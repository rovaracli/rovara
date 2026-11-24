#!/usr/bin/env bash
# For the 89 (the independent release checker) and the audit: pull one execution's whole run record from the runs bucket into a local folder, with the READER role's
# credentials. Read-only. It prints the verdict, the reasons, the alerts and the rows summary, and checks the release package against Preview's recorded hash.
# The evaluator is deterministic: to re-judge, run `node ops/staging-release/evaluator/src/cli.ts <dest>/decide/evaluator-input.json out.json` and compare with decide/decision.json.
# Usage: pull-run.sh <execution id> [dest dir]            Environment: RUNS_BUCKET (and the reader role's credentials, region us-west-2)
set -euo pipefail
EXEC="${1:-}"
DEST="${2:-./run-$EXEC}"
[ -n "${RUNS_BUCKET:-}" ] || { echo "REFUSED: RUNS_BUCKET is not set" >&2; exit 3; }
uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$EXEC" =~ $uuid_re ]] || { echo "REFUSED: usage: pull-run.sh <execution id> [dest dir]" >&2; exit 3; }
mkdir -p "$DEST"
[ -z "$(ls -A "$DEST" 2>/dev/null)" ] || { echo "REFUSED: $DEST is not empty" >&2; exit 3; }
for stage in check build preview gates decide guard release canary 89; do
  aws s3 cp --recursive --only-show-errors "s3://${RUNS_BUCKET}/${stage}/${EXEC}/" "$DEST/${stage}/" --region us-west-2 >/dev/null 2>&1 || echo "  (no ${stage}/ for this execution)"
done
echo "== pulled ${EXEC} into ${DEST}"
if [ -f "$DEST/decide/decision.json" ]; then
  jq -r '"verdict: \(.verdict)\nsha: \(.record.sha // "?")\npolicy_hash: \(.policy_hash // "none")\n" + ((.reasons // []) | map("reason [\(.rule)/\(.code)]: \(.message)") | join("\n"))' "$DEST/decide/decision.json"
  jq -r '(.alerts // []) | map("alert [\(.rule)/\(.code)]: \(.message)") | .[]' "$DEST/decide/decision.json"
fi
[ -f "$DEST/preview/rows-summary.txt" ] && { echo "== rows"; cat "$DEST/preview/rows-summary.txt"; }
if [ -f "$DEST/preview/release.sha256" ] && [ -d "$DEST/build/release" ]; then
  want="$(tr -d '[:space:]' < "$DEST/preview/release.sha256")"
  have="$(cd "$DEST/build/release" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1)" "$f"; done | ( sha256sum 2>/dev/null || shasum -a 256 ) | cut -d' ' -f1)"
  [ "$want" = "$have" ] && echo "release package hash: matches Preview's record" || echo "release package hash: DIFFERS from Preview's record (STOP)"
fi
