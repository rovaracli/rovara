// Plan 4 Task 26: schedule triggers on EventBridge Scheduler. A schedule starts paid work with nobody watching, so each fire is checked again here (the trigger live, its owner, its
// budget and caps), one slot starts at most one run however often it arrives, a backlog after an outage starts one run, and a trigger that is off, ownerless or gone is never started
// and its schedule goes. Layer 1 drives the expression and the scheduler calls, Layer 2 the handler over the trigger world, Layer 3 the dead letters and the repair sweep.
import "../support/automations-on.js";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError, chainRunKey, orgAutonomousKey, pendingTriggerScheduleKey, triggerKey, triggerRateKey } from "@rovara-code/contracts";
import { taskEndKey } from "../../packages/broker/src/agents/task-end.js";
import { deleteOrgTriggers } from "../../packages/broker/src/triggers/lifecycle.js";
import { fixtureActor } from "../support/money-authority.js";
import {
  CHAIN_SCHEDULE_SOURCE, createChainScheduler, createDeadLetters, handleChainSchedule, putSchedule, scheduleExpression, scheduleSettingsFromEnvironment, sweepSchedules, type ScheduleSettings,
} from "../../packages/broker/src/triggers/schedules.js";
import type { TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { ScheduleTriggerSpecSchema } from "@rovara-code/contracts";
import { type ScheduleSpec } from "@rovara-code/contracts";
import { FakeDeadLetterQueue, FakeSchedulerClient } from "../support/fake-scheduler.js";
import { DANA, ORG_A, ORG_B, PRIYA, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const GROUP = "agentx-staging-chain-triggers";
const SETTINGS: ScheduleSettings = {
  groupName: GROUP,
  roleArn: "arn:aws:iam::123456789012:role/agentx/staging/ChainScheduleInvokeRole-ABC",
  functionArn: "arn:aws:lambda:us-east-1:123456789012:function:agentx-staging-broker",
  queueArn: "arn:aws:sqs:us-east-1:123456789012:agentx-staging-chain-schedule-dead-letters",
};
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const MINUTE = 60_000;
const HOUR = 3_600_000;
const daily = (over: Record<string, unknown> = {}) => ScheduleTriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", missed: "run_once", ...over });

function setup() {
  const v = setupTriggerWorld();
  const client = new FakeSchedulerClient();
  const queue = new FakeDeadLetterQueue();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const scheduler = createChainScheduler({ client, settings: SETTINGS });
  (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  Object.assign(v.routeDeps, { triggerSchedules: scheduler });
  const deps = v.routeDeps as unknown as TriggerDispatchDependencies;
  const iso = (offsetMs: number) => new Date(v.clock.now + offsetMs).toISOString();
  const fire = (triggerId: string, scheduledAt: string, orgId = ORG_A, options?: { forceLate?: boolean }) => handleChainSchedule(deps, { orgId, triggerId, scheduledAt }, v.clock.now, options);
  const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
  const activity = async (triggerId: string) => (await v.triggers.listActivity(ORG_A, triggerId, 500)).map((entry) => ({ outcome: entry.outcome, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }));
  const endRun = (runId: string) => v.db.set({ ...v.db.get(chainRunKey(ORG_A, runId, "META"))!, status: "succeeded" });
  const putOwn = (triggerId: string, spec = daily()) => putSchedule({ client, settings: SETTINGS }, { orgId: ORG_A, triggerId, spec });
  return { v, client, queue, logs, scheduler, deps, iso, fire, runs, activity, endRun, putOwn };
}
/** A custom agent on web that allows the schedule, owned by Dana with a budget, and a trigger on it turned on by Dana (a built-in has no schedule to turn on until Task 27 suggests one). */
const agentTrigger = async (v: TriggerWorld, over: Record<string, unknown> = {}) => {
  const spec = daily();
  const agent = await v.triggerAgent(`Nightly ${String(Math.random())}`, [{ kind: "person" }, spec], { budgetUsd: 20 });
  return { agent, trigger: await v.seed({ target: { kind: "agent", agentId: agent.agentId }, spec: spec as never, scheduleStatus: "ok", createdBy: DANA, ...over }) };
};
const chainTrigger = async (v: TriggerWorld, over: Record<string, unknown> = {}) => {
  const chain = await v.budgetedChain(ONE_STEP);
  return { chain, trigger: await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: daily() as never, scheduleStatus: "ok", ...over }) };
};

// ---- Layer 1: the expression and the scheduler calls

describe("scheduleExpression", () => {
  const cases: Array<[ScheduleSpec, string]> = [
    [{ kind: "daily", at: "09:30", days: ["MON", "FRI"] }, "cron(30 9 ? * MON,FRI *)"],
    [{ kind: "daily", at: "09:30" }, "cron(30 9 * * ? *)"],
    [{ kind: "daily", at: "00:05" }, "cron(5 0 * * ? *)"],
    [{ kind: "daily", at: "23:59", days: ["SUN"] }, "cron(59 23 ? * SUN *)"],
    [{ kind: "weekly", at: "09:00", day: "MON" }, "cron(0 9 ? * MON *)"],
    [{ kind: "interval", minutes: 120 }, "rate(2 hours)"],
    [{ kind: "interval", minutes: 15 }, "rate(15 minutes)"],
    [{ kind: "interval", minutes: 30 }, "rate(30 minutes)"],
    [{ kind: "interval", minutes: 60 }, "rate(1 hour)"],
    [{ kind: "interval", minutes: 240 }, "rate(4 hours)"],
    [{ kind: "interval", minutes: 720 }, "rate(12 hours)"],
    [{ kind: "interval", minutes: 1440 }, "rate(1 day)"],
  ];
  it.each(cases)("%j is %s", (spec, expected) => {
    expect(scheduleExpression(spec)).toBe(expected);
  });
});

describe("putSchedule and the scheduler calls", () => {
  const TRIGGER = "ctr_00000000000000000007";

  it("creates the schedule named by the trigger id in the group, with the exact input template, zone, window, retry policy and dead-letter queue", async () => {
    const s = setup();
    await s.putOwn(TRIGGER, daily({ timezone: "America/New_York", schedule: { kind: "daily", at: "09:30", days: ["MON", "FRI"] } }));
    expect(s.client.commands("CreateScheduleCommand")).toEqual([{
      Name: TRIGGER, GroupName: GROUP, Description: "Rovara schedule trigger", ScheduleExpression: "cron(30 9 ? * MON,FRI *)", ScheduleExpressionTimezone: "America/New_York",
      FlexibleTimeWindow: { Mode: "OFF" }, State: "ENABLED",
      Target: {
        Arn: SETTINGS.functionArn, RoleArn: SETTINGS.roleArn,
        Input: JSON.stringify({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: TRIGGER, scheduledAt: "<aws.scheduler.scheduled-time>" }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 5 }, DeadLetterConfig: { Arn: SETTINGS.queueArn },
      },
    }]);
    expect(s.client.get(GROUP, TRIGGER)?.state).toBe("ENABLED");
    expect(CHAIN_SCHEDULE_SOURCE).toBe("agentx.chain-schedule");
  });

  it.each(["UTC", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Tokyo", "America/Sao_Paulo"])("passes the zone %s to the scheduler, which owns the clock change (a time that does not exist is skipped, one that happens twice runs once)", async (timezone) => {
    const s = setup();
    await s.putOwn(TRIGGER, daily({ timezone }));
    expect(s.client.commands("CreateScheduleCommand")[0]).toMatchObject({ ScheduleExpressionTimezone: timezone });
  });

  it("holds no em dash in the schedule's name or description", async () => {
    const s = setup();
    await s.putOwn(TRIGGER);
    const sent = s.client.commands("CreateScheduleCommand")[0]!;
    for (const field of ["Name", "Description", "GroupName"]) expect(String(sent[field]), field).not.toMatch(/[—–]/u);
  });

  it("replaces a schedule that exists (a change of its time), whole, and creates none twice", async () => {
    const s = setup();
    await s.putOwn(TRIGGER, daily());
    await s.putOwn(TRIGGER, daily({ schedule: { kind: "interval", minutes: 60 } }));
    expect(s.client.commands("UpdateScheduleCommand")).toHaveLength(1);
    expect(s.client.get(GROUP, TRIGGER)!.input).toMatchObject({ ScheduleExpression: "rate(1 hour)", ScheduleExpressionTimezone: "UTC", Target: { DeadLetterConfig: { Arn: SETTINGS.queueArn } } });
    expect(s.client.schedules.size).toBe(1);
  });

  it("sets State DISABLED for a trigger that is off", async () => {
    const s = setup();
    await putSchedule({ client: s.client, settings: SETTINGS }, { orgId: ORG_A, triggerId: TRIGGER, spec: daily(), enabled: false });
    expect(s.client.get(GROUP, TRIGGER)?.state).toBe("DISABLED");
  });

  it("refuses a spec that is not a schedule, and sends nothing", async () => {
    const s = setup();
    await expect(putSchedule({ client: s.client, settings: SETTINGS }, { orgId: ORG_A, triggerId: TRIGGER, spec: { kind: "event", source: "github", type: "pull_request.opened" } })).rejects.toThrow();
    await expect(putSchedule({ client: s.client, settings: SETTINGS }, { orgId: ORG_A, triggerId: "not-a-trigger", spec: daily() })).rejects.toThrow();
    expect(s.client.calls).toEqual([]);
  });

  it("disable keeps the schedule as it is and sets it DISABLED (the whole definition goes back), and puts it running again", async () => {
    const s = setup();
    await s.putOwn(TRIGGER, daily({ timezone: "Europe/Berlin", schedule: { kind: "weekly", at: "08:15", day: "TUE" } }));
    await s.scheduler.disable({ orgId: ORG_A, triggerId: TRIGGER });
    const held = s.client.get(GROUP, TRIGGER)!;
    expect(held.state).toBe("DISABLED");
    expect(held.input).toMatchObject({ ScheduleExpression: "cron(15 8 ? * TUE *)", ScheduleExpressionTimezone: "Europe/Berlin", FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: SETTINGS.functionArn, DeadLetterConfig: { Arn: SETTINGS.queueArn } } });
    await s.scheduler.put({ orgId: ORG_A, triggerId: TRIGGER, spec: daily() });
    expect(s.client.get(GROUP, TRIGGER)?.state).toBe("ENABLED");
  });

  it("disable and remove of a schedule that is not there succeed (they can be repeated)", async () => {
    const s = setup();
    await expect(s.scheduler.disable({ orgId: ORG_A, triggerId: TRIGGER })).resolves.toBeUndefined();
    await expect(s.scheduler.remove({ orgId: ORG_A, triggerId: TRIGGER })).resolves.toBeUndefined();
    await s.putOwn(TRIGGER);
    await s.scheduler.remove({ orgId: ORG_A, triggerId: TRIGGER });
    expect(s.client.schedules.size).toBe(0);
  });

  it("other scheduler faults are not hidden", async () => {
    const s = setup();
    s.client.down = Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    await expect(s.putOwn(TRIGGER)).rejects.toThrow("throttled");
    await expect(s.scheduler.disable({ orgId: ORG_A, triggerId: TRIGGER })).rejects.toThrow("throttled");
    await expect(s.scheduler.remove({ orgId: ORG_A, triggerId: TRIGGER })).rejects.toThrow("throttled");
    await expect(s.scheduler.describe(TRIGGER)).rejects.toThrow("throttled");
  });

  it("describes a schedule by what its own input names, and nothing for one that is not there or whose input is not ours", async () => {
    const s = setup();
    expect(await s.scheduler.describe(TRIGGER)).toBeUndefined();
    await s.putOwn(TRIGGER);
    expect(await s.scheduler.describe(TRIGGER)).toEqual({ state: "ENABLED", orgId: ORG_A, triggerId: TRIGGER });
    s.client.get(GROUP, TRIGGER)!.input["Target"] = { ...(s.client.get(GROUP, TRIGGER)!.input["Target"] as object), Input: "not json" };
    expect(await s.scheduler.describe(TRIGGER)).toEqual({ state: "ENABLED" });
  });
});

