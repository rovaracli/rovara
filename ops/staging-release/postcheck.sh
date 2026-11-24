#!/usr/bin/env bash
# PostCheck action (role `postcheck`, read-only plus the installed pointer and HOLD). Plan v3 stage 9, ported from the Mac's 60-post-step-checks.sh and the install proofs.
# Runs after Deploy. Every check prints [PASS] / [WARN] / [FAIL]; any FAIL stops the stage (the Release stage then rolls back, P9), sets a HOLD, and does NOT move the pointer.
#   stacks     every stack of the order is UPDATE_COMPLETE and no change set is left on any stack; the DELETE_FAILED events of the latest update are the expected set only
#   images     runtime WorkerImageUri and slack OrchestratorImageUri equal this run's overrides.json (a run artifact)
#   outputs    ApiEndpoint, UserPoolId and the CloudFormation role output unchanged (read before Preview, read again now)
#   lambdas    every Lambda of the control-plane stack: Active and LastUpdateStatus Successful
#   health     the public JWKS answers 200
#   errors     Lambda Errors stay 0 for POSTCHECK_WATCH_MINUTES (default 15) after the deploy finished
#   slack      the ECS service is steady (ACTIVE, desired == running, one COMPLETED deployment; waits up to 10 minutes, read-only)
# On success it writes the installed pointer (<prefix>/code-installed = this sha), but only while the pointer still holds the sha Check read (P-ORDER).
# NOT done here (stand-up items, see DONE): the settings record version (written by the agentx CLI after a deploy, never by a change set), the feedback-state counts (no data-plane read).
# Inputs: ENVIRONMENT RUN_DIR EXEC_ID RELEASE_SHA RUNS_BUCKET PARAM_PREFIX; POSTCHECK_WATCH_MINUTES, POSTCHECK_SLEEP_SECONDS, SLACK_ROLLOUT_WAIT_SECONDS, JWKS_URL (tests only)
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA RUNS_BUCKET
require_account
WORK="${WORK:-$PWD/work/postcheck}"
mkdir -p "$WORK" "$RUN_DIR"
npass=0; nwarn=0; nfail=0
pass() { npass=$((npass + 1)); echo "  [PASS] $*"; }
warn() { nwarn=$((nwarn + 1)); echo "  [WARN] $*"; }
fail() { nfail=$((nfail + 1)); echo "  [FAIL] $*"; }

s3_get release deploy.json "$WORK/deploy.json" || refuse "Deploy recorded nothing: PostCheck has nothing to check"
s3_get build release/overrides.json "$WORK/overrides.json" || refuse "no overrides.json for this run"
s3_get preview before-outputs.json "$WORK/before-outputs.json" || refuse "Preview recorded no before-outputs"
s3_get check check.json "$WORK/check.json" || refuse "Check recorded nothing"
export OVERRIDES_FILE="$WORK/overrides.json"
jq -e --arg sha "$RELEASE_SHA" '.ok == true and .sha == $sha' "$WORK/deploy.json" >/dev/null || refuse "Deploy's record is not an ok record for this sha"
FINISHED="$(jq -r '.finishedAt' "$WORK/deploy.json")"
PARTS="$(order_parts)"
ALL_PARTS="access $PARTS"

note "stacks"
for part in $PARTS; do
  stack="$(stack_name "$part")"
  st="$(stack_status "$stack")"
  [ "$st" = UPDATE_COMPLETE ] && pass "$stack is UPDATE_COMPLETE" || fail "$stack is '$st' (expected UPDATE_COMPLETE)"
