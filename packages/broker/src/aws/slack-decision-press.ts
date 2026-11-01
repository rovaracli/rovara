// Decision cards in Slack (wire-proof): the interactivity Lambda's handler for a card's buttons. It knows nothing about people or cards: it hands the press (who pressed, in which workspace, which button and
// the digest of what the card showed) to the broker, which finds the real Rovara person and runs the press through the card routes, and it says privately what the broker answers. "Open" is a link button and
// is only acknowledged. While the broker's cards switch is off it answers `enabled: false`, and the press is answered exactly as any button this Lambda does not know.
import { DECISION_SLACK_ACTION_IDS, DECISION_SLACK_OPEN_ACTION } from "../decisions/slack-card.js";
import type { SlackActionHandler, SlackBlockAction } from "./slack-interactivity.js";

export interface DecisionPressDependencies {
  /** A direct broker invoke: the broker's reply, or a throw when the broker itself failed. */
  invokeBroker(event: Record<string, unknown>, timeoutMs: number): Promise<{ statusCode?: number | undefined; body?: string | undefined }>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
  /** What is said for a button nobody knows (the same sentence the Lambda uses for any unknown button). */
  unknownButtonText: string;
}

/** How long the Lambda waits for the broker: inside Slack's window for a response URL. */
const DECISION_PRESS_TIMEOUT_MS = 8_000;

export function decisionPressHandler(deps: DecisionPressDependencies): SlackActionHandler {
  return {
    matches: (actionId) => DECISION_SLACK_ACTION_IDS.has(actionId),
    async handle(action: SlackBlockAction) {
      if (action.actionId === DECISION_SLACK_OPEN_ACTION) return;
      const answer = await deps.invokeBroker({
        source: "agentx.slack-ingress", action: "decision-card-press",
        press: {
          actionId: action.actionId, value: action.value, userId: action.userId, ...(action.actionTs === undefined ? {} : { actionTs: action.actionTs }), messageTs: action.messageTs,
          userTeamId: action.userTeamId, workspaceTeamId: action.workspaceTeamId, enterpriseId: action.enterpriseId, userEnterpriseId: action.userEnterpriseId,
        },
      }, DECISION_PRESS_TIMEOUT_MS);
      let said = deps.unknownButtonText;
      try {
        const body = JSON.parse(answer.body ?? "") as { enabled?: unknown; text?: unknown };
        if (answer.statusCode === 200 && body.enabled === true && typeof body.text === "string" && body.text.length > 0 && body.text.length <= 600) said = body.text;
      } catch { /* an answer that is not the broker's is the unknown button */ }
      await deps.respondEphemeral(action.responseUrl, said);
    },
  };
}
