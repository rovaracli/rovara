#!/usr/bin/env bash
# Gate 45 (pre-checks of a settled environment before an in-place upgrade). READ-ONLY: ro() only, no secret value, no Lambda environment.
# Port of the Mac 45-access-last-checks.sh. Env: ENVIRONMENT, RUN_DIR, CS_NAME (the pipeline's own change set name), PIPELINE_KIND. Exit 0 = no FAIL, 1 = a FAIL.
# Results: $RUN_DIR/gates/45-checks/results.txt.
#
# Kept (what a routine upgrade of a settled environment can break):
#   1  every stack of the access stack + the pack's order is settled (UPDATE_COMPLETE / CREATE_COMPLETE / UPDATE_ROLLBACK_COMPLETE) and its ONLY change set is $CS_NAME
#   2  /agentx/<env>/settings parses as Code expects (naming, env/account/region, identity, the six stacks)
#   3  callback signing key secret: metadata only (the pipeline keeps the previous parameter value; it never reads the secret)
#   3b broker-names parameter is a String, the callback-key secret carries its env tag, the company stack parameters are on the live stacks
#   11 the DNS firewall association is still on the VPC and COMPLETE, and the three domain lists still exist (as reads; nothing is saved: the Mac copy was for the one-time switch-over)
# Dropped (switch-over only: they guard the one-time delete of the old monolith, which a routine upgrade never makes):
#   4 Athena workgroup named queries and 5 RDS DeletionProtection (the monolith resources are gone), 6 CloudFront tag (same), 7 role agentx-<env>-img-create (the OLD deploy policy's
#   delete), 8 broker managed policies attached only to the broker role (the monolith cleanup), 9 Slack ModelProxyEgress and 10 embedder ENIs (control-plane delete ordering).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
pack_init
need_env EXEC_ID
require_account
RDIR="$RUN_DIR/gates/45-checks"
mkdir -p "$RDIR"
exec > >(tee "$RDIR/results.txt") 2>&1

npass=0 nwarn=0 nfail=0
pass() { npass=$((npass + 1)); echo "  [PASS] $*"; }
fail() { nfail=$((nfail + 1)); echo "  [FAIL] $*"; }
warnx() { nwarn=$((nwarn + 1)); echo "  [WARN] $*"; }
E1="$ENVIRONMENT"

# physid <stack> <logical id>: the physical id, or empty.
physid() {
  local doc
  doc="$(ro cloudformation list-stack-resources --stack-name "$1" 2>/dev/null)" || return 0
  printf '%s' "$doc" | jq -r --arg l "$2" '[.StackResourceSummaries[]? | select(.LogicalResourceId == $l) | .PhysicalResourceId][0] // empty'
}

note "45- pre-checks (read-only), $ENVIRONMENT, $(now_utc)"

note "1. stacks and change sets (the only change set allowed is $CS_NAME)"
STACKS="agentx-$E1-access"
for p in $(order_parts); do STACKS="$STACKS $(stack_name "$p")"; done
for s in $STACKS; do
  st="$(stack_status "$s")"
  case "$st" in
    UPDATE_COMPLETE|CREATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) pass "$s is $st" ;;
    *) fail "$s is '$st' (expected UPDATE_COMPLETE)" ;;
  esac
  names="$(change_set_names "$s")"
  if [ "$names" = '?' ]; then
    fail "$s: the change sets could not be listed"
  else
    other="$(printf '%s\n' "$names" | grep -v '^$' | grep -vx "$CS_NAME" || true)"
    if [ -n "$other" ]; then fail "$s has a change set that is not this run's ($CS_NAME): $(printf '%s' "$other" | tr '\n' ' ')"; else pass "$s has no change set other than $CS_NAME"; fi
  fi
done

note "2. /agentx/$E1/settings (what Code's agentx reads)"
SETTINGS="$(ssm_value "/agentx/$E1/settings")"
if [ -z "$SETTINGS" ] || ! printf '%s' "$SETTINGS" | jq -e . >/dev/null 2>&1; then
  fail "/agentx/$E1/settings is missing or not JSON"
