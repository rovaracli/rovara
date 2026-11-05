#!/bin/bash
# TS-SEAL-6: swap the linux-runtime runner's Docker engine (28.x) for the pinned Docker 25.0.5, so the test services Linux checks (scripts/ci-test-services-linux.sh) can run a second time on the engine
# generation the workers run. Staging workers are Amazon Linux 2023 with its own Docker 25 build (25.0.18 on 2026-11-04); Docker publishes static binaries for 25.0.x only up to 25.0.5
# (https://download.docker.com/linux/static/stable/<arch>/, checked 2026-11-05), so 25.0.5 is the newest 25.0.x that can be pinned here by version and checksum. It is also the first release with the CVE-2024-29018 fix.
#
# WHAT IT DOES (as root, on the CI runner only; never on a worker)
#   1. Saves the worker image (TSL_DOCKER25_WORKER_IMAGE, built by the previous workflow steps on the old engine) to a tar, so it is not built a second time (the build is 6 to 9 minutes).
#   2. Downloads docker-25.0.5.tgz for this CPU from download.docker.com, checks its SHA-256 against the pin below, unpacks it under /opt/docker-25.0.5 and checks the binary reports 25.0.5.
#   3. Stops docker.service and docker.socket, points the unit at the pinned dockerd with a systemd drop-in (the same unit, socket and iptables as before; dockerd starts its own containerd from the pinned directory), gives it a
#      separate data root (/var/lib/docker25, so the 28.x image store is never opened by an older engine) and puts the pinned CLI first on PATH (/usr/local/bin/docker).
#      Before it starts, the old engine's leftovers are removed: Docker 28's iptables chains (DOCKER-FORWARD, DOCKER-CT, DOCKER-BRIDGE, DOCKER-INTERNAL), Docker's own filter and nat chains with every jump to them, the docker0
#      MASQUERADE and the docker0 link, so Docker 25 builds its own from nothing (DOCKER-USER is kept: the rules step puts the boot firewall's rules back with check-then-insert and never flushes it).
#   4. Starts it, requires `docker version` to report EXACTLY the pinned Server and Client versions, loads the worker image back and requires the same tag and the same layers (RootFS.Layers; the image id is not compared here, because a runner that uses the containerd image store gives a different id).
# The step after this one runs scripts/ci-test-services-linux.sh with TSL_EXPECT_DOCKER_VERSION=25.0.5, which asserts the version again and fails the job unless the checker reports Docker Engine 25.0.5.
# The checksums were taken from the downloads over TLS on 2026-11-05 (Docker publishes none); a new pin means a new reviewed change here.
set -euo pipefail

readonly DOCKER25_VERSION=25.0.5
readonly DOCKER25_SHA256_AARCH64=cf3529e0e4d46f83c4c57df4f986df86f011313359d86f33b5bfe6f333f12063
readonly DOCKER25_SHA256_X86_64=d5ff82e5fd469aab5ce73f01c27fa4ca8df85e5376d8245d012c73694dc2fc95
readonly DOCKER25_DIR=/opt/docker-25.0.5
readonly DOCKER25_DATA_ROOT=/var/lib/docker25
readonly DOCKER25_DROPIN=/etc/systemd/system/docker.service.d/rovara-docker25.conf

log() { printf 'ci-docker25-engine: %s\n' "$*" >&2; }
die() { log "FAIL: $*"; exit 1; }
diagnose() { systemctl status docker.service --no-pager -l 2>&1 | tail -n 25 >&2 || true; journalctl -u docker.service --no-pager -n 60 >&2 2>&1 || true; }

