import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, orgMemberKey } from "@agentx/contracts";
import { putSessionShare, deleteSessionShare } from "../../packages/broker/src/agent-sessions/shares.js";
import { routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { takeTaskOwnership } from "../../packages/broker/src/developer/task-people.js";
import { createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, PRIYA, ORG_A, ORG_B, sessionWorld } from "../support/agent-session-world.js";

function world() {
  const w = sessionWorld();
  const s = w.seedSession();
  const task = w.db.get(taskKey(s.taskId))!;
  w.db.set({ ...task, workflow: createWorkflowSnapshot({ taskId: s.taskId, ownerId: PRIYA, now: new Date(w.clock.now).toISOString() }) });
  const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore,
    origin: "https://cell.example.com", taskView: async () => { throw new Error("ADMITTED"); } } satisfies SessionRouteDependencies;
  const notices = () => w.db.find((item) => item.entityType === "CHANGE_NOTICE");
  return { ...w, ...s, deps, notices };
}

describe("Rovara Code session shares", () => {
  it("narrowing is immediate and sends no owner notice", async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const result = await putSessionShare(w.deps, w.caller(ARJUN), w.sessionId, { requestId: randomUUID(), principal: { kind: "member", developerId: ARJUN }, level: "view" });
    expect(result.status).toBe(200);
    expect(w.notices()).toEqual([]);
  });

  it("a widening tells the effective owner and DELETE restores the earlier level", async () => {
    const w = world();
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: PRIYA }, "view");
    await putSessionShare(w.deps, w.caller(ARJUN), w.sessionId, { requestId: randomUUID(), principal: { kind: "member", developerId: PRIYA }, level: "use" });
    const [notice] = w.notices();
    expect(notice).toMatchObject({ by: ARJUN, sessionId: w.sessionId, undo: { principalKey: `MEMBER#${PRIYA}` } });
    await deleteSessionShare(w.deps, w.caller(PRIYA), w.sessionId, `MEMBER#${PRIYA}`);
    expect(w.db.get(agentSessionKey(ORG_A, w.sessionId, `SHARE#MEMBER#${PRIYA}`))).toMatchObject({ level: "view" });
  });

  it("the legacy ownership primitive cannot bypass session confirmation", async () => {
    const w = world();
    await expect(takeTaskOwnership(w.deps, w.caller(ARJUN), w.taskId, { requestId: randomUUID(), expectedPeopleRevision: 1 })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(w.db.get(taskKey(w.taskId))).not.toHaveProperty("currentOwner");
  });
});

// Every Code session route is exercised with the same live authority table. Allowed callers
// reach each route's domain checks; denied callers must stop at authority, before any write.
const routes = [
  { method: "GET", tail: "", level: "view" },
  { method: "GET", tail: "/shares", level: "view" },
  { method: "GET", tail: "/events", level: "view" },
  { method: "POST", tail: "/answers", level: "use", body: { round: 1, answers: [{ questionId: "q1", text: "Yes" }] } },
  { method: "POST", tail: "/change-anyway", level: "use" },
  { method: "POST", tail: "/retry", level: "edit" },
  { method: "POST", tail: "/take-over", level: "edit" },
  { method: "PUT", tail: "/shares", level: "edit", body: { principal: { kind: "member", developerId: PRIYA }, level: "view" } },
  { method: "DELETE", tail: `/shares/MEMBER%23${PRIYA}`, level: "edit" },
] as const;
const ranks = { view: 1, use: 2, edit: 3, owner: 4, removed: 0, otherOrg: 0 };
for (const route of routes) for (const standing of Object.keys(ranks) as Array<keyof typeof ranks>) {
  it(`${route.method} ${route.tail || "/"}: ${standing}`, async () => {
    const w = world();
    const who = standing === "owner" ? PRIYA : ARJUN;
    if (standing !== "owner" && standing !== "removed" && standing !== "otherOrg") w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: ARJUN }, standing);
    if (standing === "removed") w.db.delete(orgMemberKey(ORG_A, ARJUN));
    // Seed a target for DELETE so its permission check cannot be skipped by a missing share.
    w.seedShare(ORG_A, w.sessionId, { kind: "member", developerId: PRIYA }, "view", PRIYA);
    const url = new URL(`/v1/app/sessions/${w.sessionId}${route.tail}`, w.deps.origin);
    const before = w.db.transactions().length;
    let error: { code?: string } | undefined;
    try {
      await routeAgentSessionRequest(w.deps, w.caller(who, standing === "otherOrg" ? ORG_B : ORG_A), {
        method: route.method, path: url.pathname, requestId: randomUUID(), headers: {}, body: JSON.stringify({ requestId: randomUUID(), ...("body" in route ? route.body : {}) }),
      }, url);
    } catch (caught) { error = caught as { code?: string }; }
    if (ranks[standing] < ranks[route.level]) {
      expect(error?.code).toBe(standing === "removed" || standing === "otherOrg" ? "NOT_FOUND" : "SESSION_LEVEL_REQUIRED");
      expect(w.db.transactions()).toHaveLength(before);
    } else {
      expect(error?.code).not.toBe("SESSION_LEVEL_REQUIRED");
      expect(error?.code).not.toBe("NOT_FOUND");
    }
  });
}
