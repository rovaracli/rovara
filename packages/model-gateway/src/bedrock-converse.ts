// Rovara's AI on non-Claude Bedrock models (DEC 243c): the agent route speaks Anthropic Messages; these models are called through
// Bedrock's Converse / ConverseStream. This module translates the checked Anthropic request into a Converse body, a Converse answer
// back into an Anthropic message, and ConverseStream's event stream into Anthropic SSE (the meter's UsageCollector reads it as it
// reads Anthropic's). Text and client tools only: images, documents, thinking blocks and server tools are refused (free, before
// any hold). Everything is total over untrusted data; a malformed answer throws (the call is then treated as a broken stream).
import { record } from "./model-gateway-token.js";
import { EventStreamError, type EventStreamMessage } from "./bedrock-event-stream.js";

/** A non-Claude Bedrock model or system inference profile id (`<provider>.<model>` or `<geo>.<provider>.<model>`). */
export const BEDROCK_CONVERSE_ID = /^(?!global\.)(?!(?:(?:us|eu|apac|jp|au|ca)\.)?anthropic\.)(?:(?:us|eu|apac|jp|au|ca)\.)?[a-z][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9.:-]{0,100}$/u;
/** Sent for a tool result with no output (Converse refuses an empty one). */
export const EMPTY_TOOL_RESULT = "(no output)";
/** What a non-Claude call is held to when the price snapshot names no output limit for the model. */
export const CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

type Json = Record<string, unknown>;
const text = (v: unknown): v is string => typeof v === "string";

/** One Anthropic content block to Converse. undefined: a block Rovara's AI does not offer for these models. */
function block(value: unknown, role: "user" | "assistant"): Json | undefined {
  if (text(value)) return { text: value };
  const b = record(value);
  if (b === undefined) return undefined;
  if (b.type === "text" && text(b.text)) return { text: b.text };
  if (role === "assistant" && b.type === "tool_use" && text(b.id) && text(b.name) && record(b.input) !== undefined) return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
  if (role === "user" && b.type === "tool_result" && text(b.tool_use_id)) {
    const parts = b.content === undefined ? [] : text(b.content) ? [b.content] : Array.isArray(b.content) ? b.content : undefined;
    if (parts === undefined) return undefined;
    const content: Json[] = [];
    for (const part of parts) {
      const p = text(part) ? part : record(part)?.type === "text" && text(record(part)!.text) ? record(part)!.text as string : undefined;
      if (p === undefined) return undefined;
      // Converse refuses blank text: an empty part is left out.
      if (p !== "") content.push({ text: p });
    }
    // A silent tool (no output): Converse needs at least one non-blank content item in a tool result.
    return { toolResult: { toolUseId: b.tool_use_id, content: content.length === 0 ? [{ text: EMPTY_TOOL_RESULT }] : content, status: b.is_error === true ? "error" : "success" } };
  }
  return undefined;
}

/**
 * The checked Anthropic body (guard.ts) as a Converse request, with `maxTokens` the hold is sized from. undefined: something these
 * models are not offered with (refused before any hold). `thinking`, `output_config`, `metadata` and cache markers are dropped:
 * they shape Claude's answer only.
 */
