// Does an agent step's report stand on anything? The worker records every tool call of a step, and when the step ends compares the report with what happened: tool
// failures, text that imitates tool calls, and the things the report cites (pull requests, commits, files, tool names) that neither a successful call returned nor
// the step's own request and earlier reports held. The answer is "grounded" or "unverified"; the broker never lets an unverified step count as a success.
//
// Deterministic and bounded: no model call, the report is read to GROUNDING_REPORT_SCAN_CHARS, at most MAX_CITATIONS things are checked and at most MAX_REASONS reasons
// are kept. A check that cannot be complete (more tool text than the recorder keeps) leaves the citations unchecked rather than blaming the agent for evidence it lost.
import { redactText, type AgentStepGrounding } from "@agentx/contracts";

/** The most of a report that is read; the worker cuts a report to 32 KiB before it is checked, so this is a backstop. */
export const GROUNDING_REPORT_SCAN_CHARS = 262_144;
/** The most of one call's answer the recorder keeps, and the most it keeps in all (past it the citations are not checked). */
export const GROUNDING_CALL_TEXT_CHARS = 65_536;
export const GROUNDING_TOTAL_TEXT_CHARS = 2_000_000;
const MAX_CITATIONS = 50;
const MAX_REASONS = 10;
const MAX_FAILURES = 10;
const MESSAGE_CHARS = 300;
/** The step's own tools: a choice of branch and a skill's text are not reads of the world, so their calls are not recorded. */
const OWN_TOOLS: ReadonlySet<string> = new Set(["choose_branch", "read_skill"]);

/** How a call ended: it answered (`ok`), failed (a thrown error, or a connector answer that says FAILED or UNKNOWN), is held for a person's approval, or never ended. */
export type RecordedCallOutcome = "ok" | "failed" | "held" | "pending";

export interface RecordedToolCall {
  tool: string;
  /** A tool of the broker's connectors (as against the read-only file tools and the step's own tools). */
  connector: boolean;
  args: unknown;
  outcome: RecordedCallOutcome;
  /** The answer's text, cut to GROUNDING_CALL_TEXT_CHARS. */
  text: string;
}

export interface GroundingInput {
  /** The step's report as it will be kept. */
  report: string;
  /** What the step was given: the request, its context and the earlier reports, as the model read them. */
  provided: string;
  calls: readonly RecordedToolCall[];
  /** The connector tools the step was offered: the name the model calls and the connector's own name for it. */
  connectorTools: ReadonlyArray<{ name: string; upstream: string }>;
  /** The recorder dropped some answers' text: what the report cites cannot be compared with the whole of what the tools returned. */
  evidenceTruncated?: boolean;
}

/** Collects a step's tool calls from the session's events (`tool_execution_start` and `tool_execution_end`). */
export class ToolCallRecorder {
  private readonly recorded: RecordedToolCall[] = [];
  private readonly open = new Map<string, RecordedToolCall>();
  private kept = 0;
  private cut = false;

  constructor(private readonly connectorNames: ReadonlySet<string>) {}

  /** True when an answer's text was cut or dropped to stay inside the bounds. */
  get truncated(): boolean {
    return this.cut;
  }

  calls(): RecordedToolCall[] {
    return this.recorded;
  }

  observe(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    const id = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const tool = typeof value.toolName === "string" ? value.toolName : undefined;
    if (tool !== undefined && OWN_TOOLS.has(tool)) return;
    if (value.type === "tool_execution_start" && tool !== undefined) {
      const call: RecordedToolCall = { tool, connector: this.connectorNames.has(tool), args: value.args, outcome: "pending", text: "" };
      this.recorded.push(call);
      if (id !== undefined) this.open.set(id, call);
      return;
    }
    if (value.type !== "tool_execution_end" || id === undefined) return;
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    const text = answerText(value.result);
    const room = Math.max(0, Math.min(GROUNDING_CALL_TEXT_CHARS, GROUNDING_TOTAL_TEXT_CHARS - this.kept));
    call.text = text.slice(0, room);
    this.kept += call.text.length;
    if (text.length > room) this.cut = true;
    // The status is read from the whole answer, not the kept part: a connector's answer is a small JSON object whose text may be long.
    call.outcome = value.isError === true ? "failed" : call.connector ? connectorOutcome(text) : "ok";
  }
}

function answerText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}

