# shellcheck shell=bash
# The staging release gate pack's shim (plan v3 section 2: "staging-aws shim (STS account and us-west-2 assert), RUN_DIR, OVERRIDES_FILE, order.txt").
# Source it from a pack script after `set -euo pipefail`. It runs nothing in AWS by itself.
#
# What it replaces: the Mac's staging-aws.sh guard (profile, account id, region) and common.sh / common-v2.sh. In the pipeline the CodeBuild role IS the credential, so the guard
# becomes assertions: the environment is staging, the region is us-west-2, and STS says which account this is (the account id is never written in the pack).
# Rules carried over from the Mac scripts:
#   - every AWS call names the region; nothing in the pack reads a secret value (no get-secret-value, no --with-decryption);
#   - ro() is the read-only call: describe/list/head/simulate and an allow-listed get-; Lambda and ECS task reads come back WITHOUT any Environment block;
#   - no script uses `--query` or `--output text`: it asks for JSON and parses it with jq (so the fixtures in the pack's tests can stand in for the CLI);
#   - gate markers are JSON files under $RUN_DIR/gates/ (name, sha, writtenAt, result, skippedReason, failures): the shape the policy evaluator reads.
# Run directory: RUN_DIR is the directory the stage uploads (the pipeline passes `out`). Overrides: OVERRIDES_FILE is the run's overrides.json (a run artifact, never a Mac file).

PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION=us-west-2

refuse() { echo "REFUSED: $*" >&2; exit 3; }
note() { echo "== $*"; }
warn() { echo "  [WARN] $*" >&2; }

# need_env NAME...: each must be set and non-empty.
need_env() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || refuse "environment variable $v is not set"
  done
}

# pack_init: the environment, region, run directory and execution identifiers every stage script needs.
pack_init() {
  need_env ENVIRONMENT RUN_DIR
  [ -z "$(find "$PACK_DIR" ! -type f ! -type d 2>/dev/null)" ] || refuse "the gate pack holds a symlink or another entry that is not a regular file or a directory"
  [ "$ENVIRONMENT" = staging ] || refuse "this pack serves the staging pipeline only (ENVIRONMENT=$ENVIRONMENT)"
  if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$REGION" ]; then refuse "AWS_REGION is $AWS_REGION, not $REGION"; fi
  if [ -n "${AWS_DEFAULT_REGION:-}" ] && [ "$AWS_DEFAULT_REGION" != "$REGION" ]; then refuse "AWS_DEFAULT_REGION is $AWS_DEFAULT_REGION, not $REGION"; fi
  # no bytecode caches: nothing may be written into the pinned pack (its hash covers every file in it)
  export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
  case "$RUN_DIR" in
    /|.|..|*..*) refuse "RUN_DIR '$RUN_DIR' is not a plain directory name" ;;
  esac
  mkdir -p "$RUN_DIR"
  PIPELINE_KIND="${PIPELINE_KIND:-code}"
  case "$PIPELINE_KIND" in code|cloud) ;; *) refuse "PIPELINE_KIND must be code or cloud" ;; esac
  if [ -n "${EXEC_ID:-}" ]; then
    uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    [[ "$EXEC_ID" =~ $uuid_re ]] || refuse "EXEC_ID is not a pipeline execution id"
    EXEC8="${EXEC_ID:0:8}"
    CS_NAME="rovara-pipeline-${EXEC8}"
  fi
  if [ -n "${RELEASE_SHA:-}" ]; then
    [[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || refuse "RELEASE_SHA is not a full 40-hex sha"
  fi
  PARAM_PREFIX="${PARAM_PREFIX:-/rovara-release/${ENVIRONMENT}}"
}

# a: one AWS call in the stack's region. Errors are shown (the caller decides what a failure means).
a() { aws "$@" --region "$REGION"; }

# Account of the signed-in role, and a check that it looks like one. The pack never names an account: it asks STS.
require_account() {
  local doc
  doc="$(aws sts get-caller-identity --output json --region "$REGION")" || refuse "could not read the signed-in account"
  ACCOUNT="$(printf '%s' "$doc" | jq -r '.Account // empty')"
  [[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || refuse "STS returned no account id"
  BOUNDARY_ARN="arn:aws:iam::${ACCOUNT}:policy/agentx/${ENVIRONMENT}/agentx-${ENVIRONMENT}-boundary"
  DEPLOY_ROLE_NAME="agentx-${ENVIRONMENT}-cloudformation"
  BOOTSTRAP_BUCKET="cdk-hnb659fds-assets-${ACCOUNT}-${REGION}"
}

# ro <service> <operation> [args...]: a read-only call. Anything but describe/list/head/simulate or an allow-listed get- is refused; secret reads and
# --with-decryption are never allowed. Lambda and ECS task reads have every Environment block removed from the answer before the caller sees it.
ro() {
  local svc="${1:?service}" op="${2:?operation}"
  local all="$*" low
  low="$(printf '%s' "$all" | tr '[:upper:]' '[:lower:]')"
  case "$op" in
    describe-*|list-*|head-*|simulate-principal-policy|simulate-custom-policy) ;;
    get-*)
      case "$svc $op" in
        "s3api get-bucket-"*|"iam get-role"|"iam get-role-policy"|"iam get-policy"|"iam get-policy-version"|"ssm get-parameter"|"ssm get-parameters"|"ssm get-parameters-by-path"|"cloudformation get-template"|"route53resolver get-"*|"kms get-key-policy"|"athena get-work-group"|"lambda get-function-configuration"|"codepipeline get-pipeline-execution"|"codepipeline get-pipeline-state"|"cloudwatch get-metric-statistics"|"cloudwatch get-metric-data") ;;
        *) refuse "ro: '$svc $op' is not on the read-only get allowlist" ;;
      esac ;;
    *) refuse "ro: '$svc $op' is not a read-only verb" ;;
  esac
  if [ "$svc" = secretsmanager ] && [ "$op" != describe-secret ] && [ "$op" != list-secrets ]; then refuse "ro: secretsmanager $op is not allowed (metadata reads only)"; fi
  case "$low" in *with-decryption*) refuse "ro: --with-decryption is never allowed" ;; esac
  local out rc=0
  case "$svc $op" in
    "lambda "*|"ecs describe-task-definition"|"ecs describe-tasks"|"ecs list-tasks")
      out="$(aws "$@" --region "$REGION" --output json)" || rc=$?
      [ "$rc" -eq 0 ] || return "$rc"
      printf '%s' "$out" | jq -c 'walk(if type == "object" then del(.Environment, .environment) else . end)'
      return 0 ;;
  esac
  aws "$@" --region "$REGION" --output json
}

