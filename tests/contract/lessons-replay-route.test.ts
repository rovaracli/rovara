// Lane 7: `POST /v1/admin/tasks/{taskId}/lessons-replay` and its GET, through the real handler. Only the administrator of the task's project may use them (the e2e replay's rule); a copy is started marked, audited,
// and read back as a copy only.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Audit, KEY } from "../unit/lessons/lesson-helpers.js";
import { InMemorySnapshotStore } from "../../packages/broker/src/lessons/replay-snapshot-store.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };
void KEY;

async function world(withLessons = true) {
  const audit = new Audit();
  const store = new InMemoryLessonStore();
  const snapshots = new InMemorySnapshotStore();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {}, ...(withLessons ? { lessons: { store, snapshots, routes: { audit } } } : {}) } });
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const metas = () => h.db.find((item) => item.sk === "META" && typeof item.pk === "string" && item.pk.startsWith("DEVTASK#"));
  const post = (id: string, user: { subject: string; admin?: boolean }, body: unknown) => call(h.handler, { method: "POST", path: `/v1/admin/tasks/${id}/lessons-replay`, user, body });
  const get = (id: string, user: { subject: string; admin?: boolean } = ADMIN) => call(h.handler, { method: "GET", path: `/v1/admin/tasks/${id}/lessons-replay`, user });
  const ok = () => ({ requestId: randomUUID(), memory: { mode: "off" }, maxUsd: 2 });
  return { ...h, taskId, audit, metas, post, get, ok };
}

describe("who may start a copy", () => {
  it("only an administrator of the task's project: a member, an administrator of another project and an unknown task are all refused, and nothing is started", async () => {
    const w = await world();
    const before = w.metas().length;
    expect((await w.post(w.taskId, { subject: "someone", admin: false }, w.ok())).body.error).toEqual({ code: "FORBIDDEN", message: "administrator claim is required" });
    expect((await w.post(w.taskId, { subject: "other-admin", admin: true }, w.ok())).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await w.post(randomUUID(), ADMIN, w.ok())).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await w.get(w.taskId, { subject: "someone", admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(w.metas()).toHaveLength(before);
    expect(w.audit.actions()).toEqual([]);
  });
  it("answers nothing where lessons are not set up", async () => {
    const w = await world(false);
    expect((await w.post(w.taskId, ADMIN, w.ok())).body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("starting and reading a copy", () => {
  it("starts a marked copy in the same project, owned by the past task's owner, audited first, and reads it back as a copy", async () => {
    const w = await world();
    const before = w.metas().length;
    const started = await w.post(w.taskId, ADMIN, w.ok());
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const replay = started.body.replay as { taskId: string; evalRun: boolean; memory: string };
    expect(replay).toMatchObject({ evalRun: true, memory: "off" });
    expect(w.metas()).toHaveLength(before + 1);
    const record = w.db.get(`DEVTASK#${replay.taskId}`, "META") as Record<string, unknown>;
    expect(record).toMatchObject({ evalRun: true, evalMemory: { mode: "off" }, project: "payments", shared: false, developerId: MAYA.developerId });
    expect(w.audit.events.map((e) => e.action)).toEqual(["lesson.replay_started"]);
    expect(w.audit.events[0]!.facts).toMatchObject({ memory: "off", maxCents: 200, sourceTask: w.taskId });
    const view = await w.get(replay.taskId);
    expect(view.status).toBe(200);
    expect(view.body.replay).toMatchObject({ taskId: replay.taskId, evalRun: true, state: "running", learningCalls: 0, loadedKeys: [] });
  });
  it("an unmarked start is impossible through the route: a body that tries to drop or change the mark is refused and starts nothing; a copy cannot be copied", async () => {
    const w = await world();
    const before = w.metas().length;
    for (const extra of [{ evalRun: false }, { evalRun: true }, { shareToChannel: true }, { workflow: true }]) {
      expect((await w.post(w.taskId, ADMIN, { ...w.ok(), ...extra })).body.error, JSON.stringify(extra)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect((await w.post(w.taskId, ADMIN, { ...w.ok(), memory: { mode: "live" } })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await w.post(w.taskId, ADMIN, { ...w.ok(), lessonsFile: { path: ".rovara/lessons.md" } })).body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("file-arm-not-built") as unknown });
    expect(w.metas()).toHaveLength(before);
    const copy = ((await w.post(w.taskId, ADMIN, w.ok())).body.replay as { taskId: string }).taskId;
    expect((await w.post(copy, ADMIN, w.ok())).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("reads only a copy: the past task itself answers as if the route did not exist", async () => {
    const w = await world();
    expect((await w.get(w.taskId)).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("a start that cannot be audited starts nothing", async () => {
    const w = await world();
    w.audit.emit = async () => { throw new Error("ledger down"); };
    const before = w.metas().length;
    expect((await w.post(w.taskId, ADMIN, w.ok())).body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.metas()).toHaveLength(before);
  });
});
