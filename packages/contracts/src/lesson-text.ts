// Learning v2 (L1/L4): the one text-hygiene function for lesson text, shared by the broker (before a model reads a span, before a lesson is stored)
// and the worker (before a lesson is rendered into a stage's prompt). It removes what hides text from a reviewer (zero-width and bidi controls,
// tag characters), markup that imitates a prompt boundary (`<system>`, `<<team-lessons>>`) and control characters. Pure; no I/O.

/** Zero-width, bidi, byte-order, soft-hyphen, word-joiner and Unicode tag characters (U+E0000-U+E007F), plus C0/C1 controls except tab and newline. */
// eslint-disable-next-line no-misleading-character-class, no-control-regex
const HIDDEN = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Removes hidden and control characters. */
export function stripHiddenCharacters(text: string): string {
  return text.normalize("NFKC").replace(HIDDEN, "");
}

/**
 * Makes text inert as a prompt boundary: drops any `<...>` tag, turns the `<<` and `>>` delimiters this feature uses into plain parentheses, and collapses
 * runs of blank lines. Applied again at render time, so a lesson stored by an older build cannot close the lessons block.
 */
export function neutraliseMarkup(text: string): string {
  return text
    .replace(/<<+|>>+/gu, (match) => (match.startsWith("<") ? "(" : ")"))
    .replace(/<\/?[A-Za-z!?][^<>\n]{0,200}>/gu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

/** Hidden characters out, then markup out, then trimmed and cut to `maxChars` (code points). */
export function cleanLessonText(text: string, maxChars: number): string {
  const cleaned = neutraliseMarkup(stripHiddenCharacters(text)).trim();
  const points = [...cleaned];
  return points.length <= maxChars ? cleaned : points.slice(0, maxChars).join("").trimEnd();
}
