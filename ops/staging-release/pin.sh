#!/usr/bin/env bash
# Prints the gate pack's pin: sha256 of the sorted manifest of EVERY regular file under ops/staging-release (the same recipe as the pipeline's pin step:
# `find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum`). The controller writes this value to SSM /rovara-release/<env>/policy-pin (approver role) after an Opus review
# of the pack diff. Refuses a symlink or any entry that is not a regular file or a directory. It reads nothing but the pack itself.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
[ -z "$(find "$PACK_DIR" ! -type f ! -type d)" ] || refuse "the gate pack holds a symlink or another entry that is not a regular file or a directory"
dir_sha256 "$PACK_DIR"
