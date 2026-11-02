// Shared helpers of the source taps. Nothing here logs, and nothing here throws on hostile input: bad input is dropped or cut.
import { redactText } from "@agentx/contracts";
import type { Retention, Scalar, SourceConfig, SourceConfigPort, CaptureModePort, SourceSystem, RecordDraft } from "./ports.js";

export const TEXT_MAX_BYTES = 8 * 1024;
const LINKS_MAX = 8;
const LINK_MAX_CHARS = 2048;

/**
 * A person's or system's words made safe to hand on: control and invisible characters (other than newline and tab) are removed, credentials are
 * redacted (the pipeline redacts again; `redactText` is idempotent), and the text is cut to `maxBytes` on a character boundary.
 */
export function cleanText(text: unknown, maxBytes = TEXT_MAX_BYTES): string | undefined {
  if (typeof text !== "string") return undefined;
  // Cut before redacting so a huge body costs little; the margin keeps a secret near the cut from being half-matched and left behind.
  const bounded = text.length > maxBytes * 4 ? text.slice(0, maxBytes * 4) : text;
  const stripped = bounded.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : ""));
  const redacted = redactText(stripped).trim();
  if (redacted === "") return undefined;
  return cutToBytes(redacted, maxBytes);
}

export function cutToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  // Do not leave half of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** A plain https permalink with no login in it; anything else is dropped. */
export function permalink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > LINK_MAX_CHARS) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function linksOf(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const link = permalink(value);
    if (link !== undefined && !out.includes(link)) out.push(link);
  }
  return out.slice(0, LINKS_MAX);
}

/** Only scalars survive, strings cut to 200 characters; an undefined value is left out. */
export function scalars(values: Record<string, Scalar | undefined | null>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 200).join("") : value;
  }
  return out;
}

export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const time = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}

/** Slack's `ts` ("1758657600.000200", seconds) as an ISO time. */
export function isoOfSlackTs(ts: unknown): string | undefined {
  if (typeof ts !== "string" || !/^\d{1,12}\.\d{1,9}$/.test(ts)) return undefined;
  return new Date(Math.floor(Number(ts) * 1000)).toISOString();
}

export interface GateDependencies {
  mode: CaptureModePort;
  config: SourceConfigPort;
}

/**
 * The first check of every tap: capture is on for the workspace, and the source row for this scope exists and is enabled. No row, a disabled row
 * or a failing read is "do not record" (fail closed); the caller's delivery is never failed by it.
 */
export async function gate(
  deps: GateDependencies,
  input: { workspaceId: string; project?: string; source: SourceSystem; scope: string },
): Promise<SourceConfig | undefined> {
  try {
    const config = await deps.config.get(input.workspaceId, input.source, input.scope);
    if (config === undefined || !config.enabled) return undefined;
    const project = input.project ?? config.project;
    if (!await deps.mode.captureOn(input.workspaceId, project)) return undefined;
    return config;
  } catch {
    return undefined;
  }
}

export function isExcluded(config: SourceConfig, ...ids: Array<string | undefined>): boolean {
  return ids.some((id) => id !== undefined && config.exclude.includes(id));
}

/** Retention A keeps no raw text anywhere. */
export function withRetention(draft: RecordDraft, retention: Retention): RecordDraft {
  if (retention !== "A") return { ...draft, retention };
  const rest = { ...draft, retention };
  delete rest.text;
  return rest;
}

/** Every tap's hard bound on what one delivery may write. */
export const MAX_DRAFTS_PER_DELIVERY = 50;

/** Scripts written without spaces between words: a run of these is cut into words with the platform's word segmenter (a dictionary-based break), not taken whole. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
let segmenter: Intl.Segmenter | undefined;
const wordSegmenter = (): Intl.Segmenter => (segmenter ??= new Intl.Segmenter("und", { granularity: "word" }));

/** The words of a text and where each sits in it: every run of letters, digits and marks (Unicode, NFC-normalised), with punctuation and whitespace as separators; unspaced scripts are cut by the word segmenter. */
function wordsOf(text: string): Array<{ key: string; start: number; end: number }> {
  const out: Array<{ key: string; start: number; end: number }> = [];
  for (const run of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const at = run.index;
    const piece = run[0];
    // A Jira heading marker (`h2.`) is markup, not a word.
    if (/^h[1-6]$/iu.test(piece) && text[at + piece.length] === ".") continue;
    if (!UNSPACED.test(piece)) { out.push({ key: piece.toLowerCase(), start: at, end: at + piece.length }); continue; }
    for (const segment of wordSegmenter().segment(piece)) {
      if (segment.isWordLike === true) out.push({ key: segment.segment.toLowerCase(), start: at + segment.index, end: at + segment.index + segment.segment.length });
    }
  }
  return out;
}

/**
 * Per-editor rows: the words a person ADDED in an edit, from the text before and the text after. A word counts as added only when the earlier text has no more of it than the new text does (a COUNT of each word, not
 * a position), so a block of text that was only moved adds nothing, and a typo fix adds just the one changed word. A word is a run of letters and digits (NFC-normalised, any script; punctuation and whitespace
 * only separate words, so `Priya,Sam`, `Priya, Sam`, `well-known`, `well known` and `foo/bar` are the same words), and a script written without spaces (Chinese, Japanese, Thai...) is cut into words by the word
 * segmenter, so a one-character fix there credits one word, not the paragraph. Link and markup syntax is taken away first: `[Priya](http://x.y/z)` is the word "Priya" (which was there) and the address (which is the
 * editor's); a heading, list or emphasis marker is no word. Words are compared without case. What is returned is the editor's own text for the new words: neighbouring new words come back as written (with the
 * punctuation between them), separate runs are joined by a space.
 *
 * Fail closed: `previous` unknown gives nothing; nothing added gives nothing. The two texts must be in the SAME format (a source that sends the old and the new text in different markups must not be compared:
 * Jira's changelog gives both, in wiki markup).
 */
export function addedText(previous: string | undefined, next: string | undefined): string | undefined {
  if (previous === undefined || next === undefined) return undefined;
  const plain = (text: string): string => text
    .replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/gu, "$1 $2")
    .replace(/\[([^\]|]*)\|([^\]]*)\]/gu, "$1 $2")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gisu, "$2 $1")
    .normalize("NFC");
  const before = plain(previous);
  const after = plain(next);
  const remaining = new Map<string, number>();
  for (const { key } of wordsOf(before)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const runs: string[] = [];
  let start = -1;
  let end = -1;
  let last = -1;
  const words = wordsOf(after);
  words.forEach((word, index) => {
    const left = remaining.get(word.key) ?? 0;
    if (left > 0) { remaining.set(word.key, left - 1); return; }
    // A new word next to the previous new word (nothing old between them) continues the run.
    if (start >= 0 && last === index - 1) end = word.end; else { if (start >= 0) runs.push(after.slice(start, end)); start = word.start; end = word.end; }
    last = index;
  });
  if (start >= 0) runs.push(after.slice(start, end));
  return runs.length === 0 ? undefined : runs.join(" ");
}
