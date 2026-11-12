"""The keyword side of the Team record search, as the broker does it (lane K1, DECISIONS 145), for the retrieval eval.

Mirrors packages/broker/src/team-record/search-fusion.ts: the tokenizer, BM25 (k1 1.2, b 0.75, idf log(1 + (N - df + 0.5) / (df + 0.5))), the 12-query-word cap, and the PASSAGE RULE:
  - a document of at most PASSAGE_TOKENS tokens (or an empty one) is ONE passage, itself;
  - a longer one has windows of PASSAGE_TOKENS tokens starting at 0, PASSAGE_STEP, 2 x PASSAGE_STEP, ...; the last window is the FIRST one that reaches the end of the document;
  - N, df and the average length are over ALL passages of all documents given, and a document's score is the best score of any of its passages.
The tokenizer is the eval's own (ASCII letters and digits; the broker's also keeps other scripts, which the synthetic corpus does not use).
"""
from __future__ import annotations

import math
import re

PASSAGE_TOKENS = 80
PASSAGE_STEP = PASSAGE_TOKENS // 2


def tokenize(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [re.sub(r"(ing|ed|es|s)$", "", w) if len(w) > 4 else w for w in words]


def passage_ranges(count: int, size: int = PASSAGE_TOKENS) -> list[tuple[int, int]]:
    """The [start, end) token ranges of the passages of a document of `count` tokens."""
    if count <= size:
        return [(0, count)]
    step = max(1, size // 2)
    out, start = [], 0
    while True:
        out.append((start, min(count, start + size)))
        if start + size >= count:
            return out
        start += step


def best_passage_scores(query: str, documents: list[str], size: int | None = PASSAGE_TOKENS, k1: float = 1.2, b: float = 0.75) -> list[float]:
    """One score per document: the BM25 of its best passage (`size` tokens; None scores the document whole). 0 for a document with none of the query's words."""
    needles = [w for w in dict.fromkeys(tokenize(query)) if len(w) >= 2][:12]
    if not needles or not documents:
        return [0.0] * len(documents)
    wanted = set(needles)
    passages: list[tuple[int, int, dict[str, int]]] = []  # (owner, length, counts of the query's words)
    for owner, document in enumerate(documents):
        tokens = tokenize(document)
        for start, end in passage_ranges(len(tokens), size if size is not None else 10**12):
            counts: dict[str, int] = {}
            for token in tokens[start:end]:
                if token in wanted:
                    counts[token] = counts.get(token, 0) + 1
            passages.append((owner, end - start, counts))
    average = sum(p[1] for p in passages) / len(passages) or 1.0
    n = len(passages)
    idf = {}
    for word in needles:
        containing = sum(1 for p in passages if word in p[2])
        idf[word] = math.log(1 + (n - containing + 0.5) / (containing + 0.5))
    best = [0.0] * len(documents)
    for owner, length, counts in passages:
        score = 0.0
        for word in needles:
            f = counts.get(word)
            if f:
                score += idf[word] * f * (k1 + 1) / (f + k1 * (1 - b + b * length / average))
        if score > best[owner]:
            best[owner] = score
    return best


def keyword_ranking(query: str, documents: list[str], size: int | None, positions: list[int] | None = None) -> list[int]:
    """Row indexes with a positive score, best first, ties in the order given (newest first in the broker; the eval passes `positions` newest first). `positions` maps document i to its row index."""
    scores = best_passage_scores(query, documents, size)
    rows = positions if positions is not None else list(range(len(documents)))
    order = sorted(range(len(documents)), key=lambda i: -scores[i])
    return [rows[i] for i in order if scores[i] > 0]
