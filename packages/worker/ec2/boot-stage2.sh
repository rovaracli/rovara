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

# Test services (named environments only; it lives here and not in boot.sh to stay under the 16 KB user data limit). Both steps run in stage2_main after the worker environment is written and BEFORE the worker unit starts, so no run
# network, setup network or end-to-end network can exist yet (the worker and the E2E qualification create them, later).
# 1. Docker's own auto-allocated networks (the E2E checker's, whole /16s by default) must never take 172.29/16 (setup runs), 172.30/16 (run networks) or the VPC's 10.42/16: default-address-pools holds /24s from 172.18-172.28 and
#    192.168/16 only (172.17 is docker0; 172.29-172.31 and 10/8 are left out; 3,072 networks). Stage 1 wrote daemon.json without them, so this rewrites it and restarts Docker, then runs the container firewall script again (a restart rebuilds
#    Docker's chains). The restart happens before anything uses a Docker network: only images were pulled so far.
set_docker_address_pools() {
  local pools='[{"base":"172.18.0.0/15","size":24},{"base":"172.20.0.0/14","size":24},{"base":"172.24.0.0/14","size":24},{"base":"172.28.0.0/16","size":24},{"base":"192.168.0.0/16","size":24}]'
  printf '{"data-root": "%s", "default-address-pools": %s}\n' "$DOCKER_DATA_ROOT" "$pools" >/etc/docker/daemon.json
  systemctl restart docker.service && bash /usr/local/libexec/rovara-container-firewall
}
# 2. Two different rvi bridges never talk (a run network and an end-to-end network, or two runs): routed between bridges is "not bridged", traffic inside one bridge is bridged and flows. Inserted at the top of DOCKER-USER, so no earlier
#    RETURN or ACCEPT can skip it. IPv6 only where Docker has that chain.
# 3. The metadata address must still be blocked after the Docker restart (a restart rebuilds Docker's chains; the container firewall script that was just run again puts its DROP back). block_imds, with the metadata REJECT, is
#    in the worker launcher and runs when the worker unit starts, which is after this; this checks what stands now, so a lost block stops the boot before any container can start.
metadata_blocked() {
  iptables -S DOCKER-USER 2>/dev/null | grep -Eq -- '^-A DOCKER-USER -d 169\.254\.169\.254/32 -j (DROP|REJECT)$'
}
wall_between_run_networks() {
  local rule="DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP"
  iptables -C $rule 2>/dev/null || iptables -I $rule || return 1
  ! command -v ip6tables >/dev/null || ! ip6tables -S DOCKER-USER >/dev/null 2>&1 || ip6tables -C $rule 2>/dev/null || ip6tables -I $rule || return 1
}
# 4. TS-SEAL-2: nothing on a run bridge (rvi+) or a build bridge (rvb+) reaches the HOST over IPv6 either. The firewall unit's own ip6tables rule is best effort (a failure there only prints a line, and it is skipped when ip6tables is
#    missing), so after the Docker restart this puts the INPUT drops in place or stops the boot. Each is inserted at the top of INPUT, once. Without a usable ip6tables the boot is allowed to go on only when the host has no IPv6 at
#    all: IPv6 counts as off only when it is disabled for the interfaces that exist (conf/all) AND for those that will (conf/default, which a new bridge takes), or when the kernel has no IPv6.
ipv6_active() {
  [[ -e /proc/net/if_inet6 ]] || return 1
  [[ $(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null) != 1 || $(cat /proc/sys/net/ipv6/conf/default/disable_ipv6 2>/dev/null) != 1 ]]
}
wall_ipv6_into_host() {
  local bridge
  if command -v ip6tables >/dev/null && ip6tables -S INPUT >/dev/null 2>&1; then
    for bridge in rvb+ rvi+; do
      ip6tables -C INPUT -i $bridge -j DROP 2>/dev/null || ip6tables -I INPUT -i $bridge -j DROP || return 1
    done
  else
    ! ipv6_active
  fi
}
# 5. The walls above and the isolation DROP are not in the container firewall unit (boot.sh, at its size limit, writes that), so they would be lost at a host reboot or a Docker restart (a restart rebuilds Docker's chains) if
#    only this one-time boot put them in place. A unit of its own re-applies them whenever the firewall unit runs, before the worker starts. An idle stop TERMINATES the instance and the next start launches a new one that runs boot.sh
#    and this stage again; the unit covers what a new launch does not: a reboot of the same instance and a Docker restart.
readonly RUN_WALLS_UNIT=rovara-run-walls.service
install_run_walls_unit() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  { printf 'set -e\n'; declare -f ipv6_active wall_between_run_networks wall_ipv6_into_host; printf 'wall_between_run_networks\nwall_ipv6_into_host\n'; } >/usr/local/libexec/rovara-run-walls || return 1
  cat >"/etc/systemd/system/$RUN_WALLS_UNIT" <<UNIT || return 1
