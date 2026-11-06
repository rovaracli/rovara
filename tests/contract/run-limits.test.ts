import { fixtureActor } from "../support/money-authority.js";
// Plan 3 Task 34: run limits come from estimates. A workflow task starts with the planning limit, a task without a workflow with the TASK
// estimate's run limit and an agent-step run with the AGENT estimate's; the plan that reaches review carries `runEstimate`; approving the
// plan accepts the run limit by the approver's tier, or blocks the workflow and asks (through the injected `requestRunLimit`, which Task 32
// wires); a run that merged or finished writes its cost for the next estimate; `suggestMaxPerRun` is a display figure for the agent's page.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { getTaskDocumentView, releaseFinishedTask, resumeAfterRunLimitApproval } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { runLimitAckMessage } from "../../packages/broker/src/aws/developer-tasks/decide.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import {
  acceptRunLimit, estimateRun, recordRunCost, suggestMaxPerRun, type EstimatePath, type RequestRunLimit,
} from "../../packages/broker/src/spend/estimate.js";
import { writeSpendPolicy } from "../../packages/broker/src/spend/settings.js";
import { WorkflowDecisionRequestSchema, createWorkflowSnapshot, WorkflowSnapshotSchema, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { recipeDigest, type RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import type { AgentId } from "../../packages/contracts/src/agent-node.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org-node.js";
import { agentRunsKey, projectAgentKey, projectAiKey, projectMemberKey, runCostKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { MAX_RUN_LIMIT_USD, defaultSpendPolicy, runLimitBlockText, type RunEstimate } from "../../packages/contracts/src/spend.js";
import type { ProjectRole } from "../../packages/contracts/src/app-projects.js";
import { MAYA, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { call, loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const ROVARA_CODE = "rovara-code" as AgentId;

let createAgentRunStarter: typeof BrokerModule.createAgentRunStarter;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createAgentRunStarter } = await import("../../packages/broker/src/aws/broker.js"));
});

// ---- history: the costs of the runs an estimate reads

/** One finished run's cost, as `recordRunCost` leaves it. `index` orders the runs: a higher one ended later. */
function seedCost(db: FakeDynamoDb, input: { org?: OrgId; project?: string; agentId?: string; path: EstimatePath; costUsd: number; index: number; taskId?: string }): void {
  const endedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + input.index * 3_600_000).toISOString();
  const taskId = input.taskId ?? `task-${input.path}-${input.index}`;
  const org = input.org ?? TEST_ORG;
  const project = input.project ?? "payments";
  const agentId = input.agentId ?? ROVARA_CODE;
  db.set({
    ...runCostKey(org, project, agentId, input.path, endedAt, taskId), entityType: "RUN_COST",
    orgId: org, project, agentId, path: input.path, taskId, endedAt, costUsd: input.costUsd,
  });
}
const seedCosts = (db: FakeDynamoDb, path: EstimatePath, costs: readonly number[], extra: { org?: OrgId; project?: string; agentId?: string; offset?: number } = {}) =>
  costs.forEach((costUsd, index) => seedCost(db, { path, costUsd, index: index + (extra.offset ?? 0), ...extra }));

const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", cloud: true });
const estimateOf = (db: FakeDynamoDb, path: EstimatePath, extra: { project?: string; agentId?: AgentId; org?: OrgId; maxPerRunUsd?: number } = {}) =>
  estimateRun(deps(db), { orgId: extra.org ?? TEST_ORG, project: extra.project ?? "payments", agentId: extra.agentId ?? ROVARA_CODE, path, ...(extra.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: extra.maxPerRunUsd }) });

describe("estimateRun", () => {
  it("answers the defaults when there is no history", async () => {
    const db = new FakeDynamoDb();
    expect(await estimateOf(db, "FULL")).toEqual({ lowUsd: 4, highUsd: 10, runLimitUsd: 20, stopAtUsd: 20, basis: "default", samples: 0 });
    expect(await estimateOf(db, "QUICK")).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 });
    expect(await estimateOf(db, "TASK")).toEqual({ lowUsd: 2, highUsd: 5, runLimitUsd: 10, stopAtUsd: 10, basis: "default", samples: 0 });
    expect(await estimateOf(db, "AGENT")).toEqual({ lowUsd: 0.5, highUsd: 2, runLimitUsd: 4, stopAtUsd: 4, basis: "default", samples: 0 });
  });

  it("takes p50 and p80 by nearest rank over the costs, and doubles the high end for the run limit", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [1, 2, 2, 3, 4, 9]);
    expect(await estimateOf(db, "FULL")).toEqual({ lowUsd: 2, highUsd: 4, runLimitUsd: 8, stopAtUsd: 8, basis: "history", samples: 6 });
  });

  it("rounds each figure up to fifty cents", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [1.1, 1.2, 1.3, 1.4, 1.6]);
    expect(await estimateOf(db, "FULL")).toEqual({ lowUsd: 1.5, highUsd: 1.5, runLimitUsd: 3, stopAtUsd: 3, basis: "history", samples: 5 });
  });

  it("rounds up, never to the nearest", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [1.1, 1.1, 1.1, 1.1, 1.1]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ lowUsd: 1.5, highUsd: 1.5, runLimitUsd: 3 });
  });

  it("never expects a run to cost nothing", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [0, 0, 0, 0, 0]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ lowUsd: 0.5, highUsd: 0.5, runLimitUsd: 1 });
  });

  it("does not round a cost that is already a multiple of fifty cents up again", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [2, 2, 2, 2.5, 2.5]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ lowUsd: 2, highUsd: 2.5, runLimitUsd: 5 });
  });

  it("uses the default below five samples", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [1, 1, 1, 1]);
    expect(await estimateOf(db, "FULL")).toEqual({ lowUsd: 4, highUsd: 10, runLimitUsd: 20, stopAtUsd: 20, basis: "default", samples: 4 });
  });

  it("reads only the newest twenty runs", async () => {
    const db = new FakeDynamoDb();
    // Five old, dear runs, then twenty cheap ones: the old ones are past the twenty.
    seedCosts(db, "FULL", [100, 100, 100, 100, 100]);
    seedCosts(db, "FULL", Array.from({ length: 20 }, () => 1), { offset: 5 });
    expect(await estimateOf(db, "FULL")).toEqual({ lowUsd: 1, highUsd: 1, runLimitUsd: 2, stopAtUsd: 2, basis: "history", samples: 20 });
  });

  it("reads the history of this org, project, agent and path only", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [30, 30, 30, 30, 30], { org: ORG_B });
    seedCosts(db, "FULL", [30, 30, 30, 30, 30], { project: "other" });
    seedCosts(db, "FULL", [30, 30, 30, 30, 30], { agentId: "agt_aaaaaaaaaaaaaaaaaaaa" });
    seedCosts(db, "QUICK", [30, 30, 30, 30, 30]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ basis: "default", samples: 0, runLimitUsd: 20 });
    expect(await estimateOf(db, "FULL", { org: ORG_B })).toMatchObject({ basis: "history", samples: 5, highUsd: 30 });
  });

  it("stops at the agent's max per run when that is lower than the run limit, and at the run limit otherwise", async () => {
    const db = new FakeDynamoDb();
    expect(await estimateOf(db, "FULL", { maxPerRunUsd: 6 })).toMatchObject({ runLimitUsd: 20, stopAtUsd: 6 });
    expect(await estimateOf(db, "FULL", { maxPerRunUsd: 50 })).toMatchObject({ runLimitUsd: 20, stopAtUsd: 20 });
    seedCosts(db, "FULL", [75, 75, 75, 75, 75]);
    // Rovara Code has no max per run: the stop is the run limit itself.
    expect(await estimateOf(db, "FULL")).toMatchObject({ highUsd: 75, runLimitUsd: 150, stopAtUsd: 150 });
  });

  it("never sets a run limit above the most a run may be limited to", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "FULL", [900, 900, 900, 900, 900]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ highUsd: 900, runLimitUsd: MAX_RUN_LIMIT_USD, stopAtUsd: MAX_RUN_LIMIT_USD });
  });

  it("uses the org's run limit multiplier", async () => {
    const db = new FakeDynamoDb();
    await writeSpendPolicy(deps(db), TEST_ORG, { ...defaultSpendPolicy(), runLimitMultiplier: 3 }, fixtureActor(deps(db), TEST_ORG, "admin").developerId, { ...({}), actor: fixtureActor(deps(db), TEST_ORG, "admin") });
    expect(await estimateOf(db, "FULL")).toMatchObject({ highUsd: 10, runLimitUsd: 30 });
  });

  it("leaves out a stored cost that is not a number, and never answers a limit below a dollar", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "QUICK", [0.01, 0.02, 0.01, 0.02, 0.01]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ lowUsd: 0.5, highUsd: 0.5, runLimitUsd: 1 });
    seedCost(db, { path: "QUICK", costUsd: Number.NaN, index: 50 });
    expect(await estimateOf(db, "QUICK")).toMatchObject({ samples: 5 });
  });
});

