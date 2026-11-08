// Lessons in production, lane 1: the task-end learning dependencies are built where the Team record AND the model path exist, and the inline model-calling handler is NOT registered from production wiring.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spendCounterKey } from "@agentx/contracts";
import { hasTaskEndHandlers } from "../../packages/broker/src/agents/task-end.js";
import { installLearningTaskEnd, learningDepsInUse, uninstallLearningTaskEnd } from "../../packages/broker/src/aws/broker/learning-wiring.js";
import type { learningDepsFor, lessonsRuntimeFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { LEARNING_COUNTER } from "../../packages/broker/src/aws/broker/learning-spend.js";
import { createLessonsWorkerHandler } from "../../packages/broker/src/aws/broker/lessons-worker.js";
import { installLessons, lessonSimilarityFor, pauseStillAppliesFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { installTeamRecordEmitter, uninstallTeamRecordEmitter } from "../../packages/broker/src/aws/broker/team-record-wiring.js";
import { announceHumanSendBack } from "../../packages/broker/src/lessons/send-back-events.js";
import { DENYING_SPEND, NO_EMBEDDER, NO_VECTORS, REFUSING_MODEL } from "../../packages/broker/src/lessons/runtime.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { uninstallLearningTaskEnd(); sendBack.mockClear(); });

const sendBack = vi.fn(async (input: unknown) => { void input; });
function install(over: { modelAccess?: boolean; teamRecord?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const dependencies = {
    documentClient: db, tableName: "state", agents: {}, developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
    ...(over.teamRecord === false ? {} : { teamRecord: { table: { documentClient: new FakeDynamoDb(), tableName: "record" }, edition: "public", emitter: { sendBack }, taskVisibility: async () => ({ kind: "shared" }) } }),
    ...(over.modelAccess === false ? {} : { modelAccess: { access: { learningCompletion: async () => ({ text: "{}", model: "m" }) }, proxyUrl: "http://proxy" } }),
  } as Record<string, unknown>;
  return { db, dependencies };
}

describe("the learning dependencies", () => {
  it("are built where the Team record and the model path exist, from the runtime's own pieces", () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const runtime = dependencies.lessons as ReturnType<typeof lessonsRuntimeFor> & object;
    const learning = dependencies.learning as NonNullable<ReturnType<typeof learningDepsFor>>;
    expect(runtime).toBeDefined();
    expect(learning).toBeDefined();
    expect(learning.settings).toBe(runtime.settings);
    expect(learning.rovara).toBe((dependencies.teamRecord as { emitter: unknown }).emitter);
    // The company's own model and payer path replace the refusing stand-ins everywhere they are used.
    expect(learning.reflect.model).toBe(runtime.routes.judgeModel);
    expect(learning.reflect.spend).toBe(runtime.routes.spend);
    expect(learning.process.judgeModel).toBe(runtime.routes.judgeModel);
    expect(learning.process.spend).toBe(runtime.routes.spend);
    expect(runtime.routes.judgeModel).not.toBe(REFUSING_MODEL);
    expect(runtime.routes.spend).not.toBe(DENYING_SPEND);
    expect(learning.reflect.edition).toBe("public");
  });

  it("the one pause store (\"lessons paused\", lane 1b) is shared by the Lessons tab, the curator and the reflector, so a reason recorded anywhere is the one the tab shows", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const runtime = dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>;
    const learning = dependencies.learning as NonNullable<ReturnType<typeof learningDepsFor>>;
    expect(runtime.routes.pause).toBeDefined();
    expect(learning.reflect.pause).toBe(runtime.routes.pause);
    expect(learning.process.pause).toBe(runtime.routes.pause);
    await runtime.routes.pause!.record(TEST_ORG, "web", "no_provider");
    expect(await runtime.routes.pause!.read(TEST_ORG, "web")).toMatchObject({ code: "no_provider", scope: "project" });
  });

  it("L3: the pause view is wired with a check that clears a reason whose cause is gone, and the audit outbox is wired where the install has a ledger", () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const runtime = dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>;
    expect(runtime.routes.pauseStillApplies).toBeTypeOf("function");
    // No ledger on this install: the audit sink cannot stage a change into a transaction.
    expect("stage" in runtime.routes.audit).toBe(false);
    const ledgered = install();
    ledgered.dependencies.audit = { sqs: { send: async () => ({}) }, queueUrl: "http://queue", documentClient: ledgered.db, tableName: "state", now: Date.now, log: () => undefined };
    installLessons(ledgered.dependencies as never);
    expect("stage" in (ledgered.dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>).routes.audit).toBe(true);
  });

  it("L3: pauseStillAppliesFor re-asks the model's quote for a provider, model or budget reason; the month's look for the monthly limit; and keeps the size and provider-failure reasons for the next call", async () => {
    const quotes: unknown[] = [];
    let answer: { ok: boolean; code?: string } = { ok: true };
    const model = { complete: async () => ({ text: "", costUsd: 0, model: "m" }), quote: async (request: unknown) => { quotes.push(request); if (answer.ok === undefined) throw new Error("down"); return answer as never; } };
    let look: "ok" | "month_full" = "ok";
    const spend = { admit: async () => look === "ok", look: async () => look };
    const applies = pauseStillAppliesFor(model, spend);
    // The cause is gone (a provider was connected): the quote is accepted, so the reason no longer applies.
    expect(await applies(TEST_ORG, "web", "no_provider")).toBe(false);
    expect(quotes[0]).toMatchObject({ purpose: "reflect", workspaceId: TEST_ORG, project: "web" });
    answer = { ok: false, code: "no_provider" };
    expect(await applies(TEST_ORG, "web", "no_provider")).toBe(true);
    expect(await applies(TEST_ORG, "web", "all_models_forbidden")).toBe(true);
    // A reason that depends on the size of the call, or on what the provider did, is left for the next learning call.
    answer = { ok: true };
    expect(await applies(TEST_ORG, "web", "cost_too_high")).toBe(true);
    expect(await applies(TEST_ORG, "web", "model_failed")).toBe(true);
    expect(await applies(TEST_ORG, "web", "monthly_limit")).toBe(false);
    look = "month_full";
    expect(await applies(TEST_ORG, "web", "monthly_limit")).toBe(true);
    const broken = pauseStillAppliesFor({ ...model, quote: async () => { throw new Error("down"); } }, spend);
    expect(await broken(TEST_ORG, "web", "no_budget")).toBe(true);
  });

  it("are not built without the model path (the lessons runtime then keeps its refusing stand-ins), without the Team record, or when a caller gave its own", async () => {
    const noModel = install({ modelAccess: false });
    installLessons(noModel.dependencies as never);
    expect(noModel.dependencies.lessons).toBeDefined();
    expect(noModel.dependencies.learning).toBeUndefined();
    const runtime = noModel.dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>;
    expect(runtime.routes.judgeModel).toBe(REFUSING_MODEL);
    expect(runtime.routes.spend).toBe(DENYING_SPEND);
    const off = install({ teamRecord: false });
    installLessons(off.dependencies as never);
    expect(off.dependencies.lessons).toBeUndefined();
    expect(off.dependencies.learning).toBeUndefined();
    const given = {};
    const kept = { ...install().dependencies, learning: given };
    installLessons(kept as never);
    expect(kept.learning).toBe(given);
  });

  it("the spend gate is the company's learning month on the install's State table: a look that holds and writes nothing, refusing when the month's counter has no room", async () => {
    const { dependencies, db } = install();
    installLessons(dependencies as never);
    const runtime = dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>;
    expect(await runtime.routes.spend.admit(TEST_ORG, 0.15)).toBe(true);
    expect(db.find((item) => item["entityType"] === "LEARNING_SPEND" || item["entityType"] === "SPEND_COUNTER")).toHaveLength(0);
    const month = new Date().toISOString().slice(0, 7);
    db.set({ ...spendCounterKey(TEST_ORG, month, LEARNING_COUNTER), entityType: "SPEND_COUNTER", spentUsd: 19.95, committedUsd: 19.95 });
    expect(await runtime.routes.spend.admit(TEST_ORG, 0.15)).toBe(false);
  });

  it("similarity is one seam: the load and route dependencies and the learning pieces take the embedder and the vectors from lessonSimilarityFor, which has none today", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const runtime = dependencies.lessons as NonNullable<ReturnType<typeof lessonsRuntimeFor>>;
    const seam = lessonSimilarityFor(dependencies);
    expect(seam.embedder).toBe(NO_EMBEDDER);
    expect(seam.vectors).toBe(NO_VECTORS);
    expect(runtime.load.embedder).toBe(seam.embedder);
    expect(runtime.routes.embedder).toBe(seam.embedder);
    expect(runtime.routes.vectors).toBe(seam.vectors);
    const learning = dependencies.learning as NonNullable<ReturnType<typeof learningDepsFor>>;
    expect(learning.process.embedder).toBe(seam.embedder);
    expect(learning.process.vectors).toBe(seam.vectors);
  });
});

