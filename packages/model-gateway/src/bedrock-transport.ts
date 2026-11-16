import type { ClientRequest } from "node:http";
import https from "node:https";
import { signRequest, type CredentialSource } from "./aws.js";
import { BedrockStreamToSse } from "./bedrock-event-stream.js";
import { NotSentError, type ProviderResponse, type ProviderTransport } from "./provider.js";

/**
 * Rovara's AI (DEC 240): Bedrock's InvokeModel / InvokeModelWithResponseStream in Rovara's OWN AWS account, signed with the
 * gateway task role's credentials (SigV4, service "bedrock"). There is no customer role and no external id: the IAM grant on the
 * task role (infra/lib/model-gateway.ts) names the allow-listed models only. The host is fixed from the configured region; the
 * path is one the route built from an allow-listed model id (bedrockInvokePath) and is checked again here. A streamed answer
 * (AWS event-stream framing) is turned back into the Anthropic SSE the agent route speaks (bedrock-event-stream.ts).
 *
 * Why InvokeModel and not bedrock-runtime's native /anthropic/v1/messages: AWS documents the IAM actions and the response
 * framing of InvokeModel(WithResponseStream), not of the native path (checked 2026-11-15); one real staging call settled the
 * framing used here (tests/fixtures/model-gateway-bedrock).
 */
/** A Bedrock Claude model or system inference profile id: `anthropic.<model>` or `<geo>.anthropic.<model>`, optional `:<n>`. */
export const BEDROCK_CLAUDE_ID = /^(?:[a-z]{2,4}\.)?anthropic\.claude-[a-z0-9-]{1,80}(?::\d{1,3})?$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const PATH = /^\/model\/([A-Za-z0-9.-]+(?:%3A\d{1,3})?)\/(invoke|invoke-with-response-stream)$/u;

/** The request path for an allow-listed model id (encoded as AWS's SDKs send it). Throws for anything else. */
export function bedrockInvokePath(modelId: string, streaming: boolean): string {
  if (!BEDROCK_CLAUDE_ID.test(modelId)) throw new Error("invalid bedrock model");
  return `/model/${encodeURIComponent(modelId)}/${streaming ? "invoke-with-response-stream" : "invoke"}`;
}

export interface BedrockTransportOptions { region: string; credentials: CredentialSource; request?: typeof https.request; now?: () => number }

export function createBedrockTransport(options: BedrockTransportOptions): ProviderTransport {
  if (!REGION.test(options.region)) throw new Error("invalid aws region");
  const host = `bedrock-runtime.${options.region}.amazonaws.com`;
  const request = options.request ?? https.request;
  const now = options.now ?? Date.now;
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    const path = input.path;
    const match = path === undefined ? null : PATH.exec(path);
    if (path === undefined || match === null || !BEDROCK_CLAUDE_ID.test(decodeURIComponent(match[1]!))) throw new NotSentError();
    const streaming = match[2] === "invoke-with-response-stream";
    let credentials;
    try { credentials = await options.credentials(); } catch { throw new NotSentError(); }
    if (input.signal.aborted) throw new NotSentError();
    const body = Buffer.from(input.body);
    // Only these headers: the route's own (an Anthropic version header, a caller key) never reach AWS.
    const headers = signRequest({ method: "POST", host, path, region: options.region, service: "bedrock", body, credentials, now: new Date(now()), headers: { "content-type": "application/json", accept: streaming ? "application/vnd.amazon.eventstream" : "application/json" } });
    return new Promise<ProviderResponse>((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try {
        call = request({ hostname: host, port: 443, path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...headers, "content-length": String(body.byteLength) } }, (response) => {
          const status = response.statusCode ?? 0;
          const raw = response as AsyncIterable<Uint8Array>;
          resolve({ status, body: streaming && status >= 200 && status < 300 ? toSse(raw) : raw, cancel: () => response.destroy() });
        });
      } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(body); } catch { call.destroy(); fail(); } }
    });
  };
}

async function* toSse(raw: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const sse = new BedrockStreamToSse();
  for await (const part of raw) { const out = sse.push(part); if (out.length > 0) yield out; }
  sse.finish();
}