describe("suggestMaxPerRun", () => {
  /** A run of the agent as the settlement ledger keeps it: the total the run spent in a month. */
  const run = (db: FakeDynamoDb, agentId: string, month: string, taskId: string, usd: number, lastAt: string, project = "payments") =>
    db.set({ ...agentRunsKey(TEST_ORG, month, agentId, taskId), entityType: "AGENT_RUN", orgId: TEST_ORG, agentId, project, origin: "app", usd, taskId, lastAt });

  it("doubles the p80 of the agent's last runs", async () => {
    const db = new FakeDynamoDb();
    [1, 2, 2, 3, 4, 9].forEach((usd, index) => run(db, ROVARA_CODE, index < 3 ? "2026-09" : "2026-10", `t${index}`, usd, `2026-10-0${index + 1}T00:00:00.000Z`, index % 2 === 0 ? "payments" : "web"));
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: ROVARA_CODE })).toBe(8);
  });

  it("falls back to the default high end times two for the agent's usual path", async () => {
    const db = new FakeDynamoDb();
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: ROVARA_CODE })).toBe(20);
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: "ticket-triage" })).toBe(4);
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: "agt_aaaaaaaaaaaaaaaaaaaa", coding: true })).toBe(20);
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: "agt_aaaaaaaaaaaaaaaaaaaa" })).toBe(4);
  });

  it("needs five runs, counts only the last twenty and reads only this agent in this org", async () => {
    const db = new FakeDynamoDb();
    [5, 5, 5, 5].forEach((usd, index) => run(db, ROVARA_CODE, "2026-10", `few${index}`, usd, `2026-10-0${index + 1}T00:00:00.000Z`));
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: ROVARA_CODE })).toBe(20);
    Array.from({ length: 20 }, (_, index) => run(db, ROVARA_CODE, "2026-10", `new${index}`, 1, `2026-10-2${index % 10}T0${Math.floor(index / 10)}:00:00.000Z`));
    run(db, "ticket-triage", "2026-10", "other", 40, "2026-10-29T00:00:00.000Z");
    expect(await suggestMaxPerRun(deps(db), { orgId: TEST_ORG, agentId: ROVARA_CODE })).toBe(2);
  });
});

describe("the agent's page", () => {
  it("suggests the default until the agent has runs, then twice the p80 of its last runs", async () => {
    const t = await world();
    const suggested = async () => (await t.api(MAYA, "GET", `/v1/app/agents/${ROVARA_CODE}`)).body.suggestedMaxPerRunUsd;
    expect(await suggested()).toBe(20);
    const month = new Date().toISOString().slice(0, 7);
    [1, 2, 2, 3, 4, 9].forEach((usd, index) => t.h.db.set({
      ...agentRunsKey(TEST_ORG, month, ROVARA_CODE, `run-${String(index)}`), entityType: "AGENT_RUN", orgId: TEST_ORG, agentId: ROVARA_CODE, project: "payments", origin: "app", usd, taskId: `run-${String(index)}`,
      lastAt: `${month}-0${String(index + 1)}T00:00:00.000Z`,
    }));
    expect(await suggested()).toBe(8);
  });
});

// ---- who may accept a run limit

describe("acceptRunLimit", () => {
  const taskWith = (runLimitUsd: number, extra: Partial<DeveloperTaskRecord> = {}): DeveloperTaskRecord => ({
    taskId: "11111111-1111-4111-8111-111111111111", orgId: TEST_ORG, project: "payments", budgetUsd: 2,
    runEstimate: { lowUsd: 1, highUsd: runLimitUsd / 2, runLimitUsd, stopAtUsd: runLimitUsd, basis: "history", samples: 6 }, ...extra,
  } as DeveloperTaskRecord);
  async function accepting(options: { role?: ProjectRole; broken?: boolean; policy?: Partial<ReturnType<typeof defaultSpendPolicy>> } = {}) {
    const db = new FakeDynamoDb();
    const members = new FakeProjectMembers();
    members.addProject(TEST_ORG, "payments");
    if (options.role !== undefined) members.grant(TEST_ORG, "payments", "dev", options.role);
    if (options.broken === true) members.roleOf = async () => { throw new Error("unreachable"); };
    if (options.policy !== undefined) await writeSpendPolicy(deps(db), TEST_ORG, { ...defaultSpendPolicy(), ...options.policy }, fixtureActor(deps(db), TEST_ORG, "admin").developerId, { ...({}), actor: fixtureActor(deps(db), TEST_ORG, "admin") });
    return (orgRole: OrgRole, limit: number) => acceptRunLimit({ ...deps(db), projectMembers: members }, { task: taskWith(limit), approver: { developerId: "dev", orgRole } });
  }

  it("lets a member accept up to the lead threshold, and no more", async () => {
    const accept = await accepting();
    expect(await accept("member", 8)).toMatchObject({ accepted: true, runLimitUsd: 8 });
    expect(await accept("member", 10)).toMatchObject({ accepted: true, runLimitUsd: 10 });
    expect(await accept("member", 11)).toMatchObject({ accepted: false, needs: "maintainer", approverRole: "project_maintainer" });
  });

  it("lets a project maintainer from a grant accept up to the admin threshold", async () => {
    const accept = await accepting({ role: "maintainer" });
    expect(await accept("member", 20)).toMatchObject({ accepted: true, runLimitUsd: 20 });
    expect(await accept("member", 100)).toMatchObject({ accepted: true });
    expect(await accept("member", 150)).toMatchObject({ accepted: false, needs: "admin", approverRole: "org_admin" });
  });

  it("lets an org owner or admin accept any amount", async () => {
    const accept = await accepting();
    expect(await accept("admin", 150)).toMatchObject({ accepted: true, runLimitUsd: 150 });
    expect(await accept("owner", MAX_RUN_LIMIT_USD)).toMatchObject({ accepted: true, runLimitUsd: MAX_RUN_LIMIT_USD });
  });

  it("gives a contributor or a viewer a member's tier", async () => {
    for (const role of ["contributor", "viewer"] as const) {
      expect(await (await accepting({ role }))("member", 11)).toMatchObject({ accepted: false, needs: "maintainer" });
    }
  });

  it("says in the exact words who has to approve", async () => {
    const accept = await accepting();
    expect(await accept("member", 20)).toMatchObject({ accepted: false, message: "This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it." });
    expect(await accept("member", 150)).toMatchObject({ accepted: false, message: "This plan's run limit is $150, which needs an admin's approval. I've asked for it." });
  });

  it("reads the thresholds from the org's spend policy", async () => {
    const accept = await accepting({ policy: { leadApprovalThresholdUsd: 5, adminApprovalThresholdUsd: 30 } });
    expect(await accept("member", 6)).toMatchObject({ accepted: false, needs: "maintainer" });
    expect(await accept("member", 31)).toMatchObject({ accepted: false, needs: "admin" });
  });

  it("treats a role that can't be read as a member's, never a higher one", async () => {
    const accept = await accepting({ role: "maintainer", broken: true });
    expect(await accept("member", 20)).toMatchObject({ accepted: false, needs: "maintainer" });
  });

  it("works out the limit afresh when the task has no estimate", async () => {
    const db = new FakeDynamoDb();
    seedCosts(db, "QUICK", [1, 2, 2, 3, 4, 9]);
    const task = { ...taskWith(0), runEstimate: undefined, workflow: createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-10-22T00:00:00.000Z", path: "QUICK" }) } as unknown as DeveloperTaskRecord;
    expect(await acceptRunLimit({ ...deps(db) }, { task, approver: { developerId: "dev", orgRole: "member" } })).toMatchObject({ accepted: true, runLimitUsd: 8 });
  });
});

// ---- the plan-ready lines

describe("the plan-ready message", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const now = "2026-10-22T12:00:00.000Z";
  const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
  const workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), revision: 3, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [plan] });
  const estimate = (extra: Partial<RunEstimate> = {}): RunEstimate => ({ lowUsd: 2, highUsd: 4, runLimitUsd: 8, stopAtUsd: 8, basis: "history", samples: 6, ...extra });
  const textOf = (runEstimate: RunEstimate | undefined, agentName = "Rovara Code") => workflowMessage({ taskId, workflow, ...(runEstimate === undefined ? {} : { runEstimate, agentName }) })?.text ?? "";

  it("says the estimated cost with an en dash and the run limit", () => {
    expect(textOf(estimate())).toContain("Estimated cost: about $2–$4. Run limit: $8.");
  });

  it("writes half dollars as they are", () => {
    expect(textOf(estimate({ lowUsd: 1.5, highUsd: 2.5, runLimitUsd: 5, stopAtUsd: 5 }))).toContain("Estimated cost: about $1.5–$2.5. Run limit: $5.");
  });

  it("adds the max-per-run line only when the agent's max per run stops the run first", () => {
    const text = textOf(estimate({ stopAtUsd: 3 }), "Ticket looker");
    expect(text).toContain("Estimated cost: about $2–$4. Run limit: $8.\nTicket looker's max per run is $3, so this run will stop at $3, before its run limit.");
    expect(textOf(estimate())).not.toContain("max per run");
  });

  it("says nothing of cost on a requirements or design document, whose approval accepts no run limit", () => {
    const early = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, path: "FULL" }), revision: 3, stage: "PLAN_REVIEW", state: "WAITING",
      artifacts: [{ ...plan, id: "requirements-v1", type: "requirements" as const }] });
    const text = workflowMessage({ taskId, workflow: early, runEstimate: estimate(), agentName: "Rovara Code" })?.text ?? "";
    expect(text).toContain("is ready for your approval");
    expect(text).not.toContain("Estimated cost");
  });

  it("says nothing of cost when the task has no estimate, and leaves the rest of the message as it was", () => {
    const plain = textOf(undefined);
    expect(plain).not.toContain("Estimated cost");
    expect(textOf(estimate())).toContain(plain.split("\n")[0]!);
  });

  it("says a plan blocked on its run limit in the same words, with nothing to retry", () => {
    const blocked = WorkflowSnapshotSchema.parse({ ...workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: runLimitBlockText(20, "maintainer") });
    const message = workflowMessage({ taskId, workflow: blocked })!;
    expect(message.text).toBe("This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it.");
    const buttons = message.blocks.filter((block) => block.type === "actions").flatMap((block) => (block.elements as Array<{ action_id: string }>).map((button) => button.action_id));
    expect(buttons).toEqual(["agentx_workflow_close"]);
  });

  it("escapes an agent name that Slack would read as markup", () => {
    expect(textOf(estimate({ stopAtUsd: 3 }), "<!channel> &")).toContain("&lt;!channel&gt; &amp;'s max per run is $3");
  });
});

