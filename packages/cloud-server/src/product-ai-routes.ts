// The project's product AI settings (B7; docs/model-gateway-product-ai.md "Settings"): the customer's own AI Studio key for the
// calls their tests make, the project's eval budget per stage run, and the approved eval spend the gateway's stage hold reads.
//
//   GET    /projects/:name/product-ai                 what is set (never the key: no answer, log or audit record carries it)
//   PUT    /projects/:name/product-ai/key             {requestId, expectedRevision, key}: connect, or rotate when one is connected
//   DELETE /projects/:name/product-ai/key             {requestId, expectedRevision}: remove (7-day recovery window in the store)
//   PUT    /projects/:name/product-ai/eval-budget     {requestId, expectedRevision, calls, costMicros}
//   PUT    /projects/:name/product-ai/eval-approval   {requestId, expectedRevision, approval: {...} | null}
//
// Who: the project's admin (Code's access check made now: the project's access is "administrator") or a company admin; anyone
// else is refused, and a project the person can't see is not found. Every write needs a fresh step-up, and goes through the
// app's signed-write path (CSRF in handler.ts, the body hash at CloudFront). The store is the gateway's write-only product key
// store (scripts/cloud-lambda.ts wires ProductKeyStore over the gateway's product key table and KMS keys); it seals the key in
// one transaction with its own receipt and audit row, and Cloud records its own audit record after the change is saved.
import { recordCloudAction, type CloudAuditAction } from "./audit-log.js";
import { COMPANY_ID } from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The store's error codes (product-keys.ts ProductKeyErrorCode), answered in this module's own fixed words. */
export type ProductAiErrorCode = "invalid" | "stale" | "not_found" | "in_recovery" | "forbidden" | "unavailable" | "too_open" | "refused";
export interface ProductAiActor { id: string; role: "company_admin" | "project_maintainer" }
interface Change { iss: string; cid: string; owner: string; requestId: string; expectedRevision: number; actor: ProductAiActor }
/** The view the store answers (ProductKeysView): never a key. */
export interface ProductAiView {
  revision: number; owner: string;
  sources: Array<{ sourceId: string; provider: string; hasKey: boolean; available: boolean; connectedAt: number; updatedAt: number; warning?: { status: number; at: number }; linkedTo?: string }>;
  removed: Array<{ sourceId: string; provider: string; recoverUntil: number }>;
  caps?: { taskMicros: number; projectMonthMicros: number };
  evalBudget?: { calls: number; costMicros: number };
  evalApproval?: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string; approver: { personId: string; provider: string }; role: string; approvedAt: number };
}
/** What the routes need from ProductKeyStore (structural: cloud-server does not depend on the gateway package). */
export interface ProductAiStore {
  view(iss: string, cid: string, owner: string): Promise<ProductAiView>;
  connect(change: Change & { sourceId: string; provider: "gemini"; key: string }): Promise<ProductAiView>;
  rotate(change: Change & { sourceId: string; key: string }): Promise<ProductAiView>;
  remove(change: Change & { sourceId: string }): Promise<ProductAiView>;
  setEvalBudget(change: Change & { budget: { calls: number; costMicros: number } }): Promise<ProductAiView>;
  setEvalApproval(change: Change & { approval: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string } | null; provider: string }): Promise<ProductAiView>;
}
export interface ProductAiBackend {
  store: ProductAiStore;
  /** The Code install's token issuer (`<ROVARA_CODE_URL>/v1/auth`): the key rows are bound to it, as the gateway reads them. */
  issuer: string;
  /** The deployment's one company, used only when Code's access check names none (as company-routes.ts). */
  companyId?: string;
}

