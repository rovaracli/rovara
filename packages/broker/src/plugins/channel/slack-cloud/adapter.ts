// Convergence lane A8 (H1): Cloud's Slack as an ordinary `channel` adapter on Code's port. REGISTERED ONLY: no live path calls it (the Slack ingress Lambda, the Slack service and the notifier keep running as they do),
// so registering it changes nothing for a company. It sends with the SAME Web API calls today's code makes (`chatPostMessage`, `chatPostEphemeral`: unfurls off, Slack's error code only) and escapes text the way today's
// notices do (`&`, `<` and `>` only: no link, mention or channel reference can come out of a task's words).
//
// What it will not do, whatever it is told: it posts only in the workspace its `serves` check allows (a conversation of another workspace is refused, fail closed), it never puts more in a message than the event carries,
// and the kinds of decision that ask for a sign-in (`plan_approval`, `admin`) are in `stepUp`, so a card for one carries no buttons. It has no `start`: Cloud hears Slack on its own ingress, and hands what it hears to the
// sink (`wiring.ts`) once that path is switched.
import type { ChannelAdapter, ChannelCapabilities, ChannelDecision, ChannelEvent, StepUpKind } from "@rovara-code/contracts";
import { chatPostEphemeral, chatPostMessage } from "../../../aws/slack-web.js";

/** The same shape as Code's own Slack adapter, so a card renders and answers the same wherever it runs. */
export const CLOUD_SLACK_CAPABILITIES: ChannelCapabilities = { threads: true, buttons: 4, edits: false, maxTextLength: 3_000, proactive: true };
/** The thread id this adapter reads as "no thread": a message at the top of a space (a direct message, a notice). */
export const CLOUD_SLACK_NO_THREAD = "0000000000.000000";
export const CLOUD_SLACK_ACTION_PREFIX = "rovara_decide_";
const SEEN_MAX = 1_000;
const SECTION_MAX = 3_000;

export class CloudSlackError extends Error {
  constructor(readonly code: "wrong_channel" | "wrong_workspace" | "direct_not_supported") {
    super(code);
    this.name = "CloudSlackError";
  }
}

/** Text for Slack's markup: `&`, `<` and `>` are the only characters it reads as syntax (the notifier's own rule). */
export const slackEscape = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").replace(/&[a-z]{0,3}$/u, "")}…`;
};

export interface Rendered { text: string; blocks?: unknown[]; ephemeralTo?: string }

const LABEL_STYLE: Partial<Record<ChannelDecision["decision"], "primary" | "danger">> = { APPROVE: "primary", REJECT: "danger" };
const section = (text: string): unknown => ({ type: "section", text: { type: "mrkdwn", text: cut(slackEscape(text), SECTION_MAX) } });

/** The message for an event, or undefined when it says nothing to a person in this chat. */
export function renderCloudSlackEvent(event: ChannelEvent, maxLength: number): Rendered | undefined {
  const text = (value: string): string => cut(slackEscape(value), maxLength);
  switch (event.type) {
    case "ack": return { text: "Got it." };
    case "progress": return { text: text(event.data.text), ...(event.data.onlyTo === undefined ? {} : { ephemeralTo: event.data.onlyTo }) };
    case "question": return { text: text(event.data.choices === undefined ? event.data.text : `${event.data.text}\n${event.data.choices.map((choice, index) => `${String(index + 1)}. ${choice}`).join("\n")}`) };
    case "check_report": return { text: text(`${{ passed: "Checks passed.", failed: "Checks failed.", unknown: "Checks have not finished." }[event.data.status]} ${event.data.text}`) };
    case "pr": return { text: text(`Pull request: ${event.data.title}\n${event.data.url}`) };
    // The text of a reply or notice only, as Code's own Slack adapter does (this adapter declares no `edits`, `ephemeral` parts or `direct`); parts and actions are not shown.
    case "message": return { text: text(event.data.text), ...(event.data.audience?.kind === "ephemeral" ? { ephemeralTo: event.data.audience.actor.userId } : {}) };
    // A closing line is optional since the 0.5.17 pin: everything the request said came before it.
    case "done": return event.data.text === undefined ? undefined : { text: text(event.data.text) };
    // Needs `direct`, which this adapter does not declare.
    case "direct": return undefined;
    case "error": return { text: text(event.data.text) };
    case "link_required": return { text: text(`Link your account to Rovara: ${event.data.linkUrl}`), ephemeralTo: event.data.actor.userId };
    case "approval_request": {
      const open = { type: "button", text: { type: "plain_text", text: "Open the task" }, url: event.data.taskUrl, action_id: "rovara_open_task" };
      const buttons = (event.data.actions ?? []).map((action) => ({
        type: "button", text: { type: "plain_text", text: cut(action.label, 70) }, action_id: `${CLOUD_SLACK_ACTION_PREFIX}${action.decision}`,
        ...(LABEL_STYLE[action.decision] === undefined ? {} : { style: LABEL_STYLE[action.decision] }),
        value: JSON.stringify({ r: event.data.requestId, v: event.data.expectedRevision, d: event.data.artifactDigest, o: action.decision }),
      }));
      return { text: text(event.data.text), blocks: [section(event.data.text), { type: "actions", elements: [...buttons, open] }] };
    }
  }
}

export interface CloudSlackOptions {
  /** The projects the adapter serves. */
  projects: readonly string[];
  /** Reads the bot token for each request (a Secrets Manager read behind a cache, as the notifier does). */
  botToken: () => Promise<string>;
  /** Whether this install's bot may post in a workspace: the workspace is one a company bound. False or a throw refuses (fail closed). */
  serves: (teamId: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

export class CloudSlackChannel implements ChannelAdapter {
  readonly capabilities = CLOUD_SLACK_CAPABILITIES;
  readonly projects: readonly string[];
  readonly stepUp: readonly StepUpKind[] = ["plan_approval", "admin"];
  readonly noThread = CLOUD_SLACK_NO_THREAD;
  private readonly seen = new Set<string>();

  constructor(private readonly options: CloudSlackOptions) {
    this.projects = [...options.projects];
  }

  async deliver(event: ChannelEvent): Promise<void> {
    if (event.channel !== "slack") throw new CloudSlackError("wrong_channel");
    // A message to one person outside any conversation needs the `direct` ability, which this adapter does not declare, so the core never sends one here (Code's Slack adapter refuses it the same way).
    if (event.type === "direct") throw new CloudSlackError("direct_not_supported");
    if (event.conversation.channel !== "slack") throw new CloudSlackError("wrong_channel");
    // At least once: a repeat of an event id in this run is dropped, as an adapter must.
    if (this.seen.has(event.id)) return;
    const served = await this.options.serves(event.conversation.tenant).catch(() => false);
    if (!served) throw new CloudSlackError("wrong_workspace");
    const rendered = renderCloudSlackEvent(event, this.capabilities.maxTextLength);
    if (rendered === undefined) return;
    const threadTs = event.conversation.thread === CLOUD_SLACK_NO_THREAD ? undefined : event.conversation.thread;
    const token = await this.options.botToken();
    const fetchImplementation = this.options.fetch ?? fetch;
    if (rendered.ephemeralTo !== undefined) await chatPostEphemeral(token, { channel: event.conversation.space, user: rendered.ephemeralTo, threadTs, text: rendered.text }, fetchImplementation);
    else await chatPostMessage(token, { channel: event.conversation.space, threadTs, text: rendered.text, blocks: rendered.blocks }, fetchImplementation);
    this.seen.add(event.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
  }
}
