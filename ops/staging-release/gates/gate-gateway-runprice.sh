#!/usr/bin/env bash
# Gate: the model gateway serves runPrice v1 with admission v1 and a snapshot at or above the floor (what Code's CLI asserts before it deploys). Ported from the Mac's
# gate-gateway-runprice.sh. One public HTTPS GET, no AWS write. The host is the control plane's own live CoreModelGatewayHost parameter, not a name in this file.
# Env: ENVIRONMENT RUN_DIR; GATEWAY_MIN_SNAPSHOT (default 8); GATEWAY_HEALTHZ_URL (tests only: a local URL instead of the live host).
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
pack_init
require_account
MIN="${GATEWAY_MIN_SNAPSHOT:-8}"
printf '%s' "$MIN" | grep -Eq '^[0-9]+$' || refuse "GATEWAY_MIN_SNAPSHOT is not a number"
URL="${GATEWAY_HEALTHZ_URL:-}"
if [ -z "$URL" ]; then
  doc="$(ro cloudformation describe-stacks --stack-name "$(stack_name control-plane)")" || refuse "cannot read the control-plane stack"
  host="$(printf '%s' "$doc" | jq -r '[.Stacks[0].Parameters[]? | select(.ParameterKey == "CoreModelGatewayHost") | .ParameterValue][0] // ""')"
  printf '%s' "$host" | grep -Eq '^[a-z0-9][a-z0-9.-]*$' || { echo "  [FAIL] the control plane names no gateway host"; exit 1; }
  URL="https://${host}/healthz"
fi
body="$(mktemp)"
code="$(curl -s -m 10 -H 'accept: application/json' -o "$body" -w '%{http_code}' "$URL" || echo 000)"
echo "$(now_utc) GET healthz -> HTTP $code"
if [ "$code" = 200 ] && jq -e --argjson floor "$MIN" '.ok == true and (.runPrice.version == 1) and (.runPrice.admissionVersion == 1) and ((.runPrice.snapshotVersion | type) == "number") and (.runPrice.snapshotVersion >= $floor)' "$body" >/dev/null 2>&1; then
  echo "GATE PASS: runPrice v1, admission v1, snapshot >= $MIN"; rm -f "$body"; exit 0
fi
echo "  [FAIL] the gateway does not serve runPrice v1 with snapshot >= $MIN"; rm -f "$body"; exit 1
