// Decision cards on Slack (Decisions D4): the same `DecisionCard` as Home, as Block Kit. One card, one message. The buttons follow the card's own friction, so Slack cannot be a way around it:
//   low    Approve (one tap) and Not now, and a link to the details;
//   medium NO approve button: "Review the evidence" is a link to the card on the web, where the evidence is opened and Approve is allowed; Not now stays one tap;
//   high   one link, "Open to decide": the full page and its fresh sign-in. No approve and no reject here.
// A pressed button carries only the card's id; the server re-checks everything (routes.ts), so a forged or stale press is refused there. Every word that came from a person, a plan or a repository
// was already flattened by the projector; here it is also escaped for Slack (a mention, a link, a broadcast).
import type { DecisionCard, DecisionTab } from "@agentx/contracts";

export const DECISION_SLACK_APPROVE_ACTION = "rovara_decision_approve";
export const DECISION_SLACK_REJECT_ACTION = "rovara_decision_reject";
export const DECISION_SLACK_OPEN_ACTION = "rovara_decision_open";
export const DECISION_SLACK_ACTION_IDS: ReadonlySet<string> = new Set([DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_REJECT_ACTION, DECISION_SLACK_OPEN_ACTION]);

export interface SlackCardMessage { text: string; blocks: Array<Record<string, unknown>> }

/** Escapes what Slack would read as markup. */
export const escapeSlack = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const SECTION_MAX = 2_800;
const clip = (value: string): string => [...value].slice(0, SECTION_MAX).join("");

const STATE_WORDS: Record<DecisionCard["evidence"][number]["state"], string> = { good: "", warning: " (check this)", bad: " (problem)", unknown: "" };
const RISK_WORDS: Record<DecisionCard["risk"], string> = { low: "Low risk", medium: "Medium risk: look at the evidence first", high: "High risk: decided on its own page, after you sign in again" };

const button = (actionId: string, text: string, extra: Record<string, unknown>): Record<string, unknown> => ({ type: "button", action_id: actionId, text: { type: "plain_text", text }, ...extra });

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
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: clip(head) } },
    { type: "section", text: { type: "mrkdwn", text: clip([`Recommended: ${escapeSlack(card.recommended.action)}. ${escapeSlack(card.recommended.why)}`, `Next: ${escapeSlack(card.next.text)}`, ...tabs].join("\n")) } },
    ...(evidence.length === 0 ? [] : [{ type: "context", elements: [{ type: "mrkdwn", text: clip(evidence.join("  |  ")) }] }]),
    { type: "context", elements: [{ type: "mrkdwn", text: clip([escapeSlack(RISK_WORDS[card.risk]), ...reasons, `Project: ${escapeSlack(card.project)}`].join("  |  ")) }] },
  ];
  if (card.status !== "pending") {
    const done = card.status === "answered_by_rule" ? "Answered by a standing rule." : card.status === "approved" ? "Approved." : card.status === "rejected" ? "Not now." : card.status === "expired" ? "Expired." : "Cancelled.";
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: done }] });
    return { text, blocks };
  }
  const elements: Array<Record<string, unknown>> = [];
  const canApprove = card.actions.some((action) => action.kind === "approve");
  const canReject = card.actions.some((action) => action.kind === "reject");
  if (card.risk === "high") {
    elements.push(button(DECISION_SLACK_OPEN_ACTION, "Open to decide", { url: input.cardUrl, style: "primary", value: `${card.id}|${input.digest}` }));
  } else if (card.risk === "low" && canApprove) {
    elements.push(button(DECISION_SLACK_APPROVE_ACTION, "Approve", { style: "primary", value: `${card.id}|${input.digest}` }));
    if (canReject) elements.push(button(DECISION_SLACK_REJECT_ACTION, "Not now", { value: `${card.id}|${input.digest}` }));
    elements.push(button(DECISION_SLACK_OPEN_ACTION, "Details", { url: input.cardUrl, value: `${card.id}|${input.digest}` }));
  } else {
    // Medium, or a low card that is answered on its own page (a question, a choice).
    elements.push(button(DECISION_SLACK_OPEN_ACTION, card.risk === "medium" ? "Review the evidence" : "Open", { url: input.cardUrl, style: "primary", value: `${card.id}|${input.digest}` }));
    if (canReject) elements.push(button(DECISION_SLACK_REJECT_ACTION, "Not now", { value: `${card.id}|${input.digest}` }));
  }
  blocks.push({ type: "actions", elements });
  return { text, blocks };
}
