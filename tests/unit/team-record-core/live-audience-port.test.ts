// SRL-4: the State-table port of the live task check: it answers per task, a task that fails is unreadable on its own (the others still answer), and it asks no more than a few at a time.
import { describe, expect, it } from "vitest";
import { tableTaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience-port.js";
import { ARJUN, ORG_A, ORG_B, PRIYA, sessionWorld } from "../../support/agent-session-world.js";

describe("tableTaskVisibilityPort", () => {
  it("answers the live visibility of each task, and nothing for a task that is gone, another company's, or that fails to read", async () => {
    const w = sessionWorld();
    const open = w.seedSession({});
    w.seedShare(ORG_A, open.sessionId, { kind: "project", project: "web" }, "view");
    const listed = w.seedSession({});
    w.seedShare(ORG_A, listed.sessionId, { kind: "member", developerId: ARJUN }, "use");
    const broken = w.seedSession({});
    w.db.set({ pk: `DEVTASK#${broken.taskId}`, sk: "PEOPLE", schemaVersion: 7, people: "garbled" });
    const table = { documentClient: w.db, tableName: "state", now: () => 0 };
    const answers = await tableTaskVisibilityPort(table).read(ORG_A, [open.taskId, listed.taskId, broken.taskId, "00000000-0000-4000-8000-000000000000", open.taskId]);
    expect(answers.get(open.taskId)).toEqual({ kind: "shared" });
    expect(answers.get(listed.taskId)).toEqual({ kind: "shared_with", developerIds: [PRIYA, ARJUN] });
    expect(answers.get(broken.taskId)).toBeUndefined();
    expect(answers.get("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect((await tableTaskVisibilityPort(table).read(ORG_B, [open.taskId])).get(open.taskId)).toBeUndefined();
  });

  it("reads a long list a few tasks at a time", async () => {
    let live = 0;
    let peak = 0;
    const table = { documentClient: { send: async () => { live += 1; peak = Math.max(peak, live); await new Promise((resolve) => setTimeout(resolve, 1)); live -= 1; return {}; } }, tableName: "state", now: () => 0 };
    const ids = Array.from({ length: 40 }, (_, index) => `t${String(index)}`);
    const answers = await tableTaskVisibilityPort(table).read(ORG_A, ids);
    expect(answers.size).toBe(40);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
