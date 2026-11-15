// Cloud -> gateway service calls (PRODUCT-VERTEX-CLOUD-CONNECT). Only the gateway's serving role may assume the Vertex federation
// role, so Cloud's settings route cannot run the Vertex connection test itself. It asks the gateway: "test this Vertex federation
// setup for this company". The gateway mints a token for the company and checks that the customer's pool REFUSES a canary
// company (VertexTokens.probe), and answers only the probe's fixed result. Cloud then seals the record in its own store
// transaction, as for every other key (ProductKeyStore.connect / rotate with vertexCheck): the gateway stays read-only on keys.
//
// Authentication: an HMAC from the product key store's KMS HMAC key (ProductKeysMacKey). Cloud's settings role may only
// GenerateMac; the gateway's serving role may only VerifyMac; the key never leaves KMS. The MAC covers a fixed purpose (apart
// from the key fingerprints the same key makes: product-seal.ts uses PRODUCT_KEY_PURPOSE), the path, the time and the body's
// SHA-256, so a call can't be moved to another path, company or credential. A call is taken for SERVICE_CALL_SKEW_MS either side
// of the gateway's clock. A replay inside that window only re-runs the same test (no state changes on the gateway).
//
// Every failure is one fixed word: nothing from the request or from KMS/Google is echoed or logged.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COMPANY, record } from "./model-gateway-token.js";
import type { VertexCheck } from "./product-keys.js";
import { parseVertexConnect, type VertexCredential } from "./product-vertex-credential.js";
import type { ProbeResult } from "./product-vertex-token.js";

export const SERVICE_CALL_PURPOSE = "rovara-gateway-service-call/v1";
export const VERTEX_CHECK_PATH = "/v1/service/vertex-check";
export const SERVICE_CALL_AT_HEADER = "x-rovara-call-at";
export const SERVICE_CALL_MAC_HEADER = "x-rovara-call-mac";
export const SERVICE_CALL_SKEW_MS = 60_000;
export const SERVICE_CALL_BODY_MAX = 4_096;
/** Cloud's wait for the gateway's answer (the probe makes up to four Google/AWS calls of 5 s each). */
export const SERVICE_CALL_TIMEOUT_MS = 25_000;
const RESULTS: readonly ProbeResult[] = ["ok", "too_open", "refused", "unavailable"];

export interface MacSigner { generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }> }
export interface MacVerifier { verifyMac(input: { KeyId: string; Message: Uint8Array; Mac: Uint8Array }): Promise<boolean> }

/** What the MAC covers: sha256 of [purpose, path, time, sha256(body)]. 32 bytes, under KMS's 4,096-byte message limit. */
export function serviceCallMessage(path: string, at: number, body: Buffer): Uint8Array {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256").update(JSON.stringify([SERVICE_CALL_PURPOSE, path, at, bodyHash])).digest();
}

/** The body of a Vertex check: the install, the company, and the federation setup the customer typed. */
export interface VertexCheckBody { iss: string; cid: string; credential: Extract<VertexCredential, { scheme: "federation" }> }

