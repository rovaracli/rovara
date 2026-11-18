// "AI for your agents" (DEC 240): which AI the company's agents use. Saved in Cloud's Companies table (COMPANY#<org>/AGENT_AI), and
// read by the model gateway on every agent call (model-gateway agent-ai.ts). Three choices:
//
//   rovara         Rovara's AI: Claude through Rovara's own AWS account, nothing to paste, charged to the company per use.
//   anthropic_key  the company's own Anthropic key (connected on the "Learning AI key" page; DEC 236).
//   bedrock_byo    the company's own Bedrock (DEC 238): choosable once its AWS role is connected (bedrock-byo-routes.ts).
//
//   GET /org/agent-ai   the saved choice (null when none), its version, and the three choices
//   PUT /org/agent-ai   {expectedVersion, source}: save the choice
//
// Who: company admins only (Code's access check made now), reads included. A write goes through the
// app's signed-write path (CSRF in handler.ts). Each saved change is audited. There is never an automatic switch between sources:
// the gateway uses only the saved one.
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { recordCloudAction } from "./audit-log.js";
import { AGENT_AI_SOURCES, agentSourceSwitchedOn, CompanyStoreConflict, effectiveAgentSource, type AgentAiSource } from "./company-store.js";
import { bedrockConnected } from "./bedrock-byo-routes.js";
import { LEARNING_AI_OWNER } from "./learning-ai-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

/** The sources an admin may save. `bedrock_byo` (DEC 238) only once the company's Bedrock is connected on this Cloud. */
export const AGENT_AI_CHOOSABLE: readonly AgentAiSource[] = ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint"];
/** The sources every Cloud lists; the others (DEC 254t) are listed only where their kind is switched on, so this answer is unchanged elsewhere. */
const ALWAYS_LISTED: readonly AgentAiSource[] = ["rovara", "anthropic_key", "bedrock_byo"];
/** The company account each own-key source (DEC 254t) needs before it can be chosen (the learning document's provider). */
const KEY_OF: Readonly<Partial<Record<AgentAiSource, "openai" | "openrouter" | "endpoint">>> = Object.freeze({ openai_key: "openai", openrouter_key: "openrouter", custom_endpoint: "endpoint" });
const BODY_BYTES_MAX = 1_024;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "AI for your agents isn't set up on this Cloud."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change the AI the company's agents use."),
  invalid: refusal(400, "CONFIG_INVALID", "Choose Rovara's AI, your own Anthropic key or your own Bedrock."),
  bedrockFirst: refusal(400, "CONFIG_INVALID", "Connect your own Bedrock first (Settings, Your own Bedrock), then choose it here."),
  keyFirst: refusal(400, "CONFIG_INVALID", "Connect that provider's key first (Settings, AI keys), then choose it here."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  switchedOff: refusal(400, "CONFIG_INVALID", "This AI source isn't switched on for this Cloud yet."),
  stale: refusal(409, "CONFLICT", "The AI for your agents changed. Refresh and try again."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "AI for your agents is unavailable right now. Try again."),
});
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

interface Admin { companyId: string; developerId: string; name: string }

const NOTHING_SWITCHED_ON: ReadonlySet<string> = new Set();
/** DEC 254t: whether this install switched the source's kind on (Rovara's AI and the pre-switch sources always are). */
const switchedOn = (context: RouteContext, source: string): boolean => agentSourceSwitchedOn(source, context.company?.aiSourceKinds ?? NOTHING_SWITCHED_ON);

/** A company admin of a company Cloud knows, from Code's access check made now. A RouteAnswer when refused. */
async function admin(context: RouteContext): Promise<Admin | RouteAnswer> {
  const backend = context.company;
  if (backend === undefined) return WORDS.off;
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // A company owner or admin (Code's company role, never its install administrator flag).
  if (!isCompanyAdmin(who.companyRole)) return WORDS.forbidden;
  return { companyId: who.companyId, developerId: who.developerId, name: who.name };
}