// ---- Layer 2: one fire

describe("a fire starts one run at most", () => {
  it("starts a chain run for an on-time fire: origin schedule, startedBy the slot, run by the chain's owner, noted on the trigger and in its activity", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const slot = s.iso(-5_000);
    const answer = await s.fire(trigger.triggerId, slot);
    expect(answer).toMatchObject({ outcome: "started" });
    expect(answer.runId).toMatch(/^crn_[0-9a-z]{20}$/);
    const run = s.v.run(answer.runId!)!;
    expect(run).toMatchObject({ origin: "schedule", project: "web", startedBy: { kind: "schedule", triggerId: trigger.triggerId, scheduledAt: slot } });
    expect(run.owner).toMatchObject({ developerId: PRIYA });
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ lastRunId: answer.runId, lastFiredAt: new Date(s.v.clock.now).toISOString() });
    expect(await s.activity(trigger.triggerId)).toEqual([{ outcome: "started" }]);
  });

  it("the same slot twice, or many times at once, starts one run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const slot = s.iso(-5_000);
    const answers = await Promise.all([s.fire(trigger.triggerId, slot), s.fire(trigger.triggerId, slot), s.fire(trigger.triggerId, slot)]);
    expect(s.runs()).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer.runId)).size).toBe(1);
    const again = await s.fire(trigger.triggerId, slot);
    expect(again).toMatchObject({ outcome: "duplicate", runId: answers[0].runId });
    expect(s.runs()).toHaveLength(1);
  });

  it("starts one agent run paid by the agent for a schedule on a custom agent, as its owner, with the scheduled-job text and no event context", async () => {
    const s = setup();
    const { agent, trigger } = await agentTrigger(s.v);
    const answer = await s.fire(trigger.triggerId, s.iso(-1_000));
    expect(answer).toMatchObject({ outcome: "started" });
    expect(answer.taskId).toBeDefined();
    expect(s.v.starts).toHaveLength(1);
    expect(s.v.starts[0]).toMatchObject({
      orgId: ORG_A, project: "web", origin: "schedule", agent: { agentId: agent.agentId }, owner: { developerId: DANA }, payer: { kind: "agent", agentId: agent.agentId },
      input: { text: "Do your scheduled job." },
    });
    expect(s.v.starts[0]!.input).not.toHaveProperty("context");
    // Plan 5 (N6): the run names the schedule trigger that started it, so its session does.
    expect(s.v.starts[0]!.trigger).toEqual({ kind: "schedule", triggerId: trigger.triggerId });
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ lastTaskId: answer.taskId });
    expect((await s.fire(trigger.triggerId, s.iso(-1_000))).outcome).toBe("duplicate");
    expect(s.v.tasks.size).toBe(1);
  });

  it("records a refusal of the start by its code, and a fault that may pass is thrown so the scheduler retries, and the retry starts the one run", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    s.v.hooks.refuse.push(agentXError("AGENT_BUDGET_EXCEEDED", "no money"));
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "failed", reason: "AGENT_BUDGET_EXCEEDED" });
    s.v.hooks.refuse.push(new Error("socket hang up"));
    const slot = s.iso(-2_000);
    await expect(s.fire(trigger.triggerId, slot)).rejects.toThrow("socket hang up");
    expect(await s.fire(trigger.triggerId, slot)).toMatchObject({ outcome: "started" });
    expect(s.v.tasks.size).toBe(1);
    expect(JSON.stringify(s.logs)).not.toContain("socket hang up");
  });
});

