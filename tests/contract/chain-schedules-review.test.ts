// Plan 4 Task 26 review fixes. I-1: EventBridge Scheduler invokes the broker ASYNCHRONOUSLY, so an error thrown by the fire never reaches the scheduler's retry policy or the chain
// dead-letter queue: Lambda's own async retries run, and the last failure lands in the Slack hand-off queue with a misleading alarm. The fire records its own failure in the chain
// queue and answers. M-1: the no-overlap check is a claim on the trigger's revision, not a best-effort pointer. M-2: an agent task with no end record stops blocking the trigger
// after the plan's longest run. M-3: a late claim is given back when a cap skips the slot. M-4: a dead letter that keeps failing is parked after a few tries, and the queue's age is
// alarmed. M-5: a schedule that could not be deleted with its trigger is logged.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentXError, orgAutonomousKey, triggerRateKey } from "@rovara-code/contracts";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { createChainScheduler, createDeadLetters, fireChainSchedule, handleChainSchedule, sweepSchedules, type ScheduleSettings } from "../../packages/broker/src/triggers/schedules.js";
import type { TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { ScheduleTriggerSpecSchema } from "@rovara-code/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { FakeDeadLetterQueue, FakeSchedulerClient } from "../support/fake-scheduler.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { DANA, ORG_A, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(disposeGateWorlds);

const SETTINGS: ScheduleSettings = {
  groupName: "agentx-staging-chain-triggers",
  roleArn: "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-chain-schedule",
  functionArn: "arn:aws:lambda:us-east-1:123456789012:function:agentx-staging-broker",
  queueArn: "arn:aws:sqs:us-east-1:123456789012:agentx-staging-chain-schedule-dead-letters",
};
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/agentx-staging-chain-schedule-dead-letters";
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const MINUTE = 60_000;
const HOUR = 3_600_000;
const daily = (over: Record<string, unknown> = {}) => ScheduleTriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", missed: "run_once", ...over });

// ---- I-1: the fire records its own failure

describe("I-1: a fire that fails is recorded in the chain dead-letter queue and answered, never thrown to Lambda's async path", () => {
  const event = (over: Record<string, unknown> = {}) => ({ source: "agentx.chain-schedule", orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: new Date(Date.now() - 5_000).toISOString(), ...over });
  const bodyOf = (reply: unknown) => JSON.parse((reply as { body: string }).body) as Record<string, unknown>;
  async function broker(withQueue = true) {
    const queue = new FakeDeadLetterQueue();
    const client = new FakeSchedulerClient();
    const h = await createDeveloperTaskBroker({
      brokerExtra: { agents: { triggerSchedules: createChainScheduler({ client, settings: SETTINGS }), ...(withQueue ? { scheduleDeadLetters: createDeadLetters({ sqs: queue, queueUrl: QUEUE_URL }) } : {}) } },
    });
    return { h, queue };
  }
  const failTriggerReads = (h: Awaited<ReturnType<typeof broker>>["h"], message = "boom") =>
    h.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("TRIGGER#"), error: { name: "ProvisionedThroughputExceededException", message } });

  it("answers 200 and puts a bounded record of the slot in the chain queue, where the broker's own drain will find it", async () => {
    const { h, queue } = await broker();
    failTriggerReads(h);
    const slot = new Date(Date.now() - 5_000).toISOString();
    const reply = await h.handler(event({ scheduledAt: slot }));
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(bodyOf(reply)).toMatchObject({ outcome: "dead_lettered" });
    expect(queue.sent).toHaveLength(1);
    expect(JSON.parse(queue.sent[0]!)).toEqual({ source: "agentx.chain-schedule", orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: slot, failure: "ProvisionedThroughputExceededException" });
    expect(queue.sent[0]!.length).toBeLessThan(512);
  });

  it("puts only ids, the instant and a code in the record, never the error's text", async () => {
    const { h, queue } = await broker();
    failTriggerReads(h, "token sk-live-SECRET and a path /Users/x");
    await h.handler(event());
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).not.toContain("SECRET");
    expect(queue.sent[0]).not.toContain("/Users");
  });

  it("uses the code of a refusal of ours as the failure, the error's name otherwise, and `unknown` for a name that is not a plain word", async () => {
    const record = async (error: Error) => {
      const put: string[] = [];
      const deps = { triggers: { get: async () => { throw error; } } } as unknown as TriggerDispatchDependencies;
      const answer = await fireChainSchedule(deps, { orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: new Date().toISOString() }, Date.now(), { put: async (body) => { put.push(body); } });
      expect(answer).toMatchObject({ outcome: "dead_lettered" });
      return (JSON.parse(put[0]!) as { failure: string }).failure;
    };
    expect(await record(agentXError("RUNTIME_UNAVAILABLE", "try again"))).toBe("RUNTIME_UNAVAILABLE");
    expect(await record(Object.assign(new Error("x"), { name: "ThrottlingException" }))).toBe("ThrottlingException");
    expect(await record(Object.assign(new Error("x"), { name: "token sk-live-SECRET /Users/x" }))).toBe("unknown");
  });

  it("records nothing for a fire that is answered (stale, or an input that is not a slot)", async () => {
    const { h, queue } = await broker();
    expect(bodyOf(await h.handler(event()))).toMatchObject({ outcome: "stale" });
    expect(bodyOf(await h.handler(event({ scheduledAt: "<aws.scheduler.scheduled-time>" })))).toMatchObject({ outcome: "stale", reason: "invalid" });
    expect(queue.sent).toEqual([]);
  });

  it("writes nothing for an input that cannot be named in a record (a failure of an unreadable event is only logged)", async () => {
    const { h, queue } = await broker();
    failTriggerReads(h);
    const reply = await h.handler(event({ orgId: "not-an-org" }));
    expect(reply).toMatchObject({ statusCode: 200 });
    expect(queue.sent).toEqual([]);
  });

  it("still throws when the record cannot be written, so Lambda's own retries are the last resort rather than a silent loss", async () => {
    const { h, queue } = await broker();
    failTriggerReads(h);
    queue.failSend = Object.assign(new Error("sqs down"), { name: "ServiceUnavailable" });
    await expect(h.handler(event())).rejects.toThrow();
  });

  it("still throws where there is no queue to record in", async () => {
    const { h } = await broker(false);
    failTriggerReads(h);
    await expect(h.handler(event())).rejects.toThrow();
  });

  it("a recorded failure is found by the sweep and starts the run once the fault is gone", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const slot = s.iso(-5_000);
    s.queue.add({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId: trigger.triggerId, scheduledAt: slot, failure: "ProvisionedThroughputExceededException" });
    const report = await sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: QUEUE_URL }), now: s.v.clock.now });
    expect(report.deadLetters).toBe(1);
    expect(s.runs()).toHaveLength(1);
  });
});

