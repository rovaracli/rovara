import { agentXError } from "@rovara-code/contracts";
import type { DockerCli } from "./swebench/containers.js";

/** The user-defined bridge network of every sandbox: outbound internet works, the host's network and other containers' do not. */
export const TASK_SANDBOX_NETWORK = "agentx-task";
/**
 * The Linux interface of that network, fixed. The EC2 boot firewall (packages/worker/ec2/boot.sh `wall_off_containers`) walls untrusted containers by interface name: every `rvb*` bridge gets the private-range,
 * link-local, loopback and host-INPUT drops (only the VPC resolver's port 53 stays open). Docker's own name for an unnamed network is `br-<hex>`, which no rule matches, so a plain `agentx-task` network was reachable
 * to VPC addresses and the host's own ports (TASK-BRIDGE-UNWALLED). `rvb` + `task` is 7 of the 15 characters an interface name may have.
 */
export const TASK_SANDBOX_BRIDGE = "rvbtask";
const DOCKER_CALL_TIMEOUT_MS = 60_000;

/**
 * An EC2 worker, by either marker: boot.sh writes AGENTX_RUNTIME=ec2 to the worker's environment, and the worker image sets
 * AGENTX_WORKER_PROCESS_SCOPE=container. Neither is needed for the sandbox, which is the default everywhere; they make
 * the local shell impossible to ask for.
 */
export function isEc2WorkerRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENTX_RUNTIME === "ec2" || environment.AGENTX_WORKER_PROCESS_SCOPE === "container";
}

/**
 * The `docker network create` arguments of the task network. Two options:
 * - the fixed interface name the boot firewall walls (above);
 * - `enable_icc=false`: the network is ONE layer-2 segment shared by every sandbox and dev container of every task on this worker, and the host firewall walls only what leaves it. With inter-container
 *   communication off, Docker drops container-to-container IP traffic on the bridge (its `-i br -o br -j DROP`, seen by the bridge netfilter), so one task's code cannot connect to another task's sandbox or
 *   dev container, nor use ARP games to put itself in the path of a neighbour's traffic (the redirected packets are dropped the same way).
 */
export function taskNetworkCreateArgs(): string[] {
  return ["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${TASK_SANDBOX_BRIDGE}`, "--opt", "com.docker.network.bridge.enable_icc=false", TASK_SANDBOX_NETWORK];
}

const INSPECT_FORMAT = "{{.Driver}} {{json .Options}} {{.Internal}}";

/**
 * Whether `docker network inspect --format INSPECT_FORMAT` describes the task network as created above: a plain, non-internal bridge whose `bridge.name` and `enable_icc` options have exactly these values. Other
 * options are ignored (a newer Docker may add some of its own; recreating the network for them would only churn), and a network without the two is not walled.
 */
export function isWalledTaskNetwork(inspected: string): boolean {
  const text = inspected.trim();
  const first = text.indexOf(" ");
  const last = text.lastIndexOf(" ");
  if (first === -1 || last <= first || text.slice(0, first) !== "bridge" || text.slice(last + 1) !== "false") return false;
  let options: unknown;
  try {
    options = JSON.parse(text.slice(first + 1, last));
  } catch {
    return false;
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
  const given = options as Record<string, unknown>;
  return given["com.docker.network.bridge.name"] === TASK_SANDBOX_BRIDGE && given["com.docker.network.bridge.enable_icc"] === "false";
}

/**
 * Idempotent: another start may create, or remove and make again, the network between any two of these calls. The data root persists on the
 * workspace volume, so a network of this name is not trusted: it must be the walled bridge above (an `agentx-task` made by an earlier release has Docker's own `br-<hex>` name and is unwalled), or it is
 * removed and made again. A removal that fails is judged by looking again: a network that is now right (a concurrent start made it) is used, and one that is gone is made. Shared by the task sandbox and the dev
 * container start (devcontainer.ts), which join the same network.
 */
export async function ensureTaskNetwork(docker: DockerCli): Promise<void> {
  const inspect = ["network", "inspect", "--format", INSPECT_FORMAT, TASK_SANDBOX_NETWORK];
  const found = await docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  if (found.exitCode === 0) {
    if (isWalledTaskNetwork(found.stdout)) return;
    const removed = await docker.run(["network", "rm", TASK_SANDBOX_NETWORK], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
    if (removed.exitCode !== 0) {
      const again = await docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
      if (again.exitCode === 0 && isWalledTaskNetwork(again.stdout)) return;
      if (again.exitCode === 0) {
        throw agentXError("RUNTIME_UNAVAILABLE", `the ${TASK_SANDBOX_NETWORK} network is not the walled bridge (${TASK_SANDBOX_BRIDGE}, no inter-container traffic) and could not be removed, so AgentX did not start the task sandbox: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`);
      }
      // Gone by now (another start removed it): made below.
    }
  }
  const created = await docker.run(taskNetworkCreateArgs(), { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  if (created.exitCode === 0) return;
  if (isWalledTaskNetwork((await docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS })).stdout)) return;
  const detail = (created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
  throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not create the ${TASK_SANDBOX_NETWORK} network for the task sandbox: ${detail || `exit ${String(created.exitCode)}`}`);
}