describe("lessons in production, lane 2: a task's end sends ids to the queue (WB-4); one send-back listener (L6)", () => {
  const queue = () => { const sent: unknown[] = []; return { sent, queue: { send: async (m: unknown) => { sent.push(m); } } }; };

  it("the inline flag is gone: production registers the ENQUEUING handler where the learning dependencies and a queue exist, and nothing without a queue", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    installLearningTaskEnd(dependencies);
    expect(hasTaskEndHandlers()).toBe(false);
    const q = queue();
    dependencies.lessonsReflectQueue = q.queue;
    installLearningTaskEnd(dependencies);
    expect(hasTaskEndHandlers()).toBe(true);
    expect(learningDepsInUse()).toBe(dependencies.learning);
    expect(readFileSync(new URL("../../packages/broker/src/aws/broker/learning-wiring.ts", import.meta.url), "utf8")).not.toMatch(/INLINE_LEARNING|inline/u);
  });

  it("a task that ends sends one message of ids and the model is never called by the broker", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const q = queue();
    dependencies.lessonsReflectQueue = q.queue;
    installLearningTaskEnd(dependencies);
    const completion = vi.fn();
    (dependencies.modelAccess as { access: { learningCompletion: unknown } }).access.learningCompletion = completion;
    const { onTaskEnded } = await import("../../packages/broker/src/agents/task-end.js");
    const taskId = "11111111-1111-4111-8111-111111111111";
    const task = { taskId, orgId: TEST_ORG, project: "p", developerId: "d", ownerKey: "o", workspaceId: "w" };
    await onTaskEnded({ documentClient: dependencies.documentClient, tableName: "state", now: Date.now, log: () => undefined } as never, task as never, "merged", {}, { record: true });
    expect(q.sent).toEqual([{ orgId: TEST_ORG, taskId, outcome: "merged", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as string }]);
    expect(completion).not.toHaveBeenCalled();
  });

  it("L6: installing the learning hook registers no human send-back listener; the Team record's one listener writes a send-back once", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    dependencies.lessonsReflectQueue = queue().queue;
    (dependencies.teamRecord as Record<string, unknown>)["jobs"] = undefined;
    installLearningTaskEnd(dependencies);
    const event = { workspaceId: TEST_ORG, project: "p", taskId: "t", requestId: "r", actorDeveloperId: "d", instructions: "x", round: 1, shared: false, ownerDeveloperId: "o", at: "2026-11-01T00:00:00.000Z" };
    await announceHumanSendBack(event);
    expect(sendBack).not.toHaveBeenCalled();
    installTeamRecordEmitter(dependencies);
    try {
      await announceHumanSendBack(event);
      expect(sendBack).toHaveBeenCalledTimes(1);
    } finally { uninstallTeamRecordEmitter(); }
  });

  it("the handler builds the dependencies before it installs the hook", () => {
    const handler = readFileSync(new URL("../../packages/broker/src/aws/broker/handler.ts", import.meta.url), "utf8");
    expect(handler.indexOf("installLessons(dependencies);")).toBeGreaterThan(0);
    expect(handler.indexOf("installLearningTaskEnd(dependencies);")).toBeGreaterThan(handler.indexOf("installLessons(dependencies);"));
  });
});

