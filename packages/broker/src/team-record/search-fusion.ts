// DECISIONS 142 (owner, 2026-11-12): every Team record search blends the keyword results and the meaning (vector) results with reciprocal rank fusion (RRF). The retrieval eval of lane
// fix/0515-embedder-small-model (environments/embedder/eval) measured it: bge-small alone 0.78 hit@5 / 0.72 MRR, BM25 alone 0.82 / 0.79, bge-small + BM25 with RRF 0.84 / 0.79 (the
// numbers also hold the other dense models' gain from the blend). This file holds the two pure parts: the keyword ranking (BM25, the same one the eval used) and the fusion (the same k).

/** The RRF constant: the eval used 60 (the usual value); a document at rank r of a list adds 1 / (RRF_K + r) to its score. */
export const RRF_K = 60;

/** Words of a text for the keyword ranking: letters and digits, lower case, a light plural/tense strip on words over four letters (the eval's tokenizer, with Unicode letters). */
export function keywordTokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0).map((word) => (word.length > 4 ? word.replace(/(ing|ed|es|s)$/u, "") : word));
}

/**
 * BM25 (k1 1.2, b 0.75) of each document for the query, over exactly the documents given (the idf is theirs: for the search that is the newest rows it reads, `KEYWORD_SCAN_ROWS`, and the facts). Returns one
 * score per document, 0 for a document with none of the query's words. At most 12 query words count (as before).
 */
export function bm25Scores(query: string, documents: readonly string[]): number[] {
  const needles = [...new Set(keywordTokens(query))].filter((word) => word.length >= 2).slice(0, 12);
  if (needles.length === 0 || documents.length === 0) return documents.map(() => 0);
  const counted = documents.map((document) => {
    const counts = new Map<string, number>();
    const tokens = keywordTokens(document);
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { counts, length: tokens.length };
  });
  const average = counted.reduce((sum, entry) => sum + entry.length, 0) / counted.length || 1;
  const n = documents.length;
  const idf = new Map<string, number>();
  for (const word of needles) {
    const containing = counted.filter((entry) => entry.counts.has(word)).length;
    idf.set(word, Math.log(1 + (n - containing + 0.5) / (containing + 0.5)));
  }
  return counted.map((entry) => {
    let score = 0;
    for (const word of needles) {
      const frequency = entry.counts.get(word);
      if (frequency !== undefined) score += (idf.get(word) as number) * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * entry.length / average));
    }
    return score;
  });
}

/** One ranked list's rank (1 is best) for every id in it, in the order given. */
export function ranksOf(ids: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of ids) if (!ranks.has(id)) ranks.set(id, ranks.size + 1);
  return ranks;
}

/** Reciprocal rank fusion of ranked lists of ids (best first): the score of an id is the sum of 1 / (RRF_K + rank) over the lists it is in. Ids in several lists rank above ids in one. Best first; ties keep the order of first appearance. */
export function reciprocalRankFusion(lists: ReadonlyArray<readonly string[]>): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  for (const list of lists) for (const [id, rank] of ranksOf(list)) score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank));
  return [...score].map(([id, value]) => ({ id, score: value })).sort((left, right) => right.score - left.score);
}
