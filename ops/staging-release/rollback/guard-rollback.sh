#!/usr/bin/env bash
# Called by the Release stage's Guard action (P3's guard.sh), whatever the execution type: a STANDARD execution passes straight through, a ROLLBACK execution is judged here
# (the target, the floor, one rollback per HOLD, routine in reverse) and the stage stops on any refusal.
# Exports expected: RELEASE_KIND, EXEC_ID, PIPELINE_NAME, SSM_PREFIX, RUNS_BUCKET, OPERATOR_ALERTS_TOPIC_ARN, RELEASE_ALERTS_TOPIC_ARN, and for a rollback
# ROLLBACK_EVALUATOR_INPUT = the evaluator input assembled from the rollback's fresh change sets (see DONE.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${here}/src/cli.ts" guard
