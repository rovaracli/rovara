// The script-token check both engines run, in the same order and words (area 36): a token with read and start on the project starts a task (its client
// is the fixed "Script token"), reads it back, and is refused every decision: approving the plan that waits for the owner, stopping it, closing it.
// The plan that waited stays undecided.
import { outcome, statusClass } from "./outcomes.js";

export interface TokenSurface {
  make(projects: readonly string[], permissions: readonly string[]): Promise<string>;
  call(secret: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The task that waits for the owner's plan decision (started before the token was made). */
  waitingTaskId(): string;
  /** The decisions recorded on a task, read as the owner. */
  decisionsOf(taskId: string): Promise<string[]>;
}

const errorCode = (body: Record<string, unknown>): string => {
  const code = (body.error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "none";
};

export async function runTokenScript(surface: TokenSurface, requestIds: { start: string; decide: string; cancel: string }): Promise<string[]> {
  const words: string[] = [];
  const secret = await surface.make(["payments"], ["read", "start"]);
  words.push(outcome("tokens", "made"));
  const started = await surface.call(secret, "POST", "/v1/dev/tasks", { requestId: requestIds.start, project: "payments", instructions: "Fix the retry bug", workflow: true, workflowPath: "QUICK", client: "pretend-to-be-claude-code" });
  words.push(outcome("tokens", `start:${statusClass(started.status)}`));
  const startedId = (started.body.task as { taskId?: string } | undefined)?.taskId;
  if (startedId !== undefined) {
    const read = await surface.call(secret, "GET", `/v1/dev/tasks/${startedId}`);
    words.push(outcome("tokens", `read:${statusClass(read.status)}`));
    words.push(outcome("tokens", `client:${String((read.body.task as { client?: unknown } | undefined)?.client)}`));
  }
  const waiting = surface.waitingTaskId();
  const decided = await surface.call(secret, "POST", `/v1/dev/tasks/${waiting}/workflow/decision`, { requestId: requestIds.decide, decision: "APPROVE" });
  words.push(outcome("tokens", `decide:${statusClass(decided.status)}:${errorCode(decided.body)}`));
  const cancelled = await surface.call(secret, "POST", `/v1/dev/tasks/${waiting}/cancel`, { requestId: requestIds.cancel });
  words.push(outcome("tokens", `cancel:${statusClass(cancelled.status)}:${errorCode(cancelled.body)}`));
  const closed = await surface.call(secret, "POST", `/v1/dev/tasks/${waiting}/close`, {});
  words.push(outcome("tokens", `close:${statusClass(closed.status)}:${errorCode(closed.body)}`));
  words.push(outcome("tokens", `waiting_task_decisions:${String((await surface.decisionsOf(waiting)).length)}`));
  return words;
}
