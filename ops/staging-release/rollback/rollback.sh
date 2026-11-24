#!/usr/bin/env bash
# The explicit rollback to the recorded last-good execution (the rollback role). A dry run unless --execute. Exports: RELEASE_KIND (code|cloud), PIPELINE_NAME, SSM_PREFIX, RUNS_BUCKET,
# OPERATOR_ALERTS_TOPIC_ARN, RELEASE_ALERTS_TOPIC_ARN. The Release stage's guard then re-judges the rollback before anything deploys.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${here}/src/cli.ts" request "$@"