// ---- the flows

type Reply = { status: number; body: Record<string, unknown> };

async function world(options: { proxy?: boolean; requestRunLimit?: RequestRunLimit | "none" } = {}) {
  const access = options.proxy === false ? undefined : fakeModelAccess();
  const requestRunLimit = vi.fn<RequestRunLimit>(async () => ({ spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa" }));
  const seam = options.requestRunLimit === "none" ? undefined : options.requestRunLimit ?? requestRunLimit;
  const h = await createSingleAnswerPlanBroker({
    brokerExtra: { agents: { ...(seam === undefined ? {} : { requestRunLimit: seam }) }, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }) },
  });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
  }
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const api = async (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const startTask = async (extra: Record<string, unknown> = {}) => {
    const started = await api(MAYA, "POST", "/v1/dev/tasks", { project: "payments", instructions: "Fix the retry bug", client: "test-client", ...extra });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    return { taskId, workspaceId: String(meta(taskId).workspaceId) };
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; budgetUsd?: number; budgetBaselineUsd?: number; maxPerRunUsd?: number; runEstimate?: RunEstimate; modelKeyIds?: string[];
    workflow: { revision: number; stage: string; state: string; blockReason?: string; artifacts: Array<{ sha256: string }>; decisions: unknown[] };
  };
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const operationWhere = (workspaceId: string, predicate: (item: Record<string, unknown>) => boolean) => {
    const found = operations(workspaceId).filter(predicate).at(-1);
    if (found === undefined) throw new Error("no such operation");
    return String(found.id);
  };
  const finishPrepare = async (workspaceId: string) => h.finish(workspaceId, operationWhere(workspaceId, (item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
  /** Finishes the running planning step with a plan, and answers what the decision names. */
  const finishPlanning = async (taskId: string, workspaceId: string) => {
    await h.artifact(workspaceId, operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED"), "plan.md", planAnswer(planDocument()));
    await h.finish(workspaceId, operationWhere(workspaceId, (item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED"), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflow = meta(taskId).workflow;
    return { digest: workflow.artifacts.at(-1)!.sha256, revision: workflow.revision };
  };
  const decide = (taskId: string, plan: { digest: string; revision: number }, requestId: string = randomUUID(), decision: "APPROVE" | "REQUEST_CHANGES" = "APPROVE") =>
    h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId, expectedRevision: plan.revision, decision, reason: "Approved", artifactDigest: plan.digest, ...(decision === "APPROVE" ? { acknowledgedRunLimitUsd: (h.db.get(`DEVTASK#${taskId}`, "META") as { runEstimate?: { runLimitUsd?: number } } | undefined)?.runEstimate?.runLimitUsd } : {}) });
  /** A Quick workflow task with its plan made and waiting for the owner. */
  const planned = async (path: "QUICK" | "FULL" = "QUICK") => {
    const { taskId, workspaceId } = await startTask({ workflow: true, workflowPath: path });
    await finishPrepare(workspaceId);
    const plan = await finishPlanning(taskId, workspaceId);
    return { taskId, workspaceId, plan };
  };
  const setRole = (orgRole: OrgRole) => seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: orgRole });
  const makeMaintainer = () => h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, grantId: randomUUID(), projectName: "payments", role: "developer", projectRole: "maintainer", grantedBy: { system: "admin" } });
  return { h, access, requestRunLimit, store, api, startTask, meta, operations, operationWhere, finishPrepare, finishPlanning, decide, planned, setRole, makeMaintainer };
}

describe("the limit a run starts with", () => {
  it("gives a Quick workflow task the planning limit, and the key its operation asks for is capped at it", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.startTask({ workflow: true, workflowPath: "QUICK" });
    expect(t.meta(taskId).budgetUsd).toBe(2);
    await t.finishPrepare(workspaceId);
    const planning = t.h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === t.operationWhere(workspaceId, (item) => item.workflowMode === "PLAN"))[0]!;
    const asked = await call(t.h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (planning.invocation as { callbackCapability: string }).callbackCapability } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(t.access!.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(2);
  });

  it("gives a Full workflow task the Full planning limit", async () => {
    const t = await world();
    expect(t.meta((await t.startTask({ workflow: true, workflowPath: "FULL" })).taskId).budgetUsd).toBe(6);
  });

  it("gives a project's own planning limit when it set one", async () => {
    const t = await world();
    t.h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: false, planningLimitUsd: { QUICK: 4 }, revision: 1 });
    expect(t.meta((await t.startTask({ workflow: true, workflowPath: "QUICK" })).taskId).budgetUsd).toBe(4);
    expect(t.meta((await t.startTask({ workflow: true, workflowPath: "FULL" })).taskId).budgetUsd).toBe(6);
  });

  it("gives a task without a workflow the TASK estimate's run limit", async () => {
    const t = await world();
    expect(t.meta((await t.startTask()).taskId).budgetUsd).toBe(10);
    seedCosts(t.h.db, "TASK", [1, 1, 1, 1, 1]);
    expect(t.meta((await t.startTask()).taskId).budgetUsd).toBe(2);
  });

  it("leaves a start without a model proxy as it was", async () => {
    const t = await world({ proxy: false });
    expect(t.meta((await t.startTask({ workflow: true, workflowPath: "QUICK" })).taskId).budgetUsd).toBeUndefined();
    expect(t.meta((await t.startTask()).taskId).budgetUsd).toBeUndefined();
  });

  it("gives an agent-step run the AGENT estimate's run limit", async () => {
    const t = await world();
    const overlay: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "work", kind: "agent", workspace: "none" }] };
    const created = await t.api(MAYA, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: AgentId }).agentId;
    const draft = (await t.store.getDraft(TEST_ORG, agentId))!;
    await t.store.saveDraft({ orgId: TEST_ORG, agentId, overlay, expectedRevision: draft.revision, by: MAYA.developerId });
    const saved = (await t.store.get(TEST_ORG, agentId))!;
    await t.store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: saved.draftRevision, digest: recipeDigest(await resolveAgent(t.store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
    t.h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", orgId: TEST_ORG, project: "payments", agentId, addedBy: MAYA.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    const run = await t.api(MAYA, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", input: { text: "Look at the new ticket" } });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(t.meta(String((run.body.task as { taskId: string }).taskId)).budgetUsd).toBe(4);
  });

  it("lets a request lower the limit a run starts with, never raise it, and starts a run limited to 0 paused", async () => {
    const t = await world();
    const starter = createAgentRunStarter(t.h.brokerInput as never)!;
    const request = (runLimitUsd: number) => ({
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE }, input: { text: "Fix the retry bug" }, origin: "app" as const,
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member" as const, developerId: MAYA.developerId }, runLimitUsd,
    });
    expect(await startAgentRun(starter, request(1))).toMatchObject({ runLimitUsd: 1, stopAtUsd: 1, paused: false });
    expect(await startAgentRun(starter, request(5))).toMatchObject({ runLimitUsd: 2, stopAtUsd: 2, paused: false });
    expect(await startAgentRun(starter, request(0))).toMatchObject({ runLimitUsd: 0, paused: true });
  });
});