/** The project's one AI Studio source (one per provider per project, so the route never has to guess). */
export const PRODUCT_AI_SOURCE_ID = "src_gemini";
/** Approvals are recorded with this approver provider: the approver is a person of this Code install. */
export const PRODUCT_AI_APPROVER_PROVIDER = "rovara-code";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BODY_BYTES_MAX = 4_096;

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Product AI settings aren't set up on this Cloud."),
  noCompany: refusal(403, "FORBIDDEN", "Your sign-in doesn't belong to a company Cloud knows."),
  notFound: refusal(404, "PROJECT_NOT_FOUND", "That project doesn't exist, or you can't use it."),
  forbidden: refusal(403, "FORBIDDEN", "Only the project's admin or a company admin can change its product AI settings."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  invalid: refusal(400, "CONFIG_INVALID", "These product AI settings are not valid."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CONFLICT", "Product AI settings changed. Refresh and try again."),
  noKey: refusal(404, "NOT_FOUND", "No product AI key is connected to this project."),
  inRecovery: refusal(409, "CONFLICT", "This key was removed less than 7 days ago. Ask an installation administrator to recover it."),
  keyRefused: refusal(400, "CONFIG_INVALID", "The provider refused this key."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Product AI settings are unavailable right now. Try again."),
});
const ANSWER_OF: Record<ProductAiErrorCode, RouteAnswer> = {
  invalid: WORDS.invalid, stale: WORDS.stale, not_found: WORDS.noKey, in_recovery: WORDS.inRecovery, forbidden: WORDS.forbidden,
  unavailable: WORDS.unavailable, too_open: WORDS.keyRefused, refused: WORDS.keyRefused,
};
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const exactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

interface Who { backend: ProductAiBackend; companyId: string; developerId: string; name: string; role: ProductAiActor["role"]; project: string }

/** The person, their company and their role in this project, from Code's access check made now. A RouteAnswer when refused. */
async function who(context: RouteContext, write: boolean): Promise<Who | RouteAnswer> {
  const backend = context.productAi;
  if (backend === undefined) return WORDS.off;
  const project = context.params[0] ?? "";
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(project)) return WORDS.notFound;
  const access = await context.client.access(context.session);
  const named = (access as { companyId?: unknown }).companyId;
  let companyId: string;
  if (named !== undefined) {
    if (typeof named !== "string" || !COMPANY_ID.test(named)) return WORDS.noCompany;
    companyId = named;
  } else if (backend.companyId !== undefined && COMPANY_ID.test(backend.companyId)) companyId = backend.companyId;
  else return WORDS.noCompany;
  const mine = access.projects.find((each) => each.name === project);
  const role = access.administrator === true ? "company_admin" : mine?.access === "administrator" ? "project_maintainer" : undefined;
  // A project the person can't see is not found; one they see but don't administer is refused.
  if (mine === undefined && access.administrator !== true) return WORDS.notFound;
  if (role === undefined) return WORDS.forbidden;
  if (!/^[a-f0-9]{64}$/u.test(access.developerId)) return WORDS.forbidden;
  if (write && freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return WORDS.stepUp;
  return { backend, companyId, developerId: access.developerId, name: access.displayName, role, project };
}

/** The store's answer, without anything the app has no use for (the approver's person id is shown as "you" or not). */
function view(v: ProductAiView, w: Who) {
  const gemini = v.sources.find((s) => s.provider === "gemini");
  return {
    project: w.project, revision: v.revision, canChange: true,
    key: gemini === undefined ? { connected: false } : { connected: gemini.hasKey && gemini.available, connectedAt: gemini.connectedAt, updatedAt: gemini.updatedAt, ...(gemini.warning === undefined ? {} : { refusedAt: gemini.warning.at }) },
    removedUntil: v.removed.find((r) => r.provider === "gemini")?.recoverUntil ?? null,
    evalBudget: v.evalBudget ?? null,
    evalApproval: v.evalApproval === undefined ? null : {
      selection: v.evalApproval.selection, inputsDigest: v.evalApproval.inputsDigest, maxCalls: v.evalApproval.maxCalls, maxCostMicros: v.evalApproval.maxCostMicros,
      ...(v.evalApproval.model === undefined ? {} : { model: v.evalApproval.model }), approvedAt: v.evalApproval.approvedAt, approvedByYou: v.evalApproval.approver.personId === w.developerId,
    },
  };
}

/** Reads the write's envelope: a request id (replay-safe in the store) and the revision the person saw. */
function envelope(context: RouteContext, keys: readonly string[]): { body: Record<string, unknown>; requestId: string; expectedRevision: number } | RouteAnswer {
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || !exactly(body, ["requestId", "expectedRevision", ...keys])) return WORDS.invalid;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision)) return WORDS.invalid;
  return { body, requestId: body.requestId, expectedRevision: body.expectedRevision };
}

async function guarded(w: Who, run: () => Promise<ProductAiView>): Promise<ProductAiView | RouteAnswer> {
  try { return await run(); }
  catch (error) {
    // The store's errors carry a fixed code; anything else is an outage. Never the error's text.
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && Object.hasOwn(ANSWER_OF, code) ? ANSWER_OF[code as ProductAiErrorCode] : WORDS.unavailable;
  }
}
async function audited(context: RouteContext, w: Who, action: CloudAuditAction): Promise<void> {
  if (context.audit === undefined) return;
  try {
    await recordCloudAction(context.audit, { companyId: w.companyId, actor: { developerId: w.developerId, name: w.name, type: "person" }, action, via: "web", subject: `project:${w.project}`, project: w.project }, context.now);
  } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action, companyId: w.companyId })); }
}
const changeOf = (w: Who, e: { requestId: string; expectedRevision: number }): Change => ({ iss: w.backend.issuer, cid: w.companyId, owner: w.project, requestId: e.requestId, expectedRevision: e.expectedRevision, actor: { id: w.developerId, role: w.role } });

