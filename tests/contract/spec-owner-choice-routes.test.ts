// Wire lane D (MD-1): POST /v1/app/tasks/{id}/spec/{retry|continue|keep|replan} through the real developer routes, the real task access check and a real task: the task's owner (or a co-owner) may
// press; anyone else, however they are signed in, is refused and the spec's state does not move.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TASK_PAGE_READ_ONLY_MESSAGE } from "../../packages/broker/src/aws/task-web-api.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { reviewPagePost } from "../support/card-decision.js";
import { TEST_ORG } from "../support/orgs.js";
import { dynamoSpecStore } from "../../packages/broker/src/spec/store.js";
import { newSpecState, type SpecState } from "../../packages/broker/src/spec/state.js";
import { SpecTargetSchema, projectMemberKey } from "@agentx/contracts";

const NOW = "2026-10-31T10:00:00.000Z";

async function heldTask() {
  const h = await createDeveloperTaskBroker();
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const store = dynamoSpecStore({ documentClient: h.db, tableName: "state" });
  const failed = { ...newSpecState({ taskId, planDigest: "a".repeat(64), kind: "feature", target: SpecTargetSchema.parse({ format: "kiro" }), knowledgeCommit: "b".repeat(40), now: NOW }),
    status: "failed", attempt: 1, failure: { code: "publish_failed", at: NOW } } as SpecState;
  await store.save(failed, undefined);
  const choose = (who: typeof MAYA, action: string, method = "POST") => h.dev(who, method, `/v1/app/tasks/${taskId}/spec/${action}`);
  const state = async () => (await store.load(taskId)).state;
  return { ...h, taskId, choose, state };
}

describe("the owner's choices on a held spec", () => {
  it("the task's owner continues without the spec; the state records who", async () => {
    const t = await heldTask();
    const reply = await t.choose(MAYA, "continue");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(await t.state()).toMatchObject({ continuedWithoutSpec: { by: MAYA.developerId } });
  });

  it("refuses a member who is not on the project, and the state does not move", async () => {
    const t = await heldTask();
    const before = await t.state();
    for (const action of ["retry", "continue", "keep", "replan"]) {
      const reply = await t.choose(OMAR, action);
      expect(reply.status, action).toBeGreaterThanOrEqual(400);
      expect(reply.status, action).toBeLessThan(500);
    }
    expect(await t.state()).toEqual(before);
  });

  it("refuses the task's own owner once they are only a viewer on the project (viewers only view), and the state does not move", async () => {
    const t = await heldTask();
    t.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", role: "viewer" });
    const before = await t.state();
    for (const action of ["retry", "continue", "keep", "replan"]) {
      const reply = await t.choose(MAYA, action);
      expect(reply.status, `${action} ${JSON.stringify(reply.body)}`).toBeGreaterThanOrEqual(400);
      expect(reply.status, action).toBeLessThan(500);
    }
    expect(await t.state()).toEqual(before);
  });

  it("answers an action the route does not have, and a task that is not there, with not found", async () => {
    const t = await heldTask();
    expect((await t.choose(MAYA, "merge")).status).toBe(404);
    const missing = await t.dev(MAYA, "POST", `/v1/app/tasks/${randomUUID()}/spec/continue`);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
  });
});

describe("OWNER DECISION 7: the old review page's spec choices are read-only", () => {
  it("refuses every choice on the old page with 410 and where the task is decided now, and the spec's state does not move; the task page's route is the one that chooses", async () => {
    const t = await heldTask();
    const before = await t.state();
    for (const action of ["retry", "continue", "keep", "replan"]) {
      const refused = await reviewPagePost(t, MAYA, t.taskId, `spec/${action}`, { expectedRevision: 1 });
      expect(refused.status, action).toBe(410);
      expect(refused.body, action).toMatchObject({ error: "read_only", message: TASK_PAGE_READ_ONLY_MESSAGE });
    }
    expect(await t.state()).toEqual(before);
    // Positive control: the same owner chooses on the task page's route.
    expect((await t.choose(MAYA, "continue")).status).toBe(200);
    expect(await t.state()).not.toEqual(before);
  });
});
