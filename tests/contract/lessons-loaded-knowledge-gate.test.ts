// L3b fix round 1, S5: "What the agent loaded" is mounted behind the same switch as the lessons routes: not on an install with no lesson ports, not for a project whose learning is Off.
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";

const access = vi.hoisted(() => ({ project: "demo", deny: false }));
vi.mock("../../packages/broker/src/developer/task-access.js", () => ({
  resolveTaskAccess: async () => {
    if (access.deny) throw new Error("TASK_NOT_FOUND");
    return { task: { taskId: "t", orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: access.project }, role: "owner", ownerActorIds: [] };
  },
}));
const { routeLoadedKnowledgeFor } = await import("../../packages/broker/src/aws/developer-routes/lessons.js");

const TASK = "11111111-1111-4111-8111-111111111111";
const url = new URL(`https://cell.example/v1/app/tasks/${TASK}/loaded-knowledge`);
const caller = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, developerId: "a".repeat(64), orgRole: "owner", amr: "cloud", name: "n", sessionId: "s" } as never;
const deps = (over: { settings?: unknown; lessons?: boolean } = {}) => ({
  tableName: "state", now: () => 1, documentClient: { send: async () => ({ Items: [] }) }, developer: { signInTableName: "signin" },
  ...(over.lessons === false ? {} : { lessons: { settings: { read: async () => over.settings ?? {} } } }),
}) as never;

describe("loaded knowledge is behind learning", () => {
  it("an install with no lesson ports does not mount it", async () => {
    expect(await routeLoadedKnowledgeFor(deps({ lessons: false }), caller, "GET", url)).toBeUndefined();
  });
  it("a project whose learning is Off does not mount it", async () => {
    expect(await routeLoadedKnowledgeFor(deps({ settings: { mode: "Off" } }), caller, "GET", url)).toBeUndefined();
    expect(await routeLoadedKnowledgeFor(deps({ settings: { mode: "On", companyLock: "Off" } }), caller, "GET", url)).toBeUndefined();
  });
  it("a project whose learning is on answers the records", async () => {
    expect(await routeLoadedKnowledgeFor(deps({ settings: { mode: "Suggest" } }), caller, "GET", url)).toEqual({ stages: [] });
  });
  it("a task the caller cannot read goes to the route, which refuses it as it does today", async () => {
    access.deny = true;
    await expect(routeLoadedKnowledgeFor(deps(), caller, "GET", url)).rejects.toBeDefined();
    access.deny = false;
  });
  it("only the exact shapes, only GET", async () => {
    expect(await routeLoadedKnowledgeFor(deps(), caller, "POST", url)).toBeUndefined();
    expect(await routeLoadedKnowledgeFor(deps(), caller, "GET", new URL(`https://cell.example/v1/app/tasks/${TASK}/loaded-knowledgex`))).toBeUndefined();
    expect(await routeLoadedKnowledgeFor(deps(), caller, "GET", new URL(`https://cell.example/v1/app/tasks/${TASK}`))).toBeUndefined();
  });
});
