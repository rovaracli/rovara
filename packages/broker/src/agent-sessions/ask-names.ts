// Live interaction fix round 2 (I6): replacing a member's names in the words an Ask stores. Pure.
//
// Matching is done on a "skeleton" of the text: NFKC-normalised, zero-width and soft-hyphen characters removed, accents stripped, look-alike Cyrillic and Greek letters folded to Latin, lower case,
// one code point per code point of the normalised text, so a match found in the skeleton is replaced at the same place in the text. Whitespace (including a line wrap) inside a name is
// any run of white space; the separators `-`, `_` and `.` may be missing ("SamOkafor", "sam-okafor"); "Last, First" is matched too; a name written with percent escapes ("Sam%20Okafor") is found by
// decoding a percent run and scrubbing what it says.
//
// What is NOT scrubbed, on purpose: a single word that is also a common word. A display name's first name alone ("Mark" in "mark the file") and a one-word display name are replaced only as a mention
// ("@mark") or inside the full name; the surname alone is treated the same. A handle, login, email or id (`handles`) is a specific identifier and is replaced wherever it stands as a whole word.
export interface NamedPerson {
  developerId: string;
  /** An erased person known only by their label tag (`p_xxxxxx`): their developer id is gone, so the tag is what their label is scrubbed by. */
  tag?: string | undefined;
  /** Display names ("Sam Okafor"). Matched in full, in either order, with or without separators; a single word of one is replaced only as an `@mention`. */
  names: readonly string[];
  /** Logins, emails, Slack and Linear ids: specific identifiers, replaced as whole words wherever they stand. */
  handles?: readonly string[] | undefined;
}

const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;
const WORD = "[\\p{L}\\p{N}_]";
const SEPARATORS = "[\\s\\-_.]*";

/** Look-alike letters of other scripts, folded to the Latin letter they imitate. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "ӏ": "l",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "χ": "x", "ε": "e", "η": "n", "μ": "u", "β": "b",
};

/** The text with compatibility forms folded and invisible characters removed. This is the form that is stored. */
export function normaliseWords(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "");
}

/** One lower-case, accent-free, look-alike-free code point for each code point of `normalised`. */
export function skeletonOf(normalised: string): string {
  return Array.from(normalised, (character) => {
    const lower = Array.from(character.toLowerCase())[0] ?? character;
    const base = Array.from(lower.normalize("NFD").replace(/\p{M}/gu, ""))[0] ?? lower;
    return CONFUSABLES[base] ?? base;
  }).join("");
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

interface Rule { pattern: RegExp; replacement: string }

function rulesFor(person: NamedPerson, replacement: string): Rule[] {
  const rules: Rule[] = [];
  const word = (body: string) => new RegExp(`(?<!${WORD})${body}(?!${WORD})`, "gu");
  for (const name of person.names) {
    const tokens = skeletonOf(normaliseWords(name)).split(/[\s\-_.,]+/u).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    const alternatives: string[] = [];
    if (tokens.length > 1) {
      alternatives.push(tokens.map(escapeRegex).join(SEPARATORS));
      // "Okafor, Sam" and "Okafor Sam"
      alternatives.push([...tokens].reverse().map(escapeRegex).join("[\\s,]+"));
    }
    if (alternatives.length > 0) rules.push({ pattern: word(`@?(?:${alternatives.join("|")})`), replacement });
    // A single word of the name (or a one-word name) is replaced only as an @mention.
    for (const token of tokens) if (token.length >= 2) rules.push({ pattern: new RegExp(`(?<!${WORD})@${escapeRegex(token)}(?!${WORD})`, "gu"), replacement });
  }
  for (const handle of person.handles ?? []) {
    const literal = skeletonOf(normaliseWords(handle)).trim().replace(/^@/u, "");
    if (literal.length >= 2) rules.push({ pattern: word(`@?${escapeRegex(literal)}`), replacement });
  }
  return rules;
}

/** Replaces every match of every rule in `text` once, longest match first at a place, never twice over the same characters. */
function replaceAll(text: string, rules: readonly Rule[]): string {
  const normalised = normaliseWords(text);
  const skeleton = skeletonOf(normalised);
  const matchable = skeleton.length === normalised.length ? skeleton : normalised.toLowerCase();
  const hits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const rule of rules) {
    for (const match of matchable.matchAll(rule.pattern)) {
      if (match[0].length > 0) hits.push({ start: match.index, end: match.index + match[0].length, replacement: rule.replacement });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "", at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue;
    out += normalised.slice(at, hit.start) + hit.replacement;
    at = hit.end;
  }
  return out + normalised.slice(at);
}

/**
 * The words with every known person's names replaced: by `person p_xxxxxx` (their label) for a member, by `@former-member` for an erased one. `labelOf` gives the replacement for a developer.
 */
export function scrubNames(text: string, people: readonly NamedPerson[], replacementOf: (developerId: string) => string): string {
  const rules = people.flatMap((person) => rulesFor(person, replacementOf(person.developerId)));
  if (rules.length === 0) return normaliseWords(text);
  // A name written with percent escapes ("Sam%20Okafor"): the URL-ish word that holds the escapes is decoded, and used only when what it says contains a name.
  const decoded = normaliseWords(text).replace(/[\p{L}\p{N}._~+-]*%[0-9A-Fa-f]{2}[\p{L}\p{N}._~%+-]*/gu, (word) => {
    let plain: string;
    try { plain = decodeURIComponent(word); } catch { return word; }
    const scrubbed = replaceAll(plain, rules);
    return scrubbed === normaliseWords(plain) ? word : scrubbed;
  });
  // "+" for a space in a form-encoded name ("Sam+Okafor") reads as a separator through the rules' white space; handled by trying the text with plus signs as spaces only for the matching run.
  const plusFixed = decoded.replace(/[\p{L}\p{N}]+(?:\+[\p{L}\p{N}]+)+/gu, (run) => {
    const scrubbed = replaceAll(run.replaceAll("+", " "), rules);
    return scrubbed === run.replaceAll("+", " ") ? run : scrubbed;
  });
  return replaceAll(plusFixed, rules);
}
