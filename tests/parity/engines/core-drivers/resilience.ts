// Core drivers: decision timeouts, notifications, races, lost workers, session messages (areas 1, 5, 6, 19, 21). Review send-backs are in task-flow.ts.
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import type { Step } from "../../harness/types.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;
const DAY_MS = 86_400_000;

/** Everything the core's timers do (relay, dispatch, recovery sweep, session sweep, notices, merge tracking), a few times, as the schedules would. */
async function runSchedules(ctx: CoreContext, passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) await ctx.runtime.tick();
}

export const RESILIENCE_DRIVERS: Record<string, Driver> = {
  "decision.timeout": {
    async run(ctx, step) {
      const days = (step as Extract<Step, { do: "decision.timeout" }>).days;
      for (let day = 0; day < days; day += 1) {
        ctx.clock.advance(DAY_MS);
        await runSchedules(ctx, 2);
      }
    },
  },
  "feature:notifications": {
    // The core batches needs-you notices (one message at most every few minutes); the session sweep queues them and the tick delivers them.
    async run(ctx) {
      ctx.clock.advance(10 * 60_000);
      await runSchedules(ctx);
    },
  },
  race: {
    supports: (step) => ((step as Extract<Step, { do: "race" }>).steps.every((inner) => inner.do === "plan.approve") ? true : { unsupported: "the core race driver runs concurrent plan approvals only" }),
    async run(ctx, step) {
      const inner = (step as Extract<Step, { do: "race" }>).steps;
      // Both presses read the same plan page (the same request, revision and digest) and post at once.
      const outcomes = await Promise.allSettled(inner.map(() => ctx.decidePlan("approve")));
      const taken = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
      if (taken === 0) throw new Error(`no approval of the race was taken: ${outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "ok")).join("; ")}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.race", taken, refused: outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [String(outcome.reason).slice(0, 160)] : [])) }));
    },
  },
  "worker.lost": {
    // The coding run is handed to the machine and never answered; the machine is then gone (terminated, as an EC2 reclaim or a crashed host would leave it).
    async run(ctx) {
      const job = await ctx.take();
      const workspace = await ctx.store.get({ pk: `WORKSPACE#${ctx.task.workspaceId}`, sk: "META" });
      const machineId = (workspace?.machine as { machineId?: string } | undefined)?.machineId;
      if (machineId !== undefined) await ctx.world.machines.terminate(machineId);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.workerLost", mode: ctx.modeOf(job), machineId }));
      // Hours pass with every sweep running, as on Cloud (whose reconciler finds the lost compute on its next run).
      for (let hour = 0; hour < 3; hour += 1) {
        ctx.clock.advance(3_600_000);
        await runSchedules(ctx, 2);
      }
    },
  },
  "session.message": {
    async run(ctx, step) {
      const text = (step as Extract<Step, { do: "session.message" }>).text;
      const task = await ctx.readTask();
      const sessionId = typeof task?.sessionId === "string" ? task.sessionId : undefined;
      if (sessionId === undefined) throw new Error("the core task has no session to message");
      const sent = await ctx.api(`/v1/app/sessions/${sessionId}/messages`, { method: "POST", body: { requestId: "33333333-3333-4333-8333-333333333333", kind: "steer", text } });
      ctx.extra.features.push(sent.status < 400 ? "session.message:accepted" : `session.message:refused:${String(sent.status)}`);
      if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "core.sessionMessage", status: sent.status, body: JSON.stringify(sent.body).slice(0, 300) }));
      await ctx.runtime.tick();
    },
  },
};
