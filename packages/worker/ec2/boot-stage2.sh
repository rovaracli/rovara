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
  printf '{"data-root": "%s", "default-address-pools": %s%s}\n' "$DOCKER_DATA_ROOT" "$pools" "$(function_runner_daemon_runtimes)" >/etc/docker/daemon.json
  systemctl restart docker.service && bash /usr/local/libexec/rovara-container-firewall
}
# 2. Two different rvi bridges never talk (a run network and an end-to-end network, or two runs): routed between bridges is "not bridged", traffic inside one bridge is bridged and flows. Inserted at the top of DOCKER-USER, so no
#    earlier RETURN or ACCEPT for an rvi bridge can skip it (the launcher later puts the internal-address jumps above it, but those match rvbtask and rvbs+ only, never rvi+). IPv6 only where Docker has that chain.
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
#    missing), so after the Docker restart this puts the INPUT drops in place, or (4b below) withholds test services. Each is inserted at the top of INPUT, once. Without a usable ip6tables the boot is allowed to go on only when the host has no IPv6 at
#    all: IPv6 counts as off only when it is disabled for the interfaces that exist (conf/all) AND for those that will (conf/default, which a new bridge takes), or when the kernel has no IPv6.
ipv6_active() {
  [[ -e /proc/net/if_inet6 ]] || return 1
  [[ $(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null) != 1 || $(cat /proc/sys/net/ipv6/conf/default/disable_ipv6 2>/dev/null) != 1 ]]
}
IPV6_WALL_REASON=""
wall_ipv6_into_host() {
  local bridge
  IPV6_WALL_REASON=""
  if command -v ip6tables >/dev/null && ip6tables -S INPUT >/dev/null 2>&1; then
    for bridge in rvb+ rvi+; do
      ip6tables -C INPUT -i $bridge -j DROP 2>/dev/null || ip6tables -I INPUT -i $bridge -j DROP || { IPV6_WALL_REASON=rule-not-added; return 1; }
    done
  elif ipv6_active; then
    IPV6_WALL_REASON=ip6tables-unusable
    return 1
  fi
}
# 4b. An IPv6 wall that cannot be put in place does NOT stop the worker (owner, 2026-11-04). The worker runs normal tasks as in 0.5.2 but offers no test services: AGENTX_TEST_SERVICES_NOT_PULLED=all is the existing fail-closed
#    withhold (testServicesAdvertisedFeatures returns no feature, and testServicesConfigFromEnvironment no configuration, for `all`), written here BEFORE the worker unit starts. The wall itself records why it failed in
#    IPV6_WALL_REASON (one fixed word: ip6tables-unusable | rule-not-added), and the boot facts reuse that: ipv6Drops is false exactly when the wall failed, with the reason. The run network walls and the metadata block stay
#    fatal. Also run by the walls unit on a reboot or Docker restart, so there the worker comes back withheld instead of not at all.
#    The withhold is STICKY for the life of the instance (it fails closed): if the walls unit later succeeds (a reboot, a Docker restart), worker.env keeps `all` and the old reason until a new launch rewrites worker.env.
withhold_test_services_for_ipv6() {
  local reason=${1:-ip6tables-unusable} file=${WORKER_ENV_FILE:-/etc/agentx/worker.env} tmp from to
  IPV6_WALL_REASON=$reason
  from='"ipv6Drops":true'
  to="\"ipv6Drops\":false,\"ipv6DropsReason\":\"$reason\""
  # A private (0600) temp file in the SAME directory, moved over the target: the replace is atomic, so a reader never sees a half-written worker.env. The whole new file is written by ONE subshell redirected into
  # it that stops at the first failed write; the last line must then be the withhold itself, or the temp file is removed and nothing is moved (a full disk must not leave a worker.env without the withhold).
  tmp=$(mktemp "$file.XXXXXX") || return 1
  (
    line=""
    if [[ -f "$file" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        case $line in
          AGENTX_TEST_SERVICES_NOT_PULLED=*) ;;
          AGENTX_TEST_SERVICES_BOOT_FACTS=*) printf '%s\n' "${line//"$from"/$to}" || exit 1 ;;
          *) printf '%s\n' "$line" || exit 1 ;;
        esac
      done <"$file"
    fi
    printf 'AGENTX_TEST_SERVICES_NOT_PULLED=all\n' || exit 1
  ) >"$tmp" || { rm -f "$tmp"; return 1; }
  [[ $(tail -n 1 "$tmp") == AGENTX_TEST_SERVICES_NOT_PULLED=all ]] || { rm -f "$tmp"; return 1; }
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file" || { rm -f "$tmp"; return 1; }
  log "TEST SERVICES WITHHELD: could not drop IPv6 from run networks into the host ($reason); the worker runs normal tasks and offers no test services"
}
# 5. The walls above and the isolation DROP are not in the container firewall unit (boot.sh, at its size limit, writes that), so they would be lost at a host reboot or a Docker restart (a restart rebuilds Docker's chains) if
#    only this one-time boot put them in place. A unit of its own re-applies them whenever the firewall unit runs, before the worker starts. An idle stop TERMINATES the instance and the next start launches a new one that runs boot.sh
#    and this stage again; the unit covers what a new launch does not: a reboot of the same instance and a Docker restart.
readonly RUN_WALLS_UNIT=rovara-run-walls.service
install_run_walls_unit() {
  install -d -o root -g root -m 0755 /usr/local/libexec
  # The run network wall is fatal here; the IPv6 one is not: a failure withholds test services (see 4b) and lets the worker start. A worker that is already running is restarted (best effort, not waited for: it is ordered after this unit) so it re-reads its environment.
  { printf 'set -e\nWORKER_ENV_FILE=%s\nWORKER_UNIT=%s\nlog() { printf "%%s\\n" "$*" >&2; }\n' "$WORKER_ENV_FILE" "$WORKER_UNIT"; declare -f ipv6_active wall_between_run_networks wall_ipv6_into_host withhold_test_services_for_ipv6; printf 'wall_between_run_networks\nwall_ipv6_into_host || { withhold_test_services_for_ipv6 "${IPV6_WALL_REASON:-ip6tables-unusable}" || exit 1; systemctl try-restart --no-block "$WORKER_UNIT" || true; }\n'; } >/usr/local/libexec/rovara-run-walls || return 1
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
  # AGENTX_WORKER_IMAGE (the worker's own image, pinned by digest): the sealed round's resolver guard, a root NET_ADMIN container, runs from this and never from the sandbox image (check-sandbox.ts, "THE GUARD'S IMAGE").
  { printf 'AGENTX_TEST_SERVICES_REGISTRY=%s\n' "$registry"; printf 'AGENTX_TEST_SERVICES_ENV=%s\n' "$environment"; printf 'AGENTX_WORKER_IMAGE=%s\n' "$AGENTX_WORKER_IMAGE"; } >>"$WORKER_ENV_FILE"
  # Per image: the repositories that did not pre-pull (a comma list of svc/<name>); the worker does not offer them. FAIL CLOSED: a list that is not well formed or has more than 16 names is written as `all`
  # (every image counts as not pulled and the worker offers no test-services feature), never dropped, because writing nothing would offer images that are not here.
  # A worker already withheld (`all`, written by withhold_test_services_for_ipv6 or by a launch with tx off) STAYS withheld: a per-image list never replaces or follows it.
  if [[ -n "${PREPULL_FAILED_REPOS:-}" ]] && ! grep -qx 'AGENTX_TEST_SERVICES_NOT_PULLED=all' "$WORKER_ENV_FILE" 2>/dev/null; then
    if [[ "$PREPULL_FAILED_REPOS" =~ ^svc/[a-z0-9][a-z0-9._-]{0,62}(,svc/[a-z0-9][a-z0-9._-]{0,62}){0,15}$ ]]; then printf 'AGENTX_TEST_SERVICES_NOT_PULLED=%s\n' "$PREPULL_FAILED_REPOS" >>"$WORKER_ENV_FILE"
    else printf 'AGENTX_TEST_SERVICES_NOT_PULLED=all\n' >>"$WORKER_ENV_FILE"; fi
  fi
}
# The worker container has no registry login and no AWS credentials (only root on the host has the instance role), so ROOT pulls, before the worker starts, every digest in the pre-pull list baked into the worker image
# (catalog repositories `svc/*` only, by digest, never a tag). The worker never pulls: it runs a dependency only if its digest is pinned in the image AND already here. Nothing to pull (no catalog, an empty list) is fine and
# silent. A login that fails, or no image arriving at all, is logged loudly and returns 1, and the caller then does not offer test services on this worker (the broker refuses a plan to it) while the worker still takes everything else.
# Some images arriving and others not (slice 2) is `partial`: returns 0, the settings are written, and the repositories that did not arrive are listed in AGENTX_TEST_SERVICES_NOT_PULLED (not offered; the rest stay available).
# What the last pull_catalog_images did, for the boot facts the worker reports (CloudWatch): none | ok | partial (some images arrived, the rest are named in AGENTX_TEST_SERVICES_NOT_PULLED) | failed, how many digests, and whether the registry login was removed.
PREPULL_RESULT=none; PREPULL_COUNT=0; PREPULL_LOGGED_OUT=false; PREPULL_FAILED_REPOS=""
# ONLY when test services are on (`tx`; the control plane's launch writes AGENTX_TEST_SERVICES=1 only then). With them off there is no list read, no ECR login, no pull and no log line, and the boot facts say `off`. This is gated on
# the switch and NOT on the build flavor: the worker image is a release-flavor build even on staging (it trusts only digests baked into its own image plus this pre-pull), so an empty list in release builds would stop staging workers.
# Every pull is the install's OWN registry and environment (cut from its worker image and log group below), never a fixed account: the list carries repository and digest only.
# `catalog_seconds N`: N seconds, but never past the boot deadline (less the 10 s the kill grace adds), so the whole pre-pull ends inside /ping's window. At least 1.
catalog_seconds() {
  local left=$(( ${BOOT_DEADLINE:-$((SECONDS + 100000))} - SECONDS - 10 ))
  ((left > 1)) || left=1
  printf '%s\n' $(($1 < left ? $1 : left))
}
pull_catalog_images() {
  local region=$1 registry=${AGENTX_WORKER_IMAGE%%/*} environment list line repository digest="" count=0 failed="" pairs=() pair reference results file index=0
  local timeout_s=180 parallel=4 all=() kind runner_count=0 runner_failed=""
  # Off: nothing is read, logged in or pulled, and nothing is logged. The facts say `off`. (The broker sends no dependency plan while `tx` is off; a worker launched with it off that is later asked for one refuses at run time with the fixed "not available on this worker" words, as for any image that did not arrive.)
  if [[ "${AGENTX_TEST_SERVICES:-}" != 1 ]]; then PREPULL_RESULT=off; return 0; fi
  # Overrides count only as plain positive whole numbers; anything else (0, empty, text) is the default.
  [[ "${CATALOG_PULL_TIMEOUT_S:-}" =~ ^[1-9][0-9]*$ ]] && timeout_s=$CATALOG_PULL_TIMEOUT_S
  [[ "${CATALOG_PULL_PARALLEL:-}" =~ ^[1-9][0-9]*$ ]] && parallel=$CATALOG_PULL_PARALLEL
  [[ "$registry" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$ ]] || return 0
  [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z][a-z0-9-]{0,19})/worker$ ]] || return 0
  environment=${BASH_REMATCH[1]}
  # The list is read with a throwaway `cat` of the image's own file (no network, read-only, no capability): not a second copy-out of the image (stage 1 copies out stage 2 only, once).
  list=$(mktemp) || return 1
  timeout --foreground --kill-after=10s "$(catalog_seconds 120)s" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/service-catalog/prepull.json >"$list" 2>/dev/null || : >"$list"
  while IFS= read -r line; do
    if [[ "$line" =~ ^\"repository\":\ *\"(svc/[a-z0-9][a-z0-9._-]{0,62})\" ]]; then repository=${BASH_REMATCH[1]}
    elif [[ "$line" =~ \"digest\":\ *\"(sha256:)?([a-f0-9]{64})\" && -n "${repository:-}" ]]; then pairs+=("$repository@sha256:${BASH_REMATCH[2]}"); repository=""; fi
  done < <(tr -d '\r' <"$list" | sed -E 's/^[[:space:]]+//; s/,$//' | grep -E '^"(repository|digest)"')
  rm -f "$list"
  # Slice 4: the function runner's images ride in the same pulls (one login, the same bounds), when it is on and the disk has room (function_runner_collect_pairs); otherwise nothing changes. They are COUNTED APART: `pairs`, the
  # count, PREPULL_RESULT and PREPULL_FAILED_REPOS (so the boot facts and AGENTX_TEST_SERVICES_NOT_PULLED) are the SERVICE images' only; the runner's outcome is FUNCTION_RUNNER_PULLED and FUNCTION_RUNNER_FAILED_REPOS.
  function_runner_collect_pairs || true
  ((${#pairs[@]} + ${#FUNCTION_RUNNER_PAIRS[@]} > 0)) || return 0
  # Too little of the boot deadline left to log in and pull (under 30 s): pull nothing, name every repository as not pulled (AGENTX_TEST_SERVICES_NOT_PULLED) and keep the worker starting.
  if [[ -n "${BOOT_DEADLINE:-}" ]] && ((BOOT_DEADLINE - SECONDS < 30)); then
    ((${#FUNCTION_RUNNER_PAIRS[@]} == 0)) || { FUNCTION_RUNNER_FAILED_REPOS="$FUNCTION_RUNNER_REPOSITORIES"; function_runner_unavailable images-not-pulled; }
    ((${#pairs[@]} > 0)) || return 0
    for pair in "${pairs[@]}"; do failed="$failed ${pair%%@*}"; done
    PREPULL_FAILED_REPOS=$(printf '%s\n' $failed | sort -u | paste -sd, -)
    PREPULL_RESULT=failed; log "CATALOG PRE-PULL SKIPPED: the boot deadline is too close: $PREPULL_FAILED_REPOS"; return 1
  fi
  { timeout --foreground --kill-after=10s "$(catalog_seconds 120)s" aws ecr get-login-password --region "$region" \
      | timeout --foreground --kill-after=10s "$(catalog_seconds 120)s" docker login --username AWS --password-stdin "$registry" >/dev/null 2>&1; } \
    || { docker logout "$registry" >/dev/null 2>&1 && PREPULL_LOGGED_OUT=true; PREPULL_RESULT=failed; log "CATALOG PRE-PULL FAILED: the registry login failed"; return 1; }
  # Each pull is bounded on its own (180 s, then killed; CATALOG_PULL_TIMEOUT_S overrides) and up to 4 run at once (CATALOG_PULL_PARALLEL), so one hung pull holds boot for one timeout and not for ten minutes. A pull that fails
  # does NOT stop the others (slice 2, per image): the rest are pulled and stay available, and each repository that did not arrive is named in AGENTX_TEST_SERVICES_NOT_PULLED so the worker does not offer it (a plan that needs
  # it is refused at run time with the fixed "not available on this worker" words). Once the boot deadline has passed, the images not yet started count as not pulled. Results are one file per pull in a private directory
  # (a background pull cannot set this shell's variables).
  PREPULL_FAILED_REPOS=""
  results=$(mktemp -d) || { docker logout "$registry" >/dev/null 2>&1 && PREPULL_LOGGED_OUT=true; PREPULL_RESULT=failed; log "CATALOG PRE-PULL FAILED: no scratch directory"; return 1; }
  ((${#pairs[@]} == 0)) || all+=("${pairs[@]}")
  ((${#FUNCTION_RUNNER_PAIRS[@]} == 0)) || all+=("${FUNCTION_RUNNER_PAIRS[@]}")
  for pair in "${all[@]}"; do
    index=$((index + 1))
    kind=""; [[ " $FUNCTION_RUNNER_REPOSITORIES " == *" ${pair%%@*} "* ]] && kind=r
    if [[ -n "${BOOT_DEADLINE:-}" ]] && ((BOOT_DEADLINE - SECONDS < 20)); then printf '%s' "${pair%%@*}" >"$results/$index.${kind}fail"; continue; fi
    reference="$registry/rovara-catalog/$environment/$pair"
    while (($(jobs -rp | wc -l) >= parallel)); do sleep 1; done
    (
      docker image inspect "$reference" >/dev/null 2>&1 && : >"$results/$index.${kind}ok" && exit 0
      timeout --foreground --kill-after=10s "$(catalog_seconds "$timeout_s")s" docker pull "$reference" >/dev/null 2>&1 && : >"$results/$index.${kind}ok" && exit 0
      printf '%s' "${pair%%@*}" >"$results/$index.${kind}fail"
    ) &
  done
  wait
  for file in "$results"/*.ok; do [[ ! -e "$file" ]] || count=$((count + 1)); done
  for file in "$results"/*.fail; do [[ ! -e "$file" ]] || failed="$failed $(cat "$file")"; done
  for file in "$results"/*.rok; do [[ ! -e "$file" ]] || runner_count=$((runner_count + 1)); done
  for file in "$results"/*.rfail; do [[ ! -e "$file" ]] || runner_failed="$runner_failed $(cat "$file")"; done
  rm -rf "$results"
  # No ECR token stays on disk after the pulls (the worker has no login of its own and needs none).
  docker logout "$registry" >/dev/null 2>&1 && PREPULL_LOGGED_OUT=true
  # The runner's own outcome: any of its repositories not pulled is a reason it is not offered (never a reason a SERVICE is withheld).
  FUNCTION_RUNNER_PULLED=$runner_count
  if [[ -n "$runner_failed" ]]; then FUNCTION_RUNNER_FAILED_REPOS=$(printf '%s\n' $runner_failed | sort -u | paste -sd, -); function_runner_unavailable images-not-pulled; fi
  ((${#pairs[@]} > 0)) || return 0
  PREPULL_COUNT=$count
  if [[ -n "$failed" ]]; then
    PREPULL_FAILED_REPOS=$(printf '%s\n' $failed | sort -u | paste -sd, -)
    if ((count == 0)); then PREPULL_RESULT=failed; log "CATALOG PRE-PULL FAILED: $failed"; return 1; fi
    PREPULL_RESULT=partial
    log "CATALOG PRE-PULL PARTIAL: pulled $count, not offered on this worker: $PREPULL_FAILED_REPOS"
    return 0
  fi
  PREPULL_RESULT=ok
  log "pulled $count catalog image(s) by digest"
}
# The facts only root can see, handed to the worker as ONE environment value that it logs at its start (staging workers are not SSM-managed, so nothing reads them from the host). Booleans, a count and a version number:
# no name, path or secret. Written after the walls are in place; the worker validates the shape (packages/worker/src/test-services-report.ts parseBootFacts).
write_test_services_boot_facts() {
  local imds=false walls=false ip6=false ip6_reason="" docker_version
  metadata_blocked && imds=true
  iptables -C DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP 2>/dev/null && walls=true
  # The IPv6 fact is the wall's own result (IPV6_WALL_REASON, set by wall_ipv6_into_host / the withhold in this same boot), not a second probe that could disagree with it.
  if [[ -z "${IPV6_WALL_REASON:-}" ]]; then ip6=true; else ip6_reason=$IPV6_WALL_REASON; fi
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -n1)
  [[ "$docker_version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){0,3}(-[a-z0-9.]{1,12})?$ ]] || docker_version=0
  [[ -z "$ip6_reason" ]] || ip6_reason=",\"ipv6DropsReason\":\"$ip6_reason\""
  printf 'AGENTX_TEST_SERVICES_BOOT_FACTS={"metadataBlocked":%s,"runWalls":%s,"ipv6Drops":%s%s,"prepull":"%s","prepulled":%s,"loggedOut":%s,"dockerVersion":"%s"}\n' \
    "$imds" "$walls" "$ip6" "$ip6_reason" "$PREPULL_RESULT" "$PREPULL_COUNT" "$PREPULL_LOGGED_OUT" "$docker_version" >>"$WORKER_ENV_FILE"
}
# Slice 4 (the function runner), named environments only, and only when the launch turns it on (AGENTX_FUNCTION_RUNNER=1 with test services on; nothing in the control plane sets it yet: it waits for the live proof, F7).
# A function runs in a gVisor sandbox (`docker run --runtime runsc`) from AWS's Lambda base image, with Rovara's static agent mounted read-only. This stage's part, in order:
#   1. install_function_runner_runsc  (FIRST in the named block: before the image pulls, with its own time budget, and before Docker's daemon.json is written) downloads the PINNED, DATED gVisor release for this machine's architecture, checks its sha512 against the value written in this file (never one that came
#      with the download), unpacks only the files the archive is allowed to hold, and keeps it under a root-owned versioned directory. EVERY attempt is checked: a file is used only after the check passes, on a first try or a retry,
#      and nothing already on disk is reused. set_docker_address_pools then registers it as the `runsc` runtime in the same daemon.json it writes (it writes that file from scratch, so a runtime written anywhere else would be lost).
#   2. pull_catalog_images adds the runner's three repositories (function-agent, lambda-python, lambda-nodejs: `function-runner-prepull.json`, digests only) to its pulls, when the disk has room.
#   3. finish_function_runner  (after Docker restarted) checks that Docker lists the runtime, that a container really runs under it (its kernel is not the host's), that every runner image here is of this machine's architecture,
#      extracts the agent file out of its image to a root-owned path, and only then writes AGENTX_FUNCTION_RUNNER=ready. ANY failure writes `unavailable` and one fixed reason instead: the worker keeps starting and keeps its other
#      features (as the IPv6 wall does), and the broker never sends it a plan that needs the runner, because the worker lists the feature only for `ready` (function-runner-ready.ts).
# The values below are held equal to packages/cloud-contracts/src/function-runner-catalog.ts by a test.
readonly GVISOR_RELEASE=20261109.0
readonly GVISOR_BASE_URL=https://storage.googleapis.com/gvisor/releases/release/20261109.0
readonly GVISOR_SHA512_AARCH64=411f2d6f7f98a93643725ce9933ff67a7f96f884c2317be3e2b579b976ceb54065bd1d4292a9d61de38da1940ef21b7e41070127874086b7992fb7b5e7a85897
readonly GVISOR_SHA512_X86_64=1a6b8f74c37b4931ef473f67ec1f601690855bedc52ac709f2fac965c69677aa0426ef44598d8eee1aed72cfdb9df87a2a5f352cb3348880fc61a7732bc10f2a
readonly GVISOR_ROOT=/usr/local/lib/rovara-gvisor
readonly FUNCTION_RUNNER_AGENT_DIR=/opt/rovara/function-runner
readonly FUNCTION_RUNNER_AGENT_PATH=/opt/rovara/function-runner/agent
readonly FUNCTION_RUNNER_REPOSITORIES="svc/function-agent svc/lambda-nodejs svc/lambda-python"
# Free space (MB) the Docker data directory must have BEFORE the runner's images are pulled: they are about 2.5 GB, and the services and runs need the rest.
readonly FUNCTION_RUNNER_MIN_FREE_MB=8192
readonly FUNCTION_RUNNER_INSTALL_BUDGET_S=150
FUNCTION_RUNNER_RUNSC=""; FUNCTION_RUNNER_STATE=off; FUNCTION_RUNNER_REASON=""; FUNCTION_RUNNER_PAIRS=(); FUNCTION_RUNNER_PULLED=0; FUNCTION_RUNNER_FAILED_REPOS=""
function_runner_enabled() { [[ "${AGENTX_FUNCTION_RUNNER:-}" == 1 && "${AGENTX_TEST_SERVICES:-}" == 1 ]]; }
# One of the fixed reasons (function-runner-catalog.ts FUNCTION_RUNNER_UNAVAILABLE_REASONS), never a command's own text.
function_runner_unavailable() { FUNCTION_RUNNER_STATE=unavailable; FUNCTION_RUNNER_REASON=$1; log "FUNCTION RUNNER NOT OFFERED on this worker: $1 (not fatal)"; return 0; }
install_function_runner_runsc() {
  local arch want stage archive attempt verified=false dir budget_end left
  FUNCTION_RUNNER_RUNSC=""
  function_runner_enabled || return 0
  [[ "$FUNCTION_RUNNER_STATE" != unavailable ]] || return 1
  case "$(uname -m)" in
    aarch64|arm64) arch=aarch64; want=$GVISOR_SHA512_AARCH64 ;;
    x86_64) arch=x86_64; want=$GVISOR_SHA512_X86_64 ;;
    *) function_runner_unavailable arch-not-supported; return 1 ;;
  esac
  stage=$(mktemp -d /var/tmp/rovara-gvisor.XXXXXX) || { function_runner_unavailable runtime-install-failed; return 1; }
  chmod 0700 "$stage"
  archive="$stage/gvisor.tar.bz2"
  # Its OWN share of the boot's time, taken BEFORE the image pulls: at most 100 s a try and 150 s in all (and never past the boot deadline), so neither a slow pull starves it nor a hung download starves the pulls.
  budget_end=$((SECONDS + FUNCTION_RUNNER_INSTALL_BUDGET_S))
  for attempt in 1 2 3; do
    rm -f "$archive"
    left=$((budget_end - SECONDS)); ((left >= 5)) || break
    if timeout --foreground --kill-after=10s "$(catalog_seconds $((left < 100 ? left : 100)))s" curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-filesize 134217728 --output "$archive" "$GVISOR_BASE_URL/$arch/gvisor.tar.bz2" 2>/dev/null \
      && [[ "$(sha512sum "$archive" 2>/dev/null | cut -d' ' -f1)" == "$want" ]]; then verified=true; break; fi
    sleep "${FUNCTION_RUNNER_RETRY_SLEEP:-2}"
  done
  if [[ $verified != true ]]; then rm -rf "$stage"; function_runner_unavailable runtime-install-failed; return 1; fi
  # Only the archive's own, plain, regular files (and one directory level) are written, each created new and never through a link; anything else in it stops the install.
  if ! python3 -I - "$archive" "$stage/out" <<'PY' 2>/dev/null; then
import os, re, sys, tarfile
archive, out = sys.argv[1], sys.argv[2]
name_ok = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$")
os.mkdir(out, 0o755)
total = 0
with tarfile.open(archive, "r:bz2") as tar:
    members = tar.getmembers()
    if len(members) > 64 or "runsc" not in [m.name for m in members]:
        sys.exit(1)
    for m in members:
        if not name_ok.match(m.name) or not (m.isreg() or (m.isdir() and "/" not in m.name)):
            sys.exit(1)
        total += m.size
        if total > 400 * 1024 * 1024:
            sys.exit(1)
        path = os.path.join(out, m.name)
        if m.isdir():
            os.mkdir(path, 0o755)
            continue
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        with os.fdopen(fd, "wb") as target, tar.extractfile(m) as source:
            while True:
                chunk = source.read(1 << 20)
                if not chunk:
                    break
                target.write(chunk)
PY
    rm -rf "$stage"; function_runner_unavailable runtime-install-failed; return 1
  fi
  dir="$GVISOR_ROOT/$GVISOR_RELEASE"
  if ! { install -d -o root -g root -m 0755 "$GVISOR_ROOT" && rm -rf "$dir" && mv "$stage/out" "$dir" && chown -R root:root "$dir" && chmod -R go-w "$dir" && [[ -f "$dir/runsc" && ! -L "$dir/runsc" && -x "$dir/runsc" ]] \
    && "$dir/runsc" --version 2>&1 | grep -q "${GVISOR_RELEASE%%.*}"; }; then
    rm -rf "$stage" "$dir"; function_runner_unavailable runtime-install-failed; return 1
  fi
  rm -rf "$stage"
  FUNCTION_RUNNER_RUNSC="$dir/runsc"
  log "gVisor $GVISOR_RELEASE installed (sha512 checked)"
}
# What set_docker_address_pools adds to daemon.json: the runsc runtime, only after install_function_runner_runsc succeeded (the path is one this script made, never an input).
function_runner_daemon_runtimes() {
  [[ -n "$FUNCTION_RUNNER_RUNSC" && "$FUNCTION_RUNNER_RUNSC" == "$GVISOR_ROOT/$GVISOR_RELEASE/runsc" ]] || return 0
  printf ', "runtimes": {"runsc": {"path": "%s"}}' "$FUNCTION_RUNNER_RUNSC"
}
# The host reference of one runner pair (`svc/<name>@sha256:<digest>`), in the install's own registry and environment, by digest.
function_runner_reference() {
  [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z][a-z0-9-]{0,19})/worker$ ]] || return 1
  printf '%s/rovara-catalog/%s/%s\n' "${AGENTX_WORKER_IMAGE%%/*}" "${BASH_REMATCH[1]}" "$1"
}
# Reads the runner's pre-pull list out of the worker image (a throwaway `cat`, as for prepull.json) into FUNCTION_RUNNER_PAIRS. Returns 1, saying why in one fixed word, when the runner is off, has no room on disk, or its list does not hold all three repositories.
function_runner_collect_pairs() {
  local list line repository="" free_mb name
  FUNCTION_RUNNER_PAIRS=()
  function_runner_enabled || return 1
  [[ "$FUNCTION_RUNNER_STATE" != unavailable ]] || return 1
  free_mb=$(df -Pm "$DOCKER_DATA_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
  if ! { [[ "$free_mb" =~ ^[0-9]+$ ]] && ((free_mb >= FUNCTION_RUNNER_MIN_FREE_MB)); }; then function_runner_unavailable disk-too-low; return 1; fi
  list=$(mktemp) || { function_runner_unavailable images-not-pulled; return 1; }
  timeout --foreground --kill-after=10s "$(catalog_seconds 120)s" docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint cat "$AGENTX_WORKER_IMAGE" /opt/agentx/packages/worker/service-catalog/function-runner-prepull.json >"$list" 2>/dev/null || : >"$list"
  while IFS= read -r line; do
    if [[ "$line" =~ ^\"repository\":\ *\"(svc/[a-z0-9][a-z0-9._-]{0,62})\" ]]; then repository=${BASH_REMATCH[1]}
    elif [[ "$line" =~ \"digest\":\ *\"(sha256:)?([a-f0-9]{64})\" && -n "$repository" ]]; then
      # Only the runner's own repositories: the list is data in the image, but nothing it names is pulled unless this script knows the name.
      [[ " $FUNCTION_RUNNER_REPOSITORIES " == *" $repository "* ]] && FUNCTION_RUNNER_PAIRS+=("$repository@sha256:${BASH_REMATCH[2]}")
      repository=""
    fi
  done < <(tr -d '\r' <"$list" | sed -E 's/^[[:space:]]+//; s/,$//' | grep -E '^"(repository|digest)"')
  rm -f "$list"
  for name in $FUNCTION_RUNNER_REPOSITORIES; do
    [[ "$(printf '%s\n' "${FUNCTION_RUNNER_PAIRS[@]:-}" | grep -c "^$name@")" -ge 1 ]] || { FUNCTION_RUNNER_PAIRS=(); function_runner_unavailable images-not-pulled; return 1; }
  done
  return 0
}
# After Docker restarted: the runtime is registered AND really runs a container (its kernel is gVisor's, not the host's: the worker image's own node prints it), the runner's images are of this machine's architecture, and the agent is
# extracted from its image to a root-owned file that is an ELF for this machine. Returns 1 with the state `unavailable` and one fixed reason on any failure.
verify_function_runner_runtime() {
  [[ -n "$FUNCTION_RUNNER_RUNSC" ]] || { function_runner_unavailable runtime-not-registered; return 1; }
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"' || { function_runner_unavailable runtime-not-registered; return 1; }
  timeout --foreground --kill-after=10s "$(catalog_seconds 60)s" docker run --rm --pull never --runtime runsc --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint /usr/local/bin/node "$AGENTX_WORKER_IMAGE" \
    -e 'process.exit(require("os").release() === process.argv[1] ? 3 : 0)' "$(uname -r)" >/dev/null 2>&1 || { function_runner_unavailable runtime-smoke-failed; return 1; }
}
function_runner_docker_arch() { case "$(uname -m)" in aarch64|arm64) printf 'arm64' ;; x86_64) printf 'amd64' ;; esac; }
function_runner_machine_byte() { case "$(uname -m)" in aarch64|arm64) printf 'b7' ;; x86_64) printf '3e' ;; esac; }
extract_function_agent() {
  local pair reference="" container tmp machine
  for pair in "${FUNCTION_RUNNER_PAIRS[@]:-}"; do [[ "$pair" == svc/function-agent@* ]] && reference=$(function_runner_reference "$pair"); done
  [[ -n "$reference" ]] || { function_runner_unavailable agent-unavailable; return 1; }
  tmp=$(mktemp -d /var/tmp/rovara-agent.XXXXXX) || { function_runner_unavailable agent-unavailable; return 1; }
  chmod 0700 "$tmp"
  container=$(docker create --pull never --network none --entrypoint /agent "$reference" 2>/dev/null) || { rm -rf "$tmp"; function_runner_unavailable agent-unavailable; return 1; }
  docker cp "$container:/agent" "$tmp/agent" >/dev/null 2>&1; docker rm -f "$container" >/dev/null 2>&1 || true
  machine=$(function_runner_machine_byte)
  # A regular file (not a link), not empty and under 64 MB, an ELF (7f 45 4c 46) whose machine is this one's (byte 18: b7 aarch64, 3e x86-64): a wrong-architecture agent would fail every function silently.
  if ! { [[ -n "$machine" && -f "$tmp/agent" && ! -L "$tmp/agent" && -s "$tmp/agent" && "$(wc -c <"$tmp/agent" | tr -d ' ')" -le 67108864 ]] \
    && [[ "$(od -An -tx1 -N4 "$tmp/agent" | tr -d ' \n')" == 7f454c46 && "$(od -An -tx1 -j18 -N1 "$tmp/agent" | tr -d ' \n')" == "$machine" ]] \
    && install -d -o root -g root -m 0755 /opt/rovara "$FUNCTION_RUNNER_AGENT_DIR" && install -o root -g root -m 0755 "$tmp/agent" "$FUNCTION_RUNNER_AGENT_DIR/.agent.new" && mv -f "$FUNCTION_RUNNER_AGENT_DIR/.agent.new" "$FUNCTION_RUNNER_AGENT_PATH"; }; then
    rm -f "$FUNCTION_RUNNER_AGENT_DIR/.agent.new"; rm -rf "$tmp"; function_runner_unavailable agent-unavailable; return 1
  fi
  rm -rf "$tmp"
}
finish_function_runner() {
  local pair reference arch
  function_runner_enabled || return 0
  if [[ "$FUNCTION_RUNNER_STATE" != unavailable ]]; then
    if ((${#FUNCTION_RUNNER_PAIRS[@]} == 0)); then function_runner_unavailable images-not-pulled
    else
      for pair in "${FUNCTION_RUNNER_PAIRS[@]}"; do
        # Pulled (a repository the services pre-pull reported as failed is not here) and of this machine's architecture: an image of another one is removed, never used.
        if [[ ",${FUNCTION_RUNNER_FAILED_REPOS:-}," == *",${pair%%@*},"* ]]; then function_runner_unavailable images-not-pulled; break; fi
        reference=$(function_runner_reference "$pair") || { function_runner_unavailable images-not-pulled; break; }
        arch=$(docker image inspect --format '{{.Architecture}}' "$reference" 2>/dev/null || true)
        if [[ -z "$arch" || "$arch" != "$(function_runner_docker_arch)" ]]; then
          docker rmi "$reference" >/dev/null 2>&1 || true; function_runner_unavailable images-not-pulled; break
        fi
      done
    fi
  fi
  if [[ "$FUNCTION_RUNNER_STATE" != unavailable ]]; then verify_function_runner_runtime || true; fi
  if [[ "$FUNCTION_RUNNER_STATE" != unavailable ]]; then extract_function_agent || true; fi
  [[ "$FUNCTION_RUNNER_STATE" == unavailable ]] || FUNCTION_RUNNER_STATE=ready
  write_function_runner_environment
}
# Root's note for the worker: `ready` with the runtime and agent path, or `unavailable` with the fixed reason. Nothing else is ever written.
write_function_runner_environment() {
  function_runner_enabled || return 0
  if [[ "$FUNCTION_RUNNER_STATE" == ready ]]; then
    printf 'AGENTX_FUNCTION_RUNNER=ready\nAGENTX_FUNCTION_RUNNER_RUNTIME=runsc\nAGENTX_FUNCTION_RUNNER_AGENT=%s\nAGENTX_FUNCTION_RUNNER_PULLED=%s\n' "$FUNCTION_RUNNER_AGENT_PATH" "$FUNCTION_RUNNER_PULLED" >>"$WORKER_ENV_FILE"
  else
    printf 'AGENTX_FUNCTION_RUNNER=unavailable\nAGENTX_FUNCTION_RUNNER_REASON=%s\nAGENTX_FUNCTION_RUNNER_PULLED=%s\n' "${FUNCTION_RUNNER_REASON:-runtime-install-failed}" "$FUNCTION_RUNNER_PULLED" >>"$WORKER_ENV_FILE"
  fi
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
# Owner decision 123: open the company's approved internal addresses on the task and setup bridges, resolved and pinned now, until the next start of the worker container (stage 2 `write_private_addresses`). Not fatal: a failure opens nothing.
if named_environment && [[ -f /usr/local/libexec/rovara-private-allow ]]; then /bin/bash /usr/local/libexec/rovara-private-allow || log 'internal addresses not opened (not fatal: tasks reach none of them)'; fi
# The opt-in TS-L self-test (stage 2 `run_tsl_selftest`) applies exactly the wall steps above, before it runs, by starting this script with --walls-only: it stops here, before anything that starts or prepares a worker.
[[ "${1:-}" != --walls-only ]] || exit 0
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
# Owner decision 123: the pinned name=address pairs (for the sandboxes' --add-host) and the step's counts, each only in its one written form.
if named_environment; then for pair in "AGENTX_PRIVATE_ADDRESS_HOSTS:/etc/agentx/private-address-pins:^[a-z0-9.-]{1,94}=[0-9.]{7,15}(,[a-z0-9.-]{1,94}=[0-9.]{7,15}){0,127}$" "AGENTX_PRIVATE_ADDRESS_FACTS:/etc/agentx/private-address-facts:^entries=[0-9]{1,2},opened=[0-9]{1,2},skipped=[0-9]{1,2}$"; do IFS=: read -r name file pattern <<<"$pair"; value=$(head -c 16384 "$file" 2>/dev/null || true); if [[ -n "$value" && "$value" =~ $pattern ]]; then args+=(--env "$name=$value"); fi; done; fi
if [[ "$test_services_run_dir" == true ]]; then args+=(--volume "$TEST_SERVICES_RUN_DIR:$TEST_SERVICES_RUN_DIR" --env "AGENTX_TEST_SERVICES_RUN_DIR=$TEST_SERVICES_RUN_DIR"); fi
# The opt-in TS-L self-test's result for THIS boot (stage 2 writes it under /run, which a reboot empties, so a restarted instance never reports an old one): one line of at most 3,000 characters in its one written form, else nothing.
tsl_selftest_result=$(head -c 3001 /run/agentx/tsl-selftest 2>/dev/null | tr -d '\r\n' || true)
if named_environment && [[ ${#tsl_selftest_result} -gt 0 && ${#tsl_selftest_result} -le 3000 && "$tsl_selftest_result" == '{"v":1,'* ]]; then args+=(--env "AGENTX_TEST_SERVICES_SELFTEST=$tsl_selftest_result"); fi
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

# Internal addresses a company's tasks may reach (owner decision 123). The rvbtask bridge (task sandboxes and dev containers, their builds included) and the setup-run bridges (rvbs*) are walled off from every private
# address by the container firewall (boot.sh's container firewall unit). A company admin may list EXACT internal host:port pairs (a package mirror on a private address), approved by a second admin; the control plane's
# launch hands this worker that company's list as AGENTX_PRIVATE_ADDRESSES (a worker belongs to one workspace, a workspace to one company). This step writes, root-only:
#   /etc/agentx/private-addresses     the list, only when it is well formed (anything else: nothing is opened);
#   /etc/agentx/vpc-cidrs             the install's own network, read from this instance's metadata: nothing inside it is ever opened (the model proxy, the database, the VPC resolver, the broker and other workers live there);
#   /etc/agentx/private-reserved-cidrs   the ranges private MCP servers and model endpoints own (AGENTX_PRIVATE_ADDRESS_RESERVED_CIDRS, from the launch): nothing inside them is ever opened either (review L3);
#   /etc/agentx/private-routed-cidrs  the private ranges this install routes to (AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS): an address outside them is never opened (the security group would drop it; the wall says so too);
#   /usr/local/libexec/rovara-private-allow   the step the launcher runs at EVERY start of the worker container (a boot, a worker restart, a Docker restart), before the container starts (below).
# DNS REBINDING: the firewall matches addresses, never names. At each run the step resolves each name once (the VPC resolver, the same one a sandbox asks), checks EVERY address it got (each must be a plain IPv4 private
# address outside the worker's own Docker ranges, the metadata, loopback and link-local ranges and the install's network; one bad address refuses the whole entry), and opens exactly those address:port pairs (TCP). The
# addresses stay pinned until the next run: a name that later answers with another address (a rebinding to the install's own services, say) reaches nothing new, because nothing new is open. The next run resolves
# again and drops the old pins. The pinned name=address pairs are handed to the worker (AGENTX_PRIVATE_ADDRESS_HOSTS), which gives task sandboxes and dev containers `--add-host` entries for them, so their lookups agree
# with the wall; and the counts (entries, opened, skipped) as AGENTX_PRIVATE_ADDRESS_FACTS, which the worker logs at its start.
# The rules live in a chain of their own (ROVARA-PRIVATE-ALLOW), emptied and filled again at each run, reached from DOCKER-USER for rvbtask (at the top) and for the setup bridges rvbs+ (placed right BELOW the setup
# walls block_imds puts in, so a setup sandbox's own port-53 drop still comes first; none when those walls are missing, as setup runs are then refused). Run networks (rvi*) and every other bridge get nothing. The
# chain starts with RETURN guards for the never-opened ranges, so even a wrong ACCEPT below them could not reach those. Any failure empties the chain (fail closed: nothing opened) and the worker still starts.
readonly PRIVATE_ADDRESSES_FILE=/etc/agentx/private-addresses
readonly VPC_CIDRS_FILE=/etc/agentx/vpc-cidrs
readonly RESERVED_CIDRS_FILE=/etc/agentx/private-reserved-cidrs
readonly ROUTED_CIDRS_FILE=/etc/agentx/private-routed-cidrs
write_private_addresses() {
  local value=${AGENTX_PRIVATE_ADDRESSES:-} mac cidrs="" attempt cidr_value
  local cidr_pattern='^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}(,[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}){0,39}$'
  install -d -m 0700 /etc/agentx
  rm -f "$PRIVATE_ADDRESSES_FILE" "$VPC_CIDRS_FILE" "$RESERVED_CIDRS_FILE" "$ROUTED_CIDRS_FILE"
  # The launch's reserved and routed ranges (review L3), one range per line. Fail closed: a value that is set but not well formed is written as a file with no usable range, which refuses every entry (routed) or drops the list (reserved).
  cidr_value=${AGENTX_PRIVATE_ADDRESS_RESERVED_CIDRS:-}
  if [[ -n "$cidr_value" ]]; then
    if [[ "$cidr_value" =~ $cidr_pattern ]]; then install -m 0600 /dev/null "$RESERVED_CIDRS_FILE" && printf '%s\n' "${cidr_value//,/$'\n'}" >"$RESERVED_CIDRS_FILE"; else log "the reserved ranges are not well formed; no internal address is opened"; value=""; fi
  fi
  cidr_value=${AGENTX_PRIVATE_ADDRESS_ROUTED_CIDRS:-}
  if [[ -n "$cidr_value" ]]; then
    if [[ "$cidr_value" =~ $cidr_pattern ]]; then install -m 0600 /dev/null "$ROUTED_CIDRS_FILE" && printf '%s\n' "${cidr_value//,/$'\n'}" >"$ROUTED_CIDRS_FILE"; else log "the routed ranges are not well formed; no internal address is opened"; install -m 0600 /dev/null "$ROUTED_CIDRS_FILE"; fi
  fi
  if [[ -n "$value" ]]; then
    if [[ "$value" =~ ^[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}(,[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}){0,15}$ ]]; then
      install -m 0600 /dev/null "$PRIVATE_ADDRESSES_FILE" && printf '%s\n' "$value" >"$PRIVATE_ADDRESSES_FILE"
    else
      log "the internal address list is not well formed; no internal address is opened"
    fi
  fi
  for ((attempt = 1; attempt <= 3; attempt++)); do
    mac=$(imds_once mac 2>/dev/null) && cidrs=$(imds_once "network/interfaces/macs/$mac/vpc-ipv4-cidr-blocks" 2>/dev/null) && [[ -n "$cidrs" ]] && break
    cidrs=""
  done
  if [[ -n "$cidrs" ]]; then install -m 0600 /dev/null "$VPC_CIDRS_FILE" && printf '%s\n' "$cidrs" >"$VPC_CIDRS_FILE"; else log "the install's network could not be read; no internal address is opened"; fi
  install -d -o root -g root -m 0755 /usr/local/libexec
  cat >/usr/local/libexec/rovara-private-allow <<'PRIVATEALLOW'
set -u
readonly LIST_FILE=${ROVARA_PRIVATE_ADDRESSES_FILE:-/etc/agentx/private-addresses}
readonly CIDR_FILE=${ROVARA_VPC_CIDRS_FILE:-/etc/agentx/vpc-cidrs}
readonly RESERVED_FILE=${ROVARA_PRIVATE_RESERVED_CIDRS_FILE:-/etc/agentx/private-reserved-cidrs}
readonly ROUTED_FILE=${ROVARA_PRIVATE_ROUTED_CIDRS_FILE:-/etc/agentx/private-routed-cidrs}
readonly PINS_FILE=${ROVARA_PRIVATE_ADDRESS_PINS_FILE:-/etc/agentx/private-address-pins}
readonly FACTS_FILE=${ROVARA_PRIVATE_ADDRESS_FACTS_FILE:-/etc/agentx/private-address-facts}
readonly CHAIN=ROVARA-PRIVATE-ALLOW
readonly BRIDGE=rvbtask
readonly SETUP_BRIDGES=rvbs+
readonly MAX_ADDRESSES=8
# Never opened, whatever an entry says. Keep equal to the contract (packages/cloud-contracts/src/app-private-addresses.ts); tests/contract/private-address-wall.test.ts compares the two.
readonly METADATA="169.254.169.254 169.254.169.253 169.254.169.123 169.254.170.2 169.254.170.23 100.100.100.200"
readonly NEVER="0.0.0.0/8 127.0.0.0/8 169.254.0.0/16"
readonly PRIVATE="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"
readonly WORKER="172.17.0.0/16 172.18.0.0/15 172.20.0.0/14 172.24.0.0/14 172.28.0.0/15 172.30.0.0/16 192.168.0.0/16"
log() { printf 'rovara-private-allow: %s\n' "$*" >&2; }
# The 32-bit value of four plain decimal numbers (no leading zero, each at most 255); fails for any other form.
ip_number() {
  local a b c d extra octet re='^(0|[1-9][0-9]{0,2})$'
  IFS=. read -r a b c d extra <<<"$1"
  [[ -z "${extra:-}" && "$1" != *. ]] || return 1
  for octet in "${a:-}" "${b:-}" "${c:-}" "${d:-}"; do [[ "$octet" =~ $re ]] && ((octet <= 255)) || return 1; done
  printf '%s\n' $(((a << 24) + (b << 16) + (c << 8) + d))
}
in_range() {
  local address=$1 base prefix size first
  base=$(ip_number "${2%/*}") || return 0
  prefix=${2#*/}
  [[ "$prefix" =~ ^[0-9]{1,2}$ ]] && ((prefix <= 32)) || return 0
  size=$((1 << (32 - prefix)))
  first=$((base - base % size))
  ((address >= first && address < first + size))
}
in_any() { local address=$1 range; shift; for range in "$@"; do in_range "$address" "$range" && return 0; done; return 1; }
# Why an address can never be opened (a fixed word), or nothing when it may be. No install network known: nothing may be.
refusal() {
  local address=$1 item value
  for item in $METADATA; do value=$(ip_number "$item") && ((value == address)) && { echo metadata; return; }; done
  # shellcheck disable=SC2086
  in_any "$address" $NEVER && { echo never; return; }
  # shellcheck disable=SC2086
  in_any "$address" $PRIVATE || { echo not_private; return; }
  # shellcheck disable=SC2086
  in_any "$address" $WORKER && { echo worker_network; return; }
  [[ -n "$VPC" ]] || { echo no_install_network; return; }
  # shellcheck disable=SC2086
  in_any "$address" $VPC && { echo install_network; return; }
  # Ranges private MCP servers and model endpoints own (reached through their own settings, never from a task), then the ranges this install routes to. A routed file that is there but holds no usable range allows nothing.
  # shellcheck disable=SC2086
  in_any "$address" $RESERVED && { echo reserved_range; return; }
  if [[ -n "$ROUTED_PRESENT" ]]; then
    # shellcheck disable=SC2086
    in_any "$address" $ROUTED || { echo not_routed; return; }
  fi
  return 0
}
empty_chain() { iptables -F "$CHAIN" 2>/dev/null || true; rm -f "$PINS_FILE"; }
write_facts() { printf 'entries=%s,opened=%s,skipped=%s\n' "$1" "$2" "$3" >"$FACTS_FILE.tmp" && mv -f "$FACTS_FILE.tmp" "$FACTS_FILE" || rm -f "$FACTS_FILE.tmp"; }
# The setup bridges' jump goes right below the last setup wall (block_imds's rvbs+ rules), never above one: it is taken out and put back there at each run. No setup walls: no jump (setup runs are refused then).
place_setup_jump() {
  local last
  while iptables -C DOCKER-USER -i "$SETUP_BRIDGES" -j "$CHAIN" 2>/dev/null; do iptables -D DOCKER-USER -i "$SETUP_BRIDGES" -j "$CHAIN" || return 1; done
  last=$(iptables -S DOCKER-USER 2>/dev/null | awk '/^-A DOCKER-USER / { n += 1; if (index($0, " -i rvbs+ ") > 0) last = n } END { print last + 0 }')
  ((last > 0)) || return 0
  iptables -I DOCKER-USER $((last + 1)) -i "$SETUP_BRIDGES" -j "$CHAIN"
}
VPC="" RESERVED="" ROUTED="" ROUTED_PRESENT=""
if [[ -r "$CIDR_FILE" ]]; then
  while read -r line; do [[ "$line" =~ ^[0-9.]+/[0-9]{1,2}$ ]] && VPC="$VPC $line"; done <"$CIDR_FILE"
