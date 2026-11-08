"""Build step of the embedder image: fetch the pinned model files, check their sha256, export each model to ONNX (fp32, no quantization), check every file the export wrote against the
sha256 pinned in models.lock.json, and write what the Lambda needs at run time (the model, the tokenizer, a manifest).

This runs ONLY while the image is built (the first stage of environments/embedder/Dockerfile) and in the parity check
(environments/embedder/tools/parity_check.py). It needs torch, transformers, onnx, onnxruntime and huggingface_hub; the
run-time image has none of them except onnxruntime. The Lambda never reaches the network.

    python export_models.py --lock models.lock.json --out /models [--source-dir DIR] [--model record|lesson] [--update-lock]

--source-dir holds <name>/<file> copies of the pinned files (a local cache); a file that is not there is downloaded from the
pinned revision. Either way every file is checked against models.lock.json before it is used.

The tool versions in the lock's `toolchain` must be the ones installed (they are pinned by hash in requirements-build.lock), and the sha256 of every output file must be the one the
lock pins: a different tool, or a different output, stops the build instead of producing vectors under the old spec. Both are part of the spec. A deliberate change (new tool versions,
a new model revision) is recorded with --update-lock, which rewrites `outputs` and `spec` in the lock; then put the new spec in packages/contracts/src/team-record-storage.ts (the
test tests/unit/embedder/spec.test.ts fails until the two agree).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent / "app", HERE / "app"):
    sys.path.insert(0, str(candidate))

from embedder_core import spec_id  # noqa: E402


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_pinned_files(name: str, spec: dict, source_dir: Path | None, work: Path) -> Path:
    """Puts every pinned file of one model in `work/name`, verified. A hash mismatch stops the build."""
    target = work / name
    target.mkdir(parents=True, exist_ok=True)
    for filename, expected in spec["files"].items():
        destination = target / filename
        local = None if source_dir is None else source_dir / name / filename
        if local is not None and local.exists():
            shutil.copyfile(local, destination)
        else:
            from huggingface_hub import hf_hub_download  # build stage only

            downloaded = hf_hub_download(repo_id=spec["repo"], filename=filename, revision=spec["revision"], local_dir=str(target))
            if Path(downloaded) != destination:
                shutil.copyfile(downloaded, destination)
        actual = sha256_of(destination)
        if actual != expected:
            raise SystemExit(f"{name}: {filename} has sha256 {actual}, models.lock.json pins {expected}")
    return target


def export_onnx(model_dir: Path, onnx_path: Path) -> None:
    """Exports the encoder in fp32 to `onnx_path` (weights in `<name>.data` beside it, one file)."""
    import onnx
    import torch
    from transformers import AutoModel

    # Eager attention: the TorchScript exporter cannot convert grouped-query scaled_dot_product_attention (Qwen3).
    model = AutoModel.from_pretrained(str(model_dir), torch_dtype=torch.float32, attn_implementation="eager").eval()

    class Encoder(torch.nn.Module):
        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
            return self.inner(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    ids = torch.randint(5, 1000, (2, 12))
    with tempfile.TemporaryDirectory() as scratch:
        scratch_model = Path(scratch) / "raw.onnx"
        torch.onnx.export(
            Encoder(model),
            (ids, torch.ones_like(ids)),
            str(scratch_model),
            input_names=["input_ids", "attention_mask"],
            output_names=["last_hidden_state"],
            dynamic_axes={"input_ids": {0: "batch", 1: "sequence"}, "attention_mask": {0: "batch", 1: "sequence"}, "last_hidden_state": {0: "batch", 1: "sequence"}},
            opset_version=17,
            dynamo=False,
        )
        loaded = onnx.load(str(scratch_model), load_external_data=True)
        onnx.save_model(loaded, str(onnx_path), save_as_external_data=True, all_tensors_to_one_file=True, location=f"{onnx_path.name}.data")


def installed_toolchain(expected: dict) -> None:
    """The versions the lock names must be the ones running (the hashed lock file installs exactly those)."""
    import onnx
    import onnxruntime
    import tokenizers
    import torch
    import transformers

    actual = {"torch": torch.__version__.split("+")[0], "transformers": transformers.__version__, "onnx": onnx.__version__, "onnxruntime": onnxruntime.__version__, "tokenizers": tokenizers.__version__}
    if actual != expected:
        raise SystemExit(f"models.lock.json pins the export tools {expected}, but {actual} are installed; install requirements-build.lock, or change the pins in both lock files and record the change with --update-lock")


def build_model(name: str, spec: dict, toolchain: dict, source_dir: Path | None, out: Path, update_lock: bool) -> dict[str, str]:
    """Writes `out/<name>/` and returns the sha256 of every file in it (the manifest excluded)."""
    with tempfile.TemporaryDirectory() as scratch:
        work = Path(scratch)
        model_dir = fetch_pinned_files(name, spec, source_dir, work)
        destination = out / name
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        export_onnx(model_dir, destination / "model.onnx")
        shutil.copyfile(model_dir / "tokenizer.json", destination / "tokenizer.json")
        # The Lambda runs as an unprivileged user: every file must be world-readable (onnx writes its weights file 0600).
        destination.chmod(0o755)
        for path in destination.iterdir():
            path.chmod(0o644)
        outputs = {path.name: sha256_of(path) for path in sorted(destination.iterdir()) if path.is_file()}
        manifest = {
            "name": name,
            "repo": spec["repo"],
            "revision": spec["revision"],
            "license": spec["license"],
            "dimension": spec["dimension"],
            "pooling": spec["pooling"],
            "maxTokens": spec["maxTokens"],
            "prefix": spec["prefix"],
            "suffix": spec["suffix"],
            "queryPrefix": spec["queryPrefix"],
            "quantization": "none",
            "sourceFiles": spec["files"],
            "toolchain": toolchain,
            "outputs": outputs,
        }
        built_spec = spec_id(manifest)
        if not update_lock:
            if spec.get("outputs") != outputs:
                raise SystemExit(f"{name}: the export wrote {outputs}, models.lock.json pins {spec.get('outputs')}; a different output is a different spec. Check the tool versions, then record it with --update-lock")
            if built_spec != spec["spec"]:
                raise SystemExit(f"{name}: the built model's spec is {built_spec}, models.lock.json says {spec['spec']}; update the lock and the broker's pin together")
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"{name}: wrote {sum(os.path.getsize(destination / f) for f in outputs) / 1e6:.0f} MB to {destination}; spec {built_spec}")
        return outputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--source-dir")
    parser.add_argument("--model", choices=["record", "lesson"])
    parser.add_argument("--update-lock", action="store_true", help="record the outputs and the spec this export produced in the lock (a deliberate change; the image build never does)")
    args = parser.parse_args()
    lock_path = Path(args.lock)
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 1:
        raise SystemExit("models.lock.json: unknown schemaVersion")
    toolchain = lock["toolchain"]
    installed_toolchain(toolchain)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    source_dir = None if args.source_dir is None else Path(args.source_dir)
    for name, spec in lock["models"].items():
        if args.model is not None and name != args.model:
            continue
        outputs = build_model(name, spec, toolchain, source_dir, out, args.update_lock)
        if args.update_lock:
            spec["outputs"] = outputs
            spec["spec"] = spec_id({**json.loads((out / name / "manifest.json").read_text(encoding="utf-8"))})
    if args.update_lock:
        lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        print("models.lock.json updated; set the same spec values in packages/contracts/src/team-record-storage.ts")


if __name__ == "__main__":
    sys.exit(main())
