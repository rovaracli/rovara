#!/bin/sh
# The docker CLI the worker hands to the devcontainer CLI on an EC2 worker (`--docker-path`, packages/worker/src/devcontainer.ts). It is the real `docker` except that every container
# started or created joins the walled task network: `--network agentx-task` goes right after `run` / `create` (also `container run` / `container create`). That network's host interface is the
# fixed `rvbtask`, which the boot firewall walls (boot.sh `wall_off_containers`: every rvb* bridge has the private-range, link-local, loopback and host-INPUT drops). The default bridge docker0
# cannot be walled, because the worker's own container is on it. The devcontainer CLI itself never passes --network; the worker refuses a `runArgs` network (devcontainer-policy.ts), so this
# one is never overridden (the last --network wins), and a started container that is not on the network is removed.
# The network name is TASK_SANDBOX_NETWORK in packages/worker/src/task-network.ts; a contract test keeps the two equal.
set -u
network=agentx-task
case "${1:-}" in
  run | create)
    verb=$1
    shift
    exec docker "$verb" --network "$network" "$@"
    ;;
  container)
    case "${2:-}" in
      run | create)
        verb=$2
        shift 2
        exec docker container "$verb" --network "$network" "$@"
        ;;
    esac
    ;;
esac
exec docker "$@"
