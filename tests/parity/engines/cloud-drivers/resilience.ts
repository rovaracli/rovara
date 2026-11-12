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
    // A person writes to the task from its page. On Cloud's path a Slack-started Quick task has NO agent session: one is made at start only for an agent run
    // (`prepared`, aws/developer-tasks/start.ts), and lazily only for a task with `agent` and `origin` (agent-sessions/create.ts:296), which a Slack workflow
    // task never gets, so the message is refused "session not found" even after the page is read. The core gives every task a session at start. Both answers are
    // recorded as a `features` word (`session.message:accepted|refused:<status>`), so the difference is compared, not skipped.
    options: () => ({ agentSessions: true }),
    async run(ctx, step) {
      const text = (step as Extract<Step, { do: "session.message" }>).text;
      const opened = await asMaya(ctx, "GET", `/v1/dev/tasks/${ctx.e2e.taskId()}`);
      if (opened.statusCode !== 200) throw new Error(`Cloud refused the task page read (${String(opened.statusCode)})`);
      const sent = await asMaya(ctx, "POST", `/v1/app/sessions/${lazySessionId(ctx.e2e.taskId())}/messages`, { requestId: randomUUID(), kind: "steer", text });
      ctx.extra.features.push(sent.statusCode < 400 ? "session.message:accepted" : `session.message:refused:${String(sent.statusCode)}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "cloud.sessionMessage", status: sent.statusCode, body: sent.body.slice(0, 300) }));
      await ctx.e2e.settle();
    },
  },
};