# drop_chains TABLE CHAIN...: delete every rule, in any chain of TABLE, that jumps to one of the chains, then flush and delete the chains. Every call tolerates a chain that is not there.
drop_chains() {
  local ipt=$1 table=$2 chain rule; shift 2
  local -a args
  command -v "$ipt" >/dev/null || return 0
  for chain in "$@"; do
    while IFS= read -r rule; do
      read -r -a args <<<"${rule/#-A /-D }"
      "$ipt" -t "$table" "${args[@]}" 2>/dev/null || true
    done < <("$ipt" -t "$table" -S 2>/dev/null | grep -E -- "^-A .* -j $chain\$" || true)
  done
  for chain in "$@"; do "$ipt" -t "$table" -F "$chain" 2>/dev/null || true; done
  for chain in "$@"; do "$ipt" -t "$table" -X "$chain" 2>/dev/null || true; done
}

# remove_docker_leftovers: what the old engine leaves in the kernel. Only Docker's own names are touched; DOCKER-USER and INPUT are left alone.
remove_docker_leftovers() {
  local ipt rule line
  local -a args
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null || continue
    drop_chains "$ipt" filter DOCKER-FORWARD DOCKER-CT DOCKER-BRIDGE DOCKER-INTERNAL DOCKER-ISOLATION-STAGE-1 DOCKER-ISOLATION-STAGE-2 DOCKER
    # docker0's own rules (filter and nat), whichever chain holds them: the MASQUERADE of 172.17.0.0/16, per-bridge ACCEPTs.
    for rule in filter nat; do
      while IFS= read -r line; do read -r -a args <<<"${line/#-A /-D }"; "$ipt" -t "$rule" "${args[@]}" 2>/dev/null || true; done < <("$ipt" -t "$rule" -S 2>/dev/null | grep -E -- '^-A .*[ !]docker0( |$)' || true)
    done
    drop_chains "$ipt" nat DOCKER
  done
  ip link delete docker0 2>/dev/null || true
}

main() {
  local arch sha url tmp image id tar n server client loaded before_tags before_layers after_tags after_layers
  [[ $(id -u) -eq 0 ]] || die "run as root (sudo)"
  image=${TSL_DOCKER25_WORKER_IMAGE:?set TSL_DOCKER25_WORKER_IMAGE}
  : "${RUNNER_TEMP:?set RUNNER_TEMP}"
  case "$(uname -m)" in
    aarch64|arm64) arch=aarch64; sha=$DOCKER25_SHA256_AARCH64 ;;
    x86_64) arch=x86_64; sha=$DOCKER25_SHA256_X86_64 ;;
    *) die "no pinned Docker $DOCKER25_VERSION download for CPU $(uname -m)" ;;
  esac
  url="https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER25_VERSION.tgz"

  log "engine before the swap: $(docker version --format 'server {{.Server.Version}}, client {{.Client.Version}}' 2>&1 | head -n1)"
  id=$(docker image inspect --format '{{.Id}}' "$image") || die "the worker image $image is not there"
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || die "the worker image has no usable id"
  before_tags=$(docker image inspect --format '{{json .RepoTags}}' "$image") || die "could not read the worker image's tags"
  before_layers=$(docker image inspect --format '{{json .RootFS.Layers}}' "$image") || die "could not read the worker image's layers"
  [[ "$before_layers" != "null" && "$before_layers" != "[]" && "$before_tags" == *"\"$image\""* ]] || die "the worker image has no layers or does not carry the tag $image"
  tar="$RUNNER_TEMP/worker-image-for-docker25.tar"
  docker save -o "$tar" "$image" || die "could not save the worker image"
  log "saved $image ($id), $(du -h "$tar" | cut -f1)"
  log "disk before the prune:"; df -h / >&2 || true
  # The tar holds what Docker 25 needs; the old engine's images, build cache and stopped containers only take disk (the runner is nearly full after the image build).
  docker system prune -af >/dev/null 2>&1 || log "warning: docker system prune failed (not fatal)"

  tmp=$(mktemp -d)
  for n in 1 2 3; do curl -fsSL --max-time 300 -o "$tmp/docker.tgz" "$url" && break; [[ $n -lt 3 ]] || die "could not download $url"; sleep $((n * 5)); done
  printf '%s  %s\n' "$sha" "$tmp/docker.tgz" | sha256sum -c - >&2 || die "the download does not match the pinned SHA-256 $sha"
  rm -rf "$DOCKER25_DIR"
  install -d -m 0755 "$DOCKER25_DIR"
  tar -xzf "$tmp/docker.tgz" -C "$DOCKER25_DIR" --strip-components=1 || die "could not unpack the download"
  rm -rf "$tmp"
  for n in docker dockerd containerd containerd-shim-runc-v2 runc docker-proxy docker-init; do [[ -x "$DOCKER25_DIR/$n" ]] || die "$n is missing from the Docker $DOCKER25_VERSION download"; done
  "$DOCKER25_DIR/dockerd" --version | grep -q "version $DOCKER25_VERSION," || die "the unpacked dockerd is not $DOCKER25_VERSION: $("$DOCKER25_DIR/dockerd" --version)"

  systemctl stop docker.service docker.socket || true
  remove_docker_leftovers
  install -d -m 0755 /etc/docker "$(dirname "$DOCKER25_DROPIN")" "$DOCKER25_DATA_ROOT"
  # The unit keeps its name, socket and ordering; only the binary, its PATH (containerd, runc, docker-proxy and docker-init are found there) and the data root change. ExecStart= clears the packaged line first.
  cat > "$DOCKER25_DROPIN" <<UNIT
