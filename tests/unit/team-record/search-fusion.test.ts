// DECISIONS 142: the two pure parts of the always-blended Team record search: BM25 for the keyword side and reciprocal rank fusion.
import { describe, expect, it } from "vitest";
import { RRF_K, bm25Scores, keywordTokens, reciprocalRankFusion } from "../../../packages/broker/src/team-record/search-fusion.js";

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