export function toConverse(body: Json, maxTokens: number): Json | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  // Fields that change the answer's meaning and have no Converse form are refused, never dropped: structured output, and
  // "one tool call at a time" (dropping it could let the model make several).
  if (record(body.output_config)?.format !== undefined) return undefined;
  if (record(body.tool_choice)?.disable_parallel_tool_use === true) return undefined;
  const out: Json[] = [];
  for (const m of messages) {
    const message = record(m);
    const role = message?.role;
    if (message === undefined || (role !== "user" && role !== "assistant")) return undefined;
    const blocks = text(message.content) ? [message.content] : Array.isArray(message.content) ? message.content : undefined;
    if (blocks === undefined) return undefined;
    const content: Json[] = [];
    for (const each of blocks) {
      // An empty text block is dropped (Converse refuses blank text); anything else must translate.
      if (record(each)?.type === "text" && record(each)!.text === "") continue;
      const converted = block(each, role);
      if (converted === undefined) return undefined;
      content.push(converted);
    }
    if (content.length === 0) return undefined;
    out.push({ role, content });
  }
  const system = body.system === undefined ? [] : text(body.system) ? [body.system] : Array.isArray(body.system) ? body.system.map((s) => record(s)?.type === "text" && text(record(s)!.text) ? record(s)!.text : undefined) : [undefined];
  if (system.some((s) => !text(s))) return undefined;
  const inferenceConfig: Json = { maxTokens, ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}) };
  let toolConfig: Json | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools: Json[] = [];
    for (const t of body.tools) {
      const tool = record(t);
      if (tool === undefined || !text(tool.name) || record(tool.input_schema) === undefined || (tool.description !== undefined && !text(tool.description)) || tool.strict === true) return undefined;
      tools.push({ toolSpec: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: { json: tool.input_schema } } });
    }
    const choice = text(body.tool_choice) ? { type: body.tool_choice } : record(body.tool_choice);
    let toolChoice: Json | undefined;
    if (choice === undefined || choice.type === "auto") toolChoice = undefined;
    else if (choice.type === "any" || choice.type === "required") toolChoice = { any: {} };
    else if (choice.type === "tool" && text(choice.name)) toolChoice = { tool: { name: choice.name } };
    else return undefined; // "none" and anything else: not offered.
    toolConfig = { tools, ...(toolChoice === undefined ? {} : { toolChoice }) };
  } else if (body.tool_choice !== undefined && body.tool_choice !== null) return undefined;
  // Converse refuses tool blocks without a tool configuration (a turn that resends tool history with no tools): refused here, free.
  else if (out.some((m) => (m.content as Json[]).some((c) => c.toolUse !== undefined || c.toolResult !== undefined))) return undefined;
  return { messages: out, ...(system.length === 0 ? {} : { system: (system as string[]).map((s) => ({ text: s })) }), inferenceConfig, ...(toolConfig === undefined ? {} : { toolConfig }) };
}

