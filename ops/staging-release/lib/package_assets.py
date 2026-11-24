#!/usr/bin/env python3
"""Build-side: turns a CDK synth directory into the release package's synth/ and assets/ folders (deterministic zips), and writes asset-index.json.

  package_assets.py <cdk.out dir> <package dir>

For every file asset in every <stack>.assets.json (the template assets themselves are skipped: Preview uploads its own minified template at its own key):
  packaging zip  -> assets/<objectKey>   a zip of the asset directory, sorted names, fixed timestamps, so the same source hash gives the same bytes
  packaging file -> assets/<objectKey>   the file itself
asset-index.json maps objectKey -> {sha256, bytes, source, stack}. Preview reads only the index and the files it names; nothing else of cdk.out is uploaded.
Exits non-zero (fail closed) on an asset whose source is missing, a key that is not a plain file name, or two assets claiming one key with different bytes.
"""
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile

KEY = re.compile(r"^[0-9a-f]{64}(\.[a-z0-9]+)+$")


def zip_dir(src, dst):
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                if os.path.islink(full):
                    sys.exit(f"REFUSED: asset {src} holds a symlink ({full})")
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((os.stat(full).st_mode & 0o111 and 0o755 or 0o644) | 0o100000) << 16
                with open(full, "rb") as fh:
                    z.writestr(info, fh.read())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(cdk_out, package):
    os.makedirs(os.path.join(package, "assets"), exist_ok=True)
    os.makedirs(os.path.join(package, "synth"), exist_ok=True)
    index = {}
    for name in sorted(os.listdir(cdk_out)):
        full = os.path.join(cdk_out, name)
        if os.path.isfile(full) and (name.endswith(".template.json") or name.endswith(".assets.json") or name in ("manifest.json", "tree.json")):
            shutil.copyfile(full, os.path.join(package, "synth", name))
    for name in sorted(os.listdir(cdk_out)):
        if not name.endswith(".assets.json"):
            continue
        stack = name[: -len(".assets.json")]
        doc = json.load(open(os.path.join(cdk_out, name)))
        for _id, f in sorted((doc.get("files") or {}).items()):
            source = f.get("source") or {}
            path = source.get("path")
            if path is None or path.endswith(".template.json"):
                continue
            if "/" in path or path.startswith("."):
                sys.exit(f"REFUSED: asset path {path!r} is not a plain name under the synth directory")
            for _d, dest in sorted((f.get("destinations") or {}).items()):
                key = dest["objectKey"]
                if not KEY.match(key):
                    sys.exit(f"REFUSED: asset object key {key!r} is not <64 hex>.<ext>")
                src = os.path.join(cdk_out, path)
                if not os.path.exists(src):
                    sys.exit(f"REFUSED: asset source {path} of {stack} is missing")
                out = os.path.join(package, "assets", key)
                tmp = out + ".tmp"
                if os.path.isdir(src):
                    zip_dir(src, tmp)
                else:
                    shutil.copyfile(src, tmp)
                digest = sha256(tmp)
                if key in index and index[key]["sha256"] != digest:
                    sys.exit(f"REFUSED: two assets claim key {key} with different bytes")
                os.replace(tmp, out)
                index[key] = {"sha256": digest, "bytes": os.path.getsize(out), "source": path, "stack": stack}
    with open(os.path.join(package, "asset-index.json"), "w") as fh:
        json.dump(index, fh, indent=1, sort_keys=True)
    print(f"packaged {len(index)} asset(s)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
