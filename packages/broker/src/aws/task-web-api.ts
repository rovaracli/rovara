import { APP_CSRF_HEADER, appCsrfMatches } from "../developer/app-csrf.js";
// OWNER DECISION 7 and 17: with the decision cards on (`readOnly`), the review page takes no DECISION: a document's decision, the checks retry, Revise the plan and a held spec's choices are refused
// with 410 and a pointer to the task's page in Rovara, where the same functions are reached. Its comments, replies, suggestions, Ask, Remember and People keep working until the next release.
// With the cards off, the page decides exactly as before.
// Spec 061 slice 2: the task page's JSON API under `/review/<task ID>/task/api/*`. Every request needs the review
// session; every POST also needs this origin, the CSRF header matching its cookie, a JSON body of at most 16 KB and a
// strict schema. Whoever acts is the session's caller, never anything in the body. Not yours and no such task answer
// the same 404, so the API never confirms a task exists.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CommentDocumentSchema, CommentTargetSchema, DECISION_COMMENTS_MAX, PAGE_API_BODY_MAX_BYTES, PAGE_NOTE_MAX_CHARS, LearningTaskPageBodySchema, TaskPeopleRoleRequestSchema, TaskPeopleTakeOwnershipRequestSchema, type LearningForgetAnswerSchema, type LearningRememberAnswerSchema, type TaskPeopleChangeResult, type TaskPeopleRoleRequest, type TaskPeopleTakeOwnershipRequest, type TaskPeopleView } from "@rovara-code/contracts";
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import { REVISE_PLAN_REFUSALS } from "../agent-sessions/live-steer-revise.js";
import { PROJECT_RECORD_NEEDS_ADMIN } from "./broker-shared.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { PageCommentView } from "./plan-page/comments.js";
import type { PlanAnchor } from "./plan-page/render-plan.js";
import { CSRF_COOKIE, PRIVATE_HEADERS, SESSION_COOKIE, csrfCookie, isCsrfToken, parseCookie, safeResponse, type WebResponse } from "./web-session.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const TASK_PAGE_API = new RegExp(`^/review/(${UUID})/task/api/(state|comments|comments/(${UUID})/(edit|delete|remember|forget)|suggestions|decision|retry|revise-plan|spec/(?:retry|continue|keep|replan)|people|people/role|people/take-ownership|people/requests/(${UUID})(/confirm)?|e2e/artifacts/([0-9a-f]{64}))$`, "i");
/** Any path under the task page's API, known or not: it is the API's to answer, never the PR feedback page's. */
export const TASK_PAGE_API_PREFIX = new RegExp(`^/review/(${UUID})/task/api(/|$)`, "i");

/** Where the task stands, for the open page's poll: no names and no text. */
export interface TaskPageState {
  revision: number;
  /** Whether the current document waits for its owner's decision. */
  waiting: boolean;
  /** The current step's name, as the progress strip spells it. */
  stage: string;
  documents: Array<{ anchor: PlanAnchor; version: number }>;
  /** Moves whenever a comment, reply or suggestion is written. */
  commentSeq: number;
  peopleRevision?: number;
  canRead: boolean;
  canComment: boolean;
  canSuggest: boolean;
  canDecide: boolean;
  canAsk: boolean;
  canManagePeople: boolean;
  canTakeOwnership: boolean;
  /** v1.2 learning loop: set (true) only for a person with standing in the project, who may use Remember on this task. Absent for everyone else. */
  canRemember?: boolean;
  /** Read-only E2E projection loaded from the current server-owned CHECKS admission and evidence. */
  e2ePresentation?: DeveloperTaskView["e2ePresentation"];
}

const DecisionIdSchema = z.string().max(4);
const OptionIdSchema = z.string().max(31);

