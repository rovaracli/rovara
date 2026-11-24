#!/usr/bin/env bash
# Guard action (role `guard`): the FIRST action of the Release stage. Plan v3 stage 8 "Guard" part: order, hold, approval authenticity.
# It deploys nothing. It writes out/guard.json (uploaded to guard/<exec>/) ONLY when every check passes; Deploy refuses to run without that record.
#   - the execution is a STANDARD one (a rollback re-runs only this stage: the rollback rules are P9's, so until then it is refused)
#   - Decide recorded this sha and this execution
#   - no HOLD parameter exists
#   - the installed pointer is still what Check read (P-ORDER: nothing deployed since; Check already proved the installed sha is an ancestor of this sha)
#   - APPROVAL AUTHENTICITY: this execution's ApproveDeploy action succeeded, and
#       decision AUTO   -> approved by the auto-approver role, summary exactly `AUTO <sha> policy=<pin> decision=<sha256 of decision.json>`
#       decision MANUAL -> approved by the human approver role (never the auto-approver), summary starting `READY <sha>`
#     (S10) a MANUAL approval also needs the uploaded 89 RESULT (89/<exec>/RESULT.md) to hold a standalone line `READY <sha>`, and the summary must be exactly
#     `READY <sha> sha256=<sha256 of that RESULT file>`; the RESULT's hash goes into guard.json so Deploy can re-check it.
#     The boundary already lets only those two roles call PutApprovalResult; this checks which one did, and that it said the right thing. A missing field fails closed.
#     API shape (botocore model): ListActionExecutions returns `updatedBy` (not lastUpdatedBy, which is GetPipelineState's) and output.executionResult.externalExecutionSummary.
# Inputs: ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET PIPELINE_NAME PARAM_PREFIX
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA RUNS_BUCKET PIPELINE_NAME
require_account
WORK="${WORK:-$PWD/work/guard}"
mkdir -p "$WORK" "$RUN_DIR"

exec_doc="$(ro codepipeline get-pipeline-execution --pipeline-name "$PIPELINE_NAME" --pipeline-execution-id "$EXEC_ID")" || refuse "cannot read this pipeline execution"
exec_type="$(printf '%s' "$exec_doc" | jq -r '.pipelineExecution.executionType // "unknown"')"
[ "$exec_type" = STANDARD ] || refuse "execution type $exec_type: the rollback rules are not installed yet (P9), so the guard refuses"

s3_get decide decision.json "$WORK/decision.json" || refuse "Decide recorded nothing for this execution"
jq -e --arg sha "$RELEASE_SHA" --arg ex "$EXEC_ID" '(.verdict == "AUTO" or .verdict == "MANUAL") and .record.sha == $sha and .record.execution == $ex' "$WORK/decision.json" >/dev/null \
  || refuse "Decide's record names another sha or execution"
VERDICT="$(jq -r '.verdict' "$WORK/decision.json")"

holds="$(hold_names)"
[ -z "$holds" ] || refuse "a HOLD is set: $(printf '%s' "$holds" | tr '\n' ' ')"

s3_get check check.json "$WORK/check.json" || refuse "Check recorded nothing"
want="$(jq -r '.installed // "none"' "$WORK/check.json")"
now="$(ssm_value "${PARAM_PREFIX}/${PIPELINE_KIND}-installed")"
[ -n "$now" ] || now=none
[ "$want" = "$now" ] || refuse "the installed pointer moved since Check read it (Check: $want, now: $now)"

acts="$(ro codepipeline list-action-executions --pipeline-name "$PIPELINE_NAME" --filter "pipelineExecutionId=${EXEC_ID}")" || refuse "cannot read this execution's actions"
approval="$(printf '%s' "$acts" | jq -c '[.actionExecutionDetails[]? | select(.stageName == "Approve" and .actionName == "ApproveDeploy" and .status == "Succeeded")] | .[0] // empty')"
[ -n "$approval" ] || refuse "this execution's ApproveDeploy action has not succeeded"
by="$(printf '%s' "$approval" | jq -r '.updatedBy // empty')"
summary="$(printf '%s' "$approval" | jq -r '.output.executionResult.externalExecutionSummary // empty')"
[ -n "$by" ] || refuse "the approval names nobody (updatedBy missing): fail closed"
[ -n "$summary" ] || refuse "the approval has no summary: fail closed"
AUTO_ROLE="rovara-${ENVIRONMENT}-code-rel-auto-approver"
HUMAN_ROLE="rovara-${ENVIRONMENT}-code-rel-approver"
RESULT_SHA=""
if [ "$VERDICT" = AUTO ]; then
  case "$by" in *":assumed-role/${AUTO_ROLE}/"*) ;; *) refuse "an AUTO decision must be approved by the auto-approver role" ;; esac
  pin="$(ssm_value "${PARAM_PREFIX}/policy-pin")"
  dec_sha="$(sha256_file "$WORK/decision.json")"
  [ "$summary" = "AUTO ${RELEASE_SHA} policy=${pin} decision=${dec_sha}" ] || refuse "the approval summary does not match this decision"
else
  case "$by" in *":assumed-role/${HUMAN_ROLE}/"*) ;; *) refuse "a MANUAL decision must be approved by the human approver role" ;; esac
  s3_get 89 RESULT.md "$WORK/89-RESULT.md" || refuse "no uploaded 89 RESULT (89/${EXEC_ID}/RESULT.md): a manual approval needs it (S10)"
  grep -Fxq "READY ${RELEASE_SHA}" "$WORK/89-RESULT.md" || refuse "the uploaded 89 RESULT has no standalone line READY ${RELEASE_SHA}"
  RESULT_SHA="$(sha256_file "$WORK/89-RESULT.md")"
  [ "$summary" = "READY ${RELEASE_SHA} sha256=${RESULT_SHA}" ] || refuse "the approval summary is not exactly READY <sha> sha256=<hash of the uploaded 89 RESULT>"
fi

jq -n --arg ex "$EXEC_ID" --arg sha "$RELEASE_SHA" --arg verdict "$VERDICT" --arg by "$by" --arg at "$(now_utc)" --arg result "${RESULT_SHA:-}" \
  '{ok: true, execution: $ex, sha: $sha, verdict: $verdict, approvedBy: $by, checkedAt: $at} + (if $result == "" then {} else {resultSha256: $result} end)' > "$RUN_DIR/guard.json"
echo "GUARD_OK: $VERDICT decision, approved by the matching role; no hold; pointer unchanged"
