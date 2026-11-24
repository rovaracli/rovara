#!/usr/bin/env bash
# Settings record (runs in the Deploy stage ONLY after a successful deploy.sh, inside the shared /agentx/<env>/lock the stage takes and releases). The pipeline executes change
# sets directly, so it must write what the agentx CLI writes after a deploy (packages/cli/src/deploy/deploy-environment.ts, schema packages/cli/src/environments/settings.ts):
#   schemaVersion 1, env, account, region, engine "cdk", version (the pipeline's release version), naming "environment", stacks, controlPlaneUrl (control-plane ApiEndpoint),
#   identity (cognito: the identity stack's Issuer/Audience/ClientId; oidc: kept), models (the run's answers.json, else the existing record), alertAddress (kept from the existing
#   record when it has one), access (the access stack's ArtifactBucketName, CloudFormationRoleArn, OperatorRoleArn, PullThroughPrefix; permissionsBoundaryArn kept), updatedAt.
# Exactly those keys and no others (the schema is strict; legacy `cloud` keys are dropped, as the CLI's write drops them). No secret value is read or written.
# Refuses (exit 3, nothing written) on a missing or malformed input: no RELEASE_VERSION, a SETTINGS_PARAMETER other than /agentx/<env>/settings, no existing record (a deploy never
# creates an environment), a record for another env/account/region, a missing stack output.
# Inputs: ENVIRONMENT RELEASE_VERSION SETTINGS_PARAMETER; the release package is SYNTH_DIR or ./work/release (answers.json); RUN_DIR.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env RELEASE_VERSION SETTINGS_PARAMETER
require_account
[[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "RELEASE_VERSION is not x.y.z"
[ "$SETTINGS_PARAMETER" = "/agentx/${ENVIRONMENT}/settings" ] || refuse "SETTINGS_PARAMETER must be /agentx/${ENVIRONMENT}/settings"
PKG_DIR="${SYNTH_DIR:-$PWD/work/release}"

existing="$(ssm_value "$SETTINGS_PARAMETER")" || refuse "cannot read the existing settings record"
[ -n "$existing" ] || refuse "there is no settings record to update (a pipeline deploy never creates an environment)"
printf '%s' "$existing" | jq -e --arg env "$ENVIRONMENT" --arg account "$ACCOUNT" --arg region "$REGION" '.schemaVersion == 1 and .env == $env and .account == $account and .region == $region and .naming == "environment"' >/dev/null \
  || refuse "the existing record is not this environment's (env, account, region, naming)"

outputs_of() { # part -> {OutputKey: value}
  ro cloudformation describe-stacks --stack-name "$(stack_name "$1")" | jq -c '[.Stacks[0].Outputs // [] | .[] | {(.OutputKey): .OutputValue}] | add // {}'
}
cp_out="$(outputs_of control-plane)"; acc_out="$(outputs_of access)"
CP_URL="$(printf '%s' "$cp_out" | jq -r '.ApiEndpoint // empty')"
[ -n "$CP_URL" ] || refuse "the control-plane stack has no ApiEndpoint output"
for k in ArtifactBucketName CloudFormationRoleArn OperatorRoleArn PullThroughPrefix; do
  [ -n "$(printf '%s' "$acc_out" | jq -r --arg k "$k" '.[$k] // empty')" ] || refuse "the access stack has no $k output"
done
mode="$(printf '%s' "$existing" | jq -r '.identity.mode')"
if [ "$mode" = cognito ]; then
  id_out="$(outputs_of identity)"
  for k in Issuer Audience ClientId; do [ -n "$(printf '%s' "$id_out" | jq -r --arg k "$k" '.[$k] // empty')" ] || refuse "the identity stack has no $k output"; done
  identity="$(printf '%s' "$id_out" | jq -c '{mode: "cognito", issuer: .Issuer, audience: .Audience, clientId: .ClientId}')"
else
  identity="$(printf '%s' "$existing" | jq -c '.identity')"
fi
models="$(jq -c '.models // empty' "$PKG_DIR/answers.json" 2>/dev/null || true)"
[ -n "$models" ] || models="$(printf '%s' "$existing" | jq -c '.models')"
# the CLI's ModelsAnswersSchema (packages/cli/src/deploy/answer-schemas.ts, strict): refuse anything else rather than write a record the CLI cannot read back
printf '%s' "$models" | jq -e '
  def arn: type == "string" and test("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$") and length <= 640;
  def str: type == "string" and length > 0;
  def only($allowed): (keys - $allowed) == [];
  . as $m
  | ($m | type == "object") and ($m | only(["orchestrator","classifier","worker","providers","openRouter","anthropic","openai"]))
  and ($m.orchestrator | str) and ($m.classifier | str) and ($m.worker | str)
  and (($m.providers // {}) | type == "object" and only(["orchestrator","classifier","worker"]) and all(.[]; . as $v | ["amazon-bedrock","openrouter","anthropic","openai"] | index($v) != null))
  and (($m | has("openRouter") | not) or ($m.openRouter | type == "object" and only(["secretArn","providers"]) and (.secretArn | arn) and ((has("providers") | not) or (.providers | type == "array" and length > 0 and all(.[]; type == "string" and test("^[a-z0-9][a-z0-9_/-]{0,79}$"))))))
  and (["anthropic","openai"] | all(. as $k | ($m | has($k) | not) or ($m[$k] | type == "object" and only(["secretArn"]) and (.secretArn | arn))))
' >/dev/null 2>&1 || refuse "models in answers.json do not match the CLI's models schema (orchestrator/classifier/worker strings; strict keys; secret ARNs)"

record="$(jq -cn --argjson existing "$existing" --arg env "$ENVIRONMENT" --arg account "$ACCOUNT" --arg region "$REGION" --arg version "$RELEASE_VERSION" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --arg access "$(stack_name access)" --arg foundation "$(stack_name foundation)" --arg identityStack "$(stack_name identity)" --arg runtime "$(stack_name runtime)" --arg cp "$(stack_name control-plane)" --arg slack "$(stack_name slack)" \
  --arg cpUrl "$CP_URL" --argjson acc "$acc_out" --argjson identity "$identity" --argjson models "$models" '
  {schemaVersion: 1, env: $env, account: $account, region: $region, engine: "cdk", version: $version, naming: "environment",
   stacks: {access: $access, foundation: $foundation, identity: $identityStack, runtime: $runtime, "control-plane": $cp, slack: $slack},
   controlPlaneUrl: $cpUrl, identity: $identity, models: $models}
  + (if ($existing.alertAddress // "") != "" then {alertAddress: $existing.alertAddress} else {} end)
  + {access: ({artifactBucket: $acc.ArtifactBucketName, cloudFormationRoleArn: $acc.CloudFormationRoleArn, operatorRoleArn: $acc.OperatorRoleArn, pullThroughPrefix: $acc.PullThroughPrefix}
      + (if ($existing.access.permissionsBoundaryArn // "") != "" then {permissionsBoundaryArn: $existing.access.permissionsBoundaryArn} else {} end))}
  + {updatedAt: $now}')" || refuse "could not build the settings record"
printf '%s' "$record" | jq -e '.controlPlaneUrl | test("^https://")' >/dev/null || refuse "controlPlaneUrl is not an https URL"
a ssm put-parameter --name "$SETTINGS_PARAMETER" --type String --overwrite --value "$record" >/dev/null || refuse "could not write the settings record"
mkdir -p "$RUN_DIR"
printf '%s\n' "$record" | jq 'del(.access.artifactBucket)' > "$RUN_DIR/settings-record.json"
echo "SETTINGS_RECORD_DONE: version ${RELEASE_VERSION} written to ${SETTINGS_PARAMETER}"
