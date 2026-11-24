#!/usr/bin/env bash
# Gate 15 (upgrade mode): the LIVE deploy role (agentx-<env>-cloudformation, with its real boundary) is simulated for every API action the change sets' non-Metadata rows need,
# plus the IAM probe. Read-only (iam simulate-principal-policy / get-role, cloudformation list-stack-resources). Ported from the Mac 15-old-role-sim upgrade mode.
# Environment: ENVIRONMENT, RUN_DIR, RELEASE_SHA, PREVIEW_DIR (per stack S: S.changeset.json and S.template.json), WORK (unused here, part of the gate contract).
# Exit 0: 0 actions not allowed and 0 unmapped rows. Exit 1: any [FAIL] line. Exit 3: refused (bad environment, missing input). The caller writes the marker.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

pack_init
need_env PREVIEW_DIR RELEASE_SHA
[ -d "$PREVIEW_DIR" ] || refuse "PREVIEW_DIR '$PREVIEW_DIR' is not a directory"
require_account

stacks=("access:$(stack_name access)")
while IFS= read -r part; do stacks+=("${part}:$(stack_name "$part")"); done < <(order_parts)
for entry in "${stacks[@]}"; do
  s="${entry#*:}"
  [ -f "$PREVIEW_DIR/$s.changeset.json" ] && [ -f "$PREVIEW_DIR/$s.template.json" ] || refuse "missing $PREVIEW_DIR/$s.{changeset,template}.json"
done

OUT="$RUN_DIR/gates/15-role-sim"
mkdir -p "$OUT"
note "15- role simulation: the live deploy role ${DEPLOY_ROLE_NAME} for this run's change-set actions only (read-only)"
rc=0
python3 -I "$PACK_DIR/gates/lib/role_sim.py" "$PREVIEW_DIR" "$ACCOUNT" "$REGION" "$ENVIRONMENT" "$DEPLOY_ROLE_NAME" "$BOUNDARY_ARN" "$OUT" "$BOOTSTRAP_BUCKET" "${stacks[@]}" > "$OUT/results.txt" 2>&1 || rc=$?
cat "$OUT/results.txt"
if [ "$rc" -eq 0 ]; then
  echo "15- PASS: every change-set action and the IAM probe are allowed for the live role"
  exit 0
fi
echo "[FAIL] 15- STOP: read the DENY / ERROR / UNMAPPED rows above (results in $OUT/results.txt)"
exit 1