# Read-only call whose failure means "absent": prints the JSON, or the fallback.
ro_or() { local fb="$1"; shift; ro "$@" 2>/dev/null || printf '%s' "$fb"; }

# ---- run directory, markers --------------------------------------------------------------------------------------------------------------------------

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_json <file> <jq program and args...>: writes the jq result to a temp file and renames it.
write_json() {
  local file="$1"; shift
  mkdir -p "$(dirname "$file")"
  jq "$@" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# gate_marker <name> <pass|fail|skipped> [skippedReason] [failure ...]: the JSON marker the evaluator's rule B reads.
gate_marker() {
  local name="$1" result="$2" reason="${3:-}"
  shift 2 || true; [ "$#" -gt 0 ] && shift || true
  case "$result" in pass|fail|skipped) ;; *) refuse "gate_marker: bad result $result" ;; esac
  need_env RELEASE_SHA RUN_DIR
  local failures='[]'
  if [ "$#" -gt 0 ]; then failures="$(printf '%s\n' "$@" | jq -R . | jq -sc .)"; fi
  write_json "$RUN_DIR/gates/${name}.json" -n --arg name "$name" --arg sha "$RELEASE_SHA" --arg at "$(now_utc)" --arg result "$result" --arg reason "$reason" --argjson failures "$failures" \
    '{name: $name, sha: $sha, writtenAt: $at, result: $result, failures: $failures} + (if $reason == "" then {} else {skippedReason: $reason} end)'
}

# ---- overrides (a run artifact) ----------------------------------------------------------------------------------------------------------------------

# overrides_file: the run's overrides.json. There is no default: the pipeline downloads it from the release package, the Mac flow passes its own copy.
overrides_file() {
  [ -n "${OVERRIDES_FILE:-}" ] || refuse "OVERRIDES_FILE is not set: the run's overrides.json is a run artifact, there is no default file"
  [ -f "$OVERRIDES_FILE" ] || refuse "OVERRIDES_FILE '$OVERRIDES_FILE' does not exist"
  printf '%s' "$OVERRIDES_FILE"
}
# overrides_get <part> <key>: the override value or empty.
overrides_get() { jq -r --arg p "$1" --arg k "$2" '(.[$p] // {})[$k] // empty' "$(overrides_file)"; }

# ---- stacks and order --------------------------------------------------------------------------------------------------------------------------------

# order_parts: the parts in the pack's deploy order (order.txt for the Code pipeline, order-cloud.txt for Cloud), comments and blank lines removed. Never the access stack.
order_parts() {
  local f="$PACK_DIR/order.txt"
  [ "$PIPELINE_KIND" = cloud ] && f="$PACK_DIR/order-cloud.txt"
  [ -f "$f" ] || refuse "the pack has no $(basename "$f")"
  local parts
  parts="$(grep -Ev '^[[:space:]]*(#|$)' "$f" | tr -d '\r')"
  [ -n "$parts" ] || refuse "$(basename "$f") lists no stack"
  case $'\n'"$parts"$'\n' in *$'\naccess\n'*) refuse "$(basename "$f") names the access stack: the pipeline never deploys it" ;; esac
  printf '%s\n' "$parts"
}