// ---- shared set-up for the handler over the trigger world

function setup() {
  const v = setupTriggerWorld();
  const client = new FakeSchedulerClient();
  const queue = new FakeDeadLetterQueue();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  Object.assign(v.routeDeps, { triggerSchedules: createChainScheduler({ client, settings: SETTINGS }) });
  const deps = v.routeDeps as unknown as TriggerDispatchDependencies;
  const iso = (offsetMs: number) => new Date(v.clock.now + offsetMs).toISOString();
  const fire = (triggerId: string, scheduledAt: string, options?: { forceLate?: boolean }) => handleChainSchedule(deps, { orgId: ORG_A, triggerId, scheduledAt }, v.clock.now, options);
  const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
  return { v, client, queue, logs, deps, iso, fire, runs };
}
const chainTrigger = async (v: TriggerWorld, over: Record<string, unknown> = {}) => {
  const chain = await v.budgetedChain(ONE_STEP);
  return { chain, trigger: await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: daily() as never, scheduleStatus: "ok", ...over }) };
};
const agentTrigger = async (v: TriggerWorld, over: Record<string, unknown> = {}) => {
  const spec = daily();
  const agent = await v.triggerAgent(`Nightly ${String(Math.random())}`, [{ kind: "person" }, spec], { budgetUsd: 20 });
  return { agent, trigger: await v.seed({ target: { kind: "agent", agentId: agent.agentId }, spec: spec as never, scheduleStatus: "ok", createdBy: DANA, ...over }) };
};

// ---- M-1: the overlap check is a claim

