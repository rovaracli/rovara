// L3b fix round 1, S5: "What the agent loaded" is mounted behind the same switch as the lessons routes: not on an install with no lesson ports, not for a project whose learning is Off.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";

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
  afterEach(() => { setLearnedLessonsGate(undefined); });
  it("an install with no lesson ports does not mount it", async () => {
    expect(await routeLoadedKnowledgeFor(deps({ lessons: false }), caller, "GET", url)).toBeUndefined();
  });
  it("a project whose learning is Off does not serve it, and says why in a fixed code (still a 404) so the task page can offer to turn learning on (UX-4b)", async () => {
    await expect(routeLoadedKnowledgeFor(deps({ settings: { mode: "Off" } }), caller, "GET", url)).rejects.toMatchObject({ code: "LEARNING_OFF", statusCode: 404 });
    await expect(routeLoadedKnowledgeFor(deps({ settings: { mode: "On", companyLock: "Off" } }), caller, "GET", url)).rejects.toMatchObject({ code: "LEARNING_LOCKED", statusCode: 404 });
  });
  it("a project whose learning is on answers the records", async () => {
    expect(await routeLoadedKnowledgeFor(deps({ settings: { mode: "Suggest" } }), caller, "GET", url)).toEqual({ stages: [] });
  });
  it("with the install's lessons switch off it says so in a fixed code (404): no lesson ports, a project whose learning is Off, or nothing kept; records kept from before are still shown; the switch on changes nothing", async () => {
    setLearnedLessonsGate(() => false);
    await expect(routeLoadedKnowledgeFor(deps({ lessons: false }), caller, "GET", url)).rejects.toMatchObject({ code: "LESSONS_SWITCHED_OFF", statusCode: 404 });
    await expect(routeLoadedKnowledgeFor(deps({ settings: { mode: "Off" } }), caller, "GET", url)).rejects.toMatchObject({ code: "LESSONS_SWITCHED_OFF", statusCode: 404 });
    await expect(routeLoadedKnowledgeFor(deps({ settings: { mode: "On" } }), caller, "GET", url)).rejects.toMatchObject({ code: "LESSONS_SWITCHED_OFF", statusCode: 404 });
    // the text read of one file is not the list read: it is unchanged
    const text = new URL(`https://cell.example/v1/app/tasks/${TASK}/loaded-knowledge/op1/plan/items/0/text`);
    expect(await routeLoadedKnowledgeFor(deps({ lessons: false }), caller, "GET", text)).toBeUndefined();
    setLearnedLessonsGate(() => true);
    expect(await routeLoadedKnowledgeFor(deps({ lessons: false }), caller, "GET", url)).toBeUndefined();
    await expect(routeLoadedKnowledgeFor(deps({ settings: { mode: "Off" } }), caller, "GET", url)).rejects.toMatchObject({ code: "LEARNING_OFF" });
  });
  it("with the switch off, records kept from before are returned as they are (only an empty list becomes the switched-off code)", async () => {
    setLearnedLessonsGate(() => false);
    const D = "a".repeat(64);
    const manifest = {
      schemaVersion: 1, stage: "plan", repos: [{ name: "engine", commit: "f".repeat(40), readAt: "base" }],
      items: [{ layer: "repo", repo: "engine", path: ".kiro/steering/product.md", scopeDir: "", format: "kiro_steering", activation: "always", bytes: 10, digest: D, fileDigest: D, readAt: "base", status: "loaded", why: { kind: "always" } }],
      omitted: { skipped: 0, available: 0 }, skills: [], skippedSkills: [], sources: [],
      budget: { alwaysOnBytes: 10, alwaysOnLimitBytes: 131072, additionsBytes: 0, additionsLimitBytes: 131072, skipped: 0 },
    };
    const kept = { tableName: "state", now: () => 1, developer: { signInTableName: "signin" }, lessons: { settings: { read: async () => ({ mode: "On" }) } },
      documentClient: { send: async () => ({ Items: [{ operationId: "op1", recordedAt: "2026-10-30T12:00:00.000Z", manifest }] }) } } as never;
    const answer = await routeLoadedKnowledgeFor(kept, caller, "GET", url) as { stages: Array<{ operationId: string }> };
    expect(answer.stages.map((record) => record.operationId)).toEqual(["op1"]);
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
