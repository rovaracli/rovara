// S3 item b, the ingress Lambda's half. Kept in a module of its own with no heavy imports, so the ingress bundle does not pull in the broker's core.
import type { SlackRequestMessage } from "@rovara-code/contracts";

/** The broker event the ingress sends for a plain top-level Slack request (a direct invoke, like `start-workflow`). */
export const CORE_SLACK_ACTION = "core-slack-request";

export interface CoreSlackRequestEvent { source: "agentx.slack-ingress"; action: typeof CORE_SLACK_ACTION; message: SlackRequestMessage }

export interface CoreSlackFromIngressDeps {
  env: NodeJS.ProcessEnv;
  /** The ingress's direct broker invoke (`invokeBroker`). */
  invokeBroker: (event: Record<string, unknown>) => Promise<{ statusCode?: number; body?: string }>;
  /** Posts in the Slack thread (the ingress's `postSlackMessage` with its bot token). */
  post: (thread: SlackRequestMessage["thread"], text: string) => Promise<void>;
  /** Whether the combined switch is on for any company in this environment (`readCoreEngineFlags`). */
  active: boolean;
}

/**
 * The ingress Lambda's half: sends a plain top-level request to the broker's consumer and says what it answers. `undefined` while the switch is off, so the ingress wires nothing and
 * its behaviour is exactly what it was. A `true` answer means the core took the request (any refusal already told in the thread): the ingress must not queue it.
 */
export function coreSlackFromIngress(deps: CoreSlackFromIngressDeps): ((message: SlackRequestMessage) => Promise<boolean>) | undefined {
  if (!deps.active) return undefined;
  return async (message) => {
    const reply = await deps.invokeBroker({ source: "agentx.slack-ingress", action: CORE_SLACK_ACTION, message });
    if (reply.statusCode !== 200) throw new Error("the broker's core Slack consumer failed");
    const answer = JSON.parse(reply.body ?? "{}") as { handled?: unknown; reply?: unknown };
    if (answer.handled !== true) return false;
    if (typeof answer.reply === "string" && answer.reply !== "") await deps.post(message.thread, answer.reply);
    return true;
  };
}

// ---- a press on a card the core posted ----

/** The broker event the ingress sends for a press on a card the core's Slack adapter posted (its buttons are `rovara_decide_<DECISION>`, `plugins/channel/slack-cloud/adapter.ts`). */
export const CORE_SLACK_PRESS_ACTION = "core-slack-press";
/** The prefix of the core card's buttons (the adapter's `CLOUD_SLACK_ACTION_PREFIX`; a test holds the two together). */
export const CORE_CARD_ACTION_PREFIX = "rovara_decide_";

/** What the ingress hands the broker for one press: who, where, which button and what it carried. The broker checks every field again. */
export interface CoreSlackPress {
  actionId: string;
  value: string;
  userId: string;
  userTeamId: string;
  workspaceTeamId: string;
  /** The payload's Enterprise Grid ids (empty outside a grid): carried so the broker's rules see them. */
  enterpriseId: string;
  userEnterpriseId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  actionTs?: string;
}

export interface CoreSlackPressRequestEvent { source: "agentx.slack-ingress"; action: typeof CORE_SLACK_PRESS_ACTION; press: CoreSlackPress }

/** What the interactivity handler needs of Slack's own press, structurally (the real type is `SlackBlockAction`). */
interface PressedAction { actionId: string; value: string; userId: string; userTeamId: string; workspaceTeamId: string; enterpriseId: string; userEnterpriseId: string; thread: { teamId: string; channelId: string; threadTs: string }; messageTs: string; actionTs?: string | undefined; responseUrl: string }

export interface CorePressHandlerDeps {
  /** The ingress's direct broker invoke. */
  invokeBroker: (event: Record<string, unknown>, timeoutMs: number) => Promise<{ statusCode?: number | undefined; body?: string | undefined }>;
  respondEphemeral: (responseUrl: string, text: string) => Promise<void>;
  /** What is said when the broker answers nothing usable (the same sentence the Lambda uses for any unknown button). */
  unknownButtonText: string;
}

const CORE_PRESS_TIMEOUT_MS = 8_000;

/**
 * The interactivity Lambda's handler for the buttons of a card the core posted. It knows nothing about cards or people: it hands the press to the broker, which finds the card, the person and the task, and
 * says privately what the broker answers. It is registered whatever the switch says: a task the core holds keeps its cards live after the switch is turned off, and only buttons the core's own adapter posted match it.
 */
export function corePressHandler(deps: CorePressHandlerDeps): { matches(actionId: string): boolean; handle(action: PressedAction): Promise<void> } {
  return {
    matches: (actionId) => actionId.startsWith(CORE_CARD_ACTION_PREFIX),
    async handle(action) {
      const press: CoreSlackPress = {
        actionId: action.actionId, value: action.value, userId: action.userId, userTeamId: action.userTeamId, workspaceTeamId: action.workspaceTeamId, enterpriseId: action.enterpriseId, userEnterpriseId: action.userEnterpriseId,
        teamId: action.thread.teamId, channelId: action.thread.channelId, threadTs: action.thread.threadTs, messageTs: action.messageTs, ...(action.actionTs === undefined ? {} : { actionTs: action.actionTs }),
      };
      const answer = await deps.invokeBroker({ source: "agentx.slack-ingress", action: CORE_SLACK_PRESS_ACTION, press }, CORE_PRESS_TIMEOUT_MS);
      let said = deps.unknownButtonText;
      try {
        const body = JSON.parse(answer.body ?? "") as { enabled?: unknown; text?: unknown };
        if (answer.statusCode === 200 && body.enabled === true && typeof body.text === "string" && body.text.length > 0 && body.text.length <= 600) said = body.text;
      } catch { /* an answer that is not the broker's is the unknown button */ }
      await deps.respondEphemeral(action.responseUrl, said);
    },
  };
}