async function readProductAi(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, false);
  if ("status" in w) return w;
  const v = await guarded(w, () => w.backend.store.view(w.backend.issuer, w.companyId, w.project));
  return "status" in v ? v : ok(view(v, w));
}

async function putKey(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, ["key"]);
  if ("status" in e) return e;
  const key = e.body.key;
  if (typeof key !== "string" || !/^[\x21-\x7e]{8,512}$/u.test(key)) return WORDS.invalid;
  const current = await guarded(w, () => w.backend.store.view(w.backend.issuer, w.companyId, w.project));
  if ("status" in current) return current;
  const connected = current.sources.some((s) => s.sourceId === PRODUCT_AI_SOURCE_ID && s.hasKey);
  const v = await guarded(w, () => connected
    ? w.backend.store.rotate({ ...changeOf(w, e), sourceId: PRODUCT_AI_SOURCE_ID, key })
    : w.backend.store.connect({ ...changeOf(w, e), sourceId: PRODUCT_AI_SOURCE_ID, provider: "gemini", key }));
  if ("status" in v) return v;
  await audited(context, w, connected ? "product_ai.key.rotated" : "product_ai.key.connected");
  return ok(view(v, w));
}

async function removeKey(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, []);
  if ("status" in e) return e;
  const v = await guarded(w, () => w.backend.store.remove({ ...changeOf(w, e), sourceId: PRODUCT_AI_SOURCE_ID }));
  if ("status" in v) return v;
  await audited(context, w, "product_ai.key.removed");
  return ok(view(v, w));
}

async function putEvalBudget(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, ["calls", "costMicros"]);
  if ("status" in e) return e;
  const { calls, costMicros } = e.body;
  if (!whole(calls) || !whole(costMicros) || calls < 1 || costMicros < 1) return WORDS.invalid;
  const v = await guarded(w, () => w.backend.store.setEvalBudget({ ...changeOf(w, e), budget: { calls, costMicros } }));
  if ("status" in v) return v;
  await audited(context, w, "product_ai.eval_budget.changed");
  return ok(view(v, w));
}

async function putEvalApproval(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, ["approval"]);
  if ("status" in e) return e;
  const raw = e.body.approval;
  let approval: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string } | null = null;
  if (raw !== null) {
    const a = record(raw);
    const keys = a === undefined ? [] : Object.keys(a);
    if (a === undefined || !["selection", "inputsDigest", "maxCalls", "maxCostMicros"].every((k) => keys.includes(k)) || !keys.every((k) => ["selection", "inputsDigest", "maxCalls", "maxCostMicros", "model"].includes(k))) return WORDS.invalid;
    if (typeof a.selection !== "string" || typeof a.inputsDigest !== "string" || !whole(a.maxCalls) || !whole(a.maxCostMicros) || (a.model !== undefined && typeof a.model !== "string")) return WORDS.invalid;
    approval = { selection: a.selection, inputsDigest: a.inputsDigest, maxCalls: a.maxCalls, maxCostMicros: a.maxCostMicros, ...(typeof a.model === "string" ? { model: a.model } : {}) };
  }
  // The store checks every field again (lengths, digest, model id) and records the approver as this person.
  const v = await guarded(w, () => w.backend.store.setEvalApproval({ ...changeOf(w, e), approval, provider: PRODUCT_AI_APPROVER_PROVIDER }));
  if ("status" in v) return v;
  await audited(context, w, approval === null ? "product_ai.eval_approval.withdrawn" : "product_ai.eval_approval.recorded");
  return ok(view(v, w));
}

const PROJECT_PATH = "\\/projects\\/([a-z][a-z0-9-]{0,62})\\/product-ai";
/** Added to the route table when the handler has a product AI backend. */
export const PRODUCT_AI_ROUTES: Route[] = [
  { method: "GET", path: new RegExp(`^${PROJECT_PATH}$`, "u"), answer: readProductAi },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/key$`, "u"), answer: putKey },
  { method: "DELETE", path: new RegExp(`^${PROJECT_PATH}\\/key$`, "u"), answer: removeKey },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/eval-budget$`, "u"), answer: putEvalBudget },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/eval-approval$`, "u"), answer: putEvalApproval },
];