done
for part in $ALL_PARTS; do
  stack="$(stack_name "$part")"
  names="$(change_set_names "$stack")"
  if printf '%s\n' "$names" | grep -Fxq '?unreadable'; then fail "cannot read the change sets of $stack"; else
    left="$(printf '%s\n' "$names" | grep -c '^rovara-pipeline-' || true)"
    [ "$left" = 0 ] && pass "$stack has no pipeline change set left" || fail "$stack still has $left pipeline change set(s)"
  fi
  ev="$(ro cloudformation describe-stack-events --stack-name "$stack" 2>/dev/null)" || { fail "cannot read the events of $stack"; continue; }
  # the latest update window starts at the newest UPDATE_IN_PROGRESS of the stack itself
  bad="$(printf '%s' "$ev" | jq -r --arg part "$part" '
    (.StackEvents | (map(.ResourceType == "AWS::CloudFormation::Stack" and .ResourceStatus == "UPDATE_IN_PROGRESS") | index(true)) // (length - 1)) as $i
    | [.StackEvents[0:($i + 1)][] | select(.ResourceStatus == "DELETE_FAILED") | .LogicalResourceId] | unique
    | map(select(. as $id | (if $part == "control-plane" then ["ModelProxyLoadBalancerSecurityGroup83779477","EmbedderSubnet1","EmbedderSubnet2","EmbedderSecurityGroup","EmbedderNetwork","ModelAccessSecurityGroup5094A98C","TeamRecordLakeWorkGroupE2070EE5"] else [] end) | index($id) | not))
    | join(" ")')"
  [ -z "$bad" ] && pass "$stack: no unexpected DELETE_FAILED resource" || fail "$stack: unexpected DELETE_FAILED: $bad"
done

note "images"
check_param() { # part key
  local want got
  want="$(overrides_get "$1" "$2")"
  [ -n "$want" ] || { warn "overrides.json names no $2 (nothing to compare)"; return 0; }
  got="$(ro cloudformation describe-stacks --stack-name "$(stack_name "$1")" | jq -r --arg k "$2" '[.Stacks[0].Parameters[]? | select(.ParameterKey == $k) | .ParameterValue][0] // ""')"
  [ "$got" = "$want" ] && pass "$2 on $1 equals the override (${got##*@})" || fail "$2 on $1 is '$got', the run's overrides say '$want'"
}
check_param runtime WorkerImageUri
check_param slack OrchestratorImageUri

note "outputs that must not move"
for part in $ALL_PARTS; do
  stack="$(stack_name "$part")"
  now="$(ro cloudformation describe-stacks --stack-name "$stack" | jq -c '[.Stacks[0].Outputs // [] | .[] | {(.OutputKey): .OutputValue}] | add // {}')"
  for key in ApiEndpoint UserPoolId CloudFormationRoleArn; do
    was="$(jq -r --arg k "$key" '[.[] | select(.OutputKey == $k) | .OutputValue][0] // ""' "$WORK/before-outputs.json")"
    # before-outputs holds every stack's outputs together: the keys above are unique across the environment's stacks
    [ -n "$was" ] || continue
    cur="$(printf '%s' "$now" | jq -r --arg k "$key" '.[$k] // ""')"
    [ -n "$cur" ] || continue
    [ "$cur" = "$was" ] && pass "output $key unchanged" || fail "output $key moved: was '$was', now '$cur'"
  done
done

note "lambdas of the control plane"
cp_stack="$(stack_name control-plane)"
fns="$(ro cloudformation list-stack-resources --stack-name "$cp_stack" | jq -r '[.StackResourceSummaries[]? | select(.ResourceType == "AWS::Lambda::Function") | .PhysicalResourceId] | .[]')"
nfn=0
for fn in $fns; do
  nfn=$((nfn + 1))
  cfg="$(ro lambda get-function-configuration --function-name "$fn")" || { fail "cannot read Lambda $fn"; continue; }
  [ "$(printf '%s' "$cfg" | jq -r '.State // "Active"')" = Active ] && [ "$(printf '%s' "$cfg" | jq -r '.LastUpdateStatus // "Successful"')" = Successful ] || fail "Lambda $fn is not Active/Successful"
done
[ "$nfn" -gt 0 ] && pass "$nfn Lambda(s) read; failures above if any" || fail "the control-plane stack lists no Lambda"

note "health"
api="$(jq -r '[.[] | select(.OutputKey == "ApiEndpoint") | .OutputValue][0] // ""' "$WORK/before-outputs.json")"
url="${JWKS_URL:-${api}/v1/auth/.well-known/jwks.json}"
if [ -n "${JWKS_URL:-}" ] || printf '%s' "$api" | grep -Eq '^https://'; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)"
  [ "$code" = 200 ] && pass "public JWKS answers 200" || fail "public JWKS answered $code"
else fail "no https ApiEndpoint output to probe"; fi

