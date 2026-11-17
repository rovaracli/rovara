// The project's product AI settings (B7; docs/model-gateway-product-ai.md "Settings"): the customer's own AI Studio key for the
// calls their tests make, the project's eval budget per stage run, and the approved eval spend the gateway's stage hold reads.
//
//   GET    /projects/:name/product-ai                 what is set (never the key: no answer, log or audit record carries it)
//   PUT    /projects/:name/product-ai/key             {requestId, expectedRevision, key}: connect, or rotate when one is connected
//   DELETE /projects/:name/product-ai/key             {requestId, expectedRevision}: remove (7-day recovery window in the store)
//   PUT    /projects/:name/product-ai/eval-budget     {requestId, expectedRevision, calls, costMicros}
//   PUT    /projects/:name/product-ai/eval-approval   {requestId, expectedRevision, approval: {...} | null}
//   PUT    /projects/:name/product-ai/vertex          {requestId, expectedRevision, projectId, location, audience, serviceAccount | null}:
//                                                     test and save a Vertex AI federation setup (PRODUCT-VERTEX-CLOUD-CONNECT). The store
//                                                     asks the model gateway to run the connection test (service-call.ts: a token for this
//                                                     company, and the canary company refused) before it seals; nothing is saved otherwise.
//   DELETE /projects/:name/product-ai/vertex          {requestId, expectedRevision}
//   PUT    /projects/:name/product-ai/bedrock         {requestId, expectedRevision, roleArn, region, models, allowGlobal, productModels?}: the project's OWN
//                                                     Bedrock role for its tests' calls (DEC 238 slice 2), tested by the gateway like the company's
//   PUT    /projects/:name/product-ai/bedrock/link    {requestId, expectedRevision}: use the company's connected Bedrock (a link, never a copy)
//   DELETE /projects/:name/product-ai/bedrock         {requestId, expectedRevision}: remove the own role, or the link
//   POST   /projects/:name/product-ai/bedrock/setup   {region, models, allowGlobal, productModels?}: the CloudShell command that creates the role
//
// Eval approvals (PRODUCT-EVAL-APPROVER-REREAD): an approval counts at the gateway's stage hold for 15 minutes from the role check
// made here, and Cloud withdraws a person's approvals when it changes their membership (withdrawForMember, below).
//
// Who: the project's admin (Code's access check made now: the project's access is "administrator") or a company admin; anyone
// else is refused, and a project the person can't see is not found. Every write needs a fresh step-up, and goes through the
// app's signed-write path (CSRF in handler.ts, the body hash at CloudFront). The store is the gateway's write-only product key
// store (scripts/cloud-lambda.ts wires ProductKeyStore over the gateway's product key table and KMS keys); it seals the key in
// one transaction with its own receipt and audit row, and Cloud records its own audit record after the change is saved.
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { recordCloudAction, type CloudAuditAction } from "./audit-log.js";
import { COMPANY_ID } from "./company-store.js";
import { BEDROCK_ANSWERS, BEDROCK_ROLE_ARN, BEDROCK_WORDS, choiceKeys, choiceOf, connectionKey, type BedrockBackend } from "./bedrock-byo-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The store's error codes (product-keys.ts ProductKeyErrorCode), answered in this module's own fixed words. */
export type ProductAiErrorCode = "invalid" | "stale" | "not_found" | "in_recovery" | "forbidden" | "unavailable" | "too_open" | "refused" | "aws_too_open" | "aws_refused" | "role_in_use";
export interface ProductAiActor { id: string; role: "company_admin" | "project_maintainer" }
export interface ProductAiChange { iss: string; cid: string; owner: string; requestId: string; expectedRevision: number; actor: ProductAiActor }
type Change = ProductAiChange;
/** The view the store answers (ProductKeysView): never a key. */
export interface ProductAiView {
  revision: number; owner: string;
  sources: Array<{ sourceId: string; provider: string; hasKey: boolean; available: boolean; connectedAt: number; updatedAt: number; warning?: { status: number; at: number }; linkedTo?: string; vertex?: { scheme: string; projectId: string; location: string; serviceAccount?: string }; bedrock?: { roleArn: string; region: string; models: Record<string, string>; allowGlobal: boolean; productModels?: readonly string[]; checks: Record<string, string>; checkedAt: number } }>;
  removed: Array<{ sourceId: string; provider: string; recoverUntil: number }>;
  caps?: { taskMicros: number; projectMonthMicros: number };
  evalBudget?: { calls: number; costMicros: number };
  evalApproval?: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string; approver: { personId: string; provider: string }; role: string; approvedAt: number };
  evalApprovalState?: "current" | "stale" | "withdrawn";
}
/** What the routes need from ProductKeyStore (structural: cloud-server does not depend on the gateway package). */
export interface ProductAiStore {
  view(iss: string, cid: string, owner: string): Promise<ProductAiView>;
  connect(change: Change & { sourceId: string; provider: "gemini" | "vertex" | "anthropic" | "openai" | "bedrock"; key: string }): Promise<ProductAiView>;
  rotate(change: Change & { sourceId: string; key: string }): Promise<ProductAiView>;
  /** A project uses a company source (a link, never a copy; product-keys.ts link). */
  link(change: Change & { sourceId: string; companySourceId: string }): Promise<ProductAiView>;
  remove(change: Change & { sourceId: string }): Promise<ProductAiView>;
  /** Restores a removed source inside its 7-day window (product-keys.ts recover). */
  recover(change: Change & { sourceId: string }): Promise<ProductAiView>;
  setEvalBudget(change: Change & { budget: { calls: number; costMicros: number } }): Promise<ProductAiView>;
  setEvalApproval(change: Change & { approval: { selection: string; inputsDigest: string; maxCalls: number; maxCostMicros: number; model?: string } | null; provider: string; roleCheckedAt?: number }): Promise<ProductAiView>;
  /** Every eval approval this person made up to now stops counting (product-keys.ts withdrawApprovals). Throws when not saved. */
  withdrawApprovals(iss: string, cid: string, personId: string): Promise<void>;
}
export interface ProductAiBackend {
  store: ProductAiStore;
  /** The Code install's token issuer (`<ROVARA_CODE_URL>/v1/auth`): the key rows are bound to it, as the gateway reads them. */
  issuer: string;
  /** The company's own Bedrock (bedrock-byo-routes.ts, DEC 238): absent when the gateway's set-up call or the template is not configured. */
  bedrock?: BedrockBackend;
}