export const PageDecisionInputSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  answers: z.array(z.object({ decisionId: DecisionIdSchema, optionId: OptionIdSchema, opened: z.boolean() }).strict()).max(20),
  includedCommentIds: z.array(z.string().uuid()).max(DECISION_COMMENTS_MAX),
  selectedOptionalCheckIds: z.array(z.string().max(64)).max(20).optional(),
  /** Binds an approval to the exact ordered work breakdown the owner saw (the same value as the MCP tool's work_breakdown_digest); the broker checks it. */
  workBreakdownDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** QA6-12: the run limit the confirmation showed (a coding plan's approval sets it); the broker refuses the approval if it would set another. */
  acknowledgedRunLimitUsd: z.number().nonnegative().max(100_000).optional(),
  note: z.string().trim().min(1).max(PAGE_NOTE_MAX_CHARS).optional(),
}).strict().superRefine((input, context) => {
  if (new Set(input.answers.map((answer) => answer.decisionId)).size !== input.answers.length) context.addIssue({ code: "custom", path: ["answers"], message: "each decision once" });
  if (new Set(input.includedCommentIds).size !== input.includedCommentIds.length) context.addIssue({ code: "custom", path: ["includedCommentIds"], message: "each comment once" });
});
export type PageDecisionInput = z.infer<typeof PageDecisionInputSchema>;

/** The owner's retry of a blocked browser and API round, from the page: the same re-approval the Slack button makes. Nothing else rides along. */
export const PageRetryInputSchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export type PageRetryInput = z.infer<typeof PageRetryInputSchema>;

/** The text's length is checked by the comment store, so the page can say "Keep comments under 2,000 characters." */
const CommentTextSchema = z.string().max(PAGE_API_BODY_MAX_BYTES);

export const PageCommentInputSchema = z.object({
  requestId: z.string().uuid(),
  document: CommentDocumentSchema,
  version: z.number().int().positive(),
  target: CommentTargetSchema,
  parentId: z.string().uuid().optional(),
  text: CommentTextSchema,
  ask: z.boolean(),
}).strict();
export type PageCommentInput = z.infer<typeof PageCommentInputSchema>;
export const PageCommentEditSchema = z.object({ rev: z.number().int().positive(), text: CommentTextSchema }).strict();
export const PageCommentDeleteSchema = z.object({ rev: z.number().int().positive() }).strict();
export const PageSuggestionInputSchema = z.object({ document: CommentDocumentSchema, decisionId: DecisionIdSchema, optionId: OptionIdSchema.nullable() }).strict();
export type PageSuggestionInput = z.infer<typeof PageSuggestionInputSchema>;

