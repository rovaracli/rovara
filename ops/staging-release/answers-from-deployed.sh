#!/usr/bin/env bash
# Build stage, last step: the deploy answers and the overrides of this run, then the release package.
# - answers.json: the agentx CLI's own `upgrade --answers-from-deployed` (it reads the deployed environment and its settings and deploys nothing), with the images of this run.
# - overrides.json: the run's overrides ARTIFACT (never a Mac file): only the two image parameters (worker, slack). No secret, no placeholder, nothing else.
# - the package: out/release/ (release:build's output, already there) gets synth/, assets/, asset-index.json, answers.json, overrides.json and images.json added, so ONE
#   directory (and its hash, which Preview records and Guard and Deploy re-check) holds everything a later stage may use.
# Answers hold names only: a names-only check runs here, and gitleaks runs over out/ in the buildspec after this script.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA VERSION
require_account
PKG="$RUN_DIR/release"
[ -d "$PKG" ] || refuse "no release package at $PKG (release:build did not run)"
[ -f "$RUN_DIR/images.json" ] || refuse "no images.json (build-images.sh did not run)"
[ -d "$RUN_DIR/synth" ] || refuse "no synth (synth-diffs.sh did not run)"

WORKER_URI="$(jq -r '.[] | select(.key == "worker") | .uri' "$RUN_DIR/images.json")"
SLACK_URI="$(jq -r '.[] | select(.key == "slack") | .uri' "$RUN_DIR/images.json")"
[ -n "$WORKER_URI" ] && [ -n "$SLACK_URI" ] || refuse "images.json lacks the worker or the slack image"

node packages/cli/dist/bin.js --env "$ENVIRONMENT" upgrade --answers-from-deployed "$RUN_DIR/answers.json" --worker-image "$WORKER_URI" --slack-image "$SLACK_URI" \
  || node --import tsx packages/cli/src/bin.ts --env "$ENVIRONMENT" upgrade --answers-from-deployed "$RUN_DIR/answers.json" --worker-image "$WORKER_URI" --slack-image "$SLACK_URI" \
  || refuse "the CLI could not write the deployed answers"
jq -e --arg env "$ENVIRONMENT" --arg region "$REGION" --arg account "$ACCOUNT" '.env == $env and .region == $region and .account == $account' "$RUN_DIR/answers.json" >/dev/null \
  || refuse "answers.json does not name this environment, region and account"
# names only: no key, token, secret or password VALUE may sit in the answers (a key named *secret* may hold a name or ARN: it must not look like a credential).
if jq -r '.. | strings' "$RUN_DIR/answers.json" | grep -Eq '(AKIA[0-9A-Z]{16}|-----BEGIN|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})'; then refuse "answers.json holds something that looks like a credential"; fi

jq -n --arg w "$WORKER_URI" --arg s "$SLACK_URI" '{runtime: {WorkerImageUri: $w}, slack: {OrchestratorImageUri: $s}}' > "$RUN_DIR/overrides.json"

python3 -I "$PACK_DIR/lib/package_assets.py" "$RUN_DIR/synth" "$PKG"
cp "$RUN_DIR/answers.json" "$PKG/answers.json"
cp "$RUN_DIR/overrides.json" "$PKG/overrides.json"
cp "$RUN_DIR/images.json" "$PKG/images.json"
cp "$RUN_DIR/npm-ci-dry-run.json" "$PKG/npm-ci-dry-run.json"
echo "release package assembled: $(find "$PKG" -type f | wc -l | tr -d ' ') files"
