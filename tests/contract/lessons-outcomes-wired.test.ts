// Lessons outcomes lane (0.5.11): the WIRED path from a task's end to a settled helpful mark, on the Dynamo lesson store (a fake table) and the runtime the broker builds (`createLessonsRuntime`): the real task-end handler
// sends ids to the queue, the queue's consumer is the real reflect worker (lease, deadline) running `learnFromEndedTaskTyped`, which counts the outcome with the runtime's counters and its model-backed judge, and the real
// nightly job settles the marks that fell due. Mutation checks (done by hand, see the lane's report): dropping `countOutcome`'s call in task-end.ts fails the first test; dropping the Off guard fails the Off test.
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "../../packages/contracts/src/index.js";
import { lessonsNightlyJob, type LessonsJobDeps } from "../../packages/broker/src/lessons/jobs.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import { dynamoReflectClaims } from "../../packages/broker/src/lessons/reflect-claims.js";
import type { ReflectQueue, ReflectQueueMessage } from "../../packages/broker/src/lessons/reflect-queue.js";
import { handleReflectBatch } from "../../packages/broker/src/lessons/reflect-worker.js";
import { createLessonsRuntime, type LessonsRuntime } from "../../packages/broker/src/lessons/runtime.js";
import { dynamoPauseStore } from "../../packages/broker/src/lessons/pause.js";
import { learnFromEndedTaskTyped, learningTaskEndHandler, type TaskLearningDeps, type TaskSubjectBase } from "../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../packages/broker/src/lessons/task-outcome-rows.js";
import type { EvidenceSpan } from "../../packages/broker/src/lessons/reflect-input.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { BASE, MERGED, PROJECT, WS, allowAllAccess, lessonRecord, reply } from "../unit/lessons/lesson-helpers.js";

const DAY = 86_400_000;
const KEY = { workspaceId: WS, project: PROJECT };
const T0 = 1_800_000_000_000;
const LESSON = "les_wired0001";

class World {
  now = T0;
  mode: "Off" | "Collect" | "Suggest" | "On" = "On";
  spans: EvidenceSpan[] = [];
  reverter: { actorDeveloperId?: string } | undefined;
  /** The outcome judge's model (a different one from the reflector's). */
  judgeModel: PipelineModel & { calls: Array<Record<string, unknown>>; replies: string[] };
  reflectCalls = 0;
  runtime: LessonsRuntime;
  learning: TaskLearningDeps;
  audit: AuditEventInput[] = [];
  private readonly record = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
  private readonly state = new FakeDynamoDb();
  readonly table = { documentClient: this.record, tableName: "record" };