/** Whether the company's own key of `provider` is connected (the learning document of the product key store), or null when this Cloud can't tell. */
async function keyConnected(context: RouteContext, companyId: string, provider: "anthropic" | "openai" | "openrouter" | "endpoint"): Promise<boolean | null> {
  const productAi = context.productAi;
  if (productAi === undefined) return null;
  try {
    const view = await productAi.store.view(productAi.issuer, companyId, LEARNING_AI_OWNER);
    return view.sources.some((s) => s.provider === provider && s.hasKey && s.available);
  } catch { return null; }
}
/** For the default only: a Cloud with no Bedrock backend has no own Bedrock to prefer (the gateway builds it from the same switch), so that reads "not connected"; a backend that cannot be read stays null (cannot tell). */
export const bedrockForDefault = (context: Pick<RouteContext, "productAi">, read: boolean | null): boolean | null => context.productAi?.bedrock === undefined ? false : read;
export const anthropicKeyConnected = (context: RouteContext, companyId: string) => keyConnected(context, companyId, "anthropic");
/** The learning document's revision (what an endpoint write sends as expectedRevision), or null when this Cloud can't tell. */
async function keysRevision(context: RouteContext, companyId: string): Promise<number | null> {
  const productAi = context.productAi;
  if (productAi === undefined) return null;
  try { return (await productAi.store.view(productAi.issuer, companyId, LEARNING_AI_OWNER)).revision; } catch { return null; }
}

async function answer(context: RouteContext, who: Admin): Promise<RouteAnswer> {
  let saved;
  try { saved = await context.company!.store.agentAi(who.companyId); } catch { return WORDS.unavailable; }
  const bedrock = await bedrockConnected(context, who.companyId);
  // DEC 254t: an own-key source is listed only where its kind is switched on (elsewhere this answer is exactly as before), and
  // available only once its key is connected (the gateway would refuse every call otherwise).
  // A stored endpoint stays listed (not choosable) after its kind is switched off, so it can still be seen and removed (A3-REVIEW-1 L3).
  const storedEndpoint = !switchedOn(context, "custom_endpoint") && (await keyConnected(context, who.companyId, "endpoint")) === true;
  const listed = AGENT_AI_SOURCES.filter((source) => ALWAYS_LISTED.includes(source) || switchedOn(context, source) || (source === "custom_endpoint" && storedEndpoint));
  const keys: Partial<Record<AgentAiSource, boolean | null>> = {};
  for (const source of listed) { const provider = KEY_OF[source]; if (provider !== undefined) keys[source] = await keyConnected(context, who.companyId, provider); }
  // DEC 254zzz3(1): for an exempt company with no saved choice, what its agents use now (the gateway's default). Only for such a company is a
  // connection read for it; anyone else is answered exactly as before (neither field is added).
  const exempt = saved === undefined && context.company?.rovaraAiExempt?.has(who.companyId) === true;
  const effective = effectiveAgentSource({ saved: saved?.source, exempt, keyConnected: exempt ? await anthropicKeyConnected(context, who.companyId) : null, bedrockConnected: exempt ? bedrockForDefault(context, bedrock) : null });
  return ok({
    source: saved?.source ?? null,
    // Added only for a company on the default: every other answer is byte for byte what it was.
    ...(effective.isDefault ? { effectiveSource: effective.source, sourceIsDefault: true } : {}),
    version: saved?.version ?? 0,
    canChange: true,
    choices: listed.map((source) => ({ source, available: AGENT_AI_CHOOSABLE.includes(source) && switchedOn(context, source) && (source !== "bedrock_byo" || bedrock === true) && (KEY_OF[source] === undefined || keys[source] === true) })),
    anthropicKeyConnected: await anthropicKeyConnected(context, who.companyId),
    bedrockConnected: bedrock,
    ...(keys.openai_key === undefined ? {} : { openaiKeyConnected: keys.openai_key }),
    ...(keys.openrouter_key === undefined ? {} : { openrouterKeyConnected: keys.openrouter_key }),
    ...(keys.custom_endpoint === undefined ? {} : { endpointConnected: keys.custom_endpoint, keysRevision: await keysRevision(context, who.companyId) }),
  });
}

async function readAgentAi(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  return "status" in who ? who : answer(context, who);
}

