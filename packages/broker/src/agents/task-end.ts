// Plan 3, Task 22 (G7): the single place a task ends. STUB until the implementation commit.
import type { OrgId, PauseScope } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";

export type TaskEndOutcome = "succeeded" | "failed" | "cancelled" | "creator_removed" | "merged" | "closed";

export interface TaskEndEvent {
  orgId: OrgId;
  taskId: string;
  chain?: { chainRunId: string; stepId: string };
  outcome: TaskEndOutcome;
  finalReport?: string;
  branch?: string;
  pullRequests?: Array<{ repository: string; number: number; url: string }>;
  runLimitUsd: number;
  stopAtUsd?: number;
  spentUsd: number;
}

export interface TaskPauseEvent { orgId: OrgId; taskId: string; chain?: { chainRunId: string; stepId: string }; scope: PauseScope; spendRequestId?: string }

export interface TaskEndHost {
  releaseWorkspace?(taskId: string): Promise<unknown>;
  blockKeys?(task: DeveloperTaskRecord): Promise<void>;
  spentUsd?(task: DeveloperTaskRecord): Promise<number>;
}

export interface TaskEndDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  agentRuns?: TaskEndHost | undefined;
}

export type TaskEndHandler = (deps: TaskEndDependencies, event: TaskEndEvent) => Promise<void>;
export type TaskPauseHandler = (deps: TaskEndDependencies, event: TaskPauseEvent) => Promise<void>;

export function registerTaskEndHandler(handler: TaskEndHandler): () => void {
  void handler;
  throw new Error("not implemented");
}

export function registerTaskPauseHandler(handler: TaskPauseHandler): () => void {
  void handler;
  throw new Error("not implemented");
}

export async function onTaskEnded(deps: TaskEndDependencies, task: DeveloperTaskRecord, outcome: TaskEndOutcome, detail: { finalReport?: string; branch?: string } = {}): Promise<"called" | "already_ended"> {
  void deps; void task; void outcome; void detail;
  throw new Error("not implemented");
}

export async function onTaskPaused(deps: TaskEndDependencies, task: DeveloperTaskRecord, scope: PauseScope, spendRequestId?: string): Promise<void> {
  void deps; void task; void scope; void spendRequestId;
  throw new Error("not implemented");
}
