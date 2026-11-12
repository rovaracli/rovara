package standin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Header names of the SageMaker container contract and of Rovara's one addition.
const (
	HeaderTargetModel      = "X-Amzn-SageMaker-Target-Model"
	HeaderCustomAttributes = "X-Amzn-SageMaker-Custom-Attributes"
	// HeaderEndpoint names the endpoint on the primary listener. The front does not send it today; an endpoint with its own port needs no header.
	HeaderEndpoint = "X-Rovara-Endpoint"
)

const (
	maxInFlight = 64
	// bodyBudget bounds the request bytes held at once across all requests, so a few 6 MiB bodies cannot take the container's memory (the catalog gives it 128 MiB; reading, splitting
	// and parsing a body holds several copies of it). A request reserves its declared length (6 MiB when it declares none) and is refused with 503 when the budget is spent.
	bodyBudget = 16 << 20
)

// Server answers for every endpoint of one config.
type Server struct {
	cfg       *Config
	log       *slog.Logger
	endpoints map[string]*runtimeEndpoint
	sem       chan struct{}

	budgetMu sync.Mutex
	held     int64
}

type runtimeEndpoint struct {
	name   string
	model  *runtimeModel
	models map[string]*runtimeModel
}

// New builds the server from a checked config. The logger receives sizes, hashes and statuses, never a request or reply body.
func New(cfg *Config, log *slog.Logger) *Server {
	s := &Server{cfg: cfg, log: log, endpoints: map[string]*runtimeEndpoint{}, sem: make(chan struct{}, maxInFlight)}
	for name, ep := range cfg.Endpoints {
		re := &runtimeEndpoint{name: name, models: map[string]*runtimeModel{}}
		if ep.Model != nil {
			re.model = newRuntimeModel(ep.Model, cfg.Seed, name, "")
		}
		for target, m := range ep.Models {
			re.models[target] = newRuntimeModel(m, cfg.Seed, name, target)
		}
		s.endpoints[name] = re
	}
	return s
}

// Listeners are the addresses to serve on and the handler of each: the primary one (any endpoint by header, else the default) and one per endpoint that has a port.
func (s *Server) Listeners() []Listener {
	port, _ := parsePort(s.cfg.Listen)
	out := []Listener{{Addr: ":" + strconv.Itoa(port), Handler: s.handler("")}}
	for _, name := range s.cfg.EndpointNames() {
		if p := s.cfg.Endpoints[name].Port; p != 0 {
			out = append(out, Listener{Addr: ":" + strconv.Itoa(p), Handler: s.handler(name), Endpoint: name})
		}
	}
	return out
}

// Listener is one address and what answers on it.
type Listener struct {
	Addr     string
	Endpoint string // "" for the primary listener
	Handler  http.Handler
}

// NewHTTPServer is an http.Server with every timeout and limit set: a slow or oversize client cannot hold the process.
func NewHTTPServer(l Listener) *http.Server {
	return &http.Server{
		Addr:              l.Addr,
		Handler:           l.Handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      70 * time.Second, // SageMaker's 60 second answer limit, plus the time to write
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
}

// Serve runs a listener until the context ends.
func Serve(ctx context.Context, l Listener) error {
	ln, err := net.Listen("tcp", l.Addr)
	if err != nil {
		return err
	}
	srv := NewHTTPServer(l)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
		return nil
	}
}