async function putAgentAi(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || Object.keys(body).length !== 2 || !whole(body.expectedVersion) || typeof body.source !== "string") return WORDS.invalid;
  const source = AGENT_AI_CHOOSABLE.find((s) => s === body.source);
  if (source === undefined) return WORDS.invalid;
  // DEC 254t: a source of a kind this install has not switched on is not choosable (the gateway refuses it too).
  if (!switchedOn(context, source)) return WORDS.switchedOff;
  // Only a connected Bedrock can be chosen (the gateway would refuse every call otherwise). Can't tell: refused, never guessed.
  if (source === "bedrock_byo" && (await bedrockConnected(context, who.companyId)) !== true) return WORDS.bedrockFirst;
  // DEC 254t: an own-key source only once that provider's key is connected. Can't tell: refused, never guessed.
  const provider = KEY_OF[source];
  if (provider !== undefined && (await keyConnected(context, who.companyId, provider)) !== true) return WORDS.keyFirst;
  const store = context.company!.store;
  try {
    await store.putAgentAi({ companyId: who.companyId, source, updatedAt: context.now().toISOString(), updatedBy: who.developerId }, body.expectedVersion);
  } catch (error) { return error instanceof CompanyStoreConflict ? WORDS.stale : WORDS.unavailable; }
  if (context.audit !== undefined) {
    try {
      await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action: "agent_ai.source.changed", via: "web", subject: `agent_ai:${source}` }, context.now);
    } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action: "agent_ai.source.changed", companyId: who.companyId })); }
  }
  return answer(context, who);
}

// ---- DEC 254t (A3): the company's own OpenAI-compatible endpoint
//
//   PUT    /org/agent-ai/endpoint   {requestId, expectedRevision, baseUrl, key, models: [{name, catalog: {provider, modelId}}]}: connect or replace
//   DELETE /org/agent-ai/endpoint   {requestId, expectedRevision}: remove (7-day recovery window in the store)
//
// Only where the endpoint kind is switched on. Company admins, audited. The address, key and models are sealed TOGETHER
// as one company account in the write-only learning document (provider "endpoint"): never answered, logged or audited. The store checks
// the address with the gateway's SSRF guard (https, port 443, no user, a public host); the gateway checks it again, with DNS, on every
// call. `expectedRevision` is the learning document's revision (GET /org/learning-ai).
const ENDPOINT_SOURCE_ID = "src_endpoint";
const ENDPOINT_BODY_MAX = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ENDPOINT_WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Your own endpoint isn't set up on this Cloud."),
  switchedOff: refusal(400, "CONFIG_INVALID", "Your own endpoint isn't switched on for this Cloud yet."),
  invalid: refusal(400, "CONFIG_INVALID", "This endpoint can't be used: it needs an https address on port 443 of a public host, a key, and 1 to 20 models."),
  stale: refusal(409, "CONFLICT", "The company's AI keys changed. Refresh and try again."),
  noEndpoint: refusal(404, "NOT_FOUND", "No endpoint is connected."),
  inRecovery: refusal(409, "CONFLICT", "This endpoint was removed less than 7 days ago. Ask an installation administrator to recover it."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Your own endpoint is unavailable right now. Try again."),
});
const ENDPOINT_ERRORS: Readonly<Record<string, RouteAnswer>> = Object.freeze({ invalid: ENDPOINT_WORDS.invalid, stale: ENDPOINT_WORDS.stale, not_found: ENDPOINT_WORDS.noEndpoint, in_recovery: ENDPOINT_WORDS.inRecovery, forbidden: WORDS.forbidden });

