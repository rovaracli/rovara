// Learning loop (v1.2), spotting repeats with no model call (design 4.1). Pure and deterministic: a correction's text becomes a signature, a set of salted hashes of its words and
// adjacent word pairs, and two signatures are compared with a weighted Jaccard score or, for a long text that holds a shorter one, containment. No correction text is kept in a signature, so
// similarity and the dismissed-pattern match still work after the text is dropped (design 3.3).
//
// The words are normalised so that look-alike forms meet: NFKC first (full-width letters, ligatures), combining marks removed, then Cyrillic and Greek letters that look like Latin ones
// folded to the Latin letter, so "Alwаys" (Cyrillic а) and "Αlways" (Greek Α) read as "always". The fold is for the signature only; the stored text keeps the NFKC form.
import { createHmac } from "node:crypto";
import { inertRuleText } from "../playbook/inert-rule-text.js";

/** Salted hashes of a text's words and word pairs, sorted and without repeats. A text with a negation also holds `NEGATED`, which is no hash and takes no part in the score. */
export type Signature = readonly string[];
/** The marker for a negated text ("do not", "never", "avoid", "without"): a negated and a plain text are never taken as the same rule. */
export const NEGATED = "~neg";

/** How many of the project's last-180-day signatures hold each hash. Rare hashes weigh more. */
export interface DocumentFrequency {
  readonly total: number;
  readonly counts: ReadonlyMap<string, number>;
}
export interface SignatureComparison {
  /** Weighted Jaccard: the weight of the shared hashes over the weight of all of them. */
  jaccard: number;
  /** The weight of the shared hashes over the weight of the smaller signature. */
  containment: number;
  similar: boolean;
}

/** Similar means a weighted Jaccard of at least this... */
export const SIMILARITY_JACCARD_MIN = 0.45;
/** ...or this share of the smaller text held by the larger one... */
export const SIMILARITY_CONTAINMENT_MIN = 0.8;
/** ...but containment only counts when the smaller signature has at least this many hashes (about five words): "Use strict types." sits inside a thousand unrelated texts. */
export const CONTAINMENT_MIN_HASHES = 8;
const HASH_HEX_LENGTH = 16;
/** The most characters (code points) of a text that go into a signature. A stored correction is at most 1,000, so nothing real is lost; the cut bounds the work on any input. */
export const SIGNATURE_TEXT_MAX = 2000;

// ---- look-alike letters

/** Cyrillic and Greek letters that read as a Latin letter, upper and lower case, plus a few Latin look-alikes NFKC leaves alone (dotless i, script g). */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Cyrillic, lower case
  а: "a", с: "c", е: "e", о: "o", р: "p", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ӏ: "l", ѵ: "v",
  // Cyrillic, upper case
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", І: "I", Ј: "J", Ѕ: "S", Ԁ: "D", Ԛ: "Q", Ԝ: "W", Ѵ: "V",
  // Greek, lower case
  α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y",
  // Greek, upper case
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Latin look-alikes that NFKC keeps
  ı: "i", ɡ: "g", ǀ: "l", ⅼ: "l",
};
const LOOK_ALIKE_PATTERN = new RegExp(`[${Object.keys(LOOK_ALIKES).join("")}]`, "gu");
const foldLookAlikes = (text: string): string => text.replace(LOOK_ALIKE_PATTERN, (letter) => LOOK_ALIKES[letter] ?? letter);

// ---- words

/** Words that carry no rule: articles, pronouns, auxiliaries, modals, politeness. Negations ("not", "never", "without") are NOT here: they change what a rule says. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then else of to in on at by for from with into onto as is are was were be been being am do does did done have has had having it its this that these those there here " +
    "you your yours we our us they them their i me my he she his her him who whom which what when where why how can could should would will shall may might must than so such very just also too " +
    "please thanks thank instead rather about because while whenever each other another same"
  ).split(" "),
);
/** Words of a negation. A text holding any of them is `NEGATED`. */
const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "not", "no", "never", "nor", "neither", "cannot", "without", "avoid", "stop", "dont", "doesnt", "didnt", "cant", "wont", "shouldnt", "mustnt", "isnt", "arent", "wasnt", "werent", "havent", "hasnt", "couldnt", "wouldnt",
]);

const COMBINING_MARKS = /\p{M}/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;
const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|py|go|rs|java|kt|rb|php|css|scss|html?|sh|toml|lock|txt|sql|tf|xml|conf|cfg|env|log)$/iu;
const TRAILING_PUNCTUATION = /[,;:!?)\]}"'`.]+$/u;

