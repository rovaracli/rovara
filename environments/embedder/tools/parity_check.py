"""Parity check: the run-time path (embedder_core over the exported fp32 ONNX model) against the reference (sentence-transformers on the
original weights). Run by hand after export_models.py, and by the image build as a gate (the Dockerfile fails under the threshold).

    python parity_check.py --models /models --reference-dir DIR --lock models.lock.json 

Needs sentence-transformers and torch, so it is a BUILD-stage tool; the Lambda image does not have them.
Reports per model: the lowest and mean cosine between the two vectors of each sample text, and the rank agreement of a small
retrieval sample (does the exported model put the same document first), and a text longer than the token budget (cut the same way, and flagged).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent / "app", HERE / "app"):
    sys.path.insert(0, str(candidate))

from embedder_core import Embedder  # noqa: E402

DOCUMENTS = [
    "Never import from the legacy payments module; use packages/billing/src/charge.ts instead.",
    "Always run the contract tests after changing a zod schema in packages/contracts.",
    "The broker Lambda has a 4 KB environment budget, so derive names from the environment instead of passing variables.",
    "Release notes are written by the controller, not by lane builders.",
    "Slack channel ids start with C for public channels and G for older private ones.",
    "When a test needs a clock, inject `now` as a parameter; never call Date.now() inside the function under test.",
    "Retry transient AWS faults a bounded number of times; a deterministic refusal is final.",
    "Do not log free text from model errors; map them to fixed codes from an allow-list.",
    "The team record keeps raw Slack text for at most thirty days and then only the distilled facts.",
    "A pull request that changes IAM must list every added action and the exact resource ARN.",
    "Use mkdtemp(tmpdir()) in tests; absolute paths such as /Users/... break Linux CI.",
    "Python services pin exact versions and build in a container with no network at run time.",
]
QUERIES = [
    ("Which module should replace the old payments code?", 0),
    ("What should I run after editing a schema?", 1),
    ("Why can't I add another environment variable to the broker?", 2),
    ("How long do we keep raw Slack messages?", 8),
    ("How should tests get the current time?", 5),
    ("Rules for AWS permissions in PRs", 9),
]


# A text far over every model's token budget: the exported model and the reference must agree on it after the cut, and the function must say it cut.
LONG_DOCUMENT = " ".join(DOCUMENTS) * 15  # about 16,000 characters: over 2,048 tokens, under the function's character limit


MIN_COSINE = 0.999


def cosine(a, b) -> float:
    return float(sum(x * y for x, y in zip(a, b)))


def reference_vectors(spec: dict, files: Path, texts: list[str], prompt: str) -> list[list[float]]:
    import torch
    from sentence_transformers import SentenceTransformer

    # fp32 like the exported model: the Qwen weights are stored in bfloat16, which sentence-transformers would otherwise keep (and compare against with a bf16 rounding error).
    model = SentenceTransformer(str(files), device="cpu", model_kwargs={"dtype": torch.float32})
    model.max_seq_length = spec["maxTokens"]
    out = model.encode([f"{prompt}{t}" for t in texts], normalize_embeddings=True, batch_size=1)
    return [[float(v) for v in row] for row in out]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--reference-dir", required=True, help="<name>/ = the FULL pinned snapshot (with modules.json and 1_Pooling), e.g. huggingface_hub.snapshot_download(repo, revision=...)")
    parser.add_argument("--lock", required=True)
    parser.add_argument("--min-cosine", type=float, default=MIN_COSINE, help="floor for the worst cosine between our vector and the reference's (fp32 both sides)")
    args = parser.parse_args()
    lock = json.loads(Path(args.lock).read_text(encoding="utf-8"))
    embedder = Embedder(Path(args.models))
    failed = False
    for name, spec in lock["models"].items():
        files = Path(args.reference_dir) / name
        ours_answer = embedder.handle({"model": name, "kind": "document", "texts": [*DOCUMENTS, LONG_DOCUMENT][:16]})
        if not ours_answer["ok"]:
            print(f"{name}: the function refused the sample texts ({ours_answer['code']})", file=sys.stderr)
            failed = True
            continue
        ours_docs = ours_answer["vectors"][: len(DOCUMENTS)]
        ours_long, long_flag = ours_answer["vectors"][len(DOCUMENTS)], ours_answer["truncated"][len(DOCUMENTS)]
        if ours_answer["truncated"][: len(DOCUMENTS)] != [False] * len(DOCUMENTS) or long_flag is not True:
            print(f"{name}: the truncation flags are wrong ({ours_answer['truncated']})", file=sys.stderr)
            failed = True
        ref_docs = reference_vectors(spec, files, DOCUMENTS, "")
        cos = [cosine(a, b) for a, b in zip(ours_docs, ref_docs)]
        cos_long = cosine(ours_long, reference_vectors(spec, files, [LONG_DOCUMENT], "")[0])
        q_texts = [q for q, _ in QUERIES]
        ours_q = embedder.handle({"model": name, "kind": "query", "texts": q_texts})["vectors"]
        ref_q = reference_vectors(spec, files, q_texts, spec["queryPrefix"])
        cos_q = [cosine(a, b) for a, b in zip(ours_q, ref_q)]
        top_ours = [max(range(len(DOCUMENTS)), key=lambda i: cosine(q, ours_docs[i])) for q in ours_q]
        top_ref = [max(range(len(DOCUMENTS)), key=lambda i: cosine(q, ref_docs[i])) for q in ref_q]
        agree = sum(1 for a, b in zip(top_ours, top_ref) if a == b)
        gold_ours = sum(1 for t, (_, g) in zip(top_ours, QUERIES) if t == g)
        gold_ref = sum(1 for t, (_, g) in zip(top_ref, QUERIES) if t == g)
        worst = min([*cos, *cos_q, cos_long])
        print(json.dumps({"model": name, "docsCosineMin": round(min(cos), 5), "docsCosineMean": round(sum(cos) / len(cos), 5), "queriesCosineMin": round(min(cos_q), 5), "longCosine": round(cos_long, 5),
                          "top1Agreement": f"{agree}/{len(QUERIES)}", "goldTop1Ours": f"{gold_ours}/{len(QUERIES)}", "goldTop1Reference": f"{gold_ref}/{len(QUERIES)}"}))
        if worst < args.min_cosine or agree != len(QUERIES):
            failed = True
            print(f"{name}: parity below threshold (worst cosine {worst:.5f})", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
