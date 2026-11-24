#!/usr/bin/env bash
# The Canary action (P9). The stage exports: RELEASE_KIND (code|cloud), EXEC_ID, EXEC_TYPE (STANDARD|ROLLBACK), RELEASE_SHA, SSM_PREFIX, RUNS_BUCKET,
# OPERATOR_ALERTS_TOPIC_ARN, RELEASE_ALERTS_TOPIC_ARN, CANARY_START_FUNCTION, CANARY_STATUS_FUNCTION. It needs the pinned Node (22.23.2) and the AWS CLI.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${here}/src/cli.ts"
