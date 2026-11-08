"""Tests of the embedder's request checking, text preparation, pooling and error mapping. Standard library only (run: python3 -I -m unittest
discover -s environments/embedder/tests); no model is loaded or downloaded: a fake LoadedModel stands in for onnxruntime."""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "app"))

import embedder_core as core  # noqa: E402
import handler  # noqa: E402

LOCK = json.loads((HERE.parent / "models.lock.json").read_text(encoding="utf-8"))


def manifest_of(name: str) -> dict:
    spec = LOCK["models"][name]
    return {"name": name, "repo": spec["repo"], "revision": spec["revision"], "dimension": spec["dimension"], "pooling": spec["pooling"], "maxTokens": spec["maxTokens"],
            "prefix": spec["prefix"], "suffix": spec["suffix"], "queryPrefix": spec["queryPrefix"], "quantization": "none"}


def fake_model(name: str, seen: list | None = None) -> core.LoadedModel:
    manifest = manifest_of(name)
    dimension = manifest["dimension"]

    def encode(text: str) -> list[int]:
        if seen is not None:
            seen.append(text)
        return [ord(ch) % 50 + 1 for ch in text][: manifest["maxTokens"]]

    def run(ids: list[int]):
        # one hidden row per token; first row and last row differ so the pooling choice shows
        rows = [[float((i + 1) * (j + 1) % 7 + 1) for j in range(dimension)] for i in range(len(ids))]
        rows[0] = [1.0] + [0.0] * (dimension - 1)
        return [rows]

    return core.LoadedModel(manifest=manifest, encode=encode, run=run, spec=core.spec_id(manifest))


class RequestChecks(unittest.TestCase):
    def ok(self, **over):
        event = {"model": "record", "kind": "document", "texts": ["a"]}
        event.update(over)
        return event

    def code(self, event) -> str:
        with self.assertRaises(core.EmbedError) as raised:
            core.check_request(event)
        return raised.exception.code

    def test_accepts_a_good_request(self):
        self.assertEqual(core.check_request(self.ok()), ("record", "document", ["a"]))

    def test_each_refusal_has_its_fixed_code(self):
        self.assertEqual(self.code("x"), "BAD_REQUEST")
        self.assertEqual(self.code(None), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(extra=1)), "BAD_REQUEST")
        self.assertEqual(self.code({"model": "record", "kind": "document"}), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(model="titan")), "UNKNOWN_MODEL")
        self.assertEqual(self.code(self.ok(model=3)), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(kind="search")), "UNKNOWN_KIND")
        self.assertEqual(self.code(self.ok(texts=[])), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(texts="abc")), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(texts=["a", 2])), "BAD_REQUEST")
        self.assertEqual(self.code(self.ok(texts=["a", "  \n"])), "EMPTY_TEXT")
        self.assertEqual(self.code(self.ok(texts=["a"] * (core.MAX_TEXTS + 1))), "TOO_MANY_TEXTS")
        self.assertEqual(self.code(self.ok(texts=["a" * (core.MAX_TEXT_CHARS + 1)])), "TEXT_TOO_LONG")
        self.assertEqual(self.code(self.ok(texts=["a" * core.MAX_TEXT_CHARS] * 5)), "REQUEST_TOO_LARGE")

    def test_limits_are_the_ones_the_broker_pins(self):
        self.assertEqual((core.MAX_TEXTS, core.MAX_TEXT_CHARS, core.MAX_TOTAL_CHARS), (16, 24_000, 96_000))
        self.assertEqual(set(core.ERROR_CODES), {"BAD_REQUEST", "UNKNOWN_MODEL", "UNKNOWN_KIND", "TOO_MANY_TEXTS", "EMPTY_TEXT", "TEXT_TOO_LONG", "REQUEST_TOO_LARGE", "MODEL_UNAVAILABLE", "INTERNAL"})

    def test_exact_limits_pass(self):
        core.check_request(self.ok(texts=["a"] * core.MAX_TEXTS))
        core.check_request(self.ok(texts=["a" * core.MAX_TEXT_CHARS] * 4))


