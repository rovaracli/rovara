#!/usr/bin/env bash
# Gates stage (role `gates`, read-only). Plan v3 stage 5. Runs the ported gates against the change sets Preview made and writes ONE JSON marker per gate to
# $RUN_DIR/gates/<name>.json (name, sha, writtenAt, result, skippedReason, failures): the shape the policy evaluator reads (rule B).
# A failing gate is DATA, not a stage failure: this script exits 0 once every gate ran and wrote its marker, so Decide can read the failure and answer MANUAL.
# (Deploy refuses any marker that does not pass, so a failed gate still never deploys.) It exits non-zero only when it could not run at all.
#   15-gate  role simulation of the deploy role for every row           25-gate  change-set gates (G0-G10)       45-gate  settled-environment checks
#   46-gate  pre-switch backups: a standing skip (DEC 254zzz397)         gate-gateway-runprice / gate-gateway-deployed: the gateway already serves what this Code needs
#   50-dry-run  deploy.sh --dry-run (its guards; "ready-guard" is expected to fail here: Decide and the approval come later)
# Inputs: ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA RUNS_BUCKET
require_account
WORK="${WORK:-$PWD/work/gates}"
export WORK
PREVIEW_DIR="$WORK/preview"
export PREVIEW_DIR
rm -rf "$PREVIEW_DIR"; mkdir -p "$PREVIEW_DIR" "$RUN_DIR/gates"
s3_get_dir preview "" "$PREVIEW_DIR" || refuse "no preview record for this execution"
export CS_NAME EXEC_ID RELEASE_SHA

# run_gate <marker name> <script> [args...]: the gate's exit code is the verdict; its [FAIL] lines are kept as the marker's failure list.
run_gate() {
  local name="$1" script="$2"; shift 2
  local log="$RUN_DIR/gates/${name}.log" rc=0
  note "gate ${name}"
  bash "$PACK_DIR/gates/${script}" "$@" > "$log" 2>&1 || rc=$?
  cat "$log"
  if [ "$rc" -eq 0 ]; then gate_marker "$name" pass; else
    local fails
    fails="$(grep -E '\[FAIL\]' "$log" | sed 's/^[[:space:]]*//' | cut -c1-200 | head -20 || true)"
    [ -n "$fails" ] || fails="exit code $rc"
    # one array element per line
    local args=()
    while IFS= read -r line; do args+=("$line"); done <<EOF
$fails
EOF
    gate_marker "$name" fail "" "${args[@]}"
  fi
}

run_gate 15-gate 15-role-sim.sh
run_gate 25-gate 25-change-set-gates.sh
run_gate 45-gate 45-checks.sh
# 46-: the RDS snapshot and State backup of the switch-over are a standing skip (owner decision DEC 254zzz397).
gate_marker 46-gate skipped "DEC 254zzz397"
run_gate gate-gateway-runprice gate-gateway-runprice.sh
run_gate gate-gateway-deployed gate-gateway-deployed.sh

# 50- dry run: the Deploy guards, executed read-only against this execution's records. It needs the release package: take it from Build's folder, as Deploy will.
note "gate 50-dry-run"
s3_get_dir build "release/" "$WORK/release" || refuse "no release package from Build"
rc=0
SYNTH_DIR="$WORK/release" WORK="$WORK/dry-run" bash "$PACK_DIR/deploy.sh" --dry-run > "$RUN_DIR/gates/50-dry-run.log" 2>&1 || rc=$?
cat "$RUN_DIR/gates/50-dry-run.log"
if [ "$rc" -ne 0 ]; then gate_marker 50-dry-run fail "" "deploy.sh --dry-run exit code $rc"; else
  failed="$(grep -E '^\s*\[FAIL\] ' "$RUN_DIR/gates/50-dry-run.log" | sed -E 's/^[[:space:]]*\[FAIL\] //' || true)"
  args=()
  while IFS= read -r line; do [ -z "$line" ] || args+=("$line"); done <<EOF
$failed
EOF
  other="$(printf '%s\n' "$failed" | grep -vx 'ready-guard' | grep -v '^$' || true)"
  if [ -z "$other" ]; then gate_marker 50-dry-run pass "" ${args[@]+"${args[@]}"}; else gate_marker 50-dry-run fail "" "${args[@]}"; fi
fi
echo "GATES_DONE: $(ls "$RUN_DIR/gates"/*.json | wc -l | tr -d ' ') marker(s) in $RUN_DIR/gates"
