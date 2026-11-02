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

/** The most words either text may have for a word-by-word comparison (the table is words x words); more than this and the edit keeps no words. */
const DIFF_WORDS_MAX = 2_000;

/**
 * Per-editor rows: the words a person ADDED in an edit, from the text before and the text after, WORD BY WORD (a longest common subsequence of the words, so a one-word typo fix credits that one word and
 * not the sentence, line or title around it). The inserted runs are returned in order, separated by a space. It is how a person who edited someone else's text is credited with their own words only,
 * never with the author's.
 *
 * Fail closed: `previous` unknown gives nothing; nothing inserted gives nothing; and texts too long to compare word by word give nothing. The two texts must be in the SAME format (a source that sends the old
 * and the new text in different markups must not be compared: Jira's changelog gives both, in wiki markup).
 */
export function addedText(previous: string | undefined, next: string | undefined): string | undefined {
  if (previous === undefined || next === undefined) return undefined;
  const words = (text: string): string[] => text.split(/\s+/u).filter((word) => word !== "");
  // Words are compared without the punctuation around them and without case ("hand." is "hand"); what is returned is the word as the editor wrote it.
  const key = (word: string): string => { const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase(); return bare === "" ? word : bare; };
  const original = words(next);
  const before = words(previous).map(key);
  const after = original.map(key);
  if (before.length > DIFF_WORDS_MAX || after.length > DIFF_WORDS_MAX) return undefined;
  // lcs[i][j]: the length of the longest common run of words in before[i..] and after[j..].
  const width = after.length + 1;
  const lcs = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = before[i] === after[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const inserted: string[] = [];
  let i = 0;
  let j = 0;
  while (j < after.length) {
    if (i < before.length && before[i] === after[j]) { i += 1; j += 1; } else if (i < before.length && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) { i += 1; } else { inserted.push(original[j]!); j += 1; }
  }
  return inserted.length === 0 ? undefined : inserted.join(" ");
}
