"""Run at image build with no network: both names (the Team record's and the lessons', one model since DECISIONS 140) load from the image, every file is the one the manifest names, and the vectors have the right size and unit length."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from embedder_core import Embedder, spec_id

root = Path(os.environ.get("EMBEDDER_MODELS_DIR", "/opt/models"))
embedder = Embedder(root)
for model, dimension in (("record", 384), ("lesson", 384)):
    folder = root / model
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["outputs"].items():
        digest = hashlib.sha256()
        with (folder / name).open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != expected:
            sys.exit(f"smoke test failed for {model}: {name} is not the file the manifest names")
    answer = embedder.handle({"model": model, "kind": "document", "texts": ["smoke test"]})
    if not answer["ok"] or answer["dimension"] != dimension or len(answer["vectors"][0]) != dimension or answer["spec"] != spec_id(manifest) or answer["truncated"] != [False]:
        sys.exit(f"smoke test failed for {model}: {answer.get('code')}")
    norm = sum(v * v for v in answer["vectors"][0]) ** 0.5
    if abs(norm - 1.0) > 1e-3:
        sys.exit(f"smoke test failed for {model}: norm {norm}")
print("embedder smoke ok")
