#!/usr/bin/env bash
# Preview stage (role `preview`, the ONLY role that creates change sets and writes assets). Plan v3 stage 4, ported from the Mac's 20-preview-code.sh.
#
#   release package (SYNTH_DIR, Build's one synth and its assets)  ->  assets uploaded (never overwriting a key)  ->  templates uploaded  ->  parameters
#   ->  ONE change set per stack named rovara-pipeline-<exec8> (role = the environment's CloudFormation role)  ->  described with property values
#   ->  rows summary, recorded change set ids, template and parameter hashes, the release package hash   ->  everything in $RUN_DIR (the stage uploads it to preview/<exec>/).
#
# It runs no repository code, no node, no agentx: the synth comes from the release package, the uploads and change sets are plain AWS CLI. It EXECUTES NOTHING.
# Decide judges exactly the change sets recorded here (it re-reads them from CloudFormation); Deploy executes exactly those, by name.
# Inputs (environment): ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET SYNTH_DIR; RELEASE_VERSION optional (recorded); out/release.sha256 written by the stage (read, never written here).
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA SYNTH_DIR
[ -d "$SYNTH_DIR" ] || refuse "SYNTH_DIR '$SYNTH_DIR' is not a directory"
require_account

PKG_HASH_FILE="$RUN_DIR/release.sha256"
[ -f "$PKG_HASH_FILE" ] || refuse "the stage did not record the release package hash ($PKG_HASH_FILE)"
PKG_HASH="$(tr -d '[:space:]' < "$PKG_HASH_FILE")"
[[ "$PKG_HASH" =~ ^[0-9a-f]{64}$ ]] || refuse "the recorded release package hash is not a sha256"
for f in synth/manifest.json asset-index.json answers.json overrides.json images.json; do [ -f "$SYNTH_DIR/$f" ] || refuse "the release package has no $f"; done
# The run's overrides are the package's own file: a run artifact. Nothing outside the package can name an image or a parameter.
export OVERRIDES_FILE="$SYNTH_DIR/overrides.json"
overrides_file >/dev/null
if jq -e '[.. | strings | select(startswith("@"))] | length > 0' "$OVERRIDES_FILE" >/dev/null; then refuse "overrides.json holds a placeholder value; a pipeline change set is executed"; fi
# overrides.json is written by Build (merged code): only the two image parameters may be named in it. Anything else (a NoEcho secret, a switch) is refused here.
jq -e '(keys - ["runtime", "slack"]) == [] and ((.runtime // {}) | keys - ["WorkerImageUri"]) == [] and ((.slack // {}) | keys - ["OrchestratorImageUri"]) == []' "$OVERRIDES_FILE" >/dev/null \
  || refuse "overrides.json names a parameter other than the worker and slack image parameters"

CID_access=AgentXAccess; CID_foundation=AgentXProductionFoundation; CID_identity=AgentXIdentity
CID_runtime=AgentXProductionRuntime; CID_control_plane=AgentXControlPlane; CID_slack=AgentXSlackOrchestrator
cid_of() {
  case "$1" in
    access) echo "$CID_access" ;; foundation) echo "$CID_foundation" ;; identity) echo "$CID_identity" ;;
    runtime) echo "$CID_runtime" ;; control-plane) echo "$CID_control_plane" ;; slack) echo "$CID_slack" ;;
    *) refuse "no construct id for part $1" ;;
  esac
}
PARTS="access
$(order_parts)"
[ "$PIPELINE_KIND" = code ] || refuse "this Preview serves the Code pipeline; the Cloud pipeline (P4) brings its own stack mapping"

note "preview for ${ENVIRONMENT}, release ${RELEASE_SHA:0:12}, change set ${CS_NAME}"
mkdir -p "$RUN_DIR/tmp"

# ---- the environment's CloudFormation role (every stack but access is deployed through it) ----
ACCESS_STACK="$(stack_name access)"
access_doc="$(ro cloudformation describe-stacks --stack-name "$ACCESS_STACK")"
ROLE_ARN="$(printf '%s' "$access_doc" | jq -r '[.Stacks[0].Outputs[]? | select(.OutputKey == "CloudFormationRoleArn") | .OutputValue][0] // ""')"
case "$ROLE_ARN" in "arn:aws:iam::${ACCOUNT}:role/"*"${DEPLOY_ROLE_NAME}") ;; *) refuse "the access stack names no ${DEPLOY_ROLE_NAME} role in this account" ;; esac

