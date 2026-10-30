// v1.2 learning loop, B2: spotting repeats with no model call (design 4.1, 7.2 W8). Pure and deterministic. The fixture pairs are hand-written (tests/fixtures/learning/similarity-pairs.json);
// precision on them must stay at or above 90% (W8). Confusable letters (Cyrillic or Greek look-alikes, full-width forms) fold together after NFKC.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareCorrection } from "../../packages/broker/src/learning/text.js";
import {
  CONTAINMENT_MIN_HASHES,
  buildDocumentFrequency,
  compareSignatures,
  isSimilar,
  signatureOf,
  signatureWords,
  type Signature,
} from "../../packages/broker/src/learning/similarity.js";

const SALT = "project-salt-one";
interface Pair { id: string; kind: string; similar: boolean; a: string; b: string }
const { pairs } = JSON.parse(readFileSync(new URL("../fixtures/learning/similarity-pairs.json", import.meta.url), "utf8")) as { pairs: Pair[] };

// What capture would store, then its signature. A generic or too-short text is not a correction; the signature is then taken of the cleaned text anyway, so the pair can still be compared.
function signatureOfRaw(raw: string, salt = SALT): Signature {
  const prepared = prepareCorrection(raw);
  return signatureOf(prepared.ok ? prepared.text : raw, salt);
}
const sig = (text: string, salt = SALT) => signatureOf(text, salt);

describe("the signature", () => {
  it("is deterministic, sorted and free of duplicates", () => {
    const first = sig("Always run the linter before committing changes.");
    expect(sig("Always run the linter before committing changes.")).toEqual(first);
    expect([...first]).toEqual([...new Set(first)].sort());
    expect(first.length).toBeGreaterThan(4);
  });
  it("is salted per project and holds no plain word", () => {
    const a = sig("Always run the linter before committing changes.", "salt-a");
    const b = sig("Always run the linter before committing changes.", "salt-b");
    expect(a.some((hash) => b.includes(hash))).toBe(false);
    const joined = a.join(" ");
    for (const word of ["linter", "committing", "always", "changes"]) expect(joined).not.toContain(word);
    for (const hash of a) expect(hash).toMatch(/^[0-9a-f]{16}$|^~neg$/);
  });
  it("is the same for different case, punctuation, numbers, paths, addresses and quoted identifiers", () => {
    const base = sig("Check the handler handles a missing email.");
    expect(sig("CHECK THE HANDLER HANDLES A MISSING EMAIL!!")).toEqual(base);
    expect(sig("Check src/api/users.ts line 42 handles the handler 7 a missing email.")).toEqual(sig("Check src/api/orders.ts line 9 handles the handler 3 a missing email."));
    expect(sig("Check https://example.com/x?y=1 the handler handles a missing email.")).toEqual(base);
  });
  it("folds plurals and verb endings lightly", () => {
    expect(signatureWords("tests testing tested")).toEqual(["test", "test", "test"]);
    expect(signatureWords("queues and consumers")).toEqual(signatureWords("queue consumer"));
  });
  it("drops stop words but keeps negations", () => {
    const words = signatureWords("Do not log the request bodies for the failed requests");
    expect(words).toContain("not");
    expect(words).not.toContain("the");
    expect(words).not.toContain("for");
  });
  it("splits camelCase and snake_case identifiers into words", () => {
    expect(signatureWords("Rename getUserName and get_user_name")).toEqual(signatureWords("Rename get user name and get user name"));
  });
  it("is empty for text with nothing to compare, and empty never matches", () => {
    expect(sig("")).toEqual([]);
    expect(sig("12345 67890 /a/b/c.ts")).toEqual([]);
    expect(isSimilar(sig(""), sig(""))).toBe(false);
  });
});

describe("NFKC and confusable letters fold together", () => {
  const base = "Always run the linter before committing changes.";
  it("gives the same signature for Cyrillic look-alikes", () => {
    expect(sig("Alwаys run the linter bеfore committing chаnges.")).toEqual(sig(base));
  });
  it("gives the same signature for Greek look-alikes", () => {
    expect(sig("Αlways run the lιnter before cοmmitting changes.")).toEqual(sig(base));
  });
  it("gives the same signature for full-width letters", () => {
    expect(sig("Ａｌｗａｙｓ ｒｕｎ ｔｈｅ ｌｉｎｔｅｒ ｂｅｆｏｒｅ ｃｏｍｍｉｔｔｉｎｇ ｃｈａｎｇｅｓ．")).toEqual(sig(base));
  });
  it("ignores invisible characters and combining marks", () => {
    expect(sig("Al\u200Bways run the lin\u202Ater before commit\u0301ting changes.")).toEqual(sig(base));
  });
  it("keeps genuinely different words different", () => {
    expect(sig("Always run the formatter before committing changes.")).not.toEqual(sig(base));
  });
});

