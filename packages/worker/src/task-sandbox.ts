import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { agentXError, type ProjectCommand } from "@agentx/contracts";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { containerBashOperations, runContainerCommand, type ContainerExec } from "./devcontainer.js";
import type { CommandResult } from "./readiness.js";
import { hiddenWorkspaceDirectories } from "./workspace-state.js";
import { createDockerCli, removeContainer, taskContainerExec, type DockerCli } from "./swebench/containers.js";

/**
 * Ruling R56: on an EC2 worker, code the task controls (the agent's shell, project setup and readiness commands, project
 * checks) never runs in the worker's own process namespace, network namespace or user. The worker container has the
 * host's Docker socket and, until the network moves off the host (boot.sh), the instance role, so anything that ran in it
 * had both. A project without a devcontainer gets this sandbox instead: a container with no Docker socket, no host
 * network, no capabilities and only the workspace mounted, without the worker's own state in it (workspace-state.ts). It is started from the worker's own image (the base
 * environment), which AGENTX_SANDBOX_IMAGE names, and removed when the operation ends.
 *
 * A project's devcontainer is the other sandbox (devcontainer.ts, devcontainer-policy.ts).
 */

/** The user-defined bridge network of every sandbox: outbound internet works, the host's network and other containers' do not. */
export const TASK_SANDBOX_NETWORK = "agentx-task";
/** The label every sandbox carries, with the ID of the operation it serves. */
export const TASK_SANDBOX_LABEL = "agentx.task";
/** The `node` user of environments/base/Dockerfile, which the worker also runs as. */
export const TASK_SANDBOX_USER = "1000:1000";
/** The environment variable that names the sandbox image; boot.sh sets it to the worker's own image. */
export const TASK_SANDBOX_IMAGE_ENVIRONMENT = "AGENTX_SANDBOX_IMAGE";
/** `local` or `sandbox`: where a project without a devcontainer runs its commands. Off EC2 only; EC2 is always `sandbox`. */
export const TASK_SHELL_ENVIRONMENT = "AGENTX_TASK_SHELL";
/** The image's init (environments/base/Dockerfile): PID 1 that reaps what a command leaves behind. */
const SANDBOX_INIT = "/usr/bin/tini";
const SANDBOX_START_TIMEOUT_MS = 5 * 60_000;
const DOCKER_CALL_TIMEOUT_MS = 60_000;
/** What hides a folder of the workspace volume that is not the project's. */
const MASK_OPTIONS = "ro,noexec,nosuid,size=4k";

/** The deployed worker image sets this (environments/base/Dockerfile); only EC2 workers run it. */
export function isEc2WorkerRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENTX_WORKER_PROCESS_SCOPE === "container";
}

/**
 * The local shell runs task code as a child of the worker. It stays for tests and for a developer's own machine, and is
 * never a fallback: on the EC2 runtime it is refused.
 */
export function assertLocalTaskExecutionAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  if (isEc2WorkerRuntime(environment)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not run a task's commands inside the worker on an EC2 worker; they run in the task sandbox");
  }
}

/**
 * Pi's local shell, which runs a command as a child of this process. Every use asks first, so on the EC2 runtime a
 * command that reaches it fails with RUNTIME_UNAVAILABLE instead of running in the worker.
 */
export function localBashOperations(environment: NodeJS.ProcessEnv = process.env): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec(command, cwd, options) {
      assertLocalTaskExecutionAllowed(environment);
      return local.exec(command, cwd, options);
    },
  };
}

export type TaskShellKind = "sandbox" | "local";

/** Where a project without a devcontainer runs its commands: the sandbox on EC2 (always), the local shell elsewhere unless the sandbox is asked for. */
export function taskShellFromEnvironment(environment: NodeJS.ProcessEnv = process.env): TaskShellKind {
  const requested = environment[TASK_SHELL_ENVIRONMENT];
  if (requested !== undefined && requested !== "" && requested !== "sandbox" && requested !== "local") {
    throw agentXError("CONFIG_INVALID", `${TASK_SHELL_ENVIRONMENT} must be "sandbox" or "local"`);
  }
  if (requested === "local") assertLocalTaskExecutionAllowed(environment);
  return isEc2WorkerRuntime(environment) || requested === "sandbox" ? "sandbox" : "local";
}

/** How a project without a devcontainer runs its commands: chosen explicitly, never by falling back from the other. */
export type TaskShellSelection =
  | { kind: "local" }
  | { kind: "sandbox"; docker?: DockerCli; image?: string; environment?: NodeJS.ProcessEnv };

/** The selection a worker makes from its environment. */
export function taskShellSelection(environment: NodeJS.ProcessEnv = process.env): TaskShellSelection {
  return taskShellFromEnvironment(environment) === "sandbox" ? { kind: "sandbox", environment } : { kind: "local" };
}

export interface TaskSandboxRunInput {
  name: string;
  taskId: string;
  image: string;
  rootPath: string;
  /** Folders of the workspace volume that are the worker's, not the project's (workspace-state.ts): each gets an empty read-only tmpfs over it. */
  maskedPaths: readonly string[];
}

