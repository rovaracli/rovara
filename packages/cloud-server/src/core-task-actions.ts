// Audit 2026-11-18 item 6: an owner's actions on a task the core engine owns. Rovara Code's old workflow routes (`/v1/dev/tasks/{id}/workflow/review`, `/close`,
// `/workflow/decision`) answer a core task with 404 "That is not on the core engine on this install yet." (Code engine-boundary.ts `serveCoreTask`), and only to a person the
// core lets read the task (anyone else gets the missing task's answer). Cloud keeps asking the old route first: that 404 is Code's own word that the task is the core's, and it
// changes nothing. Then it uses the route Code's core already serves for the same act, as the same person with the same token and scopes:
//   - Retry reviews and Close: the core's session routes, `POST /v1/app/sessions/{codeSession}/retry` and `.../close` (Code local/app/session-routes.ts over the session control,
//     which checks the person's session level: `edit` for both, and close is the owner's). The Code session id is the one Code's task read names, else the one Code gives a task
//     (`taskSessionId`, inbox-routes.ts `codeSessionIdOf`). A task Code holds no session for answers "There is no such session." (a hosted start without a ticket writes none
//     today); Cloud says in fixed words that the action is not available for this task yet, and nothing was done.
//   - Plan approval: the core's decision cards (`/v1/app/decisions`). A coding plan waiting on a core task is an `approve_plan` card, decided on the card with Code's own step-up,
//     digest and risk rules (the session page and Home's "Needs you" show it). So where Code has that card, Cloud no longer links to its own approval page (approve.ts).
//   - Accepting review findings: the core serves `workflow/review-findings` itself, but accepting a SECURITY finding is Code's web page's alone with a fresh step-up
//     (core/task-flow/security-accept.ts, DEC 236h), and no hosted route of the core is that page. Code's refusal becomes fixed words that say so and what to do instead.
// Nothing here takes an id from the request: the task id is Cloud's own session record's, and Code decides who may act; its other refusals reach the app unchanged.
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import type { CodeTask } from "./session-view.js";
import { codeSessionIdOf } from "./inbox-routes.js";
import type { RouteAnswer } from "./routes.js";

/** Code's words for an operation of a core task its core does not serve yet (core-host/dev-routes.ts NOT_ON_THE_CORE_YET). */
export const CORE_NOT_YET = "That is not on the core engine on this install yet.";
/** Code's words for a session it has not got, or one the person holds no level on (core/sessions/access.ts SESSION_NOT_FOUND_TEXT). */
export const CODE_NO_SESSION = "There is no such session.";
/** Code's words when a security finding is accepted anywhere but its own web page with a fresh step-up (security-accept.ts SECURITY_ACCEPT_ON_THE_PAGE, both engines). */
export const CODE_SECURITY_ACCEPT_ON_THE_PAGE = "Accepting a security finding needs the Rovara web page with a fresh sign-in";

export const CORE_ACTION_WORDS = Object.freeze({
  retry: "Retry reviews isn't available for this task in Rovara Cloud yet. Nothing was changed.",
  close: "Closing this task isn't available in Rovara Cloud yet. Nothing was changed.",
  unreadable: "Rovara Code sent an answer Cloud couldn't read.",
  securityNotHere: "Rovara accepts a security finding only on its own task page, right after you confirm it's you, and that isn't available for this task in Rovara Cloud yet. Nothing was accepted. Send the work back to coding to fix it.",
  stepUp: "Accepting a security finding needs you to confirm it's you again. Confirm it, then try once more.",
  planOnCard: "This plan is decided on its card on the session page.",
});

const CODE_SESSION = /^ses_[0-9a-z]{20}$/u;
/** Code's session control takes a lower-case UUID only (core/sessions/control.ts REQUEST_ID). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Code's decision list is capped (DECISION_CARDS_MAX); Cloud looks at no more than this. */
const CARDS_LOOKED_AT = 500;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });

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

/** The Code session of a task: the one Code's task read names, else the one Code gives every task (its id's hash). */
export function codeSessionOf(task: { taskId: string; [field: string]: unknown }): string {
  const named = task["sessionId"];
  return typeof named === "string" && CODE_SESSION.test(named) ? named : codeSessionIdOf(task.taskId.toLowerCase());
}

/**
 * The core's own retry or close of the task, through its session, as the person. The answer's task (Code's session view carries it as its body) must be the task asked about.
 * `{ task }` when done; otherwise the answer to give: fixed words for a session Code has not got, fixed words for an answer that does not read. Code's other refusals (the
 * session level, nothing to retry, a closed session) throw as CodeError and reach the app unchanged.
 */
export async function actOnCoreSession(client: CodeClient, session: CodeSession, task: CodeTask, action: "retry" | "close", requestId: string): Promise<{ task: CodeTask } | { answer: RouteAnswer }> {
  const lowered = requestId.toLowerCase();
  if (!REQUEST_ID.test(lowered)) return { answer: fail(400, "CONFIG_INVALID", "requestId must be a UUID.") };
  let raw: unknown;
  try {
    // Close takes the request id and nothing else on the core: it has no unpublished-work check to agree to.
    raw = await client.json<unknown>(session, `/v1/app/sessions/${codeSessionOf(task)}/${action}`, { method: "POST", body: { requestId: lowered } });
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== undefined && refusal.status === 404 && refusal.message === CODE_NO_SESSION) return { answer: fail(501, "NOT_ON_CODE_YET", CORE_ACTION_WORDS[action]) };
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

/** Code's refusal of an accept that includes a security finding, in Cloud's fixed words; undefined for any other error. */
export function securityAcceptRefusal(error: unknown): RouteAnswer | undefined {
  const refusal = refusalOf(error);
  if (refusal === undefined || refusal.status !== 403 || refusal.message !== CODE_SECURITY_ACCEPT_ON_THE_PAGE) return undefined;
  // The old engine takes it from Cloud's own page with a fresh step-up (REAUTH_REQUIRED when it is stale); the core never takes it from a hosted route (FORBIDDEN).
  if (refusal.code === "REAUTH_REQUIRED") return fail(403, "REAUTH_REQUIRED", CORE_ACTION_WORDS.stepUp);
  if (refusal.code === "FORBIDDEN") return fail(409, "SECURITY_ACCEPT_NOT_HERE", CORE_ACTION_WORDS.securityNotHere);
  return undefined;
}
