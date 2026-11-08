// Lessons in production, lane 1: the task-end learning dependencies are built where the Team record AND the model path exist, and the inline model-calling handler is NOT registered from production wiring.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spendCounterKey } from "@agentx/contracts";
import { hasTaskEndHandlers } from "../../packages/broker/src/agents/task-end.js";
import { INLINE_LEARNING_TASK_END_ENABLED, installLearningTaskEnd, learningDepsInUse, uninstallLearningTaskEnd } from "../../packages/broker/src/aws/broker/learning-wiring.js";
import type { learningDepsFor, lessonsRuntimeFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { LEARNING_COUNTER } from "../../packages/broker/src/aws/broker/learning-spend.js";
import { installLessons, lessonSimilarityFor } from "../../packages/broker/src/aws/broker/lessons-wiring.js";
import { announceHumanSendBack } from "../../packages/broker/src/lessons/send-back-events.js";
import { DENYING_SPEND, NO_EMBEDDER, NO_VECTORS, REFUSING_MODEL } from "../../packages/broker/src/lessons/runtime.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => uninstallLearningTaskEnd());

const sendBack = vi.fn(async (input: unknown) => { void input; });
function install(over: { modelAccess?: boolean; teamRecord?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const dependencies = {
    documentClient: db, tableName: "state", developer: { signInTableName: "signin" }, artifactBucketName: "artifacts", s3: { send: async () => ({}) },
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

describe("the inline handler is not registered from production wiring (it would call the model while a task ends)", () => {
  it("the flag is off, and installing the broker's learning dependencies registers no task-end handler and no send-back listener", async () => {
    expect(INLINE_LEARNING_TASK_END_ENABLED).toBe(false);
    const { dependencies } = install();
    installLessons(dependencies as never);
    const before = hasTaskEndHandlers();
    installLearningTaskEnd(dependencies);
    expect(hasTaskEndHandlers()).toBe(before);
    expect(hasTaskEndHandlers()).toBe(false);
    // The dependencies are kept for the queue worker, and a human send-back does not reach them.
    expect(learningDepsInUse()).toBe(dependencies.learning);
    await announceHumanSendBack({ workspaceId: TEST_ORG, project: "p", taskId: "t", requestId: "r", actorDeveloperId: "d", instructions: "x", round: 1, shared: false, ownerDeveloperId: "o", at: "2026-11-01T00:00:00.000Z" });
    expect(sendBack).not.toHaveBeenCalled();
  });

  it("only an explicit opt-in registers it (the unit tests of the handler itself)", () => {
    const { dependencies } = install();
    installLessons(dependencies as never);
    installLearningTaskEnd(dependencies, { inline: true });
    expect(hasTaskEndHandlers()).toBe(true);
  });

  it("the handler builds the dependencies before it installs the hook", () => {
    const handler = readFileSync(new URL("../../packages/broker/src/aws/broker/handler.ts", import.meta.url), "utf8");
    expect(handler.indexOf("installLessons(dependencies);")).toBeGreaterThan(0);
    expect(handler.indexOf("installLearningTaskEnd(dependencies);")).toBeGreaterThan(handler.indexOf("installLessons(dependencies);"));
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
