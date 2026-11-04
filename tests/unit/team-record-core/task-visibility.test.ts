// Who may read the Team record's rows about a task: its Plan 5 visibility (session shares + the People list), never the C1 Slack-channel flag `task.shared` (design 4.4.2).
import { describe, expect, it } from "vitest";
import { agentSessionKey } from "@agentx/contracts";
import { taskKey } from "../../../packages/broker/src/developer/task-records.js";
import { SHARED_WITH_MAX, resolveTaskVisibility } from "../../../packages/broker/src/lessons/task-visibility.js";
import { ARJUN, MIA, ORG_A, ORG_B, PRIYA, OLA, sessionWorld } from "../../support/agent-session-world.js";

function setup(options: Parameters<ReturnType<typeof sessionWorld>["seedSession"]>[0] = {}) {
  const w = sessionWorld();
  const seeded = w.seedSession(options);
  const table = { documentClient: w.db, tableName: "state", now: () => 0 };
  const visibility = (orgId: string = ORG_A) => resolveTaskVisibility(table, orgId, seeded.taskId);
  const slackShared = () => w.db.set({ ...(w.db.get(taskKey(seeded.taskId).pk, taskKey(seeded.taskId).sk) as Record<string, unknown>), shared: true, share: { teamId: "T1", channelId: "C1", mode: "view", sharedReason: "requested", sharedAt: "2026-10-22T08:00:00.000Z" } });
  return { w, ...seeded, visibility, slackShared };
}

describe("a task's visibility for the record", () => {
  it("a task shared to a Slack channel (the C1 flag) but with no Plan 5 share is the owner's alone", async () => {
    const t = setup();
    t.slackShared();
    expect(await t.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });

  it("a share with the project (or the whole company) makes it the project's", async () => {
    const project = setup();
    project.w.seedShare(ORG_A, project.sessionId, { kind: "project", project: "web" }, "view");
    expect(await project.visibility()).toEqual({ kind: "shared" });
    const company = setup();
    company.w.seedShare(ORG_A, company.sessionId, { kind: "org" }, "view");
    expect(await company.visibility()).toEqual({ kind: "shared" });
  });

  it("a share with ANOTHER project does not make it this project's", async () => {
    const t = setup();
    t.w.seedShare(ORG_A, t.sessionId, { kind: "project", project: "ops" }, "view");
    expect(await t.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });

  it("people shares and the People list are the list: the owner first, no duplicates, nobody denied", async () => {
    const t = setup({ people: [{ developerId: MIA, role: "viewer" }, { developerId: OLA, role: "denied" }, { developerId: PRIYA, role: "owner" }] });
    t.w.seedShare(ORG_A, t.sessionId, { kind: "member", developerId: ARJUN }, "use");
    t.w.seedShare(ORG_A, t.sessionId, { kind: "member", developerId: OLA }, "view");
    expect(await t.visibility()).toEqual({ kind: "shared_with", developerIds: [PRIYA, ARJUN, MIA].sort((a, b) => (a === PRIYA ? -1 : b === PRIYA ? 1 : a.localeCompare(b))) });
  });

  it("the list is cut to 500 with the owner kept", async () => {
    const people = Array.from({ length: 520 }, (_, index) => ({ developerId: index.toString(16).padStart(64, "0"), role: "viewer" as const }));
    const t = setup({ people });
    const found = await t.visibility();
    expect(found?.kind).toBe("shared_with");
    const ids = (found as { developerIds: readonly string[] }).developerIds;
    expect(ids).toHaveLength(SHARED_WITH_MAX);
    expect(ids[0]).toBe(PRIYA);
  });

  it("a taker is the owner now", async () => {
    const t = setup({ currentOwner: ARJUN });
    expect(await t.visibility()).toEqual({ kind: "private", ownerDeveloperId: ARJUN });
  });

  it("fail closed: an unreadable People list, an unreadable session, or a task with no session is the owner's alone", async () => {
    const unreadablePeople = setup({ people: [] });
    unreadablePeople.w.db.set({ pk: `DEVTASK#${unreadablePeople.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    unreadablePeople.w.seedShare(ORG_A, unreadablePeople.sessionId, { kind: "member", developerId: ARJUN }, "use");
    expect(await unreadablePeople.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });

    const garbledSession = setup();
    garbledSession.w.db.set({ ...agentSessionKey(ORG_A, garbledSession.sessionId, "META"), orgId: ORG_A, sessionId: garbledSession.sessionId, nonsense: true });
    garbledSession.w.seedShare(ORG_A, garbledSession.sessionId, { kind: "org" }, "view");
    expect(await garbledSession.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });

    const noSession = setup();
    const record = noSession.w.db.get(taskKey(noSession.taskId).pk, taskKey(noSession.taskId).sk) as Record<string, unknown>;
    const { sessionId: _gone, ...without } = record; // eslint-disable-line @typescript-eslint/no-unused-vars
    noSession.w.db.set(without);
    expect(await noSession.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });

  it("a share list that cannot be read is the owner's alone", async () => {
    const t = setup();
    t.w.seedShare(ORG_A, t.sessionId, { kind: "org" }, "view");
    const failing = { documentClient: { send: async (command: unknown) => { if (JSON.stringify((command as { input?: unknown }).input).includes("SHARE#")) throw new Error("down"); return t.w.db.send(command as never); } }, tableName: "state", now: () => 0 };
    expect(await resolveTaskVisibility(failing, ORG_A, t.taskId)).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });

  it("nothing is recorded for a task that is missing, another org's, or has no readable owner", async () => {
    const t = setup();
    expect(await t.visibility(ORG_B)).toBeUndefined();
    expect(await resolveTaskVisibility({ documentClient: t.w.db, tableName: "state", now: () => 0 }, ORG_A, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
    const record = t.w.db.get(taskKey(t.taskId).pk, taskKey(t.taskId).sk) as Record<string, unknown>;
    t.w.db.set({ ...record, currentOwner: { nonsense: true } });
    expect(await t.visibility()).toBeUndefined();
  });
});
