"""Run at image build with no network: both models load from the image and give unit-length vectors of the right size."""
from __future__ import annotations

import os
import sys
from pathlib import Path

from embedder_core import Embedder

embedder = Embedder(Path(os.environ.get("EMBEDDER_MODELS_DIR", "/opt/models")))
for model, dimension in (("record", 1024), ("lesson", 384)):
    answer = embedder.handle({"model": model, "kind": "document", "texts": ["smoke test"]})
    if not answer["ok"] or answer["dimension"] != dimension or len(answer["vectors"][0]) != dimension:
        sys.exit(f"smoke test failed for {model}: {answer.get('code')}")
    norm = sum(v * v for v in answer["vectors"][0]) ** 0.5
    if abs(norm - 1.0) > 1e-3:
        sys.exit(f"smoke test failed for {model}: norm {norm}")
print("embedder smoke ok")
