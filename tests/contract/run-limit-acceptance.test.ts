// Plan 3 final fix wave (owner decision 3, option E): who can accept a run limit when a plan is approved.
//   - the member pays: as it always was (up to the lead threshold; a maintainer up to the admin threshold; an admin any amount);
//   - the project pays: the member who approves accepts up to the project's `memberAcceptRunLimitUpToUsd` (default $10, read live); above it a `run_limit`
//     request goes to the project's maintainers, with "Waiting for a project maintainer to accept the $N run limit.";
//   - an agent's owner pays: a run limit within the agent's max per run is accepted automatically; above it the request goes to the agent's owner (or, when
//     the owner is gone, to its managers, else the org's admins), whoever approved the plan.
// Task 32's rule holds on every path: the person who asked cannot decide their own request unless they are the org's only owner or admin.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptRunLimit } from "../../packages/broker/src/spend/estimate.js";
import { applyProjectAiChange, readProjectAi, writeProjectAi, writeSpendPolicy } from "../../packages/broker/src/spend/settings.js";
import { RUN_LIMIT_BLOCK_PREFIX, defaultSpendPolicy, isRunLimitBlockReason } from "../../packages/contracts/src/spend.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { OrgRole } from "../../packages/contracts/src/org.js";
import type { ProjectRole } from "../../packages/contracts/src/app-projects.js";
import { createSpendRequest, decideSpendRequest, spendApprovers } from "../../packages/broker/src/spend/requests.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ADA, BEN, DEB, TRIAGE, refusal, setup } from "../support/spend-world.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", cloud: true, now: Date.now });

/** A plan whose run limit is `limit`, paid by `payer`. */
const task = (limit: number, extra: Partial<DeveloperTaskRecord> = {}): DeveloperTaskRecord => ({
  taskId: TASK_ID, orgId: TEST_ORG, project: "payments", budgetUsd: 2,
  runEstimate: { lowUsd: 1, highUsd: limit / 2, runLimitUsd: limit, stopAtUsd: limit, basis: "history", samples: 6 }, ...extra,
} as DeveloperTaskRecord);

