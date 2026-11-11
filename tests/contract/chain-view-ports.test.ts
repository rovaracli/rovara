// Plan 4 Task 10: the broker's side of the chain view's task ports (`chainViewPortsFor`): a step task's settled spend, from the model proxy's keys, and the approvals its
// agent-step run waits on. A task of another org is nobody's; no proxy means no cost; the task view is Plan 3's, handed in.
import { describe, expect, it } from "vitest";
import { chainViewPortsFor } from "../../packages/broker/src/chains/view-ports.js";
import { approvalKey } from "@rovara-code/contracts";
import { taskAgentRunKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ORG_A, ORG_B } from "../support/chain-run-world.js";

const TASK = "task-1";
const APPROVAL = `apr_${"a".repeat(20)}`;

function setup(extra: { keys?: string[]; agent?: boolean; open?: boolean; workflow?: boolean } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_A, modelKeyIds: extra.keys ?? ["k1", "k2"], ...(extra.agent === false ? {} : { agent: { agentId: "root-cause-analyst", name: "Root-cause analyst", version: 1, builtin: true } }), ...(extra.workflow === true ? { workflow: { stage: "BUILD" } } : {}) });
  db.set({
    ...taskAgentRunKey(TASK), entityType: "AGENT_RUN", orgId: ORG_A, revision: 1, state: "WAITING_FOR_APPROVAL", cursor: 0, input: { text: "why" },
    steps: [{ id: "investigate", status: "waiting", operationIds: [], approvalIds: [APPROVAL] }], reports: [],
  });
  db.set({
    ...approvalKey(ORG_A, APPROVAL), entityType: "APPROVAL", orgId: ORG_A, approvalId: APPROVAL, kind: "step", subject: { kind: "agent_run", taskId: TASK, stepId: "investigate" },
    prompt: "Send it?", approvers: { kind: "ids", ids: [] }, status: extra.open === false ? "DECLINED" : "PENDING", createdAt: "2026-10-22T09:00:00.000Z", expiresAt: "2026-10-25T09:00:00.000Z",
  });
  const asked: string[][] = [];
  const approvals = { documentClient: db, tableName: "T", now: () => Date.parse("2026-10-22T09:00:00.000Z") };
  return { db, asked, approvals };
}

describe("the chain view's task ports", () => {
  it("adds up the task's keys and counts the approvals its run waits on", async () => {
    const t = setup();
    const ports = chainViewPortsFor({ approvals: t.approvals, keySpend: async (keys) => { t.asked.push([...keys]); return 1.234; }, taskView: async () => { throw new Error("not used"); } });
    expect(await ports.taskFacts(ORG_A, TASK)).toEqual({ spentUsd: 1.234, pendingApprovals: 1 });
    expect(t.asked).toEqual([["k1", "k2"]]);
  });

  it("counts no approval that is decided, and none for a task with no agent run", async () => {
    const closed = chainViewPortsFor({ approvals: setup({ open: false }).approvals, taskView: async () => { throw new Error("not used"); } });
    expect(await closed.taskFacts(ORG_A, TASK)).toEqual({ spentUsd: 0, pendingApprovals: 0 });
    const coding = chainViewPortsFor({ approvals: setup({ agent: false }).approvals, taskView: async () => { throw new Error("not used"); } });
    expect(await coding.taskFacts(ORG_A, TASK)).toEqual({ spentUsd: 0, pendingApprovals: 0 });
  });

  it("counts no agent-step approvals for a task that runs a workflow, and rounds the cost to the cent-fraction the ledger keeps", async () => {
    const workflow = chainViewPortsFor({ approvals: setup({ workflow: true }).approvals, taskView: async () => { throw new Error("not used"); } });
    expect((await workflow.taskFacts(ORG_A, TASK))?.pendingApprovals).toBe(0);
    const sum = chainViewPortsFor({ approvals: setup().approvals, keySpend: async () => 0.1 + 0.2, taskView: async () => { throw new Error("not used"); } });
    expect((await sum.taskFacts(ORG_A, TASK))?.spentUsd).toBe(0.3);
  });

  it("asks the proxy nothing for a task with no keys, and reads a cost of nothing without a proxy", async () => {
    const t = setup({ keys: [] });
    const ports = chainViewPortsFor({ approvals: t.approvals, keySpend: async (keys) => { t.asked.push([...keys]); return 5; }, taskView: async () => { throw new Error("not used"); } });
    expect((await ports.taskFacts(ORG_A, TASK))?.spentUsd).toBe(0);
    expect(t.asked).toEqual([]);
  });

  it("reads another org's task, and a task that is not there, as nothing", async () => {
    const t = setup();
    const ports = chainViewPortsFor({ approvals: t.approvals, keySpend: async () => 9, taskView: async () => { throw new Error("not used"); } });
    expect(await ports.taskFacts(ORG_B, TASK)).toBeUndefined();
    expect(await ports.taskFacts(ORG_A, "task-9")).toBeUndefined();
  });

  it("hands the task to Plan 3's view and gives back what it answers", async () => {
    const t = setup();
    const seen: string[] = [];
    const ports = chainViewPortsFor({ approvals: t.approvals, taskView: async (task) => { seen.push(task.taskId); return { title: "x" } as never; } });
    expect(await ports.taskView({ taskId: TASK } as never)).toEqual({ title: "x" });
    expect(seen).toEqual([TASK]);
  });
});