describe("M-1: two fires at once cannot both start", () => {
  it("of two different on-time slots arriving together, exactly one starts and the other is skipped as still running", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const answers = await Promise.all([s.fire(trigger.triggerId, s.iso(-20_000)), s.fire(trigger.triggerId, s.iso(-10_000))]);
    expect(answers.map((answer) => answer.outcome).sort()).toEqual(["skipped", "started"]);
    expect(answers.find((answer) => answer.outcome === "skipped")).toMatchObject({ reason: "previous_run_still_running" });
    expect(s.runs()).toHaveLength(1);
  });

  it("of an on-time slot and a late one together, still one run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    await Promise.all([s.fire(trigger.triggerId, s.iso(-10_000)), s.fire(trigger.triggerId, s.iso(-2 * HOUR))]);
    expect(s.runs()).toHaveLength(1);
  });

  it("of five different slots together, one run", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    await Promise.all([1, 2, 3, 4, 5].map((index) => s.fire(trigger.triggerId, s.iso(-index * 1_000))));
    expect(s.v.tasks.size).toBe(1);
  });

  it("holds the trigger while another slot's start is under way, and lets go of the hold once the work is noted", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const first = await s.fire(trigger.triggerId, s.iso(-10_000));
    expect(first.outcome).toBe("started");
    const after = (await s.v.triggers.get(ORG_A, trigger.triggerId))!;
    expect(after.lastRunId).toBe(first.runId);
    expect((after as unknown as { startClaim?: unknown }).startClaim).toBeUndefined();
  });

  it("a hold left by a start that was cut short blocks another slot for a few minutes, and no longer", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { startClaim: { slot: s.iso(-30 * MINUTE), at: s.iso(-MINUTE) } });
    expect(await s.fire(trigger.triggerId, s.iso(-5_000))).toMatchObject({ outcome: "skipped", reason: "previous_run_still_running" });
    s.v.clock.now += 11 * MINUTE;
    expect((await s.fire(trigger.triggerId, s.iso(-4_000))).outcome).toBe("started");
    expect(s.runs()).toHaveLength(1);
  });

  it("a hold on the same slot does not block its retry", async () => {
    const s = setup();
    const slot = s.iso(-5_000);
    const { trigger } = await chainTrigger(s.v, { startClaim: { slot, at: s.iso(-MINUTE) } });
    expect((await s.fire(trigger.triggerId, slot)).outcome).toBe("started");
  });

  it("lets go of the hold when the start is refused, fails in a way that may pass, or is held back by a cap", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    s.v.hooks.refuse.push(new Error("socket hang up"));
    await expect(s.fire(trigger.triggerId, s.iso(-5_000))).rejects.toThrow();
    expect(((await s.v.triggers.get(ORG_A, trigger.triggerId))! as unknown as { startClaim?: unknown }).startClaim).toBeUndefined();
    s.v.db.set({ ...orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10)), entityType: "ORG_AUTONOMOUS", count: 500 });
    expect(await s.fire(trigger.triggerId, s.iso(-4_000))).toMatchObject({ reason: "org_daily_limit" });
    expect(((await s.v.triggers.get(ORG_A, trigger.triggerId))! as unknown as { startClaim?: unknown }).startClaim).toBeUndefined();
  });
});

// ---- Task 27 review (minor): two fires of one slot spend one cap count

describe("two fires of the same slot at once spend one count of each cap", () => {
  const counts = (s: ReturnType<typeof setup>, triggerId: string) => ({
    hour: (s.v.db.get(triggerRateKey(ORG_A, triggerId, new Date(s.v.clock.now).toISOString().slice(0, 13))) as { count?: number } | undefined)?.count ?? 0,
    day: (s.v.db.get(orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10))) as { count?: number } | undefined)?.count ?? 0,
  });

  it("one run, one count against the trigger's hour and one against the org's day, and every answer names the run", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const slot = s.iso(-5_000);
    const answers = await Promise.all([s.fire(trigger.triggerId, slot), s.fire(trigger.triggerId, slot), s.fire(trigger.triggerId, slot)]);
    expect(s.runs()).toHaveLength(1);
    expect(counts(s, trigger.triggerId)).toEqual({ hour: 1, day: 1 });
    expect(answers.filter((answer) => answer.outcome === "started")).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer.runId)).size).toBe(1);
    expect(answers.filter((answer) => answer.outcome !== "started").every((answer) => answer.outcome === "duplicate")).toBe(true);
  });

  it("the same for an agent trigger", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const slot = s.iso(-5_000);
    await Promise.all([s.fire(trigger.triggerId, slot), s.fire(trigger.triggerId, slot)]);
    expect(s.v.starts).toHaveLength(1);
    expect(counts(s, trigger.triggerId)).toEqual({ hour: 1, day: 1 });
  });
});

