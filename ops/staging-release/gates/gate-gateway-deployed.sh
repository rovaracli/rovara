#!/usr/bin/env bash
# Gate: the gateway is SETTLED on a digest-pinned image (the Mac's gate-gateway-deployed.sh, which also compared the image with one expected digest; here that digest is
# optional: EXPECTED_GATEWAY_DIGEST). healthz alone also passes on the old image, so this reads ECS: one deployment, COMPLETED, running == desired, image @sha256:<64 hex>.
# It also runs the runprice gate. Read-only. Env: ENVIRONMENT RUN_DIR; EXPECTED_GATEWAY_DIGEST (optional sha256:...).
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
pack_init
require_account
rc=0
bash "$(dirname "$0")/gate-gateway-runprice.sh" || rc=1
gw_stack="rovara-cloud-${ENVIRONMENT}-gateway"
res="$(ro cloudformation list-stack-resources --stack-name "$gw_stack")" || { echo "  [FAIL] cannot read the gateway stack"; exit 1; }
svc="$(printf '%s' "$res" | jq -r '[.StackResourceSummaries[]? | select(.ResourceType == "AWS::ECS::Service") | .PhysicalResourceId][0] // ""')"
[ -n "$svc" ] || { echo "  [FAIL] the gateway stack has no ECS service"; exit 1; }
cluster="${svc#*:service/}"; cluster="${cluster%%/*}"
d="$(ro ecs describe-services --cluster "$cluster" --services "$svc")" || { echo "  [FAIL] cannot read the gateway service"; exit 1; }
running="$(printf '%s' "$d" | jq -r '.services[0].runningCount')"; desired="$(printf '%s' "$d" | jq -r '.services[0].desiredCount')"
ndep="$(printf '%s' "$d" | jq -r '.services[0].deployments | length')"; rollout="$(printf '%s' "$d" | jq -r '.services[0].deployments[0].rolloutState')"
td="$(printf '%s' "$d" | jq -r '.services[0].deployments[0].taskDefinition')"
img="$(ro ecs describe-task-definition --task-definition "$td" | jq -r '.taskDefinition.containerDefinitions[0].image')"
echo "$(now_utc) ECS: running=$running desired=$desired deployments=$ndep rollout=$rollout image=...@${img##*@}"
if [ "$running" = "$desired" ] && [ "$ndep" = 1 ] && [ "$rollout" = COMPLETED ] && printf '%s' "$img" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
  if [ -n "${EXPECTED_GATEWAY_DIGEST:-}" ] && [ "${img##*@}" != "$EXPECTED_GATEWAY_DIGEST" ]; then echo "  [FAIL] the gateway serves another digest than expected"; rc=1; else echo "ECS GATE PASS"; fi
else echo "  [FAIL] the gateway is not settled on a digest-pinned image"; rc=1; fi
exit "$rc"
