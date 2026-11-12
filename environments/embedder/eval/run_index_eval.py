"""The retrieval eval with the KEYWORD INDEX of lanes K2/K3 (DECISIONS 145), run through the PRODUCTION code path. Research only (needs onnxruntime, tokenizers, numpy and a checkout with node_modules; not part of the image).

run_window_eval.py scored a Python copy of the keyword side. This script scores the real one:
  1. it builds the synthetic corpus (corpus.build, row order = time order) and the bge-small rankings of the meaning side (the top `--vector-topk` of ALL rows, as production asks the vector index for);
  2. it hands both to tests/unit/team-record-core/keyword-index-eval.test.ts, which runs the BROKER's code: rows written as hot rows of a fake team-record table, 97 % sealed into index segments by the maintenance job, the newest
     rows left as the live tail, 3 % written late (late markers) into sealed ranges, and every query answered by `recordSearch` (index for the keyword list, the harness's bge-small list for the meaning list, the real RRF, the
     top-30 cut of the keyword list, the reload and the permission filter);
  3. it scores what comes back, next to the Python oracles (BM25 over the best passage of ALL rows; the same blended with RRF and the top-30 cut: `blend-passage-kwtop30 (full)`) and the windowed rows of 0.5.15 and K1.

  python run_index_eval.py --models-dir <dir with bge-small-en-v1.5/> --cache-dir <scratch> --rows 490,5140,20140 --runner "<command that runs the test file in a Rovara worktree>" [--out results-index.json]

Pass bars (design note 5.9): the index's top-10 scores equal the oracle's on every query (same rows, ties aside); fused hit@5 at 5k and 20k rows within 0.01 of the 490-row corpus; fused long-late hit@5 of 0.75 or more.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import corpus  # noqa: E402
import keyword_scoring as ks  # noqa: E402
from run_eval import rrf  # noqa: E402
from run_window_eval import GROUPS, embeddings, metrics  # noqa: E402

RUNNER_TEST = "tests/unit/team-record-core/keyword-index-eval.test.ts"


def run(rows_total: int, args: argparse.Namespace, cache: Path, models_dir: Path, repo: Path) -> dict:
    rows, queries = corpus.build(filler_rows=rows_total - 140)
    index_of = {r["id"]: i for i, r in enumerate(rows)}
    relevant = [{index_of[x] for x in q["relevant"]} for q in queries]
    texts = [r["text"] for r in rows]
    docs_emb = embeddings(texts, "document", cache, models_dir, args.threads)
    q_emb = embeddings([q["query"] for q in queries], "query", cache, models_dir, args.threads)
    vec = [[int(i) for i in np.argsort(-(docs_emb @ qv), kind="stable")[: args.vector_topk]] for qv in q_emb]

    with tempfile.TemporaryDirectory() as scratch:
        source, target = Path(scratch) / "in.json", Path(scratch) / "out.json"
        source.write_text(json.dumps({"rows": [{"text": t} for t in texts], "queries": [{"query": q["query"]} for q in queries], "vector": vec}))
        env = dict(os.environ, KWIDX_EVAL_IN=str(source), KWIDX_EVAL_OUT=str(target))
        started = time.time()
        done = subprocess.run(shlex.split(args.runner) + [RUNNER_TEST], cwd=repo, env=env, capture_output=True, text=True)
        if done.returncode != 0 or not target.exists():
            sys.stderr.write(done.stdout[-4000:] + done.stderr[-4000:])
            raise SystemExit(f"the production runner failed on {rows_total} rows")
        produced = json.loads(target.read_text())
        runner_seconds = round(time.time() - started, 1)

    newest_first = list(range(len(rows) - 1, -1, -1))
    window = newest_first[: args.window]

    def keyword(query: str, size: int | None, positions: list[int]) -> list[int]:
        return ks.keyword_ranking(query, [texts[i] for i in positions], size, positions)

    systems: dict[str, list[list[int]]] = {"bge-small": vec}
    whole = [keyword(q["query"], None, window) for q in queries]
    systems["bm25-whole (window 400, 0.5.15)"] = whole
    systems["blend-whole (window 400, 0.5.15)"] = [rrf([vec[i], whole[i]]) for i in range(len(queries))]
    passage_window = [keyword(q["query"], ks.PASSAGE_TOKENS, window) for q in queries]
    systems["bm25-passage (window 400, K1)"] = passage_window
    systems["blend-passage (window 400, K1)"] = [rrf([vec[i], passage_window[i]]) for i in range(len(queries))]
    oracle = [keyword(q["query"], ks.PASSAGE_TOKENS, newest_first) for q in queries]
    systems["bm25-passage (full, oracle)"] = oracle
    systems[f"blend-passage-kwtop{args.vector_topk} (full, oracle)"] = [rrf([vec[i], oracle[i][: args.vector_topk]]) for i in range(len(queries))]
    systems["bm25-index (production)"] = produced["keyword"]
    systems["blend-index (production recordSearch)"] = produced["blend"]

    out = {}
    for name, per_query_rank in systems.items():
        pq = [metrics(per_query_rank[i], relevant[i]) for i in range(len(queries))]
        out[name] = {g: {k: round(float(np.mean([p[k] for p, q in zip(pq, queries) if pred(q)])), 3) for k in ("hit5", "mrr", "recall5")} for g, pred in GROUPS.items()}
    same_set = sum(1 for i in range(len(queries)) if set(produced["keyword"][i][:10]) == set(oracle[i][: len(produced["keyword"][i][:10])]) or produced["sameTop10"][i])
    return {
        "rows": len(rows), "queries": len(queries), "window": args.window, "systems": out, "runner_seconds": runner_seconds,
        "top10_scores_equal": sum(1 for ok in produced["sameTop10"] if ok), "top10_same_set_or_equal_scores": same_set,
        "index": {k: produced[k] for k in ("buildMs", "coldLoadMs", "lateRows", "shape", "segments")},
    }


def table(result: dict, names: list[str]) -> str:
    cols = list(GROUPS)
    lines = [f"{result['rows']} rows, {result['queries']} queries (window systems read the newest {result['window']} rows; (full) and index systems read all)", "", "| system | " + " | ".join(f"{c}: hit@5 / MRR" for c in cols) + " |", "|---|" + "---|" * len(cols)]
    for n in names:
        r = result["systems"][n]
        lines.append(f"| {n} | " + " | ".join(f"{r[c]['hit5']:.2f} / {r[c]['mrr']:.2f}" for c in cols) + " |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--rows", default="490,5140,20140")
    ap.add_argument("--window", type=int, default=400)
    ap.add_argument("--vector-topk", type=int, default=30)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--runner", required=True, help="the command that runs one vitest file in a Rovara worktree (for example the lane tool `vt`)")
    ap.add_argument("--repo", default=str(HERE.parents[2]))
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    for n in [int(x) for x in args.rows.split(",")]:
        print(f"== {n} rows", flush=True)
        results.append(run(n, args, cache, Path(args.models_dir), Path(args.repo)))
    headline = ["bge-small", "bm25-whole (window 400, 0.5.15)", "blend-whole (window 400, 0.5.15)", "bm25-passage (window 400, K1)", "blend-passage (window 400, K1)", "bm25-passage (full, oracle)", f"blend-passage-kwtop{args.vector_topk} (full, oracle)", "bm25-index (production)", "blend-index (production recordSearch)"]
    for result in results:
        print("\n" + table(result, headline))
        print(f"\nindex vs oracle: top-10 scores equal on {result['top10_scores_equal']} of {result['queries']} queries; index: {json.dumps(result['index'])}")
    base = results[0]["systems"]["blend-index (production recordSearch)"]["all"]["hit5"]
    print("\npass bars")
    for result in results:
        fused = result["systems"]["blend-index (production recordSearch)"]
        print(f"  {result['rows']} rows: top-10 equal on all queries: {result['top10_scores_equal'] == result['queries']}; fused hit@5 {fused['all']['hit5']:.3f} (drop vs {results[0]['rows']} rows: {base - fused['all']['hit5']:+.3f}, bar 0.01); long-late fused hit@5 {fused['long, fact late']['hit5']:.3f} (bar 0.75)")
    if args.out:
        Path(args.out).write_text(json.dumps({"vector_topk": args.vector_topk, "window": args.window, "passage_tokens": ks.PASSAGE_TOKENS, "runs": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
