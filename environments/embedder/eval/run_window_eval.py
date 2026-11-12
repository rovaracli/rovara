"""Keyword-side eval for the team record search on a TIME-ORDERED corpus (lane K1, DECISIONS 145). Research only (needs onnxruntime, tokenizers, numpy; not part of the image).

The corpus is corpus.build(filler_rows=N) with its row order read as time order (oldest first), so the topic rows, the long documents and the filler are spread through time the way a growing project's rows are.
The search reads ONLY the newest WINDOW rows for the keyword side (KEYWORD_SCAN_ROWS = 400, query.ts) and asks the vector index about ALL rows, then fuses the two lists with RRF (k 60). This script reports hit@5 and
MRR (and recall@5) of:
  bm25-whole    BM25 per whole row (what the search did before K1), over the window
  bm25-passage  BM25 per best passage (keyword_scoring.py, the broker's passage rule), over the window
  bge-small     the meaning side alone: the top `--vector-topk` rows of ALL rows (production: limit x 3 = 30)
  blend-whole   bge-small + bm25-whole (RRF)        [what shipped in 0.5.15]
  blend-passage bge-small + bm25-passage (RRF)      [K1]
plus `(full)` variants of the BM25 and blend rows that score ALL rows instead of the window (what the keyword index of lanes K2-K4 would give: the upper bound for the window).

  python run_window_eval.py --models-dir <dir with bge-small-en-v1.5/> --cache-dir <scratch> --rows 490,2140,5140,10140 [--window 400] [--sweep 60,80,100,120] [--out results.json]
Embeddings are cached by text, so a larger corpus only embeds its new rows.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import corpus  # noqa: E402
import keyword_scoring as ks  # noqa: E402
from run_eval import MODELS, embed_all, rrf  # noqa: E402

GROUPS = {
    "all": lambda q: True,
    "short rows": lambda q: q["kind"] in ("para", "why", "ident"),
    "long, fact late": lambda q: q["kind"] == "long-late",
    "long, fact early": lambda q: q["kind"] == "long-early",
}


def metrics(ranked: list[int], relevant: set[int]) -> dict[str, float]:
    first = next((pos + 1 for pos, d in enumerate(ranked) if d in relevant), None)
    return {"hit5": float(first is not None and first <= 5), "mrr": 1.0 / first if first else 0.0, "recall5": len(set(ranked[:5]) & relevant) / min(len(relevant), 5)}


def embeddings(texts: list[str], kind: str, cache: Path, models_dir: Path, threads: int) -> np.ndarray:
    """Unit vectors of bge-small-fp32 (no instruction prefix) for texts, cached by (kind, text)."""
    path = cache / "bge-small-fp32-text-cache.pkl"
    store: dict[str, np.ndarray] = pickle.loads(path.read_bytes()) if path.exists() else {}
    key = lambda t: hashlib.sha256((kind + "\0" + t).encode()).hexdigest()  # noqa: E731
    missing = [t for t in dict.fromkeys(texts) if key(t) not in store]
    if missing:
        print(f"  embedding {len(missing)} {kind} texts ...", flush=True)
        vectors, _ = embed_all("bge-small-fp32", MODELS["bge-small-fp32"], models_dir, [(kind, t) for t in missing], threads)
        for t, v in zip(missing, vectors):
            store[key(t)] = v
        path.write_bytes(pickle.dumps(store))
    return np.asarray([store[key(t)] for t in texts], dtype=np.float32)


def run(rows_total: int, window: int, args: argparse.Namespace, cache: Path, models_dir: Path) -> dict:
    rows, queries = corpus.build(filler_rows=rows_total - 140)
    index_of = {r["id"]: i for i, r in enumerate(rows)}
    relevant = [{index_of[x] for x in q["relevant"]} for q in queries]
    texts = [r["text"] for r in rows]
    docs_emb = embeddings(texts, "document", cache, models_dir, args.threads)
    q_emb = embeddings([q["query"] for q in queries], "query", cache, models_dir, args.threads)

    newest_first = list(range(len(rows) - 1, -1, -1))  # time order: the last row is the newest; the broker reads newest first and keeps ties in that order
    windowed = newest_first[:window]

    def keyword(query: str, size: int | None, positions: list[int]) -> list[int]:
        return ks.keyword_ranking(query, [texts[i] for i in positions], size, positions)

    systems: dict[str, list[list[int]]] = {}
    vec = [[int(i) for i in np.argsort(-(docs_emb @ qv), kind="stable")[: args.vector_topk]] for qv in q_emb]
    systems["bge-small"] = vec
    sizes = [("passage", ks.PASSAGE_TOKENS)] + [(f"passage-{s}", s) for s in args.sweep if s != ks.PASSAGE_TOKENS]
    for scope, positions in (("window", windowed), ("full", newest_first)):
        suffix = "" if scope == "window" else " (full)"
        whole = [keyword(q["query"], None, positions) for q in queries]
        systems[f"bm25-whole{suffix}"] = whole
        systems[f"blend-whole{suffix}"] = [rrf([vec[i], whole[i]]) for i in range(len(queries))]
        for label, size in sizes:
            ranked = [keyword(q["query"], size, positions) for q in queries]
            systems[f"bm25-{label}{suffix}"] = ranked
            systems[f"blend-{label}{suffix}"] = [rrf([vec[i], ranked[i]]) for i in range(len(queries))]
            if label == "passage":
                # not what the broker does (it fuses the whole keyword list): each list cut to the same top-K, to show what deep keyword ranks add to a fused score
                systems[f"blend-passage-kwtop{args.vector_topk}{suffix}"] = [rrf([vec[i], ranked[i][: args.vector_topk]]) for i in range(len(queries))]
    out = {}
    for name, per_query_rank in systems.items():
        pq = [metrics(per_query_rank[i], relevant[i]) for i in range(len(queries))]
        out[name] = {g: {k: round(float(np.mean([p[k] for p, q in zip(pq, queries) if pred(q)])), 3) for k in ("hit5", "mrr", "recall5")} for g, pred in GROUPS.items()}
    return {"rows": len(rows), "queries": len(queries), "window": window, "systems": out}


def table(result: dict, names: list[str]) -> str:
    cols = list(GROUPS)
    lines = [f"{result['rows']} rows, {result['queries']} queries, keyword window = newest {result['window']} rows", "", "| system | " + " | ".join(f"{c}: hit@5 / MRR" for c in cols) + " |", "|---|" + "---|" * len(cols)]
    for n in names:
        r = result["systems"][n]
        lines.append(f"| {n} | " + " | ".join(f"{r[c]['hit5']:.2f} / {r[c]['mrr']:.2f}" for c in cols) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--rows", default="490,2140,5140,10140")
    ap.add_argument("--window", type=int, default=400)
    ap.add_argument("--vector-topk", type=int, default=30)
    ap.add_argument("--sweep", default="60,100,120", help="extra passage sizes (tokens) to report next to the broker's")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    args.sweep = [int(x) for x in args.sweep.split(",") if x]
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    for n in [int(x) for x in args.rows.split(",")]:
        print(f"== {n} rows", flush=True)
        results.append(run(n, args.window, args, cache, Path(args.models_dir)))
    headline = ["bm25-whole", "bm25-passage", "bge-small", "blend-whole", "blend-passage", f"blend-passage-kwtop{args.vector_topk}", "bm25-whole (full)", "bm25-passage (full)", "blend-whole (full)", "blend-passage (full)", f"blend-passage-kwtop{args.vector_topk} (full)"]
    for result in results:
        print("\n" + table(result, headline))
    print("\npassage size sweep (tokens; the broker uses", ks.PASSAGE_TOKENS, ")")
    for result in results:
        print("\n" + table(result, [f"{p}-{s}{x}" for x in ("", " (full)") for p in ("bm25", "blend") for s in ["passage"] + [f"passage-{t}" for t in args.sweep if t != ks.PASSAGE_TOKENS]]))
    if args.out:
        Path(args.out).write_text(json.dumps({"passage_tokens": ks.PASSAGE_TOKENS, "window": args.window, "vector_topk": args.vector_topk, "runs": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
