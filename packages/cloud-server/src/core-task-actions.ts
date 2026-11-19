// Audit 2026-11-18 item 6: an owner's actions on a task the core engine owns. Rovara Code's old workflow routes (`/v1/dev/tasks/{id}/workflow/review`, `/close`,
// `/workflow/decision`) answer a core task with 404 "That is not on the core engine on this install yet." (Code engine-boundary.ts `serveCoreTask`), and only to a person the
// core lets read the task (anyone else gets the missing task's answer). Cloud keeps asking the old route first: that 404 is Code's own word that the task is the core's, and it
// changes nothing. Then it uses the route Code's core already serves for the same act, as the same person with the same token and scopes:
//   - Retry reviews and Close: the core's session routes, `POST /v1/app/sessions/{codeSession}/retry` and `.../close` (Code local/app/session-routes.ts over the session control,
//     which checks the person's session level: `edit` for both, and close is the owner's). Since Code #1045 every hosted core start by a person writes the task's session in the
//     start's own transaction, and Code's task read names it (`sessionId`). A task whose read names no session was started before that (Code has no backfill): Cloud says in fixed
//     words that the action is not available for this task, asks Code nothing, and nothing is done. Where a session is named, Code's "There is no such session." means the person
//     holds no level on it (core/sessions/access.ts hides a session's existence), so Cloud refuses in fixed words that say so instead.
//   - Plan approval: the core's decision cards (`/v1/app/decisions`). A coding plan waiting on a core task is an `approve_plan` card, decided on the card with Code's own
//     digest and risk rules (the session page and Home's "Needs you" show it). So where Code has that card, Cloud no longer links to its own approval page (approve.ts).
//   - Accepting review findings: the core serves `workflow/review-findings` itself, but accepting a SECURITY finding there is refused (core/task-flow/security-accept.ts, DEC 236h:
//     an API token's route). Code #1045 serves the web page's own route, `POST /v1/app/tasks/{taskId}/review-findings` (same body, `{ task }` out): only the web app's own sign-in
//     client (`webApp`, which Code's sign-in sets from Cloud's client registration), only for the task's owner or a People co-owner (DEC 254zzz39 (6), 254zzz44 (3); owner
//     DEC 254zzz73 removed the step-up these once needed). Cloud asks it only after the workflow route said "the web page only" (FORBIDDEN). Code's refusals become fixed words.
// Nothing here takes an id from the request: the task id is Cloud's own session record's, and Code decides who may act; its other refusals reach the app unchanged.
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import type { CodeTask } from "./session-view.js";
import type { RouteAnswer } from "./routes.js";

/** Code's words for an operation of a core task its core does not serve yet (core-host/dev-routes.ts NOT_ON_THE_CORE_YET). */
export const CORE_NOT_YET = "That is not on the core engine on this install yet.";
/** Code's words for a session it has not got, or one the person holds no level on (core/sessions/access.ts SESSION_NOT_FOUND_TEXT). */
export const CODE_NO_SESSION = "There is no such session.";
/**
 * The start of Code's words when a security finding is accepted anywhere but its own web page (security-accept.ts SECURITY_ACCEPT_ON_THE_PAGE, both engines). Matched as a
 * prefix: owner DEC 254zzz73 removed the step-up, so Code's sentence may lose its old ending ("with a fresh sign-in"); the code (FORBIDDEN) and this start still decide.
 */
export const CODE_SECURITY_ACCEPT_ON_THE_PAGE = "Accepting a security finding needs the Rovara web page";

export const CORE_ACTION_WORDS = Object.freeze({
  retry: "Retry reviews isn't available for this task in Rovara Cloud yet. Nothing was changed.",
  close: "Closing this task isn't available in Rovara Cloud yet. Nothing was changed.",
  /** A task started before Code kept a session for every task (Code #1045 has no backfill). */
  retryNoSession: "This task was started before Rovara Cloud could retry its reviews, so it can't be retried from here. Nothing was changed.",
  closeNoSession: "This task was started before Rovara Cloud could close it, so it can't be closed from here. Nothing was changed.",
  /** Code holds the task's session, but this person holds no level on it (Code hides the session's existence). */
  retryRefused: "Rovara Code doesn't let you retry this task's reviews. Nothing was changed.",
  closeRefused: "Rovara Code doesn't let you close this task. Nothing was changed.",
  /** The page route refused: not the task's owner or a co-owner (Code reads it as no such task). */
  acceptNotYours: "Only the task's owner or a co-owner can accept these findings. Nothing was accepted.",
  unreadable: "Rovara Code sent an answer Cloud couldn't read.",
  securityNotHere: "Rovara accepts a security finding only on its own task page, and that isn't available for this task in Rovara Cloud yet. Nothing was accepted. Send the work back to coding to fix it.",
  planOnCard: "This plan is decided on its card on the session page.",
  planNotHere: "Rovara Code runs this task on its new engine, which takes a plan decision only on the plan's decision card, and that card isn't showing for you yet. Nothing was decided. Open the session and try again in a moment.",
  closeFirstAsk: "Rovara can't check this task for unpublished work yet, so closing it now may delete work that was never published.",
});

