import type { IncomingMessage, ServerResponse } from "node:http";
import { validCaps, type CapsSource } from "./caps.js";
import type { EndedTasks } from "./ended.js";
import { estimateCall, usageCost, TOOL_INPUT_ALLOWANCE_TOKENS } from "./estimate.js";
import { guardRequest, MAX_BODY_BYTES, tooLarge, type ModelLimitsSource } from "./guard.js";
import type { Meter, MeterItem, Reservation } from "./meter.js";
import { resolvePrice, UnknownPriceSource, type PriceSource } from "./price.js";
import { CALL_HARD_CEILING_MS, callDurationMs, MAX_RESPONSE_BYTES, NotSentError, SecretScanner, type ProviderKeys, type ProviderResponse, type ProviderTransport } from "./provider.js";
import { AUTH_ERROR, TASK_TOKEN_SECONDS, type TaskTokenVerifier } from "./token.js";
import { UsageCollector } from "./usage.js";
export interface GatewayRequest { method: string; url: string; headers: Readonly<Record<string, string | undefined>>; body: AsyncIterable<Uint8Array>; signal?: AbortSignal }
export interface GatewaySink { head(status: number, headers: Readonly<Record<string, string>>): void; write(bytes: Uint8Array): Promise<void>; end(): void; destroy(): void }
export interface GatewayDependencies {
  verifyToken: TaskTokenVerifier; ended: EndedTasks; meter: Meter; caps: CapsSource; prices?: PriceSource;
  metrics: { overrunBusy(issuer: string, company: string): void };
  modelLimits: ModelLimitsSource; now?: () => number;
  keys: ProviderKeys; transport: ProviderTransport; cautiousCeiling?: number; timeoutMs?: number;
  log: (event: { event: "settled"; estimated: boolean; costMicros: number; appliedMaxOutputTokens: number } | { event: "overrun_busy"; company: string } | { event: "settle_failed" | "refused" | "provider_error" }) => void;
}
export const OVERRUN_BUSY_MESSAGE = "Another call for this company may exceed its reserved cost right now; try again in a moment.";
export const OVERRUN_BUSY_RETRY_SECONDS = 2;
export const ENDED_TASK_POLL_MS = 1000;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const PREFIX: Record<MeterItem, string> = { task: "Budget has been exceeded! Key=task", person: "ExceededBudget: User=person", project: "Budget has been exceeded! Project=project", company: "Budget has been exceeded! Team=company" };
/** Core also used directly by the in-process harness. One deadline covers request, dependencies, transport, streaming and backpressure. */
export async function handleGateway(deps: GatewayDependencies, request: GatewayRequest, sink: GatewaySink): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(); request.signal?.addEventListener("abort", abort, { once: true });
  const now = deps.now ?? Date.now;
  const duration = Math.min(deps.timeoutMs ?? CALL_HARD_CEILING_MS, CALL_HARD_CEILING_MS);
  const startedAt = now();
  let deadline = startedAt + duration;
  let endedTimer: ReturnType<typeof setTimeout> | undefined;
  let timer = setTimeout(abort, duration);
  const shortenDeadline = (end: number) => {
    deadline = Math.min(deadline, end);
    clearTimeout(timer); timer = setTimeout(abort, Math.max(0, deadline - now()));
  };
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Observe the rejection even if abort happens while awaiting a non-cancellable meter transaction.
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(new Error("provider unavailable"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) abort();
  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    if (now() >= deadline || controller.signal.aborted) { void operation.catch(() => undefined); abort(); throw new Error("provider unavailable"); }
    return Promise.race([operation, aborted]);
  };
  const log = (event: Parameters<NonNullable<GatewayDependencies["log"]>>[0]) => { try { deps.log?.(event); } catch { /* Observability never changes settlement. */ } };
  let head = false;
  let reservation: Reservation | undefined;
  let cost = 0;
  let estimated = true;
  let appliedMaxOutputTokens = 0;
  let provider: ProviderResponse | undefined;
  const respond = async (status: number, type: string, message: string, extra: Record<string, string> = {}) => {
    if (head) { sink.destroy(); return; }
    head = true; sink.head(status, { ...JSON_HEADERS, ...extra });
    await wait(sink.write(Buffer.from(JSON.stringify({ error: { type, message } })))); sink.end(); log({ event: "refused" });
  };
  try {
    if (request.method === "GET" && request.url === "/healthz") { head = true; sink.head(200, JSON_HEADERS); await wait(sink.write(Buffer.from('{"ok":true}'))); sink.end(); return; }
    if (request.method !== "POST" || request.url !== "/v1/messages") { await respond(404, "not_found", "not found"); return; }
    const rawKey = request.headers["x-api-key"];
    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    // Ambiguous credentials are refused before either verifier is called.
    const token = rawKey ?? bearer;
    const claims = (rawKey !== undefined && auth !== undefined && rawKey !== bearer) || (auth !== undefined && bearer === undefined) ? undefined : await wait(deps.verifyToken(token));
    if (claims === undefined) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    const taskEnded = () => wait(deps.ended.isEnded(claims.iss, claims.cid, claims.tid, controller.signal));
    if (await taskEnded()) { await respond(403, "task_ended", "task ended"); return; }
    const declared = request.headers["content-length"];
    if (declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; }
    const parts: Uint8Array[] = []; let size = 0;
    const body = request.body[Symbol.asyncIterator]();
    for (;;) { const part = await wait(body.next()); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; } parts.push(part.value); }
    const guarded = guardRequest(Buffer.concat(parts), request.headers, claims.mdl, deps.modelLimits);
    if (!guarded.ok) { await respond(guarded.status, guarded.code, guarded.message); return; }
    shortenDeadline(startedAt + callDurationMs(guarded.maxTokens));
    const scope = { iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, ...(claims.per === undefined ? {} : { per: claims.per }) };
    const price = await wait(resolvePrice(deps.prices ?? UnknownPriceSource, "anthropic", guarded.model, deps.cautiousCeiling, controller.signal));
    const caps = await wait(deps.caps.capsFor(scope, controller.signal));
    if (!validCaps(caps)) { await respond(503, "unavailable", "model access unavailable"); return; }
    let estimate: number;
    try { estimate = estimateCall(guarded.bytes.length, guarded.maxTokens, price, guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
    // Do not race a transaction: its outcome must be known before forwarding or settling. Adapters bound their own transactions.
    const overrunCapable = price.estimated || !guarded.inputBounded;
    const admissionExpiresSeconds = Math.floor(now() / 1000) + TASK_TOKEN_SECONDS;
    if (overrunCapable) shortenDeadline(Math.floor(Math.min(deadline, admissionExpiresSeconds * 1000) / 1000) * 1000);
    appliedMaxOutputTokens = guarded.maxTokens;
    const reserved = await deps.meter.reserve({ scope, caps, estimateMicros: estimate, appliedMaxOutputTokens,
      ...(!overrunCapable ? {} : { overrun: { deadlineSeconds: Math.floor(deadline / 1000), tokenExpiresSeconds: admissionExpiresSeconds } }),
    });
    if (!reserved.ok) {
      if (reserved.reason === "busy" && reserved.overrunInFlight) {
        try { deps.metrics.overrunBusy(claims.iss, claims.cid); } catch { /* A metrics outage never changes admission or settlement. */ }
        log({ event: "overrun_busy", company: claims.cid });
        await respond(429, "busy", OVERRUN_BUSY_MESSAGE, { "retry-after": String(OVERRUN_BUSY_RETRY_SECONDS) });
      } else if (reserved.reason === "busy") await respond(503, "unavailable", "model access unavailable");
      else if (reserved.held) await respond(429, "budget_held", "budget is held by another call", { "retry-after": "2" });
      else await respond(422, "budget_exceeded", PREFIX[reserved.item]);
      return;
    }
    reservation = reserved.reservation;
    // One non-overlapping, deadline-bounded poll also stops streams stalled between chunks.
    const pollEnded = async (): Promise<void> => {
      try { if (await taskEnded()) abort(); } catch { abort(); }
      if (!controller.signal.aborted) endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    };
    endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    // No call has left the process yet, including while the key port is read.
    cost = 0; estimated = false;
    if (controller.signal.aborted) throw new NotSentError();
    const key = await wait(deps.keys.keyFor(claims, "anthropic", controller.signal));
    if (typeof key !== "string" || key.length < 6 || key.length > 8192 || /[\r\n]/u.test(key)) throw new NotSentError();
    if (controller.signal.aborted) throw new NotSentError();
    cost = estimate; estimated = true;
    try { provider = await wait(deps.transport({ body: guarded.bytes, headers: guarded.headers, key, signal: controller.signal })); }
    catch (error) { if (error instanceof NotSentError) { cost = 0; estimated = false; } throw error; }
    if (provider.status < 200 || provider.status >= 300) {
      // An explicit rejection before any output uses the not-sent accounting rule for BOTH input and output.
      if (provider.status === 429 || provider.status === 529) { cost = 0; estimated = false; }
      await respond(502, "provider_error", "provider unavailable"); return; }
    const scanner = new SecretScanner([key, ...(typeof token === "string" ? [token] : [])]);
    const usage = new UsageCollector();
    const output: Uint8Array[] = []; let total = 0;
    const stream = provider.body[Symbol.asyncIterator]();
    if (guarded.streaming) { head = true; sink.head(200, { ...JSON_HEADERS, "content-type": "text/event-stream; charset=utf-8" }); }
    for (;;) {
      const next = await wait(stream.next()); if (next.done) break;
      if (await taskEnded()) throw new Error("provider unavailable");
      total += next.value.byteLength; if (total > MAX_RESPONSE_BYTES) throw new Error("provider unavailable");
      const safe = scanner.push(next.value); if (safe.hit) throw new Error("provider unavailable");
      if (guarded.streaming) { usage.push(next.value); if (safe.bytes.length) await wait(sink.write(safe.bytes)); }
      else output.push(safe.bytes);
    }
    const last = scanner.finish();
    if (guarded.streaming) { if (last.length) await wait(sink.write(last)); }
    else {
      output.push(last); const bytes = Buffer.concat(output);
      let value: unknown; try { value = JSON.parse(bytes.toString()); } catch { throw new Error("provider unavailable"); }
      usage.whole(value); head = true; sink.head(200, JSON_HEADERS); await wait(sink.write(bytes));
    }
    const counts = usage.finish();
    // Incomplete/malformed SSE is a failed stream, never a silent partial success.
    if (counts === undefined) throw new Error("provider unavailable");
    if (!price.estimated) { cost = usageCost(counts, price); estimated = false; }
    // TODO(R3c): a later known price reconciles an estimated reservation against its recorded usage.
    sink.end();
  } catch {
    log({ event: "provider_error" });
    try { if (head) sink.destroy(); else await respond(502, "provider_error", "provider unavailable"); } catch { sink.destroy(); }
  } finally {
    controller.abort(); clearTimeout(timer); clearTimeout(endedTimer); request.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    try { provider?.cancel?.(); } catch { /* Fixed log fields only; no provider text. */ }
    if (reservation !== undefined) {
      try { await deps.meter.settle(reservation, cost); log({ event: "settled", costMicros: cost, estimated, appliedMaxOutputTokens }); }
      catch { log({ event: "settle_failed" }); } // Adapter keeps the hold if its atomic settle fails.
    }
  }
}
/** node:http adapter, including backpressure and disconnect cancellation. It never opens a listener itself. */
export function createGatewayHandler(deps: GatewayDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    req.once("aborted", abort); res.once("close", abort);
    const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(",") : value;
    try {
      await handleGateway(deps, { method: req.method ?? "", url: req.url ?? "", headers, body: req as AsyncIterable<Uint8Array>, signal: controller.signal }, {
        head: (status, outgoing) => { res.writeHead(status, outgoing); },
        write: async (bytes) => {
          if (res.destroyed || controller.signal.aborted) throw new Error("response unavailable");
          if (res.write(bytes)) return;
          await new Promise<void>((resolve, reject) => {
            const clean = () => { res.off("drain", drained); res.off("close", closed); res.off("error", closed); controller.signal.removeEventListener("abort", closed); };
            const drained = () => { clean(); resolve(); }; const closed = () => { clean(); reject(new Error("response unavailable")); };
            res.once("drain", drained); res.once("close", closed); res.once("error", closed); controller.signal.addEventListener("abort", closed, { once: true });
          });
        },
        end: () => { res.end(); }, destroy: () => { res.destroy(); },
      });
    } finally { req.off("aborted", abort); res.off("close", abort); }
  };
}
