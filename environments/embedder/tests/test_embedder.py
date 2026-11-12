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
            "prefix": spec["prefix"], "suffix": spec["suffix"], "queryPrefix": spec["queryPrefix"], "quantization": "none",
            "toolchain": LOCK["toolchain"], "outputs": spec["outputs"]}


def fake_model(name: str, seen: list | None = None) -> core.LoadedModel:
    manifest = manifest_of(name)
    dimension = manifest["dimension"]

    def encode(text: str) -> tuple[list[int], bool]:
        if seen is not None:
            seen.append(text)
        ids = [ord(ch) % 50 + 1 for ch in text]
        return ids[: manifest["maxTokens"]], len(ids) > manifest["maxTokens"]

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
        self.assertEqual(self.code(self.ok(texts=["\x1c\x1f\x85"])), "EMPTY_TEXT")
        self.assertEqual(self.code(self.ok(texts=["\ufeff \u00a0"])), "EMPTY_TEXT")
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
    def test_only_a_model_with_a_query_prefix_gets_one_and_only_for_queries(self):
        record, lesson = manifest_of("record"), manifest_of("lesson")
        # bge-small (both names since DECISIONS 140): no query instruction (the retrieval eval, environments/embedder/eval, found none needed)
        self.assertEqual(core.prepare_text(record, " find x ", "query"), "find x")
        self.assertEqual(core.prepare_text(lesson, " a ", "query"), "a")
        # the mechanism stays for a model that has one
        prefixed = {**record, "queryPrefix": "Instruct: find\nQuery:"}
        self.assertEqual(core.prepare_text(prefixed, " find x ", "query"), "Instruct: find\nQuery:find x")
        self.assertEqual(core.prepare_text(prefixed, " a ", "document"), "a")

    def test_a_copy_of_a_wrapper_token_in_the_text_is_not_kept(self):
        self.assertNotIn("[CLS]", core.prepare_text(manifest_of("record"), "a[CLS]b", "document"))
        self.assertNotIn("[SEP]", core.prepare_text(manifest_of("lesson"), "a [SEP] b", "document"))
        self.assertNotIn("<|endoftext|>", core.prepare_text({**manifest_of("record"), "suffix": ["<|endoftext|>"]}, "a<|endoftext|>b", "document"))

    def test_every_other_special_token_of_the_tokenizer_is_neutralised_too(self):
        text = core.prepare_text(manifest_of("record"), "a<|im_start|>b<|fim_prefix|>c", "document", strip=("<|im_start|>", "<|fim_prefix|>", "<|endoftext|>"))
        self.assertEqual(text, "a b c")
        self.assertEqual(core.prepare_text(manifest_of("lesson"), "x [MASK] y", "document", strip=("[MASK]", "[PAD]")), "x   y")

    def test_blank_edges_are_cut_the_same_way_the_broker_cuts_them(self):
        self.assertEqual(core.prepare_text(manifest_of("lesson"), "\x1c a \ufeff", "document"), "a")

    def test_wrapper_tokens_fit_inside_max_tokens(self):
        for name in ("record", "lesson"):
            manifest = manifest_of(name)
            self.assertEqual(manifest["maxTokens"], 512)
            ids, cut = core.token_ids(manifest, lambda text: list(range(5000)), {"[CLS]": 101, "[SEP]": 102}, "x")
            self.assertEqual((ids[0], ids[-1], len(ids)), (101, 102, manifest["maxTokens"]))
            self.assertTrue(cut)
        # a model whose wrapper is only an end token (last-token pooling reads it) keeps it when the text is cut
        ends = {**manifest_of("record"), "prefix": [], "suffix": ["<|endoftext|>"], "pooling": "last_token", "maxTokens": 2048}
        ids, cut = core.token_ids(ends, lambda text: list(range(5000)), {"<|endoftext|>": 151643}, "x")
        self.assertEqual((len(ids), ids[-1], cut), (2048, 151643, True))

    def test_a_text_that_fits_is_not_flagged(self):
        record = manifest_of("record")
        special = {"[CLS]": 101, "[SEP]": 102}
        ids, cut = core.token_ids(record, lambda text: list(range(record["maxTokens"] - 2)), special, "x")
        self.assertEqual((len(ids), cut), (record["maxTokens"], False))
        ids, cut = core.token_ids(record, lambda text: list(range(record["maxTokens"] - 1)), special, "x")
        self.assertTrue(cut)

    def test_the_blank_set_is_the_union_of_what_javascript_and_python_trim(self):
        for code in range(0x110000):
            char = chr(code)
            if char.isspace() or char == "\ufeff":
                self.assertIn(code, core.BLANK_CODE_POINTS, hex(code))
        self.assertEqual(len(set(core.BLANK_CODE_POINTS)), len(core.BLANK_CODE_POINTS))