// ---- Task 28 review: a fire that finds another fire's live claim on its first read backs off

describe("a fire that finds another fire's live claim of its own slot spends nothing", () => {
  const counts = (s: ReturnType<typeof setup>, triggerId: string) => ({
    hour: (s.v.db.get(triggerRateKey(ORG_A, triggerId, new Date(s.v.clock.now).toISOString().slice(0, 13))) as { count?: number } | undefined)?.count ?? 0,
    day: (s.v.db.get(orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10))) as { count?: number } | undefined)?.count ?? 0,
  });

  it("answers a duplicate for an agent trigger, spends no cap count and starts nothing, where a chain's run identity would have covered it", async () => {
    const s = setup();
    const slot = s.iso(-5_000);
    const { trigger } = await agentTrigger(s.v);
    // Another fire of this slot took the claim a second ago and is starting the task: this fire reads it on its very first read.
    const current = (await s.v.triggers.get(ORG_A, trigger.triggerId))!;
    await s.v.triggers.update({ trigger: current, patch: { startClaim: { slot, at: s.iso(-1_000) } } });
    expect(await s.fire(trigger.triggerId, slot)).toMatchObject({ outcome: "duplicate", reason: "start_in_progress" });
    expect(s.v.starts).toHaveLength(0);
    expect(counts(s, trigger.triggerId)).toEqual({ hour: 0, day: 0 });
  });

  it("still takes over a claim of its slot that is old enough to be a start that was cut short", async () => {
    const s = setup();
    const slot = s.iso(-5_000);
    const { trigger } = await agentTrigger(s.v);
    const current = (await s.v.triggers.get(ORG_A, trigger.triggerId))!;
    await s.v.triggers.update({ trigger: current, patch: { startClaim: { slot, at: s.iso(-MINUTE) } } });
    expect((await s.fire(trigger.triggerId, slot)).outcome).toBe("started");
    expect(counts(s, trigger.triggerId)).toEqual({ hour: 1, day: 1 });
  });
});

// ---- M-2: an open task without an end stops counting after the longest run

describe("M-2: a task with no end record does not block the trigger for ever", () => {
  const taskIdOf = async (s: ReturnType<typeof setup>, triggerId: string) => (await s.v.triggers.get(ORG_A, triggerId))!.lastTaskId!;
  const age = (s: ReturnType<typeof setup>, taskId: string, hours: number) => {
    const record = s.v.db.get(taskKey(taskId))!;
    s.v.db.set({ ...record, createdAt: new Date(s.v.clock.now - hours * HOUR).toISOString() });
  };

  it("still blocks while the task is younger than the longest run (168 hours)", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    expect((await s.fire(trigger.triggerId, s.iso(-10_000))).outcome).toBe("started");
    age(s, await taskIdOf(s, trigger.triggerId), 167);
    expect(await s.fire(trigger.triggerId, s.iso(-5_000))).toMatchObject({ outcome: "skipped", reason: "previous_run_still_running" });
  });

  it("treats it as ended after 168 hours, starts the next slot, and logs the task's id", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    expect((await s.fire(trigger.triggerId, s.iso(-10_000))).outcome).toBe("started");
    const taskId = await taskIdOf(s, trigger.triggerId);
    age(s, taskId, 169);
    expect((await s.fire(trigger.triggerId, s.iso(-5_000))).outcome).toBe("started");
    expect(s.logs).toContainEqual({ event: "schedule.open_task_expired", fields: { orgId: ORG_A, triggerId: trigger.triggerId, taskId } });
    expect(s.v.tasks.size).toBe(2);
  });
});

// ---- M-3: a late claim goes back when a cap skips the slot

