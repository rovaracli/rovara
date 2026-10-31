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
  const normalised = (text: string): string[] => (stripHiddenCharacters(text).text.match(/\S+/gu) ?? []).map(word).filter((w) => w !== "");
  const guard: SourceTextGuard = {
    remember(text) {
      const words = normalised(text);
      for (let i = 0; i + runWords <= words.length; i += 1) shingles.add(words.slice(i, i + runWords).join(" "));
    },
    active: () => shingles.size > 0,
    redact(text) {
      if (shingles.size === 0 || text.length < runWords * 2) return text;
      const tokens = [...text.matchAll(/\S+/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length, w: word(m[0]) })).filter((t) => t.w !== "");
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
    },
    scrub<T>(value: T): T {
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
    },
  };
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
