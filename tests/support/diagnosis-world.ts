// A world for the Fix with agent tests: the session world (people, projects, a task and its session), a task view that reports a failed task with an ErrorRef, and the diagnosis dependencies on the
// same fake table. Nothing here is a secret; tokens in planted text are built at run time.
import { randomUUID } from "node:crypto";
import { taskFailureErrorRef, type DeveloperTaskView, type ErrorRef } from "@agentx/contracts";
import type { DiagnosisDependencies } from "../../packages/broker/src/diagnosis/light.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, MAX, ORG_A, PRIYA, sessionWorld } from "./agent-session-world.js";
import { capturingAuditDeps } from "./audit-capture.js";

export { ARJUN, MAX, ORG_A, PRIYA };
export const TAG_KEY = "t".repeat(64);

export interface SentMessage { body: string; groupId: string; deduplicationId: string; attributes: unknown }

export interface DiagnosisWorldOptions {
  enabled?: boolean;
  edition?: "enterprise" | "public";
  /** What the task's failure message and error events say (planted text goes here). */
  failureMessage?: string;
  events?: Array<{ kind: "status" | "progress" | "tool" | "message" | "error"; text: string }>;
  queueFails?: boolean;
  /** 2026-11-03: whether the company has a usable AI provider of its own for the project (default yes). `unreadable`: the company's sources can't be read. */
  provider?: boolean | "unreadable";
}

export function diagnosisWorld(options: DiagnosisWorldOptions = {}) {
  const w = sessionWorld();
  const made = w.seedSession({ kind: "task", owner: PRIYA });
  w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "use");
  const taskRecord = () => w.db.get({ pk: `DEVTASK#${made.taskId}`, sk: "META" })! as unknown as DeveloperTaskRecord;
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const sent: SentMessage[] = [];
  let operationId = randomUUID();
  const failure = { category: "task_failed" as const, message: options.failureMessage ?? "The test step failed." };
  const current = (): { errorRef: ErrorRef | undefined } => ({ errorRef: taskFailureErrorRef({ taskId: made.taskId, failure: { category: failure.category }, operationId, at: "2026-10-22T09:00:00.000Z" }) });
  const taskViews: string[] = [];
  const access = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
  const table = { documentClient: w.db, tableName: "state" };
  const diagnosis: DiagnosisDependencies = {
    ...table, now: () => w.clock.now, enabled: options.enabled ?? true, edition: options.edition ?? "enterprise",
    queue: { send: async (message: SentMessage) => { if (options.queueFails === true) throw new Error("queue down"); sent.push(message); } },
    providerUsable: async () => { if (options.provider === "unreadable") throw new Error("sources unreadable"); return options.provider !== false; },
    authority: { ...table, access },
    audit: { ...table, ...audit.deps },
    context: {
      ...table, edition: options.edition ?? "enterprise", tagKey: TAG_KEY,
      taskView: async (task) => {
        taskViews.push(task.taskId);
        return {
          taskId: task.taskId, title: task.title ?? "Bump the Stripe SDK", project: task.project, status: "FAILED", failure, ...current(),
          events: (options.events ?? []).map((event, index) => ({ at: `2026-10-22T09:00:${String(index).padStart(2, "0")}.000Z`, kind: event.kind, text: event.text })),
          workflow: { revision: 1, stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], pullRequests: [] },
        } as unknown as DeveloperTaskView;
      },
      projectDefinition: async () => ({ devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json" }, repositories: ["web"], allowedWebsites: 2 }),
      setupState: async () => undefined,
    },
  };
  return {
    w, made, diagnosis, audit, sent, taskViews, taskRecord, access, table,
    /** The error reference the app shows for the task's current failure. */
    ref: (): ErrorRef => current().errorRef!,
    /** The operation retried: the error as it stood is no longer current. */
    retried: () => { operationId = randomUUID(); },
    caller: (developerId: string) => ({ orgId: ORG_A, developerId }),
  };
}
export type DiagnosisWorld = ReturnType<typeof diagnosisWorld>;
