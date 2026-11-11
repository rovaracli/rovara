#!/bin/sh
# The docker CLI the worker hands to the devcontainer CLI on an EC2 worker (`--docker-path`, packages/worker/src/devcontainer.ts). It is the real `docker` except for what puts a container on the network:
# - `run` / `create` (also `container run` / `container create`): `--network agentx-task --cap-drop NET_RAW` go right after the verb. That network's host interface is the fixed `rvbtask`, which the boot
#   firewall walls (boot.sh `wall_off_containers`: every rvb* bridge has the private-range, link-local, loopback and host-INPUT drops), and it has inter-container traffic off. The default bridge docker0
#   cannot be walled, because the worker's own container is on it. NET_RAW is dropped so a dev container cannot craft raw packets on the segment it shares with other tasks' containers.
# - `build` (also `image build` / `builder build`): `--network agentx-task` goes right after the verb, and DOCKER_BUILDKIT=0 is set, because the Dockerfile's RUN steps and a feature's install scripts run in
#   build containers, which are on docker0 otherwise. Only the classic builder can put its build containers on a named network; BuildKit (`buildx build`, or `docker build` through it) accepts only default, host
#   and none, so `buildx` is refused here and the devcontainer CLI is told `--buildkit never` (devcontainer.ts). A build that cannot use the network fails; it never runs unwalled.
# The devcontainer CLI itself never passes --network; the worker refuses a `network` option in `runArgs` and `build.options` (devcontainer-policy.ts), and a started container that is not on the
# network alone (every network it is attached to is checked) or that kept NET_RAW is removed.
# The network name is TASK_SANDBOX_NETWORK in packages/worker/src/task-network.ts; a contract test keeps the two equal.
set -u
network=agentx-task

refuse() {
  printf 'docker-walled: %s is not available on this worker: its build and run containers must stay on the %s network\n' "$1" "$network" >&2
  exit 1
}

case "${1:-}" in
  run | create)
    verb=$1
    shift
    exec docker "$verb" --network "$network" --cap-drop NET_RAW "$@"
    ;;
  build)
    shift
    exec env DOCKER_BUILDKIT=0 docker build --network "$network" "$@"
    ;;
  buildx)
    refuse "docker buildx"
    ;;
  container)
    case "${2:-}" in
      run | create)
        verb=$2
        shift 2
        exec docker container "$verb" --network "$network" --cap-drop NET_RAW "$@"
        ;;
    esac
    ;;
  image | builder)
    if [ "${2:-}" = build ]; then
      group=$1
      shift 2
      exec env DOCKER_BUILDKIT=0 docker "$group" build --network "$network" "$@"
    fi
    ;;
esac
exec docker "$@"