fi
if [[ -r "$RESERVED_FILE" ]]; then
  while read -r line; do [[ "$line" =~ ^[0-9.]+/[0-9]{1,2}$ ]] && RESERVED="$RESERVED $line"; done <"$RESERVED_FILE"
fi
if [[ -e "$ROUTED_FILE" ]]; then
  ROUTED_PRESENT=1
  # A routed range must parse: `in_range` treats a range that does not parse as containing everything (right for the guards, which then refuse), which would let every address through here.
  [[ -r "$ROUTED_FILE" ]] && while read -r line; do [[ "$line" =~ ^[0-9.]+/[0-9]{1,2}$ ]] && ip_number "${line%/*}" >/dev/null && ((${line#*/} <= 32)) && ROUTED="$ROUTED $line"; done <"$ROUTED_FILE"
fi
rm -f "$PINS_FILE"
write_facts 0 0 0
iptables -N "$CHAIN" 2>/dev/null || iptables -S "$CHAIN" >/dev/null 2>&1 || { log "could not make the chain"; exit 1; }
iptables -F "$CHAIN" || { log "could not empty the chain"; exit 1; }
iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -i "$BRIDGE" -j "$CHAIN" || { log "could not reach the chain from DOCKER-USER"; exit 1; }
place_setup_jump || { empty_chain; log "could not reach the chain from the setup bridges; nothing opened"; exit 1; }
[[ -r "$LIST_FILE" ]] || exit 0
list=$(head -c 2048 "$LIST_FILE")
[[ "$list" =~ ^[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}(,[a-z0-9.-]{1,94}:[1-9][0-9]{0,4}){0,15}$ ]] || { log "the list is not well formed; nothing opened"; exit 1; }
# Guards first: nothing below them can open these.
# shellcheck disable=SC2086
for range in $NEVER $WORKER $VPC $RESERVED; do iptables -A "$CHAIN" -d "$range" -j RETURN || { empty_chain; log "could not add a guard"; exit 1; }; done
index=0 opened=0 skipped=0 pins=""
IFS=, read -r -a entries <<<"$list"
for entry in "${entries[@]}"; do
  index=$((index + 1))
  host=${entry%:*} port=${entry##*:}
  ((port >= 1 && port <= 65535)) || { log "entry $index: the port is not valid; skipped"; skipped=$((skipped + 1)); continue; }
  # DNS is never opened (a task could ask any internal resolver, around the install's DNS firewall); the contract refuses it too.
  ((port != 53)) || { log "entry $index: port 53 (DNS) is never opened; skipped"; skipped=$((skipped + 1)); continue; }
  name=""
  if ip_number "$host" >/dev/null; then
    addresses=$host
  elif [[ "${host##*.}" =~ ^(0x[0-9a-f]*|[0-9]+)$ ]]; then
    # A name whose last label is a number reads as an address to some resolvers (`167772161`, `012.0.0.1`, `0x0a.0.0.1`, `nexus.1`); only the plain four-number form is an address here.
    log "entry $index: not a plain IPv4 address; skipped"; skipped=$((skipped + 1)); continue
  else
    name=$host
    addresses=$(getent ahostsv4 -- "$host" 2>/dev/null | awk '{ print $1 }' | sort -u | head -n $((MAX_ADDRESSES + 1)))
  fi
  [[ -n "$addresses" ]] || { log "entry $index: did not resolve; skipped"; skipped=$((skipped + 1)); continue; }
  count=$(printf '%s\n' "$addresses" | wc -l | tr -d ' ')
  ((count <= MAX_ADDRESSES)) || { log "entry $index: resolves to more than $MAX_ADDRESSES addresses; skipped"; skipped=$((skipped + 1)); continue; }
  # Every address the name gave must pass, or the entry opens nothing.
  bad=""
  for address in $addresses; do
    value=$(ip_number "$address") || { bad=ip_form; break; }
    why=$(refusal "$value")
    [[ -z "$why" ]] || { bad=$why; break; }
  done
  [[ -z "$bad" ]] || { log "entry $index: resolves to an address that is never opened ($bad); skipped"; skipped=$((skipped + 1)); continue; }
  for address in $addresses; do
    iptables -A "$CHAIN" -d "$address/32" -p tcp --dport "$port" -j ACCEPT || { empty_chain; write_facts "${#entries[@]}" 0 "${#entries[@]}"; log "could not open entry $index; nothing opened"; exit 1; }
    [[ -z "$name" ]] || pins="${pins:+$pins,}$name=$address"
  done
  opened=$((opened + 1))
done
if [[ -n "$pins" ]]; then (umask 077 && printf '%s\n' "$pins" >"$PINS_FILE.tmp" && mv -f "$PINS_FILE.tmp" "$PINS_FILE") || rm -f "$PINS_FILE.tmp" "$PINS_FILE"; fi
write_facts "${#entries[@]}" "$opened" "$skipped"
log "opened $opened of ${#entries[@]} entries ($skipped skipped)"
exit 0
PRIVATEALLOW
  chmod 0755 /usr/local/libexec/rovara-private-allow
}

# TS-L worker self-test (OPT-IN, staging only; the release gate's five conditions, session 89, and the Opus review of 2026-11-12). Runs the SAME checks CI runs (scripts/linux-check-test-services.sh and its live driver, carried in a STAGING-flavor
# worker image under /opt/agentx/packages/worker/ec2/tsl) on this real worker, as root, AFTER the worker's walls are all in place and BEFORE the worker unit is started, and reports the result through the worker's own start report (`worker_start`,
# key `selfTest`, packages/worker/src/test-services-selftest.ts). The conditions:
#   1. OFF BY DEFAULT. It runs only when the launch environment carries AGENTX_TSL_SELFTEST=1 (a launch field; see the M1 note in packages/worker/ec2/README.md for how a staging launch would set it). Even then it refuses unless ALL of these hold,
#      each one a thing the launch cannot fake: a NAMED environment whose name, cut from the launch's log group, is exactly `staging`; the worker image's own build flavor is `staging` (the file the image builds with `CATALOG_FLAVOR=staging`
#      says so; a release image does not even carry the checks); and the registry account of the worker image and the account in the instance identity document are both the staging account. Anything else records `refused` and runs nothing.
#   2. NEVER BLOCKS THE BOOT. The WHOLE self-test (the checks, the extra read-only pass, every clean-up and read-back) ends before the boot deadline: it starts only when at least 45 s of checks plus TSL_RESERVE_S (150 s, for the clean-up) fit before
#      BOOT_DEADLINE, else it records `incomplete: no_time` and does nothing; the checks run under one timeout that kills the process group, and every Docker command is bounded. Past its hard deadline no Docker command runs, so what is left cannot
#      be read back (condition 3). The worker's own walls, units and settings are never written by it: the checks only read the firewall, and everything they make carries a fixed label.
#   3. CLEAN-UP IS PROVEN BEFORE THE WORKER TAKES WORK. After the checks (and after a timeout) every container, network, volume, bridge and rule they made is removed and READ BACK as gone: no labelled object; the same iptables and ip6tables rules in
#      EVERY table (filter, nat, mangle, raw), nft ruleset, routes, ip rules and interfaces as before, compared IN ORDER; no scratch directory. The read-back is polled (about 15 s) between two clean-up rounds, so a bridge that goes a moment late is
#      not a failure. If it still fails the boot FAILS (`fail`: the provisioner stops the session) before the worker unit is started. Docker's data root is on the workspace volume, so a failed clean-up would reach the next launch: therefore EVERY named
#      boot, with the self-test off or on, first removes whatever carries the self-test's two fixed labels (below) and reads that back, and fails the boot if it cannot (tsl_sweep_leftovers).
#   4. FIXED OUTPUT. The result is built only from fixed words (TSL_STATES, TSL_REASONS, the item ids) and the four identity values, each checked against its pattern (AMI id, boot-stage2 SHA-256, Docker version, instance id). No command output,
#      host name or address is ever copied. At most 3,000 characters (the worker_start line is one log event). The worker checks the same shape (parseSelfTest). The result is written under /run (a reboot empties it) and the worker's launcher
#      passes it only when it is there, so a restarted instance never reports an old result. `unusable` is recorded there but the boot has failed, so no worker_start ever carries it: the BootFailed reason does.
#   5. THE ITEM IDS ARE CI'S: the script CI runs gives them (TSL_ITEM_IDS), and a contract test holds this list equal to the script's, to scripts/ci-test-services-linux.sh's LIVE_IDS and to the worker's list. `L3.egress-capture` (CI's optional tcpdump
#      line) is always `pending`. TS-RUN-3's Redis flush and http_reset are two EXTRA ids, in their own `extra` list (`extra.redis-flush`, `extra.http-reset`), always pending: no live driver case, and no Redis digest is pinned (`no_pin`). The driver pulls
#      ONLY the pinned Postgres image, by digest, with the worker role's existing catalog grant (TS-IMG-1).
# Two fixed labels mark everything it makes: rovara.tsl-selftest=1 (what this script and the checker create: the bundle container, the working sandbox's network, every driver container) and the throwaway workspace key
# rovara.run-network.workspace=7e57c4ec7e57c4ec (what the driver's run modules create: run networks, helpers, probes).
readonly TSL_SELFTEST_VARIABLE=AGENTX_TSL_SELFTEST
readonly TSL_RESULT_VARIABLE=AGENTX_TEST_SERVICES_SELFTEST
readonly TSL_RESULT_FILE=/run/agentx/tsl-selftest
readonly TSL_LAUNCHER=/usr/local/libexec/agentx-worker-start
readonly TSL_ALLOWED_ENVIRONMENT=staging
readonly TSL_ALLOWED_ACCOUNT=944937319445
readonly TSL_FLAVOR_FILE=/opt/agentx/packages/cloud-contracts/dist/catalog-build-flavor.js
readonly TSL_BUNDLE_DIR=/opt/agentx/packages/worker/ec2/tsl
readonly TSL_CATALOG_DIR=/opt/agentx/packages/worker/service-catalog
readonly TSL_WORKSPACE_KEY=7e57c4ec7e57c4ec
readonly TSL_FAMILY_LABEL=rovara.run-network
readonly TSL_DRIVER_LABEL=rovara.tsl-selftest
readonly TSL_TASK_NETWORK=agentx-task
readonly TSL_TASK_BRIDGE=rvbtask
readonly TSL_RESULT_MAX_CHARS=3000
# Seconds kept back for everything after the checks: the host-only pass, two clean-up rounds, the settle polls and the read-backs.
readonly TSL_RESERVE_S=150
# Seconds of its hard deadline that must be left for the extra read-only pass after a timeout (30 s of checks, its kill grace, and the clean-up that follows it); with less, every item is `incomplete: no_time`.
readonly TSL_HOST_PASS_NEEDS_S=90
# Seconds of the hard deadline kept for what follows the checks (the clean-up rounds and the read-backs, besides the extra pass above); the checks never run into them, however long the steps before them took.
readonly TSL_AFTER_CHECKS_S=100
readonly TSL_STATES="ran refused incomplete unusable"
readonly TSL_STATUSES="pass fail pending incomplete"
readonly TSL_REASONS="ok not_named not_staging wrong_account not_staging_image budget no_time docker_unavailable walls_failed bundle_missing snapshot_failed cleanup_failed too_large check_failed later_slice no_run_network no_pull_grant pull_failed no_pin no_capture live_not_run no_result catalog_untrusted driver_error"
# The ids scripts/linux-check-test-services.sh prints, in its order of first mention (held equal to the script's by a test), the ones its live driver gives, the one CI id that is always pending here, and the two extras.
readonly TSL_ITEM_IDS="L1.walls L1.isolation L1.docker-version L1.iptables-backend L1.internal-drops L1.live L1.live-other-run L1.range L1.pools L2.egress-network L2.live L3.live L3.embedded-resolver L3.embedded-resolver-blocked L3.working-relay L3.ipv6 L3.no-route L3.other-run L3.multicast L3.run-files L3.spoofing L4.live L4.template-db L5.walls L5.live L6.no-leftovers L6.live L7.host L7.live L8.no-socket L8.live"
readonly TSL_LIVE_IDS="L1.live L1.live-other-run L2.live L3.live L3.embedded-resolver L3.embedded-resolver-blocked L3.working-relay L3.ipv6 L3.no-route L3.other-run L3.multicast L3.run-files L3.spoofing L4.live L4.template-db L6.live"
readonly TSL_PENDING_IDS="L3.egress-capture"
readonly TSL_EXTRA_IDS="extra.redis-flush extra.http-reset"
TSL_GATE=off; TSL_GATE_REASON=""; TSL_ENVIRONMENT=""; TSL_RESULTS=""; TSL_DIFF=""
TSL_AMI=unknown; TSL_BOOT2=unknown; TSL_DOCKER=unknown; TSL_INSTANCE=unknown
TSL_WORK_DIR=""; TSL_SNAPSHOT_BEFORE=""; TSL_IMAGES_BEFORE=""; TSL_HARD_DEADLINE=""
# Every Docker command of the self-test is bounded: a hung daemon costs one timeout (TSL_COMMAND_TIMEOUT_S, 1 to 999 s, default 15), not the boot. And the whole self-test is bounded: past TSL_HARD_DEADLINE (set when it starts; never later than
# the boot deadline) no Docker command is run at all. What could not be cleaned up then cannot be read back either, and the worker is stopped (condition 3) instead of left hanging.
tsl_past_deadline() { [[ -n "${TSL_HARD_DEADLINE:-}" ]] && ((SECONDS >= TSL_HARD_DEADLINE)); }
tsl_dk() {
  local limit=${TSL_COMMAND_TIMEOUT_S:-15}
  [[ "$limit" =~ ^[0-9]{1,3}$ ]] && ((10#$limit >= 1)) || limit=15
  ! tsl_past_deadline || return 124
  timeout --foreground --kill-after=5s "$((10#$limit))s" docker "$@"
}
# The opt-in gate. Sets TSL_GATE to off (nothing at all happens and nothing is recorded), refused (recorded, nothing runs) or on.
tsl_selftest_gate() {
  TSL_GATE=off; TSL_GATE_REASON=""; TSL_ENVIRONMENT=""
  [[ "${AGENTX_TSL_SELFTEST:-}" == 1 ]] || return 0
  if [[ "${AGENTX_LOG_GROUP:-}" =~ ^/agentx/([a-z][a-z0-9-]{0,19})/worker$ ]]; then TSL_ENVIRONMENT=${BASH_REMATCH[1]}; fi
  if [[ "${AGENTX_ENVIRONMENT_KIND:-}" != named ]]; then TSL_GATE=refused; TSL_GATE_REASON=not_named; return 0; fi
  if [[ "$TSL_ENVIRONMENT" != "$TSL_ALLOWED_ENVIRONMENT" ]]; then TSL_GATE=refused; TSL_GATE_REASON=not_staging; return 0; fi
  TSL_GATE=on
}
# The account: the registry account of the worker image AND the account in the instance identity document (IMDSv2) must both be the staging account. An identity document that cannot be read is a refusal, never a pass.
tsl_account_ok() {
  local registry=${AGENTX_WORKER_IMAGE:-} token doc account
  registry=${registry%%/*}
  [[ "${registry%%.*}" == "$TSL_ALLOWED_ACCOUNT" ]] || return 1
  token=$(curl -fsS --connect-timeout 2 --max-time 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null) || return 1
  doc=$(curl -fsS --connect-timeout 2 --max-time 3 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/dynamic/instance-identity/document 2>/dev/null) || return 1
  account=$(printf '%s' "$doc" | sed -n 's/.*"accountId" *: *"\([0-9]\{12\}\)".*/\1/p' | head -n1)
  [[ "$account" == "$TSL_ALLOWED_ACCOUNT" ]]
}
# The four identity values, each only in its one written form, else `unknown`: AMI id (instance metadata), boot-stage2 SHA-256 (the launch's, which boot.sh already checked against the file it sourced), Docker version, instance id.
tsl_identity() {
  local ami="" version=""
  TSL_AMI=unknown; TSL_BOOT2=unknown; TSL_DOCKER=unknown; TSL_INSTANCE=unknown
  if declare -F imds_once >/dev/null; then ami=$(imds_once ami-id 2>/dev/null | head -n1) || ami=""; fi
  [[ "$ami" =~ ^ami-[0-9a-f]{8,17}$ ]] && TSL_AMI=$ami
  [[ "${AGENTX_BOOT_STAGE2_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] && TSL_BOOT2=$AGENTX_BOOT_STAGE2_SHA256
  version=$(tsl_dk version --format '{{.Server.Version}}' 2>/dev/null | head -n1) || version=""
  [[ "$version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){0,3}(-[a-z0-9.]{1,12})?$ ]] && TSL_DOCKER=$version
  [[ "${1:-}" =~ ^i-[0-9a-f]{8,17}$ ]] && TSL_INSTANCE=$1
  return 0
}
# Seconds the CHECKS may run: TSL_SELFTEST_BUDGET_S (30 to 300, default 170), and never so long that the checks plus TSL_RESERVE_S end after the boot deadline. May be under 45 or negative: the caller then does not start.
tsl_budget_seconds() {
  local want=${TSL_SELFTEST_BUDGET_S:-170} left
  if [[ "$want" =~ ^[0-9]{2,3}$ ]] && ((10#$want >= 30 && 10#$want <= 300)); then want=$((10#$want)); else want=170; fi
  left=$(( ${BOOT_DEADLINE:-$((SECONDS + 100000))} - SECONDS - TSL_RESERVE_S ))
  ((left >= want)) || want=$left
  printf '%s\n' "$want"
}
# What the host looks like, as text IN ORDER (never sorted: a rule moved below an ACCEPT is a different firewall): every table of iptables (filter, nat, mangle, raw) and, where it is usable, ip6tables; the nft ruleset (stateless) when nft is
# there; routes of every table, ip rules and the interface names. Fails (returns 1) when anything that should be readable was not: an unread table proves nothing.
tsl_snapshot() {
  local out=$1 table text tool
  tsl_past_deadline && return 1
  : >"$out" || return 1
  for tool in iptables ip6tables; do
    if [[ "$tool" == ip6tables ]] && ! { command -v ip6tables >/dev/null 2>&1 && ip6tables -S INPUT >/dev/null 2>&1; }; then continue; fi
    for table in filter nat mangle raw; do
      # filter and nat must be readable; a table the kernel does not have (raw and mangle are loaded on demand) cannot hold a rule, and is recorded as such (the same before and after, unless a leftover loaded it).
      text=$(timeout --kill-after=3s 10s "$tool" -t "$table" -S 2>/dev/null) || { if [[ "$table" == filter || ( "$tool" == iptables && "$table" == nat ) ]]; then return 1; fi; text=unreadable; }
      printf '%s\n' "$text" | sed "s/^/$tool:$table /" >>"$out"
    done
  done
  if command -v nft >/dev/null 2>&1; then
    text=$(timeout --kill-after=3s 10s nft -s list ruleset 2>/dev/null) || return 1
    printf '%s\n' "$text" | sed 's/^/nft /' >>"$out"
  fi
  text=$(timeout --kill-after=3s 10s ip -4 route show table all 2>/dev/null) || return 1
  printf '%s\n' "$text" | sed 's/^/route4 /' >>"$out"
  text=$(timeout --kill-after=3s 10s ip -6 route show table all 2>/dev/null) || text=""
  printf '%s\n' "$text" | sed 's/^/route6 /' >>"$out"
  text=$(timeout --kill-after=3s 10s ip rule show 2>/dev/null) || return 1
  printf '%s\n' "$text" | sed 's/^/rule /' >>"$out"
  text=$(timeout --kill-after=3s 10s ip -o link show 2>/dev/null) || return 1
  printf '%s\n' "$text" | awk '{ n = $2; sub(/@.*/, "", n); sub(/:$/, "", n); print "link " n }' >>"$out"
}
# Removes the Docker OBJECTS the self-test made: containers (and their anonymous volumes), networks and volumes carrying either fixed label. Best effort; the looks below decide. Safe to run twice, and on a volume a failed self-test left behind.
tsl_remove_objects() {
  local filter ids
  for filter in "label=$TSL_DRIVER_LABEL=1" "label=$TSL_FAMILY_LABEL.workspace=$TSL_WORKSPACE_KEY"; do
    ids=$(tsl_dk ps -a -q --filter "$filter" 2>/dev/null) || ids=""
    # shellcheck disable=SC2086
    [[ -z "$ids" ]] || tsl_dk rm -f -v $ids >/dev/null 2>&1 || true
  done
  for filter in "label=$TSL_DRIVER_LABEL=1" "label=$TSL_FAMILY_LABEL.workspace=$TSL_WORKSPACE_KEY"; do
    ids=$(tsl_dk network ls -q --filter "$filter" 2>/dev/null) || ids=""
    # shellcheck disable=SC2086
    [[ -z "$ids" ]] || tsl_dk network rm $ids >/dev/null 2>&1 || true
    ids=$(tsl_dk volume ls -q --filter "$filter" 2>/dev/null) || ids=""
    # shellcheck disable=SC2086
    [[ -z "$ids" ]] || tsl_dk volume rm -f $ids >/dev/null 2>&1 || true
  done
  return 0
}
# The looks at those objects: returns 0 only when none is left and every look answered. A look that fails is NOT gone. Sets TSL_DIFF to the part that was not gone (a fixed word, for the log).
tsl_objects_gone() {
  local filter ids
  TSL_DIFF=""
  for filter in "label=$TSL_DRIVER_LABEL=1" "label=$TSL_FAMILY_LABEL.workspace=$TSL_WORKSPACE_KEY"; do
    ids=$(tsl_dk ps -a -q --filter "$filter" 2>/dev/null) || { TSL_DIFF=docker; return 1; }
    [[ -z "$ids" ]] || { TSL_DIFF=containers; return 1; }
    ids=$(tsl_dk network ls -q --filter "$filter" 2>/dev/null) || { TSL_DIFF=docker; return 1; }
    [[ -z "$ids" ]] || { TSL_DIFF=networks; return 1; }
    ids=$(tsl_dk volume ls -q --filter "$filter" 2>/dev/null) || { TSL_DIFF=docker; return 1; }
    [[ -z "$ids" ]] || { TSL_DIFF=volumes; return 1; }
  done
  return 0
}
# EVERY named boot, before anything else and whether or not the self-test is on: Docker's data root is on the workspace volume, so a self-test that failed its clean-up on an earlier instance would otherwise reach this launch. Removes what carries
# the fixed labels, reads it back (one settle and retry), and returns 1 when it cannot, so the boot fails before any customer task can meet it.
tsl_sweep_leftovers() {
  TSL_HARD_DEADLINE=""
  tsl_remove_objects
  tsl_objects_gone && return 0
  sleep 2
  tsl_remove_objects
  if tsl_objects_gone; then return 0; fi
  log "TS-L self-test leftovers could not be removed from the workspace volume ($TSL_DIFF)"
  return 1
}
# Removes everything the self-test made: the objects (above), images the checks pulled (the pinned Postgres, and nothing that was here before them) and scratch directories; KEEP names one scratch directory to leave for now.
tsl_cleanup() {
  local keep=${1:-} ids id after dir
  tsl_remove_objects
  if [[ -n "$TSL_IMAGES_BEFORE" && -s "$TSL_IMAGES_BEFORE" ]]; then
    after=$(tsl_dk image ls -q --no-trunc 2>/dev/null | LC_ALL=C sort -u) || after=""
    for id in $after; do grep -qx -- "$id" "$TSL_IMAGES_BEFORE" 2>/dev/null || tsl_dk image rm -f "$id" >/dev/null 2>&1 || true; done
  fi
  for dir in /var/tmp/tsl.* /var/tmp/tsl-work.* /var/tmp/tsl-docker.*; do [[ ! -e "$dir" || "$dir" == "$keep" ]] || rm -rf "$dir" 2>/dev/null || true; done
  return 0
}
# THE READ-BACK (condition 3): returns 0 only when every look says gone and the host looks as it did (same text, in order). A look that fails is NOT gone. Sets TSL_DIFF (containers, networks, volumes, docker, rules, routes, links, dirs).
tsl_readback() {
  local after dir first
  tsl_objects_gone || return 1
  after=$(mktemp) || { TSL_DIFF=dirs; return 1; }
  if ! tsl_snapshot "$after"; then rm -f "$after"; TSL_DIFF=rules; return 1; fi
  if ! cmp -s "$TSL_SNAPSHOT_BEFORE" "$after"; then
    first=$(diff "$TSL_SNAPSHOT_BEFORE" "$after" | awk '/^[<>]/ { print $2; exit }')
    case "$first" in link) TSL_DIFF=links ;; route4|route6|rule) TSL_DIFF=routes ;; *) TSL_DIFF=rules ;; esac
    rm -f "$after"; return 1
  fi
  rm -f "$after"
  for dir in /var/tmp/tsl.* /var/tmp/tsl-work.* /var/tmp/tsl-docker.*; do [[ ! -e "$dir" ]] || { TSL_DIFF=dirs; return 1; }; done
  return 0
}
# The read-back, polled for about 15 s (1 s apart): a bridge, a veth or a rule that goes a moment after its network is removed is not a failure. Fails only when it is still not gone at the end or the hard deadline has passed.
tsl_readback_settled() {
  local tries=${TSL_SETTLE_TRIES:-15} i
  [[ "$tries" =~ ^[0-9]{1,2}$ ]] && ((10#$tries >= 1)) || tries=15
  for ((i = 1; i <= 10#$tries; i++)); do
    tsl_readback && return 0
    tsl_past_deadline && return 1
    ((i == 10#$tries)) || sleep 1
  done
  return 1
}
# Records one item. Only fixed words are ever stored: the encoder checks them again.
tsl_item() { TSL_RESULTS="${TSL_RESULTS}$1 $2 $3"$'\n'; }
tsl_pending_reason() { # tsl_pending_reason <id>: why an item the script printed as PENDING is pending
  case "$1" in
    L1.internal-drops) printf 'no_run_network' ;;
    L5.live|L7.live|L8.live) printf 'later_slice' ;;
    *) if [[ " $TSL_LIVE_IDS " == *" $1 "* ]]; then printf 'live_not_run'; else printf 'later_slice'; fi ;;
  esac
}
# Turns the checker's output file into fixed-word items. MODE is `live` (the run finished), `timeout` (it did not: the host-only pass's lines for the host items, `incomplete: budget` for the driver's) or `none` (no time was left for even the host-only
# pass: every item is `incomplete: no_time`). Nothing of the output is copied: only the status word of the LAST line for each item id (a raw driver line the checker echoed cannot override its own verdict, which comes later), and the presence of the
# ERROR and BLOCKED lines, are read. A pull that failed at the login or the manifest read is `no_pull_grant`; one that failed at the pull itself is `pull_failed` (the checker hides the registry's words, so a grant that does not cover the repositories
# looks like either).
tsl_classify() {
  local out=$1 mode=$2 id status auth_failed=no pull_failed=no blocked=no errored=no
  grep -Eq '^TSL ERROR (the registry login failed|the manifest of )' "$out" 2>/dev/null && auth_failed=yes
  grep -Eq '^TSL ERROR the pull of ' "$out" 2>/dev/null && pull_failed=yes
  grep -Eq '^TSL BLOCKED' "$out" 2>/dev/null && blocked=yes
  grep -Eq '^TSL ERROR' "$out" 2>/dev/null && errored=yes
  for id in $TSL_ITEM_IDS; do
    if [[ "$mode" == none ]]; then tsl_item "$id" incomplete no_time; continue; fi
    if [[ "$mode" == timeout && " $TSL_LIVE_IDS " == *" $id "* ]]; then tsl_item "$id" incomplete budget; continue; fi
    status=$(awk -v id="$id" 'index($0, "TSL ") == 1 && $1 == "TSL" && $2 == id && ($3 == "PASS" || $3 == "FAIL" || $3 == "PENDING") { s = $3 } END { print s }' "$out" 2>/dev/null) || status=""
    case "$status" in
      PASS) tsl_item "$id" pass ok ;;
      FAIL)
        if [[ " $TSL_LIVE_IDS " == *" $id "* && $blocked == yes ]]; then tsl_item "$id" fail catalog_untrusted
        elif [[ " $TSL_LIVE_IDS " == *" $id "* && $auth_failed == yes ]]; then tsl_item "$id" pending no_pull_grant
        elif [[ " $TSL_LIVE_IDS " == *" $id "* && $pull_failed == yes ]]; then tsl_item "$id" pending pull_failed
        elif [[ " $TSL_LIVE_IDS " == *" $id "* && $errored == yes ]]; then tsl_item "$id" fail driver_error
        else tsl_item "$id" fail check_failed; fi ;;
      PENDING) tsl_item "$id" pending "$(tsl_pending_reason "$id")" ;;
      *) tsl_item "$id" incomplete no_result ;;
    esac
  done
  tsl_item L3.egress-capture pending no_capture
  tsl_item extra.redis-flush pending no_pin
  tsl_item extra.http-reset pending later_slice
}
# The result as ONE line of JSON, from fixed words only: `items` are CI's ids, `extra` the extras. Prints nothing and returns 1 when it would not fit TSL_RESULT_MAX_CHARS or a word is not in its list; the caller then records
# `incomplete: too_large` without items.
tsl_encode() { # tsl_encode <state> <reason> <seconds>
  local state=$1 reason=$2 seconds=$3 items="" extra="" id status why text
  [[ " $TSL_STATES " == *" $state "* && " $TSL_REASONS " == *" $reason "* && "$seconds" =~ ^[0-9]{1,4}$ ]] || return 1
  while read -r id status why; do
    [[ -n "$id" ]] || continue
    [[ " $TSL_STATUSES " == *" $status "* && " $TSL_REASONS " == *" $why "* ]] || return 1
    if [[ " $TSL_ITEM_IDS $TSL_PENDING_IDS " == *" $id "* ]]; then items="${items:+$items,}\"$id:$status:$why\""
    elif [[ " $TSL_EXTRA_IDS " == *" $id "* ]]; then extra="${extra:+$extra,}\"$id:$status:$why\""
    else return 1; fi
  done <<<"$TSL_RESULTS"
  printf -v text '{"v":1,"state":"%s","reason":"%s","ami":"%s","boot2":"%s","docker":"%s","instance":"%s","secs":%s,"items":[%s],"extra":[%s]}' "$state" "$reason" "$TSL_AMI" "$TSL_BOOT2" "$TSL_DOCKER" "$TSL_INSTANCE" "$seconds" "$items" "$extra"
  ((${#text} <= TSL_RESULT_MAX_CHARS)) || return 1
  printf '%s\n' "$text"
}
# Writes the result to TSL_RESULT_FILE (under /run: a reboot empties it; the worker's launcher passes it to the worker when it is there, so no old result is ever reported). Never fatal.
tsl_record() { # tsl_record <state> <reason> <seconds>
  local line
  line=$(tsl_encode "$1" "$2" "$3") || { TSL_RESULTS=""; line=$(tsl_encode incomplete too_large "$3") || return 0; }
  install -d -m 0700 "$(dirname "$TSL_RESULT_FILE")" 2>/dev/null || true
  printf '%s\n' "$line" >"$TSL_RESULT_FILE" 2>/dev/null || true
  log "TS-L self-test: $1 ($2)"
  return 0
}
# Runs the checker script from the bundle directory: `live` with the driver delivered (TSL_DIR), `host` without it. One timeout, whole process group.
tsl_run_checks() { # tsl_run_checks <live|host> <seconds> <dir> <out>
  local mode=$1 seconds=$2 dir=$3 out=$4
  if [[ "$mode" == live ]]; then
    TSL_DIR=$dir TSL_ENV=$TSL_ENVIRONMENT timeout --kill-after=10s "${seconds}s" bash "$dir/s.sh" >"$out" 2>/dev/null
  else
    env -u TSL_DIR -u TSL_LIVE_OUT_FILE TSL_ENV=$TSL_ENVIRONMENT timeout --kill-after=10s "${seconds}s" bash "$dir/s.sh" >"$out" 2>/dev/null
  fi
}
# The image's build flavor, then the checker, its driver and the catalog, out of the worker image the boot already pulled (by digest), into a root-owned scratch directory. Returns 0 (all there), 1 (the bundle is not in the image) or 2 (the
# image is not a staging build: the caller refuses). A release image carries no bundle at all.
tsl_extract_bundle() {
  local dir=$1 image=${AGENTX_WORKER_IMAGE:-} id
  [[ "$image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || return 1
  id=$(tsl_dk create --label "$TSL_DRIVER_LABEL=1" "$image" 2>/dev/null) || return 1
  [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  if ! tsl_dk cp "$id:$TSL_FLAVOR_FILE" "$dir/flavor.js" >/dev/null 2>&1 || ! grep -Fq 'CATALOG_BUILD_FLAVOR = "staging";' "$dir/flavor.js"; then
    tsl_dk rm -f "$id" >/dev/null 2>&1 || true
    return 2
  fi
  if tsl_dk cp "$id:$TSL_BUNDLE_DIR/checks.sh" "$dir/s.sh" >/dev/null 2>&1 && tsl_dk cp "$id:$TSL_BUNDLE_DIR/live.mjs" "$dir/live.mjs" >/dev/null 2>&1 \
    && tsl_dk cp "$id:$TSL_CATALOG_DIR/catalog.json" "$dir/catalog.json" >/dev/null 2>&1; then
    tsl_dk cp "$id:$TSL_CATALOG_DIR/catalog.sig.json" "$dir/catalog.sig.json" >/dev/null 2>&1 || true
  fi
  tsl_dk rm -f "$id" >/dev/null 2>&1 || true
  [[ -s "$dir/s.sh" && -s "$dir/live.mjs" && -s "$dir/catalog.json" ]] || return 1
  chmod 0755 "$dir" && chmod 0444 "$dir"/* 2>/dev/null || true
  return 0
}
# Ends the self-test early: cleans up, proves it, records. Returns 0, or 75 when the read-back fails.
tsl_finish_early() { # tsl_finish_early <state> <reason> <started>
  tsl_cleanup
  tsl_readback_settled || { sleep 2; tsl_cleanup; tsl_readback_settled; } || {
    log "TS-L self-test: the clean-up could not be read back ($TSL_DIFF)"
    rm -f "$TSL_SNAPSHOT_BEFORE" "$TSL_IMAGES_BEFORE"; tsl_record unusable cleanup_failed $((SECONDS - $3)); return 75
  }
  rm -f "$TSL_SNAPSHOT_BEFORE" "$TSL_IMAGES_BEFORE"
  tsl_record "$1" "$2" $((SECONDS - $3))
  return 0
}
# The whole self-test. Returns 0 always, EXCEPT 75: the read-back failed twice and this worker must not take work (the caller fails the boot).
run_tsl_selftest() {
  local instance_id=${1:-} started=$SECONDS budget out="" host_out="" rc=0 mode=live images extract_rc=0 run_s
  TSL_RESULTS=""; TSL_WORK_DIR=""; TSL_SNAPSHOT_BEFORE=""; TSL_IMAGES_BEFORE=""; TSL_HARD_DEADLINE=""
  tsl_selftest_gate
  [[ "$TSL_GATE" != off ]] || return 0
  tsl_identity "$instance_id"
  if [[ "$TSL_GATE" == refused ]]; then tsl_record refused "$TSL_GATE_REASON" 0; return 0; fi
  if ! tsl_account_ok; then tsl_record refused wrong_account 0; return 0; fi
  budget=$(tsl_budget_seconds)
  if ((budget < 45)); then tsl_record incomplete no_time 0; return 0; fi
  TSL_HARD_DEADLINE=$((SECONDS + budget + TSL_RESERVE_S))
  if ! tsl_dk version --format '{{.Server.Version}}' >/dev/null 2>&1; then tsl_record incomplete docker_unavailable 0; return 0; fi
  # The launcher's own wall steps (the metadata block, the setup walls, the internal-address chain: idempotent, run at every start of the worker too) go in FIRST, so the checks run against the firewall the tasks will get and the "before"
  # snapshot already holds those rules. If they cannot be applied the worker could not start either: nothing is run.
  if ! timeout --kill-after=5s 60s "$TSL_LAUNCHER" --walls-only >/dev/null 2>&1; then tsl_record incomplete walls_failed 0; return 0; fi
  TSL_SNAPSHOT_BEFORE=$(mktemp) && TSL_IMAGES_BEFORE=$(mktemp) && TSL_WORK_DIR=$(mktemp -d /var/tmp/tsl.XXXXXX) && out=$(mktemp) && host_out=$(mktemp) || { rm -rf "${TSL_SNAPSHOT_BEFORE:-}" "${TSL_IMAGES_BEFORE:-}" "${TSL_WORK_DIR:-}"; tsl_record incomplete snapshot_failed 0; return 0; }
  if ! tsl_snapshot "$TSL_SNAPSHOT_BEFORE" || ! images=$(tsl_dk image ls -q --no-trunc 2>/dev/null) || ! printf '%s\n' "$images" | LC_ALL=C sort -u >"$TSL_IMAGES_BEFORE" || [[ ! -s "$TSL_IMAGES_BEFORE" ]]; then
    rm -rf "$TSL_SNAPSHOT_BEFORE" "$TSL_IMAGES_BEFORE" "$TSL_WORK_DIR" "$out" "$host_out"; tsl_record incomplete snapshot_failed 0; return 0
  fi
  tsl_extract_bundle "$TSL_WORK_DIR" || extract_rc=$?
  if ((extract_rc != 0)); then
    rm -f "$out" "$host_out"
    if ((extract_rc == 2)); then tsl_finish_early refused not_staging_image "$started"; return $?; fi
    tsl_finish_early incomplete bundle_missing "$started"; return $?
  fi
  # The working sandbox's network (L2) is the worker's to make at its first task; the driver needs it now, made the way the worker makes it (task-network.ts) plus the fixed label, so the clean-up finds it even if the create timed out.
  if [[ -z "$(tsl_dk network ls -q --filter "name=^$TSL_TASK_NETWORK\$" 2>/dev/null)" ]]; then
    tsl_dk network create --driver bridge --opt "com.docker.network.bridge.name=$TSL_TASK_BRIDGE" --opt com.docker.network.bridge.enable_icc=false --label "$TSL_DRIVER_LABEL=1" "$TSL_TASK_NETWORK" >/dev/null 2>&1 || true
  fi
  # The steps above took time too: the checks run for at most what is left of the hard deadline less what follows them, never longer than the budget.
  run_s=$((TSL_HARD_DEADLINE - SECONDS - TSL_AFTER_CHECKS_S))
  ((run_s <= budget)) || run_s=$budget
  if ((run_s < 30)); then rm -f "$out" "$host_out"; tsl_finish_early incomplete no_time "$started"; return $?; fi
  tsl_run_checks live "$run_s" "$TSL_WORK_DIR" "$out" || rc=$?
  if ((rc == 124 || rc == 137)); then mode=timeout; fi
  tsl_cleanup "$TSL_WORK_DIR"
  # A timed-out run printed nothing (the checker reads the driver first): the read-only half is run alone, on the clean host, so the host items still count, if the time allows it (the reserve keeps the rest of the clean-up safe).
  if [[ "$mode" == timeout ]]; then
    if ((TSL_HARD_DEADLINE - SECONDS >= TSL_HOST_PASS_NEEDS_S)); then tsl_run_checks host 30 "$TSL_WORK_DIR" "$host_out" || true; tsl_classify "$host_out" timeout; else tsl_classify "$host_out" none; fi
  else tsl_classify "$out" live; fi
  tsl_cleanup
  if ! tsl_readback_settled; then
    # One settle, then a second round (condition 3: it must be gone before the worker takes work).
    sleep 2
    tsl_cleanup
    if ! tsl_readback_settled; then
      log "TS-L self-test: the clean-up could not be read back ($TSL_DIFF)"
      rm -f "$out" "$host_out" "$TSL_SNAPSHOT_BEFORE" "$TSL_IMAGES_BEFORE"; tsl_record unusable cleanup_failed $((SECONDS - started)); return 75
    fi
  fi
  rm -f "$TSL_SNAPSHOT_BEFORE" "$TSL_IMAGES_BEFORE" "$out" "$host_out"
  if [[ "$mode" == timeout ]]; then tsl_record incomplete budget $((SECONDS - started)); else tsl_record ran ok $((SECONDS - started)); fi
  return 0
}

# What boot.sh's main did after the worker image was pulled, in the same order, with the same BOOT_STEP labels.
stage2_main() {
  local region=$1 instance_id=$2 tsl_status
  BOOT_STEP="download the worker image"
  if [[ "$CONTAINED_RUNTIME_AVAILABLE_BOOT" == true ]]; then pull_contained_image || true; fi
  pull_executor_image || true
  BOOT_STEP="start the worker"
  write_worker_environment "$region"
  if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then
    # FIRST, on every named boot (the self-test off or on): what a failed TS-L self-test left on the workspace volume's Docker data root must not meet this launch (tsl_sweep_leftovers).
    tsl_sweep_leftovers || fail "TS-L self-test leftovers on the workspace volume could not be removed; this worker is stopped before it takes any work"
    install_function_runner_runsc || true
    if pull_catalog_images "$region"; then
      write_test_services_environment || log "the test services settings could not be written (not fatal; runs with dependencies are refused)"
    else
      log "test services are not offered on this worker (the catalog images could not be pulled; not fatal)"
    fi
    set_docker_address_pools || fail "could not set Docker's address pools"
    metadata_blocked || fail "the metadata block is missing after the Docker restart"
    wall_between_run_networks || fail "could not wall run networks off from each other"
    wall_ipv6_into_host || withhold_test_services_for_ipv6 "${IPV6_WALL_REASON:-ip6tables-unusable}" || fail "could not withhold test services after the IPv6 wall failed"
    install_run_walls_unit || fail "could not install the unit that restores the run network walls"
    finish_function_runner || log "the function runner check did not finish (not fatal; the runner is not offered)"
    write_test_services_boot_facts || log "the test services boot facts could not be written (not fatal)"
    write_private_addresses || log "the internal address step could not be written (not fatal; no internal address is opened)"
  fi
  write_worker_unit "$region" "$instance_id"
  systemctl daemon-reload
  # The opt-in TS-L self-test (above), after every wall (it applies the launcher's own wall steps first) and before the worker unit is started: it never fails the boot, except that a worker whose clean-up could not be read back as complete must not take work (return 75).
  if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then
    tsl_status=0
    run_tsl_selftest "$instance_id" || tsl_status=$?
    ((tsl_status == 0)) || fail "the TS-L self-test left test objects on this worker and it is unusable (cleanup_failed); it is stopped before it takes any work"
  fi
  systemctl enable --now "$WORKER_UNIT"
  log "worker started"
  start_e2e_qualification "$region" "$instance_id" || log "the E2E qualification did not start"
}
