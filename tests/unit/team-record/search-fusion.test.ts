// DECISIONS 142: the two pure parts of the always-blended Team record search: BM25 for the keyword side and reciprocal rank fusion.
import { describe, expect, it } from "vitest";
import { PASSAGE_STEP, PASSAGE_TOKENS, RRF_K, bm25PassageScores, bm25Scores, keywordTokens, passageRanges, reciprocalRankFusion } from "../../../packages/broker/src/team-record/search-fusion.js";

describe("reciprocal rank fusion", () => {
  it("uses k = 60, as the retrieval eval did", () => {
    expect(RRF_K).toBe(60);
    expect(reciprocalRankFusion([["a"]])[0]!.score).toBeCloseTo(1 / 61, 12);
  });
  it("an id in both lists ranks above ids in one; the sum of 1/(k+rank) decides the rest", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "d"]]);
    expect(fused.map((entry) => entry.id)).toEqual(["c", "a", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[1]!.score).toBeCloseTo(1 / 61, 12);
    expect(fused[2]!.score).toBeCloseTo(1 / 62, 12);
    expect(fused[3]!.score).toBeCloseTo(1 / 62, 12);
  });
  it("equal scores keep the order of first appearance (the first list is read first), an empty list adds nothing, and a repeated id in one list counts once", () => {
    expect(reciprocalRankFusion([["x", "y"], ["y2", "x2"]]).map((entry) => entry.id)).toEqual(["x", "y2", "y", "x2"]);
    expect(reciprocalRankFusion([[], ["a", "b"]]).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(reciprocalRankFusion([["a", "a", "b"]]).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});

describe("the keyword side's BM25", () => {
  it("tokenizes letters and digits in any script, lower case, with a light plural and tense strip on long words", () => {
    expect(keywordTokens("Retrying the Deploys, 3 timeouts; PR-1234 \u00fcber")).toEqual(["retry", "the", "deploy", "3", "timeout", "pr", "1234", "\u00fcber"]);
  });
  it("scores a document with the query's words above one without them, a rarer word above a common one, and 0 for no match", () => {
    const docs = ["rollout failed after the migration", "the the the the the", "migration notes for the team", "unrelated text"];
    const scores = bm25Scores("rollout migration", docs);
    expect(scores[0]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(0);
    expect(scores[1]).toBe(0);
    expect(scores[3]).toBe(0);
    expect(bm25Scores("", docs)).toEqual([0, 0, 0, 0]);
    expect(bm25Scores("anything", [])).toEqual([]);
  });
  it("finds a word at the very end of a long text (the whole kept text is read, not the part the embedder saw)", () => {
    const long = `${"filler words about nothing in particular. ".repeat(300)} zanzibar`;
    const scores = bm25Scores("zanzibar", ["short unrelated", long]);
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeGreaterThan(0);
  });
});

describe("the keyword side scores each row by its best passage (K1, DECISIONS 145)", () => {
  const rankOf = (scores: number[], index: number): number => 1 + scores.filter((score) => score > (scores[index] as number)).length;
  const filler = (count: number): string => Array.from({ length: count }, (_, i) => `routine${String(i % 37)} note${String(i % 11)} about planning`).join(" ");

  it("the passage rule: one passage up to PASSAGE_TOKENS tokens, then windows of PASSAGE_TOKENS tokens every PASSAGE_STEP; the last is the first window that reaches the end", () => {
    expect(PASSAGE_STEP * 2).toBe(PASSAGE_TOKENS);
    expect(passageRanges(0)).toEqual([[0, 0]]);
    expect(passageRanges(1)).toEqual([[0, 1]]);
    expect(passageRanges(PASSAGE_TOKENS)).toEqual([[0, PASSAGE_TOKENS]]);
    expect(passageRanges(PASSAGE_TOKENS + 1)).toEqual([[0, PASSAGE_TOKENS], [PASSAGE_STEP, PASSAGE_TOKENS + 1]]);
    expect(passageRanges(PASSAGE_TOKENS + PASSAGE_STEP)).toEqual([[0, PASSAGE_TOKENS], [PASSAGE_STEP, PASSAGE_TOKENS + PASSAGE_STEP]]);
    expect(passageRanges(PASSAGE_TOKENS + PASSAGE_STEP + 1)).toEqual([[0, PASSAGE_TOKENS], [PASSAGE_STEP, PASSAGE_TOKENS + PASSAGE_STEP], [PASSAGE_TOKENS, PASSAGE_TOKENS + PASSAGE_STEP + 1]]);
    // every token is in a window, no window starts after the one that reaches the end, and no window is shorter than PASSAGE_STEP + 1 (but the only one)
    for (const count of [101, 149, 150, 151, 299, 300, 301, 1_234]) {
      const ranges = passageRanges(count);
      expect(ranges[0]![0]).toBe(0);
      expect(ranges[ranges.length - 1]![1]).toBe(count);
      for (const [from, to] of ranges.slice(0, -1)) expect(to - from).toBe(PASSAGE_TOKENS);
      const last = ranges[ranges.length - 1]!;
      expect(last[1] - last[0]).toBeGreaterThan(PASSAGE_STEP);
      expect(last[1] - last[0]).toBeLessThanOrEqual(PASSAGE_TOKENS);
      ranges.slice(1).forEach(([from], i) => expect(from - ranges[i]![0]).toBe(PASSAGE_STEP));
    }
  });

  it("finds a fact about 4,000 characters into a long row, which whole-row BM25 buries under short rows that hold one of the words", () => {
    const long = `${filler(135)} The zanzibar cutover freeze starts on friday.`;
    expect(long.indexOf("zanzibar")).toBeGreaterThanOrEqual(4_000);
    const documents = [
      long,
      "zanzibar notes", "zanzibar budget review", "zanzibar hiring plan", "cutover checklist done", "cutover owner list", "freeze window calendar",
      "unrelated release note", "another unrelated change", "yet another routine row",
    ];
    const whole = bm25Scores("zanzibar cutover freeze", documents);
    const passage = bm25PassageScores("zanzibar cutover freeze", documents);
    // the control: the old scorer ranks the long row below short rows that hold only one of the words (the length penalty)
    expect(rankOf(whole, 0)).toBeGreaterThan(1);
    expect(rankOf(passage, 0)).toBe(1);
    expect(passage[0]).toBeGreaterThan(0);
  });

  it("finds a fact in the middle of a long row and at its very end, and 0 for a row without the words", () => {
    const middle = `${filler(220)} zanzibar cutover freeze ${filler(220)}`;
    const end = `${filler(250)} zanzibar cutover freeze`;
    const scores = bm25PassageScores("zanzibar cutover freeze", [middle, end, "short unrelated row", filler(300)]);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[1]).toBeGreaterThan(0);
    expect(scores[2]).toBe(0);
    expect(scores[3]).toBe(0);
  });

  it("scores a row of at most PASSAGE_TOKENS tokens exactly as the whole-row BM25 does, so the ranking of short rows is unchanged", () => {
    const documents = [
      "rollout failed after the migration", "the the the the the", "migration notes for the team", "unrelated text", "",
      "Retry timeouts in the billing service need withRetry and a jitter.", "Billing timeouts again: retry storm in the matching service.", filler(Math.floor(PASSAGE_TOKENS / 4) - 1),
      `${"word ".repeat(PASSAGE_TOKENS - 1)}rollout`,
    ];
    for (const query of ["rollout migration", "billing retry timeouts", "withRetry jitter", "the", "nothing matches this", ""]) {
      expect(bm25PassageScores(query, documents)).toEqual(bm25Scores(query, documents));
    }
    const ranking = (scores: number[]) => scores.map((score, index) => ({ score, index })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.index);
    expect(ranking(bm25PassageScores("billing retry", documents))).toEqual(ranking(bm25Scores("billing retry", documents)));
  });

  it("a long row's score is its best passage's, never a sum over its passages: a word repeated in many far-apart passages does not outrank one passage that holds both words", () => {
    const spread = Array.from({ length: 6 }, () => `${filler(50)} zanzibar`).join(" ");
    const documents = [spread, "zanzibar cutover", "unrelated release note", "another unrelated change", "yet another routine row", "weekly planning minutes"];
    const scores = bm25PassageScores("zanzibar cutover", documents);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[1]).toBeGreaterThan(scores[0] as number);
  });
});