note "Lambda errors for ${POSTCHECK_WATCH_MINUTES:-15} minutes after the deploy"
watch_min="${POSTCHECK_WATCH_MINUTES:-15}"; sleep_s="${POSTCHECK_SLEEP_SECONDS:-60}"
printf '%s' "$watch_min" | grep -Eq '^[0-9]+$' || refuse "POSTCHECK_WATCH_MINUTES is not a number"
end_epoch=$(( $(date -u -d "$FINISHED" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$FINISHED" +%s) + watch_min * 60 ))
errors_total() {
  local total=0 fn doc sum
  for fn in $fns; do
    doc="$(ro cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors --dimensions "Name=FunctionName,Value=$fn" --start-time "$FINISHED" --end-time "$(now_utc)" --period 60 --statistics Sum)" || return 1
    sum="$(printf '%s' "$doc" | jq '[.Datapoints[]?.Sum] | add // 0')" || return 1
    total=$(( total + ${sum%.*} ))
  done
  echo "$total"
}
while :; do
  e="$(errors_total)" || { fail "cannot read the Lambda Errors metric"; break; }
  if [ "$e" != 0 ]; then fail "Lambda Errors = $e since the deploy finished"; break; fi
  [ "$(date -u +%s)" -ge "$end_epoch" ] && { pass "Lambda Errors stayed 0 through the watch window"; break; }
  sleep "$sleep_s"
done

note "slack service"
wait_s="${SLACK_ROLLOUT_WAIT_SECONDS:-600}"; t0="$(date +%s)"
sl_res="$(ro cloudformation list-stack-resources --stack-name "$(stack_name slack)")"
svc="$(printf '%s' "$sl_res" | jq -r '[.StackResourceSummaries[]? | select(.ResourceType == "AWS::ECS::Service") | .PhysicalResourceId][0] // ""')"
cluster="$(printf '%s' "$sl_res" | jq -r '[.StackResourceSummaries[]? | select(.ResourceType == "AWS::ECS::Cluster") | .PhysicalResourceId][0] // ""')"
if [ -z "$svc" ] || [ -z "$cluster" ]; then fail "the slack stack has no ECS service or cluster"; else
  while :; do
    d="$(ro ecs describe-services --cluster "$cluster" --services "$svc")"
    steady="$(printf '%s' "$d" | jq -r '.services[0] | (.status == "ACTIVE" and .desiredCount == .runningCount and (.deployments | length) == 1 and .deployments[0].rolloutState == "COMPLETED")')"
    [ "$steady" = true ] && { pass "ECS service steady"; break; }
    [ $(( $(date +%s) - t0 )) -ge "$wait_s" ] && { fail "ECS service not steady after ${wait_s}s"; break; }
    sleep 15
  done
fi

# ---- verdict, pointer, hold ----
jq -n --arg ex "$EXEC_ID" --arg sha "$RELEASE_SHA" --argjson pass "$npass" --argjson warn "$nwarn" --argjson fail "$nfail" --arg at "$(now_utc)" \
  '{execution: $ex, sha: $sha, pass: $pass, warn: $warn, fail: $fail, checkedAt: $at, settingsRecord: "not written by the pipeline (the agentx CLI writes it): not checked", feedbackCounts: "not checked (no data-plane read)"}' > "$RUN_DIR/postcheck.json"
echo "POSTCHECK $nfail FAIL, $nwarn warn, $npass pass"
if [ "$nfail" -ne 0 ]; then
  hold="${PARAM_PREFIX}/${PIPELINE_KIND}-hold/postcheck-${EXEC8}"
  a ssm put-parameter --name "$hold" --type String --value "postcheck failed for ${RELEASE_SHA} (execution ${EXEC_ID})" >/dev/null 2>&1 || warn "could not set the HOLD parameter (it may exist already)"
  echo "POSTCHECK STOP: HOLD set; the installed pointer was NOT moved"
  exit 1
fi
want="$(jq -r '.installed // "none"' "$WORK/check.json")"
now="$(ssm_value "${PARAM_PREFIX}/${PIPELINE_KIND}-installed")"; [ -n "$now" ] || now=none
[ "$want" = "$now" ] || { echo "POSTCHECK STOP: the installed pointer moved while this release deployed (Check: $want, now: $now); not writing it"; exit 1; }
a ssm put-parameter --name "${PARAM_PREFIX}/${PIPELINE_KIND}-installed" --type String --overwrite --value "$RELEASE_SHA" >/dev/null || refuse "could not write the installed pointer"
echo "POSTCHECK_DONE: installed pointer = ${RELEASE_SHA:0:12}"
