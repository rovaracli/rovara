import { WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, agentXError, redactText } from "@agentx/contracts";
import { containWorkspace } from "./publish.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
import { sweepWorkspaceContainers } from "./workspace-containers.js";

/**
 * The steps that only read the workspace for someone else's judgement. Each runs after the coding session, in a workspace it
 * wrote, so a program that session left running (a background job, a `setsid` daemon, a process inside the task sandbox or the
 * project's dev container, which persists between operations) could change files, the rule-file scratch area or results while
 * the reader reads them.
 */
export const STOPS_PROGRAMS_FIRST_MODES: ReadonlySet<string> = new Set(["REVIEW", "FEEDBACK_REVIEW", "PLAN_CRITIQUE", "UNDERSTAND"]);

export interface StopBeforeReadingOptions {
  /** Test seams: the same two steps publication takes. */
  stopWorkspaceProcesses?: (rootPath: string) => Promise<{ stopped: number } | void>;
  sweepWorkspaceContainers?: (rootPath: string) => Promise<{ removed: number }>;
  log?: (event: Record<string, unknown>) => void;
}

/**
 * Before one of those steps reads anything, stops every program the coding session started the way publication does before it
 * takes a push token (publish.ts): the worker's own leftover processes (workspace-processes.ts), then every container but the
 * worker's own (workspace-containers.ts), the task sandbox and the dev container included, repeated until a round finds neither.
 * Nothing is started in their place here: the step opens its own task sandbox afterwards, and does not start the dev container
 * (its lifecycle commands are the repository's), so no program of the project runs before the read.
 *
 * Fails closed with one fixed reason (WORKFLOW_LEFTOVER_PROCESSES_MESSAGE). What went wrong is logged for the operator and is never
 * part of the reason: it can carry a container name or a program's output. The attempt is bounded by the rounds of
 * `containWorkspace`; nothing here retries.
 */
export async function stopProgramsBeforeReading(rootPath: string, options: StopBeforeReadingOptions = {}): Promise<void> {
  const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify({ component: "worker", ...event })));
  try {
    await containWorkspace(rootPath, {
      sweep: options.sweepWorkspaceContainers ?? ((root: string) => sweepWorkspaceContainers({ rootPath: root })),
      stop: options.stopWorkspaceProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })),
    });
  } catch (error) {
    log({ event: "read-step.stop-programs.failed", reason: redactText(error instanceof Error ? error.message : String(error)).slice(0, 300) });
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX ${WORKFLOW_LEFTOVER_PROCESSES_MESSAGE}, so it did not read the workspace`);
  }
}
