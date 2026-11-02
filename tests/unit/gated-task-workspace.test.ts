// NH-1 fix 7: a task with a purpose (a nightly run, a setup run or draft, a diagnosis) is a gated workspace, as a workflow task is: no follow-up model turn can run in it.
import { describe, expect, it } from "vitest";
import { gatedTaskWorkspace } from "../../packages/broker/src/aws/broker/model-access.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
function gated(task: Record<string, unknown> | undefined, pointer = true) {
  const db = new FakeDynamoDb();
  if (pointer) db.set({ ...taskPointerKey(WORKSPACE), taskId: TASK });
  if (task !== undefined) db.set({ ...taskKey(TASK), taskId: TASK, ...task });
  return gatedTaskWorkspace({ documentClient: db, tableName: "t" } as never, WORKSPACE);
}

describe("gatedTaskWorkspace", () => {
  it("is true for a task with a purpose, whatever the purpose, and for a workflow task", async () => {
    for (const purpose of ["nightly_run", "setup_agent", "setup_draft", "diagnosis"]) expect(await gated({ purpose }), purpose).toBe(true);
    expect(await gated({ workflow: { stage: "PLAN" } })).toBe(true);
  });
  it("is false for an ordinary task with neither, a pointer to no task, and a workspace with no pointer", async () => {
    expect(await gated({})).toBe(false);
    expect(await gated(undefined)).toBe(false);
    expect(await gated({ purpose: "nightly_run" }, false)).toBe(false);
  });
});