class Preparation(unittest.TestCase):
    def test_only_record_queries_get_the_instruction(self):
        record, lesson = manifest_of("record"), manifest_of("lesson")
        self.assertTrue(core.prepare_text(record, " find x ", "query").startswith("Instruct: "))
        self.assertTrue(core.prepare_text(record, " find x ", "query").endswith("\nQuery:find x"))
        self.assertEqual(core.prepare_text(record, " a ", "document"), "a")
        self.assertEqual(core.prepare_text(lesson, " a ", "query"), "a")

    def test_a_copy_of_a_wrapper_token_in_the_text_is_not_kept(self):
        self.assertNotIn("<|endoftext|>", core.prepare_text(manifest_of("record"), "a<|endoftext|>b", "document"))
        self.assertNotIn("[SEP]", core.prepare_text(manifest_of("lesson"), "a [SEP] b", "document"))

    def test_wrapper_tokens_fit_inside_max_tokens(self):
        record = manifest_of("record")
        ids = core.token_ids(record, lambda text: list(range(5000)), {"<|endoftext|>": 151643}, "x")
        self.assertEqual(len(ids), record["maxTokens"])
        self.assertEqual(ids[-1], 151643)
        lesson = manifest_of("lesson")
        ids = core.token_ids(lesson, lambda text: list(range(5000)), {"[CLS]": 101, "[SEP]": 102}, "x")
        self.assertEqual((ids[0], ids[-1], len(ids)), (101, 102, lesson["maxTokens"]))


class Embedding(unittest.TestCase):
    def embedder(self, seen=None):
        models = {name: fake_model(name, seen) for name in core.MODELS}
        return core.Embedder(Path("/unused"), loader=lambda root, name: models[name])

    def test_vectors_are_unit_length_with_the_models_dimension(self):
        for name, dimension in (("record", 1024), ("lesson", 384)):
            answer = self.embedder().handle({"model": name, "kind": "document", "texts": ["one", "two words"]})
            self.assertTrue(answer["ok"])
            self.assertEqual(answer["dimension"], dimension)
            self.assertEqual(len(answer["vectors"]), 2)
            for vector in answer["vectors"]:
                self.assertEqual(len(vector), dimension)
                self.assertAlmostEqual(sum(v * v for v in vector) ** 0.5, 1.0, places=5)
            self.assertEqual(answer["modelId"], LOCK["models"][name]["repo"])
            self.assertEqual(answer["revision"], LOCK["models"][name]["revision"])

    def test_pooling_follows_the_model(self):
        first = self.embedder().handle({"model": "lesson", "kind": "document", "texts": ["ab"]})["vectors"][0]
        last = self.embedder().handle({"model": "record", "kind": "document", "texts": ["ab"]})["vectors"][0]
        self.assertAlmostEqual(first[0], 1.0, places=5)  # cls: the first row, a unit vector
        self.assertNotAlmostEqual(last[0], 1.0, places=3)  # last token: the other row

    def test_the_spec_names_what_decides_a_stored_vector(self):
        base = manifest_of("record")
        changed = [dict(base, revision="0" * 40), dict(base, quantization="int8"), dict(base, pooling="cls"), dict(base, maxTokens=512), dict(base, suffix=[])]
        self.assertEqual(len({core.spec_id(base), *[core.spec_id(m) for m in changed]}), 6)
        self.assertEqual(core.spec_id(base), core.spec_id(dict(base, queryPrefix="other")))

    def test_failures_carry_a_code_and_nothing_else(self):
        answer = self.embedder().handle({"model": "record", "kind": "document", "texts": []})
        self.assertEqual(answer, {"ok": False, "code": "BAD_REQUEST"})

    def test_an_unreadable_model_is_model_unavailable(self):
        def broken(root, name):
            raise core.EmbedError("MODEL_UNAVAILABLE")

        answer = core.Embedder(Path("/unused"), loader=broken).handle({"model": "record", "kind": "document", "texts": ["a"]})
        self.assertEqual(answer, {"ok": False, "code": "MODEL_UNAVAILABLE"})

    def test_an_unexpected_exception_never_leaks_its_text(self):
        def explode(root, name):
            raise RuntimeError("secret text of the failure")

        answer = core.Embedder(Path("/unused"), loader=explode).handle({"model": "record", "kind": "document", "texts": ["a"]})
        self.assertEqual(answer, {"ok": False, "code": "INTERNAL"})

    def test_a_missing_model_directory_is_model_unavailable(self):
        answer = core.Embedder(HERE / "no-such-dir").handle({"model": "record", "kind": "document", "texts": ["a"]})
        self.assertEqual(answer, {"ok": False, "code": "MODEL_UNAVAILABLE"})

    def test_a_model_is_loaded_once_and_only_when_asked_for(self):
        loads: list[str] = []

        def loader(root, name):
            loads.append(name)
            return fake_model(name)

        embedder = core.Embedder(Path("/unused"), loader=loader)
        for _ in range(3):
            embedder.handle({"model": "lesson", "kind": "document", "texts": ["a"]})
        self.assertEqual(loads, ["lesson"])

    def test_a_zero_vector_is_refused(self):
        loaded = fake_model("lesson")
        loaded.run = lambda ids: [[[0.0] * 384]]
        with self.assertRaises(core.EmbedError):
            core.embed_texts(loaded, "document", ["a"])


