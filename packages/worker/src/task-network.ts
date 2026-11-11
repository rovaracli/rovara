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

/** The `docker network create` arguments of the task network. */
export function taskNetworkCreateArgs(): string[] {
  return ["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${TASK_SANDBOX_BRIDGE}`, TASK_SANDBOX_NETWORK];
}

/** What `docker network inspect --format '{{.Driver}} {{json .Options}} {{.Internal}}'` prints for the task network as created above, and for nothing else (a network without the option is not walled). */
const TASK_NETWORK_INSPECTION = new RegExp(`^bridge \\{"com\\.docker\\.network\\.bridge\\.name":"${TASK_SANDBOX_BRIDGE}"\\} false$`, "u");

/**
 * Idempotent: another start may create the network between the check and the create. The data root persists on the
 * workspace volume, so a network of this name is not trusted: it must be a plain bridge with the fixed interface name the
 * boot firewall walls (an `agentx-task` made by an earlier release has Docker's own `br-<hex>` and is unwalled), or it is
 * removed and made again. Shared by the task sandbox and the dev container start (devcontainer.ts), which join the same network.
 */
export async function ensureTaskNetwork(docker: DockerCli): Promise<void> {
  const inspect = ["network", "inspect", "--format", "{{.Driver}} {{json .Options}} {{.Internal}}", TASK_SANDBOX_NETWORK];
  const found = await docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  if (found.exitCode === 0) {
    if (TASK_NETWORK_INSPECTION.test(found.stdout.trim())) return;
    const removed = await docker.run(["network", "rm", TASK_SANDBOX_NETWORK], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
    if (removed.exitCode !== 0) {
      throw agentXError("RUNTIME_UNAVAILABLE", `the ${TASK_SANDBOX_NETWORK} network is not the walled bridge (${TASK_SANDBOX_BRIDGE}) and could not be removed, so AgentX did not start the task sandbox: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`);
    }
  }
  const created = await docker.run(taskNetworkCreateArgs(), { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  if (created.exitCode === 0) return;
  if (TASK_NETWORK_INSPECTION.test((await docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS })).stdout.trim())) return;
  const detail = (created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
  throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not create the ${TASK_SANDBOX_NETWORK} network for the task sandbox: ${detail || `exit ${String(created.exitCode)}`}`);
}