func (s *Server) handler(fixed string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusOK)
	})
	// The batch-transform probe of the contract: the settings a container suggests.
	mux.HandleFunc("GET /execution-parameters", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"MaxConcurrentTransforms":1,"BatchStrategy":"MULTI_RECORD","MaxPayloadInMB":6}`)
	})
	mux.HandleFunc("POST /invocations", func(w http.ResponseWriter, r *http.Request) { s.invoke(w, r, fixed) })
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	// msg is always one of this package's fixed sentences or the config's own error_message: never request bytes
	writeJSON(w, status, `{"error":`+strconv.Quote(msg)+`}`)
}

func (s *Server) invoke(w http.ResponseWriter, r *http.Request, fixed string) {
	start := time.Now()
	status, in, out := 0, 0, 0
	endpoint, target, sum := "", "", ""
	defer func() {
		// One line per request: what, how big, how long. Never the body, never a header value, and the target model only when it is one the config names.
		s.log.Info("invocation", "endpoint", endpoint, "model", target, "status", status, "in_bytes", in, "out_bytes", out, "body_sha8", sum, "ms", time.Since(start).Milliseconds())
	}()
	finish := func(code int, msg string) {
		status = code
		writeError(w, code, msg)
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		finish(http.StatusServiceUnavailable, "Rovara model stand-in: too many requests at once")
		return
	}

	name := fixed
	if name == "" {
		name = r.Header.Get(HeaderEndpoint)
	}
	if name == "" {
		name = s.cfg.DefaultEndpoint
	}
	if name == "" {
		finish(http.StatusBadRequest, "Rovara model stand-in: this listener serves several endpoints and the request does not name one")
		return
	}
	ep := s.endpoints[name]
	if ep == nil {
		finish(http.StatusNotFound, "Rovara model stand-in: no such endpoint")
		return
	}
	endpoint = name

	if r.ContentLength > MaxBody {
		finish(http.StatusRequestEntityTooLarge, "Rovara model stand-in: the request is larger than 6 MiB")
		return
	}
	reserve := r.ContentLength
	if reserve < 0 {
		reserve = MaxBody
	}
	if !s.reserve(reserve) {
		finish(http.StatusServiceUnavailable, "Rovara model stand-in: too many large requests at once")
		return
	}
	defer s.release(reserve)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBody))
	in = len(body)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			finish(http.StatusRequestEntityTooLarge, "Rovara model stand-in: the request is larger than 6 MiB")
		} else {
			finish(http.StatusBadRequest, "Rovara model stand-in: the request could not be read")
		}
		return
	}
	h := sha256.Sum256(body)
	sum = hex.EncodeToString(h[:4])

	rm, code, msg := ep.pick(r.Header.Get(HeaderTargetModel))
	if rm == nil {
		finish(code, msg)
		return
	}
	target = rm.name
	if len(rm.Accepts) > 0 && !acceptsType(rm.Accepts, r.Header.Get("Content-Type")) {
		finish(http.StatusUnsupportedMediaType, "Rovara model stand-in: this model does not take that content type")
		return
	}

	failed, waitMS := rm.next()
	if waitMS > 0 {
		t := time.NewTimer(time.Duration(waitMS) * time.Millisecond)
		select {
		case <-t.C:
		case <-r.Context().Done():
			t.Stop()
			status = 499
			return
		}
	}
	if failed {
		finish(rm.ErrorStatus, rm.ErrorMessage)
		return
	}
	reply, rerr := rm.answer(body)
	if rerr != nil {
		finish(rerr.status, rerr.msg)
		return
	}

	hdr := w.Header()
	hdr.Set("Content-Type", rm.ContentType)
	if rm.CustomAttributes != "" {
		hdr.Set(HeaderCustomAttributes, rm.CustomAttributes)
	}
	status = http.StatusOK
	out = len(reply)
	if rm.Stream == nil {
		hdr.Set("Content-Length", strconv.Itoa(len(reply)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(reply)
		return
	}
	// Chunked: no Content-Length, each piece flushed, a pause between them.
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	size := (len(reply) + rm.Stream.Chunks - 1) / rm.Stream.Chunks
	if size < 1 {
		size = 1
	}
	for i := 0; i < len(reply); i += size {
		if i > 0 && rm.Stream.DelayMS > 0 {
			t := time.NewTimer(time.Duration(rm.Stream.DelayMS) * time.Millisecond)
			select {
			case <-t.C:
			case <-r.Context().Done():
				t.Stop()
				return
			}
		}
		end := min(i+size, len(reply))
		if _, err := w.Write(reply[i:end]); err != nil {
			return
		}
		if fl != nil {
			fl.Flush()
		}
	}
}

func (s *Server) reserve(n int64) bool {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()
	if s.held+n > bodyBudget {
		return false
	}
	s.held += n
	return true
}

func (s *Server) release(n int64) {
	s.budgetMu.Lock()
	s.held -= n
	s.budgetMu.Unlock()
}

// pick chooses the model of a request: a multi-model endpoint by the target-model header, else the endpoint's single model.
func (ep *runtimeEndpoint) pick(target string) (*runtimeModel, int, string) {
	if len(ep.models) == 0 {
		return ep.model, 0, ""
	}
	if target == "" {
		if ep.model != nil {
			return ep.model, 0, ""
		}
		return nil, http.StatusBadRequest, "Rovara model stand-in: this is a multi-model endpoint and the request has no " + HeaderTargetModel + " header"
	}
	if m, ok := ep.models[target]; ok {
		return m, 0, ""
	}
	return nil, http.StatusNotFound, "Rovara model stand-in: no such target model"
}

func acceptsType(accepts []string, contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mt = strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	}
	for _, a := range accepts {
		if strings.EqualFold(a, mt) {
			return true
		}
	}
	return false
}

// Describe is a one-line summary of what a config serves, for the start-up log (names and kinds only).
func Describe(cfg *Config) string {
	var parts []string
	for _, name := range cfg.EndpointNames() {
		ep := cfg.Endpoints[name]
		desc := name
		if ep.Port != 0 {
			desc += fmt.Sprintf(":%d", ep.Port)
		}
		if len(ep.Models) > 0 {
			desc += fmt.Sprintf(" (%d models)", len(ep.Models))
		}
		parts = append(parts, desc)
	}
	return strings.Join(parts, ", ")
}
