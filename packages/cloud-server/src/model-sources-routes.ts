// Model sources (DEC 254zzz84(4)): the company's provider ORDER for its agents' AI, e.g. its own key first, then Rovara's AI. It is the "AI for your agents"
// row (COMPANY#<org>/AGENT_AI, agent-ai-routes.ts): `source` is the first choice and `fallback` the sources after it, in order. The model gateway admits each
// call on the first source of that order that can take it now (model-gateway server.ts); a row without `fallback` is exactly the single choice of before.
//
//   GET /org/model-sources        any member of the company: the order, every source this Cloud lists with whether it can be chosen and is connected, the revision
//   PUT /org/model-sources-order  a company owner or admin: {requestId, expectedOrgId, expectedDeveloperId, expectedRevision, order}
//
// Rules:
//   - The company and role are Code's access answer made now (companyCaller); nothing the browser sends names a company. `expectedOrgId` and
//     `expectedDeveloperId` must be the caller's own: a page drawn for another company or person changes nothing.
//   - No step-up (DEC 254zzz73); the app's signed-write path (CSRF in handler.ts) still applies to the PUT.
//   - Every source in the order is one this Cloud lists and that can be chosen now (the same rule as PUT /org/agent-ai), each once, at most
//     1 + AGENT_AI_FALLBACK_MAX. The revision is the row's version: a change made meanwhile is refused (409), nothing written.
//   - Every refusal is fixed words: nothing from the request is echoed. Each saved change is audited.
import { recordCloudAction } from "./audit-log.js";
import { agentSourceAvailability } from "./agent-ai-routes.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { AGENT_AI_FALLBACK_MAX, CompanyStoreConflict, validAgentAiSource, type AgentAiSource } from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

const BODY_BYTES_MAX = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
export const MODEL_SOURCES_ANSWERS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "AI for your agents isn't set up on this Cloud."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company owner or admin can change the order of the company's AI sources."),
  invalid: refusal(400, "CONFIG_INVALID", "Send the order as a list of the AI sources shown, each once."),
  notAvailable: refusal(400, "CONFIG_INVALID", "Every AI source in the order must be one your company can use now. Connect it first, then add it."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CHANGE_STALE", "The AI sources changed. Refresh and try again."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The AI sources are unavailable right now. Try again."),
});
const A = MODEL_SOURCES_ANSWERS;
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const exactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

interface Caller { companyId: string; developerId: string; name: string; admin: boolean }
async function caller(context: RouteContext): Promise<Caller | RouteAnswer> {
  if (context.company === undefined) return A.off;
  const who = await companyCaller(context);
  if (refused(who)) return who;
  return { companyId: who.companyId, developerId: who.developerId, name: who.name, admin: isCompanyAdmin(who.companyRole) };
}

async function snapshot(context: RouteContext, who: Caller): Promise<RouteAnswer> {
  let saved;
  try { saved = await context.company!.store.agentAi(who.companyId); } catch { return A.unavailable; }
  let listed;
  try { listed = await agentSourceAvailability(context, who.companyId); } catch { return A.unavailable; }
  const order: AgentAiSource[] = saved === undefined ? [] : [saved.source, ...(saved.fallback ?? [])];
  return {
    status: 200,
    body: {
      orgId: who.companyId, developerId: who.developerId, revision: saved?.version ?? 0, canChange: who.admin, order,
      sources: listed.map((entry) => ({ source: entry.source, available: entry.available, connected: entry.connected, inOrder: order.includes(entry.source) })),
    },
  };
}

async function readModelSources(context: RouteContext): Promise<RouteAnswer> {
  const who = await caller(context);
  return "status" in who ? who : snapshot(context, who);
}

async function putModelSourcesOrder(context: RouteContext): Promise<RouteAnswer> {
  const who = await caller(context);
  if ("status" in who) return who;
  // The role first: a plain member learns nothing more.
  if (!who.admin) return A.forbidden;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return A.tooLarge;
  const body = record(context.body);
  if (body === undefined || !exactly(body, ["requestId", "expectedOrgId", "expectedDeveloperId", "expectedRevision", "order"])) return A.invalid;
  if (typeof body["requestId"] !== "string" || !UUID.test(body["requestId"]) || !whole(body["expectedRevision"])) return A.invalid;
  // A page drawn for another company or another person changes nothing.
  if (body["expectedOrgId"] !== who.companyId || body["expectedDeveloperId"] !== who.developerId) return A.stale;
  const order = body["order"];
  if (!Array.isArray(order) || order.length === 0 || order.length > 1 + AGENT_AI_FALLBACK_MAX || !order.every(validAgentAiSource) || new Set(order).size !== order.length) return A.invalid;
  let listed;
  try { listed = await agentSourceAvailability(context, who.companyId); } catch { return A.unavailable; }
  if (!order.every((source) => listed.some((entry) => entry.source === source && entry.available))) return A.notAvailable;
  const [first, ...rest] = order;
  try {
    await context.company!.store.putAgentAi({ companyId: who.companyId, source: first!, updatedAt: context.now().toISOString(), updatedBy: who.developerId, ...(rest.length === 0 ? {} : { fallback: rest }) }, body["expectedRevision"]);
  } catch (error) { return error instanceof CompanyStoreConflict ? A.stale : A.unavailable; }
  if (context.audit !== undefined) {
    try {
      await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action: "agent_ai.source.changed", via: "web", subject: `agent_ai:${first!}`, detail: `order:${(order as string[]).join(",")}` }, context.now);
    } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action: "agent_ai.source.changed", companyId: who.companyId })); }
  }
  const after = await snapshot(context, who);
  // The receipt the page checks: the saved order and its new revision.
  return after.status !== 200 ? after : { status: 200, body: { ...(after.body as Record<string, unknown>) } };
}

/** Added to the company routes (handler.ts, beside AGENT_AI_ROUTES). */
export const MODEL_SOURCES_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/model-sources$/u, answer: readModelSources },
  { method: "PUT", path: /^\/org\/model-sources-order$/u, answer: putModelSourcesOrder },
];
