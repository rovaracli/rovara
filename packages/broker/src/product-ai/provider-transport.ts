// TE-F1e (design 7, SSRF; te-f1e.md item 1 step g): where the ProductModelEgress function's one model call leaves the process. Built on F1-a's pure address core (`lookupNameFor`, `planConnection`), the same
// core Code's laptop forwarder uses (vendor broker/src/local/model-egress/forwarder.ts; that file is not exported by `@rovara-code/broker`, so it cannot be imported here: DEFERRED TE-F1E-FORWARDER-DEDUPE).
//
// On EVERY call: the host must be a plain public name; it is resolved HERE (the fully qualified name, so no search domain applies); `planConnection` refuses the whole answer when ANY address is private, loopback
// (Lambda's runtime API listens on 127.0.0.1), link-local, shared, reserved or an IPv4-mapped IPv6 address, or the name is under a denied suffix (AWS's own API and function-URL domains). The connection goes to
// the ADDRESS that was checked (never resolved again: no rebinding), with the row's host as the TLS name and the certificate verified, https on port 443 only. Node's https.request never follows a redirect;
// a 3xx is handed back and the handler refuses it. The answer is read to at most 10 MiB and the call lasts at most 10 minutes. Faults are two fixed errors carrying no word from the system or the provider.
import dns from "node:dns";
import https from "node:https";
import { MODEL_EGRESS_DENIED_SUFFIXES, lookupNameFor, planConnection, type OutboundRequest } from "@rovara-code/contracts";
import { PRODUCT_MODEL_CALL_DEADLINE_MS, PRODUCT_MODEL_RESPONSE_MAX_BYTES } from "@agentx/cloud-contracts";

export class EgressSsrfError extends Error {
  constructor() {
    super("the provider address was refused");
    this.name = "EgressSsrfError";
  }
}
export class EgressUnreachableError extends Error {
  constructor() {
    super("the provider could not be reached");
    this.name = "EgressUnreachableError";
  }
}
/** Unreachable, and provably before any byte of the request left the process (the lookup failed, or the connection failed before its TLS handshake finished): the call cost nothing (REVIEW-1 L-3). */
export class EgressNotSentError extends EgressUnreachableError {
  constructor() {
    super();
    this.name = "EgressNotSentError";
  }
}

export interface ProviderResponse {
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: AsyncIterable<Uint8Array>;
}
/** The transport the handler calls once per call: the conformance suite's fake provider has the same shape. */
export type ProviderTransport = (request: OutboundRequest, signal?: AbortSignal) => Promise<ProviderResponse>;

export interface CloudProviderTransportOptions {
  /** Every address of a name. Default: the system resolver (all answers, verbatim). */
  readonly lookup?: (name: string) => Promise<readonly string[]>;
  /** `https.request`; injected in tests so no socket is opened. */
  readonly request?: typeof https.request;
  readonly responseBytesMax?: number;
  readonly totalMs?: number;
  /** Domains refused on top of F1-a's (Rovara's own install domains). */
  readonly denySuffixes?: readonly string[];
}

const systemLookup = async (name: string): Promise<readonly string[]> => (await dns.promises.lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

export function createCloudProviderTransport(options: CloudProviderTransportOptions = {}): ProviderTransport {
  const lookup = options.lookup ?? systemLookup;
  const httpsRequest = options.request ?? https.request;
  const responseMax = options.responseBytesMax ?? PRODUCT_MODEL_RESPONSE_MAX_BYTES;
  // The whole call (connection, request and the WHOLE answer) ends by this deadline, 30 s under the function's timeout (REVIEW-1 L-4).
  const totalMs = options.totalMs ?? PRODUCT_MODEL_CALL_DEADLINE_MS;
  const denySuffixes = options.denySuffixes ?? [];

  return async (request, signal) => {
    const name = lookupNameFor(request.host);
    if (name === undefined || [...MODEL_EGRESS_DENIED_SUFFIXES, ...denySuffixes].some((suffix) => request.host === suffix || request.host.endsWith(`.${suffix}`))) throw new EgressSsrfError();
    if (signal?.aborted === true) throw new EgressNotSentError();
    const deadlineAt = Date.now() + totalMs;
    let answers: readonly string[];
    try {
      answers = await lookup(name);
    } catch {
      throw new EgressNotSentError();
    }
    const plan = planConnection(request.host, answers, { denySuffixes });
    if (!plan.ok) throw new EgressSsrfError();

    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    headers.host = request.host;
    for (const [headerName, value] of request.headers) headers[headerName] = value;
    headers["content-length"] = String(request.body.byteLength);
    const path = request.query.length === 0 ? request.path : `${request.path}?${request.query}`;

    type Incoming = AsyncIterable<Uint8Array> & { statusCode?: number; headers: Record<string, string | string[] | undefined>; destroy(): void };
    const incoming = await new Promise<Incoming>((resolve, reject) => {
      let settled = false;
      // Nothing reaches the provider before the TLS handshake is done: a failure before it is "not sent", one after it is "may have been sent".
      let connected = false;
      const fail = (): void => {
        if (!settled) {
          settled = true;
          reject(connected ? new EgressUnreachableError() : new EgressNotSentError());
        }
      };
      // To the CHECKED address; the host is the TLS name (SNI and certificate check) and the Host header.
      const call = httpsRequest(
        { host: plan.address, port: plan.port, servername: plan.tlsServerName, method: request.method, path, headers, agent: false, rejectUnauthorized: true },
        (response) => {
          settled = true;
          clearTimeout(timer);
          resolve(response as unknown as Incoming);
        },
      );
      call.on("socket", (socket: NodeJS.EventEmitter) => {
        socket.once("secureConnect", () => {
          connected = true;
        });
      });
      const timer = setTimeout(() => {
        call.destroy();
        fail();
      }, Math.max(0, deadlineAt - Date.now()));
      call.on("error", () => {
        clearTimeout(timer);
        fail();
      });
      const onAbort = (): void => {
        call.destroy();
        fail();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      call.on("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
      call.end(Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength));
    });

    const responseHeaders: Array<[string, string]> = [];
    for (const [headerName, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") responseHeaders.push([headerName, value]);
      else if (Array.isArray(value)) for (const item of value) responseHeaders.push([headerName, item]);
    }
    return {
      status: incoming.statusCode ?? 0,
      headers: responseHeaders,
      body: (async function* () {
        let total = 0;
        const parts = incoming[Symbol.asyncIterator]();
        try {
          for (;;) {
            // The deadline covers reading the answer too: a body that stalls is cut at the call's deadline.
            const remaining = deadlineAt - Date.now();
            if (remaining <= 0) throw new EgressUnreachableError();
            let timer: NodeJS.Timeout | undefined;
            const late = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new EgressUnreachableError()), remaining);
            });
            let step: IteratorResult<Uint8Array>;
            try {
              step = await Promise.race([parts.next(), late]);
            } finally {
              clearTimeout(timer);
            }
            if (step.done === true) return;
            total += step.value.byteLength;
            if (total > responseMax) throw new EgressUnreachableError();
            yield step.value;
          }
        } catch {
          incoming.destroy();
          throw new EgressUnreachableError();
        }
      })(),
    };
  };
}
