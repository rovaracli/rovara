// packages/contracts/src/comment-commands.ts
// A comment can carry a command (R1-1). Many repositories merge, deploy or run workflows from comments
// (`bors r+`, `@mergifyio queue`, `/deploy production`, Atlantis), and those bots check only that the
// commenter has write access, which the Rovara GitHub App's comments pass. So an agent's comment, review,
// issue text or label is a write that can merge, even though no merge tool is granted. These pure
// functions decide whether a write is *consequential* (it needs a person) and strip @-mentions from it.
//
// Posture: when unsure, treat the text as a command. A false positive costs a person a click; a false
// negative lets an agent merge or deploy. Nothing here reads the network or the repository.
import { agentXError } from "./errors.js";

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

/** Unicode category Cf: zero-width, bidi and tag characters (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF ...). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Invisible characters that are not Cf: variation selectors, the combining grapheme joiner, Hangul fillers ... */
const IGNORABLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;
const COMBINING_MARKS = /\p{M}/gu;
/** Spaces of every kind, and the C0 controls that Python-style `split()` treats as spaces. */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const SPACE_LIKE = /[\p{Zs}\t\v\f\u001c-\u001f]/gu;
/** Other control characters, which carry no text; U+0085 stays because it separates lines. */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const OTHER_CONTROLS = /[\u0000-\u0008\u000e-\u001b\u007f-\u0084\u0086-\u009f]/gu;
/** The line separators: LF, CR, U+2028, U+2029 and U+0085. */
const LINE_SEPARATORS = /[\n\r\u2028\u2029\u0085]/u;

/**
 * The text that is SENT: NFKC with the Cf characters removed. Visible characters are kept (a Cyrillic
 * letter stays Cyrillic), so an approval and the vendor call carry exactly what was checked. NFKC maps
 * full-width forms, circled and mathematical letters, ligatures and special spaces to their plain form.
 */
export function cleanText(text: string): string {
  return text.replace(FORMAT_CHARACTERS, "").normalize("NFKC").replace(FORMAT_CHARACTERS, "");
}

function characterRun(ascii: string, characters: string): Array<[string, string]> {
  return Array.from(characters, (character): [string, string] => [character, ascii]);
}

function digitRun(zero: number): Array<[string, string]> {
  return Array.from({ length: 10 }, (_, value): [string, string] => [String.fromCodePoint(zero + value), String(value)]);
}

/**
 * Look-alike characters folded to the ASCII they imitate, applied AFTER NFKC/NFKD (so full-width,
 * mathematical, circled and ligature forms are already plain, and accents are already gone). The target
 * is lowercase for letters. Coverage, by design explicit rather than the full Unicode confusables file:
 *  - Cyrillic and Greek letters that look like Latin ones (capitals and small letters), including the
 *    ones that look like a letter only in italic or small-capital form (к м н т в г);
 *  - Latin small capitals and IPA letters (ᴀ ʙ ᴄ ... ɑ ɡ ı ȷ) and a few barred or stroked letters (ø đ ł ħ ŧ);
 *  - a few Armenian and Cyrillic extension letters (ո օ ս ү ѵ ѡ);
 *  - decimal digits of the Arabic-Indic, Devanagari, Thai and other scripts, to 0-9;
 *  - the slash look-alikes ∕ ⁄ ⧸ ╱ ⟋ ᜵ Ⳇ and the at-sign look-alikes ＠ ﹫ (NFKC already maps both).
 * Not covered: letters that look like digits (O, l), and the open-ended tail of Unicode confusables. Those
 * would need a bot to read them as a command, which no bot does; see the plan's accepted residual risks.
 */
export const CONFUSABLE_FOLD: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...characterRun("a", "аАαΑɑᴀ"), ...characterRun("b", "βΒВвʙ"), ...characterRun("c", "сСϲϹᴄ"), ...characterRun("d", "ԁԀᴅđ"),
  ...characterRun("e", "еЕεΕᴇ"), ...characterRun("f", "ꜰ"), ...characterRun("g", "ɡɢԍ"), ...characterRun("h", "һҺнНΗʜħ"),
  ...characterRun("i", "іІιΙɪı"), ...characterRun("j", "јЈᴊȷ"), ...characterRun("k", "кКκΚᴋ"), ...characterRun("l", "ӏӀʟł"),
  ...characterRun("m", "мМΜᴍ"), ...characterRun("n", "ɴΝո"), ...characterRun("o", "оОοΟᴏøօՕ"), ...characterRun("p", "рРρΡᴘ"),
  ...characterRun("q", "ԛԚ"), ...characterRun("r", "ʀг"), ...characterRun("s", "ѕЅꜱ"), ...characterRun("t", "тТτΤᴛŧ"),
  ...characterRun("u", "υᴜս"), ...characterRun("v", "νѵᴠ"), ...characterRun("w", "ԝԜᴡѡ"), ...characterRun("x", "хХχΧ"),
  ...characterRun("y", "уУγΥʏүҮ"), ...characterRun("z", "ᴢΖ"),
  ...characterRun("/", "∕⁄⧸╱⟋᜵Ⳇ／"), ...characterRun("@", "＠﹫"),
  // Nd blocks outside NFKC's reach (NFKC maps the full-width and mathematical digits already).
  ...[0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20,
    0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
    0xa9f0, 0xaa50, 0xabf0].flatMap(digitRun),
]));