/** The project's one AI Studio source (one per provider per project, so the route never has to guess). */
export const PRODUCT_AI_SOURCE_ID = "src_gemini";
/** The project's one Vertex AI source. */
export const PRODUCT_AI_VERTEX_SOURCE_ID = "src_vertex";
/** Approvals are recorded with this approver provider: the approver is a person of this Code install. */
export const PRODUCT_AI_APPROVER_PROVIDER = "rovara-code";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BODY_BYTES_MAX = 4_096;

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Product AI settings aren't set up on this Cloud."),
  notFound: refusal(404, "PROJECT_NOT_FOUND", "That project doesn't exist, or you can't use it."),
  forbidden: refusal(403, "FORBIDDEN", "Only the project's admin or a company admin can change its product AI settings."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  invalid: refusal(400, "CONFIG_INVALID", "These product AI settings are not valid."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CONFLICT", "Product AI settings changed. Refresh and try again."),
  noKey: refusal(404, "NOT_FOUND", "No product AI key is connected to this project."),
  inRecovery: refusal(409, "CONFLICT", "This key was removed less than 7 days ago. Ask an installation administrator to recover it."),
  keyRefused: refusal(400, "CONFIG_INVALID", "The provider refused this key."),
  memberId: refusal(400, "CONFIG_INVALID", "Name the person by their member id."),
  memberForbidden: refusal(403, "FORBIDDEN", "Only the project's admin or a company admin can change its members."),
  vertexRefused: refusal(400, "CONFIG_INVALID", "Google refused this Vertex AI setup: check the project, the workload identity provider and the service account."),
  vertexTooOpen: refusal(400, "CONFIG_INVALID", "This Vertex AI setup lets other Rovara companies through. Add the attribute condition for your company, then try again."),
  vertexUnavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The Vertex AI connection test is unavailable right now. Nothing was saved. Try again."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Product AI settings are unavailable right now. Try again."),
});
const ANSWER_OF: Record<ProductAiErrorCode, RouteAnswer> = {
  invalid: WORDS.invalid, stale: WORDS.stale, not_found: WORDS.noKey, in_recovery: WORDS.inRecovery, forbidden: WORDS.forbidden,
  unavailable: WORDS.unavailable, too_open: WORDS.keyRefused, refused: WORDS.keyRefused, aws_too_open: WORDS.keyRefused, aws_refused: WORDS.keyRefused, role_in_use: WORDS.keyRefused,
};
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

