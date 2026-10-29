// Follow-up M1: raising a process layer's step time or spending limit (or taking the spending limit away) waits for a second person; lowering either is an ordinary publish; an ordinary
// agent is judged as before.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, type AgentId, type OrgRole } from "../../packages/contracts/src/index.js";
import { decideApproval } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { MAX, OLA, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { agentXError } from "../../packages/contracts/src/index.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
type Steps = Record<string, { timeoutMinutes?: number | null; stepBudgetUsd?: number | null }>;
async function setDraft(w: MergeWorld, agentId: AgentId, steps: Steps) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps }, expectedRevision: agent.draftRevision, by: MAX });
}
const publish = async (w: MergeWorld, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
const layerWith = async (w: MergeWorld, steps: Steps): Promise<AgentId> => {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  await setDraft(w, agentId, steps);
  expect(await publish(w, agentId)).toMatchObject({ applied: true });
  return agentId;
};
const approvalIdOf = (w: MergeWorld, result: { applied: boolean }) => w.approvalIdOf((result as unknown as { confirmUrl: string }).confirmUrl);

describe("a process layer's raise of a step's time or spending limit", () => {
  it("a raised timeout waits for a second person; the requester cannot confirm it; another approver can", async () => {
    const w = world();
    const layer = await layerWith(w, { build: { timeoutMinutes: 30 } });
    await setDraft(w, layer, { build: { timeoutMinutes: 90 } });
    const waiting = await publish(w, layer);
    expect(waiting).toMatchObject({ applied: false, changes: ['Raises the time the step "Build" may run, from 30 to 90 minutes'] });
    await expect(decideApproval(w.deps, callerOf(w, MAX), approvalIdOf(w, waiting), { requestId: randomUUID(), decision: "APPROVE" })).rejects.toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
    await decideApproval(w.deps, callerOf(w, OLA), approvalIdOf(w, waiting), { requestId: randomUUID(), decision: "APPROVE" });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
  });

  it("a lowered timeout publishes at once", async () => {
    const w = world();
    const layer = await layerWith(w, { build: { timeoutMinutes: 30 } });
    await setDraft(w, layer, { build: { timeoutMinutes: 90 } });
    await decideApproval(w.deps, callerOf(w, OLA), approvalIdOf(w, await publish(w, layer)), { requestId: randomUUID(), decision: "APPROVE" });
    await setDraft(w, layer, { build: { timeoutMinutes: 45 } });
    expect(await publish(w, layer)).toMatchObject({ applied: true, value: { version: 3 } });
  });

  it("a first version that sets a time above Rovara's default waits too (it is judged against the process it builds on)", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    await setDraft(w, agentId, { build: { timeoutMinutes: 90 } });
    expect(await publish(w, agentId)).toMatchObject({ applied: false });
  });

  it("a raised step budget waits; a step budget taken away waits; a lowered one publishes", async () => {
    const w = world();
    const layer = await layerWith(w, { build: { stepBudgetUsd: 5 } });
    await setDraft(w, layer, { build: { stepBudgetUsd: 8 } });
    expect(await publish(w, layer)).toMatchObject({ applied: false, changes: ['Raises the spending limit of the step "Build", from $5 to $8'] });
    await setDraft(w, layer, { build: { stepBudgetUsd: null } });
    expect(await publish(w, layer)).toMatchObject({ applied: false, changes: ['Removes the spending limit of the step "Build"'] });
    await setDraft(w, layer, { build: { stepBudgetUsd: 2 } });
    expect(await publish(w, layer)).toMatchObject({ applied: true, value: { version: 2 } });
  });

  it("taking away a time limit of 60 minutes or more waits too (an unset step time means no limit); an ordinary agent's does not", async () => {
    const w = world();
    const layer = await layerWith(w, { build: { timeoutMinutes: 30 } });
    await setDraft(w, layer, { build: { timeoutMinutes: 200 } });
    await decideApproval(w.deps, callerOf(w, OLA), approvalIdOf(w, await publish(w, layer)), { requestId: randomUUID(), decision: "APPROVE" });
    await setDraft(w, layer, { build: { timeoutMinutes: null } });
    expect(await publish(w, layer)).toMatchObject({ applied: false, changes: ['Removes the time limit of the step "Build"'] });

    const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    await setDraft(w, created.agentId, { build: { timeoutMinutes: 200 } });
    expect(await publish(w, created.agentId)).toMatchObject({ applied: true });
    await setDraft(w, created.agentId, { build: { timeoutMinutes: null } });
    expect(await publish(w, created.agentId)).toMatchObject({ applied: true, value: { version: 2 } });
  });

  it("an ordinary agent raising the same limits publishes at once", async () => {
    const w = world();
    const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    await setDraft(w, created.agentId, { build: { timeoutMinutes: 30, stepBudgetUsd: 5 } });
    expect(await publish(w, created.agentId)).toMatchObject({ applied: true });
    await setDraft(w, created.agentId, { build: { timeoutMinutes: 200, stepBudgetUsd: 50 } });
    expect(await publish(w, created.agentId)).toMatchObject({ applied: true, value: { version: 2 } });
  });
});
