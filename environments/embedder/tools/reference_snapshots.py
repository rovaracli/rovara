"""Build stage only: downloads the files of the pinned snapshots that parity_check.py compares the exported models with, and checks every one against its sha256 in models.lock.json
(`files` and `referenceFiles`). A reference nobody pinned could pass a bad export, so a file the lock does not name is never downloaded, and a file whose hash differs stops the build."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    lock = json.loads(Path(args.lock).read_text(encoding="utf-8"))
    for name, spec in lock["models"].items():
        target = Path(args.out) / name
        for filename, expected in {**spec["files"], **spec["referenceFiles"]}.items():
            destination = target / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            downloaded = Path(hf_hub_download(repo_id=spec["repo"], filename=filename, revision=spec["revision"], local_dir=str(target)))
            if downloaded != destination:
                shutil.copyfile(downloaded, destination)
            actual = sha256_of(destination)
            if actual != expected:
                print(f"{name}: reference file {filename} has sha256 {actual}, models.lock.json pins {expected}", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