class Embedding(unittest.TestCase):
    def embedder(self, seen=None):
        models = {name: fake_model(name, seen) for name in core.MODELS}
        return core.Embedder(Path("/unused"), loader=lambda root, name: models[name])

    def test_vectors_are_unit_length_with_the_models_dimension(self):
        for name, dimension in (("record", 384), ("lesson", 384)):
            answer = self.embedder().handle({"model": name, "kind": "document", "texts": ["one", "two words"]})
            self.assertTrue(answer["ok"])
            self.assertEqual(answer["dimension"], dimension)
            self.assertEqual(len(answer["vectors"]), 2)
            for vector in answer["vectors"]:
                self.assertEqual(len(vector), dimension)
                self.assertAlmostEqual(sum(v * v for v in vector) ** 0.5, 1.0, places=5)
            self.assertEqual(answer["truncated"], [False, False])
            self.assertEqual(answer["modelId"], LOCK["models"][name]["repo"])
            self.assertEqual(answer["revision"], LOCK["models"][name]["revision"])

    def test_pooling_follows_the_model(self):
        first = self.embedder().handle({"model": "lesson", "kind": "document", "texts": ["ab"]})["vectors"][0]
        self.assertAlmostEqual(first[0], 1.0, places=5)  # cls: the first row, a unit vector
        # the mechanism stays for a last-token model
        loaded = fake_model("record")
        loaded.manifest = {**loaded.manifest, "pooling": "last_token"}
        last = core.embed_texts(loaded, "document", ["ab"])[0][0]
        self.assertNotAlmostEqual(last[0], 1.0, places=3)  # last token: the other row

    def test_the_spec_names_what_decides_a_stored_vector(self):
        base = manifest_of("record")
        changed = [
            dict(base, revision="0" * 40), dict(base, quantization="int8"), dict(base, pooling="last_token"), dict(base, maxTokens=2048), dict(base, suffix=[]),
            dict(base, toolchain={**base["toolchain"], "onnx": "0.0.0"}), dict(base, outputs={**base["outputs"], "model.onnx": "0" * 64}),
        ]
        self.assertEqual(len({core.spec_id(base), *[core.spec_id(m) for m in changed]}), 8)
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

    def test_a_text_over_the_token_budget_says_so_per_vector(self):
        short, long = "a" * 10, "a" * (LOCK["models"]["lesson"]["maxTokens"] + 5)
        answer = self.embedder().handle({"model": "lesson", "kind": "document", "texts": [short, long, short]})
        self.assertTrue(answer["ok"])
        self.assertEqual(answer["truncated"], [False, True, False])

    def test_preload_loads_what_it_is_told_and_swallows_a_failure(self):
        loads: list[str] = []

        def loader(root, name):
            loads.append(name)
            if name == "lesson":
                raise RuntimeError("cannot read")
            return fake_model(name)

        embedder = core.Embedder(Path("/unused"), loader=loader)
        embedder.preload(["record", "lesson"])
        self.assertEqual(loads, ["record", "lesson"])
        embedder.handle({"model": "record", "kind": "document", "texts": ["a"]})
        self.assertEqual(loads, ["record", "lesson"])  # already loaded: not loaded again
        self.assertEqual(embedder.handle({"model": "lesson", "kind": "document", "texts": ["a"]}), {"ok": False, "code": "INTERNAL"})

    def test_preload_warms_each_model_with_one_short_text_and_keeps_a_model_whose_warm_up_fails(self):
        seen: list[str] = []
        failing = fake_model("lesson")
        failing.run = lambda ids: (_ for _ in ()).throw(RuntimeError("cannot run"))
        models = {"record": fake_model("record", seen), "lesson": failing}
        embedder = core.Embedder(Path("/unused"), loader=lambda root, name: models[name])
        out = io.StringIO()
        with redirect_stdout(out):
            embedder.preload(["record", "lesson"])
        self.assertEqual(seen, [core.WARM_UP_TEXT])
        # one fixed line for the failed warm-up, no message text, nothing for the good one
        self.assertEqual([json.loads(line) for line in out.getvalue().splitlines()], [{"event": "embedder.warmup", "model": "lesson", "ok": False}])
        self.assertEqual(sorted(embedder._models), ["lesson", "record"])  # the failed warm-up did not drop the model; the first request reports the fault
        self.assertEqual(embedder.handle({"model": "lesson", "kind": "document", "texts": ["a"]}), {"ok": False, "code": "INTERNAL"})

    def test_the_session_is_loaded_normally_with_an_explicit_thread_count(self):
        # Lane fix/0515-embedder-small-model: the model is small, so the session keeps onnxruntime's defaults (prepacking and the arena on, nothing memory-mapped on purpose) and only the threads are set.
        class Options:
            def __init__(self) -> None:
                self.entries: dict[str, str] = {}

            def add_session_config_entry(self, key: str, value: str) -> None:
                self.entries[key] = value

        class FakeOnnxruntime:
            SessionOptions = Options

        options = core.session_options(FakeOnnxruntime, 2)
        self.assertEqual((options.intra_op_num_threads, options.inter_op_num_threads), (2, 1))
        self.assertEqual(options.entries, {})
        self.assertFalse(hasattr(options, "enable_cpu_mem_arena"))
        self.assertEqual(core.session_options(FakeOnnxruntime, 0).intra_op_num_threads, 1)

    def test_the_thread_count_is_two_unless_the_function_is_told_otherwise_and_never_more_than_the_cores(self):
        saved = os.environ.pop("EMBEDDER_THREADS", None)
        try:
            self.assertEqual(core.DEFAULT_THREADS, 2)
            original = core.visible_cpus
            try:
                core.visible_cpus = lambda: 6
                self.assertEqual(core.thread_count(), 2)
                core.visible_cpus = lambda: 1
                self.assertEqual(core.thread_count(), 1)
                os.environ["EMBEDDER_THREADS"] = "4"
                self.assertEqual(core.thread_count(), 4)
                for bad in ("0", "-1", "x", ""):
                    os.environ["EMBEDDER_THREADS"] = bad
                    core.visible_cpus = lambda: 6
                    self.assertEqual(core.thread_count(), 2, bad)
            finally:
                core.visible_cpus = original
        finally:
            os.environ.pop("EMBEDDER_THREADS", None)
            if saved is not None:
                os.environ["EMBEDDER_THREADS"] = saved

    def test_two_names_for_one_model_load_it_once(self):
        # The Team record and the lessons share one model since DECISIONS 140: the image holds one folder and the second name is a link to it.
        import tempfile
        import types

        created: list[object] = []

        class Session:
            def __init__(self, path, options, providers=None) -> None:
                created.append(path)

        class Options:
            intra_op_num_threads = 0
            inter_op_num_threads = 0

        class Tok:
            @staticmethod
            def from_file(path):
                tok = Tok()
                tok.get_added_tokens_decoder = lambda: {}
                tok.token_to_id = lambda token: 7
                return tok

        fake_ort = types.SimpleNamespace(InferenceSession=Session, SessionOptions=Options)
        fake_tokenizers = types.SimpleNamespace(Tokenizer=Tok)
        saved = {name: sys.modules.get(name) for name in ("onnxruntime", "tokenizers")}
        sys.modules["onnxruntime"], sys.modules["tokenizers"] = fake_ort, fake_tokenizers
        core._LOADED.clear()
        try:
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                (root / "record").mkdir()
                manifest = {**manifest_of("record"), "name": "record"}
                (root / "record" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                (root / "record" / "model.onnx").write_bytes(b"x")
                (root / "record" / "tokenizer.json").write_bytes(b"{}")
                (root / "lesson").symlink_to("record")
                (root / "other").mkdir()
                (root / "other" / "manifest.json").write_text(json.dumps({**manifest, "name": "somewhere-else"}), encoding="utf-8")
                first = core.load_from_disk(root, "record")
                second = core.load_from_disk(root, "lesson")
                self.assertIs(first, second)
                self.assertEqual(len(created), 1)
                self.assertEqual(first.spec, LOCK["models"]["record"]["spec"])
                # a manifest that names another folder is not this model
                with self.assertRaises(core.EmbedError) as raised:
                    core.load_from_disk(root, "other")
                self.assertEqual(raised.exception.code, "MODEL_UNAVAILABLE")
        finally:
            core._LOADED.clear()
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

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
            for group in ("files", "referenceFiles", "outputs"):
                self.assertTrue(spec[group], f"{name}/{group}")
                for filename, digest in spec[group].items():
                    self.assertRegex(digest, r"^[0-9a-f]{64}$", f"{name}/{group}/{filename}")
            self.assertIn("tokenizer.json", spec["files"])
            self.assertIn("model.safetensors", spec["files"])
            self.assertEqual(sorted(spec["outputs"]), ["model.onnx", "model.onnx.data", "tokenizer.json"], name)
            # the tokenizer is copied through: its output hash is its pinned source hash
            self.assertEqual(spec["outputs"]["tokenizer.json"], spec["files"]["tokenizer.json"], name)
            self.assertIn(spec["license"], ("Apache-2.0", "MIT"))
            self.assertNotIn("quantize", spec, "both models ship in fp32")

    def test_the_pinned_spec_is_the_one_the_code_computes(self):
        for name, spec in LOCK["models"].items():
            self.assertEqual(core.spec_id(manifest_of(name)), spec["spec"], name)

    def test_dimensions_are_the_ones_the_broker_expects(self):
        self.assertEqual(LOCK["models"]["record"]["dimension"], 384)
        self.assertEqual(LOCK["models"]["lesson"]["dimension"], 384)

    def test_both_models_cut_at_512_tokens(self):
        self.assertEqual(LOCK["models"]["record"]["maxTokens"], 512)
        self.assertEqual(LOCK["models"]["lesson"]["maxTokens"], 512)

    def test_the_record_and_the_lessons_are_one_model_so_the_image_holds_one_copy(self):
        # DECISIONS 140. The two entries are identical (so the export writes the model once and links the second name to it).
        self.assertEqual(LOCK["models"]["record"], LOCK["models"]["lesson"])
        self.assertEqual(LOCK["models"]["record"]["repo"], "BAAI/bge-small-en-v1.5")
        self.assertEqual(LOCK["models"]["record"]["queryPrefix"], "")

    def test_the_toolchain_is_what_the_hashed_lock_files_install(self):
        build = (HERE.parent / "requirements-build.lock").read_text(encoding="utf-8")
        runtime = (HERE.parent / "requirements-runtime.lock").read_text(encoding="utf-8")
        for name, version in LOCK["toolchain"].items():
            if name == "torch":
                self.assertIn(f"torch-{version}%2Bcpu-cp312-cp312-manylinux_2_28_aarch64.whl", build)
            else:
                self.assertRegex(build, rf"(?m)^{name}=={version.replace('.', r'[.]')} ", name)
        for name in ("onnxruntime", "tokenizers"):
            self.assertRegex(runtime, rf"(?m)^{name}=={LOCK['toolchain'][name].replace('.', r'[.]')} ")


class LockFiles(unittest.TestCase):
    """Every package of both images is installed by hash, from one index, with its dependencies named in the lock (never resolved at build time)."""

    def entries(self, name: str) -> list[str]:
        text = (HERE.parent / name).read_text(encoding="utf-8")
        blocks = [block for block in text.replace("\\\n", " ").splitlines() if block and not block.startswith((" ", "#"))]
        return blocks

    def test_every_requirement_is_pinned_and_hashed(self):
        for name in ("requirements-build.lock", "requirements-runtime.lock"):
            entries = self.entries(name)
            self.assertGreater(len(entries), 2, name)
            for entry in entries:
                self.assertRegex(entry, r"^[A-Za-z0-9_.-]+ ?(==[A-Za-z0-9_.!+-]+|@ https://[^ ]+)", entry[:60])
                self.assertRegex(entry, r"--hash=sha256:[0-9a-f]{64}", entry[:60])

    def test_no_extra_index_anywhere(self):
        for name in ("requirements-build.in", "requirements-build.lock", "requirements-runtime.in", "requirements-runtime.lock", "Dockerfile"):
            text = (HERE.parent / name).read_text(encoding="utf-8")
            self.assertNotIn("--extra-index-url", text.replace("# Regenerate", ""), name)
            self.assertNotIn("--index-url", text, name)

    def test_the_dockerfile_installs_only_from_the_lock_files_with_hashes_and_no_resolution(self):
        text = (HERE.parent / "Dockerfile").read_text(encoding="utf-8")
        installs = [line for line in text.replace("\\\n", " ").splitlines() if "pip install" in line and not line.lstrip().startswith("#")]
        self.assertEqual(len(installs), 2)
        for line in installs:
            self.assertIn("--require-hashes", line)
            self.assertIn("--no-deps", line)
            self.assertIn("--only-binary=:all:", line)
            self.assertRegex(line, r"-r requirements-(build|runtime)\.lock")

    def test_the_runtime_image_installs_three_packages_and_nothing_else(self):
        self.assertEqual(sorted(entry.split("==")[0] for entry in self.entries("requirements-runtime.lock")), ["numpy", "onnxruntime", "tokenizers"])


if __name__ == "__main__":
    os.environ.setdefault("EMBEDDER_MODELS_DIR", "/nonexistent")
    unittest.main()