# ---- settled stacks, and no change set of this name yet ----
for part in $PARTS; do
  stack="$(stack_name "$part")"
  st="$(stack_status "$stack")"
  case "$st" in
    UPDATE_COMPLETE|CREATE_COMPLETE) ;;
    UPDATE_ROLLBACK_COMPLETE) [ "$part" = control-plane ] || refuse "$stack is $st" ;;
    *) refuse "$stack is '$st', expected UPDATE_COMPLETE" ;;
  esac
  cs_list="$(change_set_names "$stack")"
  case $'\n'"$cs_list"$'\n' in *$'\n'"$CS_NAME"$'\n'*) refuse "$stack already has a change set named $CS_NAME" ;; esac
done

# ---- outputs of the deployed stacks (what the CLI fills new parameters from) ----
echo '[]' > "$RUN_DIR/tmp/env-outputs.json"
for part in $PARTS; do
  outs="$(ro cloudformation describe-stacks --stack-name "$(stack_name "$part")" | jq -c '.Stacks[0].Outputs // []')"
  jq -c --argjson more "$outs" '. + $more' "$RUN_DIR/tmp/env-outputs.json" > "$RUN_DIR/tmp/env-outputs.new" && mv "$RUN_DIR/tmp/env-outputs.new" "$RUN_DIR/tmp/env-outputs.json"
done

# ---- assets: first, and never over an existing key ----
: > "$RUN_DIR/tmp/assets.tsv"
asset_keys="$(jq -r 'keys[]' "$SYNTH_DIR/asset-index.json")"
for key in $asset_keys; do
  file="$SYNTH_DIR/assets/$key"
  [ -f "$file" ] || refuse "the release package lists asset $key but does not hold it"
  want="$(jq -r --arg k "$key" '.[$k].sha256' "$SYNTH_DIR/asset-index.json")"
  got="$(sha256_file "$file")"
  [ "$want" = "$got" ] || refuse "asset $key does not match its recorded sha256"
  if ro s3api head-object --bucket "$BOOTSTRAP_BUCKET" --key "$key" >/dev/null 2>&1; then
    state=existing
  else
    # Conditional write: a key an older release (or a rollback target) references can never be swapped.
    a s3api put-object --bucket "$BOOTSTRAP_BUCKET" --key "$key" --body "$file" --if-none-match '*' >/dev/null || refuse "could not write asset $key"
    state=uploaded
  fi
  printf '%s\t%s\t%s\n' "$key" "$got" "$state" >> "$RUN_DIR/tmp/assets.tsv"
done