export interface TaskWebApiDependencies {
  /** The canonical API origin (or issuer URL); only its origin is used. */
  origin: string;
  /** Where a refused action is logged (see `refusalLog`): one structured line of event, route, task ID, status and error code, never a body, token or name. */
  log?: (entry: Record<string, string>) => void;
  authenticateSession(sessionId: string): Promise<DeveloperCaller | undefined>;
  /** Must run the full access check on every call. */
  taskState(caller: DeveloperCaller, taskId: string): Promise<TaskPageState>;
  /** The comments, and the suggestions that still apply (names and "you" only), as the open page refreshes them. */
  listComments(caller: DeveloperCaller, taskId: string): Promise<{ comments: PageCommentView[]; suggestions?: unknown[]; canRemember?: boolean }>;
  createComment(caller: DeveloperCaller, taskId: string, input: PageCommentInput): Promise<{ comment: PageCommentView; duplicate?: boolean; askRefused?: string }>;
  editComment(caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number; text: string }): Promise<{ comment: PageCommentView }>;
  deleteComment(caller: DeveloperCaller, taskId: string, input: { commentId: string; rev: number }): Promise<{ comment: PageCommentView }>;
  setSuggestion(caller: DeveloperCaller, taskId: string, input: PageSuggestionInput): Promise<unknown>;
  /** v1.2 learning loop: "Remember this" on a comment. It must check the caller's own standing in the project, not only their role on the task. Without it the path is not found. */
  rememberComment?: (caller: DeveloperCaller, taskId: string, commentId: string) => Promise<z.infer<typeof LearningRememberAnswerSchema>>;
  /** v1.2 learning loop: "Forget" on a remembered comment. Without it the path is not found. */
  forgetComment?: (caller: DeveloperCaller, taskId: string, commentId: string) => Promise<z.infer<typeof LearningForgetAnswerSchema>>;
  /** Must refuse a caller who may not decide with an error carrying `pageReason: "owners_only"`. */
  decide(caller: DeveloperCaller, taskId: string, input: PageDecisionInput): Promise<{ revision: number }>;
  /** Retries a blocked application round (the owner only; any other block is refused) and answers the new revision. Without it, the retry path is not found. */
  retryApplicationRound?(caller: DeveloperCaller, taskId: string, input: PageRetryInput): Promise<{ revision: number }>;
  /** Live steer: the owner's Revise the plan press (coding stopped for a change outside the approved plan; only the owner, only then) and the new revision. Without it, the path is not found. */
  revisePlan?(caller: DeveloperCaller, taskId: string, input: PageRetryInput): Promise<{ revision: number }>;
  /** Wire lane D (MD-1): the owner's choice on a spec on hold (`retry`, `continue`, `keep` or `replan`). Without it, the paths answer not found. */
  specChoice?(caller: DeveloperCaller, taskId: string, choice: "retry" | "continue" | "keep" | "replan"): Promise<{ status: string }>;
  /**
   * The screenshot behind a row of the task's results (M1.3 Task 3.7), by its SHA-256: undefined for a digest the task's current display does not name. It must refuse a caller
   * who may not read the task (the page's own access rule) with an error carrying the code TASK_NOT_FOUND, TASK_ACCESS_DENIED, FORBIDDEN or NOT_FOUND. Without it the path is not found.
   */
  readE2EArtifact?(caller: DeveloperCaller, taskId: string, sha256: string): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined>;
  getPeople?(caller: DeveloperCaller, taskId: string): Promise<TaskPeopleView | undefined>;
  proposePeopleRole?(caller: DeveloperCaller, taskId: string, input: TaskPeopleRoleRequest): Promise<TaskPeopleChangeResult>;
  proposeOwnership?(caller: DeveloperCaller, taskId: string, input: TaskPeopleTakeOwnershipRequest): Promise<TaskPeopleChangeResult>;
  getPeopleRequest?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  confirmPeopleRequest?(caller: DeveloperCaller, taskId: string, requestId: string): Promise<TaskPeopleChangeResult>;
  /** OWNER DECISION 7: true while the decision cards are on: every write but a People request's confirmation is refused (410). */
  readOnly?: boolean;
  /** OWNER DECISION 7: the task's page in Rovara (`/app/sessions/<id>`) for a caller who may read the task, said with a refused write; undefined when it has none or the caller may not read it. */
  taskPagePath?(caller: DeveloperCaller, taskId: string): Promise<string | undefined>;
}

/** OWNER DECISION 7: what a write to the read-only page answers. */
export const TASK_PAGE_READ_ONLY_MESSAGE = "This page is read only. Decide on the task's page in Rovara.";