describe("the requirements are read again at the fire", () => {
  it("turns off a schedule trigger whose chain lost its run limit with no recheck: failed trigger_invalid, the trigger and its schedule disabled, nothing started", async () => {
    const s = setup();
    const { chain, trigger } = await chainTrigger(s.v, { createdBy: DANA });
    await s.putOwn(trigger.triggerId);
    await s.v.publishAgain(chain.chainId, { ...ONE_STEP, limits: {} });
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "failed", reason: "trigger_invalid" });
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
    expect(s.client.get(GROUP, trigger.triggerId)?.state).toBe("DISABLED");
    expect(s.runs()).toEqual([]);
    expect(s.v.starts).toEqual([]);
    expect(s.v.db.get(triggerRateKey(ORG_A, trigger.triggerId, new Date(s.v.clock.now).toISOString().slice(0, 13)))).toBeUndefined();
    expect((await s.v.notices(DANA)).join("\n")).toContain("was turned off");
    expect(await s.activity(trigger.triggerId)).toContainEqual({ outcome: "failed", reason: "trigger_invalid" });
    // Off now: the next fire is stale.
    expect((await s.fire(trigger.triggerId, s.iso(-500))).outcome).toBe("stale");
  });

  it("never starts a trigger whose owner left the org, and turns it off", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v, { createdBy: "9".repeat(64) });
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "failed", reason: "trigger_invalid" });
    expect(s.v.starts).toEqual([]);
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
  });

  it("throws when a service of ours is away, leaving the trigger on and starting nothing, so the scheduler retries", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await expect(handleChainSchedule({ ...s.deps, chains: undefined } as unknown as TriggerDispatchDependencies, { orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: s.iso(-1_000) }, s.v.clock.now)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: true });
    expect(s.runs()).toEqual([]);
  });
});

