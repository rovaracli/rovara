// Plan 3, Task 22: the agent-step engine. STUB until the implementation commit.
import type { AnyApprovalRecord, ApprovalDependencies } from "./approvals.js";

export type { TaskEndEvent, TaskEndOutcome, TaskPauseEvent } from "./task-end.js";
export { onTaskEnded, registerTaskEndHandler, registerTaskPauseHandler } from "./task-end.js";
export { CHATOPS_PATTERNS, prepareSlackReport } from "./slack-report.js";

export type AgentRunEngineDependencies = ApprovalDependencies;

export async function advanceAgentRun(deps: AgentRunEngineDependencies, taskId: string): Promise<string> {
  void deps; void taskId;
  throw new Error("not implemented");
}

export async function onAgentStepFinished(deps: AgentRunEngineDependencies, input: { taskId: string; operationId: string; outcome: string; report?: string }): Promise<void> {
  void deps; void input;
  throw new Error("not implemented");
}

export async function onWriteDecided(deps: AgentRunEngineDependencies, record: AnyApprovalRecord): Promise<void> {
  void deps; void record;
  throw new Error("not implemented");
}
