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
    ctx.extra.audit.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const auditLedger: Driver = {
  async run(ctx) {
    const words = ledgerWords(coreLedgerOrder(ctx.world.audit));
    ctx.extra.audit.push(...words);
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
    ctx.extra.audit.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const realtime: Driver = {
  async run(ctx) {
    // The registered `realtime` adapter; the in-process one keeps what it sent (`published`). Another adapter has no record to read: refused below.
    const publisher = ctx.runtime.registry.require("realtime") as { published?: () => Array<{ notice: { type: string } }> };
    if (typeof publisher.published !== "function") throw new Error(`the core's realtime adapter (${ctx.runtime.registry.names("realtime").join(", ")}) keeps no record of what it sent`);
    const words = realtimeWords(publisher.published().map((heard) => heard.notice.type));
    ctx.extra.audit.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

const outboundEvents: Driver = {
  async run(ctx) {
    // The core publishes each event to every `outbound-events` adapter the registry holds (ports/outbound-events.ts publishOutboundEvent). The composition
    // root's module list (cloud-modules.ts) registers none, and neither does the local composition: the switch sends no outbound event, as Cloud's path does not.
    const names = ctx.runtime.registry.names("outbound-events");
    const words = [outcome("outbound", `adapters:${String(names.length)}`)];
    ctx.extra.audit.push(...words);
    await logWords("core", ctx.scenario.id, words);
  },
};

/** Steps the core cannot drive yet, each with exactly what is missing. */
const notYet = (why: string): Driver => ({ supports: () => ({ unsupported: why }), run: () => Promise.reject(new Error(why)) });

export const FEATURES_B_DRIVERS: Record<string, Driver> = {
  "feature:outbound-events": outboundEvents,
  "feature:tracker-intake": notYet([
    "the core's intake reads tickets through the registry's `tracker` adapters (core/intake), and the core engine's registry has none: a recording tracker module (Code's FakeTracker,",
    "or A9's Linear/Jira adapters over fakes) must be added to tests/support/cloud-core-fakes.ts (facets lane file); the registry is sealed before a driver runs",
  ].join(" ")),
  "feature:slack-channel": notYet([
    "a Slack message cannot reach the core: (1) no Cloud code wires inboundFromQueuedSlackRequest (plugins/channel/slack-cloud/wiring.ts:54) into createCloudSlackSink;",
    "(2) the sink's ChannelWork (start a task, decide a card on the core) is not built for Cloud: Code's own is local/app/chat.ts, inside the unexported local composition (S0-Q1);",
    "(3) the CHANNEL_TENANTS backfill has not run and Cloud's bind does not write the row (slack-switch.ts readiness). Outbound Slack notices are compared by the messages facet",
  ].join(" ")),
  "feature:realtime": realtime,
  "feature:model-selection": modelSelection,
  "feature:script-tokens": scriptTokens,
  "feature:audit-ledger": auditLedger,
};
