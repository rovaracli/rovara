// Switch blocker 2 (money): the switch must not change money behaviour. The payer a core admission counts against is Cloud's own (`resolvePayer` over the project's AI settings, as
// `resolveRunPayer` applies it to a person's start), held to v2's functions for the same inputs; a company enrolled in per-task spending stops stays on Cloud's start, which captures the stop.
import { describe, expect, it } from "vitest";
import { projectAiKey, scopeKey, type BudgetScope, orgSettingsKey } from "@agentx/cloud-contracts";
import { ROVARA_CODE_AGENT_ID, orgScoped, type AdmissionRequest } from "@rovara-code/contracts";
import { cloudAdmissionLevels, cloudLevelSources, taskStopEnrolled } from "../../packages/broker/src/cloud/app/index.js";
import { resolveRunPayer } from "../../packages/broker/src/agents/runs.js";
import { budgetScopesFor } from "../../packages/broker/src/spend/payer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_s3money00000000000a" as never;
const PERSON = "a".repeat(64);
const MONTH = "2026-11";

const request = (over: Partial<AdmissionRequest> = {}): AdmissionRequest => ({ companyId: ORG, idempotencyKey: "k", action: "task.start", projectName: "payments", actor: { personId: PERSON } as never, ...over });

function dbWith(projectPays: boolean | undefined): FakeDynamoDb {
  const db = new FakeDynamoDb();
  if (projectPays !== undefined) db.set({ ...projectAiKey(ORG, "payments"), entityType: "PROJECT_AI", projectPays, revision: 1 });
  return db;
}
const depsOf = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => Date.parse("2026-11-13T10:00:00.000Z") }) as never;

describe("the payer of a core admission is Cloud's own", () => {
  it.each([[undefined], [false], [true]] as const)("a person's start with the project's pays setting %j: the same budgets as v2's resolveRunPayer and budgetScopesFor", async (projectPays) => {
    const db = dbWith(projectPays);
    const v2 = await resolveRunPayer(depsOf(db), { orgId: ORG, project: "payments", agentId: ROVARA_CODE_AGENT_ID, origin: "app", startedBy: { developerId: PERSON } });
    const expected = budgetScopesFor(v2.payer, v2.place, { agentId: ROVARA_CODE_AGENT_ID }).map((scope: BudgetScope) => scopeKey(scope));
    const levels = await cloudAdmissionLevels(cloudLevelSources(depsOf(db)))(request(), MONTH);
    expect(levels.map((level) => level.scope)).toEqual(expected);
    // The member's own budget is counted unless the project pays.
    expect(levels.some((level) => level.kind === "member")).toBe(projectPays !== true);
  });

  it("a request with no person is the project's, whatever the setting", async () => {
    const levels = await cloudAdmissionLevels(cloudLevelSources(depsOf(dbWith(false))))(request({ actor: undefined } as never), MONTH);
    expect(levels.map((level) => level.kind)).toEqual(["org", "project"]);
  });

  it("a request that names no project is refused (no scopes is never free)", async () => {
    await expect(cloudAdmissionLevels(cloudLevelSources(depsOf(dbWith(false))))(request({ projectName: undefined } as never), MONTH)).rejects.toThrow();
  });
});

describe("a company enrolled in per-task spending stops is known by what v2's capture reads", () => {
  it("not enrolled: none of the policy and seed rows; enrolled: any one of them", async () => {
    const none = new FakeDynamoDb();
    expect(await taskStopEnrolled({ documentClient: none, tableName: "state" }, ORG)).toBe(false);
    const policy = new FakeDynamoDb();
    policy.set({ ...orgSettingsKey(ORG, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId: ORG });
    expect(await taskStopEnrolled({ documentClient: policy, tableName: "state" }, ORG)).toBe(true);
    for (const sk of ["V1#bootstrap", "V1#upgrade"]) {
      const seeded = new FakeDynamoDb();
      seeded.set({ pk: orgScoped(ORG, "TASK_STOP_SEED"), sk, entityType: "TASK_STOP_SEED", orgId: ORG });
      expect(await taskStopEnrolled({ documentClient: seeded, tableName: "state" }, ORG), sk).toBe(true);
    }
    expect(await taskStopEnrolled({ documentClient: policy, tableName: "state" }, "org_s3other000000000000z")).toBe(false);
  });
});
