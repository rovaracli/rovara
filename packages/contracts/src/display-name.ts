/** The Slack service and the broker both clean requester names with this, so their limits cannot drift apart. */
export const DISPLAY_NAME_MAX_CODE_POINTS = 80;
/** Broker header limit. 80 code points encode to at most 960 characters (12 per four-byte code point). */
export const DISPLAY_NAME_MAX_ENCODED_LENGTH = 1024;

// Control characters plus the zero-width and bidi format characters; U+200C and U+200D (ZWNJ, ZWJ) stay because scripts and emoji sequences need them.
const INVISIBLE = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A printable display name of at most 80 code points, cut only between whole character clusters, or undefined when nothing is left. */
export function cleanDisplayName(name: string): string | undefined {
  const clean = name.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  let result = "";
  let length = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const size = Array.from(segment).length;
    if (length + size > DISPLAY_NAME_MAX_CODE_POINTS) break;
    result += segment;
    length += size;
  }
  result = result.trimEnd();
  return result.length > 0 ? result : undefined;
}

/**
 * Text as a GFM code span, which GitHub renders literally: no mention, link, autolink, HTML or
 * issue reference. Per CommonMark the fence is one backtick longer than the text's longest
 * backtick run, padded with a space when the text starts or ends with a backtick. The broker marks
 * names in pull requests and TASK_BUSY with it, and the MCP server marks channel turns' authors.
 */
export function inertName(name: string): string {
  const longestRun = Math.max(0, ...(name.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
  return `${fence}${pad}${name}${pad}${fence}`;
}

/**
 * An email address anywhere in a text: a local part, an @, a domain with a dot. Deliberately wide: a false match only removes a word from a name.
 * The source is shared (the broker's pull request texts build their global matcher from it) so the two rules cannot drift apart.
 */
export const EMAIL_ADDRESS_SOURCE = "[^\\s@<>()[\\]{},;:\"'`]+@[^\\s@<>()[\\]{},;:\"'`]+\\.[^\\s@<>()[\\]{},;:\"'`]+";

/** Whether the text holds an email address. */
export function containsEmailAddress(text: string): boolean {
  // Stored records are read through this, and an old or partial one may have no text at all.
  if (typeof text !== "string") return false;
  const matcher = new RegExp(EMAIL_ADDRESS_SOURCE, "u");
  // Compatibility forms count too: a fullwidth "＠" or a fullwidth domain is the same address to a person reading it.
  return matcher.test(text) || matcher.test(text.normalize("NFKC"));
}

/** The text with every email address taken out, and the empty brackets and spaces they leave tidied away. */
export function withoutEmailAddresses(text: string): string {
  const raw = new RegExp(EMAIL_ADDRESS_SOURCE, "u").test(text);
  return (raw ? text : text.normalize("NFKC")).replace(new RegExp(EMAIL_ADDRESS_SOURCE, "gu"), " ").replace(/<\s*>|\(\s*\)|\[\s*\]/gu, " ").replace(/<\s*|\s*>/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * A person's name as others may see it (release 0.4.16): `cleanDisplayName`, and when the name holds an email address, the name without it; undefined when
 * nothing with a letter or a number is left (the sign-in email-code names a person by their address). Callers show a placeholder for undefined.
 */
export function emailSafeName(name: string): string | undefined {
  const cleaned = cleanDisplayName(name);
  if (cleaned === undefined || !containsEmailAddress(cleaned)) return cleaned;
  const stripped = withoutEmailAddresses(cleaned);
  return /[\p{L}\p{N}]/u.test(stripped) ? cleanDisplayName(stripped) : undefined;
}

/** The placeholder name of a person with no real name: "Member" and eight characters of a hash of their id (the broker makes it; `isPlaceholderDisplayName` knows its shape). */
const PLACEHOLDER_DISPLAY_NAME = /^Member [0-9a-f]{4,8}$/u;
/** Every spelling of that shape, whatever the case or spacing: no person or provider may use one as a name, so nobody reads as another person's placeholder. */
const RESERVED_DISPLAY_NAME = /^member\s+[0-9a-f]{4,8}$/iu;

/** Whether the name has the shape of a placeholder, which is reserved: a chosen name or a provider's name of this shape is refused or ignored. */
export function isReservedDisplayName(name: string): boolean {
  return RESERVED_DISPLAY_NAME.test(name.trim());
}

/** Whether the name is a placeholder, not a name a person or a sign-in provider gave. */
export function isPlaceholderDisplayName(name: string): boolean {
  return PLACEHOLDER_DISPLAY_NAME.test(name);
}
