// The words for a coding run that ended with no code change: what the agent found, for Slack. The findings are untrusted (a command's output and a model's words): they were redacted and bounded
// when they were built, and every line is made inert and redacted again here, so nothing in them can mention anyone, link anywhere or open a tag.
import { NO_CHANGE_CHOICES_LINE, NO_CHANGE_COMMANDS_HEADER, NO_CHANGE_DETAILS_LABEL, NO_CHANGE_FULL_OUTPUT_LABEL, NO_CHANGE_VALUE_HIDDEN, NO_CHANGE_NO_CONCLUSION_LEAD, maskSecretValues, NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, noChangeFindingsFrom, type NoChangeFindings } from "@agentx/contracts";
import { inertLine } from "../rovara-code/inert-text.js";

/** One line of untrusted text for Slack: redacted and inert (`inertLine`), a `>` written as an entity so no line starts a quote, and a backtick made an apostrophe so no text opens or closes code. `&` and `<` are already entities. */
const slackLine = (text: string, max: number): string => inertLine(text, max).replaceAll(">", "&gt;").replaceAll("`", "'");

const CONCLUSION_LINE_MAX = 400;

/**
 * What a Slack thread must never carry, whoever can read it: on top of the page's masking, every `NAME=value` (whatever the name, `export X=…` and an inline `X=… cmd` too) and every `NAME: value`
 * whose name reads as a variable has its value hidden, a long opaque run (32 or more hex characters, or 24 or more letters, digits, `_` and `-` that mix letters with digits) is hidden, and so is the word
 * after "password is", "token is" or "key is".
 */
export function maskForSlack(text: string): string {
  return maskSecretValues(text, "any-name")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/gu, (run) => (/^[0-9a-fA-F]{32,}$/u.test(run) || (/[A-Za-z]/u.test(run) && /[0-9]/u.test(run)) ? NO_CHANGE_VALUE_HIDDEN : run))
    .replace(/\b((?:password|passwd|passphrase|token|secret|key)s?[ \t]+(?:is|was)[ \t]+)(["'`]?)[^\s"'`]+/giu, (_whole, lead: string, quote: string) => `${lead}${quote}${NO_CHANGE_VALUE_HIDDEN}`);
}

/** The conclusion's own lines, each masked for Slack and inert; a blank line between paragraphs stays. */
function conclusionLines(text: string): string[] {
  const lines = maskForSlack(text).split("\n").map((line) => slackLine(line, CONCLUSION_LINE_MAX));
  return lines.filter((line, index) => line !== "" || (index > 0 && lines[index - 1] !== ""));
}

/** A link in Slack text: the address escaped as Slack asks, and a plain label. */
const slackLink = (url: string, label: string): string => `<${url.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}|${label}>`;

/**
 * The whole message for the blocked stop, leading with what the agent found:
 *   No code changes were needed. Here's what I found: <the agent's conclusion>
 *   Commands I ran: <the commands> · Full output on the task page: <link>
 *   <what was not done, and the two ways on>
 * A Slack thread can be read by people who cannot see the task, and a command's output can hold what the agent read from the environment or a file, so NO output is posted here: the task
 * page, which checks who may see the task, shows them. With no conclusion the middle lines become one that points to the page. Without findings (an older worker) it says only that no change was needed.
 */
export function noCodeChangedText(raw: NoChangeFindings | undefined, taskPageUrl?: string): string {
  const findings = noChangeFindingsFrom(raw);
  if (findings === undefined) return [NO_CHANGE_NEEDED_LINE, NO_CHANGE_CHOICES_LINE].join("\n");
  const page = taskPageUrl === undefined ? undefined : slackLink(taskPageUrl, "task page");
  if (findings.conclusion === undefined) {
    return [`${NO_CHANGE_NO_CONCLUSION_LEAD} see what it ran on the task page${page === undefined ? "." : `: ${page}`}`, NO_CHANGE_CHOICES_LINE].join("\n");
  }
  const [first = "", ...rest] = conclusionLines(findings.conclusion);
  const lines = [`${NO_CHANGE_FOUND_HEADER} ${first}`.trimEnd(), ...rest];
  if (findings.commands.length > 0) {
    const listed = findings.commands.map((item) => `\`${slackLine(maskForSlack(item.command), 160)}\`${item.failed === true ? " (it failed)" : ""}`).join(", ");
    const earlier = findings.omitted === undefined ? "" : ` (and ${String(findings.omitted)} earlier ${findings.omitted === 1 ? "one" : "ones"})`;
    lines.push(`${NO_CHANGE_COMMANDS_HEADER} ${listed}${earlier}${page === undefined ? "" : ` · ${NO_CHANGE_FULL_OUTPUT_LABEL} ${page}`}`);
  } else if (page !== undefined) {
    // No commands to list: the page link is still given.
    lines.push(`${NO_CHANGE_DETAILS_LABEL} ${page}`);
  }
  return [...lines, NO_CHANGE_CHOICES_LINE].join("\n");
}