interface Who { backend: ProductAiBackend; companyId: string; developerId: string; name: string; role: ProductAiActor["role"]; project: string; /** When Code's access check began (an approval counts from then). */ checkedAt: number }

/** The person, their company and their role in this project, from Code's access check made now. A RouteAnswer when refused. */
async function who(context: RouteContext, write: boolean): Promise<Who | RouteAnswer> {
  const backend = context.productAi;
  if (backend === undefined) return WORDS.off;
  const project = context.params[0] ?? "";
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(project)) return WORDS.notFound;
  const checkedAt = context.now().getTime();
  const caller = await companyCaller(context);
  if (refused(caller)) return caller;
  const { access, companyId } = caller;
  const mine = access.projects.find((each) => each.name === project);
  // A company owner or admin (Code's company role, never its install administrator flag), else the project's maintainer.
  const companyAdmin = isCompanyAdmin(caller.companyRole);
  const role = companyAdmin ? "company_admin" : mine?.access === "administrator" ? "project_maintainer" : undefined;
  // A project the person can't see is not found; one they see but don't administer is refused.
  if (mine === undefined && !companyAdmin) return WORDS.notFound;
  if (role === undefined) return WORDS.forbidden;
  if (!/^[a-f0-9]{64}$/u.test(access.developerId)) return WORDS.forbidden;
  if (write && freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return WORDS.stepUp;
  return { backend, companyId, developerId: access.developerId, name: access.displayName, role, project, checkedAt };
}

/** The store's answer, without anything the app has no use for (the approver's person id is shown as "you" or not). */
function view(v: ProductAiView, w: Who) {
  const gemini = v.sources.find((s) => s.provider === "gemini");
  const vertex = v.sources.find((s) => s.provider === "vertex");
  return {
    project: w.project, revision: v.revision, canChange: true,
    key: gemini === undefined ? { connected: false } : { connected: gemini.hasKey && gemini.available, connectedAt: gemini.connectedAt, updatedAt: gemini.updatedAt, ...(gemini.warning === undefined ? {} : { refusedAt: gemini.warning.at }) },
    removedUntil: v.removed.find((r) => r.provider === "gemini")?.recoverUntil ?? null,
    vertex: vertex?.vertex === undefined ? { connected: false } : {
      connected: vertex.hasKey && vertex.available, connectedAt: vertex.connectedAt, updatedAt: vertex.updatedAt, ...(vertex.warning === undefined ? {} : { refusedAt: vertex.warning.at }),
      projectId: vertex.vertex.projectId, location: vertex.vertex.location, ...(vertex.vertex.serviceAccount === undefined ? {} : { serviceAccount: vertex.vertex.serviceAccount }),
    },
    vertexRemovedUntil: v.removed.find((r) => r.provider === "vertex")?.recoverUntil ?? null,
    bedrock: bedrockView(v),
    bedrockRemovedUntil: v.removed.find((r) => r.provider === "bedrock")?.recoverUntil ?? null,
    evalBudget: v.evalBudget ?? null,
    evalApproval: v.evalApproval === undefined ? null : {
      selection: v.evalApproval.selection, inputsDigest: v.evalApproval.inputsDigest, maxCalls: v.evalApproval.maxCalls, maxCostMicros: v.evalApproval.maxCostMicros,
      ...(v.evalApproval.model === undefined ? {} : { model: v.evalApproval.model }), approvedAt: v.evalApproval.approvedAt, approvedByYou: v.evalApproval.approver.personId === w.developerId,
      // Not told: not counted (fail closed). "stale" and "withdrawn" both mean: approve again.
      state: v.evalApprovalState ?? "stale",
    },
  };
}

