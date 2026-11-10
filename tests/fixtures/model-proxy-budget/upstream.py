# Fake model upstream for the budget spike: Anthropic Messages, OpenAI chat completions and Responses, streamed or not.
# Used by tests/integration/model-proxy-budget-docker.test.ts. A path that starts with /slow streams one delta every 0.5 s for 5 s (so a client can cut it);
# /fail answers 400. Usage: input = request bytes / 4, output = min(200, the request's output limit). Logs one JSON line per request.
import json, sys, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer



def log(**k):
    print(json.dumps({"t": round(time.time(), 3), **k}), flush=True)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _sse_start(self):
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "close"); self.end_headers()
        self.close_connection = True

    def _ev(self, name, data):
        chunk = (f"event: {name}\n" if name else "") + "data: " + (data if isinstance(data, str) else json.dumps(data)) + "\n\n"
        self.wfile.write(chunk.encode()); self.wfile.flush()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        slow = self.path.startswith("/slow")
        path = self.path[5:] if slow else self.path
        stream = bool(body.get("stream"))
        log(path=self.path, model=body.get("model"), stream=stream, max_tokens=body.get("max_tokens") or body.get("max_output_tokens") or body.get("max_completion_tokens"))
        if self.path.startswith("/fail"):
            return self._json({"error": {"type": "invalid_request_error", "message": "refused by fake upstream"}}, 400)
        steps = 10 if slow else 3
        usage_in = max(1, n // 4)
        usage_out = min(200, int(body.get("max_tokens") or body.get("max_output_tokens") or body.get("max_completion_tokens") or 200))
        try:
            if path.endswith("/v1/messages"):
                return self.messages(body, stream, steps, slow, usage_in, usage_out)
            if path.endswith("/chat/completions"):
                return self.chat(body, stream, steps, slow, usage_in, usage_out)
            if path.endswith("/responses"):
                return self.resp_api(body, stream, steps, slow, usage_in, usage_out)
        except (BrokenPipeError, ConnectionResetError) as e:
            log(path=self.path, event="client_gone", error=type(e).__name__)
            return
        self._json({"error": "no route"}, 404)

    def _pace(self, slow, i):
        if slow:
            time.sleep(0.5)

    def messages(self, body, stream, steps, slow, IN_TOK, OUT_TOK):
        mid = "msg_" + uuid.uuid4().hex[:12]
        model = body.get("model", "m")
        if not stream:
            return self._json({"id": mid, "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": "fake reply"}],
                               "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": IN_TOK, "output_tokens": OUT_TOK}})
        self._sse_start()
        self._ev("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": IN_TOK, "output_tokens": 1}}})
        self._ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
        for i in range(steps):
            self._pace(slow, i)
            self._ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": f"w{i} "}})
        self._ev("content_block_stop", {"type": "content_block_stop", "index": 0})
        self._ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": OUT_TOK}})
        self._ev("message_stop", {"type": "message_stop"})
        log(path=self.path, event="stream_complete")

    def chat(self, body, stream, steps, slow, IN_TOK, OUT_TOK):
        mid = "chatcmpl-" + uuid.uuid4().hex[:12]
        model = body.get("model", "m")
        usage = {"prompt_tokens": IN_TOK, "completion_tokens": OUT_TOK, "total_tokens": IN_TOK + OUT_TOK}
        if not stream:
            return self._json({"id": mid, "object": "chat.completion", "created": int(time.time()), "model": model,
                               "choices": [{"index": 0, "message": {"role": "assistant", "content": "fake reply"}, "finish_reason": "stop"}], "usage": usage})
        self._sse_start()
        base = {"id": mid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
        self._ev(None, {**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
        for i in range(steps):
            self._pace(slow, i)
            self._ev(None, {**base, "choices": [{"index": 0, "delta": {"content": f"w{i} "}, "finish_reason": None}]})
        self._ev(None, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self._ev(None, {**base, "choices": [], "usage": usage})
        self._ev(None, "[DONE]")
        log(path=self.path, event="stream_complete")

    def resp_api(self, body, stream, steps, slow, IN_TOK, OUT_TOK):
        rid = "resp_" + uuid.uuid4().hex[:12]
        model = body.get("model", "m")
        usage = {"input_tokens": IN_TOK, "output_tokens": OUT_TOK, "total_tokens": IN_TOK + OUT_TOK, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}
        item = {"id": "msg_" + rid, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": "fake reply", "annotations": []}]}
        done = {"id": rid, "object": "response", "created_at": int(time.time()), "status": "completed", "model": model, "output": [item], "usage": usage,
                "parallel_tool_calls": True, "tool_choice": "auto", "tools": [], "text": {"format": {"type": "text"}}}
        if not stream:
            return self._json(done)
        self._sse_start()
        self._ev("response.created", {"type": "response.created", "sequence_number": 0, "response": {**done, "status": "in_progress", "output": [], "usage": None}})
        self._ev("response.output_item.added", {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0, "item": {**item, "status": "in_progress", "content": []}})
        seq = 2
        for i in range(steps):
            self._pace(slow, i)
            self._ev("response.output_text.delta", {"type": "response.output_text.delta", "sequence_number": seq, "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": f"w{i} "})
            seq += 1
        self._ev("response.output_item.done", {"type": "response.output_item.done", "sequence_number": seq, "output_index": 0, "item": item})
        self._ev("response.completed", {"type": "response.completed", "sequence_number": seq + 1, "response": done})
        log(path=self.path, event="stream_complete")


ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 9000), H).serve_forever()
