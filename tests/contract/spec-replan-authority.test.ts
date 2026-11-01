// Wire lane D review round 1: who may Re-plan. The task's access check says who the caller is on the task (owner, co-owner, or a project developer who can see a shared task but only comments);
// Re-plan needs the owner's or a co-owner's authority. The access check is stood in for here (its own rules are tested with the People list); everything after it is the real broker.
import type * as RealAccess from "../../packages/broker/src/aws/developer-tasks/access.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes/dependencies.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { editedSpecTask } from "../support/spec-replan-world.js";

const stand: { who?: "commenter" | "co-owner" | undefined } = {};
vi.mock("../../packages/broker/src/aws/developer-tasks/access.js", async (original) => {
  const real = await original<typeof RealAccess>();
  return {
    ...real,
    authorizeTaskAction: async (...args: Parameters<typeof real.authorizeTaskAction>) => {
      const [deps, caller, taskId] = args;
      if (stand.who === undefined) return real.authorizeTaskAction(...args);
      // The task as its owner sees it, with the caller's own authority on it.
      const owner = await real.authorizeTaskAction(deps, { ...caller, developerId: MAYA.developerId }, taskId, "work");
      const actorId = taskOwnerKey(caller.developerId, taskId);
      return { ...owner, role: stand.who === "co-owner" ? "owner" : "commenter", actorId, authority: { actorId, ownerIds: stand.who === "co-owner" ? [taskOwnerKey(MAYA.developerId, taskId), actorId] : [taskOwnerKey(MAYA.developerId, taskId)] } };
    },
  };
});

beforeEach(() => { stand.who = undefined; });

const OMAR_CALLER: DeveloperCaller = { developerId: OMAR.developerId, sessionId: OMAR.sessionId, amr: OMAR.provider, name: OMAR.name, orgId: TEST_ORG, orgRole: "member" };

async function replanAs(who: "commenter" | "co-owner") {
  const t = await editedSpecTask();
  const input = t.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
  const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: t.actions, ...({ readMetaFile: async (_t: unknown, _u: string, path: string) => t.fileText(path) } as object) }, OMAR_CALLER);
  stand.who = who;
  const { specOwnerChoice } = await import("../../packages/broker/src/aws/developer-tasks/spec-wiring.js");
  return { t, run: () => specOwnerChoice(deps, OMAR_CALLER, t.taskId, "replan") };
}

describe("who may Re-plan", () => {
  it("refuses a project developer who is neither the owner nor a co-owner (403 on the page), and nothing moves", async () => {
    const { t, run } = await replanAs("commenter");
    const before = t.record();
    await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(t.record().workflow.revision).toBe(before.workflow.revision);
    expect((await t.store.load(t.taskId)).state?.editPrompt?.status).toBe("open");
  });

  it("lets a co-owner re-plan, recorded as theirs", async () => {
    const { t, run } = await replanAs("co-owner");
    await expect(run()).resolves.toEqual({ status: "replan" });
    expect(t.record().workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect((await t.store.load(t.taskId)).state?.editPrompt).toMatchObject({ status: "replan", by: OMAR.developerId });
  });
});
