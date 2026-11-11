// Plan 5 Task 7b: a session follows a task's end and a budget pause as they happen. Plan 3 tells every registered handler once when a task ends
// (`registerTaskEndHandler`) and when a run is paused for money (`registerTaskPauseHandler`). These two handlers refresh the task's session (or, for a chain
// step, its chain's session) through `refreshSessionSummary`, so it no longer waits for the stream or the sweep. They add no rule of their own: `isEnded` (the
// summary's) stays what ends a session, so an end event for a task that is still open (a plain task between turns) leaves its session open, and a pause is
// only ever a pause.
//
// A handler never fails Plan 3's telling. Plan 3 runs its handlers in order and, when one throws, stops at it and retries from it; a session store that is down
// must not hold back the handlers after this one (Plan 4's chains), so a failure here is logged and swallowed. What it could not do the stream and the sweep do.
// The handlers are safe to hear twice (a retried pause, an end told again after a lost record): a second refresh finds the same summary and writes nothing.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SessionIdSchema, type OrgId } from "@rovara-code/contracts";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { registerTaskEndHandler, registerTaskPauseHandler, type TaskEndDependencies, type TaskEndHandler, type TaskPauseHandler } from "../agents/task-end.js";
import { refreshSessionSummary, type ChainSessionSource, type LocalSessionSource, type SummaryDependencies } from "./summary.js";

/** The sources a chain or a local session reads its facts from (Plan 4 and Task 18 supply them); the same ones the sweep is given. */
export interface SessionTaskHandlerOptions {
  chains?: ChainSessionSource | undefined;
  local?: LocalSessionSource | undefined;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** Refreshes the session of the task an event is about. Never throws. */
async function refreshSessionOfTask(deps: TaskEndDependencies, event: { orgId: OrgId; taskId: string }, options: SessionTaskHandlerOptions): Promise<void> {
  const log = (name: string, fields: Record<string, unknown>) => (deps.log ?? ((entry, detail) => console.log(JSON.stringify({ component: "broker", event: entry, ...detail }))))(name, fields);
  try {
    const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(event.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task === undefined) return;
    // The task's own org decides which session is read, and the event must agree with it: an event can never reach another org's session.
    if (task.orgId !== event.orgId) {
      log("agent_session.task_event_org_mismatch", { taskId: event.taskId });
      return;
    }
    // A chain step has no session of its own: the chain run's is the one that follows it. A task from before sessions has none.
    const sessionId = SessionIdSchema.safeParse(task.sessionId ?? task.chain?.chainRunId);
    if (!sessionId.success) return;
    const summaryDeps: SummaryDependencies = {
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now,
      log: (entry) => { const { event: name, ...detail } = entry; log(typeof name === "string" ? name : "agent_session.log", detail); },
      ...(options.chains === undefined ? {} : { chains: options.chains }),
      ...(options.local === undefined ? {} : { local: options.local }),
    };
    await refreshSessionSummary(summaryDeps, event.orgId, sessionId.data);
  } catch (error) {
    log("agent_session.task_event_refresh_failed", { taskId: event.taskId, error: errorName(error) });
  }
}

/** The handler Plan 3 tells when a task ends. */
export const sessionTaskEndHandler = (options: SessionTaskHandlerOptions = {}): TaskEndHandler => (deps, event) => refreshSessionOfTask(deps, event, options);

/** The handler Plan 3 tells when a task's run is paused for money. */
export const sessionTaskPauseHandler = (options: SessionTaskHandlerOptions = {}): TaskPauseHandler => (deps, event) => refreshSessionOfTask(deps, event, options);

let registered: Array<() => void> = [];

/** Removes what `registerAgentSessionTaskHandlers` registered. */
export function unregisterAgentSessionTaskHandlers(): void {
  for (const remove of registered) remove();
  registered = [];
}

/**
 * Registers the end and pause handlers (at broker start). Registering again replaces the earlier registration, so a process that builds more than one broker
 * still has one pair. Returns the function that removes it. Plan 3 has no resume handler: a resumed task shows running through the stream and the sweep.
 */
export function registerAgentSessionTaskHandlers(options: SessionTaskHandlerOptions = {}): () => void {
  unregisterAgentSessionTaskHandlers();
  const own = [registerTaskEndHandler(sessionTaskEndHandler(options)), registerTaskPauseHandler(sessionTaskPauseHandler(options))];
  registered = own;
  return () => {
    for (const remove of own) remove();
    if (registered === own) registered = [];
  };
}
