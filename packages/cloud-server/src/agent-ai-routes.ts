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
// Who: company admins only (Code's access check made now), reads included. A write needs a fresh step-up and goes through the
// app's signed-write path (CSRF in handler.ts). Each saved change is audited. There is never an automatic switch between sources:
// the gateway uses only the saved one.
import { recordCloudAction } from "./audit-log.js";
import { AGENT_AI_SOURCES, agentSourceSwitchedOn, COMPANY_ID, CompanyStoreConflict, type AgentAiSource } from "./company-store.js";
import { bedrockConnected } from "./bedrock-byo-routes.js";
import { LEARNING_AI_OWNER } from "./learning-ai-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The sources an admin may save. `bedrock_byo` (DEC 238) only once the company's Bedrock is connected on this Cloud. */
export const AGENT_AI_CHOOSABLE: readonly AgentAiSource[] = ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key"];
/** The sources every Cloud lists; the others (DEC 254t) are listed only where their kind is switched on, so this answer is unchanged elsewhere. */
const ALWAYS_LISTED: readonly AgentAiSource[] = ["rovara", "anthropic_key", "bedrock_byo"];
/** The company account each own-key source (DEC 254t) needs before it can be chosen (the learning document's provider). */
const KEY_OF: Readonly<Partial<Record<AgentAiSource, "openai" | "openrouter">>> = Object.freeze({ openai_key: "openai", openrouter_key: "openrouter" });
const BODY_BYTES_MAX = 1_024;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "AI for your agents isn't set up on this Cloud."),
  noCompany: refusal(403, "FORBIDDEN", "Your sign-in doesn't belong to a company Cloud knows."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change the AI the company's agents use."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
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
async function admin(context: RouteContext, write: boolean): Promise<Admin | RouteAnswer> {
  const backend = context.company;
  if (backend === undefined) return WORDS.off;
  const access = await context.client.access(context.session);
  const said = (access as { companyId?: unknown }).companyId;
  let companyId: string;
  if (said !== undefined) {
    if (typeof said !== "string" || !COMPANY_ID.test(said)) return WORDS.noCompany;
    companyId = said;
  } else if (backend.companyId !== undefined && COMPANY_ID.test(backend.companyId)) companyId = backend.companyId;
  else return WORDS.noCompany;
  if (access.administrator !== true || !/^[a-f0-9]{64}$/u.test(access.developerId)) return WORDS.forbidden;
  if (write && freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return WORDS.stepUp;
  return { companyId, developerId: access.developerId, name: access.displayName };
}

/** Whether the company's own key of `provider` is connected (the learning document of the product key store), or null when this Cloud can't tell. */
async function keyConnected(context: RouteContext, companyId: string, provider: "anthropic" | "openai" | "openrouter"): Promise<boolean | null> {
  const productAi = context.productAi;
  if (productAi === undefined) return null;
  try {
    const view = await productAi.store.view(productAi.issuer, companyId, LEARNING_AI_OWNER);
    return view.sources.some((s) => s.provider === provider && s.hasKey && s.available);
  } catch { return null; }
}
const anthropicKeyConnected = (context: RouteContext, companyId: string) => keyConnected(context, companyId, "anthropic");

async function answer(context: RouteContext, who: Admin): Promise<RouteAnswer> {
  let saved;
  try { saved = await context.company!.store.agentAi(who.companyId); } catch { return WORDS.unavailable; }
  const bedrock = await bedrockConnected(context, who.companyId);
  // DEC 254t: an own-key source is listed only where its kind is switched on (elsewhere this answer is exactly as before), and
  // available only once its key is connected (the gateway would refuse every call otherwise).
  const listed = AGENT_AI_SOURCES.filter((source) => ALWAYS_LISTED.includes(source) || switchedOn(context, source));
  const keys: Partial<Record<AgentAiSource, boolean | null>> = {};
  for (const source of listed) { const provider = KEY_OF[source]; if (provider !== undefined) keys[source] = await keyConnected(context, who.companyId, provider); }
  return ok({
    source: saved?.source ?? null,
    version: saved?.version ?? 0,
    canChange: true,
    choices: listed.map((source) => ({ source, available: AGENT_AI_CHOOSABLE.includes(source) && switchedOn(context, source) && (source !== "bedrock_byo" || bedrock === true) && (KEY_OF[source] === undefined || keys[source] === true) })),
    anthropicKeyConnected: await anthropicKeyConnected(context, who.companyId),
    bedrockConnected: bedrock,
    ...(keys.openai_key === undefined ? {} : { openaiKeyConnected: keys.openai_key }),
    ...(keys.openrouter_key === undefined ? {} : { openrouterKeyConnected: keys.openrouter_key }),
  });
}

async function readAgentAi(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, false);
  return "status" in who ? who : answer(context, who);
}

async function putAgentAi(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, true);
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

/** Added to the route table with the company routes (the same Companies table). */
export const AGENT_AI_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/agent-ai$/u, answer: readAgentAi },
  { method: "PUT", path: /^\/org\/agent-ai$/u, answer: putAgentAi },
];