/** The project's Bedrock source (DEC 238 slice 2): its own role, or a link to the company's. Nothing secret is in either. */
function bedrockView(v: ProductAiView) {
  const b = v.sources.find((s) => s.provider === "bedrock");
  if (b === undefined) return { connected: false };
  const connected = b.available && (b.hasKey || b.linkedTo !== undefined);
  if (b.linkedTo !== undefined) return { connected, linked: true, linkedTo: b.linkedTo, connectedAt: b.connectedAt, ...(b.warning === undefined ? {} : { refusedAt: b.warning.at }) };
  if (b.bedrock === undefined) return { connected: false };
  return {
    connected, linked: false, connectedAt: b.connectedAt, updatedAt: b.updatedAt, ...(b.warning === undefined ? {} : { refusedAt: b.warning.at }),
    roleArn: b.bedrock.roleArn, region: b.bedrock.region, allowGlobal: b.bedrock.allowGlobal, checkedAt: b.bedrock.checkedAt,
    models: Object.entries(b.bedrock.models).map(([name, id]) => ({ name, id, state: b.bedrock!.checks[id] ?? "unavailable" })),
    productModels: (b.bedrock.productModels ?? []).map((id) => ({ id, state: b.bedrock!.checks[id] ?? "unavailable" })),
  };
}

/** Reads the write's envelope: a request id (replay-safe in the store) and the revision the person saw. */
function envelope(context: RouteContext, keys: readonly string[], optional: readonly string[] = []): { body: Record<string, unknown>; requestId: string; expectedRevision: number } | RouteAnswer {
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || !keys.concat(["requestId", "expectedRevision"]).every((k) => Object.hasOwn(body, k)) || !Object.keys(body).every((k) => k === "requestId" || k === "expectedRevision" || keys.includes(k) || optional.includes(k))) return WORDS.invalid;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision)) return WORDS.invalid;
  return { body, requestId: body.requestId, expectedRevision: body.expectedRevision };
}

async function guarded(w: Who, run: () => Promise<ProductAiView>, answers: Partial<Record<ProductAiErrorCode, RouteAnswer>> = {}): Promise<ProductAiView | RouteAnswer> {
  try { return await run(); }
  catch (error) {
    // The store's errors carry a fixed code; anything else is an outage. Never the error's text.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && Object.hasOwn(answers, code)) return answers[code as ProductAiErrorCode]!;
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
  const v = await guarded(w, () => w.backend.store.setEvalApproval({ ...changeOf(w, e), approval, provider: PRODUCT_AI_APPROVER_PROVIDER, ...(approval === null ? {} : { roleCheckedAt: w.checkedAt }) }));
  if ("status" in v) return v;
  await audited(context, w, approval === null ? "product_ai.eval_approval.withdrawn" : "product_ai.eval_approval.recorded");
  return ok(view(v, w));
}

/** The Vertex AI federation setup the form sends (Google Cloud project, location, workload identity provider, optional service account). */
const VERTEX_FORM = Object.freeze({
  projectId: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u,
  location: /^(?:global|[a-z]{2,15}-[a-z]{2,15}[0-9]{1,2})$/u,
  audience: /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/u,
  serviceAccount: /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com|[0-9]{1,20}-compute@developer\.gserviceaccount\.com)$/u,
});
const VERTEX_ANSWERS: Partial<Record<ProductAiErrorCode, RouteAnswer>> = { refused: WORDS.vertexRefused, too_open: WORDS.vertexTooOpen, unavailable: WORDS.vertexUnavailable };

async function putVertex(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, ["projectId", "location", "audience", "serviceAccount"]);
  if ("status" in e) return e;
  const { projectId, location, audience, serviceAccount } = e.body;
  if (typeof projectId !== "string" || !VERTEX_FORM.projectId.test(projectId) || typeof location !== "string" || !VERTEX_FORM.location.test(location)
    || typeof audience !== "string" || !VERTEX_FORM.audience.test(audience) || (serviceAccount !== null && (typeof serviceAccount !== "string" || !VERTEX_FORM.serviceAccount.test(serviceAccount)))) return WORDS.invalid;
  // The store parses this again (product-vertex-credential.ts), asks the gateway to test it for this company, and seals it.
  const key = JSON.stringify({ scheme: "federation", projectId, location, audience, ...(serviceAccount === null ? {} : { serviceAccount }) });
  const current = await guarded(w, () => w.backend.store.view(w.backend.issuer, w.companyId, w.project));
  if ("status" in current) return current;
  const connected = current.sources.some((s) => s.sourceId === PRODUCT_AI_VERTEX_SOURCE_ID && s.hasKey);
  const v = await guarded(w, () => connected
    ? w.backend.store.rotate({ ...changeOf(w, e), sourceId: PRODUCT_AI_VERTEX_SOURCE_ID, key })
    : w.backend.store.connect({ ...changeOf(w, e), sourceId: PRODUCT_AI_VERTEX_SOURCE_ID, provider: "vertex", key }), VERTEX_ANSWERS);
  if ("status" in v) return v;
  await audited(context, w, connected ? "product_ai.vertex.rotated" : "product_ai.vertex.connected");
  return ok(view(v, w));
}

