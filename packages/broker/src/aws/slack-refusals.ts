import { isApprovalPlaceWords } from "../approval-place/words.js";
import { FEEDBACK_REVIEW_RETRY_BUSY, FEEDBACK_REVIEW_RETRY_CHANGED } from "./developer-tasks/feedback-capture.js";
import { FEEDBACK_CHANGED_SINCE_CARD } from "./developer-tasks/feedback-review.js";
import { PROJECT_RECORD_NEEDS_ADMIN } from "./broker-shared.js";
import { STOP_WHILE_PUBLISHING_REFUSAL, STOP_WHILE_PUBLISHING_TEXT, WORKFLOW_ACTIONABLE_REFUSALS } from "../developer/workflow-actions.js";
import { SLACK_ACCOUNT_NOT_LINKED_NOTICE } from "./slack-workflow-choice.js";

/**
 * Refusals that are not about a press being out of date, by their exact text (never a prefix), in the words the presser
 * hears: the press was current, and the presser can fix what it asked for.
 */
const SLACK_PLAIN_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["select at least one check before retrying verification", "Select at least one check, then try again."],
  ["choose checks that are approved for this project", "Choose from this project's checks, then try again."],
  [FEEDBACK_REVIEW_RETRY_BUSY, FEEDBACK_REVIEW_RETRY_BUSY],
  [FEEDBACK_REVIEW_RETRY_CHANGED, FEEDBACK_REVIEW_RETRY_CHANGED],
  [FEEDBACK_CHANGED_SINCE_CARD, FEEDBACK_CHANGED_SINCE_CARD],
  [PROJECT_RECORD_NEEDS_ADMIN, PROJECT_RECORD_NEEDS_ADMIN],
  [STOP_WHILE_PUBLISHING_REFUSAL, STOP_WHILE_PUBLISHING_TEXT],
]);
/** The refusals of an approval or a retry that name what to do next (Ruling AU), said as sentences, never as "out of date". */
const SLACK_ACTIONABLE_REASONS: ReadonlySet<string> = new Set(Object.values(WORKFLOW_ACTIONABLE_REFUSALS));
/**
 * Task 19: the broker refusals a Slack press can meet in the normal course of things, by what the presser hears. A
 * task is not found for a Slack caller when it was started from an AI tool (its owner is that tool's sign-in) or is
 * gone, so the words fit both.
 */
/** The decision's lost-race sentences (FR-035), which Slack says as they are. */
const LOST_RACE = /^(Already approved by|Changes were already requested by) [^\n]{1,200}\.$/u;
/** The lost-race sentence for Slack: Slack's markup characters escaped, and the winner named with a mention when their Slack ID is known. */
function slackLostRace(reason: string, decidedBy: unknown): string {
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const escaped = escape(reason);
  const { name, slackUserId } = (decidedBy ?? {}) as { name?: unknown; slackUserId?: unknown };
  if (typeof name !== "string" || typeof slackUserId !== "string" || !/^[UW][A-Z0-9]{2,}$/u.test(slackUserId)) return escaped;
  const plain = ` by ${escape(name)} `;
  const at = escaped.indexOf(plain);
  return at < 0 ? escaped : `${escaped.slice(0, at)} by <@${slackUserId}> ${escaped.slice(at + plain.length)}`;
}

/**
 * The reasons the plan-approval check gives when a plan cannot be approved (or approved again) against the approved setup and the
 * runtimes that are ready now, by their opening words (validateWorkflowE2EApplicationPlan, decideTaskWorkflow and retryTaskWorkflow).
 * They name what to do next, so the presser hears them as a sentence; the rest of a reason is data and is never said. The exact reasons in
 * WORKFLOW_ACTIONABLE_REFUSALS (the plan-correction and retry-selection refusals) are said the same way.
 */