/** A path (`src/api/users.ts`, `./config`, `/etc/hosts`, `package.json`) is code, not a rule word. `try/catch` and `and/or` are words. */
function isPath(token: string): boolean {
  const bare = token.replace(TRAILING_PUNCTUATION, "");
  if (FILE_EXTENSION.test(bare)) return true;
  if (!bare.includes("/")) return false;
  return /^[./~]/u.test(bare) || (bare.match(/\//g) ?? []).length >= 2;
}

/** A light English stem: plural and verb endings, a doubled final consonant after "-ing" or "-ed", a final "e". Good enough that "tests", "testing" and "tested" meet. */
function stem(word: string): string {
  let result = word;
  if (result.length > 4 && result.endsWith("ies")) return `${result.slice(0, -3)}y`;
  if (result.length > 5 && result.endsWith("ing")) result = undouble(result.slice(0, -3));
  else if (result.length > 4 && result.endsWith("ed")) result = undouble(result.slice(0, -2));
  else if (result.length > 4 && /(?:ss|sh|ch|x|z)es$/u.test(result)) result = result.slice(0, -2);
  else if (result.length > 3 && result.endsWith("s") && !/(?:ss|us|is)$/u.test(result)) result = result.slice(0, -1);
  if (result.length >= 4 && result.endsWith("e")) result = result.slice(0, -1);
  return result;
}
const undouble = (stemmed: string): string => (/([bgmnprt])\1$/u.test(stemmed) ? stemmed.slice(0, -1) : stemmed);

/** All words of a text in order, normalised and stemmed, stop words removed, with the negations kept. */
export function signatureWords(text: string): string[] {
  const folded = foldLookAlikes(inertRuleText(Array.from(text).slice(0, SIGNATURE_TEXT_MAX).join("")).normalize("NFKC").normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC"));
  const withoutCode = folded.replace(URL, " ").replace(/\S+/gu, (token) => (isPath(token) ? " " : token));
  const apart = withoutCode
    .replace(/n['’]t\b/giu, "nt")
    .replace(/['’]/gu, "")
    .replace(/_/gu, " ")
    .replace(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})/gu, " ")
    .replace(/(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu, " ")
    .toLowerCase();
  return apart
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && /^\p{L}/u.test(token) && !STOP_WORDS.has(token))
    .map((token) => (NEGATION_WORDS.has(token) ? token : stem(token)));
}

// ---- signature

const hashOf = (salt: string, value: string): string => createHmac("sha256", salt).update(value, "utf8").digest("hex").slice(0, HASH_HEX_LENGTH);

/** The signature of an already cleaned correction text: its words and adjacent word pairs, each hashed with the project's salt. */
export function signatureOf(text: string, salt: string): Signature {
  const words = signatureWords(text);
  const hashes = new Set<string>();
  words.forEach((word, index) => {
    hashes.add(hashOf(salt, `1:${word}`));
    const next = words[index + 1];
    if (next !== undefined) hashes.add(hashOf(salt, `2:${word} ${next}`));
  });
  if (hashes.size === 0) return [];
  const sorted = [...hashes].sort();
  return words.some((word) => NEGATION_WORDS.has(word)) ? [...sorted, NEGATED] : sorted;
}

/** The words of a text that carry the rule: not a stop word, and (for the caller) not a generic filler. Used by the generic-text check. */
export const contentWords = (text: string): string[] => signatureWords(text).filter((word) => !NEGATION_WORDS.has(word));

// ---- comparing

/** How many of the given signatures hold each hash. Build it from the project's corrections of the last 180 days; the caller keeps it. */
export function buildDocumentFrequency(signatures: readonly Signature[]): DocumentFrequency {
  const counts = new Map<string, number>();
  for (const signature of signatures) for (const hash of signature) if (hash !== NEGATED) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return { total: signatures.length, counts };
}

const weightOf = (hash: string, frequency: DocumentFrequency | undefined): number =>
  frequency === undefined ? 1 : 1 + Math.log((frequency.total + 1) / ((frequency.counts.get(hash) ?? 0) + 1));

/** The two signatures' weighted Jaccard and containment, and whether they count as the same rule. Empty signatures never match. */
export function compareSignatures(a: Signature, b: Signature, frequency?: DocumentFrequency): SignatureComparison {
  const setA = new Set(a.filter((hash) => hash !== NEGATED));
  const setB = new Set(b.filter((hash) => hash !== NEGATED));
  if (setA.size === 0 || setB.size === 0) return { jaccard: 0, containment: 0, similar: false };
  let shared = 0;
  let weightA = 0;
  let weightB = 0;
  for (const hash of setA) {
    const weight = weightOf(hash, frequency);
    weightA += weight;
    if (setB.has(hash)) shared += weight;
  }
  for (const hash of setB) weightB += weightOf(hash, frequency);
  const jaccard = shared / (weightA + weightB - shared);
  const containment = shared / Math.min(weightA, weightB);
  const samePolarity = a.includes(NEGATED) === b.includes(NEGATED);
  const containedEnough = Math.min(setA.size, setB.size) >= CONTAINMENT_MIN_HASHES && containment >= SIMILARITY_CONTAINMENT_MIN;
  return { jaccard, containment, similar: samePolarity && (jaccard >= SIMILARITY_JACCARD_MIN || containedEnough) };
}

export const isSimilar = (a: Signature, b: Signature, frequency?: DocumentFrequency): boolean => compareSignatures(a, b, frequency).similar;