/**
 * The copy that patterns run on: cleaned, then stripped of the other invisible characters and of
 * combining marks (NFKD), folded through CONFUSABLE_FOLD, with every kind of space as a plain space.
 * Line separators are kept (see commentLines). Letter case is kept for ASCII; matchers are case-insensitive.
 * Never send this copy anywhere; send cleanText.
 */
export function normalizeForMatching(text: string): string {
  return foldedCopy(text, "");
}

/** The copy of a text with each invisible character removed (gap "") or replaced by a space (gap " "). */
function foldedCopy(text: string, gap: "" | " "): string {
  const visible = text.replace(FORMAT_CHARACTERS, gap).normalize("NFKC").replace(FORMAT_CHARACTERS, gap);
  const stripped = visible.replace(IGNORABLE_CHARACTERS, gap).normalize("NFKD").replace(COMBINING_MARKS, "");
  let folded = "";
  for (const character of stripped) folded += CONFUSABLE_FOLD[character] ?? character;
  return folded.replace(SPACE_LIKE, " ").replace(OTHER_CONTROLS, "");
}

/**
 * What the matchers scan: the normalized copy, and, when the text holds invisible characters, a second
 * copy in which each of them is a space. A zero-width character may stand in for the gap between a
 * command and its argument (`bors\u200Br+`) as easily as it may hide inside a word (`/de\u200Bploy`),
 * and which one a given bot reads is not knowable, so both are checked.
 */
function matchingCopies(text: string): string[] {
  const joined = foldedCopy(text, "");
  const spaced = foldedCopy(text, " ");
  return joined === spaced ? [joined] : [joined, spaced];
}

/** The lines of a text, on LF, CR, U+2028, U+2029 and U+0085, normalized for matching. */
export function commentLines(text: string): string[] {
  return normalizeForMatching(text).split(LINE_SEPARATORS);
}

// ---------------------------------------------------------------------------------------------
// Patterns and constants
// ---------------------------------------------------------------------------------------------

/** Tags whose closing form `</tag>` is markup, not a command. Only these; `</deploy>` and `</merge>` are commands. */
export const HTML_TAG_NAMES: readonly string[] = Object.freeze([
  "details", "summary", "sub", "sup", "br", "b", "i", "em", "strong", "code", "pre", "p", "div", "span", "kbd", "table", "thead", "tbody",
  "tr", "td", "th", "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
]);
const HTML_TAGS = new Set(HTML_TAG_NAMES);

/** Bot and app accounts an @-mention of which is always consequential. */
export const KNOWN_BOT_ACCOUNTS: readonly string[] = Object.freeze(["mergifyio", "kodiakhq", "dependabot", "renovate", "bors", "github-actions"]);
const KNOWN_BOTS = new Set(KNOWN_BOT_ACCOUNTS);

/** Not preceded by a word character, so `dependabot@example.com` is an email address, not a mention. */
const MENTION_START = "(?<![A-Za-z0-9_])@";

/**
 * Bots that act on a comment's text. Maintained: new bots are added in releases. Each pattern runs
 * case-insensitively on the normalized copy of ONE line, anywhere in the line, unanchored.
 */
export const COMMAND_COMMENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  // bors: generic on purpose, so `bors r+`, `bors r=alice`, `bors delegate+`, `bors try` and `bors ping` all count.
  { name: "bors", pattern: /\bbors(?:\s+|\s*[:,;]\s*)\S/iu },
  { name: "mergify", pattern: new RegExp(`${MENTION_START}mergifyio\\b`, "iu") },
  { name: "kodiak", pattern: new RegExp(`${MENTION_START}kodiakhq\\b|\\bkodiak\\s+\\S`, "iu") },
  { name: "atlantis", pattern: /\batlantis\s+(?:plan|apply|unlock|approve_policies|import|state|version|help)\b/iu },
  { name: "dependabot", pattern: new RegExp(`${MENTION_START}dependabot\\b`, "iu") },
  { name: "renovate", pattern: new RegExp(`${MENTION_START}renovate\\b`, "iu") },
  { name: "bors mention", pattern: new RegExp(`${MENTION_START}bors\\b`, "iu") },
  { name: "github-actions", pattern: new RegExp(`${MENTION_START}github-actions\\b`, "iu") },
  { name: "coding agents", pattern: new RegExp(`${MENTION_START}(?:copilot|claude|codex|coderabbitai)\\b`, "iu") },
  { name: "jenkins", pattern: /\b(?:retest|test)\s+this\s+please\b|\bok\s+to\s+test\b/iu },
]);

