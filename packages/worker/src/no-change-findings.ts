// What a coding run did, kept only to answer for it when the run ends with no code change: the commands the agent ran, what they printed, and the agent's last words. It reads the session's own
// tool events (nothing else is stored or asked of a model). The block it builds is redacted and bounded (`buildNoChangeFindings`) before it leaves the worker.
import { NO_CHANGE_FINDINGS_OMITTED_MAX, buildNoChangeFindings, type NoChangeFindings } from "@agentx/contracts";

/** The tools whose calls are told as "commands the agent ran": the shell and the tools that only read. A tool that writes is never listed. */
const LISTED_TOOLS: ReadonlySet<string> = new Set(["bash", "grep", "find", "ls", "read"]);
/** A read's text is the file itself, which is not a finding. */
const NO_OUTPUT_TOOLS: ReadonlySet<string> = new Set(["read"]);
/** The most calls held at once (the last ones); older ones are counted, not kept. */
const KEPT_CALLS = 60;
/** The most of one call's text held: a tool's output is already cut by the tool; this bounds a hostile one. */
const HELD_TEXT = 20_000;
const MARKER = /^AgentX result: (?:not )?done$/u;

interface Call { command: string; output: string; failed: boolean }

export class FindingsRecorder {
  private readonly calls: Call[] = [];
  private readonly open = new Map<string, Call>();
  private dropped = 0;
  private conclusion: string | undefined;

  /** Feed every session event. */
  observe(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const value = event as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown };
    const tool = typeof value.toolName === "string" ? value.toolName : undefined;
    const id = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (tool === undefined || !LISTED_TOOLS.has(tool)) return;
    if (value.type === "tool_execution_start") {
      const call: Call = { command: describe(tool, value.args), output: "", failed: false };
      this.calls.push(call);
      if (id !== undefined) this.open.set(id, call);
      if (this.calls.length > KEPT_CALLS) { this.calls.shift(); this.dropped += 1; }
      return;
    }
    if (value.type !== "tool_execution_end" || id === undefined) return;
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    call.failed = value.isError === true;
    if (!NO_OUTPUT_TOOLS.has(tool)) call.output = resultText(value.result).slice(0, HELD_TEXT);
  }

  /** The agent's last message text, as each assistant message ends (the last one is its conclusion; a message with no text clears it). */
  concludeWith(text: string | undefined): void {
    this.conclusion = text;
  }

  /** The block for the run's result: bounded and redacted. */
  build(): NoChangeFindings {
    const lines = (this.conclusion ?? "").split("\n");
    while (lines.length > 0 && (lines.at(-1)!.trim() === "" || MARKER.test(lines.at(-1)!.trim()))) lines.pop();
    const built = buildNoChangeFindings({ commands: this.calls, conclusion: lines.join("\n") });
    const omitted = Math.min((built.omitted ?? 0) + this.dropped, NO_CHANGE_FINDINGS_OMITTED_MAX);
    return { ...built, ...(omitted > 0 ? { omitted } : {}) };
  }
}

function describe(tool: string, args: unknown): string {
  const given = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
  if (tool === "bash") return typeof given.command === "string" ? given.command : "";
  const subject = [given.pattern, given.path].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  return `${tool} ${subject}`.trim();
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}
