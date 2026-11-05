#!/bin/bash
# The test services Linux checks (TS-L1 to TS-L8, scripts/linux-check-test-services.sh and its live driver) on the linux-runtime CI runner. Staging workers are not SSM-managed and nobody can run these there, so this is where
# the checks that need root and a real Docker host are proven: L1 iptables backend, address range and pools; L3 embedded resolver, multicast, run files, spoofing (TS-SEAL-4); L4 Postgres hardening and the template_db
# reset; the L2 positive check; L6 the killed-worker sweep. It runs LAST in the linux-runtime job, as root, because it rewrites /etc/docker/daemon.json and restarts Docker (the address pools), exactly as a worker's boot does.
#
# WHAT IT DOES, in order
#   1. The rules, applied the way boot-stage2.sh applies them: the container firewall (the very heredoc of boot.sh, extracted), then boot-stage2.sh is SOURCED (it only defines functions) and its own functions run in
#      stage2_main's order: set_docker_address_pools (daemon.json pools + Docker restart + firewall again), metadata_blocked, wall_between_run_networks, wall_ipv6_into_host. Nothing is copied from them.
#   2. Postgres: there is no catalog on CI. The public postgres:16 image (ECR Public mirror of Docker Hub, PINNED BY THE INDEX DIGEST below) is pushed to a throwaway local registry (localhost:5000, registry:2 pinned by digest) and
#      pulled back by the digest it got there, so the helper runs `localhost:5000/svc/postgres@sha256:<digest>` with --pull=never, the same shape as the catalog's reference. The registry is removed before the checks start.
#      The committed catalog's postgres@16 entry (run arguments, health, resources, template_db reset) supplies everything else; the catalog's signature is NOT checked here (CI proves how the entry RUNS, not that it is trusted).
#   3. The live driver runs inside the worker image (built from environments/base/Dockerfile by the previous workflow step: the code that ships), with the host's Docker socket, exactly as on a worker.
#   4. linux-check-test-services.sh reads the driver's lines (TSL_LIVE_OUT_FILE) and adds its own read-only host checks. `judge` then fails the job on any FAIL or TSL ERROR, on a PENDING that is not one of the known later-slice
#      items, and on a live item with no PASS. It needs no AWS: nothing here reads a credential.
#
# Inputs (environment): TSL_CI_WORKER_IMAGE (a local image tag, built by the workflow), TSL_CI_DRIVER_JS (the driver as JavaScript: `npx tsx scripts/linux-check-test-services-live.ts --js`), RUNNER_TEMP.
# Optional: TSL_EGRESS_CAPTURE=1 (TS-SEAL egress capture, scripts/ci-egress-capture.sh, sourced below): tcpdump records the whole host while the round runs, a sealed-style container asks 127.0.0.11 for a random token name and a control container
# asks for another, and the checker's output gets one more line, `TSL L3.egress-capture PASS|FAIL`. The judge then also requires that line to be PASS. The summary is written to $RUNNER_TEMP/egress/summary.txt; the pcap is deleted and never uploaded.
# Optional: TSL_EXPECT_DOCKER_VERSION (an exact Docker Engine version, for example 25.0.5; TS-SEAL-6). When set, the script refuses to start unless the daemon reports exactly that server version, and the judge fails the job unless the
# checker's L1.docker-version line passed on that very version. The workflow runs this script twice: on the runner's own Docker, then again after scripts/ci-docker25-engine.sh swapped in the pinned Docker 25.0.5 (what the workers run).
set -uo pipefail

readonly POSTGRES_PINNED='public.ecr.aws/docker/library/postgres:16@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a'
readonly REGISTRY_PINNED='public.ecr.aws/docker/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
readonly LOCAL_REGISTRY=localhost:5000
readonly TSL_WORKSPACE_KEY=7e57c4ec7e57c4ec
# The items the live driver must PASS (scripts/linux-check-test-services-live.ts), and the only items that may stay PENDING (later slices: L5 test-account proxy, L7, L8, and the internal-drops part that needs an idle host's run network).
readonly LIVE_IDS="L1.live L1.live-other-run L2.live L3.live L3.embedded-resolver L3.working-relay L3.ipv6 L3.no-route L3.other-run L3.multicast L3.run-files L3.spoofing L4.live L4.template-db L6.live"
readonly ALLOWED_PENDING='^TSL (L1\.internal-drops|L[578]\.[a-z-]+) PENDING '

log() { printf 'ci-test-services-linux: %s\n' "$*" >&2; }

# The egress capture's functions (they run nothing when sourced).
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/ci-egress-capture.sh"

