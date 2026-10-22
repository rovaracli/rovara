// Plan 3 Task 19 (Task 12b's hard acceptance item): the MCP transport of a company's own endpoint. `checkEndpointUrl` resolves the host and refuses a private
// address, but node resolves the name again when it connects, so a name that answers "public" to the check and "10.0.0.5" to the connection would be
// reached. So before every MCP request the endpoint is checked, and the request is made by a fetch whose connection lookup answers only with the
// addresses that check returned. The lookup never asks DNS, so what was checked is what is connected to. Redirects are refused, and every request
// opens its own connection (`agent: false`), so none is reused across a check.
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { agentXError } from "@agentx/contracts";
import type { connectMcp } from "@agentx/gateway";
import { checkEndpointUrl, dnsResolveHost, type ResolveHost } from "./endpoint-check.js";

type LookupCallback = (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;
type LookupOptions = { family?: number | string; all?: boolean } | undefined;

/** node:http's and node:https's `request`, or a stand-in for a test. */
export type RequestFunction = (url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void) => ClientRequest;

/** Decides, before one MCP request, whether the endpoint may be called, and gives the fetch that request must use. */
export type McpEndpointGuard = (endpoint: URL) => Promise<typeof fetch>;

const familyOf = (value: number | string | undefined): 0 | 4 | 6 => (value === 4 || value === "IPv4" ? 4 : value === 6 || value === "IPv6" ? 6 : 0);

/**
 * A `lookup` for node's connection options that answers with `addresses` whatever name it is asked for, in the shape asked for (`all` or one),
 * keeping to the address family asked for. It does not resolve anything.
 */
export function pinnedLookup(addresses: readonly string[]): (hostname: string, options: LookupOptions | LookupCallback, callback?: LookupCallback) => void {
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) throw agentXError("CONFIG_INVALID", "an endpoint can only be pinned to the addresses its check returned");
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const asked = typeof options === "function" ? undefined : options;
    if (done === undefined) return;
    const family = familyOf(asked?.family);
    const usable = family === 0 ? entries : entries.filter((entry) => entry.family === family);
    const first = usable[0];
    if (first === undefined) { done(Object.assign(new Error("the endpoint has no checked address of that family"), { code: "ENOTFOUND" })); return; }
    if (asked?.all === true) done(null, usable.map((entry) => ({ ...entry })));
    else done(null, first.address, first.family);
  };
}

function headersOf(init: RequestInit | undefined, request: Request | undefined): Record<string, string> {
  const merged = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
  const out: Record<string, string> = {};
  merged.forEach((value, key) => { out[key] = value; });
  return out;
}

async function bodyOf(init: RequestInit | undefined, request: Request | undefined): Promise<Buffer | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) return request === undefined || request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  throw new TypeError("a pinned fetch sends a string or bytes");
}

const BODYLESS = new Set([101, 204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A `fetch` that connects only to `addresses` (see `pinnedLookup`), opens a connection per request, never follows a redirect and ends with the caller's
 * signal. It speaks what the MCP transport sends: a method, headers and a string body, and answers a streaming `Response`. Which addresses are allowed is
 * the caller's check (`mcpEndpointGuard`); this only keeps the connection to them.
 */
export function pinnedFetch(addresses: readonly string[], options: { request?: RequestFunction } = {}): typeof fetch {
  const lookup = pinnedLookup(addresses);
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const url = new URL(original?.url ?? (input instanceof URL ? input.href : String(input)));
    const signal = init?.signal ?? original?.signal ?? undefined;
    if (signal?.aborted === true) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    const method = (init?.method ?? original?.method ?? "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await bodyOf(init, original);
    const headers = headersOf(init, original);
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    const send = options.request ?? ((target: URL, requestOptions: RequestOptions, callback?: (response: IncomingMessage) => void) =>
      (target.protocol === "https:" ? httpsRequest : httpRequest)(target, requestOptions, callback));
    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined;
      const onAbort = () => { const reason: unknown = signal?.reason ?? new DOMException("This operation was aborted", "AbortError"); request?.destroy(reason instanceof Error ? reason : new Error(String(reason))); reject(reason); };
      try {
        request = send(url, { method, headers, lookup: lookup as RequestOptions["lookup"], agent: false }, (response) => {
          signal?.removeEventListener("abort", onAbort);
          const status = response.statusCode ?? 502;
          if (REDIRECTS.has(status)) { response.destroy(); reject(new TypeError("fetch failed: a redirect was refused")); return; }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(key, entry);
          const bodyless = BODYLESS.has(status) || method === "HEAD";
          if (bodyless) response.resume();
          resolve(new Response(bodyless ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage ?? "", headers: responseHeaders }));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        request.on("error", (error) => { signal?.removeEventListener("abort", onAbort); reject(error); });
        request.end(body);
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
  };
}

/**
 * The guard the broker puts in front of every request to a company's MCP endpoint: `checkEndpointUrl` now (https, a public DNS name, every address it
 * resolves to public), then the fetch pinned to those addresses. Each request checks again, so a host that starts to resolve somewhere private is
 * refused at its next request, and one that changes its answer between the check and the connection is not reached.
 */
export function mcpEndpointGuard(options: { resolveHost?: ResolveHost; request?: RequestFunction } = {}): McpEndpointGuard {
  const resolveHost = options.resolveHost ?? dnsResolveHost;
  return async (endpoint) => {
    const checked = await checkEndpointUrl(endpoint.href, resolveHost);
    return pinnedFetch(checked.addresses, options.request === undefined ? {} : { request: options.request });
  };
}

/** `base` (the vendor connection) with the guard run before each connection and the pinned fetch handed to it. */
export function guardedConnect(base: typeof connectMcp, guard: McpEndpointGuard): typeof connectMcp {
  return async (input) => base({ ...input, fetchImplementation: await guard(input.endpoint) });
}