describe("a plan that reaches review", () => {
  it("carries the run estimate on the task and in its view", async () => {
    const t = await world();
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 });
    const view = await t.api(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect((view.body.task as { runEstimate?: RunEstimate }).runEstimate).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 });
  });

  it("shows the limit approving the plan sets: the estimate held to a lower limit the start asked for, the same as the confirmation (QA6-12)", async () => {
    const t = await world();
    const { taskId } = await t.planned("QUICK");
    t.h.db.set({ ...t.meta(taskId), requestedRunLimitUsd: 3 });
    const view = await t.api(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect((view.body.task as { runEstimate?: RunEstimate }).runEstimate).toMatchObject({ runLimitUsd: 3, highUsd: 3 });
    expect(t.meta(taskId).runEstimate!.runLimitUsd).toBe(6);
  });

  it("estimates from this project's and agent's history, and stops at the task's max per run when that is lower", async () => {
    const t = await world();
    seedCosts(t.h.db, "FULL", [1, 2, 2, 3, 4, 9]);
    const { taskId, workspaceId } = await t.startTask({ workflow: true, workflowPath: "FULL" });
    t.h.db.set({ ...t.meta(taskId), maxPerRunUsd: 5 });
    await t.finishPrepare(workspaceId);
    await t.finishPlanning(taskId, workspaceId);
    // The requirements and design come first; the estimate is made for the coding plan.
    expect(t.meta(taskId).runEstimate).toBeUndefined();
    for (let phase = 0; phase < 2; phase += 1) {
      const task = t.meta(taskId).workflow;
      expect((await t.decide(taskId, { digest: task.artifacts.at(-1)!.sha256, revision: task.revision })).status).toBe(200);
      await t.finishPlanning(taskId, workspaceId);
    }
    expect(t.meta(taskId).runEstimate).toEqual({ lowUsd: 2, highUsd: 4, runLimitUsd: 8, stopAtUsd: 5, basis: "history", samples: 6 });
  });

  it("drops the estimate of an earlier plan when the new plan has none", async () => {
    const t = await world({ proxy: false });
    const { taskId, workspaceId } = await t.startTask({ workflow: true, workflowPath: "QUICK" });
    t.h.db.set({ ...t.meta(taskId), runEstimate: { lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 } });
    await t.finishPrepare(workspaceId);
    await t.finishPlanning(taskId, workspaceId);
    expect(t.meta(taskId).runEstimate).toBeUndefined();
  });

  it("makes no estimate on an install without a model proxy", async () => {
    const t = await world({ proxy: false });
    expect(t.meta((await t.planned("QUICK")).taskId).runEstimate).toBeUndefined();
  });
});