describe("the LessonsWorker handler (lane 2): the slim entry builds the same learning dependencies", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const batch = { Records: [{ messageId: "m1", body: JSON.stringify({ orgId: TEST_ORG, taskId, outcome: "merged", requestId: "r1" }) }] };

  it("builds the learning dependencies from the same dependencies as the broker, takes the lease on the task in the State table and reflects (a task that does not exist teaches nothing, and its lease is done all the same)", async () => {
    const { dependencies, db } = install();
    const handler = createLessonsWorkerHandler(() => dependencies as never);
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
    expect(db.find((item) => item["pk"] === `LEARN#${TEST_ORG}#${taskId}#merged`)).toHaveLength(1);
    expect(db.find((item) => item["pk"] === `LEARN#${TEST_ORG}#${taskId}#merged`)[0]).toMatchObject({ leaseState: "done", attempt: 1 });
    // The same message again (SQS delivers at least once): the lease is done, nothing more is written.
    const writes = db.find(() => true).length;
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
    expect(db.find(() => true).length).toBe(writes);
  });

  it("R5: only a PAUSED record (TEAM_RECORD_ACTIVE exactly \"0\") answers the messages quietly (dropped, nothing claimed); a missing record runtime, model path or ledger is a misconfiguration: the handler throws (the Errors alarm fires, the messages stay in the queue), and the next invocation builds again", async () => {
    for (const over of [{ teamRecord: false }, { modelAccess: false }] as const) {
      const { dependencies, db } = install(over);
      // Paused: quiet.
      expect(await createLessonsWorkerHandler(() => dependencies as never, { env: { TEAM_RECORD_ACTIVE: "0" } })(batch)).toEqual({ batchItemFailures: [] });
      // Not paused (the variable is "1", or absent, or anything else): a named failure.
      for (const env of [{ TEAM_RECORD_ACTIVE: "1" }, {}, { TEAM_RECORD_ACTIVE: "" }, { TEAM_RECORD_ACTIVE: "false" }]) {
        await expect(createLessonsWorkerHandler(() => dependencies as never, { env })(batch)).rejects.toThrow(/not configured/u);
      }
      expect(db.find((item) => String(item["pk"]).startsWith("LEARN#"))).toHaveLength(0);
    }
    // A failed build is not remembered: once the value is there the same handler goes on.
    const broken = install({ modelAccess: false });
    const good = install();
    let current = broken.dependencies;
    const handler = createLessonsWorkerHandler(() => current as never, { env: {} });
    await expect(handler(batch)).rejects.toThrow();
    current = good.dependencies;
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
  });

  it("the lease table failing brings the message back, and the next delivery goes through", async () => {
    const { dependencies, db } = install();
    const handler = createLessonsWorkerHandler(() => dependencies as never);
    db.injectFault({ command: "PutCommand", match: (input) => String((input.Item as { pk?: string } | undefined)?.pk ?? "").startsWith("LEARN#"), error: { name: "InternalServerError" }, times: 1 });
    expect(await handler(batch)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
  });
});

