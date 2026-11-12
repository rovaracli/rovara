#!/usr/bin/env bash
# Local, Lambda-like measurement of the embedder image (lane fix/0515-embedder-small-model; design note section 8). Uses a Docker engine that is ALREADY running (it never starts or changes one).
#   lambda_like_bench.sh <image> [cpus=1.2] [memory=2048m] [threads]
# Starts the image under the Lambda runtime emulator with the memory and CPU of the function, no network (--network=none: the port is not published, the client runs inside the container with docker exec),
# measures with lambda_like_bench.py, prints the container's emulator log lines (Init Duration) and the JSON, and removes the container. The image is NOT removed here; delete images you built.
set -euo pipefail
image="${1:?usage: lambda_like_bench.sh <image> [cpus] [memory] [threads]}"
cpus="${2:-1.2}"; memory="${3:-2048m}"; threads="${4:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="embedder-bench-$$"
env_args=()
[ -n "$threads" ] && env_args=(-e "EMBEDDER_THREADS=$threads")
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --platform linux/arm64 --cpus="$cpus" --memory="$memory" --memory-swap="$memory" --network=none ${env_args[@]+"${env_args[@]}"} "$image" >/dev/null
# the emulator takes a moment to listen; the first invoke (inside the client) is the cold one
for _ in $(seq 1 50); do
  if docker exec "$name" /var/lang/bin/python3 -c "import socket;socket.create_connection(('127.0.0.1',8080),1)" 2>/dev/null; then break; fi
  sleep 0.2
done
docker cp "$here/lambda_like_bench.py" "$name:/tmp/lambda_like_bench.py"
result="$(docker exec "$name" /var/lang/bin/python3 -I /tmp/lambda_like_bench.py)"
echo "--- emulator log (init report lines) ---"
docker logs "$name" 2>&1 | grep -E "REPORT|Init Duration|INIT" | head -3 || true
echo "--- result (cpus=$cpus memory=$memory threads=${threads:-default}) ---"
echo "$result"
