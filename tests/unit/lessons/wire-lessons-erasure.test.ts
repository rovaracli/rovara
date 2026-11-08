// Wiring lane wire-lessons, erasure: a person's lesson that was loaded into a task leaves no text behind once the person is erased. The record of what a task loaded (the manifest) holds ids
// and scores, never lesson text, and the erasure removes the lesson from it; the stage's stored delivery copy loses the lessons as soon as it is delivered.
import { describe, expect, it } from "vitest";
import { markDeliveredCommand } from "../../../packages/broker/src/aws/dispatcher.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { loadLessonsForStage, type LoadDeps } from "../../../packages/broker/src/lessons/load.js";
import { lessonPanelRows } from "../../../packages/broker/src/lessons/panel.js";
import { NO_VECTORS } from "../../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { Audit, Clock, KEY, PROJECT, WS, allowAllAccess, lessonRecord, seed, settings } from "./lesson-helpers.js";

const SECRET_TITLE = "Mallory's private retry convention";
const SECRET_BODY = "Call the internal retry endpoint at the secret path before every request.";

describe("a loaded lesson of an erased person", () => {
  async function loaded() {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const lesson = lessonRecord({
      id: "les_mallory01", type: "convention", tier: 1, title: SECRET_TITLE, body: SECRET_BODY, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }],
      provenance: { ...lessonRecord().provenance, authors: ["mallory"], sources: ["member:mallory"], inputSources: ["member:mallory"] },
    });
    await seed(store, lesson);
    const deps: LoadDeps = { store, vectors: NO_VECTORS, settings: settings(), access: allowAllAccess, audit: new Audit(), now: clock.now };
    const request = { workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT" as const, round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" as const } };
    return { store, deps, request, port: lessonDeletionPort({ store, vectors: NO_VECTORS, audit: new Audit(), now: clock.now }) };
  }

  it("the record of what a task loaded holds no lesson text, and the erasure takes the lesson out of it and out of every later load", async () => {
    const { store, deps, request, port } = await loaded();
    const first = await loadLessonsForStage(deps, request);
    expect(first.context?.lessons.map((l) => l.id)).toEqual(["les_mallory01"]);
    // The agent got the text; the record of the load did not keep it.
    expect(JSON.stringify(await store.manifests(KEY, "task-1"))).not.toContain("retry");
    expect(JSON.stringify(await store.manifests(KEY, "task-1"))).not.toContain("Mallory");
    expect((await lessonPanelRows(store, KEY, "task-1", { principals: [], groups: [] }, allowAllAccess))[0]).toMatchObject({ lessonId: "les_mallory01", title: SECRET_TITLE });

    await port.erasePerson(WS, PROJECT, { developerId: "mallory" }, new Set());

    expect(await store.get(KEY, "les_mallory01")).toBeUndefined();
    const manifests = await store.manifests(KEY, "task-1");
    expect(manifests.flatMap((m) => m.lessons)).toEqual([]);
    expect(JSON.stringify(manifests)).not.toContain("les_mallory01");
    expect(await lessonPanelRows(store, KEY, "task-1", { principals: [], groups: [] }, allowAllAccess)).toEqual([]);
    const again = await loadLessonsForStage(deps, { ...request, taskId: "task-2" });
    expect(again.context).toBeUndefined();
    expect(JSON.stringify(await store.list(KEY, { statuses: ["active", "pending", "retired", "withdrawn", "rejected", "stale", "expired", "candidate"] }))).not.toContain("secret path");
  });
});

describe("the stage's stored delivery copy", () => {
  it("loses the lessons when it is marked delivered, keeps everything else, and is a no-op for a stage that carried none", async () => {
    const db = new FakeDynamoDb();
    const withLessons = { pk: "OUTBOX#a", sk: "OUTBOX", status: "QUEUED", invocation: { kind: "task", payload: { prompt: "do it", learnedContext: { v: 1, lessons: [{ body: SECRET_BODY }] } } } };
    const without = { pk: "OUTBOX#b", sk: "OUTBOX", status: "QUEUED", invocation: { kind: "task", payload: { prompt: "do it" } } };
    db.set(withLessons);
    db.set(without);
    await db.send(markDeliveredCommand("state", "a", "2026-11-01T00:00:00.000Z"));
    await db.send(markDeliveredCommand("state", "b", "2026-11-01T00:00:00.000Z"));
    const a = db.get("OUTBOX#a", "OUTBOX") as unknown as { status: string; deliveredAt: string; invocation: { payload: Record<string, unknown> } };
    expect(a.status).toBe("DELIVERED");
    expect(a.deliveredAt).toBe("2026-11-01T00:00:00.000Z");
    expect(a.invocation.payload).toEqual({ prompt: "do it" });
    expect(JSON.stringify(a)).not.toContain("secret path");
    expect((db.get("OUTBOX#b", "OUTBOX") as unknown as { status: string; invocation: { payload: unknown } })).toMatchObject({ status: "DELIVERED", invocation: { payload: { prompt: "do it" } } });
  });
});
