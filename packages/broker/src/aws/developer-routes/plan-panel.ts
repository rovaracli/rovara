// OWNER DECISION 18 (PLAN-PANEL-NOW): the task page reads, discusses and decides the plan in one place. What the old review page (`/review/<task>/task`) and the PR feedback page (`/review/<task>`)
// did from a browser, as app routes that call the SAME server functions with the same checks (each re-reads the task and the caller's live access itself; nothing here decides who may):
//   GET  /v1/app/tasks/{id}/documents/{requirements|design|plan}   the current version of one document, as the old page read it (`getTaskDocumentView`: its access rule, digest checks and redaction);
//                                                                  `?version=N` reads an older saved version of it from the same read, read-only (nothing to comment on or decide)
//   POST /v1/app/tasks/{id}/comments                               a comment or reply, and Ask (`createPageComment`: rate limits, full threads, roles, the Ask limits)
//   POST /v1/app/tasks/{id}/comments/{commentId}/edit|delete       your own comment (`editPageComment`, `deletePageComment`: the author only, the same limits)
//   POST /v1/app/tasks/{id}/suggestions                            a teammate's suggestion on a question (`setPageSuggestion`: never the owner)
//   GET  /v1/app/tasks/{id}/workflow/feedback                      the PR feedback review (`getWorkflowFeedbackReview`, through the `/v1/dev` route the MCP tool reads)
//   POST /v1/app/tasks/{id}/workflow/feedback-decision             approve, request changes or dismiss it (`decideTaskWorkflowFeedback` -> `submitWorkflowFeedbackDecision`, as the feedback page and Slack)
//   POST /v1/app/tasks/{id}/workflow/feedback-retry                Retry review of a PR feedback review that did not finish (`retryTaskWorkflowFeedbackReview`: the Slack button's own function, owner only, replay-safe by review digest)
// OWNER DECISION 18(d): only while the decision cards are on (dk=1); with them off these paths are not found and the old pages are the only place, unchanged.
// Every route is for a live browser session only (the web adapter checks its cookie, Origin and CSRF header); a token is refused before anything is read. Bodies are the old page's strict schemas.
import { PAGE_API_BODY_MAX_BYTES, WorkflowFeedbackFindingsDecisionRequestSchema, WorkflowFeedbackReviewRetryRequestSchema, agentXError, redactText, type PlanClaim, type PlanDocument } from "@rovara-code/contracts";
import { decisionCardsEnabled } from "../../proof/switch.js";
import { FEEDBACK_REVIEW_RETRY_BUSY, FEEDBACK_REVIEW_RETRY_CHANGED, createPageComment, deletePageComment, editPageComment, getTaskDocumentView, getWorkflowFeedbackReview, retryTaskWorkflowFeedbackReview, setPageSuggestion, submitWorkflowFeedbackDecision } from "../developer-tasks.js";
import { PageCommentDeleteSchema, PageCommentEditSchema, PageCommentInputSchema, PageSuggestionInputSchema } from "../task-web-api.js";
import type { TaskDocumentEntry, TaskDocumentKind, TaskDocumentView } from "../task-web.js";
import { developerTaskRouteDependencies } from "./dependencies.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const PLAN_PANEL_ROUTE = new RegExp(`^/v1/app/tasks/(${UUID})/(documents/(?:requirements|design|plan)|comments|comments/(${UUID})/(?:edit|delete)|suggestions|workflow/feedback|workflow/feedback-decision|workflow/feedback-retry)$`, "u");
/** Said to a caller without a live browser session (a token): these are the task page's, as the old pages were. */
export const PLAN_PANEL_BROWSER_MESSAGE = "Use a live browser session to read and discuss the plan here.";
/** The documents the panel opens, by the name the app uses; each is the old page's kind. A fixed list: nothing else is a document. */
export const PLAN_PANEL_DOCUMENTS = { requirements: "requirements", design: "design", plan: "coding plan" } as const satisfies Record<string, TaskDocumentKind>;
export type PlanPanelDocument = keyof typeof PLAN_PANEL_DOCUMENTS;