describe("a fire for a trigger that is gone, off or not a schedule is stale", () => {
  it("starts nothing for a disabled trigger and deletes its own schedule, after its input names the same org and trigger", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { enabled: false });
    await s.putOwn(trigger.triggerId);
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "stale" });
    expect(s.runs()).toEqual([]);
    expect(s.client.get(GROUP, trigger.triggerId)).toBeUndefined();
    expect(s.logs.map((entry) => entry.event)).toContain("schedule.stale");
  });

  it("deletes the schedule of a trigger that was deleted, and of one that is not a schedule", async () => {
    const s = setup();
    const { chain, trigger } = await chainTrigger(s.v);
    await s.putOwn(trigger.triggerId);
    await s.v.triggers.delete({ trigger });
    expect((await s.fire(trigger.triggerId, s.iso(-1_000))).outcome).toBe("stale");
    expect(s.client.get(GROUP, trigger.triggerId)).toBeUndefined();
    const event = await s.v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    await s.putOwn(event.triggerId);
    expect((await s.fire(event.triggerId, s.iso(-1_000))).outcome).toBe("stale");
    expect(s.client.get(GROUP, event.triggerId)).toBeUndefined();
    expect(s.runs()).toEqual([]);
  });

  it("CROSS-ORG: an invocation naming org B and org A's trigger starts nothing, reads no key of org A and deletes nothing, because the schedule's own input names org A", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await s.putOwn(trigger.triggerId);
    const keys: string[] = [];
    const send = s.v.db.send.bind(s.v.db);
    s.v.db.send = (async (command: { input: { Key?: { pk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      const pk = command.input.Key?.pk ?? command.input.ExpressionAttributeValues?.[":pk"];
      if (typeof pk === "string") keys.push(pk);
      return send(command);
    });
    expect(await s.fire(trigger.triggerId, s.iso(-1_000), ORG_B)).toMatchObject({ outcome: "stale" });
    expect(s.runs()).toEqual([]);
    expect(s.v.starts).toEqual([]);
    expect(keys.filter((pk) => pk.includes(ORG_A))).toEqual([]);
    expect(s.client.get(GROUP, trigger.triggerId)).toBeDefined();
    expect(s.client.commands("DeleteScheduleCommand")).toEqual([]);
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: true });
    expect(await s.activity(trigger.triggerId)).toEqual([]);
  });

  it("deletes nothing when the schedule is another trigger's, or its input is unreadable, or the scheduler can't be asked", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { enabled: false });
    const other = "ctr_00000000000000000099";
    await s.putOwn(trigger.triggerId, daily());
    // A schedule named like this trigger whose own input names another trigger: not ours to delete.
    const held = s.client.get(GROUP, trigger.triggerId)!;
    const target = held.input["Target"] as { Input: string };
    target.Input = JSON.stringify({ ...JSON.parse(target.Input) as object, triggerId: other });
    expect((await s.fire(trigger.triggerId, s.iso(-1_000))).outcome).toBe("stale");
    expect(s.client.get(GROUP, trigger.triggerId)).toBeDefined();
    target.Input = "not json";
    await s.fire(trigger.triggerId, s.iso(-1_000));
    expect(s.client.get(GROUP, trigger.triggerId)).toBeDefined();
    s.client.down = Object.assign(new Error("away"), { name: "ThrottlingException" });
    await expect(s.fire(trigger.triggerId, s.iso(-1_000))).resolves.toMatchObject({ outcome: "stale" });
    expect(s.client.commands("DeleteScheduleCommand")).toEqual([]);
  });

  it("answers an input that is not a trigger id, an org id or an instant without reading anything or starting anything", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const before = s.v.db.commandNames().length;
    for (const bad of [
      { orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: "<aws.scheduler.scheduled-time>" },
      { orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: "yesterday" },
      { orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: 5 },
      { orgId: ORG_A, triggerId: "ctr_x", scheduledAt: s.iso(-1_000) },
      { orgId: "nope", triggerId: trigger.triggerId, scheduledAt: s.iso(-1_000) },
      { orgId: ORG_A, triggerId: trigger.triggerId },
    ]) {
      expect(await handleChainSchedule(s.deps, bad as never, s.v.clock.now)).toMatchObject({ outcome: "stale", reason: "invalid" });
    }
    expect(s.v.db.commandNames().length).toBe(before);
    expect(s.runs()).toEqual([]);
  });

  it("refuses a slot dated ahead of the clock (a forged one), and accepts one a minute ahead (clock slack)", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    expect(await s.fire(trigger.triggerId, s.iso(HOUR))).toMatchObject({ outcome: "stale", reason: "invalid" });
    expect(s.runs()).toEqual([]);
    expect((await s.fire(trigger.triggerId, s.iso(MINUTE))).outcome).toBe("started");
  });
});