async function removeVertex(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const e = envelope(context, []);
  if ("status" in e) return e;
  const v = await guarded(w, () => w.backend.store.remove({ ...changeOf(w, e), sourceId: PRODUCT_AI_VERTEX_SOURCE_ID }));
  if ("status" in v) return v;
  await audited(context, w, "product_ai.vertex.removed");
  return ok(view(v, w));
}

/** The project's one Bedrock source, own or linked (the store keeps one source per provider per project). */
export const PRODUCT_AI_BEDROCK_SOURCE_ID = "src_bedrock";
const bedrockOff = (w: Who): RouteAnswer | undefined => (w.backend.bedrock === undefined ? BEDROCK_WORDS.off : undefined);

async function putBedrockOwn(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const off = bedrockOff(w); if (off !== undefined) return off;
  const e = envelope(context, ["roleArn", "region", "models", "allowGlobal"], ["productModels"]);
  if ("status" in e) return e;
  const choice = choiceOf(e.body);
  if (choice === undefined || typeof e.body.roleArn !== "string" || !BEDROCK_ROLE_ARN.test(e.body.roleArn)) return BEDROCK_WORDS.invalid;
  const key = connectionKey(e.body.roleArn, choice);
  const current = await guarded(w, () => w.backend.store.view(w.backend.issuer, w.companyId, w.project), BEDROCK_ANSWERS);
  if ("status" in current) return current;
  const connected = current.sources.some((s) => s.sourceId === PRODUCT_AI_BEDROCK_SOURCE_ID && s.hasKey);
  // The store parses it again, asks the gateway to test it for THIS company (canaries included), refuses a role another company or
  // source holds, and seals it. A project that is linked must remove the link first (the store keeps one source per provider).
  const v = await guarded(w, () => connected
    ? w.backend.store.rotate({ ...changeOf(w, e), sourceId: PRODUCT_AI_BEDROCK_SOURCE_ID, key })
    : w.backend.store.connect({ ...changeOf(w, e), sourceId: PRODUCT_AI_BEDROCK_SOURCE_ID, provider: "bedrock", key }), BEDROCK_ANSWERS);
  if ("status" in v) return v;
  await audited(context, w, connected ? "product_ai.bedrock.rotated" : "product_ai.bedrock.connected");
  return ok(view(v, w));
}

async function linkBedrock(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const off = bedrockOff(w); if (off !== undefined) return off;
  const e = envelope(context, []);
  if ("status" in e) return e;
  const v = await guarded(w, () => w.backend.store.link({ ...changeOf(w, e), sourceId: PRODUCT_AI_BEDROCK_SOURCE_ID, companySourceId: "src_bedrock" }), BEDROCK_ANSWERS);
  if ("status" in v) return v;
  await audited(context, w, "product_ai.bedrock.linked");
  return ok(view(v, w));
}

async function removeBedrockSource(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, true);
  if ("status" in w) return w;
  const off = bedrockOff(w); if (off !== undefined) return off;
  const e = envelope(context, []);
  if ("status" in e) return e;
  const v = await guarded(w, () => w.backend.store.remove({ ...changeOf(w, e), sourceId: PRODUCT_AI_BEDROCK_SOURCE_ID }), BEDROCK_ANSWERS);
  if ("status" in v) return v;
  await audited(context, w, "product_ai.bedrock.removed");
  return ok(view(v, w));
}

/** The one CloudShell command that creates the role (the company's external id and Rovara's broker role come from the gateway). */
async function postBedrockSetup(context: RouteContext): Promise<RouteAnswer> {
  const w = await who(context, false);
  if ("status" in w) return w;
  const bedrock = w.backend.bedrock;
  if (bedrock === undefined) return BEDROCK_WORDS.off;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  const choice = body === undefined || !choiceKeys(body, ["region", "models", "allowGlobal"]) ? undefined : choiceOf(body);
  if (choice === undefined) return BEDROCK_WORDS.invalid;
  const setup = await bedrock.setup(w.companyId).catch(() => undefined);
  if (setup === undefined) return BEDROCK_WORDS.unavailable;
  let made;
  try { made = bedrock.command(setup, w.companyId, { ...choice, project: w.project }); } catch { return BEDROCK_WORDS.invalid; }
  return ok({ ...setup, companyId: w.companyId, ...made });
}