/** One plain line of at most `max` characters, redacted (model and person text). */
const plain = (text: string, max: number): string => {
  const flat = redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join("")}…`;
};

export interface PanelClaim { id: string; text: string; children?: PanelClaim[] }
/** What the panel shows of one document: its current version, every model string redacted and bounded again here (the app shows each as plain text). */
export interface PlanPanelView {
  document: PlanPanelDocument;
  versions: Array<{ version: number; current: boolean; approved: boolean }>;
  /** The version shown: the current one, or (when `older` is set) the older one that was asked for. */
  current?: { version: number; approved: boolean } & (
    | { format: "structured"; title: string; why: Array<{ text: string; author: string }>; claims: PanelClaim[]; decisions: Array<{ id: string; claimId: string; question: string; recommended: string; options: Array<{ id: string; label: string; consequence: string }> }>;
      risks: string[]; notChanging: string[] }
    | { format: "markdown"; markdown: string });
  /** Set when `current` is an OLDER saved version (read-only: no access, no checks, nothing waiting); `currentVersion` is the version that is current now. */
  older?: { currentVersion: number };
  /** The coding plan's checks, by the ID a comment names. */
  checks: Array<{ id: string; label: string }>;
  /** The current version could not be verified: named, never shown. */
  unverified: boolean;
  /** This document waits for its owner's decision now. */
  waiting: boolean;
  /**
   * Approval place (U4): `decideAs` is the seat `canDecide` is from, "owner" or "maintainer" (a project maintainer, or a company owner or admin, deciding someone else's coding plan: the coding plan only); absent
   * when `canDecide` is false. `ownerName`: for a maintainer, the task owner's name as readers see it ("A former member" for an erased person, never an id), when there is one. Read-only: the decide route decides.
   */
  access: { canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean; decideAs?: "owner" | "maintainer"; ownerName?: string };
}

const claimsOf = (claims: readonly PlanClaim[]): PanelClaim[] => claims.map((claim) => ({ id: claim.id, text: plain(claim.text, 2000), ...(claim.children === undefined ? {} : { children: claimsOf(claim.children) }) }));

function currentOf(entry: TaskDocumentEntry | undefined): PlanPanelView["current"] {
  if (entry === undefined) return undefined;
  const base = { version: entry.version, approved: entry.approved };
  if (entry.format === "markdown") return { ...base, format: "markdown", markdown: redactText(entry.markdown) };
  const plan: PlanDocument = entry.plan;
  return {
    ...base, format: "structured", title: plain(plan.title, 300), why: plan.why.map((why) => ({ text: plain(why.text, 2000), author: plain(why.author, 80) })), claims: claimsOf(plan.claims),
    decisions: plan.decisions.map((decision) => ({ id: decision.id, claimId: decision.claimId, question: plain(decision.question, 500), recommended: decision.recommended,
      options: decision.options.map((option) => ({ id: option.id, label: plain(option.label, 300), consequence: plain(option.consequence, 500) })) })),
    risks: plan.risks.map((risk) => plain(risk, 500)), notChanging: plan.notChanging.map((line) => plain(line, 500)),
  };
}

/**
 * Who may decide, from the read: the owner's rule (`access.canDecide`) gives the "owner" seat; otherwise a maintainer's seat (`decideSeat`, worked out by `decideSeatOf` with the switch, the company, the live
 * project role and the People list) gives "maintainer", on the coding plan only, with the owner's name bounded as plain text. Anything else decides nothing.
 */
function decideAccess(view: TaskDocumentView, document: PlanPanelDocument): Pick<PlanPanelView["access"], "canDecide" | "decideAs" | "ownerName"> {
  if (view.access?.canDecide === true) return { canDecide: true, decideAs: "owner" };
  const seat = view.decideSeat;
  if (document !== "plan" || seat?.as !== "maintainer") return { canDecide: false };
  const ownerName = seat.ownerName === undefined ? "" : plain(seat.ownerName, 80);
  return { canDecide: true, decideAs: "maintainer", ...(ownerName === "" ? {} : { ownerName }) };
}

export const PLAN_PANEL_VERSION_MISSING = "That version isn't available.";
const NO_ACCESS = { canComment: false, canSuggest: false, canDecide: false, canAsk: false } as const;

/**
 * The panel's view of one document from the old page's own read (`getTaskDocumentView`), so the access rule, the digest checks and the redaction are that page's. `version` asks for an older saved
 * version of the same read: it is shown whole but read-only (the checks, the waiting flag and every right are the current version's, so none apply), and one the read does not hold is refused.
 */
export function planPanelView(view: TaskDocumentView, document: PlanPanelDocument, version?: number): PlanPanelView {
  const kind = PLAN_PANEL_DOCUMENTS[document];
  const entries = view.documents.filter((entry) => entry.kind === kind);
  const access = view.access, latest = entries.find((entry) => entry.current);
  const asked = version === undefined || version === latest?.version ? undefined : entries.find((entry) => entry.version === version);
  if (version !== undefined && version !== latest?.version && asked === undefined) throw agentXError("NOT_FOUND", PLAN_PANEL_VERSION_MISSING);
  const shown = currentOf(asked ?? latest);
  const versions = entries.map((entry) => ({ version: entry.version, current: entry.current, approved: entry.approved }));
  const unverified = (view.unverified ?? []).includes(kind);
  if (asked !== undefined) return { document, versions, ...(shown === undefined ? {} : { current: shown }), older: { currentVersion: latest!.version }, checks: [], unverified, waiting: false, access: NO_ACCESS };
  return {
    document, versions,
    ...(shown === undefined ? {} : { current: shown }),
    checks: document !== "plan" ? [] : view.checks.flatMap((check) => (check.id === undefined ? [] : [{ id: check.id, label: plain(check.label, 200) }])),
    unverified, waiting: view.waiting?.kind === kind,
    access: { canComment: access?.canComment === true, canSuggest: access?.canSuggest === true, canAsk: access?.canAsk === true && view.askAvailable === true, ...decideAccess(view, document) },
  };
}

/** The request's JSON body, refused when it is not JSON or longer than the old page took (16 KB). */
function body(request: AdaptedHttpRequest): unknown {
  const raw = request.body ?? "";
  if (Buffer.byteLength(raw, "utf8") > PAGE_API_BODY_MAX_BYTES) throw agentXError("CONFIG_INVALID", "That is too long to send.");
  if (raw === "") return {};
  try { return JSON.parse(raw) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** What the old feedback page said for a refusal: not yours, another company's or no such review read "Review not found."; anything else "This review changed." (never the core's own words). */
export const FEEDBACK_NOT_FOUND = "Review not found.";
export const FEEDBACK_CHANGED = "This review changed. Refresh it before deciding.";
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]);
async function feedbackRefusal<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && HIDDEN.has(code)) throw agentXError("NOT_FOUND", FEEDBACK_NOT_FOUND);
    if (code === "RUNTIME_UNAVAILABLE" || code === "TASK_BUSY" || code === "WORKSPACE_BUSY") throw error;
    throw agentXError("IDEMPOTENCY_CONFLICT", FEEDBACK_CHANGED);
  }
}

/**
 * Retry review's refusals: not yours or no such task reads "Review not found."; the busy and changed lines (fixed words) and the project rule's refusal (PROJECT_ACCESS_DENIED: the real reason, e.g. a viewer
 * cannot start tasks in the project; it is checked after the owner-only check, so only the task's owner ever reads it) pass; infrastructure faults pass. Anything else (a stale digest, and a task that is closed,
 * closing or never started, whose words name MCP tools) reads "This review changed."
 */
export async function retryRefusal<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && HIDDEN.has(code)) throw agentXError("NOT_FOUND", FEEDBACK_NOT_FOUND);
    if (code === "RUNTIME_UNAVAILABLE" || code === "TASK_BUSY" || code === "WORKSPACE_BUSY" || code === "PROJECT_ACCESS_DENIED") throw error;
    const message = (error as { message?: unknown } | undefined)?.message;
    // An AgentXError's message reads "CODE: words".
    if (code === "CONFIG_INVALID" && (message === `CONFIG_INVALID: ${FEEDBACK_REVIEW_RETRY_BUSY}` || message === `CONFIG_INVALID: ${FEEDBACK_REVIEW_RETRY_CHANGED}`)) throw error;
    throw agentXError("IDEMPOTENCY_CONFLICT", FEEDBACK_CHANGED);
  }
}

/** `?version=N` of a document read: a whole number from 1; anything else is refused. */
function versionOf(url: URL): number | undefined {
  const raw = url.searchParams.get("version");
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]{0,5}$/u.test(raw)) throw agentXError("CONFIG_INVALID", "AgentX didn't accept that version.");
  return Number(raw);
}

/** The routes; undefined for any other path or method. */
export async function routePlanPanel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const match = PLAN_PANEL_ROUTE.exec(url.pathname);
  if (match === null || !decisionCardsEnabled()) return undefined;
  const endpoint = match[3] === undefined ? match[2]! : url.pathname.endsWith("/edit") ? "comments/edit" : "comments/delete";
  const method = request.method.toUpperCase();
  const reads = endpoint.startsWith("documents/") || endpoint === "workflow/feedback";
  // GET /comments is the task page's comment list (task-page-actions.ts); here only its POST.
  if (reads ? method !== "GET" : method !== "POST") return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", PLAN_PANEL_BROWSER_MESSAGE);
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  const tasks = developerTaskRouteDependencies(deps, caller);
  const taskId = match[1]!.toLowerCase();
  if (endpoint.startsWith("documents/")) {
    const document = endpoint.slice("documents/".length) as PlanPanelDocument;
    // Only the coding plan's summary names a decide seat, so only its read works one out (the design and requirements panels make no approver read).
    return new StatusReply(200, planPanelView(await getTaskDocumentView(tasks, caller, taskId, { decideSeat: document === "plan" }), document, versionOf(url)));
  }
  if (endpoint === "workflow/feedback") return new StatusReply(200, { review: await feedbackRefusal(() => getWorkflowFeedbackReview(tasks, caller, taskId)) });
  if (endpoint === "workflow/feedback-decision") {
    // The old feedback page's decision, through its own function (`submitWorkflowFeedbackDecision`: owner only, the GitHub refresh, the revision and digest fences), with the MCP tool's strict schema.
    const parsed = WorkflowFeedbackFindingsDecisionRequestSchema.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "AgentX didn't accept that decision. Refresh the review and try again.");
    const decided = await feedbackRefusal(() => submitWorkflowFeedbackDecision(tasks, caller, taskId, parsed.data));
    return new StatusReply(200, { status: decided.status, nextAction: decided.nextAction });
  }
  if (endpoint === "workflow/feedback-retry") {
    // The Slack button's own function: the owner only, the send-back project rule, the workspace check, and a press for a review already retried changes nothing (`started: false`).
    const parsed = WorkflowFeedbackReviewRetryRequestSchema.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "AgentX didn't accept that. Refresh the review and try again.");
    const retried = await retryRefusal(() => retryTaskWorkflowFeedbackReview(tasks, caller, taskId, parsed.data));
    return new StatusReply(200, { started: retried.started });
  }
  const value = body(request);
  const invalid = () => agentXError("CONFIG_INVALID", "AgentX didn't accept that. Refresh the page and try again.");
  if (endpoint === "comments") {
    const parsed = PageCommentInputSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const created = await createPageComment(tasks, caller, taskId, parsed.data);
    return new StatusReply(created.duplicate ? 200 : 201, created);
  }
  if (endpoint === "suggestions") {
    const parsed = PageSuggestionInputSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    await setPageSuggestion(tasks, caller, taskId, parsed.data);
    return new StatusReply(200, { ok: true });
  }
  const commentId = match[3]!.toLowerCase();
  if (endpoint === "comments/edit") {
    const parsed = PageCommentEditSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    return new StatusReply(200, await editPageComment(tasks, caller, taskId, { commentId, ...parsed.data }));
  }
  const parsed = PageCommentDeleteSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return new StatusReply(200, await deletePageComment(tasks, caller, taskId, { commentId, ...parsed.data }));
}
