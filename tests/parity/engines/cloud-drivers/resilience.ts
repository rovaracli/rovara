// Cloud drivers: decision timeouts, notifications, races, lost workers, session messages (areas 1, 5, 6, 19, 21). Review send-backs are in task-flow.ts.
import { randomUUID } from "node:crypto";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import type { Step } from "../../harness/types.js";
import { lazySessionId } from "../../../../packages/broker/src/agent-sessions/create.js";
import { asMaya } from "./task-flow.js";

type Driver = StepDriver<CloudContext, CloudOptions>;
const DAY_MS = 86_400_000;

/** Every scheduled sweep the journey harness can run (dispatch recovery and the session reconciler, merge tracking, webhook recovery), then the notices. */
async function runSchedules(ctx: CloudContext): Promise<void> {
  ctx.memo.lost = [...((ctx.memo.lost as string[] | undefined) ?? []), ...(await ctx.e2e.runRecovery()).lostOperations];
  await ctx.e2e.runMergeRecovery();
  await ctx.e2e.runWebhookRecovery();
  await ctx.e2e.deliverNotices();
  await ctx.e2e.settle();
}

export const RESILIENCE_DRIVERS: Record<string, Driver> = {
  "decision.timeout": {
    async run(ctx, step) {
      const days = (step as Extract<Step, { do: "decision.timeout" }>).days;
      // A day at a time, with the schedules run each day, as the deployed schedules would.
      for (let day = 0; day < days; day += 1) {
        ctx.e2e.clock.advance(DAY_MS);
        await runSchedules(ctx);
      }
    },
  },
  "feature:notifications": {
    // The notifier is fed by the table's stream; the harness delivers what it queued.
    async run(ctx) {
      ctx.e2e.clock.advance(10 * 60_000);
      await ctx.e2e.deliverNotices();
      await ctx.e2e.settle();
    },
  },
  race: {
    supports: (step) => ((step as Extract<Step, { do: "race" }>).steps.every((inner) => inner.do === "plan.approve") ? true : { unsupported: "the Cloud race driver runs concurrent plan approvals only" }),
    async run(ctx, step) {
      const inner = (step as Extract<Step, { do: "race" }>).steps;
      // Both presses reach the broker before either settles (the harness's `concurrently`), as two devices or a double Slack delivery would.
      await ctx.e2e.concurrently(...inner.map(() => () => ctx.e2e.click("agentx_workflow_approve")));
      await ctx.e2e.settle();
    },
  },
  "worker.lost": {
    // The next coding run's compute is lost (no terminal callback ever comes), armed before the run starts.
    async prepare(ctx) { ctx.e2e.worker.crashNext("task:IMPLEMENT"); },
    async run(ctx) {
      await ctx.e2e.settle();
      await runSchedules(ctx);
    },
  },
  "session.message": {
    // Found while writing this driver: a Slack-started Quick task on Cloud's path has NO agent session at all, so there is nothing to message. A session is
    // made at start only for an agent run (`prepared`, aws/developer-tasks/start.ts), and lazily only for a task that has `agent` and `origin`
    // (agent-sessions/create.ts:296), which a Slack workflow task never gets; the messages route answers "session not found". The core gives every task a
    // session at start. Until a Cloud path that has a session is driven here (a task started from the web app with an agent), the step is not covered on
    // Cloud, with this reason (reported as difference R-SESSIONS in the resilience lane's report).
    supports: () => ({ unsupported: "a Slack-started Quick task has no agent session on Cloud's path (agent-sessions/create.ts:296 needs task.agent and task.origin, set only for agent runs), so a message is refused \"session not found\"; the core gives every task a session (difference R-SESSIONS)" }),
    // Cloud's agent sessions are wired in the journey harness only when asked (`agentSessions`), as a deployed install has them.
    options: () => ({ agentSessions: true }),
    async run(ctx, step) {
      const text = (step as Extract<Step, { do: "session.message" }>).text;
      // A person writes from the task's page; Cloud gives a Slack-started task its session the first time the task is read in full (task-view.ts
      // `ensureTaskSession`), under the id both sides derive from the task id. So the page is opened first, as the person's browser would.
      const opened = await asMaya(ctx, "GET", `/v1/dev/tasks/${ctx.e2e.taskId()}`);
      if (opened.statusCode !== 200) throw new Error(`Cloud refused the task page read (${String(opened.statusCode)})`);
      const sessionId = lazySessionId(ctx.e2e.taskId());
      const sent = await asMaya(ctx, "POST", `/v1/app/sessions/${sessionId}/messages`, { requestId: randomUUID(), kind: "steer", text });
      if (sent.statusCode >= 400) throw new Error(`Cloud refused the session message (${String(sent.statusCode)}): ${sent.body.slice(0, 200)}`);
      ctx.memo.sessionMessage = sent.body;
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.sessionMessage", status: sent.statusCode, body: sent.body.slice(0, 300) }));
      await ctx.e2e.settle();
    },
  },
};
