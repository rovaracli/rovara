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

  it("People is read before the shares and wins, as the session's own access answer has it: an unreadable list under a company or project share is the owner's alone", async () => {
    for (const principal of [{ kind: "org" }, { kind: "project", project: "web" }] as const) {
      const t = setup({ people: [] });
      t.w.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
      t.w.seedShare(ORG_A, t.sessionId, principal, "view");
      expect(await t.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
    }
  });

  it("a denied entry under a company or project share means the task is not the project's: it is the people listed, without the denied person", async () => {
    for (const principal of [{ kind: "org" }, { kind: "project", project: "web" }] as const) {
      const t = setup({ people: [{ developerId: MIA, role: "denied" }, { developerId: ARJUN, role: "viewer" }] });
      t.w.seedShare(ORG_A, t.sessionId, principal, "view");
      t.w.seedShare(ORG_A, t.sessionId, { kind: "member", developerId: MIA }, "use");
      expect(await t.visibility()).toEqual({ kind: "shared_with", developerIds: [PRIYA, ARJUN] });
    }
    const alone = setup({ people: [{ developerId: MIA, role: "denied" }] });
    alone.w.seedShare(ORG_A, alone.sessionId, { kind: "project", project: "web" }, "view");
    expect(await alone.visibility()).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
  });

  it("an empty or all-viewer People list does not stop a project share from making the task the project's", async () => {
    const t = setup({ people: [{ developerId: MIA, role: "viewer" }] });
    t.w.seedShare(ORG_A, t.sessionId, { kind: "project", project: "web" }, "view");
    expect(await t.visibility()).toEqual({ kind: "shared" });
  });

  it("the earlier owner of a taken-over task, still listed as People owner, is not on the list (the session gives them nothing for it)", async () => {
    const t = setup({ currentOwner: ARJUN, people: [{ developerId: PRIYA, role: "owner" }, { developerId: MIA, role: "viewer" }] });
    expect(await t.visibility()).toEqual({ kind: "shared_with", developerIds: [ARJUN, MIA] });
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

  // SRL-4: a READ of the record is strict. Writing falls back to "the owner's alone" (never wider than the truth); reading with nothing known shows nothing, not even to the owner.
  describe("strict (reading the record)", () => {
    const strict = (table: Parameters<typeof resolveTaskVisibility>[0], orgId: string, taskId: string) => resolveTaskVisibility(table, orgId, taskId, { strict: true });

    it("answers exactly as the default does when everything can be read", async () => {
      const t = setup({ people: [{ developerId: MIA, role: "viewer" }] });
      t.w.seedShare(ORG_A, t.sessionId, { kind: "member", developerId: ARJUN }, "use");
      const table = { documentClient: t.w.db, tableName: "state", now: () => 0 };
      expect(await strict(table, ORG_A, t.taskId)).toEqual(await resolveTaskVisibility(table, ORG_A, t.taskId));
      const plain = setup();
      expect(await strict({ documentClient: plain.w.db, tableName: "state", now: () => 0 }, ORG_A, plain.taskId)).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
    });

    it("throws for an unreadable People list, a share list that fails, a garbled session and a task read that fails", async () => {
      const people = setup({ people: [] });
      people.w.db.set({ pk: `DEVTASK#${people.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
      await expect(strict({ documentClient: people.w.db, tableName: "state", now: () => 0 }, ORG_A, people.taskId)).rejects.toThrow();

      const shares = setup();
      shares.w.seedShare(ORG_A, shares.sessionId, { kind: "org" }, "view");
      const failing = { documentClient: { send: async (command: unknown) => { if (JSON.stringify((command as { input?: unknown }).input).includes("SHARE#")) throw new Error("down"); return shares.w.db.send(command as never); } }, tableName: "state", now: () => 0 };
      await expect(strict(failing, ORG_A, shares.taskId)).rejects.toThrow();

      const garbled = setup();
      garbled.w.db.set({ ...agentSessionKey(ORG_A, garbled.sessionId, "META"), orgId: ORG_A, sessionId: garbled.sessionId, nonsense: true });
      garbled.w.seedShare(ORG_A, garbled.sessionId, { kind: "org" }, "view");
      await expect(strict({ documentClient: garbled.w.db, tableName: "state", now: () => 0 }, ORG_A, garbled.taskId)).rejects.toThrow();

      const down = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => 0 };
      await expect(strict(down, ORG_A, garbled.taskId)).rejects.toThrow();
    });

    it("is still undefined for a task that is missing or another company's, and the owner's alone for a task with no session at all", async () => {
      const t = setup();
      const table = { documentClient: t.w.db, tableName: "state", now: () => 0 };
      expect(await strict(table, ORG_B, t.taskId)).toBeUndefined();
      expect(await strict(table, ORG_A, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
      const record = t.w.db.get(taskKey(t.taskId).pk, taskKey(t.taskId).sk) as Record<string, unknown>;
      const { sessionId: _gone, ...without } = record; // eslint-disable-line @typescript-eslint/no-unused-vars
      t.w.db.set(without);
      expect(await strict(table, ORG_A, t.taskId)).toEqual({ kind: "private", ownerDeveloperId: PRIYA });
    });
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