describe("no overlap", () => {
  it("skips an on-time fire while the run the trigger last started is open, and starts again once it ends", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const first = await s.fire(trigger.triggerId, s.iso(-10_000));
    expect(first.outcome).toBe("started");
    expect(await s.fire(trigger.triggerId, s.iso(-5_000))).toMatchObject({ outcome: "skipped", reason: "previous_run_still_running" });
    expect(s.runs()).toHaveLength(1);
    s.endRun(first.runId!);
    const next = await s.fire(trigger.triggerId, s.iso(-1_000));
    expect(next.outcome).toBe("started");
    expect(next.runId).not.toBe(first.runId);
    expect(s.runs()).toHaveLength(2);
    expect(await s.activity(trigger.triggerId)).toContainEqual({ outcome: "skipped", reason: "previous_run_still_running" });
  });

  it("skips while the agent task it last started has not ended, and starts once its end is recorded", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const first = await s.fire(trigger.triggerId, s.iso(-10_000));
    expect(first.outcome).toBe("started");
    expect(await s.fire(trigger.triggerId, s.iso(-5_000))).toMatchObject({ outcome: "skipped", reason: "previous_run_still_running" });
    expect(s.v.tasks.size).toBe(1);
    s.v.db.set({ ...taskEndKey(first.taskId!), entityType: "TASK_END", orgId: ORG_A, outcome: "succeeded" });
    expect((await s.fire(trigger.triggerId, s.iso(-1_000))).outcome).toBe("started");
    expect(s.v.tasks.size).toBe(2);
  });

  it("treats another org's end record for the same task id as not ended", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const first = await s.fire(trigger.triggerId, s.iso(-10_000));
    s.v.db.set({ ...taskEndKey(first.taskId!), entityType: "TASK_END", orgId: ORG_B, outcome: "succeeded" });
    expect((await s.fire(trigger.triggerId, s.iso(-5_000))).outcome).toBe("skipped");
  });
});

describe("a late fire, and a backlog after an outage", () => {
  const SLOTS = [3 * HOUR, 2.5 * HOUR, 2 * HOUR, 1.5 * HOUR, HOUR, 31 * MINUTE];

  it("is on time up to 30 minutes late, and late after", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { spec: daily({ missed: "skip" }) });
    expect((await s.fire(trigger.triggerId, s.iso(-30 * MINUTE))).outcome).toBe("started");
    s.endRun((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastRunId!);
    expect(await s.fire(trigger.triggerId, s.iso(-30 * MINUTE - 1_000))).toMatchObject({ outcome: "missed" });
    expect(s.runs()).toHaveLength(1);
  });

  it("with run_once, six late fires after an outage start exactly one run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const answers = [];
    for (const late of SLOTS) answers.push(await s.fire(trigger.triggerId, s.iso(-late)));
    expect(answers.filter((answer) => answer.outcome === "started")).toHaveLength(1);
    expect(s.runs()).toHaveLength(1);
    expect(answers.slice(1).every((answer) => answer.outcome === "skipped" || answer.outcome === "missed")).toBe(true);
  });

  it("with run_once, six late fires start one run even when each run has ended by the next fire (the slot's claim, not the overlap check, holds the rest)", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const answers = [];
    for (const late of SLOTS) {
      const answer = await s.fire(trigger.triggerId, s.iso(-late));
      answers.push(answer);
      if (answer.runId !== undefined) s.endRun(answer.runId);
    }
    expect(answers.filter((answer) => answer.outcome === "started")).toHaveLength(1);
    expect(answers.slice(1).map((answer) => answer.outcome)).toEqual(["missed", "missed", "missed", "missed", "missed"]);
    expect(s.runs()).toHaveLength(1);
    expect((await s.activity(trigger.triggerId)).filter((entry) => entry.outcome === "missed")).toHaveLength(5);
  });

  it("the same late slot many times at once gives one run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const slot = s.iso(-2 * HOUR);
    await Promise.all([1, 2, 3, 4, 5].map(() => s.fire(trigger.triggerId, slot)));
    expect(s.runs()).toHaveLength(1);
  });

  it("with skip, six late fires start none and leave six missed items", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { spec: daily({ missed: "skip" }) });
    const answers = [];
    for (const late of SLOTS) answers.push(await s.fire(trigger.triggerId, s.iso(-late)));
    expect(answers.map((answer) => answer.outcome)).toEqual(Array(6).fill("missed"));
    expect(s.runs()).toEqual([]);
    expect(await s.activity(trigger.triggerId)).toEqual(Array(6).fill({ outcome: "missed" }));
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBeUndefined();
  });

  it("an on-time slot after a late run still starts (the claim holds only the slots that were already past)", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const late = await s.fire(trigger.triggerId, s.iso(-2 * HOUR));
    expect(late.outcome).toBe("started");
    s.endRun(late.runId!);
    s.v.clock.now += 10 * MINUTE;
    expect((await s.fire(trigger.triggerId, s.iso(-1_000))).outcome).toBe("started");
    expect(s.runs()).toHaveLength(2);
  });

  it("gives the slot back when the late start fails in a way that may pass, so the retry starts the run", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const slot = s.iso(-2 * HOUR);
    s.v.hooks.refuse.push(new Error("socket hang up"));
    await expect(s.fire(trigger.triggerId, slot)).rejects.toThrow();
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBeUndefined();
    expect((await s.fire(trigger.triggerId, slot)).outcome).toBe("started");
    expect(s.v.tasks.size).toBe(1);
  });
});