/** What a connector's answer (the broker's ConnectorResult as JSON) says. An answer that is not that JSON is taken as an answer. */
function connectorOutcome(text: string): RecordedCallOutcome {
  const parsed = parseObject(text);
  const status = parsed?.["status"];
  if (status === "FAILED" || status === "UNKNOWN") return "failed";
  if (status === "IN_PROGRESS") return "held";
  return "ok";
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The vendor's words in a connector answer (its `text`, with the reason when there is one), else the answer itself. */
function evidenceText(call: RecordedToolCall): string {
  const parsed = call.connector ? parseObject(call.text) : undefined;
  return typeof parsed?.["text"] === "string" ? parsed["text"] : call.text;
}

const oneLine = (text: string, max: number): string => {
  const flat = redactText(text).replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

function failureMessage(call: RecordedToolCall): string {
  const parsed = call.connector ? parseObject(call.text) : undefined;
  const said = typeof parsed?.["text"] === "string" && parsed["text"] !== "" ? parsed["text"] : typeof parsed?.["reason"] === "string" ? parsed["reason"] : call.text;
  return oneLine(said === "" ? "it gave no reason" : said, MESSAGE_CHARS);
}

const TOOL_CALL_TEXT = /<\/?(?:tool_calls?|tool_responses?|tool_results?|tool_use|function_calls?|invoke|antml:[a-z_]+)\b|<parameter\s+name=/iu;
const PULL_REQUEST = /(?:\bPR|\bpull request|\bpull-request)s?\s*#?\s*(\d{1,7})\b|\/pull\/(\d{1,7})\b/giu;
const COMMIT = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/giu;
const FILE_PATH = /(?<![\w./:@-])((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|py|go|rs|java|kt|rb|sh|sql|css|scss|html|toml|tf|swift|cpp|hpp|c|h))(?![\w/-])/gu;

function citations(report: string): { pullRequests: string[]; commits: string[]; files: string[] } {
  const found = { pullRequests: new Set<string>(), commits: new Set<string>(), files: new Set<string>() };
  const room = () => found.pullRequests.size + found.commits.size + found.files.size < MAX_CITATIONS;
  for (const match of report.matchAll(PULL_REQUEST)) {
    if (!room()) break;
    found.pullRequests.add(match[1] ?? match[2]!);
  }
  for (const match of report.matchAll(COMMIT)) {
    if (!room()) break;
    const token = match[0].toLowerCase();
    // A commit has both digits and letters; a word or a plain number (a run id, a count) is not one.
    if (/\d/u.test(token) && /[a-f]/u.test(token)) found.commits.add(token);
  }
  for (const match of report.matchAll(FILE_PATH)) {
    if (!room()) break;
    found.files.add(match[1]!);
  }
  return { pullRequests: [...found.pullRequests], commits: [...found.commits], files: [...found.files] };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Compares the report with what the step did. Undefined when the report stands and no tool failed (the result then carries nothing extra); otherwise the verdict, why, and
 * a summary of the tools, which the broker records on the run and shows with its result.
 */
export function checkGrounding(input: GroundingInput): AgentStepGrounding | undefined {
  const report = input.report.slice(0, GROUNDING_REPORT_SCAN_CHARS);
  const reasons: string[] = [];
  const note = (reason: string): void => { reasons.push(oneLine(reason, MESSAGE_CHARS)); };
  const failed = input.calls.filter((call) => call.outcome === "failed");
  const succeeded = input.calls.filter((call) => call.outcome === "ok");

  if (TOOL_CALL_TEXT.test(report)) {
    note("The report contains tool calls or tool answers written as text. A tool call exists only when the agent calls the tool, so none of it happened.");
  }

  // A connector tool whose latest call failed: what the agent read from it, if anything, is not the whole of what it needed.
  const latest = new Map<string, RecordedToolCall>();
  for (const call of input.calls) if (call.connector && call.outcome !== "pending") latest.set(call.tool, call);
  for (const [tool, call] of latest) if (call.outcome === "failed") note(`The tool ${tool} failed: ${failureMessage(call)}`);
  if (failed.length > 0 && succeeded.length === 0) note(`The agent made no successful tool call: all ${String(failed.length)} of its calls failed, so it read nothing.`);

  for (const { name, upstream } of input.connectorTools) {
    const mentioned = [...new Set([name, upstream])].filter((candidate) => candidate.length >= 4 && new RegExp(`(?<![\\w])${escapeRegExp(candidate)}(?![\\w])`, "u").test(report));
    if (mentioned.length === 0) continue;
    if (!input.calls.some((call) => call.tool === name && (call.outcome === "ok" || call.outcome === "held"))) {
      note(`The report names the tool ${mentioned[0]!}, but the agent did not call it.`);
    }
  }

  if (input.evidenceTruncated !== true) {
    const evidence = [input.provided, ...input.calls.filter((call) => call.outcome === "ok" || call.outcome === "held").map((call) => `${safeJson(call.args)}\n${evidenceText(call)}`)].join("\n").toLowerCase();
    const cited = citations(report);
    const commitsInEvidence = [...new Set([...evidence.matchAll(COMMIT)].map((match) => match[0]))];
    for (const number of cited.pullRequests) {
      if (!new RegExp(`(?:#|/pulls?/|number\\W{0,5}|pull request\\s+#?|pr\\s*#?)${number}(?!\\d)`, "u").test(evidence)) {
        note(`The report cites pull request #${number}, which no tool returned and the request did not contain.`);
      }
    }
    for (const commit of cited.commits) {
      if (!commitsInEvidence.some((known) => known.startsWith(commit) || (known.length >= 7 && commit.startsWith(known)))) {
        note(`The report cites commit ${commit}, which no tool returned and the request did not contain.`);
      }
    }
    for (const file of cited.files) {
      const lower = file.toLowerCase();
      if (!evidence.includes(lower) && !evidence.includes(lower.slice(lower.lastIndexOf("/") + 1))) {
        note(`The report cites the file ${file}, which no tool read or listed and the request did not contain.`);
      }
    }
  }

  const tools = {
    calls: input.calls.length,
    failed: failed.length,
    failures: failed.slice(0, MAX_FAILURES).map((call) => ({ tool: call.tool.slice(0, 100), message: failureMessage(call) })),
  };
  if (reasons.length === 0 && failed.length === 0) return undefined;
  const shown = reasons.slice(0, MAX_REASONS);
  if (reasons.length > MAX_REASONS) shown[MAX_REASONS - 1] = `${String(reasons.length - MAX_REASONS + 1)} more things in the report are not backed by a tool call.`;
  return { verdict: reasons.length === 0 ? "grounded" : "unverified", reasons: shown, tools };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