describe("L4: the lessons' scheduled jobs", () => {
  const withJobs = (paused: boolean) => {
    const { dependencies, db } = install();
    const registered: string[] = [];
    const teamRecord = dependencies.teamRecord as Record<string, unknown>;
    teamRecord["jobs"] = { extend: (job: string) => { registered.push(job); } };
    if (paused) teamRecord["paused"] = true;
    return { dependencies, db, registered };
  };
  it("a running record gets both: the hourly resume of half-done deletions and the nightly re-reflection of reverts", () => {
    const { dependencies, registered } = withJobs(false);
    installLessons(dependencies as never);
    expect(registered).toEqual(["hourly", "nightly"]);
  });
  it("a PAUSED record still gets the hourly resume (an erase must finish whether or not the record is paused), on a store-only port, and no nightly re-reflection (a paused record learns nothing)", () => {
    const { dependencies, registered } = withJobs(true);
    installLessons(dependencies as never);
    expect(dependencies.lessons).toBeUndefined();
    expect(registered).toEqual(["hourly"]);
  });
});

describe("what the production subject source is given", () => {
  it("reads through the install's own readers: a task that does not exist gives nothing, and nothing is read from Slack", async () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    const learning = dependencies.learning as NonNullable<ReturnType<typeof learningDepsFor>>;
    expect(await learning.source.read({ workspaceId: TEST_ORG, taskId: "11111111-1111-4111-8111-111111111111" })).toBeUndefined();
  });
});

describe("human fix-up commits and the corrections people already make", () => {
  it("the extractor is installed in the Team record's tap, with NO queue (a model call does not fit the ops queue's 30 seconds), and the subject source reads the record's captured words", async () => {
    const { dependencies } = install();
    const installed: Array<{ extractor: unknown; enqueue?: unknown }> = [];
    (dependencies.teamRecord as Record<string, unknown>).humanEdit = { install: (input: { extractor: unknown; enqueue?: unknown }) => { installed.push(input); } };
    installLessons(dependencies as never);
    expect(installed).toHaveLength(1);
    expect(typeof (installed[0]!.extractor as { extract: unknown }).extract).toBe("function");
    expect(installed[0]!.enqueue).toBeUndefined();
  });

  it("not installed without the model path or the Team record", () => {
    const noModel = install({ modelAccess: false });
    const installed: unknown[] = [];
    (noModel.dependencies.teamRecord as Record<string, unknown>).humanEdit = { install: (input: unknown) => { installed.push(input); } };
    installLessons(noModel.dependencies as never);
    expect(installed).toEqual([]);
  });
});
