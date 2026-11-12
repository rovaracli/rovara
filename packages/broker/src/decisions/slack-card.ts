// Decision cards on Slack (Decisions D4): the same `DecisionCard` as Home, as Block Kit. One card, one message. The buttons follow the card's own friction, so Slack cannot be a way around it:
//   low    Approve (one tap) and Not now, and "Open", a link to the card;
//   medium a CODING PLAN has Approve too (approval place, U4: the message shows its evidence, and the server lets a linked person who signed in to Rovara within the company's window approve it, else it says to open the card); any other medium card has no
//          approve button: "Show the evidence" is a link to the card on the web, where the evidence is opened and Approve is allowed. Not now is one tap on every card, and in a chat it is a dismissal, never a rejection;
//   high   one link, "Open": the card (or the confirmation page and its fresh sign-in). No approve here.
//   A coding plan also has Reject at every risk (owner decision 99: a reject only stops work, so it is judged like a medium approval, never needs the app; the server checks the person is linked and recently signed in). Reject asks "Are you sure?" first, and a
//   Not now (a dismissal) is never put beside it.
// The button words are the shared table (`DECISION_LABELS`), the same as the web card's.
// A pressed button carries only the card's id; the server re-checks everything (routes.ts), so a forged or stale press is refused there. Every word that came from a person, a plan or a repository
// was already flattened by the projector; here it is also escaped for Slack (a mention, a link, a broadcast).
import { DECISION_LABELS, formatRunLimitUsd, hideEmailAddresses, runLimitRaiseText, runLimitRaises, type DecisionCard, type DecisionTab } from "@rovara-code/contracts";

export const DECISION_SLACK_APPROVE_ACTION = "rovara_decision_approve";
export const DECISION_SLACK_REJECT_ACTION = "rovara_decision_reject";
export const DECISION_SLACK_OPEN_ACTION = "rovara_decision_open";
/** Owner decision 99: Reject on a coding plan's message. A rejection ends the task; it is not `DECISION_SLACK_REJECT_ACTION`, which is "Not now", a dismissal. */
export const DECISION_SLACK_REJECT_PLAN_ACTION = "rovara_decision_reject_plan";
export const DECISION_SLACK_ACTION_IDS: ReadonlySet<string> = new Set([DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_REJECT_ACTION, DECISION_SLACK_REJECT_PLAN_ACTION, DECISION_SLACK_OPEN_ACTION]);

export interface SlackCardMessage { text: string; blocks: Array<Record<string, unknown>> }

