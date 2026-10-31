// Decision cards on Slack (Decisions D4): what a press does. A press names only the card; it is turned into the same request the web sends and goes through `routeDecisionCards`, so the server's
// friction (evidence opened first for a medium card, no approve for a high one, the caller's own authority) applies to Slack exactly as to the web. A refusal is said to the person alone
// (ephemeral), in fixed words; nothing from the refusal's own text is shown.
import { createHash } from "node:crypto";
import { DecisionCardIdSchema } from "@agentx/contracts";
import { DECISION_SLACK_ACTION_IDS, DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_OPEN_ACTION, DECISION_SLACK_REJECT_ACTION } from "./slack-card.js";
import { decisionCardPath } from "./project.js";
import type { DecisionCaller, DecisionRequest } from "./routes.js";

/** A stable v4-shaped request id from the card and the press's own timestamp, so Slack's retry of one press is one decision. */
export function pressRequestId(cardId: string, actionTs: string): string {
  const hex = createHash("sha256").update(`decision-slack\0${cardId}\0${actionTs}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The press as a card request, or undefined for a button that is not a decision press (or a card id that is not one). Only an approve or a "not now" is a request. */
export function pressToRequest(press: { actionId: string; value: string; actionTs: string }): DecisionRequest | undefined {
  const id = DecisionCardIdSchema.safeParse(press.value);
  if (!id.success) return undefined;
  if (press.actionId === DECISION_SLACK_APPROVE_ACTION) return { method: "POST", pathname: `${decisionCardPath(id.data)}/approve`, searchParams: new URLSearchParams(), body: { requestId: pressRequestId(id.data, press.actionTs) } };
  if (press.actionId === DECISION_SLACK_REJECT_ACTION) return { method: "POST", pathname: `${decisionCardPath(id.data)}/reject`, searchParams: new URLSearchParams(), body: { requestId: pressRequestId(id.data, press.actionTs), reason: "not_now" } };
  return undefined;
}

export const DECISION_SLACK_TEXT = Object.freeze({
  approved: "Approved.",
  rejected: "Noted. Not now.",
  openFirst: "Open the evidence on the web first, then approve it there.",
  openToDecide: "This one is decided on its own page. Use Open to decide.",
  gone: "This decision is no longer waiting for you.",
  unknownPerson: "I couldn't tell who you are in Rovara. Open the decision on the web.",
  failed: "I couldn't record that. Open the decision on the web and try again.",
});

/** The fixed sentence for an error a route threw (by its code only). */
export function refusalText(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error).code : undefined;
  if (code === "CHANGE_STALE") return DECISION_SLACK_TEXT.openFirst;
  if (code === "NOT_FOUND") return DECISION_SLACK_TEXT.gone;
  return DECISION_SLACK_TEXT.failed;
}

export interface SlackPress { actionId: string; value: string; userId: string; actionTs?: string | undefined; messageTs: string; responseUrl: string }

export interface DecisionSlackDependencies {
  /** The Rovara person behind a Slack user, or undefined when it cannot be told (never guessed). */
  resolveCaller(press: SlackPress): Promise<DecisionCaller | undefined>;
  route(caller: DecisionCaller, request: DecisionRequest): Promise<unknown>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
}

/** A handler shaped like `SlackActionHandler` (matches / handle), ready for the interactivity list. The link buttons' own presses are acknowledged and ignored. */
export function decisionSlackHandler(deps: DecisionSlackDependencies): { matches(actionId: string): boolean; handle(action: SlackPress): Promise<void> } {
  return {
    matches: (actionId) => DECISION_SLACK_ACTION_IDS.has(actionId),
    async handle(press) {
      if (press.actionId === DECISION_SLACK_OPEN_ACTION) return;
      const request = pressToRequest({ actionId: press.actionId, value: press.value, actionTs: press.actionTs ?? press.messageTs });
      if (request === undefined) { await deps.respondEphemeral(press.responseUrl, DECISION_SLACK_TEXT.gone); return; }
      const caller = await deps.resolveCaller(press);
      if (caller === undefined) { await deps.respondEphemeral(press.responseUrl, DECISION_SLACK_TEXT.unknownPerson); return; }
      try {
        await deps.route(caller, request);
      } catch (error) {
        await deps.respondEphemeral(press.responseUrl, refusalText(error));
        return;
      }
      await deps.respondEphemeral(press.responseUrl, press.actionId === DECISION_SLACK_APPROVE_ACTION ? DECISION_SLACK_TEXT.approved : DECISION_SLACK_TEXT.rejected);
    },
  };
}