const STOP: Readonly<Record<string, string>> = Object.freeze({ end_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", stop_sequence: "stop_sequence", model_context_window_exceeded: "model_context_window_exceeded" });
/** Converse's stop reason in Anthropic's words; a filtered or blocked answer is a refusal. */
export function anthropicStop(reason: unknown): string {
  return text(reason) ? STOP[reason] ?? (reason === "content_filtered" || reason === "guardrail_intervened" ? "refusal" : "end_turn") : "end_turn";
}
/** Converse usage in Anthropic's fields. Throws unless input and output are whole numbers (usage then can't be read: full hold). */
export function anthropicUsage(value: unknown): Json {
  const u = record(value);
  const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (u === undefined || !whole(u.inputTokens) || !whole(u.outputTokens)) throw new EventStreamError();
  const cacheRead = whole(u.cacheReadInputTokens) ? u.cacheReadInputTokens : 0;
  const cacheWrite = whole(u.cacheWriteInputTokens) ? u.cacheWriteInputTokens : 0;
  return { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
}

/** A Converse answer as an Anthropic message. Reasoning blocks are dropped; anything else unknown throws. */
export function fromConverse(answer: unknown, model: string, id: string): Json {
  const a = record(answer);
  const message = record(record(a?.output)?.message);
  if (a === undefined || message === undefined || !Array.isArray(message.content)) throw new EventStreamError();
  const content: Json[] = [];
  for (const c of message.content) {
    const b = record(c);
    if (b !== undefined && text(b.text)) content.push({ type: "text", text: b.text });
    else if (b !== undefined && record(b.toolUse) !== undefined) {
      const t = record(b.toolUse)!;
      if (!text(t.toolUseId) || !text(t.name)) throw new EventStreamError();
      content.push({ type: "tool_use", id: t.toolUseId, name: t.name, input: record(t.input) ?? {} });
    } else if (b !== undefined && b.reasoningContent !== undefined) continue;
    else throw new EventStreamError();
  }
  return { id, type: "message", role: "assistant", model, content, stop_reason: anthropicStop(a.stopReason), stop_sequence: null, usage: anthropicUsage(a.usage) };
}

/**
 * ConverseStream events to Anthropic SSE, in order. Converse sends usage last (metadata, after messageStop), so message_start carries
 * zero counts and the final message_delta carries the real ones (the UsageCollector takes both). Converse's block indexes are
 * renumbered from 0 over the blocks passed on (reasoning blocks are dropped). Every event is re-serialised as one line of JSON.
 */
export class ConverseStreamToSse {
  readonly #model: string; readonly #id: string;
  #started = false; #stopReason: string | undefined; #ended = false;
  readonly #open = new Map<number, number>(); readonly #dropped = new Set<number>(); #next = 0;
  constructor(model: string, id: string) { this.#model = model; this.#id = id; }
  #event(type: string, data: Json): Buffer { return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`, "utf8"); }
  convert(messages: readonly EventStreamMessage[]): Buffer {
    const out: Buffer[] = [];
    for (const message of messages) {
      if (message.headers[":message-type"] !== "event" || this.#ended) throw new EventStreamError();
      let p: Json | undefined;
      try { p = record(JSON.parse(message.payload.toString("utf8")) as unknown); } catch { throw new EventStreamError(); }
      if (p === undefined) throw new EventStreamError();
      const index = p.contentBlockIndex;
      const validIndex = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < 1_000;
      switch (message.headers[":event-type"]) {
        case "messageStart":
          if (this.#started) throw new EventStreamError();
          this.#started = true;
          out.push(this.#event("message_start", { message: { id: this.#id, type: "message", role: "assistant", model: this.#model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
          break;
        case "contentBlockStart": {
          const tool = record(record(p.start)?.toolUse);
          if (!this.#started || !validIndex || this.#open.has(index) || tool === undefined || !text(tool.toolUseId) || !text(tool.name)) throw new EventStreamError();
          const at = this.#next++; this.#open.set(index, at);
          out.push(this.#event("content_block_start", { index: at, content_block: { type: "tool_use", id: tool.toolUseId, name: tool.name, input: {} } }));
          break;
        }
        case "contentBlockDelta": {
          const delta = record(p.delta);
          if (!this.#started || !validIndex || delta === undefined) throw new EventStreamError();
          if (delta.reasoningContent !== undefined) { if (!this.#open.has(index)) this.#dropped.add(index); break; }
          if (this.#dropped.has(index)) throw new EventStreamError();
          if (text(delta.text)) {
            // Converse starts text blocks with their first delta.
            if (!this.#open.has(index)) { const at = this.#next++; this.#open.set(index, at); out.push(this.#event("content_block_start", { index: at, content_block: { type: "text", text: "" } })); }
            out.push(this.#event("content_block_delta", { index: this.#open.get(index)!, delta: { type: "text_delta", text: delta.text } }));
          } else if (text(record(delta.toolUse)?.input) && this.#open.has(index)) {
            out.push(this.#event("content_block_delta", { index: this.#open.get(index)!, delta: { type: "input_json_delta", partial_json: record(delta.toolUse)!.input } }));
          } else throw new EventStreamError();
          break;
        }
        case "contentBlockStop":
          if (!validIndex) throw new EventStreamError();
          if (this.#dropped.delete(index)) break;
          if (!this.#open.has(index)) throw new EventStreamError();
          out.push(this.#event("content_block_stop", { index: this.#open.get(index)! })); this.#open.delete(index);
          break;
        case "messageStop":
          if (!this.#started || this.#stopReason !== undefined) throw new EventStreamError();
          this.#stopReason = anthropicStop(p.stopReason);
          break;
        case "metadata":
          if (this.#stopReason === undefined) throw new EventStreamError();
          out.push(this.#event("message_delta", { delta: { stop_reason: this.#stopReason, stop_sequence: null }, usage: anthropicUsage(p.usage) }));
          out.push(this.#event("message_stop", {}));
          this.#ended = true;
          break;
        default: throw new EventStreamError();
      }
    }
    return Buffer.concat(out);
  }
}
