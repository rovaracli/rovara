// Stdio MCP host redesign (T11): a task runner for the Linux job that runs the REAL runner image in Docker the way ECS runs a runner task: each container read-only, every capability
// dropped, the image's own non-root user, an init process, the bundle volume read-write for `fetch` and read-only for `server`, home and tmp from the image's VOLUME paths. It shares
// the host's network (the controller listens on this machine's loopback, and the programs accept plain http only there); what the job proves is the confinement of the processes and
// files, not ECS's security groups.
//
// Not for production: the controller's main.ts never builds it. Commands are run with execFile (no shell), and every name it makes starts with `rovara-mcp-ci-`.
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { RunnerTaskInfo, RunnerTaskSpec, RunnerTaskStatus, StopReason, TaskRunner } from "../../../packages/gateway/src/mcp-runner/task-runner.js";

const execFileAsync = promisify(execFile);

export type Docker = (...args: string[]) => Promise<string>;
export const realDocker: Docker = async (...args) => (await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/** The flags ECS gives every container of a runner task. */
export const ECS_FLAGS = ["--read-only", "--cap-drop", "ALL", "--init", "--network", "host"] as const;
const NODE = "/usr/local/bin/node";

export interface DockerRunnerOptions {
  image: string;
  /** The registry fixture's certificate authority, mounted into the install container. */
  caFile: string;
  docker?: Docker;
  /** Labels every container and volume, so a cleanup finds what a run made. */
  runLabel: string;
}

interface Task {
  taskId: string;
  spec: RunnerTaskSpec;
  containers: string[];
  volume?: string;
  port?: number;
  state: RunnerTaskStatus;
  stopped: boolean;
  stoppedFor?: StopReason;
  fetchOutput?: string;
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
});

const envFlags = (environment: Record<string, string>): string[] => Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

export function dockerTaskRunner(options: DockerRunnerOptions): TaskRunner & { started(): Task[]; volumeOf(taskId: string): string | undefined; containerOf(taskId: string): string | undefined; stopAll(): Promise<void> } {
  const docker = options.docker ?? realDocker;
  const tasks = new Map<string, Task>();
  let counter = 0;
  const label = ["--label", `rovara.mcp-ci=${options.runLabel}`];

  async function runInstall(task: Task, name: string): Promise<void> {
    task.containers.push(name);
    await docker("run", "-d", "--name", name, ...label, ...ECS_FLAGS, "--user", "10002:10002", "-v", `${options.caFile}:/ca.pem:ro`, "-e", "ROVARA_MCP_NPM_CAFILE=/ca.pem", ...envFlags(task.spec.containers.install ?? {}), options.image, NODE, "/opt/mcp-runner/install.mjs");
    task.state = { state: "running", address: "127.0.0.1" };
  }

  async function runServe(task: Task, name: string): Promise<void> {
    const volume = `${name}-bundle`;
    task.volume = volume;
    await docker("volume", "create", ...label, volume);
    // Step 1, the `fetch` container: it must succeed, or the `server` container is never started (ECS: dependsOn fetch SUCCESS).
    const fetchName = `${name}-fetch`;
    task.containers.push(fetchName);
    try {
      await docker("run", "--name", fetchName, ...label, ...ECS_FLAGS, "--user", "10002:10002", "-v", `${volume}:/bundle`, ...envFlags(task.spec.containers.fetch ?? {}), options.image, NODE, "/opt/mcp-runner/fetch.mjs");
    } catch (error) {
      const out = (error as { stdout?: unknown }).stdout;
      task.fetchOutput = typeof out === "string" ? out : "";
      task.state = { state: "stopped", exitCode: 1 };
      return;
    }
    if (task.stopped) return;
    // Step 2, the `server` container: the bundle read-only, its own home and tmp (the image's VOLUME paths), the open-files limit ECS sets.
    const port = await freePort();
    task.port = port;
    const serverName = `${name}-server`;
    task.containers.push(serverName);
    await docker("run", "-d", "--name", serverName, ...label, ...ECS_FLAGS, "--user", "10003:10003", "--ulimit", "nofile=1024:1024", "-v", `${volume}:/bundle:ro`, ...envFlags({ ...(task.spec.containers.server ?? {}), PORT: String(port) }), options.image);
    task.state = { state: "running", address: "127.0.0.1", endpoint: `http://127.0.0.1:${port}` };
  }

  return {
    instanceId: "dockerci",
    async start(spec) {
      counter += 1;
      const taskId = `rovara-mcp-ci-${process.pid}-${counter}`;
      const task: Task = { taskId, spec, containers: [], state: { state: "pending", address: "127.0.0.1" }, stopped: false };
      tasks.set(taskId, task);
      const run = spec.purpose === "install" ? runInstall(task, taskId) : runServe(task, taskId);
      void run.catch(() => { if (task.state.state !== "stopped") task.state = { state: "stopped", exitCode: 1 }; });
      return taskId;
    },
    async stop(taskId, reason) {
      const task = tasks.get(taskId);
      if (task === undefined || task.stopped) return;
      task.stopped = true;
      task.stoppedFor = reason;
      task.state = { state: "stopped" };
      for (const container of task.containers) await docker("rm", "-f", container).catch(() => undefined);
      if (task.volume !== undefined) await docker("volume", "rm", "-f", task.volume).catch(() => undefined);
    },
    async describe(taskId) {
      const task = tasks.get(taskId);
      if (task === undefined) return undefined;
      if (task.state.state === "running" && !task.stopped) {
        // A container that exited on its own is a stopped task (an install task ends this way when it has reported).
        const last = task.containers.at(-1)!;
        const status = await docker("inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", last).catch(() => "gone 1");
        const [state, exit] = status.split(" ");
        if (state !== "running" && state !== "created") return { state: "stopped", exitCode: Number(exit) };
      }
      return task.state;
    },
    async list() {
      return [...tasks.values()].filter((task) => !task.stopped && task.state.state !== "stopped").map((task): RunnerTaskInfo => ({
        taskId: task.taskId, purpose: task.spec.purpose, serverId: task.spec.serverId, approval: task.spec.approval, family: task.spec.family, owner: "dockerci", startedAt: 0, state: task.state.state === "running" ? "running" : "pending",
      }));
    },
    started: () => [...tasks.values()],
    volumeOf: (taskId) => tasks.get(taskId)?.volume,
    containerOf: (taskId) => tasks.get(taskId)?.containers.at(-1),
    async stopAll() {
      for (const task of tasks.values()) await this.stop(task.taskId, "shutdown");
      const left = await docker("ps", "-aq", "--filter", `label=rovara.mcp-ci=${options.runLabel}`).catch(() => "");
      if (left !== "") await docker("rm", "-f", ...left.split("\n")).catch(() => undefined);
      const volumes = await docker("volume", "ls", "-q", "--filter", `label=rovara.mcp-ci=${options.runLabel}`).catch(() => "");
      if (volumes !== "") await docker("volume", "rm", "-f", ...volumes.split("\n")).catch(() => undefined);
    },
  };
}
