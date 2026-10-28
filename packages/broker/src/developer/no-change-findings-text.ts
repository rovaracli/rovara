// The words for a coding run that ended with no code change: what the agent found, for Slack. The findings are untrusted (a command's output and a model's words): they were redacted and bounded
// when they were built, and every line is made inert and redacted again here, so nothing in them can mention anyone, link anywhere or open a tag.
import { NO_CHANGE_CHOICES_LINE, NO_CHANGE_COMMANDS_HEADER, NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, NO_CHANGE_NO_CONCLUSION, noChangeFindingsFrom, type NoChangeFindings } from "@agentx/contracts";
import { inertLine } from "../rovara-code/inert-text.js";

/** One line of untrusted text for Slack: redacted and inert (`inertLine`), a `>` written as an entity so no line starts a quote, and a backtick made an apostrophe so no text opens or closes code. `&` and `<` are already entities. */
const slackLine = (text: string, max: number): string => inertLine(text, max).replaceAll(">", "&gt;").replaceAll("`", "'");

const OUTPUT_LINES_MAX = 8;
const OUTPUT_LINE_MAX = 200;
const CONCLUSION_LINE_MAX = 400;

/** The conclusion's own lines, each inert; a blank line between paragraphs stays. */
function conclusionLines(text: string): string[] {
  const lines = text.split("\n").map((line) => slackLine(line, CONCLUSION_LINE_MAX));
  return lines.filter((line, index) => line !== "" || (index > 0 && lines[index - 1] !== ""));
}

/** The findings as lines of a Slack message (no header, no choices): the agent's conclusion, then the commands it ran with what they printed. */
export function noChangeFindingsLines(raw: NoChangeFindings | undefined): string[] {
  const findings = noChangeFindingsFrom(raw);
  if (findings === undefined) return [];
  const lines: string[] = [...(findings.conclusion === undefined ? [NO_CHANGE_NO_CONCLUSION] : conclusionLines(findings.conclusion))];
  if (findings.commands.length > 0) {
    lines.push("", NO_CHANGE_COMMANDS_HEADER);
    if (findings.omitted !== undefined) lines.push(`(${String(findings.omitted)} earlier ${findings.omitted === 1 ? "command is" : "commands are"} not listed.)`);
    for (const item of findings.commands) {
      lines.push(`- \`${slackLine(item.command, 160)}\`${item.failed === true ? " (it failed)" : ""}`);
      const output = (item.output ?? "").split("\n").map((line) => slackLine(line, OUTPUT_LINE_MAX)).filter((line) => line !== "");
      for (const line of output.slice(0, OUTPUT_LINES_MAX)) lines.push(`>  ${line}`);
      if (output.length > OUTPUT_LINES_MAX) lines.push(">  …");
    }
  }
  return lines;
}

/** The whole message for the blocked stop: the header, what the agent found, and the choices. Without findings (an older worker) it says only that no change was needed. */
export function noCodeChangedText(raw: NoChangeFindings | undefined): string {
  const findings = noChangeFindingsFrom(raw);
  return [findings === undefined ? NO_CHANGE_NEEDED_LINE : NO_CHANGE_FOUND_HEADER, ...(findings === undefined ? [] : noChangeFindingsLines(findings)), "", NO_CHANGE_CHOICES_LINE].join("\n");
}
