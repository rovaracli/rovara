#!/usr/bin/env bash
# Deploy action (role `deploy`), the 50- logic in PIPELINE MODE. Plan v3 stage 8; the Mac's 50-train1-order.sh is the model.
#
# It EXECUTES the change sets Preview made and Decide judged, BY NAME, as plain AWS CLI, in the pack's order.txt order, and then tidies leftovers.
# It runs NO repository code: no node, no npm, no agentx, no synth. The release package is only data here, and only its hash is read.
#
# Guards (each stops a real run; --dry-run lists every one as [ OK ] or [FAIL], executes nothing, and is what the Gates stage runs as the "50-dry-run" gate):
#   pipeline-identity      environment is staging, region us-west-2, execution id and sha well formed
#   guard-record           the Guard action wrote guard/<exec>/guard.json (ok, this sha): order, hold, rollback and approval were checked first
#   package-hash           the release package in hand has EXACTLY the hash Preview recorded (a differing hash is refused)
#   ready-guard            Decide's record exists for this sha and this execution, and names the change sets (the approval itself is the Approve stage; Guard read it)
#   recorded-change-sets   every stack of order.txt has a recorded change set whose name, id, status and template hash CloudFormation still confirms; an unrecorded change
#                          set, a different id or a changed template is refused. The access stack is never executed, whatever any file says
#   stacks-settled         every target stack is settled (UPDATE_COMPLETE; control-plane may be UPDATE_ROLLBACK_COMPLETE)
#   gates                  every gate marker names this sha and passes (a standing skip needs its recorded reason)
#   installed-pointer      the installed pointer still holds the sha Check read (nothing deployed in between)
#   no-hold                no HOLD parameter exists
# In --dry-run (the Gates stage runs it BEFORE Decide and the approval exist) Decide's record, the Guard record and the gate markers cannot exist yet: they are reported together as the
# one expected failure `ready-guard` (the policy ignores exactly that name), and the change sets are verified against Preview's own record instead of Decide's.
# Inputs (environment): ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET; the release package is SYNTH_DIR or ./work/release (the stage downloaded it and checked it again).
# Usage: deploy.sh [--dry-run]
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) refuse "usage: deploy.sh [--dry-run]" ;;
esac
[ "$#" -le 1 ] || refuse "usage: deploy.sh [--dry-run]"
pack_init
need_env EXEC_ID RELEASE_SHA RUNS_BUCKET
require_account

WORK="${WORK:-$PWD/work/deploy}"
mkdir -p "$WORK"
PKG_DIR="${SYNTH_DIR:-$PWD/work/release}"
ACCESS_STACK="$(stack_name access)"
PARTS="$(order_parts)"
INSTALLED_PTR="${PARAM_PREFIX}/${PIPELINE_KIND}-installed"

nfail=0
FAILED_GUARDS=""
# guard <name> <function>: a real run stops at the first failure; a dry run counts them all.
guard() {
  local name="$1" fn="$2" out rc
  # The guard runs with -e active (a `|| rc=$?` around it would switch -e off inside the function): its status is read from the marker line.
  out="$( ( set -euo pipefail; "$fn" ) 2>&1; echo "GUARD_RC=$?" )"
  rc="${out##*GUARD_RC=}"
  out="${out%GUARD_RC=*}"
  if [ "$rc" -eq 0 ]; then echo "  [ OK ] $name"; else
    echo "  [FAIL] $name"
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/         /'
    if [ "$DRY" = 1 ]; then nfail=$((nfail + 1)); FAILED_GUARDS="$FAILED_GUARDS $name"; else exit 3; fi
  fi
}

