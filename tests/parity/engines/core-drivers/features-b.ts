// Core drivers: Tracker intake, Slack channel, model selection, audit ledger, script tokens, realtime, outbound events (areas 18, 20, 24, 26, 36, 40, 43).
import type { WorkerInvocation } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { callWithCoreToken, makeCoreToken } from "../features-b-support/core-tokens.js";
import { coreLedgerOrder, ledgerWords } from "../features-b-support/audit-order.js";
import { modelWords } from "../features-b-support/models.js";
import { realtimeWords } from "../features-b-support/realtime.js";
import { logWords, outcome } from "../features-b-support/outcomes.js";
import { runTokenScript } from "../features-b-support/tokens-script.js";
import { runCoreIntake } from "../features-b-support/core-intake.js";
import { slackApproveOnCore, slackStartOnCore } from "../features-b-support/core-slack.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

const scriptTokens: Driver = {
  async run(ctx) {
    const words = await runTokenScript({
      make: (projects, permissions) => makeCoreToken(ctx, projects, permissions),
      call: (secret, method, path, body) => callWithCoreToken(ctx, secret, method, path, body),
      waitingTaskId: () => ctx.task.taskId,
      async decisionsOf(taskId) {
        const task = await ctx.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
        return ((task?.workflow as { decisions?: Array<{ decision: string }> } | undefined)?.decisions ?? []).map((decision) => decision.decision);
      },
    }, { start: "33333333-3333-4333-8333-333333333333", decide: "44444444-4444-4444-8444-444444444444", cancel: "55555555-5555-4555-8555-555555555555" });
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const auditLedger: Driver = {
  async run(ctx) {
    const words = ledgerWords(coreLedgerOrder(ctx.world.audit));
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

/** Every invocation the core handed the fake worker machines, by scenario (the fake forgets a job once its result is in). */
const handed = new Map<string, WorkerInvocation[]>();

const modelSelection: Driver = {
  // Records every invocation as the core delivers it (the fake machine forgets a finished job), before the first step runs.
  async prepare(ctx, scenario) {
    const seen: WorkerInvocation[] = [];
    handed.set(scenario.id, seen);
    const machines = ctx.world.machines;
    const deliver = machines.deliver.bind(machines);
    machines.deliver = async (machineId, invocation) => { seen.push(structuredClone(invocation)); return await deliver(machineId, invocation); };
  },
  async run(ctx) {
    const words = modelWords(handed.get(ctx.scenario.id) ?? []);
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const realtime: Driver = {
  async run(ctx) {
    // The registered `realtime` adapter; the in-process one keeps what it sent (`published`). Another adapter has no record to read: refused below.
    const publisher = ctx.runtime.registry.require("realtime") as { published?: () => Array<{ notice: { type: string } }> };
    if (typeof publisher.published !== "function") throw new Error(`the core's realtime adapter (${ctx.runtime.registry.names("realtime").join(", ")}) keeps no record of what it sent`);
    // The task's agent sessions, from the rows the core wrote (one META row per session).
    const sessions = [...ctx.recorder.keys].filter((key) => /#AGENT_SESSION#<ses> \| META$/u.test(key)).length;
    const words = [...realtimeWords(publisher.published().map((heard) => heard.notice.type)), outcome("realtime", `sessions:${String(sessions)}`)];
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const outboundEvents: Driver = {
  // A recording `outbound-events` adapter is registered for this scenario (the composition root registers none), so what the core WOULD send through the
  // point is what is compared, not only that nothing is registered.
  options: () => ({ recordOutbound: true }),
  async run(ctx) {
    await ctx.runtime.tick();
    const words = [outcome("outbound", `events:${String(ctx.world.outbound.length)}`), ...ctx.world.outbound.map((event) => outcome("outbound", `type:${event.type}`))];
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const trackerIntake: Driver = {
  options: () => ({ tracker: true }),
  async run(ctx) {
    const words = await runCoreIntake(ctx);
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const slackStart: Driver = {
  // The settings the `start` driver maps (it is not in this scenario: the Slack message starts the task).
  async prepare(ctx) {
    ctx.runtime.app.flow.deps.understandFirst = false;
    ctx.runtime.app.flow.deps.planCheck = false;
    ctx.runtime.app.flow.deps.autofix = { enabled: false };
  },
  async run(ctx) {
    const words = await slackStartOnCore(ctx);
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const slackApprove: Driver = {
  async run(ctx) {
    const words = slackApproveOnCore(ctx);
    ctx.extra.features.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

export const FEATURES_B_DRIVERS: Record<string, Driver> = {
  "feature:outbound-events": outboundEvents,
  "feature:tracker-intake": trackerIntake,
  "feature:slack-start": slackStart,
  "feature:slack-approve": slackApprove,
  "feature:realtime": realtime,
  "feature:model-selection": modelSelection,
  "feature:script-tokens": scriptTokens,
  "feature:audit-ledger": auditLedger,
};
