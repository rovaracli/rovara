import { spawn, type ChildProcess } from "node:child_process";
import { agentXError } from "@agentx/contracts";

export interface AbortablePiSession {
  abort(): Promise<void>;
  /** Live steer: queues a message for the running session (pi delivers it after the current tool calls, before the next model call). Absent for a step that takes none. */
  steer?(text: string): Promise<void>;
}

export class WorkerOperationCancelledError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} was cancelled`);
    this.name = "WorkerOperationCancelledError";
  }
}

interface ActiveOperation {
  session?: AbortablePiSession;
  processes: Set<ChildProcess>;
}

export class WorkerCancellationController {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly cancelled = new Set<string>();

  register(operationId: string, session?: AbortablePiSession): () => void {
    if (this.active.has(operationId)) throw agentXError("WORKSPACE_BUSY", "operation is already registered");
    const operation: ActiveOperation = {
      ...(session === undefined ? {} : { session }),
      processes: new Set(),
    };
    this.active.set(operationId, operation);
    return () => this.active.delete(operationId);
  }

  spawnTracked(
    operationId: string,
    executable: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ): ChildProcess {
    const operation = this.active.get(operationId);
    if (!operation) throw agentXError("NOT_FOUND", "active operation not found");
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    operation.processes.add(child);
    child.once("exit", () => operation.processes.delete(child));
    return child;
  }

  async cancel(operationId: string, graceMilliseconds = 1_000): Promise<{
    status: "CANCELLED" | "INTERRUPTED";
    remainingProcesses: number;
  }> {
    const operation = this.active.get(operationId);
    if (!operation) throw agentXError("NOT_FOUND", "active operation not found");
    // Marked first: an abort can end the task's prompt normally, and the task must already see
    // that it was cancelled when it checks (#136).
    this.cancelled.add(operationId);
    await operation.session?.abort();
    for (const child of operation.processes) signalProcess(child, "SIGTERM");
    if (operation.processes.size > 0) await delay(graceMilliseconds);
    for (const child of operation.processes) signalProcess(child, "SIGKILL");
    if (operation.processes.size > 0) await delay(50);
    const remainingProcesses = operation.processes.size;
    this.active.delete(operationId);
    return {
      status: remainingProcesses === 0 ? "CANCELLED" : "INTERRUPTED",
      remainingProcesses,
    };
  }

  isCancelled(operationId: string): boolean {
    return this.cancelled.has(operationId);
  }

  /** Whether the operation is registered with a session that takes messages and was not cancelled. */
  canSteer(operationId: string): boolean {
    return this.active.get(operationId)?.session?.steer !== undefined && !this.cancelled.has(operationId);
  }

  /**
   * Gives a message to the session of a running operation. `not_running`: no such operation is registered, it takes no message, or it was cancelled. A rejection of pi's own is thrown
   * (the caller turns it into a fixed outcome; the message is never put in it).
   */
  async steer(operationId: string, text: string): Promise<"steered" | "not_running"> {
    const operation = this.active.get(operationId);
    if (operation?.session?.steer === undefined || this.cancelled.has(operationId)) return "not_running";
    await operation.session.steer(text);
    return "steered";
  }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