g_identity() { [ "$ENVIRONMENT" = staging ] && [ "$REGION" = us-west-2 ] && [ -n "$EXEC8" ]; }
g_guard_record() {
  s3_get guard guard.json "$WORK/guard.json" || refuse "no guard record: the Guard action did not run or did not pass"
  jq -e --arg sha "$RELEASE_SHA" --arg ex "$EXEC_ID" '.ok == true and .sha == $sha and .execution == $ex' "$WORK/guard.json" >/dev/null || refuse "the guard record is not an ok record for this execution and sha"
  # S10: a manual approval stands on the uploaded 89 RESULT. Guard recorded its hash; it must still be that file, and it must still say READY for this sha.
  if [ "$(jq -r '.verdict' "$WORK/guard.json")" = MANUAL ]; then
    local want
    want="$(jq -r '.resultSha256 // empty' "$WORK/guard.json")"
    [ -n "$want" ] || refuse "a manual approval has no recorded 89 RESULT hash"
    s3_get 89 RESULT.md "$WORK/89-RESULT.md" || refuse "no uploaded 89 RESULT (89/${EXEC_ID}/RESULT.md)"
    grep -Fxq "READY ${RELEASE_SHA}" "$WORK/89-RESULT.md" || refuse "the uploaded 89 RESULT has no standalone line READY ${RELEASE_SHA}"
    [ "$(sha256_file "$WORK/89-RESULT.md")" = "$want" ] || refuse "the 89 RESULT changed after Guard read it"
  fi
}
g_package_hash() {
  [ -d "$PKG_DIR" ] || refuse "no release package at $PKG_DIR"
  s3_get preview release.sha256 "$WORK/preview-release.sha256" || refuse "Preview recorded no release package hash"
  s3_get preview preview.json "$WORK/preview.json" || refuse "Preview recorded nothing"
  local want have in_json
  want="$(tr -d '[:space:]' < "$WORK/preview-release.sha256")"
  in_json="$(jq -r '.releasePackageSha256 // empty' "$WORK/preview.json")"
  have="$(dir_sha256 "$PKG_DIR")"
  [ "$want" = "$in_json" ] || refuse "Preview's two records of the package hash differ"
  [ "$have" = "$want" ] || refuse "the release package differs from the one Preview recorded"
}
g_pre_decision() {
  # dry run only: the conditions that come after this stage
  refuse "Decide, the approval, the Guard record and the gate markers come after the dry run (expected)"
}
g_preview_as_record() {
  # dry run only: judge the change sets against Preview's record (what Decide will be asked to judge)
  jq -c '{record: {changeSets: .changeSets}}' "$WORK/preview.json" > "$WORK/decision.json"
}
g_ready() {
  s3_get decide decision.json "$WORK/decision.json" || refuse "Decide recorded nothing for this execution"
  jq -e --arg sha "$RELEASE_SHA" --arg ex "$EXEC_ID" '(.verdict == "AUTO" or .verdict == "MANUAL") and .record.sha == $sha and .record.execution == $ex and (.record.changeSets | type == "array")' "$WORK/decision.json" >/dev/null \
    || refuse "Decide's record is missing or names another sha or execution"
  [ "$(jq -r '.record.releasePackageSha256' "$WORK/decision.json")" = "$(jq -r '.releasePackageSha256' "$WORK/preview.json")" ] || refuse "Decide judged another release package than Preview recorded"
}
# One recorded change set, confirmed against CloudFormation. Echoes nothing; refuses on any difference.
verify_change_set() {
  local part="$1" stack rec
  stack="$(stack_name "$part")"
  [ "$stack" != "$ACCESS_STACK" ] || refuse "the access stack is never executed by the pipeline"
  rec="$(jq -c --arg s "$stack" '[.record.changeSets[] | select(.stack == $s)]' "$WORK/decision.json")"
  [ "$(printf '%s' "$rec" | jq 'length')" = 1 ] || refuse "$stack: Decide recorded $(printf '%s' "$rec" | jq 'length') change sets for it (exactly one is required)"
  rec="$(printf '%s' "$rec" | jq -c '.[0]')"
  [ "$(printf '%s' "$rec" | jq -r '.changeSetName')" = "$CS_NAME" ] || refuse "$stack: the recorded change set is not named $CS_NAME"
  # Preview's own record must agree with Decide's record.
  [ "$(jq -r --arg s "$stack" '[.changeSets[] | select(.stack == $s)][0].changeSetId' "$WORK/preview.json")" = "$(printf '%s' "$rec" | jq -r '.changeSetId')" ] || refuse "$stack: Preview and Decide recorded different change set ids"
  local doc
  doc="$(ro cloudformation describe-change-set --stack-name "$stack" --change-set-name "$CS_NAME")" || refuse "$stack: the change set $CS_NAME cannot be read"
  [ "$(printf '%s' "$doc" | jq -r '.ChangeSetId')" = "$(printf '%s' "$rec" | jq -r '.changeSetId')" ] || refuse "$stack: the change set in CloudFormation is not the one Decide judged (different id)"
  if [ "$(printf '%s' "$rec" | jq -r '.noChanges')" = true ]; then
    [ "$(printf '%s' "$doc" | jq -r '.Status')" = FAILED ] || refuse "$stack: recorded as no changes but the change set is $(printf '%s' "$doc" | jq -r '.Status')"
    return 0
  fi
  [ "$(printf '%s' "$doc" | jq -r '.Status')" = CREATE_COMPLETE ] && [ "$(printf '%s' "$doc" | jq -r '.ExecutionStatus')" = AVAILABLE ] || refuse "$stack: the change set is $(printf '%s' "$doc" | jq -r '.Status')/$(printf '%s' "$doc" | jq -r '.ExecutionStatus'), not available (the environment changed after the preview)"
  ro cloudformation get-template --stack-name "$stack" --change-set-name "$CS_NAME" --template-stage Original | jq -c '.TemplateBody' > "$WORK/$stack.cs-template.json"
  [ "$(canon_sha256 "$WORK/$stack.cs-template.json")" = "$(printf '%s' "$rec" | jq -r '.templateSha256')" ] || refuse "$stack: the change set's template is not the one Decide judged"
}
g_change_sets() {
  local part
  # The access stack may sit in a record (it is previewed for the 0-rows check) but nothing here ever executes it: refuse when order.txt (or anything feeding PARTS) names it.
  for part in $PARTS; do
    [ "$(stack_name "$part")" != "$ACCESS_STACK" ] || refuse "the access stack is in the deploy order: refused"
    verify_change_set "$part"
  done
  # Every change set a record names must belong to a stack of the order or be the access stack; anything else is unrecorded business.
  local stacks_in_record s
  stacks_in_record="$(jq -r '.record.changeSets[].stack' "$WORK/decision.json")"
  for s in $stacks_in_record; do
    [ "$s" = "$ACCESS_STACK" ] && continue
    local ok=0
    for part in $PARTS; do [ "$(stack_name "$part")" = "$s" ] && ok=1; done
    [ "$ok" = 1 ] || refuse "Decide's record names the change set of $s, which is not in the deploy order"
  done
}
g_settled() {
  local part stack st
  for part in $PARTS; do
    stack="$(stack_name "$part")"
    st="$(stack_status "$stack")"
    case "$st" in
      UPDATE_COMPLETE|CREATE_COMPLETE) ;;
      UPDATE_ROLLBACK_COMPLETE) [ "$part" = control-plane ] || refuse "$stack is $st" ;;
      *) refuse "$stack is '$st', expected UPDATE_COMPLETE" ;;
    esac
  done
}
g_gates() {
  s3_get_dir gates gates "$WORK/gates" || refuse "no gate markers for this execution"
  local n=0 f
  for f in "$WORK"/gates/*.json; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    jq -e --arg sha "$RELEASE_SHA" '.sha == $sha and (.result == "pass" or (.result == "skipped" and ((.skippedReason // "") != "")))' "$f" >/dev/null || refuse "gate marker $(basename "$f") does not pass for this sha"
  done
  [ "$n" -gt 0 ] || refuse "no gate marker files"
}
g_installed_pointer() {
  s3_get check check.json "$WORK/check.json" || refuse "Check recorded nothing"
  local want now
  want="$(jq -r '.installed // "none"' "$WORK/check.json")"
  now="$(ssm_value "$INSTALLED_PTR")"
  [ -n "$now" ] || now=none
  [ "$want" = "$now" ] || refuse "the installed pointer moved since Check read it (Check: $want, now: $now)"
}
g_no_hold() {
  local holds
  holds="$(hold_names)"
  [ -z "$holds" ] || refuse "a HOLD is set: $(printf '%s' "$holds" | tr '\n' ' ')"
}

echo "== deploy ${ENVIRONMENT}, release ${RELEASE_SHA:0:12}, change set ${CS_NAME} ($([ "$DRY" = 1 ] && echo DRY RUN || echo REAL)); $(now_utc)"
echo "guards:"
guard pipeline-identity g_identity
if [ "$DRY" = 1 ]; then
  guard package-hash g_package_hash
  guard ready-guard g_pre_decision
  g_preview_as_record 2>/dev/null || true
  guard recorded-change-sets g_change_sets
  guard stacks-settled g_settled
else
  guard guard-record g_guard_record
  guard package-hash g_package_hash
  guard ready-guard g_ready
  guard recorded-change-sets g_change_sets
  guard stacks-settled g_settled
  guard gates g_gates
fi
guard installed-pointer g_installed_pointer
guard no-hold g_no_hold

echo "order (one stack at a time):"
for part in $PARTS; do echo "  $(stack_name "$part")"; done
if [ "$DRY" = 1 ]; then
  mkdir -p "$RUN_DIR"
  printf '%s\n' "$FAILED_GUARDS" | tr ' ' '\n' | grep -v '^$' > "$RUN_DIR/dry-run-failures.txt" || true
  if [ "$nfail" -eq 0 ]; then echo "DRY RUN: every guard passed; nothing was executed."; else echo "DRY RUN: $nfail guard(s) FAIL:${FAILED_GUARDS}. Nothing was executed."; fi
  exit 0
fi

# ---- real run: execute the recorded change sets, by name, in order ----
mkdir -p "$RUN_DIR"
: > "$RUN_DIR/steps.jsonl"
step() { jq -nc --arg stack "$1" --arg what "$2" --arg at "$(now_utc)" --arg detail "${3:-}" '{stack: $stack, step: $what, at: $at, detail: $detail}' >> "$RUN_DIR/steps.jsonl"; }
for part in $PARTS; do
  stack="$(stack_name "$part")"
  [ "$stack" != "$ACCESS_STACK" ] || refuse "the access stack is never executed by the pipeline"
  if [ "$(jq -r --arg s "$stack" '[.record.changeSets[] | select(.stack == $s)][0].noChanges' "$WORK/decision.json")" = true ]; then
    echo "== $stack: no changes, nothing to execute"; step "$stack" skipped "no changes"; continue
  fi
  # F3: the up-front verification can be tens of minutes old by the time a later stack comes: re-check THIS change set (same id, same template hash, still the recorded one),
  # that no HOLD appeared and that the installed pointer is unmoved, immediately before the ExecuteChangeSet. The stack must still be settled.
  verify_change_set "$part"
  g_no_hold
  g_installed_pointer
  case "$(stack_status "$stack")" in UPDATE_COMPLETE|CREATE_COMPLETE) ;; UPDATE_ROLLBACK_COMPLETE) [ "$part" = control-plane ] || refuse "$stack is no longer settled" ;; *) refuse "$stack is no longer settled" ;; esac
  step "$stack" reverified
  echo "== executing $CS_NAME on $stack; $(now_utc)"
  step "$stack" execute-started
  a cloudformation execute-change-set --stack-name "$stack" --change-set-name "$CS_NAME" >/dev/null || { step "$stack" execute-refused; echo "DEPLOY STOP: CloudFormation refused to execute $CS_NAME on $stack"; exit 1; }
  a cloudformation wait stack-update-complete --stack-name "$stack" >/dev/null 2>&1 || true
  st="$(stack_status "$stack")"
  step "$stack" finished "$st"
  # what ran must be what was recorded: the change set of that name still has the recorded id (a replacement made after the pre-execute check would show here)
  want_id="$(jq -r --arg s "$stack" '[.record.changeSets[] | select(.stack == $s)][0].changeSetId' "$WORK/decision.json")"
  got_id="$(ro cloudformation describe-change-set --stack-name "$stack" --change-set-name "$CS_NAME" 2>/dev/null | jq -r '.ChangeSetId // empty')" || got_id=""
  if [ "$got_id" != "$want_id" ]; then
    step "$stack" id-mismatch "$got_id"
    echo "DEPLOY STOP: after the execute, $CS_NAME on $stack is not the recorded change set (recorded $want_id, found ${got_id:-nothing}); later stacks are not executed"
    exit 1
  fi
  if [ "$st" != UPDATE_COMPLETE ]; then
    echo "DEPLOY STOP: $stack ended as $st (CloudFormation rolls an update back under the old role; read the events)"
    ro cloudformation describe-stack-events --stack-name "$stack" | jq -r '[.StackEvents[] | select(.ResourceStatus | test("FAILED"))][:5][] | "  \(.LogicalResourceId): \(.ResourceStatusReason // "")"' | cut -c1-300 || true
    exit 1
  fi
done

# ---- tidy: this run's change sets (incl. the access preview and no-change sets), and other pipeline change sets that are no longer usable (an executed change set made every other
# one on its stack OBSOLETE). A change set that is still AVAILABLE belongs to a newer execution that has not deployed yet (or to a stack this run did not touch): it is left alone. ----
for stack in "$ACCESS_STACK" $(for part in $PARTS; do stack_name "$part"; done); do
  for name in $(change_set_names "$stack"); do
    case "$name" in
      rovara-pipeline-*)
        if [ "$name" != "$CS_NAME" ]; then
          other_status="$(ro cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" 2>/dev/null | jq -r '.ExecutionStatus // "?"')" || other_status="?"
          [ "$other_status" != AVAILABLE ] && [ "$other_status" != "?" ] || continue
        fi
        a cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name" >/dev/null && step "$stack" tidied "$name" || warn "could not delete $name on $stack" ;;
    esac
  done
done
jq -n --arg exec "$EXEC_ID" --arg sha "$RELEASE_SHA" --arg at "$(now_utc)" --slurpfile steps "$RUN_DIR/steps.jsonl" '{execution: $exec, sha: $sha, finishedAt: $at, ok: true, steps: $steps}' > "$RUN_DIR/deploy.json"
echo "DEPLOY_DONE: every recorded change set executed; leftovers tidied."