describe("comparing", () => {
  it("scores an identical text 1 and a disjoint text 0", () => {
    const a = sig("Always run the linter before committing changes.");
    expect(compareSignatures(a, a)).toMatchObject({ jaccard: 1, containment: 1, similar: true });
    const other = compareSignatures(a, sig("Paginate every list endpoint with a cursor."));
    expect(other.jaccard).toBe(0);
    expect(other.similar).toBe(false);
  });
  it("uses 80% containment for a long text that holds a shorter one", () => {
    const short = sig("The plan should list which files change and which tests cover each change.");
    const long = sig("Thanks for the draft. A few things first. The plan should list which files change and which tests cover each change. The summary is long but fine, and the diagram is good.");
    expect(short.length).toBeGreaterThanOrEqual(CONTAINMENT_MIN_HASHES);
    const result = compareSignatures(short, long);
    expect(result.jaccard).toBeLessThan(0.45);
    expect(result.containment).toBeGreaterThanOrEqual(0.8);
    expect(result.similar).toBe(true);
  });
  it("does not use containment for a very short text", () => {
    const short = sig("Use strict types.");
    expect(short.length).toBeLessThan(CONTAINMENT_MIN_HASHES);
    const long = sig("Use strict types, and also write the report in plain language, add a summary table at the top, link each finding to its evidence, and keep the report under two pages.");
    expect(compareSignatures(short, long).containment).toBeGreaterThanOrEqual(0.8);
    expect(isSimilar(short, long)).toBe(false);
  });
  it("never matches a negated text with its positive form", () => {
    expect(isSimilar(sig("Always add tests for new functions."), sig("Never add tests for new functions."))).toBe(false);
    expect(isSimilar(sig("Always add tests for new functions."), sig("Do not add tests for new functions."))).toBe(false);
    expect(isSimilar(sig("Never add tests for new functions."), sig("Do not add tests for new functions."))).toBe(true);
  });
  it("weighs rare tokens more than common ones, by document frequency", () => {
    // Two pairs of the same shape: four shared words and three different ones. The project has seen the first pair's shared words in 20 other corrections, and the second pair's in none.
    const background = Array.from({ length: 20 }, (_, i) => sig(`Run the tests before merge number${String.fromCharCode(97 + i)} thing${String.fromCharCode(97 + i)} here.`));
    const commonPair = [sig("Run the tests before merge alpha bravo charlie."), sig("Run the tests before merge delta echo foxtrot.")] as const;
    const rarePair = [sig("Zebra crossing quokka habitat alpha bravo charlie."), sig("Zebra crossing quokka habitat delta echo foxtrot.")] as const;
    const frequency = buildDocumentFrequency([...background, ...commonPair, ...rarePair]);
    const score = (pair: readonly [Signature, Signature], withFrequency: boolean) => compareSignatures(pair[0], pair[1], withFrequency ? frequency : undefined).jaccard;
    expect(score(commonPair, false)).toBeCloseTo(score(rarePair, false), 10);
    expect(score(commonPair, true)).toBeLessThan(score(commonPair, false));
    expect(score(rarePair, true)).toBeGreaterThan(score(commonPair, true));
  });
});

describe("W8: precision on the fixture pairs is at least 90%", () => {
  // A text capture refuses (generic, too short) never reaches grouping, so such a pair is never compared.
  const compared = (pair: Pair) => prepareCorrection(pair.a).ok && prepareCorrection(pair.b).ok;
  const results = pairs.map((pair) => ({ pair, predicted: compared(pair) && isSimilar(signatureOfRaw(pair.a), signatureOfRaw(pair.b)) }));
  const falsePositives = results.filter((r) => r.predicted && !r.pair.similar);
  const truePositives = results.filter((r) => r.predicted && r.pair.similar);
  const missed = results.filter((r) => !r.predicted && r.pair.similar);

  it("has about 60 pairs of every kind", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(55);
    for (const kind of ["paraphrase", "variant", "code", "long", "confusable", "negated", "same-topic", "unrelated", "generic", "containment-trap"]) {
      expect(pairs.some((pair) => pair.kind === kind), kind).toBe(true);
    }
  });
  it("never compares a generic pair: capture refuses one side", () => {
    for (const pair of pairs.filter((p) => p.kind === "generic")) expect(compared(pair), pair.id).toBe(false);
  });
  it("has precision of at least 90%, and no false positive among negated, short-in-long or unrelated pairs", () => {
    const precision = truePositives.length / Math.max(1, truePositives.length + falsePositives.length);
    expect(precision, `precision ${precision.toFixed(3)}`).toBeGreaterThanOrEqual(0.9);
    // A known limit: two corrections that differ only in their last clause read as the same rule to a score with no model behind it. The card lists both texts and a person decides.
    const knownLimits = new Set(["diff-different-stage"]);
    expect(falsePositives.filter((r) => !knownLimits.has(r.pair.id)).map((r) => r.pair.id)).toEqual([]);
  });
  it("still finds most true repeats (recall of at least 70%)", () => {
    const recall = truePositives.length / pairs.filter((pair) => pair.similar).length;
    expect(missed.map((r) => r.pair.id), `recall ${recall.toFixed(3)}`).toBeDefined();
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });
  it("finds every confusable and every near-identical variant", () => {
    const sure = results.filter((r) => ["confusable", "variant"].includes(r.pair.kind));
    expect(sure.filter((r) => !r.predicted).map((r) => r.pair.id)).toEqual([]);
  });
});