/** A label whose addition starts a merge, deploy or release in many repositories. Matched against a whole label, case-insensitively. */
export const TRIGGER_LABEL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: "automerge", pattern: /^auto[-_ ]?merge$/iu },
  { name: "merge", pattern: /^merge$/iu },
  { name: "ready-to-merge", pattern: /^ready[-_ ]?to[-_ ]?merge$/iu },
  { name: "merge-queue", pattern: /^merge[-_ ]?queue$/iu },
  { name: "deploy", pattern: /^deploy(?:[-_:/ ].*)?$/iu },
  { name: "release", pattern: /^release(?:[-_:/ ].*)?$/iu },
  { name: "ship", pattern: /^ship(?:[-_ ]?it)?$/iu },
  { name: "rollback", pattern: /^roll[-_ ]?back$/iu },
  { name: "hotfix-deploy", pattern: /^hotfix[-_ ]?deploy$/iu },
]);

/**
 * A `/word` token: a `/` followed by a letter, not preceded by a letter, digit, `.`, `/`, `-` or `:`,
 * and not followed by another `/` (a token followed by `/` is a path segment, as in /usr/bin). The word
 * runs to the first character that is not a letter, digit, `_` or `-`; the trailing lookahead stops the
 * engine backtracking to a shorter word that a `/` would then no longer follow.
 */
const SLASH_COMMAND = /(?<![\p{L}\p{N}./:-])\/(\p{L}[\p{L}\p{N}_-]*)(?![\p{L}\p{N}_/-])/gu;
const MENTION = /(?<![A-Za-z0-9_])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?(?:\[bot\])?)/gu;

/** The deepest nesting walked. Real arguments (a Jira document is about a dozen levels) stay far below it. */
const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------------------------
// Walking the arguments
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every string value of the arguments at any depth, with whether it sits under a label path. Paths use
 * the item-path syntax (`a.b`, `a[].b`). A skipped path drops its whole subtree. Returns true when the
 * arguments nest deeper than the limit, which the caller treats as consequential.
 */
function walkStrings(
  value: unknown,
  path: string,
  depth: number,
  inLabel: boolean,
  skip: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  visit: (text: string, isLabel: boolean) => void,
): boolean {
  if (typeof value === "string") {
    visit(value, inLabel);
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  if (depth > MAX_DEPTH) return true;
  let tooDeep = false;
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) tooDeep = walkStrings(entry, `${path}[]`, depth + 1, inLabel, skip, labels, visit) || tooDeep;
    return tooDeep;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (skip.has(childPath)) continue;
    tooDeep = walkStrings(entry, childPath, depth + 1, inLabel || labels.has(childPath), skip, labels, visit) || tooDeep;
  }
  return tooDeep;
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

export interface CommentSignalOptions {
  /** The recipe setting: when true, mentions are kept (and every one is consequential). */
  allowMentions: boolean;
  /** Item-path syntax paths whose values are label names (a string, or an array or object of them). */
  labelPaths: readonly string[];
  /** Item-reference and enum-valued arguments named in the tool's schema, which are not text. Their whole subtree is skipped. */
  skipPaths?: readonly string[] | undefined;
  /** Words an org's own automations act on (guardrail, at most 50). Any occurrence anywhere, with or without a slash, makes the write consequential. */
  extraCommandWords?: readonly string[] | undefined;
  /** Org-added trigger label patterns (guardrail `extraTriggerLabels`); `*` matches any run of characters. */
  extraTriggerLabels?: readonly string[] | undefined;
}

export interface CommentSignal { consequential: boolean; reasons: string[] }

function globPattern(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "iu");
}

function isBotName(name: string): boolean {
  const lowered = name.toLowerCase().replace(/[.-]+$/u, "");
  const bare = lowered.replace(/\[bot\]$/u, "");
  if (bare !== lowered || /[-_]bot$/u.test(bare)) return true;
  return bare.split("/").some((segment) => KNOWN_BOTS.has(segment));
}

function lineReasons(line: string, reasons: Set<string>, options: CommentSignalOptions): void {
  for (const { name, pattern } of COMMAND_COMMENT_PATTERNS) if (pattern.test(line)) reasons.add(`command pattern: ${name}`);
  for (const match of line.matchAll(SLASH_COMMAND)) {
    const word = (match[1] ?? "").toLowerCase();
    const index = match.index;
    if (index > 0 && line[index - 1] === "<" && HTML_TAGS.has(word)) continue;
    reasons.add(`slash command /${word.slice(0, 40)}`);
  }
  for (const match of line.matchAll(MENTION)) {
    const name = match[1] ?? "";
    if (isBotName(name)) reasons.add(`mention of a bot: @${name.slice(0, 40)}`);
    else if (options.allowMentions) reasons.add(`mention: @${name.slice(0, 40)}`);
  }
}

