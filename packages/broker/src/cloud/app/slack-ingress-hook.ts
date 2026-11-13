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