/** Connect/replace needs the kind switched on; removal never does (A3-REVIEW-1 L3): a company can always remove what it stored. */
async function endpointAdmin(context: RouteContext, gated = true): Promise<Admin | RouteAnswer> {
  if (context.productAi === undefined) return ENDPOINT_WORDS.off;
  const who = await admin(context);
  if ("status" in who) return who;
  if (gated && !switchedOn(context, "custom_endpoint")) return ENDPOINT_WORDS.switchedOff;
  return who;
}
async function endpointCall<T>(work: () => Promise<T>): Promise<T | RouteAnswer> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && Object.hasOwn(ENDPOINT_ERRORS, code) ? ENDPOINT_ERRORS[code]! : ENDPOINT_WORDS.unavailable;
  }
}
async function endpointAudited(context: RouteContext, who: Admin, action: "agent_ai.endpoint.connected" | "agent_ai.endpoint.rotated" | "agent_ai.endpoint.removed"): Promise<void> {
  if (context.audit === undefined) return;
  try {
    await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action, via: "web", subject: "agent_ai:custom_endpoint" }, context.now);
  } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action, companyId: who.companyId })); }
}
/** The connection text the store seals, from the request's exact fields (shape only; the store checks every value). undefined: refused. */
function endpointText(body: Record<string, unknown>): string | undefined {
  const models = body.models;
  if (typeof body.baseUrl !== "string" || body.baseUrl.length > 2048 || typeof body.key !== "string" || body.key.length > 1024 || !Array.isArray(models) || models.length < 1 || models.length > 20) return undefined;
  const clean: Array<{ name: string; catalog: { provider: string; modelId: string } }> = [];
  for (const each of models) {
    const m = record(each); const catalog = record(m?.catalog);
    if (m === undefined || catalog === undefined || Object.keys(m).length !== 2 || Object.keys(catalog).length !== 2 || typeof m.name !== "string" || typeof catalog.provider !== "string" || typeof catalog.modelId !== "string") return undefined;
    clean.push({ name: m.name, catalog: { provider: catalog.provider, modelId: catalog.modelId } });
  }
  return JSON.stringify({ scheme: "openai_compatible", baseUrl: body.baseUrl, key: body.key, models: clean });
}

async function putEndpoint(context: RouteContext): Promise<RouteAnswer> {
  const who = await endpointAdmin(context);
  if ("status" in who) return who;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > ENDPOINT_BODY_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  const keys = ["requestId", "expectedRevision", "baseUrl", "key", "models"];
  if (body === undefined || Object.keys(body).length !== keys.length || !keys.every((k) => Object.hasOwn(body, k)) || typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision)) return ENDPOINT_WORDS.invalid;
  const text = endpointText(body);
  if (text === undefined) return ENDPOINT_WORDS.invalid;
  const backend = context.productAi!;
  const current = await endpointCall(() => backend.store.view(backend.issuer, who.companyId, LEARNING_AI_OWNER));
  if ("status" in current) return current;
  const change = { iss: backend.issuer, cid: who.companyId, owner: LEARNING_AI_OWNER, requestId: body.requestId, expectedRevision: body.expectedRevision, actor: { id: who.developerId, role: "company_admin" as const } };
  const connected = current.sources.some((s) => s.sourceId === ENDPOINT_SOURCE_ID && s.hasKey);
  const saved = await endpointCall(() => connected ? backend.store.rotate({ ...change, sourceId: ENDPOINT_SOURCE_ID, key: text }) : backend.store.connect({ ...change, sourceId: ENDPOINT_SOURCE_ID, provider: "endpoint", key: text }));
  if ("status" in saved) return saved;
  await endpointAudited(context, who, connected ? "agent_ai.endpoint.rotated" : "agent_ai.endpoint.connected");
  return answer(context, who);
}

async function removeEndpoint(context: RouteContext): Promise<RouteAnswer> {
  const who = await endpointAdmin(context, false);
  if ("status" in who) return who;
  const body = record(context.body);
  if (body === undefined || Object.keys(body).length !== 2 || typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision)) return ENDPOINT_WORDS.invalid;
  const backend = context.productAi!;
  const removed = await endpointCall(() => backend.store.remove({ iss: backend.issuer, cid: who.companyId, owner: LEARNING_AI_OWNER, requestId: body.requestId as string, expectedRevision: body.expectedRevision as number, actor: { id: who.developerId, role: "company_admin" }, sourceId: ENDPOINT_SOURCE_ID }));
  if ("status" in removed) return removed;
  await endpointAudited(context, who, "agent_ai.endpoint.removed");
  return answer(context, who);
}

/** Added to the route table with the company routes (the same Companies table). */
export const AGENT_AI_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/agent-ai$/u, answer: readAgentAi },
  { method: "PUT", path: /^\/org\/agent-ai$/u, answer: putAgentAi },
  { method: "PUT", path: /^\/org\/agent-ai\/endpoint$/u, answer: putEndpoint },
  { method: "DELETE", path: /^\/org\/agent-ai\/endpoint$/u, answer: removeEndpoint },
];
