// m1 (review): text the MODEL writes is scrubbed like the text of a source. The stubs (events.ts, transcript.ts) stop a source's own words reaching the event log, but a
// model, or injected source text that tells it to, can copy a `citations_only` or Slack source word for word into its answer, its plan, its findings or its summaries, and
// those are stored where the owner reads them. So the worker remembers what each source returned during the stage and, before anything is sent or saved, replaces any run of
// RUN_WORDS or more words that appears word for word in a source's text. Reasoning ("thinking") blocks are not stored at all in a stage that read a source. A short quote
// (a few words, an id, a title) is not touched: this stops copying the source out, not citing it.
import { stripHiddenCharacters } from "@agentx/contracts";
import type { EventBatchSink } from "../events.js";
import type { ArtifactSink } from "../artifacts.js";

export const RUN_WORDS = 20;
export const REMOVED = "[text from a source removed]";

const word = (raw: string): string => raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// ME-17: text the model writes is often JSON (the Understand artifact, a JSON message), and JSON hides a copied run from a plain word match. A line break inside a string is the two characters
// `\n`, which glue the last word of one line to the first of the next ("papa\nquebec"); a run that starts right after a key sits against `{"summary":"`. So, before words are cut out, the
// escapes that stand for white space (`\n`, `\r`, `\t`, a `\u000a`-style break, an escaped `"` or `/`, however many backslashes a nested encoding put in front) and the characters that only
// structure JSON (`{ } [ ] " : ,`) are read as spaces. The view is as long as the text, so a range found in it is cut out of the original text, and what is cut never ends inside an escape:
// the JSON that comes back still parses. The same view is used for the source text and the model's text, so a source that itself came back as JSON matches too.
// Text that parses as JSON is redacted by walking the parsed value instead of cutting the text: a run inside one string is cut out of that string; a run that spans several strings
// (array elements, object values) replaces each string it touches in full, so the structure survives. A run that spans object KEYS is not caught (keys are not read): best effort.
const JSON_WHITESPACE_CODES = "0009|000[aAbBcCdD]|0020|0085|00[aA]0|1680|200[0-9aA]|202[89]|202[fF]|205[fF]|3000";
const JSON_NOISE = new RegExp(`(?<!\\\\)\\\\+(?:[nrt"/]|u(?:${JSON_WHITESPACE_CODES}))|[{}\\[\\]":,]`, "gu");
const jsonView = (text: string): string => text.replace(JSON_NOISE, (match) => " ".repeat(match.length));

export interface SourceTextGuard {
  remember(text: string): void;
  /** Whether a source has been read yet; until then nothing is changed. */
  active(): boolean;
  redact(text: string): string;
  /** `value` with every string redacted and every reasoning block dropped, at any depth. The same object comes back when nothing changed. */
  scrub<T>(value: T): T;
}

