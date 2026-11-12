#!/bin/sh
# The docker CLI the worker hands to the devcontainer CLI on an EC2 worker (`--docker-path`, packages/worker/src/devcontainer.ts). It is the real `docker` except for what puts a container on the network:
# - `run` / `create` (also `container run` / `container create`): `--network agentx-task --cap-drop NET_RAW` go right after the verb. That network's host interface is the fixed `rvbtask`, which the boot
#   firewall walls (boot.sh `wall_off_containers`: every rvb* bridge has the private-range, link-local, loopback and host-INPUT drops), and it has inter-container traffic off. The default bridge docker0
#   cannot be walled, because the worker's own container is on it. NET_RAW is dropped so a dev container cannot craft raw packets on the segment it shares with other tasks' containers.
# - `build` (also `image build` / `builder build`): `--network agentx-task` goes right after the verb, and DOCKER_BUILDKIT=0 is set, because the Dockerfile's RUN steps and a feature's install scripts run in
#   build containers, which are on docker0 otherwise. Only the classic builder can put its build containers on a named network; BuildKit (`buildx build`, or `docker build` through it) accepts only default, host
#   and none, so `buildx` is refused here and the devcontainer CLI is told `--buildkit never` (devcontainer.ts). A build that cannot use the network fails; it never runs unwalled.
# Global flags before the verb (`--context x run`, `-H host build`, `--config dir`, `--host`, ...) are refused: the devcontainer CLI never emits them, and parsing past them would have to know every
# flag that takes a value, while a refused one cannot slip a run or build past the rewrite (they can also point docker at another daemon). A build with a --network / --net of its own anywhere in its
# arguments is refused, rather than relying on the one added here coming first (the classic builder takes the last).
# The devcontainer CLI itself never passes --network; the worker refuses a `network` option in `runArgs` and `build.options` (devcontainer-policy.ts), and a started container that is not on the
# network alone (every network it is attached to is checked) or that kept NET_RAW is removed.
# The network name is TASK_SANDBOX_NETWORK in packages/worker/src/task-network.ts; a contract test keeps the two equal.
set -u
network=agentx-task

# Owner decision 123: the internal names the host's wall pinned at this worker's start (AGENTX_PRIVATE_ADDRESS_HOSTS, `name=address` pairs, comma separated; boot-stage2.sh `rovara-private-allow`) become `--add-host` entries
# of every container and build, so a dev container's lookups agree with the wall. A value that is not in that one written form gives none (the wall still decides what is reachable).
hosts=""
case "${AGENTX_PRIVATE_ADDRESS_HOSTS:-}" in
  "" | *[!a-z0-9.,=-]*) ;;
  *)
    old_ifs=$IFS
    IFS=,
    for pair in $AGENTX_PRIVATE_ADDRESS_HOSTS; do
      name=${pair%%=*} address=${pair#*=}
      case "$name:$address" in
        *=* | :* | *: | *[!0-9.]) hosts=""; break ;;
      esac
      case "$address" in *[!0-9.]* | "") hosts=""; break ;; esac
      hosts="$hosts --add-host $name:$address"
    done
    IFS=$old_ifs
    ;;
esac

refuse() {
  printf 'docker-walled: %s is not available on this worker: its build and run containers must stay on the %s network\n' "$1" "$network" >&2
  exit 1
}

# Refuses a --network / --net option (either spelling, either form) among the arguments of a build.
refuse_build_network() {
  for argument in "$@"; do
    case "$argument" in
      --network | --network=* | --net | --net=*) refuse "a build with its own $argument" ;;
    esac
  done
}

case "${1:-}" in
  -*)
    refuse "a docker option ($1) before the command"
    ;;
  run | create)
    verb=$1
    shift
    # shellcheck disable=SC2086
    exec docker "$verb" --network "$network" --cap-drop NET_RAW $hosts "$@"
    ;;
  build)
    shift
    refuse_build_network "$@"
    # shellcheck disable=SC2086
    exec env DOCKER_BUILDKIT=0 docker build --network "$network" $hosts "$@"
    ;;
  buildx)
    refuse "docker buildx"
    ;;
  container)
    case "${2:-}" in
      run | create)
        verb=$2
        shift 2
        # shellcheck disable=SC2086
        exec docker container "$verb" --network "$network" --cap-drop NET_RAW $hosts "$@"
        ;;
    esac
    ;;
  image | builder)
    if [ "${2:-}" = build ]; then
      group=$1
      shift 2
      refuse_build_network "$@"
      # shellcheck disable=SC2086
      exec env DOCKER_BUILDKIT=0 docker "$group" build --network "$network" $hosts "$@"
    fi
    ;;
esac
exec docker "$@"
