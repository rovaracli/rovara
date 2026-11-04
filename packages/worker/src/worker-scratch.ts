import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentXError } from "@agentx/contracts";

/**
 * Where the worker keeps scratch of its own: the throwaway Git repositories it reads a candidate with, and the folder that holds a Git credential while one command runs (TF12).
 *
 * On an EC2 worker the temporary directory can be on the workspace volume (`TMPDIR=/mnt/agentx-runtime/tmp`, a bind mount of `.agentx-runtime` on it). Task code runs against that volume
 * (the sandbox and the devcontainer mount it, with the worker's folders hidden behind empty mounts), and anything a task's process leaves running could write there. Worker scratch is
 * therefore made on a file system the workspace volume is not on: the worker container's own `/tmp`, which no sandbox or devcontainer mounts.
 *
 * The choice is by device: the first of the temporary directory, `/tmp` and `/var/tmp` whose file system is not the workspace root's. On a machine where the workspace has no volume of its own
 * (a developer's, a test) every candidate shares its device and the temporary directory is used, as it always was. On an EC2 worker, where that cannot be, nothing is made: scratch on
 * the workspace volume is refused.
 */
export const WORKSPACE_ROOT_ENVIRONMENT = "AGENTX_WORKSPACE_ROOT";
const DEFAULT_WORKSPACE_ROOT = "/mnt/workspace";
const FALLBACK_BASES = ["/tmp", "/var/tmp"] as const;

export interface WorkerScratchOptions {
  environment?: NodeJS.ProcessEnv;
}

/** The device a path is on, or undefined when it cannot be read. */
type DeviceProbe = (path: string) => Promise<number | undefined>;

const statDevice: DeviceProbe = async (path) => (await stat(path).catch(() => undefined))?.dev;
let deviceProbe: DeviceProbe = statDevice;
/** Test seam: how the device of a path is read. Returns the undo. */
export function useScratchDeviceProbeForTests(probe: DeviceProbe): () => void {
  const previous = deviceProbe;
  deviceProbe = probe;
  return () => {
    deviceProbe = previous;
  };
}

/** The same two markers as `isEc2WorkerRuntime` (task-sandbox.ts, which this file cannot import without a cycle; a test pins them together). */
export function ec2WorkerRuntime(environment: NodeJS.ProcessEnv): boolean {
  return environment.AGENTX_RUNTIME === "ec2" || environment.AGENTX_WORKER_PROCESS_SCOPE === "container";
}

/** The directory worker scratch is made in (see the file's comment). */
export async function workerScratchBase(options: WorkerScratchOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const temporary = tmpdir();
  const candidates = [temporary, ...FALLBACK_BASES.filter((base) => base !== temporary)];
  const workspaceDevice = await deviceProbe(environment[WORKSPACE_ROOT_ENVIRONMENT] ?? DEFAULT_WORKSPACE_ROOT);
  if (workspaceDevice === undefined) return temporary;
  for (const base of candidates) {
    const device = await deviceProbe(base);
    if (device !== undefined && device !== workspaceDevice) return base;
  }
  if (ec2WorkerRuntime(environment)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX has no scratch directory outside the workspace volume, so it did not make one where a task's processes could write");
  }
  return temporary;
}

/** A new private (mode 0700) directory of the worker's, named `prefix` and a random suffix, in {@link workerScratchBase}. The caller removes it. */
export async function makeWorkerScratch(prefix: string, options: WorkerScratchOptions = {}): Promise<string> {
  return await mkdtemp(join(await workerScratchBase(options), prefix));
}
