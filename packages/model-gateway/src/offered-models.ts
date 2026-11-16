// "Agents pick models" (DEC 243c, DEC 236j): which models one company's agents may use. Rovara Code reads this list for the company's
// page (it offers exactly these models and refuses any other), so it must be what the agent route accepts for that company on its very
// next call. The shape is Code's OfferedAgentModels (contracts/shared/offered-agent-models.v1.json):
//
//   GET /v1/service/companies/<companyId>/offered-models   ->   { "version": 1, "models": [ { "model": "<name>" }, ... ] }
//
// Authentication: a service token the Code install's broker signs with its TASK key, so this route trusts exactly what the agent route
// trusts (the pinned issuer, the pinned task key ids, the JWKS the install publishes) and nothing else: no new key, no new secret. It is
// a different token from a task token on purpose: header typ `rovara-service+jwt`, audience `rovara-model-gateway-offered-models`, exactly
// the claims iss/aud/jti/iat/nbf/exp/cid, at most SERVICE_TOKEN_SECONDS of life, so a task token never opens this route and this token
// never opens the agent route. (The vertex-check HMAC is Cloud's own KMS key: only Cloud's settings role may sign with it, and Code's
// broker has no such right, so it is not an option for Code.)
//
// Company isolation: the company is the token's `cid`, the path must name the same company (anything else is refused as an unsigned call,
// so a caller that builds company A's address with company B's token learns nothing), and every read below is for that one company. The
// source row's own companyId is checked again by CompanyAgentAiSource.
//
// Every failure is a fixed answer: nothing from the request, a token or the store is echoed or logged.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentAiSource, AgentAiSourceReader, ByoBedrock } from "./agent-ai.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const SERVICE_TOKEN_TYPE = "rovara-service+jwt";
export const SERVICE_TOKEN_AUDIENCE = "rovara-model-gateway-offered-models";
export const SERVICE_TOKEN_SECONDS = 60;
export const SERVICE_TOKEN_CLAIMS = ["iss", "aud", "jti", "iat", "nbf", "exp", "cid"] as const;
export const OFFERED_MODELS_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/offered-models$/u;
/** Code's AGENT_MODEL_NAME and OFFERED_AGENT_MODELS_MAX (packages/contracts/src/agent-model-choice.ts). */
export const OFFERED_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const OFFERED_MODELS_MAX = 64;
/** At most this many checks at once and started per minute, per serving task, before any key fetch (the path is on the public load balancer). */
export const OFFERED_MODELS_OPEN = 8;
export const OFFERED_MODELS_PER_MINUTE = 600;

export interface ServiceClaims { iss: string; aud: typeof SERVICE_TOKEN_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function parseServiceClaims(value: unknown): ServiceClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== SERVICE_TOKEN_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as ServiceClaims;
}
export const SERVICE_TOKEN_KIND: SignedTokenKind<ServiceClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseServiceClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

/**
 * Anthropic's own models, named as Anthropic's API names them (the engine names Code's catalog uses): what a company that connected its
 * own Anthropic key (or saved no choice: company-key mode) may use. One name per model. A contract test holds these equal to the
 * Claude names of ROVARA_AI_US_MODELS (one per model).
 */
export const ANTHROPIC_KEY_AGENT_MODELS: readonly string[] = Object.freeze(["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);
/**
 * Models Rovara's AI lists but whose Bedrock access the account has not enabled yet (the one-time Marketplace enable, 2026-11-16): a call
 * answers model_not_enabled, so none is offered until the operator enables it and removes it from GATEWAY_AGENT_MODELS_DISABLED. They
 * are only the default: that variable, when set (even empty), replaces this list. Only Rovara's AI is affected (Bedrock's account state);
 * a company's own Anthropic key never answers model_not_enabled.
 */
export const AGENT_MODELS_DISABLED_DEFAULT: readonly string[] = Object.freeze(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);

/** GATEWAY_AGENT_MODELS_DISABLED: model names, comma-separated; empty means none; absent means the default list. Throws on anything else. */
export function parseDisabledAgentModels(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set(AGENT_MODELS_DISABLED_DEFAULT);
  if (value.trim() === "") return new Set();
  const names = value.split(",").map((name) => name.trim());
  if (names.length > OFFERED_MODELS_MAX || names.some((name) => !OFFERED_MODEL_NAME.test(name)) || new Set(names).size !== names.length) throw new Error("invalid disabled agent models");
  return new Set(names);
}

export type OfferedModelsOutcome = { ok: true; models: string[] } | { ok: false; status: number; code: string; message: string };
const refusal = (status: number, code: string, message: string): OfferedModelsOutcome => ({ ok: false, status, code, message });
export const OFFERED_BYO_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: your own Bedrock is not available on this install.");
export const OFFERED_BYO_NOT_CONNECTED = refusal(403, "no_ai_key", "Connect your Bedrock: this company chose its own Bedrock for its agents, and no AWS role is connected.");
export const OFFERED_ROVARA_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: Rovara's AI is not available on this install.");
export const OFFERED_EMPTY = refusal(503, "unavailable", "No models are available for your agents right now.");

/**
 * What the agent route accepts for a company with this source, now. rovara: every name the gateway's allow-list calls (one name per
 * Bedrock id; a dated alias of the same profile is not a second model), minus the disabled ones. anthropic_key, or nothing saved:
 * Anthropic's models. bedrock_byo: see offeredByoModels. Never empty (a refusal), never more than OFFERED_MODELS_MAX, never a name the
 * contract's pattern rejects.
 */
export function offeredModelsFor(source: AgentAiSource | undefined, rovara: { models: ReadonlyMap<string, string> } | undefined, disabled: ReadonlySet<string>): OfferedModelsOutcome {
  let names: string[];
  // bedrock_byo is answered from the company's own connection (offeredByoModels), never here.
  if (source === "bedrock_byo") return OFFERED_BYO_OFF;
  if (source === "rovara") {
    if (rovara === undefined) return OFFERED_ROVARA_OFF;
    const seen = new Set<string>();
    names = [];
    for (const [name, id] of rovara.models) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!disabled.has(name)) names.push(name);
    }
  } else names = [...ANTHROPIC_KEY_AGENT_MODELS];
  names = names.filter((name) => OFFERED_MODEL_NAME.test(name)).slice(0, OFFERED_MODELS_MAX);
  return names.length === 0 ? OFFERED_EMPTY : { ok: true, models: names };
}

