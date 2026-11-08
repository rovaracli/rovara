"""AWS Lambda entry point of the embedder (container image). Direct invoke only, from the broker; no function URL, no API.

Logging: one JSON line per request with the model, the kind, the number of texts, the outcome code and the time. Never a text, a
vector or an exception message."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from embedder_core import Embedder

MODELS_ROOT = Path(os.environ.get("EMBEDDER_MODELS_DIR", "/opt/models"))
_embedder = Embedder(MODELS_ROOT)


def _summary(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        return {}
    texts = event.get("texts")
    model, kind = event.get("model"), event.get("kind")
    return {
        "model": model if model in ("record", "lesson") else None,
        "kind": kind if kind in ("query", "document") else None,
        "texts": len(texts) if isinstance(texts, list) else None,
    }


def handler(event: Any, _context: Any = None) -> dict[str, Any]:
    started = time.monotonic()
    answer = _embedder.handle(event)
    line = {"event": "embedder.request", **_summary(event), "ok": answer["ok"], "code": answer.get("code"), "ms": round((time.monotonic() - started) * 1000)}
    print(json.dumps(line), file=sys.stdout, flush=True)
    return answer
