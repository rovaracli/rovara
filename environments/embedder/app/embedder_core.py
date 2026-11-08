"""The embedder's request checking and inference. No AWS and no network: the Lambda handler (handler.py) calls this.

Request  {"model": "record" | "lesson", "kind": "query" | "document", "texts": ["..."]}
Success  {"ok": true, "model": "record", "modelId": "Qwen/...", "revision": "<commit>", "spec": "<spec id>", "dimension": 1024, "vectors": [[...]], "truncated": [false]}
         ("truncated" has one flag per vector: true when that text was longer than the model's token budget and was cut. Never a silent cut.)
Failure  {"ok": false, "code": "<one of ERROR_CODES>"}

A failure is a normal return value with a fixed code, never free text: the caller maps the code and nothing from the request or
from an exception reaches the answer or the log. The limits below are repeated in the broker's port
(packages/broker/src/embedder/client.ts); tests on both sides pin them.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

MODELS = ("record", "lesson")
KINDS = ("query", "document")

MAX_TEXTS = 16
MAX_TEXT_CHARS = 24_000
MAX_TOTAL_CHARS = 96_000
MAX_REQUEST_KEYS = 3

# What counts as blank, on both sides of the call. The broker (packages/broker/src/embedder/client.ts) uses the same code points, because JavaScript's trim() and Python's
# str.strip() disagree on some (U+001C to U+001F, U+0085 are Python-only; U+FEFF is JavaScript-only): a text one side calls blank and the other does not would fail the whole batch.
# tests/unit/embedder/spec.test.ts keeps the two lists equal.
BLANK_CODE_POINTS = (
    0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x001C, 0x001D, 0x001E, 0x001F, 0x0020, 0x0085, 0x00A0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
)
BLANK_CHARS = "".join(chr(code) for code in BLANK_CODE_POINTS)

# Version of the text rules that decide what the model sees (blank trimming, neutralising the tokenizer's own special tokens). Part of the spec.
TEXT_RULES = "text-rules-v1"

ERROR_CODES = (
    "BAD_REQUEST",
    "UNKNOWN_MODEL",
    "UNKNOWN_KIND",
    "TOO_MANY_TEXTS",
    "EMPTY_TEXT",
    "TEXT_TOO_LONG",
    "REQUEST_TOO_LARGE",
    "MODEL_UNAVAILABLE",
    "INTERNAL",
)


class EmbedError(Exception):
    """A refusal with a fixed code. The message is the code, so it is safe to log."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def spec_id(manifest: Mapping[str, Any]) -> str:
    """Names everything that decides a stored vector: model, revision, quantization, pooling, truncation, special tokens, the text rules, the export tools' versions and the
    sha256 of every file the export wrote. A document's vector is only comparable with vectors of the same spec. (The query prefix is not part of it: queries are never stored.)"""
    toolchain = manifest["toolchain"]
    outputs = manifest["outputs"]
    parts = [
        manifest["repo"],
        manifest["revision"],
        manifest["quantization"],
        manifest["pooling"],
        str(manifest["maxTokens"]),
        "|".join(manifest["prefix"]),
        "|".join(manifest["suffix"]),
        str(manifest["dimension"]),
        TEXT_RULES,
        ",".join(f"{name}={toolchain[name]}" for name in sorted(toolchain)),
        ",".join(f"{name}={outputs[name]}" for name in sorted(outputs)),
    ]
    return hashlib.sha256("\u0000".join(parts).encode("utf-8")).hexdigest()[:16]


