// Lessons in production, lane 5 fix round 1 (review C1, H1, H3, M3): the ORDERED, polarity-aware comparison of two statements. The shortlist (similarity.ts) compares word SETS and so cannot tell "pnpm over npm" from "npm
// over pnpm", "tls on" from "tls off", or "3 times" from "9 times". Whatever may decide that two lessons are one (a merge by code, a rejected lesson coming back, a judge's "same", the same-mistake measure) goes
// through this module instead. Nothing here reads a store or calls a model.
//
//   verbatim   the two bodies are EQUAL after normalising case, whitespace and punctuation. Nothing else: every word, digit, negation and direction word is kept, in order.
//   near       a copy with a few filler words added or removed: the same words in the same order, the same negations, direction words, qualifiers and numbers, at most a tenth (and three words) more on one side.
//   flipped    the same words with a polarity, direction or number changed, or the same words in another order: a person decides (a contradiction card), never a merge.
//   narrows    the other lesson's words, in order, with more added: a refinement (a person decides), never a copy.
//
// A word that is in the "critical" lists below is never filler. The lists are deliberately long: a word wrongly kept as critical only sends a pair to the judge or a person, a word wrongly dropped merges advice.

/** Words that carry no advice by themselves. Everything NOT here takes part in the order test, so a changed noun, verb, preposition or digit means "not a copy". */
const FILLER: ReadonlySet<string> = new Set("a an the and is are be been it its this that these those also just too very so then please really here there you your we our as of do does did".split(" "));

/** Contractions and words that negate; all count as one "not" when polarity is compared. */
const NEGATORS: ReadonlySet<string> = new Set("not no never none nothing nobody cannot cant dont doesnt didnt wont isnt arent wasnt werent shouldnt mustnt couldnt wouldnt havent hasnt hadnt neither nor".split(" "));
/** Direction, polarity and comparison words (with the negators and every number, below). A difference in any of them is a difference in the advice. */
const POLARITY: ReadonlySet<string> = new Set((
  "always avoid prefer instead rather on off before after over than more less most least enable enabled disable disabled true false allow allowed deny denied forbid forbidden ban banned require required " +
  "skip ignore keep remove add drop include exclude start stop increase decrease higher lower above below first last must should may up down open close " +
  "zero one two three four five six seven eight nine ten once twice thrice half double single hundred thousand all every"
).split(" "));
/** Words that narrow or condition a statement: an added one means the statement is not the same any more. */
const QUALIFIERS: ReadonlySet<string> = new Set("except unless only but when whenever if for without otherwise besides excluding including".split(" "));

const NUMBER = /^-?\d/u;
const WORD = /-?\d+(?:[.,]\d+)*[\p{L}%]*|[\p{L}_][\p{L}\p{N}_]*|!=|[<>=≤≥≠]/gu;

