// Stdio MCP host redesign (T6), design section 14: a task runner that runs the steps of a runner task in this machine's processes, for the integration tests. It is NOT for
// production: the controller's main.ts never builds it. Each serve or probe task does what the two containers do (the real fetch step, then the real bridge on a loopback port), with
// the same environment names and the same checks; the only difference is the confinement, which is the program itself (no setpriv or prlimit on a developer's machine).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, type Bridge } from "./bridge.js";
import { bootstrapEnvironment } from "./bootstrap.js";
import { fetchBundle } from "./fetch.js";
import type { RunnerTaskInfo, RunnerTaskSpec, RunnerTaskStatus, StopReason, TaskRunner } from "./task-runner.js";

export interface LocalRunnerOptions {
  /** Where the fetch step downloads from (the controller's runner listener). */
  controllerUrl: string;
  /** Runs the install task's program with the environment the controller gave the `install` container. Resolves with its exit code. */
  installStep?: (environment: Record<string, string>) => Promise<number>;
  /** The values of a server's declared secrets (a real runner has ECS inject them). */
  secrets?: (serverId: string) => Record<string, string>;
  workRoot?: string;
  /** Called when a task is started, for tests to look at (the spec holds the tokens, so it is for tests only). */
  onStart?: (taskId: string, spec: RunnerTaskSpec) => void;
}

interface LocalTask {
  info: RunnerTaskInfo;
  spec: RunnerTaskSpec;
  state: RunnerTaskStatus;
  folder?: string;
  server?: Server | undefined;
  bridge?: Bridge;
  stopped: boolean;
  stoppedFor?: StopReason;
}

export function localTaskRunner(options: LocalRunnerOptions): TaskRunner & { stopAll(): Promise<void>; started(): Array<{ taskId: string; spec: RunnerTaskSpec; stoppedFor?: StopReason | undefined }> } {
  const tasks = new Map<string, LocalTask>();
  let counter = 0;

  async function teardown(task: LocalTask): Promise<void> {
    await task.bridge?.close().catch(() => undefined);
    const server = task.server;
    task.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    if (task.folder !== undefined) await rm(task.folder, { recursive: true, force: true });
  }

  async function runServe(task: LocalTask): Promise<void> {
    const spec = task.spec;
    const root = options.workRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    task.folder = await mkdtemp(join(root, "local-runner-"));
    const bundleDir = join(task.folder, "bundle");
    const home = join(task.folder, "home");
    const temp = join(task.folder, "tmp");
    await Promise.all([bundleDir, home, temp].map((directory) => mkdir(directory)));
    // Each container redeems its one-time nonce at the controller, from this machine's loopback address (the task's address here), as a real container does.
    const fetchEnvironment = { ...(spec.containers.fetch ?? {}) };
    const serverEnvironment = { ...(spec.containers.server ?? {}) };
    await bootstrapEnvironment(fetchEnvironment, { delayMs: 20 });
    await bootstrapEnvironment(serverEnvironment, { delayMs: 20 });
    // Step 1, the `fetch` container: the real fetch step.
    await fetchBundle({ controllerUrl: fetchEnvironment.MCP_CONTROLLER_URL ?? options.controllerUrl, token: fetchEnvironment.MCP_RUNNER_TOKEN ?? "", bundleHash: fetchEnvironment.MCP_BUNDLE_HASH ?? "", destination: bundleDir, getuid: () => 10_002, getgid: () => 10_002 });
    if (task.stopped) return;
    // Step 2, the `server` container: the real bridge, listening on a loopback port.
    const secretEnv = JSON.parse(serverEnvironment.MCP_SECRET_ENV ?? "[]") as string[];
    const bridge = createBridge({
      token: serverEnvironment.MCP_RUNNER_TOKEN ?? "", bundleHash: serverEnvironment.MCP_BUNDLE_HASH ?? "", bundleDir, packageName: serverEnvironment.MCP_PACKAGE_NAME ?? "",
      args: JSON.parse(serverEnvironment.MCP_SERVER_ARGS ?? "[]") as string[], secretEnv, memoryMiB: Number(serverEnvironment.MCP_MEMORY_MIB ?? 512), environment: { ...(options.secrets?.(spec.serverId) ?? {}) },
      homeDir: home, tmpDir: temp, confine: (program, args) => ({ file: process.execPath, args: [program, ...args] }), getuid: () => 10_003, getgid: () => 10_003,
      onChildExit: () => { task.state = { state: "stopped", exitCode: 1 }; },
    });
    task.bridge = bridge;
    const server = createServer((req, res) => { void bridge.handle(req, res); });
    task.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    task.state = { state: "running", address: "127.0.0.1", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    await bridge.start();
  }

  return {
    instanceId: "local",
    async start(spec) {
      counter += 1;
      const taskId = `local-${counter}`;
      const task: LocalTask = {
        spec, state: { state: "pending", address: "127.0.0.1" }, stopped: false,
        info: { taskId, purpose: spec.purpose, serverId: spec.serverId, approval: spec.approval, family: spec.family, owner: "local", startedAt: Date.now(), state: "pending" },
      };
      tasks.set(taskId, task);
      options.onStart?.(taskId, spec);
      const finish = (code: number): void => { if (task.state.state !== "stopped") task.state = { state: "stopped", exitCode: code }; };
      if (spec.purpose === "install") {
        task.state = { state: "running", address: "127.0.0.1" };
        void (options.installStep?.({ ...(spec.containers.install ?? {}) }) ?? Promise.resolve(1)).then(finish, () => finish(1));
      } else {
        void runServe(task).catch(() => { finish(1); void teardown(task); });
      }
      return taskId;
    },
    async stop(taskId, reason) {
      const task = tasks.get(taskId);
      if (task === undefined || task.stopped) return;
      task.stopped = true;
      task.stoppedFor = reason;
      task.state = { state: "stopped" };
      await teardown(task);
    },
    async describe(taskId) {
      const task = tasks.get(taskId);
      return task === undefined ? undefined : task.state;
    },
    async list() {
      return [...tasks.values()].filter((task) => !task.stopped && task.state.state !== "stopped").map((task) => ({ ...task.info, state: task.state.state === "running" ? "running" as const : "pending" as const }));
    },
    async stopAll() {
      await Promise.all([...tasks.values()].map(async (task) => { task.stopped = true; task.state = { state: "stopped" }; await teardown(task); }));
    },
    started: () => [...tasks.entries()].map(([taskId, task]) => ({ taskId, spec: task.spec, stoppedFor: task.stoppedFor })),
  };
}
