// Learning loop (v1.2), the text of a correction (design 3.3, review Important 7). Pure functions: the same text always gives the same result, and nothing here reads or writes a store.
//
// A correction's text is untrusted: it can be a person's comment, a send-back reason or a pull request review comment, and a human later accepts a rule built from it. So before it is stored:
//   1. NFKC folds full-width letters, ligatures and other compatibility forms;
//   2. hidden characters (zero-width, bidirectional, other format and control characters) are removed, so a token or a code fence split by one is whole again;
//   3. secrets are redacted, BEFORE anything is cut, so a token that straddles the limit cannot leave a fragment (the `agent-sessions/messages.ts` order);
//   4. code is dropped: fenced (``` and ~~~), `suggestion` blocks, indented lines and quoted lines. Pull request comments quote private code, and none of it is kept;
//   5. markup is made inert: links keep their label and lose the address, images keep their alt text, HTML tags and Slack mention markup are gone;
//   6. the text is redacted once more (step 5 can join pieces), cut to 1,000 characters, and passed through `inertRuleText`, so it is the same text the rule editor would save.
// Whether the text is worth keeping (not empty, not short, not generic: W3) is `prepareCorrection`. No model reads any of this.
import { redactText } from "@agentx/contracts";
import { inertRuleText } from "../playbook/inert-rule-text.js";
import { contentWords, signatureWords } from "./similarity.js";

/** The most characters (code points) of a stored correction. */
export const CORRECTION_TEXT_MAX = 1000;
/** A correction under this many characters after cleaning is not a correction (design 2.2). */
export const CORRECTION_MIN_CHARS = 20;
/** The most characters of the wording a suggestion proposes (design 4.4). */
export const PROPOSED_TEXT_MAX = 400;

export type PreparedCorrection = { ok: true; text: string } | { ok: false; reason: "empty" | "too_short" | "generic" };

const codePoints = (text: string): string[] => Array.from(text);

// ---- code

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const QUOTED_LINE = /^ {0,3}>/u;
const INDENTED_LINE = /^(?: {4,}|\t)/u;

/**
 * The text without its code: fenced blocks (``` and ~~~, with any info string such as `suggestion`; a fence ends at a line of the same mark, at least as long; one never closed runs to the end),
 * indented lines (four spaces or a tab), and quoted lines (`>`). The prose around them stays. Inline `code` is kept: it is one identifier in a sentence, not a block of someone's code.
 */
export function stripCode(text: string): string {
  const kept: string[] = [];
  let fence: { mark: string; length: number } | undefined;
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (fence !== undefined) {
      const close = new RegExp(`^ {0,3}${fence.mark === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`, "u");
      if (close.test(line)) fence = undefined;
      continue;
    }
    if (QUOTED_LINE.test(line) || INDENTED_LINE.test(line) && line.trim() !== "") continue;
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string has no backtick (``` code ``` on one line is inline code).
    if (open !== null && !(open[1]?.startsWith("`") && (open[2] ?? "").includes("`"))) {
      fence = { mark: open[1]?.startsWith("`") ? "`" : "~", length: open[1]?.length ?? 3 };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// ---- markup

const SLACK_LINK = /<(?:https?:|mailto:)[^<>|\s]{0,2000}(?:\|([^<>]{0,200}))?>/giu;
const SLACK_MENTION = /<([@#!])([^<>|\s]{1,64})(?:\|[^<>]{0,64})?>/gu;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const HTML_RAW_ELEMENT = /<(script|style)\b[^>]{0,500}>[\s\S]*?(?:<\/\1\s*>|$)/giu;
const HTML_TAG = /<\/?[A-Za-z][^<>]{0,500}>/gu;
const HTML_TAG_START = /<(?=[A-Za-z/!?])/gu;
const MARKDOWN_IMAGE = /!\[([^\]]{0,200})\]\([^)]{0,2000}\)/gu;
const MARKDOWN_LINK = /\[([^\]]{0,200})\]\([^)]{0,2000}\)/gu;
const MARKDOWN_REFERENCE_LINK = /\[([^\]]{1,200})\]\[[^\]]{0,64}\]/gu;
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\]]{1,64}\]:[ \t]*\S.*$/gmu;
const BARE_URL = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()[\]]{1,2000}/giu;

/** Links keep their label, images their alt text; tags, comments, script and style bodies, and Slack markup go. Nothing that remains can render as a link, a tag or a ping. */
function inertMarkup(text: string): string {
  return text
    .replace(SLACK_LINK, (_whole, label: string | undefined) => label ?? "")
    .replace(SLACK_MENTION, "[$1$2]")
    .replace(HTML_COMMENT, "")
    .replace(HTML_RAW_ELEMENT, " ")
    .replace(HTML_TAG, "")
    .replace(HTML_TAG_START, "")
    .replace(MARKDOWN_IMAGE, "$1")
    .replace(MARKDOWN_LINK, "$1")
    .replace(MARKDOWN_REFERENCE_LINK, "$1")
    .replace(MARKDOWN_REFERENCE_DEFINITION, "")
    .replace(BARE_URL, "[link]");
}

// ---- the stored text

/**
 * A correction's raw text as it is stored: NFKC, hidden characters removed, redacted, code dropped, markup made inert, redacted again, cut to 1,000 characters, and inert. Can be empty (all
 * code, or nothing). It never throws.
 */
export function cleanCorrectionText(raw: string): string {
  const visible = inertRuleText(raw.normalize("NFKC"));
  const redacted = redactText(visible);
  const prose = inertMarkup(stripCode(redacted));
  const tidy = prose
    .replace(/\t/gu, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const cut = codePoints(redactText(tidy)).slice(0, CORRECTION_TEXT_MAX).join("");
  return inertRuleText(cut);
}

// ---- generic text (W3)

/**
 * Words that say "this is wrong" without saying what. A text with fewer than two other content words is generic. The list is run through the same normaliser as the signatures, so it matches
 * stems ("comments" and "comment") and look-alike letters.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  signatureWords(
    "see included comment comments please fix fixed change changes changed update updated thing things issue issues again wrong bad good better work works need needs make look looks right correct like " +
      "think try great nice nit still fine okay lgtm approve approved reject rejected redo revise revised review reviewed feedback address addressed above below follow unclear confusing hmm lot sorry " +
      "more less much many thanks thank sure yes yep ok",
  ),
);

/** Whether the cleaned text names nothing specific: fewer than two content words that are not generic fillers ("See the included comments.", "Looks good to me", "Please fix this"). */
export function isGenericCorrection(cleaned: string): boolean {
  return contentWords(cleaned).filter((word) => !GENERIC_WORDS.has(word)).length < 2;
}

/** The cleaned text of a correction, or why it is not one: nothing left (`empty`), under 20 characters (`too_short`), or generic (`generic`). */
export function prepareCorrection(raw: string): PreparedCorrection {
  const text = cleanCorrectionText(raw);
  if (text === "") return { ok: false, reason: "empty" };
  if (codePoints(text).length < CORRECTION_MIN_CHARS) return { ok: false, reason: "too_short" };
  if (isGenericCorrection(text)) return { ok: false, reason: "generic" };
  return { ok: true, text };
}

// ---- the proposed rule (design 4.4)

/** The wording a suggestion proposes: the first two sentences of the (latest) correction's stored text, at most 400 characters, through `inertRuleText`. The card says to edit it before accepting. */
export function proposedRuleText(text: string): string {
  const sentences = inertRuleText(text)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
  return inertRuleText(codePoints(sentences.slice(0, 2).join(" ")).slice(0, PROPOSED_TEXT_MAX).join(""));
}