/** The words of a text, in order, lower case, punctuation and whitespace gone. Digits, negations and comparison signs are kept; an apostrophe inside a word is dropped (don't -> dont). */
export function wordsOf(text: string): string[] {
  const folded = text.normalize("NFKC").toLowerCase().replace(/['’`]/gu, "").replace(/[\p{Cf}\p{Cc}]/gu, " ");
  return folded.match(WORD) ?? [];
}

/** A text normalised for equality: its words joined by one space. */
export const normalizedText = (text: string): string => wordsOf(text).join(" ");

/**
 * A plural or third-person "s" is not a different word (a tier-0 lesson is written from a template: "use" becomes "uses", "retries" stays): content words lose it before the ordered comparison. Filler and every
 * critical word are left as they are. Verbatim never uses this.
 */
function stem(word: string): string {
  if (word.length >= 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.length >= 4 && word.endsWith("s") && !/(ss|us|is)$/u.test(word) ? word.slice(0, -1) : word;
}
const forOrder = (words: readonly string[]): string[] => words.filter((w) => !FILLER.has(w)).map((w) => (isCritical(w) ? w : stem(w)));

const isNumber = (word: string): boolean => NUMBER.test(word);
const isSign = (word: string): boolean => word === "!=" || /^[<>=≤≥≠]$/u.test(word);
const isPolarity = (word: string): boolean => NEGATORS.has(word) || POLARITY.has(word) || isNumber(word) || isSign(word);
const isQualifier = (word: string): boolean => QUALIFIERS.has(word);
/** Every kind of word whose presence or place changes what the advice says. */
export const isCritical = (word: string): boolean => isPolarity(word) || isQualifier(word);
const canon = (word: string): string => (NEGATORS.has(word) ? "not" : word);

const polaritySequence = (words: readonly string[]): string[] => words.filter(isPolarity).map(canon);
const criticalSequence = (words: readonly string[]): string[] => words.filter(isCritical).map(canon);
const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedKey = (words: readonly string[]): string => [...words].sort().join(" ");

/** The longest text compared word by word; a longer one is only ever called verbatim. */
const MAX_WORDS = 400;

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
  }
  return previous[b.length]!;
}

export interface CopyRelation {
  /** The bodies are equal after normalisation. */
  verbatim: boolean;
  /** The same words, in the same order, with only filler (and at most a tenth, three words, more on one side) different; every negation, direction word, qualifier and number is the same, in the same place. */
  near: boolean;
  /** Close in words but a polarity, direction or number differs, or the same words come in another order. */
  flipped: boolean;
  /** The FIRST text (the draft) holds all of the second's words, in order, and more: a narrowing or extension. Never a copy. */
  narrows: boolean;
  /** The negations, direction words and numbers are the same words (any order). */
  polaritySame: boolean;
  /** Negations, direction words, qualifiers (not "for") and numbers are the same words (any order): the floor under a judge's "same". */
  criticalSame: boolean;
  /** The ordered share of the longer text that the two have in common, 0 to 1. */
  ordered: number;
}

const NONE: CopyRelation = { verbatim: false, near: false, flipped: false, narrows: false, polaritySame: false, criticalSame: false, ordered: 0 };

/** How the `draft` statement relates to the `other` one, comparing their words in order. Pure; both directions are looked at (the shorter must be wholly inside the longer). */
export function relate(draft: string, other: string): CopyRelation {
  const full = [wordsOf(draft), wordsOf(other)] as const;
  if (full[0].length === 0 || full[1].length === 0) return NONE;
  const verbatim = full[0].join(" ") === full[1].join(" ");
  const x = forOrder(full[0]);
  const y = forOrder(full[1]);
  if (x.length === 0 || y.length === 0) return { ...NONE, verbatim };
  if (x.length > MAX_WORDS || y.length > MAX_WORDS) return { ...NONE, verbatim };
  const longest = Math.max(x.length, y.length);
  const shortest = Math.min(x.length, y.length);
  const common = lcsLength(x, y);
  const ordered = common / longest;
  const polaritySame = sortedKey(polaritySequence(x)) === sortedKey(polaritySequence(y));
  const floorCritical = (words: readonly string[]): string => sortedKey(criticalSequence(words).filter((w) => w !== "for"));
  const criticalSame = floorCritical(x) === floorCritical(y);
  const criticalInOrder = sameSequence(criticalSequence(x), criticalSequence(y));
  const subsequence = common === shortest;
  const near = verbatim || (shortest >= 2 && criticalInOrder && subsequence && longest - shortest <= Math.min(3, Math.floor(longest * 0.1)));
  // The same words in another order ("pnpm over npm" against "npm over pnpm", "migrations before seeding" against the reverse), or close in order with a polarity, direction or number changed.
  const reordered = shortest >= 3 && x.length === y.length && sortedKey(x) === sortedKey(y) && !sameSequence(x, y);
  const polarityDiffers = !sameSequence(polaritySequence(x), polaritySequence(y));
  // One side holds the other's words in order and ADDS a negation ("Never use withRetry ... ; call fetch directly" against "Use withRetry ..."): that is the opposite advice with more words around it, not a narrowing.
  const addsNegation = subsequence && x.some((w) => NEGATORS.has(w)) !== y.some((w) => NEGATORS.has(w));
  const flipped = !near && (reordered || (polarityDiffers && (ordered >= 0.7 || addsNegation)));
  const narrows = !near && !flipped && y.length >= 4 && common === y.length && x.length > y.length;
  return { verbatim, near, flipped, narrows, polaritySame, criticalSame, ordered };
}

/**
 * How much of `small` (a correction) a longer text (a lesson) says, in order: the share of `small`'s words found in the same order in `big`, and whether every negation, direction word and number of `small` is also in `big`
 * (a lesson that says "off" does not cover a correction that says "on"). Both texts are cut at MAX_WORDS words; a text cut short covers less, never more.
 */
export function covers(small: string, big: string): { ordered: number; pairs: number; polarityContained: boolean } {
  const x = forOrder(wordsOf(small)).slice(0, MAX_WORDS);
  const y = forOrder(wordsOf(big)).slice(0, MAX_WORDS);
  if (x.length === 0 || y.length === 0) return { ordered: 0, pairs: 0, polarityContained: false };
  const have = new Map<string, number>();
  for (const w of polaritySequence(y)) have.set(w, (have.get(w) ?? 0) + 1);
  const polarityContained = polaritySequence(x).every((w) => { const n = have.get(w) ?? 0; have.set(w, n - 1); return n > 0; });
  // Two words swapped keep most of the order (the longest common run is only one word short) but break the pairs of neighbours around them: the share of `small`'s neighbouring pairs found in `big` (`pairs`) is part of the answer.
  const pairs = new Set(y.slice(1).map((w, i) => `${y[i]} ${w}`));
  const wanted = x.slice(1).map((w, i) => `${x[i]} ${w}`);
  const pairShare = wanted.length === 0 ? 1 : wanted.filter((pair) => pairs.has(pair)).length / wanted.length;
  return { ordered: lcsLength(x, y) / x.length, pairs: pairShare, polarityContained };
}