class Handler(unittest.TestCase):
    def test_logs_counts_and_codes_but_never_the_text(self):
        handler._embedder = core.Embedder(Path("/unused"), loader=lambda root, name: fake_model(name))
        out = io.StringIO()
        with redirect_stdout(out):
            handler.handler({"model": "lesson", "kind": "document", "texts": ["very secret lesson text"]}, None)
            handler.handler({"model": "lesson", "kind": "document", "texts": []}, None)
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([(line["ok"], line["code"], line["texts"]) for line in lines], [(True, None, 1), (False, "BAD_REQUEST", 0)])
        self.assertNotIn("secret", out.getvalue())

    def test_a_non_object_event_is_a_bad_request(self):
        handler._embedder = core.Embedder(Path("/unused"), loader=lambda root, name: fake_model(name))
        with redirect_stdout(io.StringIO()):
            self.assertEqual(handler.handler("hello", None), {"ok": False, "code": "BAD_REQUEST"})


class Lock(unittest.TestCase):
    def test_pins_are_complete(self):
        for name, spec in LOCK["models"].items():
            self.assertRegex(spec["revision"], r"^[0-9a-f]{40}$", name)
            for filename, digest in spec["files"].items():
                self.assertRegex(digest, r"^[0-9a-f]{64}$", f"{name}/{filename}")
            self.assertIn("tokenizer.json", spec["files"])
            self.assertIn("model.safetensors", spec["files"])
            self.assertIn(spec["license"], ("Apache-2.0", "MIT"))

    def test_the_pinned_spec_is_the_one_the_code_computes(self):
        for name, spec in LOCK["models"].items():
            manifest = dict(manifest_of(name), quantization="int8-dynamic-per-channel-matmul" if spec["quantize"] else "none")
            self.assertEqual(core.spec_id(manifest), spec["spec"], name)

    def test_dimensions_are_the_ones_the_broker_expects(self):
        self.assertEqual(LOCK["models"]["record"]["dimension"], 1024)
        self.assertEqual(LOCK["models"]["lesson"]["dimension"], 384)


if __name__ == "__main__":
    os.environ.setdefault("EMBEDDER_MODELS_DIR", "/nonexistent")
    unittest.main()