# ---- one change set per stack ----
: > "$RUN_DIR/tmp/changesets.jsonl"
for part in $PARTS; do
  stack="$(stack_name "$part")"
  cid="$(cid_of "$part")"
  tfile="$(python3 -I "$PACK_DIR/lib/changeset_tools.py" template-file "$SYNTH_DIR/synth/manifest.json" "$cid")"
  case "$tfile" in */*|.*) refuse "template file '$tfile' of $cid is not a plain name" ;; esac
  python3 -I "$PACK_DIR/lib/changeset_tools.py" minify "$SYNTH_DIR/synth/$tfile" "$RUN_DIR/tmp/$stack.template.min.json"
  tkey="rovara-pipeline/${EXEC_ID}/${stack}.json"
  a s3api put-object --bucket "$BOOTSTRAP_BUCKET" --key "$tkey" --body "$RUN_DIR/tmp/$stack.template.min.json" --if-none-match '*' >/dev/null || refuse "could not write the template of $stack"

  ro cloudformation describe-stacks --stack-name "$stack" | jq -c '.Stacks[0].Parameters // []' > "$RUN_DIR/$stack.live-params.json"
  ro cloudformation get-template --stack-name "$stack" --template-stage Original | jq -c '.TemplateBody' > "$RUN_DIR/$stack.live-template.json"
  python3 -I "$PACK_DIR/lib/changeset_tools.py" params "$RUN_DIR/tmp/$stack.template.min.json" "$RUN_DIR/$stack.live-params.json" "$OVERRIDES_FILE" "$part" "$RUN_DIR/tmp/env-outputs.json" "$RUN_DIR/$stack.params.json"
  if [ "$part" = slack ]; then
    cptf="$(python3 -I "$PACK_DIR/lib/changeset_tools.py" template-file "$SYNTH_DIR/synth/manifest.json" "$CID_control_plane")"
    python3 -I "$PACK_DIR/lib/changeset_tools.py" slack-cp-outputs "$SYNTH_DIR/synth/$cptf" "$RUN_DIR/tmp/env-outputs.json" "$RUN_DIR/tmp/$stack.template.min.json" "$OVERRIDES_FILE" "$RUN_DIR/$stack.params.json"
  fi

  role_args=()
  [ "$part" = access ] || role_args=(--role-arn "$ROLE_ARN")
  created="$(a cloudformation create-change-set --stack-name "$stack" --change-set-name "$CS_NAME" --change-set-type UPDATE \
    --template-url "https://${BOOTSTRAP_BUCKET}.s3.${REGION}.amazonaws.com/${tkey}" --parameters "file://$RUN_DIR/$stack.params.json" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND ${role_args[@]+"${role_args[@]}"} \
    --description "pipeline ${EXEC_ID} ${RELEASE_SHA:0:12}" --output json)" || refuse "could not create the change set on $stack"
  cs_id="$(printf '%s' "$created" | jq -r '.Id // empty')"
  [ -n "$cs_id" ] || refuse "create-change-set on $stack returned no id"
  a cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$CS_NAME" >/dev/null 2>&1 || true

  # All pages (the CLI merges them), with property values; a page token left over would mean a truncated read.
  ro cloudformation describe-change-set --stack-name "$stack" --change-set-name "$CS_NAME" --include-property-values > "$RUN_DIR/$stack.changeset.json"
  if jq -e '.NextToken != null' "$RUN_DIR/$stack.changeset.json" >/dev/null; then refuse "the change set of $stack was not read to the end"; fi
  # The template CloudFormation actually received.
  ro cloudformation get-template --stack-name "$stack" --change-set-name "$CS_NAME" --template-stage Original | jq -c '.TemplateBody' > "$RUN_DIR/$stack.template.json"

  status="$(jq -r '.Status' "$RUN_DIR/$stack.changeset.json")"
  reason="$(jq -r '.StatusReason // ""' "$RUN_DIR/$stack.changeset.json")"
  no_changes=false
  if [ "$status" = FAILED ] && grep -Ei "didn't contain changes|did not contain changes" >/dev/null <<<"$reason"; then no_changes=true; fi
  if [ "$status" != CREATE_COMPLETE ] && [ "$no_changes" != true ]; then refuse "the change set on $stack is $status: $reason"; fi
  jq -nc --arg stack "$stack" --arg part "$part" --arg name "$CS_NAME" --arg id "$cs_id" --arg status "$status" --arg reason "$reason" --argjson noChanges "$no_changes" \
    --argjson rows "$(jq '.Changes | length' "$RUN_DIR/$stack.changeset.json")" \
    --arg templateSha256 "$(canon_sha256 "$RUN_DIR/$stack.template.json")" --arg paramsSha256 "$(sha256_file "$RUN_DIR/$stack.params.json")" \
    '{stack: $stack, part: $part, changeSetName: $name, changeSetId: $id, status: $status, statusReason: $reason, noChanges: $noChanges, rows: $rows, templateSha256: $templateSha256, paramsSha256: $paramsSha256}' >> "$RUN_DIR/tmp/changesets.jsonl"
done

# ---- the record ----
# Outputs of every stack as they were before any change (PostCheck compares the ones that must not move).
jq -c '.' "$RUN_DIR/tmp/env-outputs.json" > "$RUN_DIR/before-outputs.json"
{
  echo "change sets for ${ENVIRONMENT} release ${RELEASE_SHA} (${CS_NAME}); nothing executed"
  for part in $PARTS; do
    stack="$(stack_name "$part")"
    echo "== $stack"
    jq -r '[.Changes[]?.ResourceChange | {a: .Action, r: (.Replacement // "-"), t: .ResourceType}] | group_by([.a, .r, .t]) | .[] | "  \(length)\t\(.[0].a)\t\(.[0].r)\t\(.[0].t)"' "$RUN_DIR/$stack.changeset.json"
  done
} > "$RUN_DIR/rows-summary.txt"
jq -s . "$RUN_DIR/tmp/changesets.jsonl" > "$RUN_DIR/changesets.json"
jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {key: .[0], sha256: .[1], state: .[2]})' "$RUN_DIR/tmp/assets.tsv" > "$RUN_DIR/assets.json"
jq -n --arg exec "$EXEC_ID" --arg sha "$RELEASE_SHA" --arg version "${RELEASE_VERSION:-}" --arg pkg "$PKG_HASH" --arg cs "$CS_NAME" --arg role "$ROLE_ARN" --arg at "$(now_utc)" \
  --slurpfile changeSets "$RUN_DIR/changesets.json" --slurpfile assets "$RUN_DIR/assets.json" \
  '{execution: $exec, sha: $sha, version: $version, releasePackageSha256: $pkg, changeSetName: $cs, cloudFormationRole: $role, createdAt: $at, changeSets: $changeSets[0], assets: $assets[0]}' > "$RUN_DIR/preview.json"
rm -rf "$RUN_DIR/tmp"
note "PREVIEW_DONE: $(jq '.changeSets | length' "$RUN_DIR/preview.json") change set(s) ${CS_NAME}, $(jq '.assets | length' "$RUN_DIR/preview.json") asset(s); nothing executed"
