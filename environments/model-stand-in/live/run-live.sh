#!/bin/bash
# Live proof of the model stand-in, inside the Linux VM (never on the Mac; no docker):
#   colima ssh -p aws-emu-spike -- bash <worktree>/environments/model-stand-in/live/run-live.sh
# Needs: Go 1.26.9 or newer (GO_BIN = its bin dir if it is not on PATH), a built front (FRONT_BIN, from the fork's rovara/sm-shim branch), the engine at /usr/bin/aws-emulator,
# and a Python with boto3 (PY). It builds the stand-in itself, starts its own processes and stops only those. No AWS call is made.
set -eu
[ -n "${GO_BIN:-}" ] && export PATH=$GO_BIN:$PATH
SRC=$(cd "$(dirname "$0")/.." && pwd)
W=${SM3_WORK:-/tmp/sm3-live}
PY=${PY:-/home/abhishekgarg.guest/spike/suite/.venv/bin/python}
FRONT_BIN=${FRONT_BIN:-$W/rovara-aws-front}
export GOCACHE=${GOCACHE:-/tmp/sm3-gocache} GOTOOLCHAIN=local CGO_ENABLED=0
mkdir -p "$W"
(cd "$SRC" && go vet ./... && go test -count=1 ./... && go build -trimpath -ldflags="-s -w" -o "$W/model-stand-in" ./cmd/model-stand-in)
exec "$PY" "$SRC/live/live.py" --stand-in-bin "$W/model-stand-in" --front-bin "$FRONT_BIN"