export interface GatewayVertexCheckOptions {
  /** The gateway's address (https://host, no path). */
  address: string;
  /** The Code install's token issuer the key rows are bound to (the gateway refuses another). */
  issuer: string;
  kms: MacSigner;
  macKeyId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Cloud's side: the store's VertexCheck, answered by the gateway. Only a federation setup is sent (a key file never leaves Cloud
 * this way); anything the gateway does not answer with one of the four results is "unavailable" (nothing is saved).
 */
export function gatewayVertexCheck(options: GatewayVertexCheckOptions): VertexCheck {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return async (cid, credential) => {
    if (credential.scheme !== "federation" || !COMPANY.test(cid)) return "unavailable";
    try {
      const body = Buffer.from(JSON.stringify({ iss: options.issuer, cid, credential: { scheme: "federation", projectId: credential.projectId, location: credential.location, audience: credential.audience, ...(credential.serviceAccount === undefined ? {} : { serviceAccount: credential.serviceAccount }) } } satisfies VertexCheckBody));
      const at = now();
      const signed = await options.kms.generateMac({ KeyId: options.macKeyId, Message: serviceCallMessage(VERTEX_CHECK_PATH, at, body) });
      if (signed.Mac === undefined || signed.Mac.length !== 32) return "unavailable";
      const answer = await send(new URL(VERTEX_CHECK_PATH, options.address), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
        headers: { "content-type": "application/json", [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: Buffer.from(signed.Mac).toString("base64url") },
      });
      if (answer.status !== 200) return "unavailable";
      const text = await answer.text();
      if (text.length > 256) return "unavailable";
      const result = record(JSON.parse(text) as unknown)?.result;
      return RESULTS.find((r) => r === result) ?? "unavailable";
    } catch { return "unavailable"; }
  };
}

export interface VertexCheckHandlerOptions {
  /** This gateway's one Code install (its token issuer). */
  issuer: string;
  kms: MacVerifier;
  macKeyId: string;
  vertex: { probe(cid: string, credential: VertexCredential, signal?: AbortSignal): Promise<ProbeResult> };
  now?: () => number;
}

const ANSWERS = {
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  tooLarge: { status: 413, body: { error: { type: "invalid_request", message: "the request is too large" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  invalid: { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;

/** Reads at most `max` bytes; undefined when the body is longer. */
async function readBody(req: AsyncIterable<Uint8Array>, max: number): Promise<Buffer | undefined> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return undefined;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The gateway's answer to one Vertex check: status and JSON body. Exported for tests; the server writes it. */
export async function answerVertexCheck(options: VertexCheckHandlerOptions, request: { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> }, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const body = await readBody(request.body, SERVICE_CALL_BODY_MAX);
  if (body === undefined) return ANSWERS.tooLarge;
  const atText = request.headers[SERVICE_CALL_AT_HEADER]; const macText = request.headers[SERVICE_CALL_MAC_HEADER];
  if (typeof atText !== "string" || !/^[0-9]{1,16}$/u.test(atText) || typeof macText !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(macText)) return ANSWERS.refused;
  const at = Number(atText);
  if (Math.abs((options.now ?? Date.now)() - at) > SERVICE_CALL_SKEW_MS) return ANSWERS.refused;
  let valid: boolean;
  try { valid = await options.kms.verifyMac({ KeyId: options.macKeyId, Message: serviceCallMessage(VERTEX_CHECK_PATH, at, body), Mac: new Uint8Array(Buffer.from(macText, "base64url")) }); }
  catch (error) { return (error as { name?: unknown } | null)?.name === "KMSInvalidMacException" ? ANSWERS.refused : ANSWERS.unavailable; }
  if (valid !== true) return ANSWERS.refused;
  // Signed by Cloud: now the body's shape, exactly.
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  const input = record(parsed);
  if (input === undefined || Object.keys(input).length !== 3 || input.iss !== options.issuer || typeof input.cid !== "string" || !COMPANY.test(input.cid)) return ANSWERS.invalid;
  const fields = record(input.credential);
  const credential = fields === undefined || fields.scheme !== "federation" ? undefined : parseVertexConnect(JSON.stringify(fields));
  if (credential === undefined) return ANSWERS.invalid;
  const result = await options.vertex.probe(input.cid, credential, signal).catch((): ProbeResult => "unavailable");
  return { status: 200, body: { result: RESULTS.includes(result) ? result : "unavailable" } };
}

/** The HTTP handler the serving process mounts at VERTEX_CHECK_PATH (process.ts), only when Vertex and the MAC key are configured. */
export function createVertexCheckHandler(options: VertexCheckHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const answer = await answerVertexCheck(options, { method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { res.off("close", abort); }
  };
}