describe("limits", () => {
  it("holds a trigger to its allowance for the hour, recording rate_limited, and counts nothing for a fire that is skipped", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { maxRunsPerHour: 1 });
    const first = await s.fire(trigger.triggerId, s.iso(-20_000));
    expect(first.outcome).toBe("started");
    s.endRun(first.runId!);
    expect(await s.fire(trigger.triggerId, s.iso(-10_000))).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
    expect(s.runs()).toHaveLength(1);
  });

  it("holds the org to its autonomous runs for the day, recording org_daily_limit", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    s.v.db.set({ ...orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10)), entityType: "ORG_AUTONOMOUS", count: 500 });
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "skipped", reason: "org_daily_limit" });
    expect(s.runs()).toEqual([]);
  });

  it("counts a started run against the org's day", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await s.fire(trigger.triggerId, s.iso(-1_000));
    expect(s.v.db.get(orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10)))).toMatchObject({ count: 1 });
  });
});

describe("archiving and closing", () => {
  it("archiving the chain turns its schedule trigger off and its schedule DISABLED", async () => {
    const s = setup();
    const { chain, trigger } = await chainTrigger(s.v, { createdBy: DANA });
    await s.putOwn(trigger.triggerId);
    fixtureActor(s.v.db, ORG_A, DANA); // archiving holds the admin to their company access in its own transaction
    const archived = await s.v.chainCall(DANA, "POST", `/v1/app/chains/${chain.chainId}/archive`, {});
    expect(archived.status).toBeLessThan(300);
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
    expect(s.client.get(GROUP, trigger.triggerId)?.state).toBe("DISABLED");
  });

  it("closeOrg deletes the org's schedules, and not another org's", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const theirs = await s.v.triggers.create({ record: { orgId: ORG_B, triggerId: "ctr_bbbbbbbbbbbbbbbbbbbb", target: { kind: "agent", agentId: "code-reviewer" }, project: "web", spec: daily(), enabled: true, maxRunsPerHour: 30, createdBy: PRIYA, scheduleStatus: "ok" } });
    await s.putOwn(trigger.triggerId);
    await putSchedule({ client: s.client, settings: SETTINGS }, { orgId: ORG_B, triggerId: theirs.triggerId, spec: daily() });
    await deleteOrgTriggers(s.deps, ORG_A);
    expect(s.client.get(GROUP, trigger.triggerId)).toBeUndefined();
    expect(s.client.get(GROUP, theirs.triggerId)).toBeDefined();
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toBeUndefined();
    expect(await s.v.triggers.get(ORG_B, theirs.triggerId)).toBeDefined();
  });

  it("closeOrg keeps the org's triggers when a schedule could not be deleted, and finishing it on a second close removes both", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await s.putOwn(trigger.triggerId);
    s.client.down = Object.assign(new Error("away"), { name: "ThrottlingException" });
    await expect(deleteOrgTriggers(s.deps, ORG_A)).rejects.toThrow();
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toBeDefined();
    s.client.down = undefined;
    await deleteOrgTriggers(s.deps, ORG_A);
    expect(s.client.get(GROUP, trigger.triggerId)).toBeUndefined();
    expect(s.v.db.get(triggerKey(ORG_A, trigger.triggerId))).toBeUndefined();
  });
});

// ---- Layer 3: dead letters and repair

describe("dead letters", () => {
  const letter = (triggerId: string, scheduledAt: string, orgId = ORG_A) => ({ source: "agentx.chain-schedule", orgId, triggerId, scheduledAt });

  it("records each as missed, then handles it as a late fire under the trigger's policy: run_once starts one run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const handle = s.queue.add(letter(trigger.triggerId, s.iso(-5_000)));
    const report = await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(report).toMatchObject({ deadLetters: 1 });
    expect(s.runs()).toHaveLength(1);
    expect(s.queue.deleted).toEqual([handle]);
    const entries = await s.v.triggers.listActivity(ORG_A, trigger.triggerId, 50);
    expect(entries.map((entry) => `${entry.outcome}:${entry.reason ?? ""}`).sort()).toEqual(["missed:dead_letter", "started:"]);
  });

  it("with skip, a dead letter starts nothing", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { spec: daily({ missed: "skip" }) });
    s.queue.add(letter(trigger.triggerId, s.iso(-5_000)));
    await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(s.runs()).toEqual([]);
    expect(await s.activity(trigger.triggerId)).toHaveLength(2);
    expect(await s.activity(trigger.triggerId)).toEqual(expect.arrayContaining([{ outcome: "missed", reason: "dead_letter" }, { outcome: "missed" }]));
    expect(s.queue.messages).toEqual([]);
  });

  it("takes at most 10 a sweep, asking the queue for no more", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { spec: daily({ missed: "skip" }) });
    for (let index = 0; index < 12; index += 1) s.queue.add(letter(trigger.triggerId, s.iso(-(index + 1) * HOUR)));
    const report = await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(report.deadLetters).toBe(10);
    expect(s.queue.messages).toHaveLength(2);
    expect(Math.max(...s.queue.received)).toBeLessThanOrEqual(10);
  });

  it("deletes a letter that is not ours or not readable, starting nothing, and leaves one whose handling failed in a way that may pass", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    s.queue.add("not json");
    s.queue.add({ source: "something-else", orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: s.iso(-5_000) });
    s.queue.add({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: "bad", scheduledAt: s.iso(-5_000) });
    const kept = s.queue.add(letter(trigger.triggerId, s.iso(-4_000)));
    s.v.hooks.refuse.push(new Error("socket hang up"));
    const report = await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(s.runs()).toEqual([]);
    expect(s.queue.messages.map((message) => message.handle)).toEqual([kept]);
    expect(report).toMatchObject({ deadLetters: 3, failed: 1 });
  });

  it("CROSS-ORG: a letter naming org B and org A's trigger starts nothing, deletes no schedule and is removed from the queue", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await s.putOwn(trigger.triggerId);
    s.queue.add(letter(trigger.triggerId, s.iso(-5_000), ORG_B));
    await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(s.runs()).toEqual([]);
    expect(s.client.get(GROUP, trigger.triggerId)).toBeDefined();
    expect(s.queue.messages).toEqual([]);
    expect(await s.activity(trigger.triggerId)).toEqual([]);
  });
});