# stack_name <part>: the full CloudFormation stack name.
stack_name() {
  if [ "$PIPELINE_KIND" = cloud ]; then printf 'rovara-cloud-%s-%s' "$ENVIRONMENT" "$1"; else printf 'agentx-%s-%s' "$ENVIRONMENT" "$1"; fi
}

# stack_status <stack>: StackStatus or ABSENT.
stack_status() {
  local doc
  doc="$(ro cloudformation describe-stacks --stack-name "$1" 2>/dev/null)" || { printf 'ABSENT'; return 0; }
  printf '%s' "$doc" | jq -r '.Stacks[0].StackStatus // "ABSENT"'
}

# change_set_names <stack>: every change set name of the stack (one per line); the single line ?unreadable when the list cannot be read (callers must treat that as a failure).
change_set_names() {
  local doc
  doc="$(ro cloudformation list-change-sets --stack-name "$1" 2>/dev/null)" || { echo '?unreadable'; return 0; }
  printf '%s' "$doc" | jq -r '.Summaries[]?.ChangeSetName'
}

# ssm_value <name>: the parameter's value, or empty when it does not exist (ParameterNotFound only); any other read failure returns 1 (read without decryption).
ssm_value() {
  local doc err tmp rc=0
  tmp="$(mktemp)"
  doc="$(ro ssm get-parameter --name "$1" 2>"$tmp")" || rc=$?
  err="$(cat "$tmp")"; rm -f "$tmp"
  if [ "$rc" -ne 0 ]; then
    # only a plain "not found" means absent: throttling, AccessDenied or a network error must not read as "no value" (a pointer check would pass as none == none)
    case "$err" in *ParameterNotFound*) return 0 ;; esac
    echo "ssm_value: cannot read $1 (not a plain not-found): ${err:0:200}" >&2
    return 1
  fi
  printf '%s' "$doc" | jq -r '.Parameter.Value // empty'
}

# sha256 of a file (portable: GNU coreutils on CodeBuild, shasum on a Mac).
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# sha256 of the sorted manifest of every regular file under a directory (the release package hash; the same recipe as the pipeline's RELEASE_HASH_COMMAND).
dir_sha256() {
  ( cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256_file "$f")" "$f"; done | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1 )
}

# canon_sha256 <json file>: sha256 of the file's JSON in canonical form (sorted keys, compact). Used for templates, so the hash does not depend on how a file was written.
canon_sha256() {
  local tmp
  tmp="$(mktemp)"
  jq -cS . "$1" > "$tmp" || { rm -f "$tmp"; refuse "$1 is not JSON"; }
  sha256_file "$tmp"
  rm -f "$tmp"
}

# s3_get <stage> <file> <dest>: one object of this execution's run record (s3://$RUNS_BUCKET/<stage>/$EXEC_ID/<file>). Fails when it is not there.
s3_get() {
  need_env RUNS_BUCKET EXEC_ID
  mkdir -p "$(dirname "$3")"
  aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/$1/${EXEC_ID}/$2" "$3" --region "$REGION" >/dev/null
}
# s3_get_dir <stage> <prefix-in-stage> <dest dir>
s3_get_dir() {
  need_env RUNS_BUCKET EXEC_ID
  mkdir -p "$3"
  aws s3 cp --recursive --only-show-errors "s3://${RUNS_BUCKET}/$1/${EXEC_ID}/${2}" "$3" --region "$REGION" >/dev/null
}

# hold_names: the HOLD parameters of this pipeline (any parameter under <prefix>/<kind>-hold/, at any depth, or a bare <prefix>/<kind>-hold, means HOLD; the value does not matter), one name per line; ?unreadable when a read fails.
hold_names() {
  local doc bare err tmp rc=0
  doc="$(ro ssm get-parameters-by-path --path "${PARAM_PREFIX}/${PIPELINE_KIND}-hold/" --recursive 2>/dev/null)" || { echo "?unreadable"; return 0; }
  printf '%s' "$doc" | jq -r '.Parameters[]?.Name'
  # a bare <kind>-hold parameter (no child) is a HOLD too: Check reads it, so Decide, Guard and Deploy must agree
  tmp="$(mktemp)"
  bare="$(ro ssm get-parameter --name "${PARAM_PREFIX}/${PIPELINE_KIND}-hold" 2>"$tmp")" || rc=$?
  err="$(cat "$tmp")"; rm -f "$tmp"
  if [ "$rc" -eq 0 ]; then printf '%s' "$bare" | jq -r '.Parameter.Name // empty'
  else case "$err" in *ParameterNotFound*) ;; *) echo "?unreadable" ;; esac; fi
}
