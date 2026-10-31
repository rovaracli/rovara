// Stdio MCP host redesign (fix round 1, I4): how a runner task gets its token. RunTask parameters are readable by anyone who can DescribeTasks or read CloudTrail, so the override carries
// only a one-time NONCE per container. The container redeems it ONCE, over TLS, at the controller's runner listener (`POST /bootstrap`); the controller answers with the real token (and,
// for an install, the request) only to the task's own network interface. A nonce that is read afterwards from CloudTrail or DescribeTasks is useless: it is spent, it expires within minutes,
// and it only works from the address of the task it was issued to.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { runnerTokenWellFormed } from "./token-scope.js";

export type BootstrapFailure = "bad_request" | "refused" | "unavailable";

/** The exchange failed. The message is a fixed code, never text from the controller. */
export class BootstrapError extends Error {
  constructor(readonly code: BootstrapFailure) {
    super(code);
    this.name = "BootstrapError";
  }
}

export interface BootstrapOptions {
  controllerUrl: string;
  /** A private certificate authority for the controller's runner listener. */
  ca?: string | undefined;
  /** Tries while the controller says "not yet" (the task's address is not known to it yet) or cannot be reached. */
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}

function secureUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BootstrapError("bad_request"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "") throw new BootstrapError("bad_request");
  return url;
}

const NONCE = /^[A-Za-z0-9_-]{43}$/u;

/** One try. Resolves with the controller's status and body (at most 4 KiB). */
function post(url: URL, body: string, ca: string | undefined, timeoutMs: number): Promise<{ status: number; text: string }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "POST", timeout: timeoutMs, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, ...(ca === undefined ? {} : { ca }) }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 4_096) { response.destroy(); reject(new BootstrapError("unavailable")); } else chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => reject(new BootstrapError("unavailable")));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new BootstrapError("unavailable")));
    req.end(body);
  });
}

/** Redeems the nonce for the task's token (and the install request, when there is one). The nonce is spent by the first answer; a "not yet" is retried, a refusal is not. */
export async function redeemBootstrap(nonce: string, options: BootstrapOptions): Promise<{ token: string; request?: string }> {
  if (!NONCE.test(nonce)) throw new BootstrapError("bad_request");
  const target = new URL(`${secureUrl(options.controllerUrl).href.replace(/\/$/u, "")}/bootstrap`);
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 2_000;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: { status: number; text: string } | undefined;
    try { outcome = await post(target, JSON.stringify({ nonce }), options.ca, options.timeoutMs ?? 10_000); } catch { outcome = undefined; }
    if (outcome?.status === 200) {
      let parsed: { token?: unknown; request?: unknown };
      try { parsed = JSON.parse(outcome.text) as typeof parsed; } catch { throw new BootstrapError("refused"); }
      if (!runnerTokenWellFormed(parsed.token) || (parsed.request !== undefined && (typeof parsed.request !== "string" || parsed.request.length > 2_048))) throw new BootstrapError("refused");
      return { token: parsed.token, ...(parsed.request === undefined ? {} : { request: parsed.request }) };
    }
    // 409 is "not yet" (the controller does not know the task's address yet); an unreachable controller is retried too. Anything else is final.
    if (outcome !== undefined && outcome.status !== 409) throw new BootstrapError("refused");
    if (attempt >= attempts) throw new BootstrapError(outcome === undefined ? "unavailable" : "refused");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Turns the nonce in a task's environment into its token: sets `MCP_RUNNER_TOKEN` (and `MCP_INSTALL_REQUEST`) and removes the nonce. An environment with no nonce is left as it is (a test
 * seam: the controller never sends a token in an environment).
 */
export async function bootstrapEnvironment(env: Record<string, string | undefined>, options?: Partial<BootstrapOptions>): Promise<void> {
  const nonce = env.MCP_BOOTSTRAP_NONCE;
  if (nonce === undefined) return;
  delete env.MCP_BOOTSTRAP_NONCE;
  const redeemed = await redeemBootstrap(nonce, { controllerUrl: env.MCP_CONTROLLER_URL ?? "", ...(env.ROVARA_MCP_CONTROLLER_CA === undefined ? {} : { ca: env.ROVARA_MCP_CONTROLLER_CA }), ...options });
  env.MCP_RUNNER_TOKEN = redeemed.token;
  if (redeemed.request !== undefined) env.MCP_INSTALL_REQUEST = redeemed.request;
}