/**
 * DEC 238, slice 1: the models the agent route accepts for a company on its own Bedrock are exactly the names of that company's own
 * connection (`models`: agent model name to the Bedrock Claude id or profile it picked), and only Claude ids are sent (server.ts guard).
 * The connection is read for the verified token's install and company only. The disabled list does not apply (it is Rovara's account).
 */
export async function offeredByoModels(byo: Pick<ByoBedrock, "connection"> | undefined, iss: string, cid: string): Promise<OfferedModelsOutcome> {
  if (byo === undefined) return OFFERED_BYO_OFF;
  const found = await byo.connection(iss, cid);
  if (found === undefined) return OFFERED_BYO_NOT_CONNECTED;
  const names = Object.entries(found.connection.models).filter(([name, id]) => BEDROCK_CLAUDE_ID.test(id) && OFFERED_MODEL_NAME.test(name)).map(([name]) => name).slice(0, OFFERED_MODELS_MAX);
  return names.length === 0 ? OFFERED_EMPTY : { ok: true, models: names };
}

export interface OfferedModelsHandlerOptions {
  /** createSignedTokenVerifier(..., SERVICE_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<ServiceClaims | undefined>;
  sources: AgentAiSourceReader;
  /** The agent route's Rovara's AI allow-list, when configured. */
  rovara?: { models: ReadonlyMap<string, string> };
  disabled: ReadonlySet<string>;
  /** The company's own Bedrock (DEC 238), when this gateway has it built (as the agent route's `agentAi.byo`). Absent: bedrock_byo is refused. */
  byo?: Pick<ByoBedrock, "connection">;
  now?: () => number;
}

const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notFound: { status: 404, body: { error: { type: "not_found", message: "not found" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerOfferedModels(options: OfferedModelsHandlerOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }): Promise<{ status: number; body: unknown }> {
  const target = OFFERED_MODELS_PATH.exec(request.url);
  if (target === null) return ANSWERS.notFound;
  if (request.method !== "GET") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const claims = await options.verify(auth.slice(7));
  // The token's company is THE company; a path naming another company is an unsigned call (nothing about either company is said).
  if (claims === undefined || claims.cid !== target[1]) return ANSWERS.refused;
  let outcome: OfferedModelsOutcome;
  try {
    const source = await options.sources.sourceFor(claims.cid);
    outcome = source === "bedrock_byo" ? await offeredByoModels(options.byo, claims.iss, claims.cid) : offeredModelsFor(source, options.rovara, options.disabled);
  } catch { return ANSWERS.unavailable; }
  if (!outcome.ok) return { status: outcome.status, body: { error: { type: outcome.code, message: outcome.message } } };
  return { status: 200, body: { version: 1, models: outcome.models.map((model) => ({ model })) } };
}

/** The HTTP handler the serving process mounts for OFFERED_MODELS_PATH (process.ts), only in company-key mode. */
export function createOfferedModelsHandler(options: OfferedModelsHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, OFFERED_MODELS_OPEN, OFFERED_MODELS_PER_MINUTE);
  return async (req, res) => {
    const release = limit.take();
    try {
      // A GET carries no body worth reading; it is dropped unread.
      req.resume();
      const url = req.url ?? "";
      const answer = release === undefined ? ANSWERS.busy : await answerOfferedModels(options, { method: req.method ?? "", url, headers: req.headers });
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); }
  };
}