async function accepting(options: { role?: ProjectRole; setting?: number; policy?: Partial<ReturnType<typeof defaultSpendPolicy>> } = {}) {
  const db = new FakeDynamoDb();
  const members = new FakeProjectMembers();
  members.addProject(TEST_ORG, "payments");
  if (options.role !== undefined) members.grant(TEST_ORG, "payments", "dev", options.role);
  if (options.policy !== undefined) await writeSpendPolicy(deps(db), TEST_ORG, { ...defaultSpendPolicy(), ...options.policy }, "admin");
  const setSetting = async (value: number | null) => {
    const current = await readProjectAi(deps(db), TEST_ORG, "payments");
    await writeProjectAi(deps(db), TEST_ORG, "payments", applyProjectAiChange(current, { memberAcceptRunLimitUpToUsd: value }), "admin");
  };
  if (options.setting !== undefined) await setSetting(options.setting);
  const accept = (orgRole: OrgRole, record: DeveloperTaskRecord) => acceptRunLimit({ ...deps(db), projectMembers: members }, { task: record, approver: { developerId: "dev", orgRole } });
  return { db, accept, setSetting };
}
const memberPays = (limit: number) => task(limit, { payer: { kind: "member", developerId: "dev" } } as never);
const projectPays = (limit: number) => task(limit, { payer: { kind: "project", project: "payments" } } as never);
const agentPays = (limit: number, maxPerRunUsd?: number) => task(limit, { payer: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa" }, ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }) } as never);

describe("the member pays: no change", () => {
  it("accepts up to the lead threshold, at it and over it", async () => {
    const { accept } = await accepting();
    expect(await accept("member", memberPays(9))).toMatchObject({ accepted: true });
    expect(await accept("member", memberPays(10))).toMatchObject({ accepted: true });
    expect(await accept("member", memberPays(11))).toMatchObject({ accepted: false, needs: "maintainer", message: "This plan's run limit is $11, which needs a project maintainer's approval. I've asked for it." });
  });
  it("is not changed by the project's setting", async () => {
    const { accept } = await accepting({ setting: 50 });
    expect(await accept("member", memberPays(11))).toMatchObject({ accepted: false });
  });
});

describe("the project pays", () => {
  it("defaults to $10: at it a member accepts, over it the request goes to the maintainers in the exact words (today's behaviour at the default)", async () => {
    const { accept } = await accepting();
    expect(await accept("member", projectPays(9))).toMatchObject({ accepted: true });
    expect(await accept("member", projectPays(10))).toMatchObject({ accepted: true });
    expect(await accept("member", projectPays(11))).toMatchObject({
      accepted: false, needs: "maintainer", approverRole: "project_maintainer", message: "Waiting for a project maintainer to accept the $11 run limit.",
    });
  });

  it("follows the project's setting, read now: raised, lowered and cleared", async () => {
    const { accept, setSetting } = await accepting({ setting: 25 });
    expect(await accept("member", projectPays(25))).toMatchObject({ accepted: true });
    expect(await accept("member", projectPays(26))).toMatchObject({ accepted: false, needs: "maintainer" });
    await setSetting(5);
    expect(await accept("member", projectPays(5))).toMatchObject({ accepted: true });
    expect(await accept("member", projectPays(6))).toMatchObject({ accepted: false });
    await setSetting(0);
    expect(await accept("member", projectPays(1))).toMatchObject({ accepted: false });
    await setSetting(null);
    expect(await accept("member", projectPays(10))).toMatchObject({ accepted: true });
    expect(await accept("member", projectPays(11))).toMatchObject({ accepted: false });
  });

  it("does not lower what a maintainer or an org admin may accept, and over the admin threshold still needs an admin", async () => {
    const maintainer = await accepting({ role: "maintainer", setting: 5 });
    expect(await maintainer.accept("member", projectPays(60))).toMatchObject({ accepted: true });
    expect(await maintainer.accept("member", projectPays(150))).toMatchObject({ accepted: false, needs: "admin", message: "This plan's run limit is $150, which needs an admin's approval. I've asked for it." });
    expect(await maintainer.accept("admin", projectPays(150))).toMatchObject({ accepted: true });
    const member = await accepting({ setting: 200 });
    expect(await member.accept("member", projectPays(150))).toMatchObject({ accepted: true });
  });

  it("the new words are a run limit block like the old ones", () => {
    expect(isRunLimitBlockReason("Waiting for a project maintainer to accept the $11 run limit.")).toBe(true);
    expect(isRunLimitBlockReason("Waiting for the agent's owner to accept the $11 run limit.")).toBe(true);
    expect(isRunLimitBlockReason(`${RUN_LIMIT_BLOCK_PREFIX}20, which needs an admin's approval.`)).toBe(true);
    expect(isRunLimitBlockReason("coding stopped")).toBe(false);
    expect(isRunLimitBlockReason(undefined)).toBe(false);
  });
});

describe("an agent's owner pays", () => {
  it("accepts a run limit within the agent's max per run automatically, at it and under it, whoever approves", async () => {
    const { accept } = await accepting();
    expect(await accept("member", agentPays(8, 8))).toMatchObject({ accepted: true });
    expect(await accept("member", agentPays(3, 8))).toMatchObject({ accepted: true });
  });

  it("over the max per run the request goes to the agent's owner, even when an org admin or a maintainer approved the plan", async () => {
    const { accept } = await accepting({ role: "maintainer" });
    for (const role of ["member", "admin", "owner"] as const) {
      expect(await accept(role, agentPays(9, 8)), role).toMatchObject({ accepted: false, approverRole: "agent_owner", message: "Waiting for the agent's owner to accept the $9 run limit." });
    }
  });

  it("an agent with no max per run keeps the tiers it always had", async () => {
    const { accept } = await accepting();
    expect(await accept("member", agentPays(8))).toMatchObject({ accepted: true });
    expect(await accept("member", agentPays(11))).toMatchObject({ accepted: false, needs: "maintainer" });
  });
});

describe("who is asked, and who may decide, on each path", () => {
  const asRequest = (taskId: string, limit: number, who = BEN) => ({
    orgId: TEST_ORG, kind: "run_limit" as const, taskId, amountUsd: limit - 2, newLimitUsd: limit, scope: { kind: "task" as const, taskId }, requestedBy: { kind: "member" as const, developerId: who.developerId },
    requestedFor: { developerId: who.developerId }, resume: "implement" as const,
  });

  it("an agent-paid run limit goes to the agent's owner at any size, not by the thresholds", async () => {
    const t = await setup();
    const agentId = await t.agentOf(TRIAGE, { by: MAYA, name: "Looker" });
    expect((await t.setBudget(MAYA, agentId, { maxPerRunUsd: 8 })).status).toBe(200);
    await t.shareWith(agentId, BEN);
    const run = await t.runOf(agentId, { who: BEN });
    await t.set(run.taskId, "SET payer = :payer", { ":payer": { kind: "agent", agentId } });
    for (const limit of [9, 40, 400]) {
      const approvers = await spendApprovers(t.deps(), asRequest(run.taskId, limit) as never);
      expect(approvers, String(limit)).toMatchObject({ role: "agent_owner", ids: [MAYA.developerId] });
    }
  });

  it("falls to the agent's managers when its owner is gone: the owning project's maintainers, or for a member's agent the org's admins who hold manage on it", async () => {
    const t = await setup();
    const mine = await t.agentOf(TRIAGE, { by: MAYA, name: "Looker" });
    const run = await t.runOf(mine, { who: MAYA });
    await t.set(run.taskId, "SET payer = :payer", { ":payer": { kind: "agent", agentId: mine } });
    // Maya has left the organization: nobody of the owner's list is a member any more.
    t.db.delete({ pk: `ORG#${TEST_ORG}`, sk: `MEMBER#${MAYA.developerId}` } as never);
    const admins = await spendApprovers(t.deps(), asRequest(run.taskId, 40, MAYA) as never);
    expect(admins).toMatchObject({ role: "org_admin" });
    expect([...admins.ids].sort()).toEqual([ADA.developerId, DEB.developerId].sort());
    const shared = await t.agentOf(TRIAGE, { by: BEN, name: "Shared looker", owner: { kind: "project", project: "payments" }, accountable: BEN });
    const second = await t.runOf(shared, { who: BEN });
    await t.set(second.taskId, "SET payer = :payer", { ":payer": { kind: "agent", agentId: shared } });
    expect(await spendApprovers(t.deps(), asRequest(second.taskId, 40, MAYA) as never)).toMatchObject({ role: "agent_owner", ids: [BEN.developerId] });
  });

  it("the person who asked cannot decide their own request, except as the org's only owner or admin (Task 32's rule)", async () => {
    const t = await setup({ secondAdmin: false });
    const agentId = await t.agentOf(TRIAGE, { by: ADA, name: "Looker" });
    const run = await t.runOf(agentId, { who: ADA });
    await t.set(run.taskId, "SET payer = :payer", { ":payer": { kind: "agent", agentId } });
    const made = await createSpendRequest(t.deps(), {
      orgId: TEST_ORG, kind: "run_limit", taskId: run.taskId, scope: { kind: "task", taskId: run.taskId }, amountUsd: 38, newLimitUsd: 40, reason: "Approving this plan sets a run limit of $40.",
      requestedBy: { kind: "member", developerId: ADA.developerId }, requestedFor: { developerId: ADA.developerId }, resume: "continue", subject: `TASK#${run.taskId}#E`,
    });
    // Ada owns the agent and asked, and is also the only owner or admin: she may decide it.
    expect(made.approvers.ids).toEqual([ADA.developerId]);
    await t.decide(ADA, made.record.spendRequestId);
    // With another admin, the same person asking cannot decide their own request.
    const t2 = await setup();
    const agent2 = await t2.agentOf(TRIAGE, { by: MAYA, name: "Looker" });
    const run2 = await t2.runOf(agent2, { who: MAYA });
    await t2.set(run2.taskId, "SET payer = :payer", { ":payer": { kind: "agent", agentId: agent2 } });
    const own = await createSpendRequest(t2.deps(), {
      orgId: TEST_ORG, kind: "run_limit", taskId: run2.taskId, scope: { kind: "task", taskId: run2.taskId }, amountUsd: 38, newLimitUsd: 40, reason: "Approving this plan sets a run limit of $40.",
      requestedBy: { kind: "member", developerId: MAYA.developerId }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", subject: `TASK#${run2.taskId}#E`,
    });
    expect(await refusal(t2.decide(MAYA, own.record.spendRequestId))).toMatchObject({ code: "FORBIDDEN" });
    // The org's other admins are asked instead.
    expect(await refusal(decideSpendRequest(t2.deps(), t2.caller(DEB, "admin"), own.record.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }))).toBeUndefined();
  });
});