export function createSourceTextGuard(runWords = RUN_WORDS): SourceTextGuard {
  const shingles = new Set<string>();
  const normalised = (text: string): string[] => (jsonView(stripHiddenCharacters(text).text).match(/\S+/gu) ?? []).map(word).filter((w) => w !== "");
  const guard: SourceTextGuard = {
    remember(text) {
      const words = normalised(text);
      for (let i = 0; i + runWords <= words.length; i += 1) shingles.add(words.slice(i, i + runWords).join(" "));
    },
    active: () => shingles.size > 0,
    redact(text) {
      return redactAt(text, 0);
    },
    scrub<T>(value: T): T {
      return scrubValue(value);
    },
  };

  /** Cuts every run out of the text itself. */
  function cutRuns(text: string): string {
      const tokens = [...jsonView(text).matchAll(/\S+/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length, w: word(m[0]) })).filter((t) => t.w !== "");
      const ranges: Array<[number, number]> = [];
      for (let i = 0; i + runWords <= tokens.length; i += 1) {
        if (shingles.has(tokens.slice(i, i + runWords).map((t) => t.w).join(" "))) ranges.push([tokens[i]!.start, tokens[i + runWords - 1]!.end]);
      }
      if (ranges.length === 0) return text;
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
      }
      let out = "";
      let at = 0;
      for (const [start, end] of merged) { out += text.slice(at, start) + REMOVED; at = end; }
      return out + text.slice(at);
  }

  const MAX_JSON_DEPTH = 64;
  const MAX_NESTED_JSON = 4;
  /** The strings of a parsed JSON value in document order (keys are not read); undefined when it nests too deeply to walk. */
  function leavesOf(value: unknown, into: string[], depth: number): boolean {
    if (depth > MAX_JSON_DEPTH) return false;
    if (typeof value === "string") { into.push(value); return true; }
    if (Array.isArray(value)) return value.every((item) => leavesOf(item, into, depth + 1));
    if (typeof value === "object" && value !== null) return Object.values(value as Record<string, unknown>).every((item) => leavesOf(item, into, depth + 1));
    return true;
  }
  function mapLeaves(value: unknown, replace: (leaf: string) => string): unknown {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map((item) => mapLeaves(item, replace));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mapLeaves(item, replace)]));
    return value;
  }

  /**
   * Text that parses as JSON is redacted by walking the parsed value, so the structure always survives: a run inside one string is cut out of that string; a run that spans several
   * strings replaces each of them in full. Returns undefined when the text is not JSON (or is too deeply nested to walk), and the caller cuts the text itself.
   */
  function redactJson(text: string, depth: number): string | undefined {
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return undefined; }
    if (typeof parsed !== "object" && typeof parsed !== "string") return undefined;
    if (parsed === null) return undefined;
    const leaves: string[] = [];
    if (!leavesOf(parsed, leaves, 0)) return undefined;
    // Runs over the words of all the strings in order: a window that starts in one string and ends in another touches both.
    const words: string[] = [];
    const leafOfWord: number[] = [];
    leaves.forEach((leaf, index) => { for (const w of normalised(leaf)) { words.push(w); leafOfWord.push(index); } });
    const whole = new Set<number>();
    for (let i = 0; i + runWords <= words.length; i += 1) {
      if (!shingles.has(words.slice(i, i + runWords).join(" "))) continue;
      if (leafOfWord[i] === leafOfWord[i + runWords - 1]) continue;
      for (let k = i; k < i + runWords; k += 1) whole.add(leafOfWord[k]!);
    }
    let index = 0;
    let changed = false;
    const next = mapLeaves(parsed, (leaf) => {
      const own = index;
      index += 1;
      const out = whole.has(own) ? REMOVED : redactAt(leaf, depth + 1);
      if (out !== leaf) changed = true;
      return out;
    });
    // JSON with nothing to remove comes back exactly as it was. (It is not cut as text either: a run that only shows across object keys is not caught, and cutting it would break the JSON.)
    if (!changed) return text;
    const indent = /^\s*[[{]\s*\n([ \t]+)/u.exec(text)?.[1];
    return JSON.stringify(next, null, indent);
  }

  function redactAt(text: string, depth: number): string {
    if (shingles.size === 0 || text.length < runWords * 2) return text;
    const viaJson = depth < MAX_NESTED_JSON && /^\s*["[{]/u.test(text) ? redactJson(text, depth) : undefined;
    if (viaJson !== undefined) return viaJson;
    // Not JSON (a message with prose around it, a document that was cut off): cut the runs out of the text itself.
    return cutRuns(text);
  }

  function scrubValue<T>(value: T): T {
      if (shingles.size === 0) return value;
      const walk = (entry: unknown, depth: number): unknown => {
        if (depth > 12) return entry;
        if (typeof entry === "string") return guard.redact(entry);
        if (Array.isArray(entry)) {
          let changed = false;
          const out = entry.filter((item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === "thinking")).map((item) => { const next = walk(item, depth + 1); if (next !== item) changed = true; return next; });
          return changed || out.length !== entry.length ? out : entry;
        }
        if (typeof entry === "object" && entry !== null) {
          let changed = false;
          const out: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
            // A reasoning block's own text field, and a provider's raw signature of it, are not stored.
            if ((entry as { type?: unknown }).type === "thinking" && (key === "thinking" || key === "thinkingSignature")) { changed = true; continue; }
            const next = walk(item, depth + 1);
            if (next !== item) changed = true;
            out[key] = next;
          }
          return changed ? out : entry;
        }
        return entry;
      };
      return walk(value, 0) as T;
  }
  return guard;
}

/** The event sink with the guard applied to every event. The guard is looked up per batch: it exists only once the stage has read a source. */
export function guardEventSink(sink: EventBatchSink, guard: () => SourceTextGuard | undefined): EventBatchSink {
  return async (batch) => { const active = guard(); return sink(active === undefined ? batch : active.scrub(batch)); };
}

export function guardArtifactSink(sink: ArtifactSink, guard: () => SourceTextGuard | undefined): ArtifactSink {
  return async (artifact) => {
    const active = guard();
    return sink(active === undefined || typeof (artifact as { content?: unknown }).content !== "string" ? artifact : { ...artifact, content: active.redact((artifact as { content: string }).content) });
  };
}
