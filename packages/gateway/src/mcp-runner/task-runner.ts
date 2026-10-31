// Stdio MCP host redesign (T6), design sections 2 and 6: how the controller starts and stops the tasks that hold customer code.
//
// The controller never runs a package. It asks a `TaskRunner` for a task: an install task, a probe task or a serve task (a "runner"). The real runner is ECS (ecs-runner.ts);
// the local runner (local-runner.ts) runs the same steps in this machine's processes, for tests. Everything the controller does is written against this interface, so the
// state machine (starts, idle stops, leftovers, crashes) is tested against a fake without any cloud.

/** What a task is for. An install task has no secrets; a probe task has the secrets of a pending proposal; a serve task has one server's secrets. */
export type RunnerPurpose = "install" | "probe" | "serve";
export const RUNNER_PURPOSES: readonly RunnerPurpose[] = ["install", "probe", "serve"];

/** Why the controller stopped a task. Recorded with the stop (ECS keeps it) and in the audit log; it is never text from a task. */
export type StopReason =
  | "idle" | "lifetime" | "disabled" | "secret_replaced" | "crash" | "leftover" | "room" | "approval_changed" | "tools_changed" | "failed" | "done" | "shutdown";

export interface RunnerTaskSpec {
  purpose: RunnerPurpose;
  /** The server this task is for. A probe task has the id of the proposal; an install task has "install". */
  serverId: string;
  /** The first 12 characters of the bundle hash the task was approved to run (empty for an install). A task whose tag differs from the approval is stopped. */
  approval: string;
  /** The task definition family. Always starts with `rovara-mcp-`. It is the tag; what is run is `taskDefinition`. */
  family: string;
  /**
   * The exact task definition revision to run (an ARN ending `:<revision>`), the one the controller registered or verified. A serve or probe task is never started from a family
   * name, which would run whatever revision is the latest. An install task may name its static family (the infrastructure owns it).
   */
  taskDefinition: string;
  /** The server's own security group. Absent: the runner's default (install tasks). */
  securityGroupId?: string | undefined;
  /** The size the task definition has (the local runner uses its memory). */
  size: { cpu: number; memoryMiB: number };
  /** Environment variables per container name. These are the only per-task values: the token, the bundle hash, the package, the names of its secrets. */
  containers: Record<string, Record<string, string>>;
}

export type RunnerTaskStatus =
  | { state: "pending"; /** The private address of the task's network interface, when it has one yet. */ address?: string }
  | { state: "running"; /** Where the bridge answers: `http://<private ip>:8080`. Absent for an install task. */ endpoint?: string; address?: string }
  | { state: "stopped"; /** Why the task stopped, when the runner knows: a container's exit code. */ exitCode?: number };

export interface RunnerTaskInfo {
  taskId: string;
  purpose: RunnerPurpose;
  serverId: string;
  approval: string;
  family: string;
  /** Milliseconds since the epoch. */
  startedAt: number;
  state: "pending" | "running" | "stopped";
}

export interface TaskRunner {
  /** Starts a task and returns its id. Throws when the task cannot be started. */
  start(spec: RunnerTaskSpec): Promise<string>;
  /** Stops a task. Stopping a task that is already gone is not an error. */
  stop(taskId: string, reason: StopReason): Promise<void>;
  /** The state of a task, or undefined when the runner does not know it. */
  describe(taskId: string): Promise<RunnerTaskStatus | undefined>;
  /**
   * Every task of this controller that is not stopped, from the cloud's own records (not from memory), so a controller that restarted can find what it started. Throws when the
   * runner cannot be read: the caller then stops nothing.
   */
  list(): Promise<RunnerTaskInfo[]>;
}

/** A task definition family of this feature always has this prefix; the controller's IAM is scoped to it (T8). */
export const RUNNER_FAMILY_PREFIX = "rovara-mcp-";

export const serveFamily = (serverId: string): string => `${RUNNER_FAMILY_PREFIX}serve-${serverId}`;
export const approvalOf = (bundleHash: string): string => bundleHash.slice(0, 12);
