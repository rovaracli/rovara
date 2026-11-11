// Plan 3, Task 22 (R4-2): what an agent's final report may say in Slack. An agent writes the report from what it read (tickets, pull requests, a
// repository), and some of that is written by strangers, so before the notifier posts it for the project's channel it is made harmless:
//   - every mention is gone (Slack's own forms, a plain @channel, @here or @everyone, and any @name, as Task 14 strips them from a comment);
//   - every link to another site is plain text (`label (host)`): only the task's own link and the org's `reportLinkDomains` stay links;
//   - and if what is left reads as a command to a bot or a chat-ops tool (a slash command, `!deploy`, `deploy api to production`, `rollback`,
//     `restart`, an org's own command word), nothing of the report is posted: only a link to the task, where the whole report stays.
// A pure function of its input.
import { cleanText, commentLines, commentSignal, hideEmailAddresses, stripMentions, type OrgId } from "@rovara-code/contracts";

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

/**
 * What a report holds that Slack turns into something live, in the order the scan meets it: `<url|label>`, a bare `https://` or `mailto:` address, and a bare
 * domain (`evil.example/login`, `www.evil.example`, `evil.com`). A bare domain is only taken for one when it has a path, starts with `www.` or ends in a
 * top-level domain Slack is known to link: file names (`README.md`, `index.ts`) and versions (`1.2.3`) stay as they are.
 */
const LINK = new RegExp([
  String.raw`<((?:https?:\/\/|mailto:)[^|>\s<]+)(?:\|([^>]*))?>`,
  String.raw`((?:https?:\/\/|mailto:)[^\s<>|]+)`,
  String.raw`(?<![\p{L}\p{N}_@./:-])((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/[^\s<>|]*)?)`,
].join("|"), "giu");
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;
/** The top-level domains that Slack links when they stand alone; others are only taken for a domain when a path or `www.` shows it is one. */
const LINKED_TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set([
  "com", "net", "org", "io", "dev", "app", "co", "ai", "info", "biz", "xyz", "online", "site", "tech", "cloud", "link", "click", "top", "us", "uk", "de", "fr", "ru", "cn", "in",
  "ly", "gl", "gd", "me", "to", "cc", "tv", "ws", "edu", "gov",
]);

/** The host of an address; for a `mailto:` address the domain of the mailbox. */
function hostOf(url: string): string | undefined {
  if (/^mailto:/iu.test(url)) {
    const address = url.slice("mailto:".length).split("?")[0]!;
    const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    return address.includes("@") && domain !== "" ? domain : undefined;
  }
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A host as it is shown once its link is flattened: its dots in brackets, so Slack does not link it again (Task 22 M4, the one-line fix of the final fix wave). */
const defanged = (host: string): string => host.replace(/\./gu, "[.]");

/** Every link to a host that is neither the task's own nor one the org allows becomes plain text with its host after it. */
function flattenLinks(text: string, allowed: (host: string) => boolean): string {
  return text.replace(LINK, (whole: string, slackUrl: string | undefined, label: string | undefined, bare: string | undefined, domain: string | undefined) => {
    if (slackUrl !== undefined) {
      const host = hostOf(slackUrl);
      const shown = label === undefined || label.trim() === "" ? undefined : flattenLinks(label, allowed);
      if (host !== undefined && allowed(host)) return shown === undefined ? whole : `<${slackUrl}|${shown}>`;
      return `${shown ?? "link"} (${host === undefined ? "unknown site" : defanged(host)})`;
    }
    if (bare !== undefined) {
      const trailing = TRAILING_PUNCTUATION.exec(bare)?.[0] ?? "";
      const address = trailing === "" ? bare : bare.slice(0, -trailing.length);
      const host = hostOf(address);
      return host !== undefined && allowed(host) ? whole : `link (${host === undefined ? "unknown site" : defanged(host)})${trailing}`;
    }
    const trailing = TRAILING_PUNCTUATION.exec(domain!)?.[0] ?? "";
    const address = trailing === "" ? domain! : domain!.slice(0, -trailing.length);
    const authority = address.split("/")[0]!.toLowerCase();
    const host = authority.split(":")[0]!;
    if (!(address.includes("/") || host.startsWith("www.") || LINKED_TOP_LEVEL_DOMAINS.has(host.split(".").at(-1)!))) return whole;
    return allowed(authority) ? whole : `link (${defanged(host.replace(/^www\./u, ""))})${trailing}`;
  });
}

const escapeText = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/**
 * What is left of the report after the scan is plain text Slack must show as it is: `&`, `<` and `>` are Slack's own control characters, so each is written as its
 * entity, except in the `<url|label>` links the scan kept on purpose. Nothing the report says can then be read by Slack as a mention, a group or a command.
 */
function escapeForSlack(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/<((?:https?:\/\/|mailto:)[^|>\s<]+)(?:\|([^>]*))?>/giu)) {
    out += escapeText(text.slice(last, match.index));
    out += `<${match[1]!.replace(/&/gu, "&amp;")}${match[2] === undefined ? "" : `|${escapeText(match[2])}`}>`;
    last = match.index + match[0].length;
  }
  return out + escapeText(text.slice(last));
}

export function prepareSlackReport(report: string, options: SlackReportOptions): PreparedSlackReport {
  const taskHost = hostOf(options.taskUrl);
  const domains = options.reportLinkDomains.map((domain) => domain.toLowerCase());
  const allowed = (host: string): boolean => host === taskHost
    || domains.some((domain) => host.split(":")[0] === domain || host.split(":")[0]!.endsWith(`.${domain}`));
  // Folded first (NFKC, invisible characters out), so a form written with fullwidth brackets is the form it will be read as before it is looked for; once more
  // after the mention strip, which folds again; and every `<`, `>` and `&` that is left is escaped, so nothing the folding makes live can reach Slack.
  const unmentioned = plainSlackForms(stripMentions(plainSlackForms(cleanText(report))).args as string);
  // S3: a mailto link is already flattened to its host here; any other address is hidden.
  const text = hideEmailAddresses(flattenLinks(unmentioned, allowed));
  const command = commentSignal(text, { allowMentions: false, labelPaths: [], extraCommandWords: options.extraCommandWords }).consequential
    || commentLines(text).some((line) => CHATOPS_PATTERNS.some((pattern) => pattern.test(line)));
  return command ? { kind: "link_only", text: `Report available in Rovara: ${options.taskUrl}` } : { kind: "text", text: escapeForSlack(text) };
}