describe("M-3: a slot skipped by a cap does not count as covered", () => {
  it("gives back the late claim when the org's day is used up, so the slot starts once the cap allows", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    const key = orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10));
    s.v.db.set({ ...key, entityType: "ORG_AUTONOMOUS", count: 500 });
    const slot = s.iso(-2 * HOUR);
    expect(await s.fire(trigger.triggerId, slot)).toMatchObject({ outcome: "skipped", reason: "org_daily_limit" });
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBeUndefined();
    s.v.db.set({ ...key, entityType: "ORG_AUTONOMOUS", count: 0 });
    expect((await s.fire(trigger.triggerId, slot)).outcome).toBe("started");
  });

  it("gives back the late claim when the trigger's hour is used up, so the slot starts once the cap allows", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v, { maxRunsPerHour: 1 });
    const key = triggerRateKey(ORG_A, trigger.triggerId, new Date(s.v.clock.now).toISOString().slice(0, 13));
    s.v.db.set({ ...key, entityType: "TRIGGER_RATE", count: 1 });
    const slot = s.iso(-2 * HOUR);
    expect(await s.fire(trigger.triggerId, slot)).toMatchObject({ outcome: "skipped", reason: "rate_limited" });
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBeUndefined();
    s.v.db.set({ ...key, entityType: "TRIGGER_RATE", count: 0 });
    expect((await s.fire(trigger.triggerId, slot)).outcome).toBe("started");
  });

  it("puts back the earlier lastFiredAt, not nothing, when the trigger had fired before", async () => {
    const s = setup();
    const before = "2020-01-01T00:00:00.000Z";
    const { trigger } = await chainTrigger(s.v, { lastFiredAt: before });
    s.v.db.set({ ...orgAutonomousKey(ORG_A, new Date(s.v.clock.now).toISOString().slice(0, 10)), entityType: "ORG_AUTONOMOUS", count: 500 });
    expect(await s.fire(trigger.triggerId, s.iso(-2 * HOUR))).toMatchObject({ reason: "org_daily_limit" });
    expect((await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastFiredAt).toBe(before);
  });
});

// ---- M-4: a letter that keeps failing is parked

describe("M-4: a dead letter that keeps failing is parked after a few tries", () => {
  const letter = (triggerId: string, scheduledAt: string) => ({ source: "agentx.chain-schedule", orgId: ORG_A, triggerId, scheduledAt });
  const sweep = (s: ReturnType<typeof setup>) => sweepSchedules(s.deps, { deadLetters: createDeadLetters({ sqs: s.queue, queueUrl: QUEUE_URL }), now: s.v.clock.now });

  it("asks the queue for each message's receive count", async () => {
    const s = setup();
    await sweep(s);
    expect(JSON.stringify(s.queue.lastAttributeRequest)).toContain("ApproximateReceiveCount");
  });

  it("handles a failing letter five times, then parks it for 12 hours and logs it, and stops starting anything for it", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const handle = s.queue.add(letter(trigger.triggerId, s.iso(-5_000)));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      s.v.hooks.refuse.push(new Error("socket hang up"));
      const report = await sweep(s);
      expect(report, `try ${String(attempt)}`).toMatchObject({ failed: 1, deadLetters: 0 });
    }
    expect(s.queue.parked).toEqual([]);
    const refusalsLeft = s.v.hooks.refuse.length;
    const sixth = await sweep(s);
    expect(sixth).toMatchObject({ deadLetters: 0 });
    expect(s.queue.parked).toEqual([{ handle, seconds: 43_200 }]);
    expect(s.logs).toContainEqual({ event: "schedule.dead_letter_parked", fields: { orgId: ORG_A, triggerId: trigger.triggerId, receives: 6 } });
    expect(s.queue.messages.map((message) => message.handle)).toEqual([handle]);
    expect(s.v.hooks.refuse.length).toBe(refusalsLeft);
    expect(s.v.tasks.size).toBe(0);
    // Parked, it is not received again, so it cannot use the sweep's ten.
    const seventh = await sweep(s);
    expect(seventh).toMatchObject({ deadLetters: 0, failed: 0 });
  });

  it("a letter that is handled on a later try leaves the queue as before", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    s.queue.add(letter(trigger.triggerId, s.iso(-5_000)));
    s.v.hooks.refuse.push(new Error("socket hang up"));
    expect(await sweep(s)).toMatchObject({ failed: 1 });
    expect(await sweep(s)).toMatchObject({ deadLetters: 1, failed: 0 });
    expect(s.queue.messages).toEqual([]);
    expect(s.queue.parked).toEqual([]);
  });

  it("a parked letter that cannot be parked is counted as failed and logged", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const handle = s.queue.add(letter(trigger.triggerId, s.iso(-5_000)));
    s.queue.receiveCounts.set(handle, 6);
    const original = s.queue.send;
    s.queue.send = async (command) => {
      if (command.constructor.name === "ChangeMessageVisibilityCommand") throw new Error("nope");
      return original(command);
    };
    expect(await sweep(s)).toMatchObject({ failed: 1 });
  });
});

