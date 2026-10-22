// Plan 3, Task 22 (R4-2): what an agent's final report may say in Slack. An agent writes the report from what it read (tickets, pull requests, a
// repository), and some of that is written by strangers, so before the notifier posts it for the project's channel it is made harmless:
//   - every mention is gone (Slack's own forms, a plain @channel, @here or @everyone, and any @name, as Task 14 strips them from a comment);
//   - every link to another site is plain text (`label (host)`): only the task's own link and the org's `reportLinkDomains` stay links;
//   - and if what is left reads as a command to a bot or a chat-ops tool (a slash command, `!deploy`, `deploy api to production`, `rollback`,
//     `restart`, an org's own command word), nothing of the report is posted: only a link to the task, where the whole report stays.
// A pure function of its input.
import { commentLines, commentSignal, stripMentions, type OrgId } from "@agentx/contracts";

/**
 * Chat-ops commands that a channel's bots and automations act on, matched case-insensitively against each LINE of the normalized report
 * (look-alike and invisible characters folded). Maintained: a new tool that listens to a channel gets its words here.
 */
export const CHATOPS_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\s*[!.][a-z]/i,
  /\bdeploy\b.{0,60}\bto\b/i,
  /\bship\b.{0,60}\bto\b/i,
  /\brollback\b/i,
  /\broll back\b/i,
  /\brestart\b/i,
  /\bredeploy\b/i,
  /\bpromote\b.{0,60}\bto\b/i,
  /\bscale\b.{0,40}\bto\b/i,
]);

export type PreparedSlackReport = { kind: "text"; text: string } | { kind: "link_only"; text: string };

export interface SlackReportOptions {
  orgId: OrgId;
  /** The task's page: the one address of the cell that may stay a link, and what a withheld report points at. */
  taskUrl: string;
  /** The org's other hosts whose links may stay (guardrail, at most 20, default none). A subdomain of one is allowed too. */
  reportLinkDomains: readonly string[];
  /** The org's own command words (guardrail): one anywhere in the report withholds it. */
  extraCommandWords: readonly string[];
}

/** The text Slack mentions become: never the `<@U…>` form that pings a person, never a broadcast word with its markup. */
function plainSlackForms(text: string): string {
  return text
    // <!channel>, <!here> and <!everyone> (and the space after) are dropped: they would ping the whole channel.
    .replace(/<!(?:channel|here|everyone)(?:\|[^>]*)?>[ ]?/g, "")
    // <!subteam^S123|@oncall>, <!date^…|fallback> and any other <!…>: its label, else "a user group" for a group and nothing.
    .replace(/<!([^>|]*)(?:\|([^>]*))?>/g, (_form, command: string, label: string | undefined) => {
      if (label !== undefined && label.trim() !== "") return label.replace(/^@+/u, "");
      return command.startsWith("subteam") ? "a user group" : "";
    })
    // <@U123>, <@W456|alice>: the label, else "a person".
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_form, _id: string, label: string | undefined) => (label !== undefined && label.trim() !== "" ? label.replace(/^@+/u, "") : "a person"))
    // <#C789|general>: #general, else "a channel".
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_form, _id: string, label: string | undefined) => (label !== undefined && label.trim() !== "" ? `#${label}` : "a channel"))
    // A plain @channel, @here or @everyone (and the space after).
    .replace(/(?<![\p{L}\p{N}_])@(?:channel|here|everyone)(?![\p{L}\p{N}_])[ ]?/giu, "");
}

const LINK = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>|(https?:\/\/[^\s<>|]+)/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Every link to a host that is neither the task's own nor one the org allows becomes plain text with its host after it. */
function flattenLinks(text: string, allowed: (host: string) => boolean): string {
  return text.replace(LINK, (whole: string, slackUrl: string | undefined, label: string | undefined, bare: string | undefined) => {
    if (slackUrl !== undefined) {
      const host = hostOf(slackUrl);
      if (host !== undefined && allowed(host)) return whole;
      const shown = label === undefined || label.trim() === "" ? "link" : flattenLinks(label, allowed);
      return `${shown} (${host ?? "unknown site"})`;
    }
    const trailing = TRAILING_PUNCTUATION.exec(bare!)?.[0] ?? "";
    const address = trailing === "" ? bare! : bare!.slice(0, -trailing.length);
    const host = hostOf(address);
    return host !== undefined && allowed(host) ? whole : `link (${host ?? "unknown site"})${trailing}`;
  });
}

export function prepareSlackReport(report: string, options: SlackReportOptions): PreparedSlackReport {
  const taskHost = hostOf(options.taskUrl);
  const domains = options.reportLinkDomains.map((domain) => domain.toLowerCase());
  const allowed = (host: string): boolean => host === taskHost
    || domains.some((domain) => host.split(":")[0] === domain || host.split(":")[0]!.endsWith(`.${domain}`));
  const unmentioned = stripMentions(plainSlackForms(report)).args as string;
  const text = flattenLinks(unmentioned, allowed);
  const command = commentSignal(text, { allowMentions: false, labelPaths: [], extraCommandWords: options.extraCommandWords }).consequential
    || commentLines(text).some((line) => CHATOPS_PATTERNS.some((pattern) => pattern.test(line)));
  return command ? { kind: "link_only", text: `Report available in Rovara: ${options.taskUrl}` } : { kind: "text", text };
}
