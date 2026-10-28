// What a coding run found when it ended with no code change. The worker builds this block from the run's own record (the commands the agent ran, what they printed, and the
// agent's final answer) and the broker keeps it on the blocked workflow, so a read-only request ("run X and tell me", "check if we use Z") is answered instead of dead-ending.
// Everything in it is untrusted: a command's output and a model's words. Every string is redacted and bounded here, by the worker before it leaves and by the broker before it is stored or shown.
import { z } from "zod";
import { redactText } from "./redaction.js";

/** At most this many commands are kept (the last ones the agent ran); `omitted` counts the earlier ones. */
export const NO_CHANGE_FINDINGS_COMMANDS_MAX = 10;
/** Each command is one line of at most this many characters. */
export const NO_CHANGE_FINDINGS_COMMAND_MAX = 160;
/** Each command's output is cut to this many characters (its beginning and its end are kept). */
export const NO_CHANGE_FINDINGS_OUTPUT_MAX = 400;
/** The agent's own conclusion is cut to this many characters. */
export const NO_CHANGE_FINDINGS_CONCLUSION_MAX = 1500;
/** The commands, their outputs and the conclusion together never exceed this many characters. */
export const NO_CHANGE_FINDINGS_TOTAL_MAX = 5000;

/** The block reason of a coding run that finished with the code as it was (the worker's WORKFLOW_NO_CODE_CHANGE_MESSAGE). */
export const NO_CODE_CHANGED_REASON = "No code changes were needed, so there is nothing to check or open as a pull request. Close the task, or ask for a change.";
/** What that block reason said before its wording changed; a task stored blocked with it still reads as this stop. */
export const NO_CODE_CHANGED_LEGACY_REASONS: readonly string[] = ["Coding finished, but no code changed, so there is nothing to check or open as a pull request. Retry coding, or close the task."];

/** Whether a stored block reason is the no-code-change stop, in its present or earlier words. */
export function isNoCodeChangedReason(reason: string | undefined): boolean {
  return reason !== undefined && (reason === NO_CODE_CHANGED_REASON || NO_CODE_CHANGED_LEGACY_REASONS.includes(reason));
}

/** What the session reads as its step while the task waits on this stop. */
export const NO_CODE_CHANGED_STEP = "No code changes were needed";
/** The first line when no findings came with the result (an older worker sent none): what is known is that no change was needed. */
export const NO_CHANGE_NEEDED_LINE = "No code changes were needed.";
/** The first line of the message and of the task page's section. */
export const NO_CHANGE_FOUND_HEADER = "No code changes were needed. Here's what I found:";
/** Said in place of a conclusion when the agent ended its run without writing one. */
export const NO_CHANGE_NO_CONCLUSION = "The agent did not write a conclusion.";
/** Said above the commands. */
export const NO_CHANGE_COMMANDS_HEADER = "Commands the agent ran:";
/** The choices, said once: nothing was checked or opened, the task can be closed, and a change is asked for by replying and retrying coding. */
export const NO_CHANGE_CHOICES_LINE = "Nothing was checked and no pull request was opened. To ask for a change, reply here with what you want, then choose Retry coding. Or close the task.";
/** The same choices for a page that has no thread to reply in. */
export const NO_CHANGE_CHOICES_PAGE = "Nothing was checked and no pull request was opened. Close the task, or ask for a change by replying in the task's thread, then choosing Retry coding.";

const CommandSchema = z.object({
  command: z.string().min(1).max(NO_CHANGE_FINDINGS_COMMAND_MAX),
  output: z.string().max(NO_CHANGE_FINDINGS_OUTPUT_MAX).optional(),
  failed: z.boolean().optional(),
});

export const NoChangeFindingsSchema = z.object({
  commands: z.array(CommandSchema).max(NO_CHANGE_FINDINGS_COMMANDS_MAX),
  /** How many earlier commands are not listed. */
  omitted: z.number().int().min(1).max(100_000).optional(),
  conclusion: z.string().min(1).max(NO_CHANGE_FINDINGS_CONCLUSION_MAX).optional(),
}).refine((findings) => noChangeFindingsSize(findings) <= NO_CHANGE_FINDINGS_TOTAL_MAX, { message: "the findings are larger than they may be" });

export type NoChangeFindings = z.infer<typeof NoChangeFindingsSchema>;

/** How many characters the findings hold in all. */
export function noChangeFindingsSize(findings: { commands: ReadonlyArray<{ command: string; output?: string | undefined }>; conclusion?: string | undefined }): number {
  return findings.commands.reduce((sum, item) => sum + item.command.length + (item.output?.length ?? 0), 0) + (findings.conclusion?.length ?? 0);
}