describe("a schedule that is still pending is repaired by the sweep", () => {
  it("puts the schedule of an enabled trigger and marks it ok, and leaves the pending list", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { scheduleStatus: "pending" });
    const report = await sweepSchedules(s.deps, { now: s.v.clock.now });
    expect(report).toMatchObject({ repaired: 1 });
    expect(s.client.get(GROUP, trigger.triggerId)?.state).toBe("ENABLED");
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ scheduleStatus: "ok" });
    const again = await sweepSchedules(s.deps, { now: s.v.clock.now });
    expect(again).toMatchObject({ repaired: 0 });
    expect(s.client.commands("CreateScheduleCommand")).toHaveLength(1);
  });

  it("sets a trigger that is off DISABLED (creating nothing) and marks it ok", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { scheduleStatus: "pending", enabled: false });
    await sweepSchedules(s.deps, { now: s.v.clock.now });
    expect(s.client.get(GROUP, trigger.triggerId)).toBeUndefined();
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ scheduleStatus: "ok" });
  });

  it("leaves it pending when the scheduler fails, and finds it again next time", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { scheduleStatus: "pending" });
    s.client.down = Object.assign(new Error("away"), { name: "ThrottlingException" });
    expect(await sweepSchedules(s.deps, { now: s.v.clock.now })).toMatchObject({ repaired: 0, failed: 1 });
    expect(await s.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ scheduleStatus: "pending" });
    s.client.down = undefined;
    expect(await sweepSchedules(s.deps, { now: s.v.clock.now })).toMatchObject({ repaired: 1 });
  });

  it("repairs no more than the sweep's cap, and a trigger that was deleted leaves the list", async () => {
    const s = setup();
    const { chain } = await chainTrigger(s.v);
    for (let index = 0; index < 4; index += 1) await s.v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: daily() as never, scheduleStatus: "pending" });
    expect(await sweepSchedules(s.deps, { now: s.v.clock.now, maxPending: 3 })).toMatchObject({ repaired: 3 });
    expect(await sweepSchedules(s.deps, { now: s.v.clock.now, maxPending: 3 })).toMatchObject({ repaired: 1 });
  });

  it("leaves the list for a trigger that was deleted, and creates no schedule for it", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { scheduleStatus: "pending" });
    await s.v.triggers.delete({ trigger });
    expect(await sweepSchedules(s.deps, { now: s.v.clock.now })).toMatchObject({ repaired: 0 });
    expect(s.client.schedules.size).toBe(0);
  });
});

// ---- pins from the mutation pass

