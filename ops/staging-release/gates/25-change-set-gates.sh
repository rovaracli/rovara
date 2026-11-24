#!/usr/bin/env bash
# Gate 25 (the change-set scan): runs gates/lib/cs_gates.py over the change sets Preview made. Offline: reads PREVIEW_DIR only.
# Env: ENVIRONMENT, RUN_DIR, PREVIEW_DIR, CS_NAME (from EXEC_ID), PIPELINE_KIND. Exit 0 pass, 1 fail. Results: $RUN_DIR/gates/25-change-set-gates/results.txt
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
pack_init
need_env PREVIEW_DIR EXEC_ID
[ -d "$PREVIEW_DIR" ] || refuse "PREVIEW_DIR '$PREVIEW_DIR' is not a directory"
RDIR="$RUN_DIR/gates/25-change-set-gates"
mkdir -p "$RDIR"
PARTS="$(order_parts)"
set +e
# shellcheck disable=SC2086
python3 -I "$HERE/lib/cs_gates.py" "$PREVIEW_DIR" "$ENVIRONMENT" "$CS_NAME" "$RDIR" $PARTS 2>&1 | tee "$RDIR/results.txt"
rc="${PIPESTATUS[0]}"
set -e
exit "$rc"