const CODE_SESSION = /^ses_[0-9a-z]{20}$/u;
/** Code's session control takes a lower-case UUID only (core/sessions/control.ts REQUEST_ID). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Code's decision list is capped (DECISION_CARDS_MAX); Cloud looks at no more than this. */
const CARDS_LOOKED_AT = 500;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
/** The fixed answer for a task Code keeps no session for (started before Code #1045). */
export const noSession = (action: "retry" | "close"): RouteAnswer => fail(501, "NOT_ON_CODE_YET", action === "retry" ? CORE_ACTION_WORDS.retryNoSession : CORE_ACTION_WORDS.closeNoSession);

/** Code's refusal: its status, code and message, or undefined for anything that is not a CodeError. */
function refusalOf(error: unknown): { status: number; code: unknown; message: unknown } | undefined {
  if (!(error instanceof CodeError)) return undefined;
  const said = isObj(error.body) && isObj(error.body["error"]) ? error.body["error"] : {};
  return { status: error.status, code: said["code"], message: said["message"] };
}

/** Whether Code answered that the task is the core's and this old route is not on the core (the person may read the task). */
export function isCoreNotYet(error: unknown): boolean {
  const refusal = refusalOf(error);
  return refusal !== undefined && refusal.status === 404 && refusal.code === "NOT_FOUND" && refusal.message === CORE_NOT_YET;
}

/**
 * The Code session of a task: the one Code's task read names (every hosted core start writes one since Code #1045), or undefined for a task started before that. Never a guess:
 * a session Code does not name is not asked about.
 */
export function codeSessionOf(task: { taskId: string; [field: string]: unknown }): string | undefined {
  const named = task["sessionId"];
  return typeof named === "string" && CODE_SESSION.test(named) ? named : undefined;
}

/**
 * The core's own retry or close of the task, through its session, as the person. The answer's task (Code's session view carries it as its body) must be the task asked about.
 * `{ task }` when done; otherwise the answer to give: fixed words for a session Code has not got, fixed words for an answer that does not read. Code's other refusals (the
 * session level, nothing to retry, a closed session) throw as CodeError and reach the app unchanged.
 */
export async function actOnCoreSession(client: CodeClient, session: CodeSession, task: CodeTask, action: "retry" | "close", requestId: string): Promise<{ task: CodeTask } | { answer: RouteAnswer }> {
  const lowered = requestId.toLowerCase();
  if (!REQUEST_ID.test(lowered)) return { answer: fail(400, "CONFIG_INVALID", "requestId must be a UUID.") };
  // A task started before Code wrote a session for every start: nothing to act through, and Code is not asked.
  const codeSession = codeSessionOf(task);
  if (codeSession === undefined) return { answer: noSession(action) };
  let raw: unknown;
  try {
    // Close takes the request id and nothing else on the core: it has no unpublished-work check to agree to.
    raw = await client.json<unknown>(session, `/v1/app/sessions/${codeSession}/${action}`, { method: "POST", body: { requestId: lowered } });
  } catch (error) {
    const refusal = refusalOf(error);
    // A Code whose core does not serve sessions on this install: fixed words, never Code's own.
    if (isCoreNotYet(error)) return { answer: fail(501, "NOT_ON_CODE_YET", CORE_ACTION_WORDS[action]) };
    // The session Code named is there, so "no such session" is Code hiding it from a person with no level on it: a refusal in fixed words.
    if (refusal !== undefined && refusal.status === 404 && refusal.message === CODE_NO_SESSION) return { answer: fail(403, "FORBIDDEN", action === "retry" ? CORE_ACTION_WORDS.retryRefused : CORE_ACTION_WORDS.closeRefused) };
    throw error;
  }
  const view = isObj(raw) && isObj(raw["session"]) ? raw["session"] : undefined;
  const body = view !== undefined && isObj(view["body"]) && view["body"]["kind"] === "task" && isObj(view["body"]["task"]) ? view["body"]["task"] : undefined;
  if (body === undefined || typeof body["taskId"] !== "string" || body["taskId"].toLowerCase() !== task.taskId.toLowerCase() || typeof body["title"] !== "string" || typeof body["project"] !== "string") {
    return { answer: fail(502, "RUNTIME_UNAVAILABLE", CORE_ACTION_WORDS.unreadable) };
  }
  if (action === "close" && raw !== undefined && isObj(raw) && raw["closed"] !== true) return { answer: fail(502, "RUNTIME_UNAVAILABLE", CORE_ACTION_WORDS.unreadable) };
  return { task: body as unknown as CodeTask };
}