describe("pins: settings, scheduler calls and edges", () => {
  const ENV = { AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AWS_LAMBDA_FUNCTION_NAME: "agentx-staging-broker", CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx/staging/r", CHAIN_SCHEDULE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/q" };
  it("accepts the settings as they should be, and refuses a role of another account, an account that is not 12 digits, a function name or a queue name with odd characters", () => {
    expect(scheduleSettingsFromEnvironment(ENV)).toBeDefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::999999999999:role/agentx/staging/r" })).toBeUndefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::123456789012:user/x" })).toBeUndefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, AGENTX_ACCOUNT_ID: "12345", CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::12345:role/agentx/staging/r", CHAIN_SCHEDULE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/12345/q" })).toBeUndefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, AWS_LAMBDA_FUNCTION_NAME: "a:b" })).toBeUndefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, CHAIN_SCHEDULE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/q%2Fx" })).toBeUndefined();
    expect(scheduleSettingsFromEnvironment({ ...ENV, CHAIN_SCHEDULE_QUEUE_URL: `https://sqs.us-west-2.amazonaws.com/123456789012/${"q".repeat(81)}` })).toBeUndefined();
  });

  it("putSchedule refuses an org id that is not one, and sends nothing", async () => {
    const s = setup();
    await expect(putSchedule({ client: s.client, settings: SETTINGS }, { orgId: "nope", triggerId: "ctr_00000000000000000007", spec: daily() })).rejects.toThrow();
    expect(s.client.calls).toEqual([]);
  });

  it("disable of a schedule that is already DISABLED sends no update", async () => {
    const s = setup();
    await s.putOwn("ctr_00000000000000000007");
    await s.scheduler.disable({ orgId: ORG_A, triggerId: "ctr_00000000000000000007" });
    await s.scheduler.disable({ orgId: ORG_A, triggerId: "ctr_00000000000000000007" });
    expect(s.client.commands("UpdateScheduleCommand")).toHaveLength(1);
  });

  it("a slot equal to the trigger's last claim is covered by it", async () => {
    const s = setup();
    const slot = s.iso(-2 * HOUR);
    const { trigger } = await chainTrigger(s.v, { lastFiredAt: slot });
    expect(await s.fire(trigger.triggerId, slot)).toMatchObject({ outcome: "missed", reason: "covered_by_a_later_run" });
    expect(s.runs()).toEqual([]);
  });

  it("the same slot written in two spellings is one slot (one run, the second a duplicate)", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const at = new Date(s.v.clock.now - 5_000);
    await s.fire(trigger.triggerId, at.toISOString());
    expect((await s.fire(trigger.triggerId, at.toISOString().replace("Z", "+00:00"))).outcome).toBe("duplicate");
    expect(s.runs()).toHaveLength(1);
  });

  it("a store failure that is not a lost race is thrown, not retried as one", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const update = s.v.triggers.update.bind(s.v.triggers);
    s.v.triggers.update = (async () => { throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); });
    await expect(s.fire(trigger.triggerId, s.iso(-2 * HOUR))).rejects.toThrow("throttled");
    s.v.triggers.update = update;
  });

  it("gives back only its own claim: a claim another fire moved on is left", async () => {
    const s = setup();
    await s.v.builtinBudget("code-reviewer");
    const { trigger } = await agentTrigger(s.v);
    const ports = (s.deps as unknown as { chainRuns: { startAgentRun: (r: unknown) => Promise<unknown> } }).chainRuns;
    ports.startAgentRun = async () => {
      const current = (await s.v.triggers.get(ORG_A, trigger.triggerId))!;
      await s.v.triggers.update({ trigger: current, patch: { lastFiredAt: "2099-01-01T00:00:00.000Z" } });
      throw new Error("socket hang up");
    };
    await expect(s.fire(trigger.triggerId, s.iso(-2 * HOUR))).rejects.toThrow("socket hang up");
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("never lets a trigger's own allowance pass the platform's 60 an hour", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { maxRunsPerHour: 1000 });
    s.v.db.set({ ...triggerRateKey(ORG_A, trigger.triggerId, new Date(s.v.clock.now).toISOString().slice(0, 13)), entityType: "TRIGGER_RATE", count: 60 });
    expect(await s.fire(trigger.triggerId, s.iso(-1_000))).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
  });

  it("another org's task with the same id is not the trigger's open work", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const first = await s.fire(trigger.triggerId, s.iso(-10_000));
    const record = s.v.db.get({ pk: `DEVTASK#${first.taskId!}`, sk: "META" })!;
    s.v.db.set({ ...record, orgId: ORG_B });
    expect((await s.fire(trigger.triggerId, s.iso(-5_000))).outcome).toBe("started");
  });

  it("asks the queue for 10 at most and takes 10 at most, whatever the caller allows", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { spec: daily({ missed: "skip" }) });
    for (let index = 0; index < 12; index += 1) s.queue.add({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: s.iso(-(index + 1) * HOUR) });
    const report = await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now, maxDeadLetters: 50 });
    expect(report.deadLetters).toBe(10);
    expect(s.queue.received).toEqual([10]);
  });

  it("a letter for a trigger that is gone leaves no activity, and one that is not from the scheduler is not handled", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await s.v.triggers.delete({ trigger });
    s.queue.add({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: s.iso(-5_000) });
    await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(await s.v.triggers.listActivity(ORG_A, trigger.triggerId, 10)).toEqual([]);
    const other = await chainTrigger(s.v);
    s.queue.add({ source: "elsewhere", orgId: ORG_A, triggerId: other.trigger.triggerId, scheduledAt: s.iso(-5_000) });
    await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now });
    expect(s.runs()).toEqual([]);
    expect(await s.activity(other.trigger.triggerId)).toEqual([]);
  });

  it("throws when a sweep part failed and nothing else got done, and answers when something did", async () => {
    const s = setup();
    s.queue.failReceive = new Error("queue away");
    await expect(sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now })).rejects.toThrow("queue away");
    await chainTrigger(s.v, { scheduleStatus: "pending" });
    expect(await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: "https://sqs/q" }), now: s.v.clock.now })).toMatchObject({ repaired: 1 });
  });

  it("drops a pending entry whose trigger is gone, and ignores one whose key does not name its own org and trigger", async () => {
    const s = setup();
    const gone = "ctr_00000000000000000042";
    s.v.db.set({ ...pendingTriggerScheduleKey(ORG_A, gone), entityType: "TRIGGER_SCHEDULE_PENDING", orgId: ORG_A, triggerId: gone });
    s.v.db.set({ pk: "PENDING_TRIGGER_SCHEDULES", sk: `${ORG_A}#ctr_00000000000000000043`, entityType: "TRIGGER_SCHEDULE_PENDING", orgId: ORG_A, triggerId: "ctr_00000000000000000044" });
    expect(await s.v.triggers.listPendingSchedules(10)).toEqual([{ orgId: ORG_A, triggerId: gone }]);
    await sweepSchedules(s.deps, { now: s.v.clock.now });
    expect(s.v.db.get(pendingTriggerScheduleKey(ORG_A, gone))).toBeUndefined();
  });

  it("keeps the pending list equal to the triggers that are pending: a trigger that becomes pending is listed, and deleting a pending one unlists it", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    expect(await s.v.triggers.listPendingSchedules(10)).toEqual([]);
    const pending = await s.v.triggers.update({ trigger, patch: { scheduleStatus: "pending" } });
    expect(await s.v.triggers.listPendingSchedules(10)).toEqual([{ orgId: ORG_A, triggerId: trigger.triggerId }]);
    await s.v.triggers.delete({ trigger: pending });
    expect(s.v.db.get(pendingTriggerScheduleKey(ORG_A, trigger.triggerId))).toBeUndefined();
  });

  it("closeOrg asks the scheduler to delete schedules of schedule triggers only", async () => {
    const s = setup();
    const { chain, trigger } = await chainTrigger(s.v);
    const event = await s.v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    await deleteOrgTriggers(s.deps, ORG_A);
    expect(s.client.commands("DeleteScheduleCommand").map((input) => input["Name"])).toEqual([trigger.triggerId]);
    expect(event.triggerId).not.toBe(trigger.triggerId);
  });
});