else
  chk() { if [ "$1" = true ]; then pass "$2"; else fail "$3"; fi; }
  chk "$(printf '%s' "$SETTINGS" | jq -r '.naming == "environment"')" "naming = environment" "naming is not 'environment': Code refuses a legacy naming"
  chk "$(printf '%s' "$SETTINGS" | jq -r --arg e "$E1" --arg a "$ACCOUNT" --arg r "$REGION" '.env == $e and .account == $a and .region == $r')" "env, account and region as expected" "env/account/region differ from $E1 / the signed-in account / $REGION"
  chk "$(printf '%s' "$SETTINGS" | jq -r '(.identity.mode // "") == "cognito"')" "identity mode = cognito" "identity mode is not cognito"
  chk "$(printf '%s' "$SETTINGS" | jq -r '(.stacks // {}) as $s | (["access","foundation","identity","runtime","control-plane","slack"] | all(. as $k | $s | has($k)))')" "settings name all six stacks" "settings do not name all six stacks"
  echo "  [INFO] engine = $(printf '%s' "$SETTINGS" | jq -r '.engine // "none"'), version = $(printf '%s' "$SETTINGS" | jq -r '.version // "none"')"
fi

note "3. callback signing key secret (metadata only; the value is never read)"
if ro secretsmanager describe-secret --secret-id "agentx/$E1/callback-signing-key" >/dev/null 2>&1; then
  echo "  [INFO] secret agentx/$E1/callback-signing-key exists (the pipeline passes the previous stack parameter value and never reads it)"
else
  echo "  [INFO] secret agentx/$E1/callback-signing-key is absent"
fi

note "3b. broker-names parameter, callback-key secret, company stack parameters"
ck="$(ro secretsmanager describe-secret --secret-id "agentx/$E1/callback-key" 2>/dev/null || true)"
if [ -z "$ck" ]; then
  echo "  [INFO] secret agentx/$E1/callback-key is absent"
else
  tag="$(printf '%s' "$ck" | jq -r '[.Tags[]? | select(.Key == "agentx:env") | .Value][0] // "none"')"
  if [ "$tag" = "$E1" ]; then pass "secret agentx/$E1/callback-key exists with tag agentx:env=$E1"; else warnx "secret agentx/$E1/callback-key has agentx:env tag '$tag'"; fi
fi
bn="$(ro ssm get-parameter --name "/agentx/$E1/broker-names" 2>/dev/null || true)"
if [ -z "$bn" ]; then
  echo "  [INFO] parameter /agentx/$E1/broker-names is absent"
else
  bt="$(printf '%s' "$bn" | jq -r '.Parameter.Type // "?"')"
  if [ "$bt" = String ]; then pass "parameter /agentx/$E1/broker-names exists as String"; else fail "parameter /agentx/$E1/broker-names is '$bt' (must be String, never SecureString)"; fi
fi
for pk in CompanySignIn CompanySelfServe SlackCompanyWorkspaces; do
  for pst in control-plane slack; do
    doc="$(ro cloudformation describe-stacks --stack-name "$(stack_name "$pst")" 2>/dev/null || true)"
    [ -n "$doc" ] || continue
    v="$(printf '%s' "$doc" | jq -r --arg k "$pk" '[.Stacks[0].Parameters[]? | select(.ParameterKey == $k) | .ParameterValue][0] // empty')"
    [ -n "$v" ] && echo "  [INFO] live $pst parameter $pk is set"
  done
done

note "11. DNS firewall: association and domain lists still present (read-only)"
assoc="$(physid "$(stack_name foundation)" AgentDnsFirewallAssociation4753647C)"
if [ -n "$assoc" ]; then
  ad="$(ro route53resolver get-firewall-rule-group-association --firewall-rule-group-association-id "$assoc" 2>/dev/null || true)"
  ast="$(printf '%s' "$ad" | jq -r '.FirewallRuleGroupAssociation.Status // "?"' 2>/dev/null || echo '?')"
  if [ "$ast" = COMPLETE ]; then pass "association $assoc is COMPLETE"; else fail "association $assoc status is '$ast' (workers' DNS filtering must stay COMPLETE)"; fi
else
  warnx "no AgentDnsFirewallAssociation4753647C in the foundation stack"
fi
for lg in AgentDnsFirewallAllowList8DD5FFDF AgentDnsFirewallProjectAllowList1C0C2230 AgentDnsFirewallBlockAllListBD1ED948; do
  id="$(physid "$(stack_name foundation)" "$lg")"
  case "$id" in
    rslvr-fdl-*)
      ld="$(ro route53resolver get-firewall-domain-list --firewall-domain-list-id "$id" 2>/dev/null || true)"
      if [ -n "$ld" ]; then pass "$lg = $id exists"; else fail "$lg = $id could not be read (workers' DNS filtering is affected)"; fi ;;
    *) warnx "$lg: no firewall domain list id found" ;;
  esac
done

note "SUMMARY: $npass pass, $nwarn warn, $nfail FAIL"
if [ "$nfail" -gt 0 ]; then echo "45- FAIL: fix every FAIL before the deploy."; exit 1; fi
echo "45- PASS"
