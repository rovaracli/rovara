#!/bin/bash
# EC2 worker boot, stage 2: the long tail of boot.sh. It ships in the worker image at /opt/agentx/boot/stage2.sh, so it does not
# count against the 16 KB user data limit. boot.sh reads it out of the image it just pulled by digest, checks its SHA-256 against
# AGENTX_BOOT_STAGE2_SHA256 (a launch setting written beside the worker image by the same release), then sources it and calls
# stage2_main. It runs inside boot.sh's shell: the other constants, log, fail, retry and BOOT_STEP are boot.sh's. Sourcing it defines
# constants and functions and runs nothing.

# Constants only this stage uses; boot.sh keeps the rest.
readonly CONTAINED_IMAGE=node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
readonly WORKER_ENV_FILE=/etc/agentx/worker.env
readonly WORKER_CONTAINER=agentx-worker
readonly DOCKER_SOCKET=/var/run/docker.sock

# This optional preload is bounded; failure leaves the worker available.
pull_contained_image() {
  local attempt
  for ((attempt=1; attempt<=RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE; attempt++)); do
    timeout "$(try_seconds 300)" docker pull "$CONTAINED_IMAGE" && return 0
    ((attempt<RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE)) && sleep "$((1 << (attempt - 1)))"
  done
  log "optional verifier image unavailable; worker continues"
  return 1
}

# Optional until the control plane sets EXECUTOR_IMAGE.
pull_executor_image() {
  [[ -n "${EXECUTOR_IMAGE:-}" ]] || return 0
  local attempt
  for ((attempt=1; attempt<=RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE; attempt++)); do
    timeout "$(try_seconds 300)" docker pull "$EXECUTOR_IMAGE" && return 0
    ((attempt<RETRY_ATTEMPTS && SECONDS<BOOT_DEADLINE)) && sleep "$((1 << (attempt - 1)))"
  done
  log "optional executor image unavailable; worker continues"
  return 1
}

# Root-only: the worker's environment is its configuration.
write_worker_environment() {
  local region=$1
  install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"
  install -m 0600 /dev/null "$WORKER_ENV_FILE"
  # R56: the sandbox image is the worker's own; AGENTX_RUNTIME=ec2 makes the worker refuse the local shell.
  cat >"$WORKER_ENV_FILE" <<EOF
AWS_REGION=$region
AGENTX_WORKSPACE_ROOT=$MOUNT_PATH
AGENTX_CONTROL_PLANE_URL=$AGENTX_CONTROL_PLANE_URL
AGENTX_MODEL_PROVIDER=$AGENTX_MODEL_PROVIDER
AGENTX_MODEL_ID=$AGENTX_MODEL_ID
AGENTX_OPENROUTER_PROVIDERS=${AGENTX_OPENROUTER_PROVIDERS:-}
PI_CACHE_RETENTION=$PI_CACHE_RETENTION
AGENTX_INVOKE_PUBLIC_KEY=$AGENTX_INVOKE_PUBLIC_KEY
AGENTX_WORKSPACE_ID=$AGENTX_WORKSPACE_ID
AGENTX_SESSION_GENERATION=$AGENTX_SESSION_GENERATION
AGENTX_SANDBOX_IMAGE=$AGENTX_WORKER_IMAGE
AGENTX_RUNTIME=ec2
EOF
  if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then printf 'AGENTX_ENVIRONMENT_KIND=named\n' >>"$WORKER_ENV_FILE"; fi
  if [[ -n ${AGENTX_MODEL_PROXY_URL:-} ]]; then
    # A model proxy holds the provider keys: the worker gets its address, no secret reference.
    printf 'AGENTX_MODEL_PROXY_URL=%s\n' "$AGENTX_MODEL_PROXY_URL" >>"$WORKER_ENV_FILE"
  else
    # No proxy: the worker reads its own provider keys.
    local name
    for name in AGENTX_OPENROUTER_SECRET_ARN AGENTX_ANTHROPIC_SECRET_ARN AGENTX_OPENAI_SECRET_ARN; do
      printf '%s=%s\n' "$name" "${!name:-}" >>"$WORKER_ENV_FILE"
    done
  fi
  printf 'TMPDIR=/tmp\n' >>"$WORKER_ENV_FILE"
  # docker exec agentx-worker processes (the web/API runtime) read the executor image from this file.
  [[ -z "${EXECUTOR_IMAGE:-}" ]] || printf 'EXECUTOR_IMAGE=%s\n' "$EXECUTOR_IMAGE" >>"$WORKER_ENV_FILE"
}