def check_request(event: Any) -> tuple[str, str, list[str]]:
    """Returns (model, kind, texts) or raises EmbedError. Unknown keys are refused, so a typo is never silently ignored."""
    if not isinstance(event, dict) or len(event) > MAX_REQUEST_KEYS:
        raise EmbedError("BAD_REQUEST")
    if set(event) - {"model", "kind", "texts"}:
        raise EmbedError("BAD_REQUEST")
    model = event.get("model")
    if not isinstance(model, str):
        raise EmbedError("BAD_REQUEST")
    if model not in MODELS:
        raise EmbedError("UNKNOWN_MODEL")
    kind = event.get("kind")
    if not isinstance(kind, str):
        raise EmbedError("BAD_REQUEST")
    if kind not in KINDS:
        raise EmbedError("UNKNOWN_KIND")
    texts = event.get("texts")
    if not isinstance(texts, list) or any(not isinstance(text, str) for text in texts):
        raise EmbedError("BAD_REQUEST")
    if len(texts) == 0:
        raise EmbedError("BAD_REQUEST")
    if len(texts) > MAX_TEXTS:
        raise EmbedError("TOO_MANY_TEXTS")
    total = 0
    for text in texts:
        if text.strip(BLANK_CHARS) == "":
            raise EmbedError("EMPTY_TEXT")
        if len(text) > MAX_TEXT_CHARS:
            raise EmbedError("TEXT_TOO_LONG")
        total += len(text)
    if total > MAX_TOTAL_CHARS:
        raise EmbedError("REQUEST_TOO_LARGE")
    return model, kind, list(texts)


@dataclass
class LoadedModel:
    """A model ready to run. `run(ids)` returns the last hidden state of that one text, shape (1, sequence, hidden). `strip` lists every special token the tokenizer would
    otherwise read out of the text itself (its added tokens); the model's own wrapper tokens are added by `token_ids`, never taken from the text."""

    manifest: Mapping[str, Any]
    encode: Callable[[str], tuple[list[int], bool]]
    run: Callable[[list[int]], Any]
    spec: str
    strip: Sequence[str] = ()


def prepare_text(manifest: Mapping[str, Any], text: str, kind: str, strip: Sequence[str] = ()) -> str:
    prefix = manifest.get("queryPrefix", "") if kind == "query" else ""
    cleaned = text
    # The model's own wrapper tokens are added by token_ids, and every other special token of the tokenizer means nothing in a stored text: a copy of one inside a text must not act as one.
    for token in sorted({*manifest["prefix"], *manifest["suffix"], *strip}, key=len, reverse=True):
        if token != "":
            cleaned = cleaned.replace(token, " ")
    return f"{prefix}{cleaned.strip(BLANK_CHARS)}"


def token_ids(manifest: Mapping[str, Any], encode_plain: Callable[[str], list[int]], special: Mapping[str, int], text: str) -> tuple[list[int], bool]:
    """Tokens without special tokens, cut so that prefix + tokens + suffix fit maxTokens, then wrapped; the flag says the text was cut. Cutting the text, not the
    wrapper, keeps the end-of-text token that last-token pooling reads."""
    before = [special[token] for token in manifest["prefix"]]
    after = [special[token] for token in manifest["suffix"]]
    room = int(manifest["maxTokens"]) - len(before) - len(after)
    plain = encode_plain(text)
    return before + plain[:room] + after, len(plain) > room


def pool(manifest: Mapping[str, Any], hidden: Any) -> list[float]:
    """Last-token or first-token pooling over the one text's hidden states (batch of one: no padding to skip), then L2 normalization."""
    sequence = hidden[0]
    row = sequence[-1] if manifest["pooling"] == "last_token" else sequence[0]
    values = [float(value) for value in row]
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm == 0.0:
        raise EmbedError("INTERNAL")
    return [value / norm for value in values]


def embed_texts(loaded: LoadedModel, kind: str, texts: Sequence[str]) -> tuple[list[list[float]], list[bool]]:
    """One vector per text, and one flag per text: true when the text was longer than the model's token budget and was cut."""
    manifest = loaded.manifest
    vectors: list[list[float]] = []
    truncated: list[bool] = []
    for text in texts:
        ids, cut = loaded.encode(prepare_text(manifest, text, kind, loaded.strip))
        vector = pool(manifest, loaded.run(ids))
        if len(vector) != int(manifest["dimension"]):
            raise EmbedError("INTERNAL")
        vectors.append([round(value, 7) for value in vector])
        truncated.append(cut)
    return vectors, truncated