/**
 * The tasks for which Code holds a pending coding-plan card this person may decide (its decision list names only what the caller may decide now). Such a plan is decided on that
 * card, not on Cloud's approval page. A Code with no cards (404, 501), or a list that does not read, holds none: Cloud's page stays as it was.
 */
export async function pendingPlanCards(client: CodeClient, session: CodeSession): Promise<ReadonlySet<string>> {
  let view: unknown;
  try {
    view = await client.json<unknown>(session, "/v1/app/decisions");
  } catch (error) {
    if (error instanceof SignInEnded) throw error;
    return new Set();
  }
  const cards = isObj(view) && Array.isArray(view["cards"]) ? (view["cards"] as unknown[]).slice(0, CARDS_LOOKED_AT) : [];
  return new Set(cards.flatMap((card) => (isObj(card) && card["kind"] === "approve_plan" && card["status"] === "pending" && typeof card["taskId"] === "string" ? [card["taskId"].toLowerCase()] : [])));
}

/** Whether this task's waiting plan is decided on a Code decision card (see `pendingPlanCards`). */
export async function planDecidedOnCard(client: CodeClient, session: CodeSession, taskId: string): Promise<boolean> {
  return (await pendingPlanCards(client, session)).has(taskId.toLowerCase());
}

/** Code's refusal of an accept that includes a security finding: `page` (the core takes it only on the web page's own route: FORBIDDEN), or undefined for any other error. */
export function securityAcceptRefusal(error: unknown): "page" | undefined {
  const refusal = refusalOf(error);
  if (refusal === undefined || refusal.status !== 403 || typeof refusal.message !== "string" || !refusal.message.startsWith(CODE_SECURITY_ACCEPT_ON_THE_PAGE)) return undefined;
  return refusal.code === "FORBIDDEN" ? "page" : undefined;
}

/** The findings accept the web page sends, exactly as the workflow route takes it (Cloud builds it from Code's task, never from the browser). */
export interface FindingsAccept { requestId: string; expectedRevision: number; candidateDigest: string; resolutions: Array<{ findingId: string; action: "ACCEPT"; note: string }> }

/**
 * The web page's own accept of review findings that include a SECURITY finding on a core task (Code #1045, `POST /v1/app/tasks/{taskId}/review-findings`), as the person with
 * Cloud's token. Code's refusals become fixed words: Cloud's client not being the web app's (FORBIDDEN) or a Code that does not serve the route says the page can't do it here; a person who is not the
 * task's owner or a co-owner (Code's no-such-task) is told so. The answer's task must be the one asked about.
 */
export async function acceptOnPage(client: CodeClient, session: CodeSession, taskId: string, body: FindingsAccept): Promise<{ task: CodeTask } | { answer: RouteAnswer }> {
  let raw: unknown;
  try {
    raw = await client.json<unknown>(session, `/v1/app/tasks/${encodeURIComponent(taskId)}/review-findings`, { method: "POST", body });
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === undefined) throw error;
    if ((refusal.status === 403 && refusal.code === "FORBIDDEN") || (refusal.status === 404 && refusal.code === "NOT_FOUND")) return { answer: fail(409, "SECURITY_ACCEPT_NOT_HERE", CORE_ACTION_WORDS.securityNotHere) };
    if (refusal.status === 404 && refusal.code === "TASK_NOT_FOUND") return { answer: fail(403, "FORBIDDEN", CORE_ACTION_WORDS.acceptNotYours) };
    throw error;
  }
  const task = isObj(raw) && isObj(raw["task"]) ? raw["task"] : undefined;
  if (task === undefined || typeof task["taskId"] !== "string" || task["taskId"].toLowerCase() !== taskId.toLowerCase() || typeof task["title"] !== "string" || typeof task["project"] !== "string") {
    return { answer: fail(502, "RUNTIME_UNAVAILABLE", CORE_ACTION_WORDS.unreadable) };
  }
  return { task: task as unknown as CodeTask };
}
