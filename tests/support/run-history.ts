// Task 34: a task with no workflow starts at the TASK estimate's run limit, and a run's limit is a function of the org's history. Tests of the
// mechanics that depend on a known task budget (how a key's cap counts what the task's keys spent, how a Continue starts a new window) seed the
// history that gives the budget they were written for.
import { runCostKey } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

/**
 * Five finished tasks of Rovara Code with no workflow on `payments`, each costing half of `limitUsd`: the TASK estimate's high end is that, and
 * its run limit (twice the high end) is `limitUsd`. The default is Plan 1's old per-task cap of $25.
 */
export function seedTaskRunLimit(db: FakeDynamoDb, limitUsd = 25, org: OrgId = TEST_ORG, project = "payments"): void {
  for (let index = 0; index < 5; index += 1) {
    const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3_600_000).toISOString();
    const taskId = `seeded-task-${String(index)}`;
    db.set({
      ...runCostKey(org, project, "rovara-code", "TASK", endedAt, taskId), entityType: "RUN_COST",
      orgId: org, project, agentId: "rovara-code", path: "TASK", taskId, endedAt, costUsd: limitUsd / 2,
    });
  }
}
