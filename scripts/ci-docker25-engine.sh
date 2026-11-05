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
#   4. Starts it, requires `docker version` to report EXACTLY the pinned Server and Client versions, loads the worker image back and requires the very same image id.
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

main() {
  local arch sha url tmp image id tar n server client loaded
  [[ $EUID -eq 0 ]] || die "run as root (sudo)"
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
  tar="$RUNNER_TEMP/worker-image-for-docker25.tar"
  docker save -o "$tar" "$image" || die "could not save the worker image"
  log "saved $image ($id), $(du -h "$tar" | cut -f1)"

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
  [[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$id" ]] || die "the worker image has another id after the load"
  log "worker image back on Docker $server with the same id ($id)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
