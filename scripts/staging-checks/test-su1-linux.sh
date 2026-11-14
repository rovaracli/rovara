#!/bin/bash
# Offline entry point for 9d: run INSIDE an existing Linux image with bash,
# python3 and GNU coreutils; Docker/Node/npm/network are not used by this suite.
# Example (coordinator ONLY, preloaded image, no pull):
# docker run --rm --network none --pull never -v "$PWD:/work:ro" -w /work \
#   --entrypoint /bin/bash "$IMAGE" scripts/staging-checks/test-su1-linux.sh
set -eu
cd "$(dirname "$0")/../.."
if [[ $(uname -s) != Linux ]] || ! command -v python3 >/dev/null ||
   ! timeout --version 2>/dev/null | grep -q 'GNU coreutils'; then
  echo 'SKIP: requires Linux, python3 and GNU timeout; deadline/process-group proof NOT RUN' >&2
  exit 77
fi
# Session-local scratch; the tests refuse an implicit shared temp fallback.
su1_scratch=$(mktemp -d "${TMPDIR:-/tmp}/su1-script-fix-linux.XXXXXXXX")
trap 'rm -rf "$su1_scratch"' EXIT
export TMPDIR="$su1_scratch" PYTHONDONTWRITEBYTECODE=1
python3 tests/shell/su1_deadlines.py
python3 tests/shell/su1_mutants.py --linux
