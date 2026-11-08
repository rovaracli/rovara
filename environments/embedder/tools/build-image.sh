#!/usr/bin/env bash
# Builds the embedder image for linux/arm64 (the Lambda's architecture). The base images are pinned by digest in the Dockerfile, the model revisions in models.lock.json and every
# Python package by hash in requirements-build.lock and requirements-runtime.lock. The build needs the network (model downloads, pip installs); the IMAGE needs none. It runs the
# parity check against the original weights and the offline smoke test, and fails if either does.
#   build-image.sh <tag>                   load the image into the local Docker as <tag>
#   build-image.sh <tag> --push <file>     push <tag> to its registry and write the build metadata (the digest) to <file>; the release job uses this
set -euo pipefail
tag="${1:?usage: build-image.sh <tag> [--push <metadata-file>]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${2:-}" = "--push" ]; then
  metadata="${3:?usage: build-image.sh <tag> --push <metadata-file>}"
  docker buildx build --platform linux/arm64 --provenance=false --sbom=false --push --metadata-file "$metadata" -t "$tag" "$here"
else
  docker buildx build --platform linux/arm64 --provenance=false --load -t "$tag" "$here"
fi