[Service]
Environment=PATH=$DOCKER25_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=
ExecStart=$DOCKER25_DIR/dockerd -H fd://
UNIT
  printf '{"data-root": "%s"}\n' "$DOCKER25_DATA_ROOT" > /etc/docker/daemon.json
  ln -sfn "$DOCKER25_DIR/docker" /usr/local/bin/docker
  hash -r
  systemctl daemon-reload
  systemctl restart docker.socket docker.service || { diagnose; die "Docker $DOCKER25_VERSION did not start"; }
  for n in $(seq 1 60); do docker version >/dev/null 2>&1 && break; sleep 1; [[ $n -lt 60 ]] || { diagnose; die "Docker $DOCKER25_VERSION did not answer within 60 seconds"; }; done

  server=$(docker version --format '{{.Server.Version}}') || die "could not read the server version"
  client=$(docker version --format '{{.Client.Version}}') || die "could not read the client version"
  [[ "$server" == "$DOCKER25_VERSION" ]] || die "the server is $server, not $DOCKER25_VERSION"
  [[ "$client" == "$DOCKER25_VERSION" ]] || die "the client is $client, not $DOCKER25_VERSION"
  [[ "$(docker info --format '{{.DockerRootDir}}')" == "$DOCKER25_DATA_ROOT" ]] || die "Docker is not using the separate data root"
  log "engine after the swap: server $server, client $client, data root $DOCKER25_DATA_ROOT"

  loaded=$(docker load -i "$tar" 2>&1) || { printf '%s\n' "$loaded" >&2; die "Docker $DOCKER25_VERSION could not load the worker image"; }
  rm -f "$tar"
  after_tags=$(docker image inspect --format '{{json .RepoTags}}' "$image") || die "the worker image is not there after the load"
  after_layers=$(docker image inspect --format '{{json .RootFS.Layers}}' "$image") || die "could not read the worker image's layers after the load"
  [[ "$after_tags" == *"\"$image\""* ]] || die "the loaded worker image does not carry the tag $image"
  [[ "$after_layers" == "$before_layers" ]] || die "the worker image has other layers after the load"
  log "worker image back on Docker $server with the same tag and layers (was id $id, now $(docker image inspect --format '{{.Id}}' "$image"); ci-test-services-linux.sh reads the id itself)"
  # What the second run starts from.
  log "state before the second run:"
  { echo "--- iptables -S"; iptables -S; echo "--- iptables -t nat -S"; iptables -t nat -S; echo "--- ip link"; ip link; echo "--- df -h /"; df -h /; } >&2 || true
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