/** Escapes what Slack would read as markup. */
export const escapeSlack = (value: string): string => hideEmailAddresses(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const SECTION_MAX = 2_800;
const clip = (value: string): string => [...value].slice(0, SECTION_MAX).join("");

const STATE_WORDS: Record<DecisionCard["evidence"][number]["state"], string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const RISK_WORDS: Record<DecisionCard["risk"], string> = { low: "Low risk", medium: "Medium risk: look at the evidence first", high: "High risk: decided on its own page" };
/** A high card promises a fresh sign-in only when it opens the confirmation page (`/v1/app/approve/<id>`); otherwise it only says it is decided on the item's page. */
const opensConfirmationPage = (card: DecisionCard): boolean => (card.actions.find((action) => action.kind === "open")?.href ?? "").startsWith("/v1/app/approve/");
const riskWords = (card: DecisionCard): string => (card.risk === "high" && opensConfirmationPage(card) ? `${RISK_WORDS.high}, after you sign in again` : RISK_WORDS[card.risk]);

const button = (actionId: string, text: string, extra: Record<string, unknown>): Record<string, unknown> => ({ type: "button", action_id: actionId, text: { type: "plain_text", text }, ...extra });
/** Slack's own "Are you sure?" for the one tap that ends a task. Fixed words. */
const REJECT_CONFIRM = { title: { type: "plain_text", text: "Reject this plan?" }, text: { type: "mrkdwn", text: "This stops the task. Nothing is coded." }, confirm: { type: "plain_text", text: "Reject" }, deny: { type: "plain_text", text: "Cancel" } };

/**
 * The message for a card. `cardUrl` is the card's page on the web (an https address of this deployment, built by the caller from the card's own open action); it is the only link on the message.
 * A card that is no longer pending gets no buttons and says what became of it.
 */
export function slackCardMessage(card: DecisionCard, input: { cardUrl: string; /** The digest of what this message shows (the projection's `digests[card.id]`): a press carries it, so a card that changed since is refused. */ digest: string; tabs?: readonly DecisionTab[] | undefined }): SlackCardMessage {
  const evidence = card.evidence.map((chip) => `${escapeSlack(chip.label)}: ${escapeSlack(chip.value)}${STATE_WORDS[chip.state]}`);
  const tabs = input.tabs === undefined ? [] : [`Two approvals: ${input.tabs.map((tab) => escapeSlack(tab.title)).join(" and ")}.`];
  const reasons = card.riskReasons.slice(0, 2).map(escapeSlack);
  const head = `*${escapeSlack(card.title)}*\n${escapeSlack(card.question)}`;
  const text = escapeSlack(`${card.title}: ${card.question}`);
  // QA6-12b: a coding plan that raises the run limit says so in the owner's words, and its Approve button carries the amount it shows (a third part of the value); the server refuses a press whose amount is no longer what approving sets.
  const raise = card.kind === "approve_plan" && card.runLimit !== undefined && runLimitRaises(card.runLimit.currentUsd, card.runLimit.proposedUsd) ? card.runLimit : undefined;
  const raiseLine = raise === undefined ? [] : [raise.currentUsd === undefined ? `This sets the run limit to ${formatRunLimitUsd(raise.proposedUsd)}.` : `${runLimitRaiseText(raise.currentUsd, raise.proposedUsd)}.`];
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: clip(head) } },
    { type: "section", text: { type: "mrkdwn", text: clip([`Recommended: ${escapeSlack(card.recommended.action)}. ${escapeSlack(card.recommended.why)}`, `Next: ${escapeSlack(card.next.text)}`, ...raiseLine, ...tabs].join("\n")) } },
    ...(evidence.length === 0 ? [] : [{ type: "context", elements: [{ type: "mrkdwn", text: clip(evidence.join("  |  ")) }] }]),
    { type: "context", elements: [{ type: "mrkdwn", text: clip([escapeSlack(riskWords(card)), ...reasons, `Project: ${escapeSlack(card.project)}`].join("  |  ")) }] },
  ];
  if (card.status !== "pending") {
    const done = card.status === "answered_by_rule" ? "Answered by a standing rule." : card.status === "approved" ? "Approved." : card.status === "rejected" ? (card.kind === "approve_plan" ? "Rejected." : "Not now.") : card.status === "expired" ? "Expired." : "Cancelled.";
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: done }] });
    return { text, blocks };
  }
  const elements: Array<Record<string, unknown>> = [];
  const canApprove = card.actions.some((action) => action.kind === "approve");
  // "Not now" is a dismissal and never a rejection; a coding plan's reject action is the real Reject, offered as its own button.
  const canReject = card.actions.some((action) => action.kind === "reject") && card.kind !== "approve_plan";
  const rejectPlan = card.kind === "approve_plan" && card.actions.some((action) => action.kind === "reject")
    ? [button(DECISION_SLACK_REJECT_PLAN_ACTION, "Reject", { style: "danger", value: `${card.id}|${input.digest}`, confirm: REJECT_CONFIRM })] : [];
  if (card.risk === "high") {
    elements.push(button(DECISION_SLACK_OPEN_ACTION, DECISION_LABELS.open, { url: input.cardUrl, style: "primary", value: `${card.id}|${input.digest}` }), ...rejectPlan);
  } else if ((card.risk === "low" || (card.risk === "medium" && card.kind === "approve_plan")) && canApprove) {
    elements.push(button(DECISION_SLACK_APPROVE_ACTION, card.kind === "merge" ? DECISION_LABELS.merge : DECISION_LABELS.approve, { style: "primary", value: `${card.id}|${input.digest}${raise === undefined ? "" : `|${String(raise.proposedUsd)}`}` }));
    if (canReject) elements.push(button(DECISION_SLACK_REJECT_ACTION, DECISION_LABELS.notNow, { value: `${card.id}|${input.digest}` }));
    elements.push(...rejectPlan, button(DECISION_SLACK_OPEN_ACTION, DECISION_LABELS.open, { url: input.cardUrl, value: `${card.id}|${input.digest}` }));
  } else {
    // Medium, or a low card that is answered on its own page (a question, a choice).
    elements.push(button(DECISION_SLACK_OPEN_ACTION, card.risk === "medium" ? DECISION_LABELS.showEvidence : DECISION_LABELS.open, { url: input.cardUrl, style: "primary", value: `${card.id}|${input.digest}` }));
    if (canReject) elements.push(button(DECISION_SLACK_REJECT_ACTION, DECISION_LABELS.notNow, { value: `${card.id}|${input.digest}` }));
    elements.push(...rejectPlan);
  }
  blocks.push({ type: "actions", elements });
  return { text, blocks };
}
