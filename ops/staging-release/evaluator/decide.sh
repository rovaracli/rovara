#!/usr/bin/env bash
# Decide's entry point (the pipeline runs `bash evaluator/decide.sh` with RUN_DIR=out and POLICY_HASH=<the pack hash it already compared with the pin>).
# 1. lib/decide_input.py gathers the evaluator's input from CloudFormation, SSM, ECR, S3, git data and GitHub (no repository code runs here, no npm).
# 2. node evaluator/src/cli.ts judges it (Node >= 22.18 runs the erasable TypeScript directly).
# 3. out/decision.json = the evaluator's decision + policy_hash (the contract with AutoApprove: it must equal the pin) + `record` (what Deploy re-checks: change set ids,
#    template hashes, the release package hash, the asset keys).
# It fails closed: anything that goes wrong writes a MANUAL decision with the reason and exits 0 (the pipeline stage turns a missing or non-AUTO verdict into MANUAL as well).
# Environment: ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET PIPELINE_NAME PARAM_PREFIX; optional MODE, PIPELINE_KIND.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACK_DIR="$(cd "$HERE/.." && pwd)"
export PACK_DIR
RUN_DIR="${RUN_DIR:-out}"
mkdir -p "$RUN_DIR"
WORK="${WORK:-$PWD/work/decide}"
export WORK
mkdir -p "$WORK"

manual() { # reason
  jq -n --arg r "$1" --arg sha "${RELEASE_SHA:-}" --arg ex "${EXEC_ID:-}" '{verdict: "MANUAL", reasons: [{rule: "decide", code: "assembly", message: $r}], alerts: [], rows: [], policy_hash: null, record: {execution: $ex, sha: $sha, changeSets: [], assets: []}}' > "$RUN_DIR/decision.json"
  echo "DECIDE: MANUAL ($1)"
  exit 0
}

[ "${ENVIRONMENT:-}" = staging ] || manual "ENVIRONMENT is not staging"
command -v jq >/dev/null 2>&1 || manual "jq is not installed"
command -v git >/dev/null 2>&1 || manual "git is not installed"
command -v python3 >/dev/null 2>&1 || manual "python3 is not installed"
command -v node >/dev/null 2>&1 || manual "node is not installed in the Decide image"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
node_minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then manual "node $(node --version) cannot run the evaluator (22.18 or newer is needed)"; fi

rc=0
python3 -I "$PACK_DIR/lib/decide_input.py" "$WORK/input.json" "$WORK/record.json" 2> "$WORK/assemble.err" || rc=$?
if [ "$rc" -ne 0 ]; then manual "$(tail -c 400 "$WORK/assemble.err" | tr '\n' ' ')"; fi

rc=0
node "$HERE/src/cli.ts" "$WORK/input.json" "$WORK/evaluator-decision.json" > "$WORK/evaluator.out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] && [ -s "$WORK/evaluator-decision.json" ] || manual "the evaluator failed (exit $rc)"

jq --slurpfile rec "$WORK/record.json" '. + {policy_hash: .policyHash, record: $rec[0]}' "$WORK/evaluator-decision.json" > "$RUN_DIR/decision.json" || manual "could not write the decision"
# Keep the evidence beside the decision (input, for the 89's independent re-run).
cp "$WORK/input.json" "$RUN_DIR/evaluator-input.json"
echo "DECIDE: $(jq -r .verdict "$RUN_DIR/decision.json") ($(jq -r '.reasons | length' "$RUN_DIR/decision.json") reason(s))"