  constructor() {
    const calls: Array<Record<string, unknown>> = [];
    const replies: string[] = [];
    this.judgeModel = {
      calls, replies,
      quote: async () => ({ ok: true, usd: 0.003 }),
      complete: async (request) => { calls.push({ ...request }); const next = replies.shift(); if (next === undefined) throw new Error("no scripted rating"); return { text: next, costUsd: 0.003, model: "judge-model" }; },
    };
    const pause = dynamoPauseStore(this.table, () => this.now);
    this.runtime = createLessonsRuntime({
      table: this.table, now: () => this.now, reader: { file: async () => undefined }, repositoriesOf: async () => ["api"], pause, model: this.judgeModel, spend: { admit: async () => true, look: async () => "ok" }, edition: "public",
      audit: async (event) => { this.audit.push(event); },
      evidence: { documentClient: this.record, tableName: "state", signInTableName: "signin", now: () => this.now }, linkedAccounts: async () => [], taskVisibility: allowAllAccess.taskVisibility,
      names: { memberName: async () => "x", isErased: async () => false },
    });
    const settings = { read: async () => ({ mode: this.mode, preset: "standard" as const }) };
    const rows: OutcomeRowReader = { sendBack: async () => undefined, revertedBy: async () => this.reverter };
    const reflectModel: PipelineModel = { complete: async () => { this.reflectCalls += 1; return { text: reply(), costUsd: 0.01, model: "reflect-model" }; }, quote: async () => ({ ok: true, usd: 0.01 }) };
    const base = (): TaskSubjectBase => ({
      facts: {
        workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged", task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
        rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [], spans: this.spans },
      },
      sendBackRequestIds: [],
    });
    this.learning = {
      source: { read: async () => base(), projectOf: async () => PROJECT }, rows, settings,
      reflect: { model: reflectModel, spend: { admit: async () => true }, audit: this.runtime.routes.audit, settings, edition: "public", now: () => this.now, pause },
      process: { ...this.runtime.routes, settings },
      counters: { ...this.runtime.counters, settings },
    };
  }

  /** The queue the task-end handler sends to; its consumer is the real reflect worker over the lease table. */
  readonly queue: ReflectQueue = {
    send: async (message: ReflectQueueMessage) => {
      const claims = dynamoReflectClaims({ documentClient: this.state, tableName: "state", keysOutcome: async () => "clear" });
      const result = await handleReflectBatch({ claims, learn: (request) => learnFromEndedTaskTyped(this.learning, request), now: () => this.now, deadlineMs: 60_000, log: () => undefined }, { Records: [{ messageId: `m-${Math.random()}`, body: JSON.stringify(message) }] });
      expect(result.batchItemFailures).toEqual([]);
    },
  };
  /** A task ends: the handler `registerTaskEndHandler` holds. */
  async end(outcome: "merged" | "closed", taskId = "task-1"): Promise<void> {
    await learningTaskEndHandler(() => ({ queue: this.queue }))({} as never, { orgId: WS, taskId, outcome, runLimitUsd: 1, spentUsd: 0 });
  }
  /** The nightly revert job's message for a reverted task (the job sends exactly this to the same queue). */
  async revert(taskId = "task-1"): Promise<void> { await this.queue.send({ orgId: WS, taskId, outcome: "reverted", requestId: `nightly-${Math.random()}` }); }

  async seedLesson(tier: 0 | 1 = 1): Promise<void> {
    const lesson = lessonRecord({ id: LESSON, status: "active", type: "convention", tier, approvals: [{ approvalId: "p1", by: "ann", at: 1, mode: "one" }], expiresAt: this.now + 5 * DAY });
    const sv = await this.runtime.store.setVersion(KEY);
    expect((await this.runtime.store.commit(KEY, sv, [lesson], this.now)).ok).toBe(true);
    await this.runtime.store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: this.now, lessons: [{ id: LESSON, version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
  }
  queued = async (): Promise<string[]> => (await this.runtime.store.duePending(KEY, this.now + 60 * DAY, 100)).map((entry) => entry.key);
  lesson = async () => (await this.runtime.store.get(KEY, LESSON))!;
  async night(): Promise<Record<string, number>> {
    const jobs: LessonsJobDeps = { table: this.table, settings: this.learning.settings, maintain: this.runtime.counters, counters: this.learning.counters, resume: async () => ({ finished: 0, failed: 0 }), now: () => this.now, newRequestId: () => "n", log: () => undefined };
    return lessonsNightlyJob(jobs, WS, [PROJECT], 30_000);
  }
}

const MARK = `helpful:task-1:${LESSON}`;

describe("a task's outcome reaches the lessons it loaded, through the real task-end path into the Dynamo store", () => {
  it("a lesson loaded on a merged task with no corrections gets a queued helpful mark; it is not applied before the window; it settles after it and renews the lesson's expiry", async () => {
    const w = new World();
    await w.seedLesson();
    await w.end("merged");
    expect(await w.queued()).toEqual([MARK]);
    expect(w.judgeModel.calls).toEqual([]);
    const expiry = (await w.lesson()).expiresAt;
    // Day 10: inside the revert window, nothing settles; the queued mark alone holds the lesson.
    w.now += 10 * DAY;
    expect(await w.night()).toMatchObject({ helpfulSettled: 0 });
    expect((await w.lesson()).counters.helpful).toBe(0);
    expect((await w.lesson()).status).toBe("active");
    // Day 15: due. Settled once, applied once, the clock restarts at the settle.
    w.now += 5 * DAY;
    expect(await w.night()).toMatchObject({ helpfulSettled: 1, lessonsExpired: 0 });
    const settled = await w.lesson();
    expect(settled.counters.helpful).toBe(1);
    expect(settled.expiresAt).toBe(w.now + 90 * DAY);
    expect(settled.expiresAt).toBeGreaterThan(expiry);
    expect(await w.queued()).toEqual([]);
    expect(await w.night()).toMatchObject({ helpfulSettled: 0 });
    // The same end delivered again (a redelivery after the settle) queues nothing and counts nothing.
    await w.end("merged");
    expect(await w.queued()).toEqual([]);
    expect((await w.lesson()).counters.helpful).toBe(1);
  });

  it("a revert before the settle takes the mark back: the lesson is not renewed, and a merge delivered again later queues nothing", async () => {
    const w = new World();
    await w.seedLesson();
    await w.end("merged");
    expect(await w.queued()).toEqual([MARK]);
    w.now += 3 * DAY;
    w.reverter = { actorDeveloperId: "rev" };
    await w.revert();
    expect(await w.queued()).toEqual([]);
    w.now += 20 * DAY;
    expect(await w.night()).toMatchObject({ helpfulSettled: 0 });
    expect((await w.lesson()).counters.helpful).toBe(0);
    await w.end("merged", "task-1");
    expect(await w.queued()).toEqual([]);
  });

  it("a revert nobody verified (no member on the person-link row) takes nothing back", async () => {
    const w = new World();
    await w.seedLesson();
    await w.end("merged");
    w.reverter = {};
    await w.revert();
    expect(await w.queued()).toEqual([MARK]);
  });

  it("a correction the customer's model judges 'caused' marks the lesson harmful, with no helpful mark; the call is the outcome purpose, held to Public's cap, on the quoted hold", async () => {
    const w = new World();
    await w.seedLesson();
    w.spans = [{ kind: "pr_comment", text: "On src/a.ts: the helper broke the retry", trust: "member", authorId: "rev", eventId: "ev-1" }];
    w.judgeModel.replies.push('{"rating":"caused"}');
    await w.end("merged");
    expect(w.judgeModel.calls).toHaveLength(1);
    // Public's one per-task cap ($0.15) less what the reflection held ($0.01): the judge is asked for what is left.
    expect(w.judgeModel.calls[0]).toMatchObject({ purpose: "outcome", workspaceId: WS, project: PROJECT, budgetUsd: 0.003 });
    expect(Number(w.judgeModel.calls[0]!["maxHoldUsd"])).toBeCloseTo(0.14, 6);
    expect((await w.lesson()).counters.harmful).toBe(1);
    expect(await w.queued()).toEqual([]);
  });

  it("two different members whose corrections are judged 'caused' retire a tier-0 lesson; one member's corrections on several tasks are one mark", async () => {
    const w = new World();
    await w.seedLesson(0);
    w.spans = [{ kind: "pr_comment", text: "This is wrong, avoid this helper", trust: "member", authorId: "dev-ann", eventId: "ev-a" }, { kind: "pr_comment", text: "Please don't use this helper here", trust: "member", authorId: "dev-bob", eventId: "ev-b" }];
    w.judgeModel.replies.push('{"rating":"caused"}', '{"rating":"caused"}');
    await w.end("merged");
    expect(await w.lesson()).toMatchObject({ status: "retired", counters: { harmful: 2 } });
    const solo = new World();
    await solo.seedLesson(0);
    solo.spans = [w.spans[0]!, { ...w.spans[1]!, authorId: "dev-ann" }];
    solo.judgeModel.replies.push('{"rating":"caused"}', '{"rating":"caused"}');
    await solo.end("merged");
    expect(await solo.lesson()).toMatchObject({ status: "active", counters: { harmful: 1 } });
  });

  it("the reflection runs before any judge call", async () => {
    const w = new World();
    await w.seedLesson();
    w.spans = [{ kind: "pr_comment", text: "This is wrong, avoid this helper", trust: "member", authorId: "dev-ann", eventId: "ev-a" }];
    w.judgeModel.replies.push('{"rating":"unrelated"}');
    const order: string[] = [];
    const complete = w.judgeModel.complete.bind(w.judgeModel);
    w.judgeModel.complete = async (request) => { order.push("judge"); return complete(request); };
    const reflect = w.learning.reflect.model;
    w.learning.reflect.model = { ...reflect, complete: async (request) => { order.push("reflect"); return reflect.complete(request); } };
    await w.end("merged");
    expect(order).toEqual(["reflect", "judge"]);
  });

  it("a judge that fails leaves the correction unjudged: no harmful and no helpful mark", async () => {
    const w = new World();
    await w.seedLesson();
    w.spans = [{ kind: "remembered", text: "use the other helper", trust: "member", authorId: "rev", eventId: "ev-2" }];
    await w.end("merged");
    expect(w.judgeModel.calls).toHaveLength(1);
    expect((await w.lesson()).counters.harmful).toBe(0);
    expect(await w.queued()).toEqual([]);
  });

  it("learning Off records nothing: no judge call, no mark, no counter; the same task with learning On does (positive control)", async () => {
    const off = new World();
    await off.seedLesson();
    off.mode = "Off";
    off.spans = [{ kind: "pr_comment", text: "You should use the shared helper here", trust: "member", authorId: "rev", eventId: "ev-3" }];
    off.judgeModel.replies.push('{"rating":"caused"}');
    await off.end("merged");
    expect(off.judgeModel.calls).toEqual([]);
    expect(await off.queued()).toEqual([]);
    expect((await off.lesson()).counters).toMatchObject({ helpful: 0, harmful: 0 });
    const on = new World();
    await on.seedLesson();
    on.spans = off.spans;
    on.judgeModel.replies.push('{"rating":"unrelated"}');
    await on.end("merged");
    expect(on.judgeModel.calls).toHaveLength(1);
    expect(await on.queued()).toEqual([MARK]);
  });

  it("a model that cannot be used (the quote refuses) records nothing and queues no helpful mark", async () => {
    const w = new World();
    await w.seedLesson();
    w.judgeModel.quote = async () => ({ ok: false, code: "no_provider" });
    await w.end("merged");
    expect(w.judgeModel.calls).toEqual([]);
    expect(await w.queued()).toEqual([]);
  });
});