def visible_cpus() -> int:
    getter = getattr(os, "sched_getaffinity", None)
    return len(getter(0)) if getter is not None else (os.cpu_count() or 1)


def load_from_disk(root: Path, name: str) -> LoadedModel:
    """Opens one baked-in model. Everything is read from the image; there is no download path in this module."""
    try:
        import onnxruntime
        from tokenizers import Tokenizer

        folder = root / name
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("name") != name:
            raise EmbedError("MODEL_UNAVAILABLE")
        options = onnxruntime.SessionOptions()
        threads = int(os.environ.get("EMBEDDER_THREADS", "0")) or visible_cpus()
        options.intra_op_num_threads = max(1, threads)
        options.inter_op_num_threads = 1
        session = onnxruntime.InferenceSession(str(folder / "model.onnx"), options, providers=["CPUExecutionProvider"])
        tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
        special: dict[str, int] = {}
        for token in [*manifest["prefix"], *manifest["suffix"]]:
            token_id = tokenizer.token_to_id(token)
            if token_id is None:
                raise EmbedError("MODEL_UNAVAILABLE")
            special[token] = token_id

        def encode_plain(text: str) -> list[int]:
            return list(tokenizer.encode(text, add_special_tokens=False).ids)

        def encode(text: str) -> tuple[list[int], bool]:
            return token_ids(manifest, encode_plain, special, text)

        # Every added token (the model's wrapper tokens, chat and fill-in markers, [MASK], [PAD]) is neutralised in the text before it is tokenized.
        strip = tuple(token.content for token in tokenizer.get_added_tokens_decoder().values())

        def run(ids: list[int]) -> Any:
            import numpy as np

            input_ids = np.asarray([ids], dtype=np.int64)
            return session.run(["last_hidden_state"], {"input_ids": input_ids, "attention_mask": np.ones_like(input_ids)})[0]

        return LoadedModel(manifest=manifest, encode=encode, run=run, spec=spec_id(manifest), strip=strip)
    except EmbedError:
        raise
    except Exception as error:  # a missing or unreadable file: one fixed code, never the error's text
        raise EmbedError("MODEL_UNAVAILABLE") from error


class Embedder:
    """Loads a model on first use (a cold start loads only the model asked for) and keeps it for the container's life."""

    def __init__(self, root: Path, loader: Callable[[Path, str], LoadedModel] = load_from_disk) -> None:
        self._root = root
        self._loader = loader
        self._models: dict[str, LoadedModel] = {}

    def preload(self, names: Sequence[str]) -> None:
        """Loads models ahead of the first request (the init phase of a cold start). A model that cannot be loaded is left for the first request, which then answers MODEL_UNAVAILABLE."""
        for name in names:
            if name in self._models:
                continue
            try:
                self._models[name] = self._loader(self._root, name)
            except Exception:  # not logged: the first request reports it with a fixed code
                continue

    def handle(self, event: Any) -> dict[str, Any]:
        try:
            model, kind, texts = check_request(event)
            loaded = self._models.get(model)
            if loaded is None:
                loaded = self._loader(self._root, model)
                self._models[model] = loaded
            vectors, truncated = embed_texts(loaded, kind, texts)
            manifest = loaded.manifest
            return {
                "ok": True,
                "model": model,
                "modelId": manifest["repo"],
                "revision": manifest["revision"],
                "spec": loaded.spec,
                "dimension": int(manifest["dimension"]),
                "vectors": vectors,
                "truncated": truncated,
            }
        except EmbedError as error:
            return {"ok": False, "code": error.code}
        except Exception:  # never let an exception's text leave: the log line has the class name only (handler.py)
            return {"ok": False, "code": "INTERNAL"}
