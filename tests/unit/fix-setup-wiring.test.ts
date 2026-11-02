// Setup and test health SH17: the dispatch wiring of the Fix setup port: absent with vx off, and with it on it records the cause the policy's own codes name (never text), with no tests to mark unless the broker's own
// evidence pack gives them (the proof switch is off here, so there is none).
import { describe, expect, it } from "vitest";
import { fixSetupDependencies } from "../../packages/broker/src/aws/broker/fix-setup-wiring.js";
import { fixSetupItemsFor } from "../../packages/broker/src/test-env/fix-setup.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"b".repeat(20)}`;
const task = { taskId: "11111111-1111-4111-8111-111111111111", orgId: ORG, project: "web", ownerKey: "dev_a", workspaceId: "ws", workflow: { candidate: { digest: "d".repeat(64) } } } as unknown as DeveloperTaskRecord;

describe("fixSetupDependencies", () => {
  it("gives the runner no port while vx is off, whatever the other switches say", () => {
    const db = new FakeDynamoDb();
    for (const value of [undefined, "", "0", "true", " 1"]) expect(fixSetupDependencies({ documentClient: db, tableName: "state" } as never, value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value }), String(value)).toEqual({});
  });

  it("records the first environment code of an ask, and nothing for an ask with none", async () => {
    const db = new FakeDynamoDb();
    const port = fixSetupDependencies({ documentClient: db, tableName: "state" } as never, { VERIFY_RESULTS_ENABLED: "1" }).fixSetup!;
    await port.record(task, { reason: "needs-a-person", codes: ["build-failed"], stage: "VERIFY" });
    expect(db.find(() => true)).toEqual([]);
    await port.record(task, { reason: "retry-limit", codes: ["check-runner-failed", "setup-failed-in-task"], stage: "VERIFY" });
    const items = await fixSetupItemsFor({ store: { documentClient: db, tableName: "state", now: Date.now }, maintainedProjects: async () => ["web"], task: async () => undefined }, { orgId: ORG, developerId: "dev_a" }, { VERIFY_RESULTS_ENABLED: "1" });
    expect(items).toMatchObject([{ kind: "fix_setup", cause: "check-runner-failed", step: "Check runner", taskCount: 1 }]);
  });

  it("offers no tests to mark without the broker's evidence pack (the original-code cause, proof switch off)", async () => {
    const db = new FakeDynamoDb();
    const port = fixSetupDependencies({ documentClient: db, tableName: "state" } as never, { VERIFY_RESULTS_ENABLED: "1" }).fixSetup!;
    await port.record(task, { reason: "original-code-also-fails", codes: ["fails-on-original-code"], stage: "VERIFY" });
    const [item] = await fixSetupItemsFor({ store: { documentClient: db, tableName: "state", now: Date.now }, maintainedProjects: async () => ["web"], task: async () => undefined }, { orgId: ORG, developerId: "dev_a" }, { VERIFY_RESULTS_ENABLED: "1" });
    expect(item).toMatchObject({ cause: "fails-on-original-code", knownFailingTests: 0 });
  });
});