function labelCandidates(label: string): string[] {
  const folded = normalizeForMatching(label).trim();
  return [folded, ...folded.split(/[,;\n]+/u).map((part) => part.trim())].filter((part) => part !== "");
}

/**
 * Whether a text or label write is consequential, and why. It is when any string of the arguments, at
 * any depth: holds a slash command; matches a COMMAND_COMMENT_PATTERNS entry on some line; @-mentions a
 * bot or app account (always) or anyone (when allowMentions keeps mentions); holds an extra command word;
 * or, under a label path, matches a trigger label. Arguments nested beyond the walk limit are consequential.
 */
export function commentSignal(args: unknown, options: CommentSignalOptions): CommentSignal {
  const reasons = new Set<string>();
  const extraWords = (options.extraCommandWords ?? []).map((word) => normalizeForMatching(word).trim().toLowerCase()).filter((word) => word !== "");
  const extraLabels = (options.extraTriggerLabels ?? []).map((glob) => globPattern(normalizeForMatching(glob).trim()));
  const tooDeep = walkStrings(args, "", 0, false, new Set(options.skipPaths ?? []), new Set(options.labelPaths), (text, isLabel) => {
    for (const copy of matchingCopies(text)) {
      for (const line of copy.split(LINE_SEPARATORS)) lineReasons(line, reasons, options);
      const lowered = copy.toLowerCase();
      for (const word of extraWords) if (lowered.includes(word)) reasons.add(`extra command word: ${word.slice(0, 40)}`);
    }
    if (!isLabel) return;
    for (const candidate of labelCandidates(text)) {
      for (const { name, pattern } of TRIGGER_LABEL_PATTERNS) if (pattern.test(candidate)) reasons.add(`trigger label: ${name}`);
      for (const pattern of extraLabels) if (pattern.test(candidate)) reasons.add(`trigger label: ${candidate.slice(0, 40)}`);
    }
  });
  if (tooDeep) reasons.add("arguments nested too deeply to check");
  return { consequential: reasons.size > 0, reasons: [...reasons].slice(0, 20) };
}

// ---------------------------------------------------------------------------------------------
// Stripping mentions
// ---------------------------------------------------------------------------------------------

export interface StripMentionsOptions {
  /** Item-reference and enum-valued arguments, left exactly as given. */
  skipPaths?: readonly string[] | undefined;
}

/** An `@` not preceded by an ASCII word character and followed by a name character: `@alice`, `@acme/team`; not `a@b.com`. */
const MENTION_AT = /(?<![A-Za-z0-9_])@(?=[\p{L}\p{N}_])/gu;
const MENTION_NAME = /(?<![A-Za-z0-9_])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?)/gu;

function stripMentionsFromText(text: string, stripped: string[]): string {
  let current = cleanText(text);
  // Removing one `@` can expose another (`@@alice`), so repeat until nothing changes.
  for (;;) {
    for (const match of current.matchAll(MENTION_NAME)) {
      const mention = `@${(match[1] ?? "").replace(/[.-]+$/u, "")}`;
      if (!stripped.includes(mention)) stripped.push(mention);
    }
    const next = current.replace(MENTION_AT, "");
    if (next === current) return current;
    current = next;
  }
}

function stripValue(value: unknown, path: string, depth: number, skip: ReadonlySet<string>, stripped: string[]): unknown {
  if (typeof value === "string") return stripMentionsFromText(value, stripped);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) throw agentXError("CONFIG_INVALID", "The arguments are nested too deeply to check, so the request was not sent.");
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => stripValue(entry, `${path}[]`, depth + 1, skip, stripped));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const childPath = path === "" ? key : `${path}.${key}`;
    return [key, skip.has(childPath) ? entry : stripValue(entry, childPath, depth + 1, skip, stripped)];
  }));
}

/**
 * The arguments with every @name and @org/team turned into plain text (the `@` removed), by default for
 * every agent write; the recipe setting `allowMentions` keeps them. Every string it returns is the
 * cleaned (NFKC, Cf-removed) text, so what is approved and sent is what was checked. `stripped` lists
 * the mentions removed. The input is not changed. Arguments nested beyond the walk limit are refused.
 */
export function stripMentions(args: unknown, options: StripMentionsOptions = {}): { args: unknown; stripped: string[] } {
  const stripped: string[] = [];
  const result = stripValue(args, "", 0, new Set(options.skipPaths ?? []), stripped);
  return { args: result, stripped };
}