describe("approving the plan", () => {
  it("starts implementation when a member accepts a run limit of $8, with the limit and a new window", async () => {
    const t = await world();
    seedCosts(t.h.db, "QUICK", [1, 2, 2, 3, 4, 9]);
    const { taskId, workspaceId, plan } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate).toMatchObject({ runLimitUsd: 8 });
    const approved = await t.decide(taskId, plan);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(t.meta(taskId)).toMatchObject({ budgetUsd: 8, budgetBaselineUsd: 0 });
    expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(t.requestRunLimit).not.toHaveBeenCalled();
  });

  it("starts the new window at what planning spent", async () => {
    const t = await world();
    const { taskId, plan } = await t.planned("QUICK");
    const planningKey = "sk-planning-key";
    t.h.db.set({ ...t.meta(taskId), modelKeyIds: [(await import("../../packages/broker/src/org/budget.js")).keyIdOf(planningKey)] });
    t.access!.setKeySpent(planningKey, 1.25);
    expect((await t.decide(taskId, plan)).status).toBe(200);
    expect(t.meta(taskId)).toMatchObject({ budgetUsd: 6, budgetBaselineUsd: 1.25 });
  });

  it("blocks a member's approval of a $20 limit with the exact words, asks for the approval and starts nothing", async () => {
    const t = await world();
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, workspaceId, plan } = await t.planned("QUICK");
    const requestId = randomUUID();
    const approved = await t.decide(taskId, plan, requestId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = t.meta(taskId);
    expect(after.workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it." });
    expect(after.budgetUsd).toBe(2);
    expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
    expect(t.requestRunLimit).toHaveBeenCalledTimes(1);
    const asked = t.requestRunLimit.mock.calls[0]![0];
    expect(asked).toMatchObject({
      kind: "run_limit", resume: "implement", orgId: TEST_ORG, taskId, newLimitUsd: 20, amountUsd: 18, approverRole: "project_maintainer",
      requestedBy: { kind: "member", developerId: MAYA.developerId },
    });
    expect(asked.reason.length).toBeLessThanOrEqual(300);
    // The same decision again is the stored outcome: nothing is asked twice.
    const again = await t.decide(taskId, plan, requestId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t.requestRunLimit).toHaveBeenCalledTimes(1);
    expect(t.meta(taskId).workflow.revision).toBe(after.workflow.revision);
  });

  // QA6-12: the confirmation shows "current limit -> proposed limit" and the person's approval names the proposed limit; the broker refuses an approval that would set another one.
  describe("the confirmation names the limit it sets (QA6-12)", () => {
    const pageView = (t: Awaited<ReturnType<typeof world>>, taskId: string) => {
      const deps = { documentClient: t.h.db, tableName: "state", actions: t.h.actions, log: () => undefined, orgId: TEST_ORG, ...(t.access === undefined ? {} : { modelAccess: t.access }),
        checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() };
      return getTaskDocumentView(deps, { orgId: TEST_ORG, developerId: MAYA.developerId } as never, taskId);
    };
    const decideShowing = (t: Awaited<ReturnType<typeof world>>, taskId: string, plan: { digest: string; revision: number }, acknowledgedRunLimitUsd: number) =>
      t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: plan.revision, decision: "APPROVE", reason: "Approved", artifactDigest: plan.digest, acknowledgedRunLimitUsd });

    it("gives the waiting coding plan's view the limit the task has now and the limit the approval would set", async () => {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const { taskId } = await t.planned("QUICK");
      expect(t.meta(taskId).budgetUsd).toBe(2);
      const view = await pageView(t, taskId);
      expect(view).toMatchObject({ waiting: { kind: "coding plan" }, runLimit: { currentUsd: 2, proposedUsd: 20 } });
    });

    it("takes an acknowledged limit of 0 (nothing to spend) as valid input", () => {
      const base = { requestId: randomUUID(), expectedRevision: 1, decision: "APPROVE", reason: "ok", artifactDigest: "a".repeat(64) };
      expect(WorkflowDecisionRequestSchema.safeParse({ ...base, acknowledgedRunLimitUsd: 0 }).success).toBe(true);
      expect(WorkflowDecisionRequestSchema.safeParse({ ...base, acknowledgedRunLimitUsd: -1 }).success).toBe(false);
    });

    it("accepts an approval that names the limit it was shown, and sets that limit", async () => {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [1, 2, 2, 3, 4, 9]);
      const { taskId, plan } = await t.planned("QUICK");
      const approved = await decideShowing(t, taskId, plan, 8);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.meta(taskId)).toMatchObject({ budgetUsd: 8, workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
    });

    it("writes exactly the acknowledged limit when the live estimate changes during the approval (no stored estimate): it is worked out once", async () => {
      const t = await world();
      const { taskId, workspaceId, plan } = await t.planned("QUICK");
      // No stored estimate: the limit is worked out live from the cost history every time it is asked for.
      const { runEstimate: _gone, ...bare } = t.meta(taskId); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
      t.h.db.set(bare);
      expect(t.meta(taskId).runEstimate).toBeUndefined();
      // The history grows right after the first read of it, as a run's cost landing mid-approval would.
      const send = t.h.db.send.bind(t.h.db);
      let reads = 0;
      t.h.db.send = (async (command: { constructor: { name: string }; input?: { KeyConditionExpression?: string } }) => {
        const answer = await send(command as never);
        if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("RUN_COST")) {
          reads += 1;
          if (reads === 1) seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
        }
        return answer;
      });
      const approved = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: plan.revision, decision: "APPROVE", reason: "Approved", artifactDigest: plan.digest, acknowledgedRunLimitUsd: 6 });
      expect(reads, "the history was read").toBeGreaterThan(0);
      // The limit written is the 6 the person was shown, not the 20 the grown history would give a second read.
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.meta(taskId).budgetUsd).toBe(6);
      expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    });

    it("refuses an approval that names another limit than the one it would set: nothing is written, started or asked", async () => {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const { taskId, workspaceId, plan } = await t.planned("QUICK");
      const before = t.meta(taskId);
      const refused = await decideShowing(t, taskId, plan, 6);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("$20");
      expect(JSON.stringify(refused.body)).toContain("$6");
      const after = t.meta(taskId);
      expect(after.budgetUsd).toBe(before.budgetUsd);
      expect(after.workflow).toMatchObject({ stage: before.workflow.stage, state: "WAITING", revision: before.workflow.revision, decisions: [] });
      expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
      expect(t.requestRunLimit).not.toHaveBeenCalled();
      // Positive control: the same approval naming the real limit goes on to the same place a plain approval does (blocked on the maintainer's approval at $20).
      expect((await decideShowing(t, taskId, plan, 20)).status).toBe(200);
      expect(t.requestRunLimit).toHaveBeenCalledTimes(1);
    });
  });

  describe("owner decision 3 (option E): when the project or an agent's owner pays", () => {
    it("a project that pays: the member's approval of a $20 limit waits for a maintainer in the new words, and the block is still a run-limit block", async () => {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const { taskId, workspaceId, plan } = await t.planned("QUICK");
      t.h.db.set({ ...t.meta(taskId), payer: { kind: "project", project: "payments" } });
      const approved = await t.decide(taskId, plan);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "Waiting for a project maintainer to accept the $20 run limit." });
      expect(t.requestRunLimit).toHaveBeenCalledTimes(1);
      expect(t.requestRunLimit.mock.calls[0]![0]).toMatchObject({ kind: "run_limit", newLimitUsd: 20, approverRole: "project_maintainer" });
      // Nothing restarts it but the approval of the request.
      const before = t.meta(taskId);
      const retried = await t.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: before.workflow.revision, instructions: "Try again." });
      expect(retried).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("Coding starts once the run limit is approved.") as unknown } } });
      expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
    });

    it("a project that pays and sets $25: the member's approval of the $20 limit is accepted and coding starts", async () => {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      t.h.db.set({ ...projectAiKey(TEST_ORG, "payments"), entityType: "PROJECT_AI", projectPays: true, memberAcceptRunLimitUpToUsd: 25, revision: 1 });
      const { taskId, workspaceId, plan } = await t.planned("QUICK");
      t.h.db.set({ ...t.meta(taskId), payer: { kind: "project", project: "payments" } });
      expect((await t.decide(taskId, plan)).status).toBe(200);
      expect(t.meta(taskId)).toMatchObject({ budgetUsd: 20, workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
      expect(t.requestRunLimit).not.toHaveBeenCalled();
      expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    });

    it("an agent's owner pays: within its max per run the approval is accepted, above it the plan waits for the agent's owner", async () => {
      const within = await world();
      seedCosts(within.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const first = await within.planned("QUICK");
      within.h.db.set({ ...within.meta(first.taskId), payer: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa" }, maxPerRunUsd: 20 });
      expect((await within.decide(first.taskId, first.plan)).status).toBe(200);
      expect(within.meta(first.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
      const above = await world();
      seedCosts(above.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const second = await above.planned("QUICK");
      above.h.db.set({ ...above.meta(second.taskId), payer: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa" }, maxPerRunUsd: 19 });
      above.setRole("admin");
      expect((await above.decide(second.taskId, second.plan)).status).toBe(200);
      expect(above.meta(second.taskId).workflow).toMatchObject({ state: "BLOCKED", blockReason: "Waiting for the agent's owner to accept the $20 run limit." });
      expect(above.requestRunLimit.mock.calls[0]![0]).toMatchObject({ approverRole: "agent_owner", newLimitUsd: 20 });
    });
  });

  describe("a plan blocked on its run limit", () => {
    async function blocked() {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const planned = await t.planned("QUICK");
      expect((await t.decide(planned.taskId, planned.plan)).status).toBe(200);
      expect(t.meta(planned.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
      const deps = { documentClient: t.h.db, tableName: "state", actions: t.h.actions, orgId: TEST_ORG, log: () => undefined, now: () => Date.now(), modelAccess: t.access!,
        checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [] };
      return { t, ...planned, deps };
    }
    const implementations = (t: Awaited<ReturnType<typeof world>>, workspaceId: string) => t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");

    it("is not restarted by the owner's retry, and nothing starts", async () => {
      const { t, taskId, workspaceId } = await blocked();
      const before = t.meta(taskId);
      const retried = await t.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { expectedRevision: before.workflow.revision, instructions: "Try again." });
      expect(retried).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: expect.stringContaining("Coding starts once the run limit is approved.") as unknown } } });
      expect(implementations(t, workspaceId)).toEqual([]);
      expect(t.meta(taskId)).toEqual(before);
    });

    it("is not restarted by a send-back to coding either", async () => {
      const { t, taskId, workspaceId } = await blocked();
      const before = t.meta(taskId);
      const sent = await t.api(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { expectedRevision: before.workflow.revision, instructions: "Fix it." });
      expect(sent).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID", message: expect.stringContaining("Coding starts once the run limit is approved.") as unknown } } });
      expect(implementations(t, workspaceId)).toEqual([]);
      expect(t.meta(taskId)).toEqual(before);
    });

    it("starts coding when its run limit is approved: the limit, the new window and the transition in one transaction", async () => {
      const { t, taskId, workspaceId, deps } = await blocked();
      const planningKey = "sk-planning-key";
      t.h.db.set({ ...t.meta(taskId), modelKeyIds: [(await import("../../packages/broker/src/org/budget.js")).keyIdOf(planningKey)] });
      t.access!.setKeySpent(planningKey, 1.5);
      const requestId = randomUUID();
      const writes: string[] = [];
      t.h.db.onWrite(({ after }) => { if (after?.sk === "META" && after.pk === `DEVTASK#${taskId}`) writes.push(`${String(after.workflow && (after.workflow as { state: string }).state)}:${String(after.budgetUsd)}:${String(after.budgetBaselineUsd)}`); });
      expect(await resumeAfterRunLimitApproval(deps as never, taskId, { requestId, runLimitUsd: 20 })).toBe("STARTED");
      expect(writes).toEqual(["RUNNING:20:1.5"]);
      expect(t.meta(taskId)).toMatchObject({ budgetUsd: 20, budgetBaselineUsd: 1.5, workflow: { stage: "IMPLEMENT", state: "RUNNING" } });
      expect(t.meta(taskId).workflow.blockReason).toBeUndefined();
      expect(implementations(t, workspaceId)).toHaveLength(1);
      // The same approval again is the run it started.
      expect(await resumeAfterRunLimitApproval(deps as never, taskId, { requestId, runLimitUsd: 20 })).toBe("STALE");
      expect(implementations(t, workspaceId)).toHaveLength(1);
    });

    it("starts nothing for a task that is not blocked on a run limit", async () => {
      const t = await world();
      const { taskId, workspaceId } = await t.planned("QUICK");
      const deps = { documentClient: t.h.db, tableName: "state", actions: t.h.actions, orgId: TEST_ORG, log: () => undefined, now: () => Date.now(), modelAccess: t.access! };
      expect(await resumeAfterRunLimitApproval(deps as never, taskId, { requestId: randomUUID(), runLimitUsd: 20 })).toBe("STALE");
      const other = t.meta(taskId);
      t.h.db.set({ ...other, workflow: { ...other.workflow, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" } });
      expect(await resumeAfterRunLimitApproval(deps as never, taskId, { requestId: randomUUID(), runLimitUsd: 20 })).toBe("STALE");
      expect(implementations(t, workspaceId)).toEqual([]);
    });

    it("refuses a limit that is not a positive amount, and a proxy that can't say, writing nothing", async () => {
      const { t, taskId, workspaceId, deps } = await blocked();
      await expect(resumeAfterRunLimitApproval(deps as never, taskId, { requestId: randomUUID(), runLimitUsd: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      t.h.db.set({ ...t.meta(taskId), modelKeyIds: ["a".repeat(64)] });
      t.access!.goDown();
      await expect(resumeAfterRunLimitApproval(deps as never, taskId, { requestId: randomUUID(), runLimitUsd: 20 })).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
      expect(implementations(t, workspaceId)).toEqual([]);
      expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    });
  });

  it("accepts no more than the limit a run was asked to start with", async () => {
    const t = await world();
    const starter = createAgentRunStarter(t.h.brokerInput as never)!;
    const started = await startAgentRun(starter, {
      requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE }, input: { text: "Fix the retry bug" }, origin: "app" as const,
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member" as const, developerId: MAYA.developerId }, runLimitUsd: 1,
    });
    const workspaceId = t.meta(started.taskId).workspaceId;
    await t.finishPrepare(workspaceId);
    const plan = await t.finishPlanning(started.taskId, workspaceId);
    expect(t.meta(started.taskId).runEstimate).toMatchObject({ runLimitUsd: 6 });
    // The limit stays the one the run started with (not a raise), so no acknowledgement is needed (slice 2 asks for one only for a raise).
    const approved = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${started.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: plan.revision, decision: "APPROVE", reason: "Approved", artifactDigest: plan.digest });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(t.meta(started.taskId)).toMatchObject({ budgetUsd: 1 });
  });

  it("slice 2: a plan that raises the run limit is never approved without the limit acknowledged, whoever asks (a tool, Slack: both come through this decision)", async () => {
    const t = await world();
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, plan } = await t.planned("QUICK");
    const before = t.meta(taskId) as unknown as { budgetUsd?: number; runEstimate: { runLimitUsd: number } };
    expect(before.runEstimate.runLimitUsd, "positive control: approving raises the limit").toBeGreaterThan(before.budgetUsd ?? 0);
    const body = { expectedRevision: plan.revision, decision: "APPROVE", reason: "Approved", artifactDigest: plan.digest };
    const refused = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), ...body });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "CONFIG_INVALID", message: runLimitAckMessage(before.budgetUsd, before.runEstimate.runLimitUsd) } });
    expect(t.meta(taskId)).toMatchObject({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    expect(t.meta(taskId).budgetUsd).toBe(before.budgetUsd);
    // With the limit acknowledged, it goes on.
    const approved = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), ...body, acknowledgedRunLimitUsd: before.runEstimate.runLimitUsd });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it("slice 2: the coding plan is a decision card: it shows the run limit, refuses a raise without the tick, approves with it, and sends the plan back with a reason", async () => {
    process.env.DECISION_CARDS_ENABLED = "1";
    try {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const { taskId } = await t.planned("QUICK");
      const before = t.meta(taskId) as unknown as { budgetUsd?: number; runEstimate: { runLimitUsd: number } };
      const cardOf = async () => {
        const list = await t.h.dev(MAYA, "GET", "/v1/app/decisions");
        const card = ((list.body.cards ?? []) as Array<{ id: string; kind: string; risk: string; actions: Array<{ kind: string; label: string; href: string }>; runLimit?: { currentUsd?: number; proposedUsd: number } }>).find((candidate) => candidate.kind === "approve_plan");
        return card === undefined ? undefined : { card, digest: (list.body.digests as Record<string, string>)[card.id]! };
      };
      const shown = await cardOf();
      expect(shown, "the owner's plan is a card").toBeDefined();
      expect(shown!.card.id).toBe(`approve_plan:${taskId}`);
      expect(shown!.card.runLimit).toEqual({ proposedUsd: before.runEstimate.runLimitUsd, ...(before.budgetUsd === undefined ? {} : { currentUsd: before.budgetUsd }) });
      expect(shown!.card.actions.map((action) => [action.kind, action.label])).toEqual(expect.arrayContaining([["approve", "Approve"], ["request_changes", "Request changes"]]));
      expect(shown!.card.actions.some((action) => action.kind === "reject"), "no Not now on a document").toBe(false);
      const path = (action: string) => `/v1/app/decisions/approve_plan/${taskId}/${action}`;
      const evidence = async () => { if (shown!.card.risk === "medium") expect((await t.h.dev(MAYA, "POST", path("evidence-opened"), { requestId: randomUUID(), shownDigest: shown!.digest })).status).toBe(200); };
      await evidence();
      // No tick: refused with the words, and nothing moved.
      const refused = await t.h.dev(MAYA, "POST", path("approve"), { requestId: randomUUID(), shownDigest: shown!.digest });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("raises the run limit");
      expect(t.meta(taskId)).toMatchObject({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
      // Request changes from the card: the plan goes back with the reason, through the one workflow decision.
      const changes = await t.h.dev(MAYA, "POST", path("request-changes"), { requestId: randomUUID(), shownDigest: shown!.digest, reason: "Keep the old export too." });
      expect(changes.status, JSON.stringify(changes.body)).toBe(200);
      expect(changes.body).toMatchObject({ cardId: `approve_plan:${taskId}`, outcome: "rejected" });
      const workflow = (t.meta(taskId) as unknown as { workflow: { stage: string; decisions: Array<{ decision: string; reason: string }> } }).workflow;
      expect(workflow.stage).toBe("PLAN");
      expect(workflow.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Keep the old export too." });
      expect(await cardOf(), "no card while the plan is being revised").toBeUndefined();
    } finally { delete process.env.DECISION_CARDS_ENABLED; }
  });

  it("slice 2: the plan card approves with the ticked limit", async () => {
    process.env.DECISION_CARDS_ENABLED = "1";
    try {
      const t = await world();
      seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
      const { taskId } = await t.planned("QUICK");
      const list = await t.h.dev(MAYA, "GET", "/v1/app/decisions");
      const card = ((list.body.cards ?? []) as Array<{ id: string; risk: string; runLimit: { proposedUsd: number } }>).find((candidate) => candidate.id === `approve_plan:${taskId}`)!;
      const digest = (list.body.digests as Record<string, string>)[card.id]!;
      if (card.risk === "medium") await t.h.dev(MAYA, "POST", `/v1/app/decisions/approve_plan/${taskId}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest });
      // A limit other than the one shown is refused as changed; the shown one approves.
      expect((await t.h.dev(MAYA, "POST", `/v1/app/decisions/approve_plan/${taskId}/approve`, { requestId: randomUUID(), shownDigest: digest, acknowledgedRunLimitUsd: card.runLimit.proposedUsd + 1 })).status).toBe(400);
      const approved = await t.h.dev(MAYA, "POST", `/v1/app/decisions/approve_plan/${taskId}/approve`, { requestId: randomUUID(), shownDigest: digest, acknowledgedRunLimitUsd: card.runLimit.proposedUsd });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      // Approved: coding starts, or waits for the raise a maintainer has to grant (the run_limit request, an outsider's decision: slice 3).
      expect(t.meta(taskId)).toMatchObject({ workflow: { stage: "IMPLEMENT" } });
      // The tick belongs to a coding plan's card only.
      expect((await t.h.dev(MAYA, "POST", `/v1/app/decisions/approve_plan/${taskId}/approve`, { requestId: randomUUID(), shownDigest: digest, acknowledgedRunLimitUsd: 1 })).status).not.toBe(200);
    } finally { delete process.env.DECISION_CARDS_ENABLED; }
  });

  it("tells the task page what the task waits for", async () => {
    const t = await world();
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, plan } = await t.planned("QUICK");
    expect((await t.decide(taskId, plan)).status).toBe(200);
    const deps = { documentClient: t.h.db, tableName: "state", actions: t.h.actions, log: () => undefined, orgId: TEST_ORG,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() };
    expect(await getTaskDocumentView(deps as never, { orgId: TEST_ORG, developerId: MAYA.developerId } as never, taskId)).toMatchObject({
      status: "Waiting for the run limit to be approved", nextStep: "Coding starts once a project maintainer or an admin approves it, or close the task in Rovara.",
    });
  });

  it("asks through the broker's own seam when none was injected (the merge with Task 32): the words say so, and a run_limit request exists", async () => {
    const t = await world({ requestRunLimit: "none" });
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, workspaceId, plan } = await t.planned("QUICK");
    expect((await t.decide(taskId, plan)).status).toBe(200);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it." });
    expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
    expect(t.h.db.find((item) => item.entityType === "SPEND_REQUEST" && item.taskId === taskId)).toMatchObject([{ kind: "run_limit", status: "PENDING", resume: "implement", newLimitUsd: 20 }]);
  });

  it("does not say it asked when the seam made no request, and says an admin's for a larger limit", async () => {
    const t = await world({ requestRunLimit: vi.fn<RequestRunLimit>(async () => undefined) });
    seedCosts(t.h.db, "QUICK", [75, 75, 75, 75, 75]);
    const { taskId, plan } = await t.planned("QUICK");
    expect((await t.decide(taskId, plan)).status).toBe(200);
    expect(t.meta(taskId).workflow.blockReason).toBe("This plan's run limit is $150, which needs an admin's approval.");
  });

  it("says it asked only when a request was made, and names the decision in the request", async () => {
    const t = await world();
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, plan } = await t.planned("QUICK");
    const requestId = randomUUID();
    expect((await t.decide(taskId, plan, requestId)).status).toBe(200);
    expect(t.meta(taskId).workflow.blockReason).toBe("This plan's run limit is $20, which needs a project maintainer's approval. I've asked for it.");
    expect(t.requestRunLimit.mock.calls[0]![0]).toMatchObject({ requestId });
  });

  it("refuses the approval, and records nothing, when the request can't be made", async () => {
    const broken = vi.fn(async () => { throw new Error("the request store is down"); });
    const t = await world({ requestRunLimit: broken });
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const { taskId, plan } = await t.planned("QUICK");
    const before = t.meta(taskId).workflow;
    const approved = await t.decide(taskId, plan);
    expect(approved.status).toBeGreaterThanOrEqual(500);
    expect(t.meta(taskId).workflow).toEqual(before);
  });

  it("lets a project maintainer accept $20, but a $150 limit needs an admin", async () => {
    const t = await world();
    t.makeMaintainer();
    seedCosts(t.h.db, "QUICK", [10, 10, 10, 10, 10]);
    const twenty = await t.planned("QUICK");
    expect((await t.decide(twenty.taskId, twenty.plan)).status).toBe(200);
    expect(t.meta(twenty.taskId)).toMatchObject({ budgetUsd: 20 });
    expect(t.meta(twenty.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    seedCosts(t.h.db, "QUICK", [75, 75, 75, 75, 75], { offset: 100 });
    const big = await t.planned("QUICK");
    expect((await t.decide(big.taskId, big.plan)).status).toBe(200);
    expect(t.meta(big.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "This plan's run limit is $150, which needs an admin's approval. I've asked for it." });
    expect(t.requestRunLimit.mock.calls.at(-1)![0]).toMatchObject({ newLimitUsd: 150, approverRole: "org_admin" });
  });

  it("lets an org admin accept $150 directly, and a run with no max per run stops at the limit", async () => {
    const t = await world();
    t.setRole("admin");
    seedCosts(t.h.db, "QUICK", [75, 75, 75, 75, 75]);
    const { taskId, plan } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate).toMatchObject({ runLimitUsd: 150, stopAtUsd: 150 });
    expect((await t.decide(taskId, plan)).status).toBe(200);
    expect(t.meta(taskId)).toMatchObject({ budgetUsd: 150 });
    expect(t.meta(taskId).maxPerRunUsd).toBeUndefined();
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(t.requestRunLimit).not.toHaveBeenCalled();
  });

  it("leaves the limit alone when a requirements or design document is approved, and asks only for the coding plan's", async () => {
    const t = await world();
    const { taskId, workspaceId, plan } = await t.planned("FULL");
    expect(t.meta(taskId).budgetUsd).toBe(6);
    expect((await t.decide(taskId, plan)).status).toBe(200);
    expect(t.meta(taskId).budgetUsd).toBe(6);
    const design = await t.finishPlanning(taskId, workspaceId);
    expect((await t.decide(taskId, design)).status).toBe(200);
    expect(t.meta(taskId).budgetUsd).toBe(6);
    const coding = await t.finishPlanning(taskId, workspaceId);
    expect(t.meta(taskId).runEstimate).toMatchObject({ runLimitUsd: 20, basis: "default" });
    expect((await t.decide(taskId, coding)).status).toBe(200);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(t.meta(taskId).budgetUsd).toBe(6);
    expect(t.requestRunLimit).toHaveBeenCalledTimes(1);
  });

  it("does not accept a limit, or hold the approval, on an install without a model proxy", async () => {
    const t = await world({ proxy: false });
    const { taskId, workspaceId, plan } = await t.planned("FULL");
    expect((await t.decide(taskId, plan)).status).toBe(200);
    const design = await t.finishPlanning(taskId, workspaceId);
    expect((await t.decide(taskId, design)).status).toBe(200);
    const coding = await t.finishPlanning(taskId, workspaceId);
    expect((await t.decide(taskId, coding)).status).toBe(200);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(t.meta(taskId).budgetUsd).toBeUndefined();
  });

  it("refuses the approval, and starts nothing, when the proxy can't say what planning spent", async () => {
    const t = await world();
    const { taskId, workspaceId, plan } = await t.planned("QUICK");
    t.h.db.set({ ...t.meta(taskId), modelKeyIds: ["a".repeat(64)] });
    t.access!.goDown();
    const approved = await t.decide(taskId, plan);
    expect(approved.status).toBe(503);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(t.operations(workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
  });

  it("holds a request-changes decision to the same planning limit it had", async () => {
    const t = await world();
    const { taskId, plan } = await t.planned("QUICK");
    expect((await t.decide(taskId, plan, randomUUID(), "REQUEST_CHANGES")).status).toBe(200);
    expect(t.meta(taskId).budgetUsd).toBe(2);
    expect(t.requestRunLimit).not.toHaveBeenCalled();
  });
});

// ---- the cost of a finished run

describe("the cost of a run that finished", () => {
  /** A workflow task that merged, with the keys it spent on. */
  async function mergedTask(t: Awaited<ReturnType<typeof world>>, extra: Partial<DeveloperTaskRecord> = {}, path: "QUICK" | "FULL" = "QUICK") {
    const { taskId } = await t.planned(path);
    const record = t.meta(taskId);
    // The stage the merge sync leaves; `workflowTaskFinished` and `workflowEndOutcome` read only these three fields.
    t.h.db.set({ ...record, workflow: { ...record.workflow, stage: "MERGED", state: "COMPLETE", outcome: "MERGED" }, ...extra });
    return taskId;
  }
  const costsOf = (t: Awaited<ReturnType<typeof world>>) => t.h.db.find((item) => item.entityType === "RUN_COST");
  const release = (t: Awaited<ReturnType<typeof world>>, taskId: string) =>
    releaseFinishedTask({ tableName: "state", actions: t.h.actions, documentClient: t.h.db, ...(t.access === undefined ? {} : { modelAccess: t.access }) }, t.meta(taskId) as unknown as DeveloperTaskRecord);
  const keyOf = (name: string) => import("../../packages/broker/src/org/budget.js").then((module) => module.keyIdOf(name));

  it("writes what the task's keys spent when its pull request merged, under its project, agent and path", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a"), await keyOf("sk-b")] });
    t.access!.setKeySpent("sk-a", 2.5);
    t.access!.setKeySpent("sk-b", 4);
    await release(t, taskId);
    expect(costsOf(t)).toHaveLength(1);
    const item = costsOf(t)[0]!;
    expect(item).toMatchObject({ pk: `ORG#${TEST_ORG}#RUN_COST#payments#${ROVARA_CODE}#QUICK`, orgId: TEST_ORG, taskId, project: "payments", agentId: ROVARA_CODE, path: "QUICK", costUsd: 6.5 });
    expect(String(item.sk)).toMatch(new RegExp(`#${taskId}$`));
    // The next estimate reads it.
    seedCosts(t.h.db, "QUICK", [6.5, 6.5, 6.5, 6.5]);
    expect(await estimateOf(t.h.db, "QUICK")).toMatchObject({ samples: 5, highUsd: 6.5, basis: "history" });
  });

  it("dates the cost by the task's last change, not by the clock", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a")] });
    const merged = { ...t.meta(taskId).workflow, updatedAt: "2026-10-05T08:00:00.000Z" };
    t.h.db.set({ ...t.meta(taskId), workflow: merged });
    t.access!.setKeySpent("sk-a", 3);
    await release(t, taskId);
    expect(costsOf(t)[0]).toMatchObject({ endedAt: "2026-10-05T08:00:00.000Z" });
  });

  it("writes a Full task's cost under the Full path", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-f")] }, "FULL");
    t.access!.setKeySpent("sk-f", 9);
    await release(t, taskId);
    expect(costsOf(t)[0]).toMatchObject({ path: "FULL", costUsd: 9 });
  });

  it("writes it once, however often the task is released", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a")] });
    t.access!.setKeySpent("sk-a", 3);
    await release(t, taskId);
    t.access!.setKeySpent("sk-a", 7);
    await release(t, taskId);
    expect(costsOf(t)).toHaveLength(1);
    expect(costsOf(t)[0]).toMatchObject({ costUsd: 3 });
    expect(t.meta(taskId).runCostRecordedAt).toBeDefined();
  });

  it("writes nothing for a run that spent nothing, a rejected plan, or a run that failed", async () => {
    const t = await world();
    const none = await mergedTask(t);
    await release(t, none);
    const rejected = (await t.planned("QUICK")).taskId;
    const record = t.meta(rejected);
    t.h.db.set({ ...record, modelKeyIds: [await keyOf("sk-r")], workflow: { ...record.workflow, stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" } });
    t.access!.setKeySpent("sk-r", 3);
    await release(t, rejected);
    expect(costsOf(t)).toEqual([]);
  });

  it("writes an agent-step run's cost under the AGENT path when it completed, and nothing when it failed or was cancelled", async () => {
    const t = await world();
    const make = async (state: "COMPLETE" | "FAILED" | "CANCELLED", key: string) => {
      const { taskId } = await t.startTask();
      t.h.db.set({
        ...t.meta(taskId), modelKeyIds: [await keyOf(key)], agentRunEnd: { state, at: "2026-10-22T10:00:00.000Z" },
        agent: { agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Ticket looker", version: 1, builtin: false, digest: "d".repeat(64) },
      });
      t.access!.setKeySpent(key, 1.5);
      await release(t, taskId);
      return taskId;
    };
    const done = await make("COMPLETE", "sk-done");
    await make("FAILED", "sk-failed");
    await make("CANCELLED", "sk-cancelled");
    expect(costsOf(t)).toHaveLength(1);
    expect(costsOf(t)[0]).toMatchObject({ taskId: done, agentId: "agt_aaaaaaaaaaaaaaaaaaaa", path: "AGENT", costUsd: 1.5, endedAt: "2026-10-22T10:00:00.000Z" });
  });

  it("does not fail the release, and writes again on the next one, when the proxy can't say", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a")] });
    t.access!.setKeySpent("sk-a", 3);
    t.access!.keySpend.mockRejectedValueOnce(new Error("proxy down"));
    await expect(release(t, taskId)).resolves.toBeDefined();
    expect(costsOf(t)).toEqual([]);
    await release(t, taskId);
    expect(costsOf(t)).toHaveLength(1);
  });

  it("writes nothing on an install without a model proxy", async () => {
    const t = await world({ proxy: false });
    const taskId = await mergedTask(t, { modelKeyIds: ["a".repeat(64)] });
    await release(t, taskId);
    expect(costsOf(t)).toEqual([]);
  });

  it("writes the item and the task's mark in one transaction, and never twice for one task", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a")] });
    t.access!.setKeySpent("sk-a", 3);
    const task = t.meta(taskId) as unknown as DeveloperTaskRecord;
    const args = { path: "QUICK" as const, endedAt: "2026-10-22T10:00:00.000Z" };
    const dependencies = { documentClient: t.h.db, tableName: "state", modelAccess: t.access! };
    expect(await recordRunCost(dependencies, task, args)).toBe("recorded");
    expect(await recordRunCost(dependencies, task, args)).toBe("already_recorded");
    expect(costsOf(t)).toHaveLength(1);
    expect(t.meta(taskId).runCostRecordedAt).toBe("2026-10-22T10:00:00.000Z");
  });

  it("keeps each org's runs to itself", async () => {
    const t = await world();
    const taskId = await mergedTask(t, { modelKeyIds: [await keyOf("sk-a")] });
    t.access!.setKeySpent("sk-a", 3);
    await release(t, taskId);
    expect(costsOf(t)[0]!.pk).toBe(`ORG#${TEST_ORG}#RUN_COST#payments#${ROVARA_CODE}#QUICK`);
    expect(await estimateOf(t.h.db, "QUICK", { org: ORG_B })).toMatchObject({ samples: 0 });
  });
});
