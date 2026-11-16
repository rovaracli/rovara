// "AI for your agents" (DEC 240): which AI the company's agents use. Saved in Cloud's Companies table (COMPANY#<org>/AGENT_AI), and
// read by the model gateway on every agent call (model-gateway agent-ai.ts). Three choices:
//
//   rovara         Rovara's AI: Claude through Rovara's own AWS account, nothing to paste, charged to the company per use.
//   anthropic_key  the company's own Anthropic key (connected on the "Learning AI key" page; DEC 236).
//   bedrock_byo    the company's own Bedrock (DEC 238): shown as coming soon, refused here until it is built.
//
//   GET /org/agent-ai   the saved choice (null when none), its version, and the three choices
//   PUT /org/agent-ai   {expectedVersion, source}: save the choice
//
// Who: company admins only (Code's access check made now), reads included. A write needs a fresh step-up and goes through the
// app's signed-write path (CSRF in handler.ts). Each saved change is audited. There is never an automatic switch between sources:
// the gateway uses only the saved one.
import { recordCloudAction } from "./audit-log.js";
import { AGENT_AI_SOURCES, COMPANY_ID, CompanyStoreConflict, type AgentAiSource } from "./company-store.js";
import { LEARNING_AI_OWNER } from "./learning-ai-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The sources an admin may save now. `bedrock_byo` stays reserved (DEC 238). */
export const AGENT_AI_CHOOSABLE: readonly AgentAiSource[] = ["rovara", "anthropic_key"];
const BODY_BYTES_MAX = 1_024;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "AI for your agents isn't set up on this Cloud."),
  noCompany: refusal(403, "FORBIDDEN", "Your sign-in doesn't belong to a company Cloud knows."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change the AI the company's agents use."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  invalid: refusal(400, "CONFIG_INVALID", "Choose Rovara's AI or your own Anthropic key."),
  comingSoon: refusal(400, "CONFIG_INVALID", "Your own Bedrock is coming soon. Choose Rovara's AI or your own Anthropic key for now."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CONFLICT", "The AI for your agents changed. Refresh and try again."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "AI for your agents is unavailable right now. Try again."),
});
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

interface Admin { companyId: string; developerId: string; name: string }

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

/** Whether the company's own Anthropic key is connected (the learning document of the product key store), or null when this Cloud can't tell. */
async function anthropicKeyConnected(context: RouteContext, companyId: string): Promise<boolean | null> {
  const productAi = context.productAi;
  if (productAi === undefined) return null;
  try {
    const view = await productAi.store.view(productAi.issuer, companyId, LEARNING_AI_OWNER);
    return view.sources.some((s) => s.provider === "anthropic" && s.hasKey && s.available);
  } catch { return null; }
}

async function answer(context: RouteContext, who: Admin): Promise<RouteAnswer> {
  let saved;
  try { saved = await context.company!.store.agentAi(who.companyId); } catch { return WORDS.unavailable; }
  return ok({
    source: saved?.source ?? null,
    version: saved?.version ?? 0,
    canChange: true,
    choices: AGENT_AI_SOURCES.map((source) => ({ source, available: AGENT_AI_CHOOSABLE.includes(source) })),
    anthropicKeyConnected: await anthropicKeyConnected(context, who.companyId),
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
  if (body.source === "bedrock_byo") return WORDS.comingSoon;
  const source = AGENT_AI_CHOOSABLE.find((s) => s === body.source);
  if (source === undefined) return WORDS.invalid;
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
