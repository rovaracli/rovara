"""Retrieval eval for the team record's embedder (lane L0). Compares BM25 and dense models, each alone and as a hybrid with BM25, on the synthetic corpus
in corpus.py. Reports recall@5, hit@5 and MRR (per query group), plus a paired bootstrap of the small-vs-base gap.

Run on a host with onnxruntime, tokenizers and numpy (not part of the image; research only):
  python run_eval.py --models-dir <dir with bge-small-en-v1.5/, bge-base-en-v1.5/, Qwen3-Embedding-0.6B-ONNX/> --cache-dir <scratch> [--out results.json]
Each model folder holds tokenizer.json and onnx/ (community ONNX exports of the pinned models). Texts are prepared with the same functions as the production
embedder (embedder_core.prepare_text and token_ids), so the 512-token cut of bge and the 2,048-token cut of Qwen3 behave as in the Lambda. Latency here is NOT measured (host CPU).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "app"))
import corpus  # noqa: E402
import embedder_core as core  # noqa: E402

BGE_INSTRUCTION = "Represent this sentence for searching relevant passages: "
QWEN_INSTRUCTION = "Instruct: Given a question about a team's past engineering work, retrieve the records that answer it\nQuery:"

MODELS = {
    "bge-small-fp32": dict(folder="bge-small-en-v1.5", onnx="model.onnx", pooling="cls", max=512, prefix=["[CLS]"], suffix=["[SEP]"], instr=BGE_INSTRUCTION),
    "bge-small-int8": dict(folder="bge-small-en-v1.5", onnx="model_quantized.onnx", pooling="cls", max=512, prefix=["[CLS]"], suffix=["[SEP]"], instr=BGE_INSTRUCTION),
    "bge-base-int8": dict(folder="bge-base-en-v1.5", onnx="model_quantized.onnx", pooling="cls", max=512, prefix=["[CLS]"], suffix=["[SEP]"], instr=BGE_INSTRUCTION),
    "qwen3-int8": dict(folder="Qwen3-Embedding-0.6B-ONNX", onnx="model_quantized.onnx", pooling="last_token", max=2048, prefix=[], suffix=["<|endoftext|>"], instr=QWEN_INSTRUCTION),
}


def embed_all(name: str, cfg: dict, models_dir: Path, texts: list[tuple[str, str]], threads: int) -> tuple[np.ndarray, int]:
    """texts = [(kind, text)]. Returns unit vectors and how many texts were cut at the token limit."""
    import onnxruntime as ort
    from tokenizers import Tokenizer

    folder = models_dir / cfg["folder"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.log_severity_level = 3
    session = ort.InferenceSession(str(folder / "onnx" / cfg["onnx"]), options, providers=["CPUExecutionProvider"])
    tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
    names = {i.name for i in session.get_inputs()}
    manifest = {"prefix": cfg["prefix"], "suffix": cfg["suffix"], "maxTokens": cfg["max"], "queryPrefix": cfg["instr"], "pooling": cfg["pooling"]}
    special = {t: tokenizer.token_to_id(t) for t in cfg["prefix"] + cfg["suffix"]}
    strip = tuple(t.content for t in tokenizer.get_added_tokens_decoder().values())
    plain = lambda s: list(tokenizer.encode(s, add_special_tokens=False).ids)  # noqa: E731
    out, cut = [], 0
    for kind, text in texts:
        ids, was_cut = core.token_ids(manifest, plain, special, core.prepare_text(manifest, text, kind, strip))
        cut += was_cut
        a = np.asarray([ids], dtype=np.int64)
        feed = {"input_ids": a, "attention_mask": np.ones_like(a)}
        if "token_type_ids" in names:
            feed["token_type_ids"] = np.zeros_like(a)
        if "position_ids" in names:
            feed["position_ids"] = np.arange(a.shape[1], dtype=np.int64)[None, :]
        for i in session.get_inputs():
            if i.name.startswith("past_key_values"):
                feed[i.name] = np.zeros([1, i.shape[1], 0, i.shape[3]], dtype=np.float32)
        h = session.run([session.get_outputs()[0].name], feed)[0][0]
        v = h[-1] if cfg["pooling"] == "last_token" else h[0]
        out.append(v / np.linalg.norm(v))
    return np.asarray(out, dtype=np.float32), cut


def tokenize(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [re.sub(r"(ing|ed|es|s)$", "", w) if len(w) > 4 else w for w in words]


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.2, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.tf = []
        df: dict[str, int] = {}
        for d in docs:
            counts: dict[str, int] = {}
            for t in tokenize(d):
                counts[t] = counts.get(t, 0) + 1
            self.tf.append(counts)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        self.len = np.array([sum(c.values()) for c in self.tf], dtype=np.float32)
        self.avg = float(self.len.mean())
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def scores(self, query: str) -> np.ndarray:
        s = np.zeros(len(self.tf), dtype=np.float32)
        for t in set(tokenize(query)):
            if t not in self.idf:
                continue
            for i, c in enumerate(self.tf):
                f = c.get(t)
                if f:
                    s[i] += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
        return s


def ranking(scores: np.ndarray) -> list[int]:
    return list(np.argsort(-scores, kind="stable"))


def rrf(rankings: list[list[int]], k: int = 60) -> list[int]:
    total: dict[int, float] = {}
    for r in rankings:
        for pos, doc in enumerate(r):
            total[doc] = total.get(doc, 0.0) + 1.0 / (k + pos + 1)
    return sorted(total, key=lambda d: -total[d])


def per_query(rank: list[int], relevant: set[int]) -> dict[str, float]:
    first = next((pos + 1 for pos, d in enumerate(rank) if d in relevant), len(rank) + 1)
    top5 = set(rank[:5])
    return {"hit1": float(first == 1), "hit5": float(first <= 5), "mrr": 1.0 / first, "recall5": len(top5 & relevant) / min(len(relevant), 5)}


def summarize(per: list[dict[str, float]]) -> dict[str, float]:
    return {k: round(float(np.mean([p[k] for p in per])), 3) for k in ("hit1", "hit5", "mrr", "recall5")} if per else {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--models", default=",".join(MODELS))
    args = ap.parse_args()
    models_dir, cache = Path(args.models_dir), Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)

    rows, queries = corpus.build()
    index_of = {r["id"]: i for i, r in enumerate(rows)}
    relevant = [{index_of[x] for x in q["relevant"]} for q in queries]
    docs = [r["text"] for r in rows]

    bm = BM25(docs)
    rankings: dict[str, list[list[int]]] = {"bm25": [ranking(bm.scores(q["query"])) for q in queries]}

    info: dict[str, dict] = {}
    for name in args.models.split(","):
        cfg = MODELS[name]
        f = cache / f"{name}-docs.npy"
        t0 = time.time()
        if f.exists():
            demb = np.load(f)
            cut = int(json.loads((cache / f"{name}-cut.json").read_text()))
        else:
            demb, cut = embed_all(name, cfg, models_dir, [("document", d) for d in docs], args.threads)
            np.save(f, demb)
            (cache / f"{name}-cut.json").write_text(json.dumps(cut))
        variants = {"": cfg["instr"] if name.startswith("qwen") else ""}
        if name.startswith("bge"):
            variants = {"": "", "+instr": cfg["instr"]}
        for suffix, prefix in variants.items():
            label = name + suffix
            qf = cache / f"{label}-queries.npy"
            if qf.exists():
                qemb = np.load(qf)
            else:
                run_cfg = dict(cfg, instr=prefix)
                qemb, _ = embed_all(name, run_cfg, models_dir, [("query", q["query"]) for q in queries], args.threads)
                np.save(qf, qemb)
            rankings[label] = [ranking(demb @ qv) for qv in qemb]
            info[label] = {"docs_cut_at_token_limit": cut, "seconds": round(time.time() - t0, 1)}
    for label in [k for k in rankings if k != "bm25"]:
        rankings[label + "+bm25"] = [rrf([rankings[label][i], rankings["bm25"][i]]) for i in range(len(queries))]

    groups = {
        "all": lambda q: True,
        "short rows (topic+ident)": lambda q: q["kind"] in ("para", "why", "ident"),
        "topic (para+why)": lambda q: q["kind"] in ("para", "why"),
        "ident": lambda q: q["kind"] == "ident",
        "long, fact late": lambda q: q["kind"] == "long-late",
        "long, fact early": lambda q: q["kind"] == "long-early",
    }
    results: dict[str, dict] = {}
    for label, rs in rankings.items():
        pq = [per_query(rs[i], relevant[i]) for i in range(len(queries))]
        results[label] = {g: summarize([p for p, q in zip(pq, queries) if pred(q)]) for g, pred in groups.items()}
        results[label]["_per_query_mrr"] = [round(p["mrr"], 4) for p in pq]
        results[label]["_per_query_hit5"] = [p["hit5"] for p in pq]

    # paired bootstrap of small vs base (best variants), on all queries
    def boot(a: str, b: str, key: str, mask: list[bool]) -> dict:
        x, y = np.array(results[a][key])[mask], np.array(results[b][key])[mask]
        rng = random.Random(7)
        diffs = []
        for _ in range(4000):
            idx = [rng.randrange(len(x)) for _ in range(len(x))]
            diffs.append(float(np.mean(x[idx] - y[idx])))
        diffs.sort()
        return {"mean_diff": round(float(np.mean(x - y)), 3), "ci95": [round(diffs[100], 3), round(diffs[3899], 3)]}

    comparisons = {}
    for a, b in [("bge-small-fp32+bm25", "bge-base-int8+bm25"), ("bge-small-fp32", "bge-base-int8"), ("bge-small-fp32+instr", "bge-base-int8+instr"),
                 ("bge-small-fp32+bm25", "qwen3-int8+bm25"), ("bge-small-fp32", "qwen3-int8")]:
        if a in results and b in results:
            for scope, pick in (("all", lambda q: True), ("short rows", groups["short rows (topic+ident)"])):
                mask = [bool(pick(q)) for q in queries]
                comparisons[f"{a} minus {b} [{scope}]"] = {"mrr": boot(a, b, "_per_query_mrr", mask), "hit5": boot(a, b, "_per_query_hit5", mask)}

    print(f"{len(rows)} rows, {len(queries)} queries ({sum(1 for r in rows if r['kind'] == 'long')} long documents)\n")
    cols = ["all", "short rows (topic+ident)", "topic (para+why)", "ident", "long, fact late", "long, fact early"]
    print("| system | " + " | ".join(f"{c}: hit@5 / MRR" for c in cols) + " | all: recall@5 |")
    print("|---|" + "---|" * (len(cols) + 1))
    for label, r in results.items():
        print(f"| {label} | " + " | ".join(f"{r[c]['hit5']:.2f} / {r[c]['mrr']:.2f}" for c in cols) + f" | {r['all']['recall5']:.2f} |")
    print("\npaired bootstrap (A minus B; positive = A better):")
    for k, v in comparisons.items():
        print(f"  {k}: MRR {v['mrr']['mean_diff']:+.3f} CI {v['mrr']['ci95']}; hit@5 {v['hit5']['mean_diff']:+.3f} CI {v['hit5']['ci95']}")
    print("\nmodel info:", json.dumps(info))
    if args.out:
        slim = {k: {g: v for g, v in r.items() if not g.startswith("_")} for k, r in results.items()}
        Path(args.out).write_text(json.dumps({"rows": len(rows), "queries": len(queries), "results": slim, "comparisons": comparisons, "info": info}, indent=2) + "\n")


if __name__ == "__main__":
    main()