const SLACK_PLAN_APPROVAL_REASONS = /^(the application E2E plan cannot be approved: |the application E2E plan could not be checked for approval \(|the plan cannot be approved again here: |the approved plan no longer carries the application intent )/u;
/**
 * The two refusals M1.3 introduces (Ruling AU): the test accounts, or an outside service's mock, are not the ones the plan was approved with. Only their opening words are
 * said, as a sentence; what follows names accounts, applications and dates, which is data and never reaches Slack.
 */
const SLACK_REAPPROVE_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  ["accounts-changed-reapprove: ", "The test accounts changed since this plan was approved. Retry the checks to approve the plan again with the accounts that are registered now."],
  ["mock-fixture-changed-reapprove: ", "The mock for an outside service changed since this plan was approved. Retry the checks to approve the plan again with the mock that is approved now."],
];
function slackPlanApprovalRefusal(reason: string): string | undefined {
  // The token opens the reason, or comes right after the opening words of a plan-approval refusal that wraps it ("the application E2E plan cannot be approved: <token>: ...").
  const wrapped = SLACK_PLAN_APPROVAL_REASONS.exec(reason);
  const rest = wrapped === null ? reason : reason.slice(wrapped[0].length);
  const reapprove = SLACK_REAPPROVE_SENTENCES.find(([opening]) => rest.startsWith(opening));
  if (reapprove !== undefined) return reapprove[1];
  if (wrapped === null && !SLACK_ACTIONABLE_REASONS.has(reason)) return undefined;
  const escaped = reason.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").slice(0, 400);
  const sentence = `${escaped.charAt(0).toUpperCase()}${escaped.slice(1)}`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

const USD = "\\$[0-9]+(?:\\.[0-9]+)?";
const RUN_LIMIT_ACK_MISSING = new RegExp(`^(This raises the run limit from ${USD} to ${USD})\\.(?:.*?, or approve it in Rovara: (https?://[^\\s<>|]{1,500}))?`, "su");
const RUN_LIMIT_CHANGED = new RegExp(`^This plan's run limit is now (${USD}), not the (${USD}) you were shown\\.(?: (This raises the run limit from ${USD} to ${USD})\\.)?(?:.*?, or approve it in Rovara: (https?://[^\\s<>|]{1,500}))?`, "su");
/**
 * QA6-12b: an approval of a plan that raises the run limit was refused because it came without the amount (an older button) or with an amount that is not the one approving would set now (a stale button, the
 * plan or the limits changed since the message was posted). The decision's own words are numbers and fixed sentences (built from `runLimitRaiseText`), so they are said, in Slack's terms: the new amount is shown.
 * Only text of exactly those shapes is said; anything else is not (the presser hears "out of date").
 */
export function slackRunLimitRefusal(reason: string): string | undefined {
  const missing = RUN_LIMIT_ACK_MISSING.exec(reason);
  // The way forward is always there: the checked link to the plan in Rovara when the broker gave one (a message with no amount on its button has no other).
  if (missing !== null) return `${missing[1]!}. This button does not carry the new limit. Use the latest message in this thread if it shows this raise, or approve the plan in Rovara${missing[2] === undefined ? "." : `: ${missing[2].replace(/&/gu, "&amp;")}`}`;
  const changed = RUN_LIMIT_CHANGED.exec(reason);
  if (changed !== null) return `The run limit changed since this message was posted: it is now ${changed[1]!}, not the ${changed[2]!} this button showed.${changed[3] === undefined ? "" : ` ${changed[3]}.`} Use the latest message in this thread to approve it${changed[4] === undefined ? "." : `, or approve the plan in Rovara: ${changed[4].replace(/&/gu, "&amp;")}`}`;
  return undefined;
}

const RISK_PLACE = /^This plan is (?:medium|high) risk, so it is approved (?:on its card in Rovara|on the plan review page)(?:, after a sign-in with the email code)?(?:\.|: https?:\/\/[^\s<>|]{1,500})$/u;
/**
 * A medium or high risk coding plan is approved in the app, not from Slack (`planRiskPlaceMessage`). Its Approve button is offered with the plan (this Lambda cannot tell the risk), so the refusal says
 * where to approve it, with the link: the sentence is fixed words and our own address. (0.5.11 note: a raise used to hide Approve behind "Open in Rovara" whatever the risk; now Approve is there.)
 */
export function slackRiskPlaceRefusal(reason: string): string | undefined {
  return RISK_PLACE.test(reason) ? reason.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;") : undefined;
}

/** Approval place (U4): the other fixed refusals of a plan approval (sign in again, link your account, not an approver), said as they are with Slack's markup escaped. */
export function slackApprovalPlaceRefusal(reason: string): string | undefined {
  return isApprovalPlaceWords(reason) ? reason.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;") : undefined;
}

/** An archived project takes no new work (a plan change, a send-back, a retry, Revise the plan): said plainly to the presser, who can ask an admin to restore it. */
export const SLACK_PROJECT_ARCHIVED = "This project is archived, so new work can't start. Ask an admin to restore it.";

/** What a person removed from the company hears when they press a button. */
export const SLACK_REMOVED_FROM_ORG = "You're no longer a member of this organization.";

export function slackRefusalMessage(code: string, outOfDate: string, reason = "", decidedBy?: unknown): string | undefined {
  switch (code) {
    // A refusal the presser can act on is said as it is; any other means the press no longer fits the task.
    case "CONFIG_INVALID": return SLACK_PLAIN_REFUSALS.get(reason) ?? slackPlanApprovalRefusal(reason) ?? slackRunLimitRefusal(reason) ?? outOfDate;
    // A plan that could not be checked for approval: the reason says to keep the plan and try again, so the presser hears it. Any other is unexpected.
    case "RUNTIME_UNAVAILABLE": return slackPlanApprovalRefusal(reason);
    // A lost race says who decided and when (the owner's name is redacted; Slack's markup characters are escaped).
    case "IDEMPOTENCY_CONFLICT": return LOST_RACE.test(reason) ? slackLostRace(reason, decidedBy) : outOfDate;
    case "WORKSPACE_BUSY":
    case "TASK_BUSY": return "AgentX is still working on the previous step. Try again when it posts.";
    case "FORBIDDEN": return slackRiskPlaceRefusal(reason) ?? slackApprovalPlaceRefusal(reason) ?? "Only the task owner can do that.";
    case "REMOVED_FROM_ORG": return SLACK_REMOVED_FROM_ORG;
    case "SLACK_ACCOUNT_NOT_LINKED": return SLACK_ACCOUNT_NOT_LINKED_NOTICE;
    case "PROJECT_ARCHIVED": return SLACK_PROJECT_ARCHIVED;
    case "TASK_NOT_FOUND": return "This task can't be changed from Slack. Continue it where it was started, or start a new request.";
    default: return undefined;
  }
}