/** The `docker run` arguments of a sandbox (R56). The workspace is the only mount, at its own path. */
export function taskSandboxRunArgs(input: TaskSandboxRunInput): string[] {
  return [
    "run", "--detach",
    "--name", input.name,
    "--label", `${TASK_SANDBOX_LABEL}=${input.taskId}`,
    "--network", TASK_SANDBOX_NETWORK,
    "--user", TASK_SANDBOX_USER,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--volume", `${input.rootPath}:${input.rootPath}`,
    ...input.maskedPaths.flatMap((path) => ["--tmpfs", `${path}:${MASK_OPTIONS}`]),
    "--workdir", input.rootPath,
    "--entrypoint", SANDBOX_INIT,
    input.image, "--", "sleep", "infinity",
  ];
}

export interface TaskSandboxOptions {
  /** The workspace root (canonical). */
  rootPath: string;
  /** The operation this sandbox serves; it labels the container. */
  taskId: string;
  /** Test seam; default: the host's `docker`. */
  docker?: DockerCli;
  /** Default: AGENTX_SANDBOX_IMAGE in `environment`. */
  image?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * One sandbox container for one operation. It starts on first use (or `start()`), serves every command through
 * `docker exec`, and `dispose()` removes it, whether it started or not.
 */
export class TaskSandbox {
  readonly name: string;
  readonly exec: ContainerExec;
  private readonly docker: DockerCli;
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: TaskSandboxOptions) {
    this.docker = options.docker ?? createDockerCli();
    this.name = `agentx-task-${options.taskId.replace(/[^a-zA-Z0-9_.-]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const exec = taskContainerExec(this.docker, this.name);
    this.exec = async (command, execOptions) => {
      await this.start();
      return exec(command, execOptions);
    };
  }

  /** Starts the container, once; a failed start stays failed. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "the task sandbox was already removed"));
    this.starting ??= this.startContainer();
    return this.starting;
  }

  /** The agent's shell in the sandbox. */
  bashOperations(): BashOperations {
    return containerBashOperations(this.exec);
  }

  /** A project command (setup, readiness) in the sandbox. */
  runCommand(command: ProjectCommand, signal?: AbortSignal): Promise<CommandResult> {
    return runContainerCommand(this.exec, this.options.rootPath, command, signal);
  }

  /** Removes the container. Safe to call again, and when nothing started. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.starting === undefined) return;
    // A start still in flight finishes first, so the removal sees the container it creates.
    await this.starting.catch(() => undefined);
    await removeContainer(this.docker, this.name);
  }

  private async startContainer(): Promise<void> {
    const image = this.options.image ?? (this.options.environment ?? process.env)[TASK_SANDBOX_IMAGE_ENVIRONMENT];
    if (image === undefined || image === "") {
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX has no task sandbox image (${TASK_SANDBOX_IMAGE_ENVIRONMENT}), so it did not run the task's commands`);
    }
    const root = resolve(this.options.rootPath);
    await this.ensureNetwork();
    const maskedPaths = await hiddenWorkspaceDirectories(root);
    const result = await this.docker.run(
      taskSandboxRunArgs({ name: this.name, taskId: this.options.taskId, image, rootPath: root, maskedPaths }),
      { timeoutMs: SANDBOX_START_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 800);
      throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not start the task sandbox${result.timedOut === true ? " (timed out)" : ""}: ${detail || `exit ${String(result.exitCode)}`}`);
    }
  }

  /** Idempotent: another start may create the network between the check and the create. */
  private async ensureNetwork(): Promise<void> {
    const inspect = ["network", "inspect", TASK_SANDBOX_NETWORK];
    if ((await this.docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS })).exitCode === 0) return;
    const created = await this.docker.run(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
    if (created.exitCode === 0) return;
    if ((await this.docker.run(inspect, { timeoutMs: DOCKER_CALL_TIMEOUT_MS })).exitCode === 0) return;
    const detail = (created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX could not create the ${TASK_SANDBOX_NETWORK} network for the task sandbox: ${detail || `exit ${String(created.exitCode)}`}`);
  }
}

/**
 * Removes the sandboxes an earlier worker process left (a crash or a restart skips dispose). The worker calls it once at
 * startup, when none of its own exists yet, so it cannot remove one that is in use.
 */
export async function removeLeftoverTaskSandboxes(docker: DockerCli = createDockerCli()): Promise<number> {
  const listed = await docker.run(["ps", "--all", "--quiet", "--filter", `label=${TASK_SANDBOX_LABEL}`], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  const ids = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "") : [];
  if (ids.length > 0) await docker.run(["rm", "--force", ...ids], { timeoutMs: DOCKER_CALL_TIMEOUT_MS });
  return ids.length;
}

/** The sandbox for a selection, or undefined for the local shell (refused on the EC2 runtime). */
export function taskSandboxFor(selection: TaskShellSelection, input: { rootPath: string; taskId: string }): TaskSandbox | undefined {
  if (selection.kind === "local") {
    assertLocalTaskExecutionAllowed();
    return undefined;
  }
  return new TaskSandbox({
    ...input,
    ...(selection.docker === undefined ? {} : { docker: selection.docker }),
    ...(selection.image === undefined ? {} : { image: selection.image }),
    ...(selection.environment === undefined ? {} : { environment: selection.environment }),
  });
}
