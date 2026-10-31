// Text hygiene for every record row (design 4.4.1, step 3): hidden and control characters removed, secrets redacted, personal details scrubbed, fenced code
// replaced by a marker (code is referenced by link, not copied; a human edit keeps its hunks), then cut to 8 KB by bytes. Applied before anything is stored and
// before any model sees the text. The taps clean too; the pipeline cleans again, because it is the last step before storage.
import { RECORD_TEXT_MAX_BYTES, redactText } from "@agentx/contracts";

// Control, format (zero-width, bidi, tag characters) and private-use characters. Line breaks and tabs survive as plain whitespace.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu;
const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// 10 to 15 digits, with spaces, dots, dashes or brackets between groups, and an optional leading plus. Digit runs of a different shape are left alone.
const PHONE = /(?<![\w.])\+?\d(?:[\s().-]{0,2}\d){9,14}(?![\w])/g;
// An AWS account id: exactly twelve digits standing alone or inside an ARN.
const ACCOUNT_ID = /(?<![\d])\d{12}(?![\d])/g;

// A mention of a person by id: Slack `<@U123>` / `<@U123|name>`, Jira `[~accountid:abc]` / `[~name]`. A person erased later must not stay in other people's words, so the id (and the
// display name Slack puts after the bar) never reaches storage: every mention reads `@member`.
const MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>|\[~(?:accountid:)?[^\]\s]+\]/g;

export function scrubPersonalDetails(text: string): string {
  return text.replace(MENTION, "@member").replace(EMAIL, "[email]").replace(ACCOUNT_ID, "[account-id]").replace(PHONE, (match) => (/^\d{4}-\d{2}-\d{2}/.test(match) ? match : "[phone]"));
}

export function cutToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    out += character;
    bytes += size;
  }
  return out;
}

export interface CleanTextOptions {
  /** A human edit's hunks are the one place code is kept. */
  keepCode?: boolean;
}

/** The text as it may be stored, or undefined when nothing is left. */
export function cleanRecordText(text: string | undefined, options: CleanTextOptions = {}): string | undefined {
  if (text === undefined) return undefined;
  let clean = text.replace(HIDDEN, (character) => (character === "\n" || character === "\t" || character === "\r" ? character : ""));
  clean = clean.replace(/\r\n?/g, "\n");
  // Hidden characters are removed before redaction, so one cannot split a secret to slip through it.
  clean = redactText(clean);
  if (options.keepCode !== true) clean = clean.replace(FENCED_CODE, (_whole, lead: string) => `${lead}[code omitted]`);
  clean = scrubPersonalDetails(clean).trim();
  clean = cutToBytes(clean, RECORD_TEXT_MAX_BYTES).trim();
  return clean.length === 0 ? undefined : clean;
}
