// Lessons connect fix 1 (M4, owner decision 32): `sharedTask` means "visible to the whole project with no People denial", read live and strict. An ordinary task nobody shared counts; a denial, another company's task, a task
// with no task session and anything unreadable do not (the last one throws, which the caller reads as unknown). The Team record's own resolver (`task-visibility.ts`) is not touched.
import { describe, expect, it } from "vitest";
import { agentSessionKey } from "@rovara-code/contracts";
import { taskKey } from "../../../packages/broker/src/developer/task-records.js";
import { resolveTaskProjectWide } from "../../../packages/broker/src/lessons/task-project-wide.js";
import { resolveTaskVisibility } from "../../../packages/broker/src/lessons/task-visibility.js";
import { MIA, ORG_A, ORG_B, PRIYA, sessionWorld } from "../../support/agent-session-world.js";

function setup(options: Parameters<ReturnType<typeof sessionWorld>["seedSession"]>[0] = {}) {
  const w = sessionWorld();
  const seeded = w.seedSession(options);
  const table = { documentClient: w.db, tableName: "state", now: () => 0 };
  return { w, ...seeded, wide: (orgId: string = ORG_A) => resolveTaskProjectWide(table, orgId, seeded.taskId), table };
}

describe("resolveTaskProjectWide", () => {
  it("an ordinary task nobody shared is project-wide (decision 31), though the Team record's own resolver still calls it the owner's alone", async () => {
    const t = setup();
    expect(await t.wide()).toBe(true);
    expect(await resolveTaskVisibility(t.table, ORG_A, t.taskId)).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });
  it("shares and People entries that are not denials add people and never narrow: a member share, a viewer entry and a project share leave it project-wide", async () => {
    const t = setup({ people: [{ developerId: MIA, role: "viewer" }] });
    t.w.seedShare(ORG_A, t.sessionId, { kind: "member", developerId: MIA }, "view");
    t.w.seedShare(ORG_A, t.sessionId, { kind: "project", project: "web" }, "view");
    expect(await t.wide()).toBe(true);
  });
  it("any People denial makes it not project-wide, whatever is shared", async () => {
    const t = setup({ people: [{ developerId: MIA, role: "denied" }] });
    t.w.seedShare(ORG_A, t.sessionId, { kind: "org" }, "view");
    expect(await t.wide()).toBe(false);
  });
  it("another company's task, a missing task and a task with no session at all are false; a task that names a session that is gone throws (unknown)", async () => {
    const t = setup();
    expect(await t.wide(ORG_B)).toBe(false);
    const missing = setup();
    await expect(resolveTaskProjectWide(missing.table, ORG_A, "99999999-9999-4999-8999-999999999999")).resolves.toBe(false);
    const record = t.w.db.get(taskKey(t.taskId).pk, taskKey(t.taskId).sk) as Record<string, unknown>;
    const { sessionId: _session, ...withoutSession } = record;
    void _session;
    t.w.db.set({ ...withoutSession });
    expect(await t.wide()).toBe(false);
    t.w.db.set({ ...record, sessionId: "ses_00000000000000000000000000000000" });
    await expect(t.wide()).rejects.toThrow();
  });
  it("R4: a task whose session belongs to another project is false (the session is that project's to open, not this task's); the same task with the matching project is true", async () => {
    const t = setup();
    expect(await t.wide()).toBe(true);
    t.w.db.set({ ...(t.w.db.get(agentSessionKey(ORG_A, t.sessionId, "META").pk, agentSessionKey(ORG_A, t.sessionId, "META").sk) as Record<string, unknown>), project: "other-project" });
    expect(await t.wide()).toBe(false);
  });
  it("an unreadable People list throws (it denies everyone, so the answer is not known), and a read that fails throws", async () => {
    const t = setup({ people: [] });
    t.w.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    await expect(t.wide()).rejects.toThrow();
    const down = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => 0 };
    await expect(resolveTaskProjectWide(down, ORG_A, t.taskId)).rejects.toThrow();
  });
});