/** What a member change does after Code made it: withdraw again (an approval whose role check raced the change) and audit. */
export interface MemberWithdrawal { after(): Promise<void> }
const NOTHING_TO_WITHDRAW: MemberWithdrawal = { after: async () => undefined };

/**
 * PRODUCT-EVAL-APPROVER-REREAD: Cloud is about to change this person's membership or role (a project member change, an invite
 * accepted). Every eval approval they made stops counting first. A RouteAnswer when the change must not be made: the caller
 * may not make it (`project`: only that project's admin or a company admin may change its members, checked with Code BEFORE
 * anything is withdrawn), the person is not named by a member id, or the withdrawal could not be saved (503, fail closed: a
 * person whose membership changes never keeps an approval the gateway would honour). Otherwise `after()`, to run once Code
 * made the change: it withdraws again (closing the window between this withdrawal and Code's change) and records the audit.
 * Without product AI settings there is nothing to withdraw.
 */
export async function withdrawForMember(context: RouteContext, personId: string, scope: { project: string } | { companyId: string }): Promise<RouteAnswer | MemberWithdrawal> {
  const backend = context.productAi;
  if (backend === undefined) return NOTHING_TO_WITHDRAW;
  let companyId: string;
  if ("companyId" in scope) companyId = scope.companyId;
  else {
    const caller = await companyCaller(context);
    // No company: the member change is refused here rather than made without the withdrawal it needs.
    if (refused(caller)) return caller;
    companyId = caller.companyId;
    // Only someone who may change the project's members withdraws anyone's approvals (never a side effect of a refused change).
    const mine = caller.access.projects.find((each) => each.name === scope.project);
    if (!isCompanyAdmin(caller.companyRole) && mine?.access !== "administrator") return WORDS.memberForbidden;
  }
  // Approvals name people by their 64-hex member id: a change naming anyone another way can't be matched, so it is not made.
  if (typeof personId !== "string" || !/^[a-f0-9]{64}$/u.test(personId)) return WORDS.memberId;
  if (!COMPANY_ID.test(companyId)) return WORDS.unavailable;
  const withdraw = async () => { await backend.store.withdrawApprovals(backend.issuer, companyId, personId); };
  try { await withdraw(); }
  catch { console.log(JSON.stringify({ event: "cloud.eval_approvals_withdraw_failed", companyId })); return WORDS.unavailable; }
  return {
    after: async () => {
      try { await withdraw(); } catch { console.log(JSON.stringify({ event: "cloud.eval_approvals_withdraw_failed", companyId, after: true })); }
      if (context.audit === undefined) return;
      try {
        await recordCloudAction(context.audit, { companyId, actor: { developerId: context.session.access.developerId, name: context.session.access.displayName, type: "person" }, action: "product_ai.eval_approvals.withdrawn_for_member", via: "web", subject: `person:${personId}` }, context.now);
      } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action: "product_ai.eval_approvals.withdrawn_for_member", companyId })); }
    },
  };
}

const PROJECT_PATH = "\\/projects\\/([a-z][a-z0-9-]{0,62})\\/product-ai";
/** Added to the route table when the handler has a product AI backend. */
export const PRODUCT_AI_ROUTES: Route[] = [
  { method: "GET", path: new RegExp(`^${PROJECT_PATH}$`, "u"), answer: readProductAi },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/key$`, "u"), answer: putKey },
  { method: "DELETE", path: new RegExp(`^${PROJECT_PATH}\\/key$`, "u"), answer: removeKey },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/eval-budget$`, "u"), answer: putEvalBudget },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/eval-approval$`, "u"), answer: putEvalApproval },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/vertex$`, "u"), answer: putVertex },
  { method: "DELETE", path: new RegExp(`^${PROJECT_PATH}\\/vertex$`, "u"), answer: removeVertex },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/bedrock$`, "u"), answer: putBedrockOwn },
  { method: "PUT", path: new RegExp(`^${PROJECT_PATH}\\/bedrock\\/link$`, "u"), answer: linkBedrock },
  { method: "DELETE", path: new RegExp(`^${PROJECT_PATH}\\/bedrock$`, "u"), answer: removeBedrockSource },
  { method: "POST", path: new RegExp(`^${PROJECT_PATH}\\/bedrock\\/setup$`, "u"), answer: postBedrockSetup },
];