[Unit]
Description=Wall run networks off from each other and from the host over IPv6
Requires=docker.service $FIREWALL_UNIT
After=docker.service $FIREWALL_UNIT
Before=$WORKER_UNIT
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /usr/local/libexec/rovara-run-walls
[Install]
WantedBy=multi-user.target
UNIT
  # The worker needs the walls unit (and is started again with it): a drop-in, so the worker unit's own text stays as it was.
  install -d -o root -g root -m 0755 "/etc/systemd/system/$WORKER_UNIT.d"
  printf '[Unit]\nRequires=%s\nAfter=%s\n' "$RUN_WALLS_UNIT" "$RUN_WALLS_UNIT" >"/etc/systemd/system/$WORKER_UNIT.d/10-run-walls.conf" || return 1
  systemctl enable "$RUN_WALLS_UNIT"
}

# Test services (slice 1): the values the worker's service runner needs, for a named environment only. Nothing here is a secret and nothing comes from a customer setting:
#   AGENTX_TEST_SERVICES_REGISTRY  the registry host of the worker image the control plane launched this worker with (the catalog repositories are in the same registry);
#   AGENTX_TEST_SERVICES_ENV       the environment name, cut from the launch's log group `/agentx/<env>/worker` (written by the control plane).
# AGENTX_TEST_SERVICES_RUN_DIR is NOT written here: the launcher adds it only when the tmpfs run directory was really mounted (so a worker whose mount failed has no complete configuration and does not offer test services).
# The catalog the worker trusts is the one baked into its own image, with the digests it pins; it checks no signature and needs no account id or key (the broker keeps the signed-catalog check). AGENTX_SANDBOX_IMAGE (the
# worker's own image, the probe image) is already written by write_worker_environment.
write_test_services_environment() {
  local registry=${AGENTX_WORKER_IMAGE%%/*} environment
  [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]] || return 1
  [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z][a-z0-9-]{0,19})/worker$ ]] || return 1
  environment=${BASH_REMATCH[1]}
  { printf 'AGENTX_TEST_SERVICES_REGISTRY=%s\n' "$registry"; printf 'AGENTX_TEST_SERVICES_ENV=%s\n' "$environment"; } >>"$WORKER_ENV_FILE"
}
# The worker container has no registry login and no AWS credentials (only root on the host has the instance role), so ROOT pulls, before the worker starts, every digest in the pre-pull list baked into the worker image
# (catalog repositories `svc/*` only, by digest, never a tag). The worker never pulls: it runs a dependency only if its digest is pinned in the image AND already here. Nothing to pull (no catalog, an empty list) is fine and
# silent; a login or a pull that fails is logged loudly and returns 1, and the caller then does not offer test services on this worker (the broker refuses a plan to it) while the worker still takes everything else.
pull_catalog_images() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*} environment list line repository digest="" count=0 pairs=() reference
  [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]] || return 0
  [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z][a-z0-9-]{0,19})/worker$ ]] || return 0
  environment=${BASH_REMATCH[1]}
  # The list is read with a throwaway `cat` of the image's own file (no network, read-only, no capability): not a second copy-out of the image (stage 1 copies out stage 2 only, once).
  list=$(mktemp) || return 1
  timeout --foreground --kill-after=10s 120s docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/service-catalog/prepull.json >"$list" 2>/dev/null || : >"$list"
  while IFS= read -r line; do
    if [[ "$line" =~ ^\"repository\":\ *\"(svc/[a-z0-9][a-z0-9._-]{0,62})\" ]]; then repository=${BASH_REMATCH[1]}
    elif [[ "$line" =~ \"digest\":\ *\"(sha256:)?([a-f0-9]{64})\" && -n "${repository:-}" ]]; then pairs+=("$repository@sha256:${BASH_REMATCH[2]}"); repository=""; fi
  done < <(tr -d '\r' <"$list" | sed -E 's/^[[:space:]]+//; s/,$//' | grep -E '^"(repository|digest)"')
  rm -f "$list"
  ((${#pairs[@]} > 0)) || return 0
  { timeout --foreground --kill-after=10s 120s aws ecr get-login-password --region "$region" \
      | timeout --foreground --kill-after=10s 120s docker login --username AWS --password-stdin "$registry" >/dev/null 2>&1; } \
    || { log "CATALOG PRE-PULL FAILED: the registry login failed"; return 1; }
  for reference in "${pairs[@]}"; do
    reference="$registry/rovara-catalog/$environment/$reference"
    docker image inspect "$reference" >/dev/null 2>&1 || timeout --foreground --kill-after=10s 600s docker pull "$reference" >/dev/null 2>&1 || { log "CATALOG PRE-PULL FAILED: $reference"; return 1; }
    count=$((count + 1))
  done
  log "pulled $count catalog image(s) by digest"
}
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

# Optional until EXECUTOR_IMAGE is set; without it only end-to-end checks are withheld.
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

# Root-only: nothing here is secret today, but it must not become world-readable.
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
AGENTX_MODEL_FALLBACK=${AGENTX_MODEL_FALLBACK:-}
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
  # The web/API runtime's browser executor; docker exec agentx-worker processes read it here too.
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
# Also, for a setup run (rvbs<slot> bridges, which the firewall unit already walls as rvb* bridges: the host's ports, every private range). With br_netfilter a packet inside one bridge passes DOCKER-USER with
# -i and -o both that bridge, and the 172.16/12 drop would also drop the helper's replies (source port 53), so two things sit above the range drops, inserted first so the metadata rejection stays on top:
# replies of a connection already allowed (conntrack), and the helper's port 53 for traffic that stays INSIDE one bridge (physdev), so one run's sandbox cannot reach another run's helper.
# The firewall unit's "VPC DNS stays open" RETURN rules match -i rvb+ and so also rvbs+: a sandbox (172.29.<slot>.3) could ask the VPC resolver directly and skip the helper that watches its names. So its port 53
# traffic that leaves its bridge is dropped, inserted after those and so above them (this launcher runs after the firewall unit: the worker unit is ordered after it, and the unit's own rules are only added when absent).
# The helper (.2) keeps its own upstream path.
# Two kinds of rule, two kinds of failure. The two metadata rejections are fatal (return 1: the worker does not start), exactly as before. The five rvbs+ rules serve setup runs only and need the kernel modules br_netfilter,
# xt_conntrack and xt_physdev (the worker's AMI floats, so they may be missing): when ANY of them cannot be inserted, the ones that went in are deleted again (each by its exact rule text, never by position or flush, so the
# metadata rules are neither removed nor moved), the worker still starts, and the state file says "unavailable" so the worker refuses setup runs and runs everything else. The state file is made here and nowhere else: root-owned,
# 0644, inside /etc/agentx (root only, 0700), which neither the worker container nor any sandbox mounts; the launcher hands its content to the worker as AGENTX_SETUP_ISOLATION, and anything but the exact word "ready" (a missing,
# unreadable, foreign or odd file) reads as unavailable. This function is idempotent and safe to call again (for example after a Docker restart re-applies the firewall): rules already present are not added twice, the state file
# is written again by every call, and a later call that finds the rvbs+ rules incomplete beside metadata rules that already exist does not insert them (they would land above the metadata rejection) but deletes the rest and writes
# "unavailable". Return codes: 0 the metadata rules are in place (read the state file for the setup rules); 1 a metadata rule failed.
block_imds() {
  local rule module present=0 imds_present=false setup_ok=true state_file=${SETUP_ISOLATION_FILE:-/etc/agentx/setup-isolation}
  local -a setup_rules=("DOCKER-USER -i rvbs+ -o rvbs+ -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p udp --dport 53 -j RETURN" "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p tcp --dport 53 -j RETURN" "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p udp --dport 53 ! -o rvbs+ -j DROP" "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p tcp --dport 53 ! -o rvbs+ -j DROP")
  local -a imds_rules=("DOCKER-USER -d 169.254.169.254/32 -j REJECT" "OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT")
  for module in br_netfilter xt_conntrack xt_physdev; do
    modprobe "$module" 2>/dev/null || printf 'agentx-worker-start: setup isolation: module %s could not be loaded (not fatal)\n' "$module" >&2
  done
  # SC2086: the rule text is split into words on purpose.
  # shellcheck disable=SC2086
  iptables -C ${imds_rules[0]} 2>/dev/null && imds_present=true
  for rule in "${setup_rules[@]}"; do
    # shellcheck disable=SC2086
    iptables -C $rule 2>/dev/null && present=$((present + 1))
  done
  if ((present == ${#setup_rules[@]})); then
    :
  elif [[ $imds_present == true ]]; then
    setup_ok=false
    printf 'agentx-worker-start: setup isolation: the rvbs+ rules are incomplete beside existing metadata rules; not inserting them\n' >&2
  else
    for rule in "${setup_rules[@]}"; do
      # shellcheck disable=SC2086
      iptables -C $rule 2>/dev/null || iptables -I $rule || { setup_ok=false; printf 'agentx-worker-start: setup isolation: an rvbs+ rule could not be inserted\n' >&2; break; }
    done
  fi
  if [[ $setup_ok != true ]]; then
    for rule in "${setup_rules[@]}"; do
      # shellcheck disable=SC2086
      if iptables -C $rule 2>/dev/null; then iptables -D $rule || printf 'agentx-worker-start: setup isolation: an rvbs+ rule could not be removed\n' >&2; fi
    done
  fi
  for rule in "${imds_rules[@]}"; do
    # shellcheck disable=SC2086
    iptables -C $rule 2>/dev/null || iptables -I $rule || return 1
  done
  rm -f "$state_file" "$state_file.tmp"
  if [[ $setup_ok == true ]]; then
    printf 'ready\n' >"$state_file.tmp" && chmod 0644 "$state_file.tmp" && mv -f "$state_file.tmp" "$state_file" || { rm -f "$state_file.tmp" "$state_file"; printf 'agentx-worker-start: setup isolation: the state file could not be written, so setup runs are refused\n' >&2; }
  else
    printf 'unavailable\n' >"$state_file.tmp" && chmod 0644 "$state_file.tmp" && mv -f "$state_file.tmp" "$state_file" || rm -f "$state_file.tmp" "$state_file"
    printf 'agentx-worker-start: setup isolation UNAVAILABLE on this worker: setup runs will be refused; other tasks are not affected\n' >&2
  fi
  return 0
}
# What the worker is told: "ready" only for a regular, non-link file owned by root and not writable by group or others whose content is exactly "ready"; everything else (missing, unreadable, odd) is "unavailable".
setup_isolation_state() {
  local file=${SETUP_ISOLATION_FILE:-/etc/agentx/setup-isolation} mode
  mode=$(stat -c %u:%a "$file" 2>/dev/null) || { printf 'unavailable'; return 0; }
  if [[ -f "$file" && ! -L "$file" && "$mode" == 0:644 && "$(head -c 16 "$file" 2>/dev/null)" == ready ]]; then printf 'ready'; else printf 'unavailable'; fi
}
docker=$(cat /etc/agentx/docker-path 2>/dev/null || true)
worker_image=$(cat /etc/agentx/worker-image 2>/dev/null || true)
[[ "$docker" == /* && -x "$docker" ]] || { log 'Docker CLI unavailable'; exit 1; }
[[ "$worker_image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || { log 'worker image identity is invalid'; exit 1; }
docker_gid=$(stat -c %g "$DOCKER_SOCKET") || { log 'Docker socket unavailable'; exit 1; }
require_model_proxy || { log 'no model proxy'; exit 1; }
if named_environment; then block_imds || { log 'iptables failed'; exit 1; }; fi
# Test services (slice 1): the run directory for the services' env files and seeds, a small tmpfs at the SAME path on the host and in the worker (the Docker daemon resolves the bind mounts the worker asks for against the host).
# Made at every start, so it is there after a reboot too. Not fatal: without it the worker refuses runs that have dependencies, and everything else runs.
readonly TEST_SERVICES_RUN_DIR=/run/agentx-test-services
prepare_test_services_run_dir() {
  install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$TEST_SERVICES_RUN_DIR" || return 1
  mountpoint -q "$TEST_SERVICES_RUN_DIR" || mount -t tmpfs -o "size=64m,mode=0700,uid=$WORKER_UID,gid=$WORKER_GID,nosuid,nodev,noexec" tmpfs "$TEST_SERVICES_RUN_DIR" || return 1
  mountpoint -q "$TEST_SERVICES_RUN_DIR"
}
test_services_run_dir=false
if named_environment; then
  if prepare_test_services_run_dir; then test_services_run_dir=true; else log 'test services run directory unavailable (not fatal)'; fi
fi
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
# Setup runs need the rvbs+ rules that the firewall step above may have had to withdraw: the worker is told "ready" or "unavailable" (any other value, or none, it treats as unavailable). Only a named environment has setup runs.
if named_environment; then args+=(--env "AGENTX_SETUP_ISOLATION=$(setup_isolation_state)"); fi
if [[ "$test_services_run_dir" == true ]]; then args+=(--volume "$TEST_SERVICES_RUN_DIR:$TEST_SERVICES_RUN_DIR" --env "AGENTX_TEST_SERVICES_RUN_DIR=$TEST_SERVICES_RUN_DIR"); fi
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

# Opt-in TEST qualification (AGENTX_E2E_QUALIFICATION_*): its own unit, so it cannot fail the boot.
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
readonly FAILURE_NAME=runtime-install-failure.json
readonly CHALLENGE_MAX_BYTES=65536
readonly PROPOSAL_MAX_BYTES=5242880
readonly POLL=${AGENTX_E2E_QUALIFICATION_POLL_SECONDS:-10}
readonly HEALTHY_WAIT=${AGENTX_E2E_QUALIFICATION_HEALTHY_WAIT_SECONDS:-900}
readonly CHALLENGE_WAIT=${AGENTX_E2E_QUALIFICATION_CHALLENGE_WAIT_SECONDS:-1800}
readonly QUALIFY_SECONDS=${AGENTX_E2E_QUALIFICATION_QUALIFY_SECONDS:-2700}
readonly PULL_SECONDS=${AGENTX_E2E_QUALIFICATION_PULL_SECONDS:-300}
log() { printf 'agentx-e2e-qualification: %s\n' "$*" >&2; }
refuse() { log "refused: $1"; exit 2; }
[[ "$ROLE_ID" =~ ^AROA[A-Z0-9]{12,}$ ]] || refuse "the role ID must be the worker role's unique ID (AROA...)"
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || refuse "the instance ID is not valid"
[[ "$EXECUTOR" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || refuse "the executor image must be an ECR image pinned by digest"
[[ "$PROFILE" == linux-arm64-web-api-v1 ]] || refuse "the profile must be linux-arm64-web-api-v1"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || refuse "the bucket name is not valid"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || refuse "the region is not valid"
readonly PREFIX="e2e-runtime/$ROLE_ID:$INSTANCE_ID/"
STAGE=$(mktemp -d) || exit 1
readonly STAGE
# Status objects also carry the executor image and /ping's features (test-deploy --check).
EXTRA=",\"executorImage\":\"$EXECUTOR\""
upload() { aws s3api put-object --bucket "$BUCKET" --key "$PREFIX$1" --body "$2" --server-side-encryption AES256 --region "$REGION" --no-cli-pager >/dev/null; }
publish_status() {
  printf '{"state":"%s","reason":"%s","finishedAt":"%s"%s}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXTRA" >"$STAGE/status.json" && upload status.json "$STAGE/status.json"
}
add_failure() {
  local f="$EVIDENCE_HOST/$FAILURE_NAME" c
  [[ -f "$f" ]] || return 0
  c=$(dd if="$f" iflag=nofollow bs=16384 count=1 2>/dev/null | grep -oE '"[a-z0-9-]{1,48}(:[a-z0-9-]{1,48})?"[],}]' | head -n 16 | tr -d '],}' | paste -sd, -)
  EXTRA+=",\"failure\":{\"codes\":[$c]}"
}
fail_with() {
  log "failed: $1"
  publish_status FAILED "$1" || log "could not upload the failure status"
  exit 1
}
deadline=$((SECONDS + HEALTHY_WAIT))
until PING=$(curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:8080/ping 2>/dev/null); do
  ((SECONDS < deadline)) || fail_with worker-not-healthy
  sleep "$POLL"
done
features=$(tr -d ' \n\r\t' <<<"$PING" | grep -oE '"invocationFeatures":\[("[A-Za-z0-9.]+"(,"[A-Za-z0-9.]+")*)?\]' | head -n1) && [[ -n "$features" ]] && EXTRA+=",$features"
# The preload is optional but the qualification needs the executor image: pull it if missing.
if ! docker image inspect "$EXECUTOR" >/dev/null 2>&1; then
  log "the executor image is not on this host; pulling it"
  { timeout --foreground --kill-after=10s "${PULL_SECONDS}s" aws ecr get-login-password --region "$REGION" \
      | timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker login --username AWS --password-stdin "${EXECUTOR%%/*}" >/dev/null 2>&1 \
      && timeout --foreground --kill-after=10s "${PULL_SECONDS}s" docker pull "$EXECUTOR" >/dev/null 2>&1; } \
    || log "the executor image could not be pulled"
  docker image inspect "$EXECUTOR" >/dev/null 2>&1 || fail_with executor-image-unavailable
fi
printf '{"state":"READY","reason":"worker-healthy","finishedAt":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXTRA" >"$STAGE/ready.json" && upload ready.json "$STAGE/ready.json" || fail_with ready-upload-failed
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
rm -f "$EVIDENCE_HOST/$PROPOSAL_NAME" "$EVIDENCE_HOST/$FAILURE_NAME"
timeout --foreground --kill-after=10s "${QUALIFY_SECONDS}s" docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js --profile "$PROFILE" --challenge-file "$EVIDENCE_CONTAINER/$CHALLENGE_NAME" --evidence-root "$EVIDENCE_CONTAINER" --out "$EVIDENCE_CONTAINER/$PROPOSAL_NAME" --failure-out "$EVIDENCE_CONTAINER/$FAILURE_NAME" >"$STAGE/qualifier.log" 2>&1
status=$?
tail -c 2000 "$STAGE/qualifier.log" | while IFS= read -r line; do log "qualifier: $line"; done
((status == 0)) || { add_failure; fail_with "qualification-failed-exit-$status"; }
proposal="$STAGE/proposal"
dd if="$EVIDENCE_HOST/$PROPOSAL_NAME" iflag=nofollow of="$proposal" bs=1M count=6 2>/dev/null || fail_with proposal-missing
size=$(wc -c <"$proposal" | tr -d '[:space:]')
((size > 0)) || fail_with proposal-missing
((size <= PROPOSAL_MAX_BYTES)) || fail_with proposal-too-large
upload proposal.json "$proposal" || fail_with proposal-upload-failed
publish_status SUCCEEDED qualified || { log "could not upload the success status"; exit 1; }
log "qualified; the proposal and status are under the prefix"
timeout --foreground --kill-after=10s 7d docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --bucket "$BUCKET" --prefix "$PREFIX" 2>&1 | while read l; do log "$l"; done
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
  if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then
    if pull_catalog_images "$region"; then
      write_test_services_environment || log "the test services settings could not be written (not fatal; runs with dependencies are refused)"
    else
      log "test services are not offered on this worker (the catalog images could not be pulled; not fatal)"
    fi
    set_docker_address_pools || fail "could not set Docker's address pools"
    metadata_blocked || fail "the metadata block is missing after the Docker restart"
    wall_between_run_networks || fail "could not wall run networks off from each other"
    wall_ipv6_into_host || fail "could not drop IPv6 from run networks into the host"
    install_run_walls_unit || fail "could not install the unit that restores the run network walls"
  fi
  write_worker_unit "$region" "$instance_id"
  systemctl daemon-reload
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
  start_e2e_qualification "$region" "$instance_id" || log "the E2E qualification did not start"
}