# judge FILE [EXPECTED_DOCKER_VERSION] [1 = the egress capture ran and must have passed]: the checker's whole output. Exit 0 only when nothing failed, no unexpected item is pending, and every live item passed. With an expected version, the L1.docker-version line must also have
# passed on exactly that Docker Engine version (the checker prints "Docker Engine <version>" from the daemon it ran against).
judge() {
  local file=$1 expected=${2:-} egress=${3:-} problems=0 id
  if [[ "$egress" == 1 ]]; then
    grep -Eq '^TSL L3\.egress-capture PASS ' "$file" || { log "FAIL: the egress capture has no PASS line (TSL L3.egress-capture)"; problems=1; }
  fi
  if [[ -n "$expected" ]]; then
    grep -Eq "^TSL L1\\.docker-version PASS [^ ]+ \\| Docker Engine ${expected//./\\.}\$" "$file" || { log "FAIL: the checks did not pass on Docker Engine $expected (no L1.docker-version PASS line for that version)"; problems=1; }
  fi
  if grep -Eq '^TSL ERROR|^TSL BLOCKED| FAIL ' "$file"; then log "FAIL: the checks reported a failure or an error:"; grep -E '^TSL ERROR|^TSL BLOCKED| FAIL ' "$file" >&2; problems=1; fi
  if grep -E ' PENDING ' "$file" | grep -Evq "$ALLOWED_PENDING"; then log "FAIL: an item is PENDING that may not be:"; grep -E ' PENDING ' "$file" | grep -Ev "$ALLOWED_PENDING" >&2; problems=1; fi
  for id in $LIVE_IDS; do
    grep -Eq "^TSL ${id//./\\.} PASS " "$file" || { log "FAIL: live item $id has no PASS line"; problems=1; }
  done
  grep -Eq '^TSL SUMMARY pass=[0-9]+ fail=0 pending=[0-9]+$' "$file" || { log "FAIL: no summary with fail=0"; problems=1; }
  return "$problems"
}

retry() { local n; for n in 1 2 3; do "$@" && return 0; sleep $((n * 5)); done; return 1; }

apply_rules() {
  local root=$1
  install -d -m 0755 /usr/local/libexec
  # The firewall unit's script, extracted from boot.sh as the CI job's first step does, so set_docker_address_pools can run it again after Docker's restart.
  sed -n "/<<'FIREWALL'/,/^FIREWALL\$/p" "$root/packages/worker/ec2/boot.sh" | sed '1d;$d' > /usr/local/libexec/rovara-container-firewall || return 1
  [[ $(wc -l < /usr/local/libexec/rovara-container-firewall) -gt 5 ]] || { log "the firewall script could not be extracted from boot.sh"; return 1; }
  chmod 0755 /usr/local/libexec/rovara-container-firewall
  bash /usr/local/libexec/rovara-container-firewall || return 1
  DOCKER_DATA_ROOT=$(docker info --format '{{.DockerRootDir}}') || return 1
  export DOCKER_DATA_ROOT
  # boot-stage2.sh defines constants and functions and runs nothing when sourced.
  set +u
  # shellcheck disable=SC1091
  source "$root/packages/worker/ec2/boot-stage2.sh" || return 1
  set -u
  set_docker_address_pools || { log "could not set Docker's address pools"; return 1; }
  metadata_blocked || { log "the metadata block is missing after the Docker restart"; return 1; }
  wall_between_run_networks || { log "could not wall run networks off from each other"; return 1; }
  wall_ipv6_into_host || { log "could not drop IPv6 from run networks into the host"; return 1; }
  iptables -S DOCKER-USER; iptables -S INPUT; ip6tables -S INPUT 2>/dev/null || true
}

