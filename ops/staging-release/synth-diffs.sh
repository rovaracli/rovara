#!/usr/bin/env bash
# Build stage, step 2: the one CDK synth of this release (runs the repo's infra code, in Build only), and a diff of it against the live templates.
# It runs the CDK app directly (never the cdk CLI, so nothing looks up AWS context), with no AWS credentials in the environment, plus the one context the CLI passes
# at deploy (-c CoreModelGatewayHost=<live value>), so the template Preview describes is the template a real deploy would send.
# Writes: $RUN_DIR/synth/ (the cdk.out), $RUN_DIR/synth-diff.txt (non-metadata differences vs the live templates, informational: Decide judges the real change sets).
# Also records `npm ci --dry-run --ignore-scripts` (rule J's consistency check) in $RUN_DIR/npm-ci-dry-run.json.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA
require_account

# The live gateway host the control plane already uses (empty when none).
cp_doc="$(ro cloudformation describe-stacks --stack-name "$(stack_name control-plane)")"
HOST="$(printf '%s' "$cp_doc" | jq -r '[.Stacks[0].Parameters[]? | select(.ParameterKey == "CoreModelGatewayHost") | .ParameterValue][0] // ""')"
[ -n "$HOST" ] && [[ "$HOST" =~ ^[a-z0-9.-]*$ ]] || refuse "the live CoreModelGatewayHost is not a plain host name"
CONTEXT="$(jq -nc --arg env "$ENVIRONMENT" --arg region "$REGION" --arg host "$HOST" '{agentxEnv: $env, agentxRegion: $region} + (if $host == "" then {} else {CoreModelGatewayHost: $host} end)')"

OUTDIR="$RUN_DIR/synth"
rm -rf "$OUTDIR"
env -u AWS_PROFILE -u AWS_REGION -u AWS_DEFAULT_REGION -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_CONTAINER_CREDENTIALS_RELATIVE_URI \
  AWS_EC2_METADATA_DISABLED=true CDK_OUTDIR="$OUTDIR" CDK_CONTEXT_JSON="$CONTEXT" node --import tsx infra/bin/agentx.ts
test -f "$OUTDIR/manifest.json" || refuse "the synth produced no manifest.json"

# Dependency-lock consistency (rule J check 4): never runs install scripts.
rc=0
npm ci --dry-run --ignore-scripts > "$RUN_DIR/npm-ci-dry-run.log" 2>&1 || rc=$?
jq -n --argjson rc "$rc" '{ok: ($rc == 0), exitCode: $rc}' > "$RUN_DIR/npm-ci-dry-run.json"

# Informational diff of each synthesized template against the live one (the live template read through CloudFormation).
: > "$RUN_DIR/synth-diff.txt"
for part in access $(order_parts); do
  stack="$(stack_name "$part")"
  case "$part" in
    access) cid=AgentXAccess ;; foundation) cid=AgentXProductionFoundation ;; identity) cid=AgentXIdentity ;;
    runtime) cid=AgentXProductionRuntime ;; control-plane) cid=AgentXControlPlane ;; slack) cid=AgentXSlackOrchestrator ;;
    *) continue ;;
  esac
  file="$(python3 -I "$PACK_DIR/lib/changeset_tools.py" template-file "$OUTDIR/manifest.json" "$cid")"
  # informational only (Decide judges the real change sets): a live template this role may not read is recorded as such, not an error
  if live="$(ro cloudformation get-template --stack-name "$stack" --template-stage Original 2>/dev/null | jq -c '.TemplateBody')"; then live_n="$(printf '%s' "$live" | jq '.Resources | length')"; else live_n="unreadable"; fi
  printf '%s %s: %s resources new, %s live\n' "$stack" "$part" "$(jq '.Resources | length' "$OUTDIR/$file")" "$live_n" >> "$RUN_DIR/synth-diff.txt"
done
echo "synth done: $(wc -l < "$RUN_DIR/synth-diff.txt" | tr -d ' ') stack(s) compared; npm ci dry run rc=$rc"