/** The most raw text read from one string before it is redacted: a tool's own output is already cut by its tool; this keeps a hostile value from costing more than it should. */
const RAW_MAX = 100_000;

/** Redacted, control characters made spaces (a line break stays), blank runs squeezed, and cut to `max` characters counted in code points: the beginning only, or the beginning and the end. */
function cleaned(value: unknown, max: number, keep: "start" | "both"): string {
  if (typeof value !== "string" || max <= 0) return "";
  const bounded = value.length <= RAW_MAX ? value : `${value.slice(0, RAW_MAX / 2)}\n${value.slice(-RAW_MAX / 2)}`;
  const text = redactText(bounded).replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (keep === "start" || max < 8) return `${points.slice(0, max - 1).join("")}…`;
  const room = max - 3, head = Math.ceil(room / 2);
  return `${points.slice(0, head).join("")} … ${points.slice(points.length - (room - head)).join("")}`;
}

function cutLine(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

const oneLine = (value: unknown, max: number): string => cutLine(cleaned(value, RAW_MAX, "start").replace(/\s+/gu, " ").trim(), max);

export interface NoChangeFindingsInput {
  commands: ReadonlyArray<{ command?: unknown; output?: unknown; failed?: unknown }>;
  conclusion?: unknown;
}

/**
 * The findings block for a run's record: the last commands (at most ten, one line each), each with its output cut to its limit, and the agent's conclusion, all redacted, and the whole never over
 * NO_CHANGE_FINDINGS_TOTAL_MAX characters (the conclusion keeps its room first, then the later commands' outputs). The input is untrusted: anything that is not text is left out.
 */
export function buildNoChangeFindings(input: NoChangeFindingsInput): NoChangeFindings {
  // The input is untrusted at run time whatever its type says.
  const items: unknown[] = Array.isArray(input.commands) ? (input.commands as unknown[]) : [];
  const listed = items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const entry = item as { command?: unknown; output?: unknown; failed?: unknown };
    const command = oneLine(entry.command, NO_CHANGE_FINDINGS_COMMAND_MAX);
    return command === "" ? [] : [{ command, raw: entry.output, failed: entry.failed === true }];
  });
  const kept = listed.slice(-NO_CHANGE_FINDINGS_COMMANDS_MAX);
  const conclusion = cleaned(input.conclusion, NO_CHANGE_FINDINGS_CONCLUSION_MAX, "start");
  let room = NO_CHANGE_FINDINGS_TOTAL_MAX - conclusion.length - kept.reduce((sum, item) => sum + item.command.length, 0);
  // The last commands are the ones the conclusion rests on, so they are given room first.
  const outputs = new Array<string>(kept.length).fill("");
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const output = cleaned(kept[index]!.raw, Math.min(NO_CHANGE_FINDINGS_OUTPUT_MAX, Math.max(0, room)), "both");
    outputs[index] = output;
    room -= output.length;
  }
  const omitted = listed.length - kept.length;
  return {
    commands: kept.map((item, index) => ({ command: item.command, ...(outputs[index] === "" ? {} : { output: outputs[index]! }), ...(item.failed ? { failed: true } : {}) })),
    ...(omitted > 0 ? { omitted } : {}),
    ...(conclusion === "" ? {} : { conclusion }),
  };
}

/**
 * What a result or a stored workflow holds as findings, made safe again: read leniently (a malformed block is no findings, never an error), then rebuilt through `buildNoChangeFindings`, so
 * whatever a worker sent (an older build, a newer one, a hostile one) is redacted and bounded on this side too. Undefined only when there is no block at all (an older worker sent none); a block with no commands and no conclusion is kept, and says the agent wrote no conclusion.
 */
export function noChangeFindingsFrom(raw: unknown): NoChangeFindings | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as { commands?: unknown; omitted?: unknown; conclusion?: unknown };
  const commands = Array.isArray(value.commands) ? value.commands.slice(-NO_CHANGE_FINDINGS_COMMANDS_MAX) : [];
  const built = buildNoChangeFindings({ commands: commands as NoChangeFindingsInput["commands"], conclusion: value.conclusion });
  const earlier = typeof value.omitted === "number" && Number.isInteger(value.omitted) && value.omitted > 0 ? Math.min(value.omitted, 100_000) : 0;
  const omitted = earlier + (Array.isArray(value.commands) ? Math.max(0, value.commands.length - commands.length) : 0);
  return { ...built, ...(omitted > 0 ? { omitted } : {}) };
}