const NOT_FOUND = { error: "not_found", message: "You don't have access to this task." };
const HIDDEN = new Set(["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]);
/** Messages the page may show as they are: written for it, in plain words. */
const PAGE_SAFE_MESSAGES = new Set(["Include at least one comment or write a note.", REVISE_PLAN_REFUSALS.noChange, REVISE_PLAN_REFUSALS.notOffered]);
const TASK_CHANGED = "This task changed. Refresh the page and try again.";

const json = (statusCode: number, body: unknown): WebResponse => safeResponse(statusCode, body);
const invalid = (message?: string) => json(400, message === undefined ? { error: "invalid_request" } : { error: "invalid_request", message });

/** What a refused action answers: its status, a short code the script reads, and a sentence for the reader. */
function refusalResponse(error: unknown): WebResponse {
  const { code, pageReason, message } = (error ?? {}) as { code?: unknown; pageReason?: unknown; message?: unknown };
  // An AgentXError's message starts with its code ("IDEMPOTENCY_CONFLICT: …"); the reader sees only the sentence.
  const text = typeof message !== "string" ? TASK_CHANGED : typeof code === "string" && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  switch (pageReason) {
    case "owners_only": return json(403, { error: "owners_only", message: "Only owners decide." });
    case "empty": case "too_long": return invalid(text);
    case "slow_down": return json(429, { error: "slow_down", message: text });
    case "thread_full": case "task_full": return json(409, { error: "full", message: text });
    case "not_yours": case "owners_answer": case "not_allowed": return json(403, { error: "not_allowed", message: text });
    case "refused": return json(422, { error: "refused", message: text });
    case "not_here": case "closed": case "locked": case "changed": case "gone": case "comment_changed": return json(409, { error: "changed", message: text });
    default: break;
  }
  if (typeof code === "string" && HIDDEN.has(code)) return json(404, NOT_FOUND);
  // The decision's own refusals: who decided and when, or that a newer version is ready (written for the page).
  if (code === "IDEMPOTENCY_CONFLICT") return json(409, { error: "changed", message: text });
  if (code === "CONFIG_INVALID" && text === PROJECT_RECORD_NEEDS_ADMIN) return json(409, { error: "changed", message: text });
  if (code === "CONFIG_INVALID") return PAGE_SAFE_MESSAGES.has(text) ? invalid(text) : json(409, { error: "changed", message: TASK_CHANGED });
  if (code === "TASK_BUSY" || code === "WORKSPACE_BUSY") return json(409, { error: "busy", message: "AgentX is busy with this task. Try again in a minute." });
  // Decision journey slice 2: a high-risk plan needs a recent sign-in. The page says so with its words and offers "Sign in again", which comes back here; its access is not stopped (`reauth`).
  if (code === "REAUTH_REQUIRED") return json(403, { error: "reauth", message: text });
  return json(503, { error: "unavailable", message: "AgentX couldn't do that right now. Try again shortly." });
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const FIELD_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;

/**
 * The one line a refused page action leaves in the log, so the next one is visible: what was refused (route, task), how (status), and the error's code. Never the body, the
 * message (it can name people), a token or an email. For a body the schema refused, `fields` names the keys it objected to (only plain field names, never values).
 */
function refusalLog(deps: TaskWebApiDependencies, route: string, taskId: string, response: WebResponse, error: unknown, fields: readonly string[] = []): void {
  if (deps.log === undefined) return;
  const { code, pageReason } = (error ?? {}) as { code?: unknown; pageReason?: unknown };
  const shown = typeof code === "string" && CODE_SHAPE.test(code) ? code : typeof pageReason === "string" && CODE_SHAPE.test(pageReason.toUpperCase()) ? pageReason.toUpperCase() : "UNKNOWN";
  const plain = fields.filter((field) => FIELD_SHAPE.test(field)).slice(0, 8);
  try {
    deps.log({ event: "task_page.refused", route, taskId, status: String(response.statusCode), code: shown, ...(plain.length === 0 ? {} : { fields: plain.join(",") }) });
  } catch {
    // A logger that fails never changes the answer.
  }
}

const FORBIDDEN = { error: "forbidden", message: "You don't have access to this task." };

/**
 * A screenshot behind a row of the task's results. The session was checked by the caller of this; the reader's right to the task is checked again here, by the dependency, on
 * every request. Anyone who may not read the task is told 403 (for a task that does not exist as well, so the answer confirms nothing); a digest the task's current display does
 * not name is 404. The object streams with the type the display recorded, privately cached for five minutes, as an attachment-free image no page can run: a locked-down
 * policy, no sniffing, no framing.
 */
async function e2eArtifactResponse(deps: TaskWebApiDependencies, caller: DeveloperCaller, taskId: string, sha256: string): Promise<WebResponse> {
  if (deps.readE2EArtifact === undefined || !/^[a-f0-9]{64}$/u.test(sha256)) return json(404, { error: "not_found" });
  let found: Awaited<ReturnType<NonNullable<TaskWebApiDependencies["readE2EArtifact"]>>>;
  try {
    found = await deps.readE2EArtifact(caller, taskId, sha256);
  } catch (error) {
    const { code } = (error ?? {}) as { code?: unknown };
    return typeof code === "string" && HIDDEN.has(code) ? json(403, FORBIDDEN) : json(503, { error: "unavailable", message: "AgentX couldn't do that right now. Try again shortly." });
  }
  if (found === undefined) return json(404, { error: "not_found" });
  const { pragma: _pragma, ...headers } = PRIVATE_HEADERS;
  void _pragma;
  return { statusCode: 200, isBase64Encoded: true, body: Buffer.from(found.bytes).toString("base64"),
    headers: { ...headers, "content-type": found.contentType, "cache-control": "private, max-age=300", "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'" } };
}

/** The task page in Rovara (`/app/sessions/<id>`, the shape the forwards accept) for a reader who may read the task, or undefined: no session, no access, or the lookup failed. */
async function taskPageOf(deps: TaskWebApiDependencies, caller: DeveloperCaller, taskId: string): Promise<string | undefined> {
  try {
    const path = await deps.taskPagePath?.(caller, taskId);
    return path !== undefined && /^\/app\/sessions\/ses_[0-9a-z]{20}$/u.test(path) ? path : undefined;
  } catch { return undefined; }
}

/** Whether the body is JSON by its declared type: `application/json`, with or without parameters. */
const isJson = (contentType: string | undefined) => contentType !== undefined && /^application\/json\s*(;|$)/i.test(contentType.trim());

export function createTaskWebApi(deps: TaskWebApiDependencies): (request: AdaptedHttpRequest, url: URL) => Promise<WebResponse> {
  const origin = new URL(deps.origin).origin;
  return async (request, url) => {
    const route = TASK_PAGE_API.exec(url.pathname);
    const prefix = TASK_PAGE_API_PREFIX.exec(url.pathname);
    if (prefix === null) return json(404, { error: "not_found" });
    const sessionId = parseCookie(request.headers, SESSION_COOKIE);
    const caller = sessionId === undefined ? undefined : await deps.authenticateSession(sessionId);
    if (caller === undefined) return json(401, { error: "sign_in_required" });
    if (route === null) return json(404, { error: "not_found" });
    const taskId = route[1]!.toLowerCase();
    const commentId = route[3]?.toLowerCase();
    const peopleRequestId = route[5]?.toLowerCase();
    // `comments/<ID>/edit` and `comments/<ID>/delete` are the comments endpoint, for that comment.
    const artifactSha256 = route[7];
    const endpoint = artifactSha256 !== undefined ? "e2e/artifacts" : commentId === undefined ? route[2]!.toLowerCase() : "comments";
    const action = route[4]?.toLowerCase();
    const peopleConfirm = route[6] !== undefined;
    const method = request.method.toUpperCase();
    // `state` is read, `comments` is read (GET) and written (POST), everything else is written.
    const allowed = endpoint === "state" || endpoint === "people" || endpoint === "e2e/artifacts" || (peopleRequestId !== undefined && !peopleConfirm)
      ? ["GET"] : endpoint === "comments" && commentId === undefined ? ["GET", "POST"] : ["POST"];
    if (!allowed.includes(method)) {
      const refused = json(405, { error: "method_not_allowed" });
      refused.headers.allow = allowed.join(", ");
      return refused;
    }
    // OWNER DECISION 7: read-only (the cards are on): every write but a People request's confirmation (Slack's People flow) is refused, before any body is read, with where the task is decided now.
    // OWNER DECISION 17: read-only for DECISIONS only (a document's decision, the checks retry, Revise the plan, a held spec's choice); comments, replies, suggestions, Ask, Remember and People keep working.
    // OWNER DECISION 18 (review M1): one place means one place: with the cards on, EVERY write here is refused (comments, Ask, edits, deletes, suggestions, Remember, People proposals), each with
    // where it is done now; only a People request's confirmation (the page Slack's People flow links to) still writes.
    // Follow-up R1: only when there IS a task page to do it on (the task has a session, and this reader may read it: the forwards' own check). A task with no task page keeps this page's
    // writes, through the same functions and checks, so nobody is left without a browser path; someone who may not read the task is answered by those functions as before.
    const taskPage = deps.readOnly === true ? await taskPageOf(deps, caller, taskId) : undefined;
    if (taskPage !== undefined && method === "POST" && !(peopleRequestId !== undefined && peopleConfirm)) {
      const refused = json(410, { error: "read_only", message: TASK_PAGE_READ_ONLY_MESSAGE, taskPage });
      refusalLog(deps, endpoint, taskId, refused, { code: "READ_ONLY" });
      return refused;
    }
    try {
      if (method === "GET") {
        if (endpoint === "e2e/artifacts") return e2eArtifactResponse(deps, caller, taskId, artifactSha256!);
        if (endpoint === "people") {
          if (deps.getPeople === undefined) return json(404, { error: "not_found" });
          // A reader who holds the task only through a session level is given no People data, and no refusal either.
          const people = await deps.getPeople(caller, taskId);
          return people === undefined ? json(404, { error: "not_found" }) : json(200, people);
        }
        if (peopleRequestId !== undefined) {
          if (deps.getPeopleRequest === undefined) return json(404, { error: "not_found" });
          return json(200, await deps.getPeopleRequest(caller, taskId, peopleRequestId));
        }
        if (endpoint === "comments") {
          const listed = await deps.listComments(caller, taskId);
          // OWNER DECISION 18 (review M1): with the cards on Remember and Forget are the task page's, so the page is not told it may.
          return json(200, { comments: listed.comments, suggestions: listed.suggestions ?? [], ...(listed.canRemember === undefined || taskPage !== undefined ? {} : { canRemember: listed.canRemember }) });
        }
        const state = await deps.taskState(caller, taskId);
        const current = parseCookie(request.headers, CSRF_COOKIE);
        const csrf = isCsrfToken(current) ? current : randomBytes(32).toString("base64url");
        const response = json(200, {
          revision: state.revision, waiting: state.waiting, stage: state.stage, documents: state.documents, commentSeq: state.commentSeq,
          ...(state.peopleRevision === undefined ? {} : { peopleRevision: state.peopleRevision }),
          canRead: state.canRead, canComment: state.canComment, canSuggest: state.canSuggest, canDecide: state.canDecide,
          canAsk: state.canAsk, canManagePeople: state.canManagePeople, canTakeOwnership: state.canTakeOwnership, csrf,
          ...(state.canRemember === undefined || taskPage !== undefined ? {} : { canRemember: state.canRemember }),
          ...(state.e2ePresentation === undefined ? {} : { e2ePresentation: state.e2ePresentation }),
        });
        response.headers["set-cookie"] = csrfCookie(csrf);
        return response;
      }
      const csrf = parseCookie(request.headers, CSRF_COOKIE);
      if (request.headers.origin !== origin || !((isCsrfToken(csrf) && request.headers["x-agentx-csrf"] === csrf) || (sessionId !== undefined && appCsrfMatches(sessionId, request.headers[APP_CSRF_HEADER])))) return json(403, { error: "request_refused" });
      if (!isJson(request.headers["content-type"])) return invalid("Send this as JSON.");
      const body = request.body ?? "";
      if (Buffer.byteLength(body, "utf8") > PAGE_API_BODY_MAX_BYTES) return invalid("That is too long to send.");
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return invalid();
      }
      if (endpoint === "people/role") {
        if (deps.proposePeopleRole === undefined) return json(404, { error: "not_found" });
        const parsed = TaskPeopleRoleRequestSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const result = await deps.proposePeopleRole(caller, taskId, parsed.data);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (endpoint === "people/take-ownership") {
        if (deps.proposeOwnership === undefined) return json(404, { error: "not_found" });
        const parsed = TaskPeopleTakeOwnershipRequestSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const result = await deps.proposeOwnership(caller, taskId, parsed.data);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (peopleRequestId !== undefined && peopleConfirm) {
        if (deps.getPeopleRequest === undefined || deps.confirmPeopleRequest === undefined) return json(404, { error: "not_found" });
        const parsed = z.object({ requestId: z.string().uuid() }).strict().safeParse(value);
        if (!parsed.success || parsed.data.requestId.toLowerCase() !== peopleRequestId) return invalid();
        const receipt = await deps.getPeopleRequest(caller, taskId, peopleRequestId);
        if (receipt.status === "COMMITTED") return json(200, receipt);
        const result = await deps.confirmPeopleRequest(caller, taskId, peopleRequestId);
        return json(result.status === "PENDING" ? 202 : 200, result);
      }
      if (endpoint === "comments" && commentId !== undefined && (action === "remember" || action === "forget")) {
        const learn = action === "remember" ? deps.rememberComment : deps.forgetComment;
        if (learn === undefined) return json(404, { error: "not_found" });
        // The body is empty and strict: standing, author and stage are never the caller's to say.
        if (!LearningTaskPageBodySchema.safeParse(value).success) return invalid();
        return json(200, await learn(caller, taskId, commentId));
      }
      if (endpoint === "comments" && commentId !== undefined) {
        if (action === "edit") {
          const parsed = PageCommentEditSchema.safeParse(value);
          if (!parsed.success) return invalid();
          return json(200, await deps.editComment(caller, taskId, { commentId, ...parsed.data }));
        }
        const parsed = PageCommentDeleteSchema.safeParse(value);
        if (!parsed.success) return invalid();
        return json(200, await deps.deleteComment(caller, taskId, { commentId, ...parsed.data }));
      }
      if (endpoint === "comments") {
        const parsed = PageCommentInputSchema.safeParse(value);
        if (!parsed.success) return invalid();
        const created = await deps.createComment(caller, taskId, parsed.data);
        return json(created.duplicate === true ? 200 : 201, created);
      }
      if (endpoint === "suggestions") {
        const parsed = PageSuggestionInputSchema.safeParse(value);
        if (!parsed.success) return invalid();
        await deps.setSuggestion(caller, taskId, parsed.data);
        return json(200, { ok: true });
      }
      if (endpoint === "revise-plan") {
        if (deps.revisePlan === undefined) return json(404, { error: "not_found" });
        const parsedRevise = PageRetryInputSchema.safeParse(value);
        if (!parsedRevise.success) return invalid();
        return json(200, await deps.revisePlan(caller, taskId, parsedRevise.data));
      }
      if (endpoint.startsWith("spec/")) {
        if (deps.specChoice === undefined) return json(404, { error: "not_found" });
        if (!PageRetryInputSchema.safeParse(value).success) return invalid();
        return json(200, await deps.specChoice(caller, taskId, endpoint.slice("spec/".length) as "retry" | "continue" | "keep" | "replan"));
      }
      if (endpoint === "retry") {
        if (deps.retryApplicationRound === undefined) return json(404, { error: "not_found" });
        const parsedRetry = PageRetryInputSchema.safeParse(value);
        if (!parsedRetry.success) return invalid();
        return json(200, await deps.retryApplicationRound(caller, taskId, parsedRetry.data));
      }
      const parsed = PageDecisionInputSchema.safeParse(value);
      if (!parsed.success) {
        const refused = invalid("AgentX didn't accept that decision. Refresh the page and try again.");
        refusalLog(deps, "decision", taskId, refused, { code: "INVALID_REQUEST" }, parsed.error.issues.flatMap((issue) => [...issue.path.map(String), ...(issue.code === "unrecognized_keys" ? issue.keys : [])]));
        return refused;
      }
      return json(200, await deps.decide(caller, taskId, parsed.data));
    } catch (error) {
      const refused = refusalResponse(error);
      if (method === "POST") refusalLog(deps, endpoint, taskId, refused, error);
      return refused;
    }
  };
}