# push_postgres: prints the digest the local registry gave the pushed image.
push_postgres() {
  local out digest
  retry docker pull --quiet "$POSTGRES_PINNED" >/dev/null || { log "could not pull the pinned postgres image"; return 1; }
  retry docker pull --quiet "$REGISTRY_PINNED" >/dev/null || { log "could not pull the pinned registry image"; return 1; }
  docker rm -f tsl-ci-registry >/dev/null 2>&1 || true
  docker run -d --name tsl-ci-registry -p 127.0.0.1:5000:5000 "$REGISTRY_PINNED" >/dev/null || return 1
  local n
  for n in $(seq 1 30); do curl -fsS --max-time 2 "http://$LOCAL_REGISTRY/v2/" >/dev/null 2>&1 && break; sleep 1; [[ $n -lt 30 ]] || { log "the local registry did not come up"; return 1; }; done
  docker tag "$POSTGRES_PINNED" "$LOCAL_REGISTRY/svc/postgres:ci" || return 1
  out=$(docker push "$LOCAL_REGISTRY/svc/postgres:ci" 2>&1) || { log "push failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; return 1; }
  digest=$(printf '%s\n' "$out" | sed -n 's/.*digest: \(sha256:[a-f0-9]\{64\}\).*/\1/p' | tail -1)
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { log "the registry gave no digest"; return 1; }
  docker rmi "$LOCAL_REGISTRY/svc/postgres:ci" >/dev/null 2>&1 || true
  docker pull --quiet "$LOCAL_REGISTRY/svc/postgres@$digest" >/dev/null || { log "could not pull the pushed image back by digest"; return 1; }
  docker rm -f tsl-ci-registry >/dev/null 2>&1 || true
  printf '%s\n' "$digest"
}

cleanup_labelled() {
  local ids
  ids=$(docker ps -a -q --filter "label=rovara.run-network.workspace=$TSL_WORKSPACE_KEY" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || docker rm -f -v $ids >/dev/null 2>&1 || true
  ids=$(docker network ls -q --filter "label=rovara.run-network.workspace=$TSL_WORKSPACE_KEY" 2>/dev/null) || ids=""
  [[ -z "$ids" ]] || docker network rm $ids >/dev/null 2>&1 || true
  docker rm -f tsl-ci-registry >/dev/null 2>&1 || true
}

main() {
  local root work gid image_id digest live_out check_out running
  [[ $EUID -eq 0 ]] || { log "run as root (sudo)"; return 2; }
  : "${TSL_CI_WORKER_IMAGE:?set TSL_CI_WORKER_IMAGE}" "${TSL_CI_DRIVER_JS:?set TSL_CI_DRIVER_JS}" "${RUNNER_TEMP:?set RUNNER_TEMP}"
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [[ -s "$TSL_CI_DRIVER_JS" ]] || { log "the driver program is missing"; return 2; }
  trap 'cleanup_labelled; eg_cleanup' EXIT
  if [[ -n "${TSL_EXPECT_DOCKER_VERSION:-}" ]]; then
    [[ "$TSL_EXPECT_DOCKER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "TSL_EXPECT_DOCKER_VERSION must be a full version such as 25.0.5"; return 2; }
    running=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || running=""
    [[ "$running" == "$TSL_EXPECT_DOCKER_VERSION" ]] || { log "FAIL: the daemon reports Docker Engine '${running:-unreadable}', not the expected $TSL_EXPECT_DOCKER_VERSION"; return 1; }
  fi
  log "running on Docker Engine $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  apply_rules "$root" || return 1
  digest=$(push_postgres) || return 1
  image_id=$(docker image inspect --format '{{.Id}}' "$TSL_CI_WORKER_IMAGE") || { log "the worker image $TSL_CI_WORKER_IMAGE is not there"; return 1; }
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { log "the worker image has no usable id"; return 1; }
  gid=$(stat -c %g /var/run/docker.sock) || return 1
  work=$(mktemp -d /var/tmp/tsl-work.XXXXXX) || return 1
  chmod 0755 "$work"
  cleanup_labelled
  # agentx-task, the working sandbox's network (L2): on a worker the worker makes it, a plain bridge, when it starts its first task sandbox (packages/worker/src/task-sandbox.ts ensureNetwork). CI has no worker, so it is
  # made here with the same arguments, after the address pools are set, and stays for the checker's L2.egress-network.
  docker network inspect agentx-task >/dev/null 2>&1 || docker network create --driver bridge agentx-task >/dev/null || { log "could not create the agentx-task network"; return 1; }
  # The capture starts before the probes and the driver, and stops after the checker: the whole round is inside it.
  if [[ "${TSL_EGRESS_CAPTURE:-}" == 1 ]]; then
    eg_prepare "$RUNNER_TEMP/egress" && eg_capture_start && eg_probes "$image_id" || { log "FAIL: the egress capture could not be set up"; return 1; }
  fi
  live_out="$RUNNER_TEMP/tsl-live.out"
  log "running the live driver in the worker image ($image_id), postgres $digest"
  timeout --foreground --kill-after=30s 2400s docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,size=64m \
    -v "$TSL_CI_DRIVER_JS:/opt/agentx/tsl-live.mjs:ro" -v "$root/environments/service-catalog/catalog.json:/opt/agentx/tsl-catalog.json:ro" \
    -e TSL_REGISTRY="$LOCAL_REGISTRY" -e TSL_ENV=ci -e TSL_CATALOG=/opt/agentx/tsl-catalog.json -e TSL_WORKER_IMAGE="$image_id" -e TSL_WORK="$work" -e TSL_CI_POSTGRES_DIGEST="$digest" \
    --user 0:0 --group-add "$gid" -v /var/run/docker.sock:/var/run/docker.sock -v "$work:$work" --entrypoint /usr/local/bin/node "$image_id" /opt/agentx/tsl-live.mjs ci > "$live_out" 2>&1
  log "driver exit status $?"
  cleanup_labelled
  rm -rf "$work"
  check_out="$RUNNER_TEMP/tsl-check.out"
  TSL_ENV=ci TSL_LIVE_OUT_FILE="$live_out" bash "$root/scripts/linux-check-test-services.sh" > "$check_out" 2>&1
  log "checker exit status $? (0: all pass; 3: only later-slice items pending; 1: a failure)"
  if [[ "${TSL_EGRESS_CAPTURE:-}" == 1 ]]; then
    eg_capture_stop
    eg_verdict "$EG_DIR/all.txt" | tee "$EG_DIR/summary.txt" >> "$check_out" || true
    rm -f "$EG_DIR/all.pcap"
  fi
  cat "$check_out"
  judge "$check_out" "${TSL_EXPECT_DOCKER_VERSION:-}" "$([[ "${TSL_EGRESS_CAPTURE:-}" == 1 ]] && echo 1 || echo 0)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