write_worker_launcher() {
  local docker=$1 instance_id=$2
  install -d -m 0700 /etc/agentx
  install -d -o root -g root -m 0755 /usr/local/libexec
  printf '%s\n' "$AGENTX_WORKER_IMAGE" >/etc/agentx/worker-image
  chmod 0600 /etc/agentx/worker-image
  printf '%s\n' "$docker" >/etc/agentx/docker-path
  chmod 0600 /etc/agentx/docker-path
  cat >/usr/local/libexec/agentx-worker-start <<'LAUNCHER'
#!/bin/bash
set -u
readonly MOUNT_PATH=/mnt/workspace
readonly RUNTIME_SOURCE=/mnt/workspace/.agentx-runtime
readonly RUNTIME_ROOT=/mnt/agentx-runtime
readonly WORKER_ENV_FILE=/etc/agentx/worker.env
readonly WORKER_CONTAINER=agentx-worker
readonly DOCKER_SOCKET=/var/run/docker.sock
readonly WORKER_UID=1000
readonly WORKER_GID=1000
log() { printf 'agentx-worker-start: %s\n' "$*" >&2; }
# R56: a named environment (AGENTX_ENVIRONMENT_KIND=named) runs on a bridge; the legacy worker is unchanged (R58).
named_environment() { grep -qx 'AGENTX_ENVIRONMENT_KIND=named' "$WORKER_ENV_FILE"; }
require_model_proxy() { ! named_environment || grep -q '^AGENTX_MODEL_PROXY_URL=.' "$WORKER_ENV_FILE"; }
worker_network_args() {
  if named_environment; then printf '%s\n' --network bridge --publish 8080:8080; else printf '%s\n' --network host; fi
}
block_imds() {
  local rule
  for rule in "DOCKER-USER -d 169.254.169.254/32 -j REJECT" "OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT"; do
    iptables -C $rule 2>/dev/null || iptables -I $rule || return 1
  done
}
docker=$(cat /etc/agentx/docker-path 2>/dev/null || true)
worker_image=$(cat /etc/agentx/worker-image 2>/dev/null || true)
[[ "$docker" == /* && -x "$docker" ]] || { log 'Docker CLI unavailable'; exit 1; }
[[ "$worker_image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || { log 'worker image identity is invalid'; exit 1; }
docker_gid=$(stat -c %g "$DOCKER_SOCKET") || { log 'Docker socket unavailable'; exit 1; }
require_model_proxy || { log 'no model proxy'; exit 1; }
if named_environment; then block_imds || { log 'iptables failed'; exit 1; }; fi
mapfile -t network_args < <(worker_network_args)
runtime_ready=false
if [[ -d "$RUNTIME_SOURCE" && ! -L "$RUNTIME_SOURCE" && $(stat -c %u:%g:%a "$RUNTIME_SOURCE" 2>/dev/null) == 0:0:755 ]]; then
  runtime_children_valid=true
  for path in candidates evidence state tmp; do
    child="$RUNTIME_SOURCE/$path"
    if [[ ! -d "$child" || -L "$child" || $(stat -c %u:%g:%a "$child" 2>/dev/null) != 1000:1000:700 ]]; then
      runtime_children_valid=false
      break
    fi
  done
  if [[ "$runtime_children_valid" == true && ! -L "$RUNTIME_ROOT" ]]; then
    if [[ ! -e "$RUNTIME_ROOT" ]]; then install -d -o root -g root -m 0755 "$RUNTIME_ROOT" 2>/dev/null || true; fi
    if [[ -d "$RUNTIME_ROOT" && $(stat -c %u:%g:%a "$RUNTIME_ROOT" 2>/dev/null) == 0:0:755 ]]; then
      if mountpoint -q "$RUNTIME_ROOT"; then
        source_id=$(stat -c %d:%i "$RUNTIME_SOURCE" 2>/dev/null || true)
        active_id=$(stat -c %d:%i "$RUNTIME_ROOT" 2>/dev/null || true)
        [[ -n "$source_id" && "$source_id" == "$active_id" ]] && runtime_ready=true
      elif mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT" 2>/dev/null && mountpoint -q "$RUNTIME_ROOT"; then
        source_id=$(stat -c %d:%i "$RUNTIME_SOURCE" 2>/dev/null || true)
        active_id=$(stat -c %d:%i "$RUNTIME_ROOT" 2>/dev/null || true)
        [[ -n "$source_id" && "$source_id" == "$active_id" ]] && runtime_ready=true
      fi
    fi
  fi
fi
args=(run --rm --name "$WORKER_CONTAINER" "${network_args[@]}" --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")
if [[ "$runtime_ready" == true ]]; then
  args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")
else
  log 'verifier unavailable; worker continues with /tmp'
  args+=(--env TMPDIR=/tmp)
fi
args+=(--volume "$DOCKER_SOCKET:$DOCKER_SOCKET" --group-add "$docker_gid" --log-driver awslogs --log-opt awslogs-region="$(sed -n 's/^AWS_REGION=//p' "$WORKER_ENV_FILE")" --log-opt awslogs-group="$(cat /etc/agentx/log-group)" --log-opt awslogs-stream="$(sed -n 's/^AGENTX_WORKSPACE_ID=//p' "$WORKER_ENV_FILE")/$(sed -n 's/^AGENTX_SESSION_GENERATION=//p' "$WORKER_ENV_FILE")/$(cat /etc/agentx/instance-id)" "$worker_image")
exec "$docker" "${args[@]}"
LAUNCHER
  chmod 0755 /usr/local/libexec/agentx-worker-start
  printf '%s\n' "$AGENTX_LOG_GROUP" >/etc/agentx/log-group
  printf '%s\n' "$instance_id" >/etc/agentx/instance-id
  chmod 0600 /etc/agentx/log-group /etc/agentx/instance-id
}

write_worker_unit() {
  local region=$1 instance_id=$2 docker
  docker=$(command -v docker)
  write_worker_launcher "$docker" "$instance_id"
  cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF
[Unit]
Description=AgentX worker for workspace $AGENTX_WORKSPACE_ID generation $AGENTX_SESSION_GENERATION
Requires=docker.service $FIREWALL_UNIT
After=docker.service $FIREWALL_UNIT network-online.target
Wants=network-online.target
RequiresMountsFor=$MOUNT_PATH

[Service]
ExecStartPre=-$docker rm --force $WORKER_CONTAINER
ExecStart=/usr/local/libexec/agentx-worker-start
ExecStop=$docker stop $WORKER_CONTAINER
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

# Opt-in TEST qualification of the web/API runtime (AGENTX_E2E_QUALIFICATION_*), under e2e-runtime/<role ID>:<instance ID>/,
# the prefix the grant e2e-runtime/${aws:userid}/ allows. Its own unit, so it cannot fail the boot; it reports through status.json.
write_e2e_qualification_script() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  cat >/usr/local/libexec/agentx-e2e-qualification <<'QUALIFICATION'
set -uo pipefail
umask 077
readonly REGION=${1:-} BUCKET=${2:-} ROLE_ID=${3:-} INSTANCE_ID=${4:-} PROFILE=${5:-} EXECUTOR=${6:-}
readonly EVIDENCE_HOST=${AGENTX_HOST_ROOT:-}/mnt/workspace/.agentx-runtime/evidence
readonly EVIDENCE_CONTAINER=/mnt/agentx-runtime/evidence
readonly CHALLENGE_NAME=runtime-install-challenge.json
readonly PROPOSAL_NAME=runtime-install-proposal.json
readonly CHALLENGE_MAX_BYTES=65536
readonly PROPOSAL_MAX_BYTES=5242880
readonly POLL=${AGENTX_E2E_QUALIFICATION_POLL_SECONDS:-10}
readonly HEALTHY_WAIT=${AGENTX_E2E_QUALIFICATION_HEALTHY_WAIT_SECONDS:-900}
readonly CHALLENGE_WAIT=${AGENTX_E2E_QUALIFICATION_CHALLENGE_WAIT_SECONDS:-1800}
readonly QUALIFY_SECONDS=${AGENTX_E2E_QUALIFICATION_QUALIFY_SECONDS:-2700}
readonly PULL_SECONDS=${AGENTX_E2E_QUALIFICATION_PULL_SECONDS:-300}
log() { printf 'agentx-e2e-qualification: %s\n' "$*" >&2; }
[[ "$ROLE_ID" =~ ^AROA[A-Z0-9]{12,}$ ]] || { log "refused: the role ID must be the worker role's unique ID (AROA...)"; exit 2; }
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || { log "refused: the instance ID is not valid"; exit 2; }
[[ "$EXECUTOR" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || { log "refused: the executor image must be an ECR image pinned by digest"; exit 2; }
[[ "$PROFILE" == linux-arm64-web-api-v1 ]] || { log "refused: the profile must be linux-arm64-web-api-v1"; exit 2; }
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { log "refused: the bucket name is not valid"; exit 2; }
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { log "refused: the region is not valid"; exit 2; }
readonly PREFIX="e2e-runtime/$ROLE_ID:$INSTANCE_ID/"
STAGE=$(mktemp -d) || exit 1
readonly STAGE
upload() { aws s3api put-object --bucket "$BUCKET" --key "$PREFIX$1" --body "$2" --server-side-encryption AES256 --region "$REGION" --no-cli-pager >/dev/null; }
publish_status() {
  printf '{"state":"%s","reason":"%s","finishedAt":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STAGE/status.json" && upload status.json "$STAGE/status.json"
}
fail_with() {
  log "failed: $1"
  publish_status FAILED "$1" || log "could not upload the failure status"
  exit 1
}
deadline=$((SECONDS + HEALTHY_WAIT))
until curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:8080/ping >/dev/null 2>&1; do
  ((SECONDS < deadline)) || fail_with worker-not-healthy
  sleep "$POLL"
done
# The boot preload is optional; the qualification needs the image.
if ! docker image inspect "$EXECUTOR" >/dev/null 2>&1; then
  log "the executor image is not on this host; pulling it"
  { timeout --foreground --kill-after=10s "${PULL_SECONDS}s" aws ecr get-login-password --region "$REGION" \
      | timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker login --username AWS --password-stdin "${EXECUTOR%%/*}" >/dev/null 2>&1 \
      && timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker pull "$EXECUTOR" >/dev/null 2>&1; } \
    || log "the executor image could not be pulled"
  docker image inspect "$EXECUTOR" >/dev/null 2>&1 || fail_with executor-image-unavailable
fi
printf '{"state":"READY","reason":"worker-healthy","finishedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STAGE/ready.json" && upload ready.json "$STAGE/ready.json" || fail_with ready-upload-failed
fetched="$STAGE/challenge.json"
deadline=$((SECONDS + CHALLENGE_WAIT))
until aws s3api get-object --bucket "$BUCKET" --key "${PREFIX}challenge.json" --region "$REGION" --no-cli-pager "$fetched" >/dev/null 2>&1; do
  ((SECONDS < deadline)) || fail_with challenge-unavailable
  sleep "$POLL"
done
size=$(wc -c <"$fetched" | tr -d '[:space:]')
((size > 0 && size <= CHALLENGE_MAX_BYTES)) || fail_with challenge-size-rejected
[[ -d "$EVIDENCE_HOST" && ! -L "$EVIDENCE_HOST" ]] || fail_with evidence-directory-unavailable
chown 1000:1000 "$fetched" && chmod 0600 "$fetched" && mv -fT "$fetched" "$EVIDENCE_HOST/$CHALLENGE_NAME" || fail_with challenge-install-failed
rm -f "$EVIDENCE_HOST/$PROPOSAL_NAME"
timeout --foreground --kill-after=10s "${QUALIFY_SECONDS}s" docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js --profile "$PROFILE" --challenge-file "$EVIDENCE_CONTAINER/$CHALLENGE_NAME" --evidence-root "$EVIDENCE_CONTAINER" --out "$EVIDENCE_CONTAINER/$PROPOSAL_NAME" >"$STAGE/qualifier.log" 2>&1
status=$?
tail -c 2000 "$STAGE/qualifier.log" | while IFS= read -r line; do log "qualifier: $line"; done
((status == 0)) || fail_with "qualification-failed-exit-$status"
proposal="$EVIDENCE_HOST/$PROPOSAL_NAME"
[[ -f "$proposal" && ! -L "$proposal" ]] || fail_with proposal-missing
size=$(wc -c <"$proposal" | tr -d '[:space:]')
((size > 0)) || fail_with proposal-missing
((size <= PROPOSAL_MAX_BYTES)) || fail_with proposal-too-large
upload proposal.json "$proposal" || fail_with proposal-upload-failed
publish_status SUCCEEDED qualified || { log "could not upload the success status"; exit 1; }
log "qualified; the proposal and status are under the prefix"
QUALIFICATION
}

# The instance ID is the one boot read from instance metadata.
start_e2e_qualification() {
  local region=$1 instance_id=$2
  [[ -n "${AGENTX_E2E_QUALIFICATION_ROLE_ID:-}" && -n "${AGENTX_E2E_QUALIFICATION_PROFILE:-}" ]] || return 0
  write_e2e_qualification_script
  systemd-run --unit=agentx-e2e-qualification --collect --no-block \
    /bin/bash /usr/local/libexec/agentx-e2e-qualification "$region" "${AGENTX_E2E_QUALIFICATION_BUCKET:-}" "$AGENTX_E2E_QUALIFICATION_ROLE_ID" "$instance_id" "$AGENTX_E2E_QUALIFICATION_PROFILE" "${EXECUTOR_IMAGE:-}" \
    >/dev/null 2>&1 || log "could not start the E2E qualification"
}

# What boot.sh's main did after the worker image was pulled, in the same order, with the same BOOT_STEP labels.
stage2_main() {
  local region=$1 instance_id=$2
  BOOT_STEP="download the worker image"
  if [[ "$CONTAINED_RUNTIME_AVAILABLE_BOOT" == true ]]; then pull_contained_image || true; fi
  pull_executor_image || true
  BOOT_STEP="start the worker"
  write_worker_environment "$region"
  write_worker_unit "$region" "$instance_id"
  systemctl daemon-reload
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
  start_e2e_qualification "$region" "$instance_id" || log "the E2E qualification did not start"
}