// ---- M-5: a schedule that could not be deleted is logged

describe("M-5: deleting a trigger whose schedule could not be deleted", () => {
  it("still deletes the trigger, and logs the ids and the error's name (nothing else)", async () => {
    const v = setupTriggerWorld();
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
    const chain = await v.budgetedChain(ONE_STEP);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: daily() as never, scheduleStatus: "ok", createdBy: DANA });
    v.scheduler.failNext = Object.assign(new Error("token sk-SECRET"), { name: "ThrottlingException" });
    const deleted = await v.chainCall(DANA, "DELETE", `/v1/app/chains/${chain.chainId}/triggers/${trigger.triggerId}`, {});
    expect(deleted.body).toEqual({ deleted: true });
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toBeUndefined();
    expect(logs).toContainEqual({ event: "trigger_schedule.delete_failed", fields: { orgId: ORG_A, triggerId: trigger.triggerId, error: "ThrottlingException" } });
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
});

// ---- pins from the mutation pass

describe("pins: the claim, the hold and the record", () => {
  const holdOf = async (s: ReturnType<typeof setup>, triggerId: string) => (await s.v.triggers.get(ORG_A, triggerId))! as unknown as { startClaim?: { slot: string; at: string }; lastTaskId?: string; lastFiredAt?: string };
  /** Replaces the agent start so that, in the middle of it, the trigger's hold is taken by `claim`. */
  const takeOverDuring = (s: ReturnType<typeof setup>, triggerId: string, claim: { slot: string; at: string }, then: "throw" | "start") => {
    const ports = (s.deps as unknown as { chainRuns: { startAgentRun: (request: unknown) => Promise<unknown> } }).chainRuns;
    const original = ports.startAgentRun.bind(ports);
    ports.startAgentRun = async (request) => {
      const current = (await s.v.triggers.get(ORG_A, triggerId))!;
      await s.v.triggers.update({ trigger: current, patch: { startClaim: claim } });
      if (then === "throw") throw new Error("socket hang up");
      return original(request);
    };
  };

  it("a task open exactly 168 hours is over (the limit is inclusive)", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    expect((await s.fire(trigger.triggerId, s.iso(-10_000))).outcome).toBe("started");
    const taskId = (await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastTaskId!;
    s.v.db.set({ ...s.v.db.get(taskKey(taskId))!, createdAt: new Date(s.v.clock.now - 168 * HOUR).toISOString() });
    expect((await s.fire(trigger.triggerId, s.iso(-5_000))).outcome).toBe("started");
  });

  it("a task whose start time cannot be read keeps blocking (it cannot be aged)", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    await s.fire(trigger.triggerId, s.iso(-10_000));
    const taskId = (await s.v.triggers.get(ORG_A, trigger.triggerId))!.lastTaskId!;
    const record = { ...s.v.db.get(taskKey(taskId))! } as Record<string, unknown>;
    delete record["createdAt"];
    s.v.db.set(record);
    expect(await s.fire(trigger.triggerId, s.iso(-5_000))).toMatchObject({ outcome: "skipped", reason: "previous_run_still_running" });
  });

  it("a late slot whose start is refused keeps its claim, so the slots behind it are covered, and its hold goes", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    s.v.hooks.refuse.push(agentXError("CONFIG_INVALID", "not allowed"));
    expect(await s.fire(trigger.triggerId, s.iso(-2 * HOUR))).toMatchObject({ outcome: "failed", reason: "CONFIG_INVALID" });
    const after = await holdOf(s, trigger.triggerId);
    expect(after.startClaim).toBeUndefined();
    expect(after.lastFiredAt).toBeDefined();
    expect(await s.fire(trigger.triggerId, s.iso(-3 * HOUR))).toMatchObject({ outcome: "missed", reason: "covered_by_a_later_run" });
  });

  it("a release leaves a hold another fire took meanwhile, even one on the same slot", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const slot = s.iso(-5_000);
    const other = { slot: s.iso(-1_000), at: s.iso(-500) };
    takeOverDuring(s, trigger.triggerId, other, "throw");
    await expect(s.fire(trigger.triggerId, slot)).rejects.toThrow();
    expect((await holdOf(s, trigger.triggerId)).startClaim).toEqual(other);
    const same = await agentTrigger(s.v);
    const sameClaim = { slot, at: s.iso(-400) };
    takeOverDuring(s, same.trigger.triggerId, sameClaim, "throw");
    await expect(s.fire(same.trigger.triggerId, slot)).rejects.toThrow();
    expect((await holdOf(s, same.trigger.triggerId)).startClaim).toEqual(sameClaim);
  });

  it("noting the started work leaves a hold another slot took meanwhile", async () => {
    const s = setup();
    const { trigger } = await agentTrigger(s.v);
    const other = { slot: s.iso(-1_000), at: s.iso(-500) };
    takeOverDuring(s, trigger.triggerId, other, "start");
    expect((await s.fire(trigger.triggerId, s.iso(-5_000))).outcome).toBe("started");
    const after = await holdOf(s, trigger.triggerId);
    expect(after.startClaim).toEqual(other);
    expect(after.lastTaskId).toBeDefined();
  });

  it("a counter that cannot be written lets go of the hold and throws", async () => {
    const s = setup();
    const { trigger } = await chainTrigger(s.v);
    s.v.db.injectFault({ command: "UpdateCommand", match: (input) => JSON.stringify(input).includes("RATE"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(s.fire(trigger.triggerId, s.iso(-5_000))).rejects.toThrow();
    expect((await holdOf(s, trigger.triggerId)).startClaim).toBeUndefined();
    expect((await s.fire(trigger.triggerId, s.iso(-4_000))).outcome).toBe("started");
  });

  it("the record of a failed fire: the answer carries the code, the slot is written as an instant whatever its spelling, a name that is not a word is `unknown`, and a refusal's code must be one", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const put: string[] = [];
    const fail = (error: Error): TriggerDispatchDependencies => ({ triggers: { get: async () => { throw error; } }, log: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }) } as unknown as TriggerDispatchDependencies);
    const input = { orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: "2026-10-24T10:00:00+02:00" };
    const answer = await fireChainSchedule(fail(Object.assign(new Error("x"), { name: "ThrottlingException" })), input, Date.parse("2026-10-24T08:00:30.000Z"), { put: async (body) => { put.push(body); } });
    expect(answer).toEqual({ outcome: "dead_lettered", reason: "ThrottlingException" });
    expect(JSON.parse(put[0]!)).toMatchObject({ scheduledAt: "2026-10-24T08:00:00.000Z", failure: "ThrottlingException" });
    expect(logs).toContainEqual({ event: "schedule.fire_failed", fields: { orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", error: "ThrottlingException" } });
    await fireChainSchedule(fail(Object.assign(new Error("x"), { name: "Boom", code: "has spaces and a secret" })), input, Date.parse("2026-10-24T08:00:30.000Z"), { put: async (body) => { put.push(body); } });
    expect((JSON.parse(put[1]!) as { failure: string }).failure).toBe("Boom");
  });

  it("with no queue, the failure is logged by its code only, and thrown", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const deps = { triggers: { get: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "try again"); } }, log: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }) } as unknown as TriggerDispatchDependencies;
    await expect(fireChainSchedule(deps, { orgId: TEST_ORG, triggerId: "ctr_00000000000000000001", scheduledAt: new Date().toISOString() }, Date.now(), undefined)).rejects.toThrow();
    expect(logs).toEqual([{ event: "schedule.fire_failed_unrecorded", fields: { error: "RUNTIME_UNAVAILABLE" } }]);
  });

  it("reads a receive count that is missing or not a count as the first receive", async () => {
    const answers: Array<Record<string, unknown>> = [
      { Body: "a", ReceiptHandle: "h1" },
      { Body: "b", ReceiptHandle: "h2", Attributes: { ApproximateReceiveCount: "garbage" } },
      { Body: "c", ReceiptHandle: "h3", Attributes: { ApproximateReceiveCount: "0" } },
      { Body: "d", ReceiptHandle: "h4", Attributes: { ApproximateReceiveCount: "4" } },
    ];
    const letters = createDeadLetters({ sqs: { send: async () => ({ Messages: answers }) }, queueUrl: QUEUE_URL });
    expect((await letters.receive(10)).map((message) => message.receives)).toEqual([1, 1, 1, 4]);
  });
});
