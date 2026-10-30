import * as spendRequests from "../../packages/broker/src/spend/requests.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { operationKey } from "../../packages/broker/src/aws/cancellation.js";
import { checkedTaskStopSnapshot } from "../../packages/broker/src/org/task-stop-window.js";
import { spendRequestView, createSpendRequest, escalateOwnerRequests } from "../../packages/broker/src/spend/requests.js";
import { AppNoteSchema } from "../../packages/contracts/src/task-workflow-node.js";
import { SLACK_CHANNEL, SLACK_TEAM, call } from "../support/slack-broker.js";
import { startAgentRun } from "../../packages/broker/src/agents/runs.js";
import { fixtureProject } from "../support/project-ai-source.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactWriteCommand, TransactGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { topUpKey, defaultSpendPolicy, ownerBudgetKey, runCostKey, DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, builtinSettingsKey, orgSettingsKey, orgScoped, projectAiKey, orgProjectCatalogKey, orgMemberKey, developerOrgKey, orgMetaKey, projectMetaKey, projectMemberKey, agentKey, projectRevisionKey, projectAgentKey } from "@agentx/contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { setup, PREPARED, CODING, TRIAGE, BEN, DEB, ADA } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
async function fixture(amount = 1_234_567, options?: Parameters<typeof setup>[0]) {
  const t = await setup(options), policy = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY"), project = projectAiKey(TEST_ORG, "payments"), agent = builtinSettingsKey(TEST_ORG, ROVARA_CODE_AGENT_ID);
  t.db.set({ ...policy, entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: amount } }, enrollment: { version: 1, state: "enabled" } });
  t.db.set({ pk: orgScoped(TEST_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap", orgId: TEST_ORG, entityType: "TASK_STOP_SEED", version: 1, source: "bootstrap", outcome: "created", policyRevision: 1 });
  t.db.set({ ...agentGuardrailsKey(TEST_ORG), orgId: TEST_ORG, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 1 } });
  t.db.set({ projectPays: false, ...t.db.get(project), ...project, orgId: TEST_ORG, entityType: "PROJECT_AI", project: "payments", revision: 1, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 100_000_000 } });
  const catalog = orgProjectCatalogKey(TEST_ORG, "payments");
  t.db.set({ ...t.db.get(catalog), ...catalog, orgId: TEST_ORG, entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1 });
  t.db.set({ ...t.db.get(agent), ...agent, orgId: TEST_ORG, entityType: "BUILTIN_AGENT_SETTINGS", agentId: ROVARA_CODE_AGENT_ID, revision: 1, stopKind: "inherit", pinnedVersion: t.deps().store.builtinDefaultPin(ROVARA_CODE_AGENT_ID), updatedBy: MAYA.developerId, updatedAt: new Date().toISOString() });
  const request = { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "claude-code" };
  const start = () => t.dev(MAYA, "POST", "/v1/dev/tasks", request);
  return { t, policy, project, agent, request, start };
}
it("a paid task commits the exact company stop into existing budgetUsd with its captured envelope", async () => {
  const f = await fixture(), reply = await f.start(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const task = reply.body.task as { taskId: string }, stored = f.t.db.get(`DEVTASK#${task.taskId}`, "META");
  expect(stored).toMatchObject({ budgetUsd: 1.234567, spendingStop: { schemaVersion: 2, effectiveStopMicrousd: 1_234_567, approvalCapMicrousd: 1_000_000 } });
});
it("initial paid admission commits an immutable window receipt and task reference", async () => {
  const f = await fixture(), reply = await f.start(); expect(reply.status).toBe(200);
  const taskId = (reply.body.task as { taskId: string }).taskId, task = f.t.meta(taskId);
  const reference = task.spendingAdmission as { requestId: string; actorId: string; intentHash: string } | undefined;
  expect(reference).toMatchObject({ requestId: f.request.requestId, actorId: MAYA.developerId });
  expect(typeof reference?.intentHash).toBe("string");
  const receipt = f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${taskId}`), sk: `REQUEST#${f.request.requestId}` });
  expect(receipt).toMatchObject({ entityType: "SPENDING_ADMISSION", outcome: "accepted", workId: taskId,
    requestId: f.request.requestId, actorId: MAYA.developerId, intentHash: reference?.intentHash,
    spendingStop: task.spendingStop, budgetBaselineUsd: 0 });
  expect(typeof receipt?.operationId).toBe("string");
});
for (const failure of ["zero", "missing_project", "deleted_policy"] as const) it(`refuses enrolled paid start ${failure} before any workspace is created`, async () => {
  const f = await fixture(failure === "zero" ? 0 : 1_234_567);
  if (failure === "missing_project") f.t.db.delete(f.project);
  if (failure === "deleted_policy") f.t.db.delete(f.policy);
  const reply = await f.start(); expect(reply.status).toBe(409);
  expect(reply.body.error).toMatchObject({ code: failure === "zero" ? "TASK_STOP_ZERO" : "TASK_STOP_CONFIG_MISSING" });
  if (failure === "zero") expect(reply.body.error).toMatchObject({ message: "Work can't start: the effective spending stop is $0." });
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
});
it("a retry returns its committed stop after policy tightening instead of recapturing", async () => {
  const f = await fixture(), first = await f.start(); expect(first.status).toBe(200);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } } });
  const again = await f.start(); expect(again.status).toBe(200);
  expect(again.body.task).toMatchObject({ taskId: (first.body.task as { taskId: string }).taskId });
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toEqual([expect.objectContaining({ budgetUsd: 1.234567 })]);
});
it("numeric edits after capture affect the next admission and do not recalculate the accepted one", async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let edited = false;
  f.t.db.send = async command => {
    if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      edited = true; f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2_000_000 } } });
    }
    return send(command);
  };
  expect((await f.start()).status).toBe(200); expect(edited).toBe(true);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toEqual([expect.objectContaining({ budgetUsd: 1.234567 })]);
  f.request.requestId = randomUUID(); expect((await f.start()).status).toBe(200);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK").map(row => row.budgetUsd).sort()).toEqual([1.234567, 2]);
});

for (const loss of ["member", "pointer", "closing"] as const) it(`enrolled paid start fences ${loss} loss at its native commit`, async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true;
      if (loss === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      else if (loss === "pointer") f.t.db.delete(developerOrgKey(MAYA.developerId));
      else f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
    }
    return send(command);
  };
  const reply = await f.start(); expect(changed).toBe(true); expect(reply.status).toBe(403);
  expect(reply.body.error).toMatchObject({ code: "FORBIDDEN" });
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
});

for (const loss of ["project_archive", "project_viewer"] as const) it(`enrolled paid start fences ${loss} at its native commit`, async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let changed = false;
  const grant = projectMemberKey(TEST_ORG, MAYA.developerId, "payments");
  f.t.db.set({ ...grant, entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true;
      if (loss === "project_archive") f.t.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", archivedAt: new Date().toISOString() });
      else f.t.db.set({ ...f.t.db.get(grant)!, role: "viewer", projectRole: "viewer", grantId: randomUUID() });
    }
    return send(command);
  };
  const reply = await f.start(); expect(changed).toBe(true); expect(reply.status).toBe(403);
  expect(reply.body.error).toMatchObject({ code: "FORBIDDEN" });
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
});
it("enrolled paid start refuses a corrupt project identity without work", async () => {
  const f = await fixture();
  f.t.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "another-project", status: "active" });
  const reply = await f.start(); expect(reply.status).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
});
it("enrolled paid start fences archive/restore ABA even when active status is unchanged", async () => {
  const f = await fixture(), key = projectMetaKey(TEST_ORG, "payments"), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.set({ ...key, entityType: "PROJECT_META", name: "payments", status: "active", archiveRevision: 1 });
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true; f.t.db.set({ ...f.t.db.get(key)!, archiveRevision: 3 });
    }
    return send(command);
  };
  const reply = await f.start(); expect(changed).toBe(true); expect(reply.status).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
});
it("a project-stop numeric edit after capture does not invalidate the accepted payer binding", async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let edited = false;
  f.t.db.send = async command => {
    if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      edited = true; f.t.db.set({ ...f.t.db.get(f.project)!, revision: 2, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 500_000 } });
    }
    return send(command);
  };
  const first = await f.start(); expect(edited).toBe(true); expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toEqual([expect.objectContaining({ budgetUsd: 1.234567 })]);
  f.request.requestId = randomUUID(); expect((await f.start()).status).toBe(200);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK").map(row => row.budgetUsd).sort()).toEqual([0.5, 1.234567]);
});
it("a real project payer change after capture still refuses atomically", async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let edited = false;
  f.t.db.send = async command => {
    if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      edited = true; f.t.db.set({ ...f.t.db.get(f.project)!, revision: 2, projectPays: true });
    }
    return send(command);
  };
  const reply = await f.start(); expect(edited).toBe(true); expect(reply.status).toBe(409);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});

async function customStart() {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer");
  const agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const request = { ...f.request, agent: { agentId } };
  return { ...f, agentId, key, startCustom: () => f.t.dev(MAYA, "POST", "/v1/dev/tasks", request) };
}
it("a legitimate published custom agent can start under the captured company stop", async () => {
  const f = await customStart(), reply = await f.startCustom(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const tasks = f.t.db.find(row => row.entityType === "DEVELOPER_TASK"); expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ budgetUsd: 1.234567, agent: { agentId: f.agentId } });
});
for (const loss of ["archive", "roster", "owner"] as const) it(`paid custom-agent start refuses a real competing ${loss} write at commit`, async () => {
  const f = await customStart(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true;
      const reply = loss === "archive" ? await f.t.api(MAYA, "POST", `/v1/app/agents/${f.agentId}/archive`, {})
        : loss === "roster" ? await f.t.api(MAYA, "DELETE", `/v1/app/projects/payments/agents/${f.agentId}`, {})
          : await f.t.api(ADA, "PUT", `/v1/app/agents/${f.agentId}/owner`, { owner: { kind: "member", developerId: DEB.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    }
    return send(command);
  };
  const reply = await f.startCustom(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});

it("an agent per-run numeric edit after capture affects only the next admission", async () => {
  const f = await customStart(), send = f.t.db.send.bind(f.t.db); let edited = false;
  f.t.db.send = async command => {
    if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      edited = true; const saved = await f.t.api(MAYA, "PUT", `/v1/app/agents/${f.agentId}/budget`, { maxPerRunUsd: 0.5 });
      expect(saved.status).toBe(200);
    }
    return send(command);
  };
  const first = await f.startCustom(); expect(first.status, JSON.stringify(first.body)).toBe(200); expect(edited).toBe(true);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toEqual([expect.objectContaining({ budgetUsd: 1.234567 })]);
  const next = await f.t.dev(MAYA, "POST", "/v1/dev/tasks", { ...f.request, requestId: randomUUID(), agent: { agentId: f.agentId } });
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK").map(row => row.budgetUsd).sort()).toEqual([0.5, 1.234567]);
});
for (const loss of ["settings_missing", "disabled"] as const) it(`paid builtin start refuses ${loss} at native commit`, async () => {
  const f = await fixture(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true;
      if (loss === "settings_missing") f.t.db.delete(f.agent);
      else {
        const row = f.t.db.get(agentGuardrailsKey(TEST_ORG))!;
        const saved = await f.t.api(ADA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: row.revision, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 1, disabledBuiltins: [ROVARA_CODE_AGENT_ID] } });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      }
    }
    return send(command);
  };
  const reply = await f.start(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});

async function otherProjectAgent() {
  const f = await fixture(), project = "platform", grant = projectMemberKey(TEST_ORG, MAYA.developerId, project);
  fixtureProject(f.t.db, TEST_ORG, project);
  const revision = projectRevisionKey(TEST_ORG, project, 1);
  f.t.db.set({ ...f.t.db.get(revision)!, ...revision, entityType: "PROJECT", orgId: TEST_ORG });
  f.t.db.set({ ...orgProjectCatalogKey(TEST_ORG, project), entityType: "PROJECT_CATALOG", orgId: TEST_ORG, name: project, latestRevision: 1 });
  f.t.db.set({ ...grant, entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: project, grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
  const agentId = await f.t.agentOf(CODING, { owner: { kind: "project", project }, accountable: ADA }), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  return { ...f, grant, agentId, key, startOther: () => f.t.dev(MAYA, "POST", "/v1/dev/tasks", { ...f.request, agent: { agentId } }) };
}
it("a legitimate agent owned by another project can start with live use authority", async () => {
  const f = await otherProjectAgent(), reply = await f.startOther(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
});
it("paid start fences a real use-grant loss in the agent's owning project", async () => {
  const f = await otherProjectAgent(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true; const saved = await f.t.api(ADA, "PUT", `/v1/app/projects/platform/members/${MAYA.developerId}`, { role: "viewer" });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    return send(command);
  };
  const reply = await f.startOther(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});
async function sharedProjectAgent() {
  const f = await otherProjectAgent();
  expect((await f.t.api(ADA, "PUT", `/v1/app/agents/${f.agentId}/owner`, { owner: { kind: "member", developerId: DEB.developerId } })).status).toBe(200);
  expect((await f.t.api(ADA, "PUT", `/v1/app/agents/${f.agentId}/shares`, { shares: [{ principal: { kind: "project", project: "platform" }, level: "use" }] })).status).toBe(200);
  return f;
}
it("a legitimate project-shared agent can start with live visibility", async () => {
  const f = await sharedProjectAgent(), reply = await f.startOther(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
});
for (const loss of ["share_removed", "shared_project_viewer"] as const) it(`paid start fences real ${loss} authority loss`, async () => {
  const f = await sharedProjectAgent(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK")) {
      changed = true;
      const saved = loss === "share_removed" ? await f.t.api(ADA, "PUT", `/v1/app/agents/${f.agentId}/shares`, { shares: [] })
        : await f.t.api(ADA, "PUT", `/v1/app/projects/platform/members/${MAYA.developerId}`, { role: "viewer" });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    return send(command);
  };
  const reply = await f.startOther(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});

async function draftStart() {
  const f = await fixture(), agentId = await f.t.agentOf(CODING, { publish: false }), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  f.t.db.delete(projectAgentKey(TEST_ORG, "payments", agentId)); // a draft test run is legitimately off-roster
  return { ...f, agentId, key, startDraft: () => f.t.api(MAYA, "POST", `/v1/app/agents/${agentId}/runs`, { project: "payments", input: { text: "Test the draft" }, version: "draft" }) };
}
it("a legitimate off-roster draft starts with its frozen draft revision and captured stop", async () => {
  const f = await draftStart(), reply = await f.startDraft(); expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const tasks = f.t.db.find(row => row.entityType === "DEVELOPER_TASK"); expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ budgetUsd: 1.234567, origin: "test_run", agent: { agentId: f.agentId, version: "draft", draftRevision: 1 } });
});
for (const phase of ["before_policy_capture", "at_native_commit"] as const) it(`paid draft start refuses a real draft edit ${phase}`, async () => {
  const f = await draftStart(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    const target = phase === "before_policy_capture" ? command instanceof TransactGetCommand
      : command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "DEVELOPER_TASK");
    if (!changed && target) {
      changed = true; const draft = await f.t.store.getDraft(TEST_ORG, f.agentId); expect(draft).toBeDefined();
      const saved = await f.t.api(MAYA, "PUT", `/v1/app/agents/${f.agentId}/draft`, { expectedRevision: draft!.revision, overlay: { ...CODING, instructions: "A newly edited draft." } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    return send(command);
  };
  const reply = await f.startDraft(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(f.t.db.find(row => row.entityType === "WORKSPACE")).toHaveLength(0);
});
async function continueWindow(enrolled = true) {
  const f = await fixture();
  if (!enrolled) f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const task = await f.t.plainTask();
  await f.t.finish(task.workspaceId, task.operationId, "SUCCEEDED");
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 500_000 } } });
  const request = { requestId: randomUUID(), instructions: "Continue the accepted task." };
  const receipt = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${request.requestId}` };
  return { ...f, task, request, receipt, continue: () => f.t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, request) };
}
it("Continue opens a newly captured exact window and commits its receipt with the operation", async () => {
  const f = await continueWindow(), reply = await f.continue(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 0.5, spendingStop: { effectiveStopMicrousd: 500_000 }, budgetBaselineUsd: 0 });
  expect(f.t.meta(f.task.taskId)).toMatchObject({ spendingAdmission: { requestId: f.request.requestId, actorId: MAYA.developerId } });
  expect(f.t.db.get(f.receipt)).toMatchObject({ entityType: "SPENDING_ADMISSION", orgId: TEST_ORG, workKind: "task-window", workId: f.task.taskId, requestId: f.request.requestId, spendingStop: { effectiveStopMicrousd: 500_000 } });
});
it("Continue refuses a missing enrolled policy without adding an operation or changing the old cap", async () => {
  const f = await continueWindow(), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.db.delete(f.policy);
  const reply = await f.continue(); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: "TASK_STOP_CONFIG_MISSING" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get(f.receipt)).toBeUndefined();
});
it("Continue receipt replay does not recapture or overwrite its committed window", async () => {
  const f = await continueWindow(); expect((await f.continue()).status).toBe(200);
  const receipt = f.t.db.get(f.receipt); expect(receipt).toBeDefined();
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.db.delete(f.policy);
  expect((await f.continue()).status).toBe(200);
  expect(f.t.db.get(f.receipt)).toEqual(receipt); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5);
  f.request.instructions = "Different instructions under the same request.";
  const changed = await f.continue(); expect(changed.status).toBe(409); expect(changed.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("a Continue capture survives a later numeric edit while the next window sees it", async () => {
  const f = await continueWindow(), send = f.t.db.send.bind(f.t.db); let edited = false;
  f.t.db.send = async command => {
    if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.Key.sk === "META")) {
      edited = true; f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 250_000 } } });
    }
    return send(command);
  };
  const first = await f.continue(); expect(first.status, JSON.stringify(first.body)).toBe(200); expect(edited).toBe(true);
  expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5);
  const operation = f.t.taskOps(f.task.workspaceId).at(-1); expect(operation).toBeDefined();
  await f.t.finish(f.task.workspaceId, operation!.id, "SUCCEEDED");
  f.request.requestId = randomUUID(); expect((await f.continue()).status).toBe(200);
  expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.25);
});

for (const loss of ["member", "pointer", "closing"] as const) it(`Continue classifies native ${loss} loss as forbidden and commits no window`, async () => {
  const f = await continueWindow(), send = f.t.db.send.bind(f.t.db), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.Key.sk === "META")) {
      changed = true;
      if (loss === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      else if (loss === "pointer") f.t.db.delete(developerOrgKey(MAYA.developerId));
      else f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
    }
    return send(command);
  };
  const reply = await f.continue(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(reply.body.error).toMatchObject({ code: "FORBIDDEN" }); expect(f.t.meta(f.task.taskId)).toEqual(before);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations); expect(f.t.db.get(f.receipt)).toBeUndefined();
});
it("a Continue receipt that commits after an absent early read wins over the busy preflight", async () => {
  const f = await continueWindow(), send = f.t.db.send.bind(f.t.db), before = f.t.taskOps(f.task.workspaceId).length; let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof GetCommand && command.input.Key?.pk === f.receipt.pk && command.input.Key.sk === f.receipt.sk) {
      raced = true; const response = await send(command); expect(response).toMatchObject({ Item: undefined });
      const winner = await f.continue(); expect(winner.status, JSON.stringify(winner.body)).toBe(200);
      return response;
    }
    return send(command);
  };
  const reply = await f.continue(); expect(raced).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(before + 1); expect(f.t.db.get(f.receipt)).toBeDefined();
  expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5);
});
for (const field of ["payer", "budgetUsd"] as const) it(`Continue refuses concurrent native task ${field} drift without overwriting it`, async () => {
  const f = await continueWindow(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false, winner = f.t.meta(f.task.taskId);
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.Key.sk === "META")) {
      changed = true; f.t.db.set({ ...winner, ...(field === "payer" ? { payer: { kind: "member", developerId: DEB.developerId } } : { budgetUsd: 2 }) }); winner = f.t.meta(f.task.taskId);
    }
    return send(command);
  };
  const reply = await f.continue(); expect(changed).toBe(true); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: "CHANGE_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(winner); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations); expect(f.t.db.get(f.receipt)).toBeUndefined();
});
it("Continue resolves a committed native write whose acknowledgement was lost without a second window", async () => {
  const f = await continueWindow(), send = f.t.db.send.bind(f.t.db); let lost = false;
  f.t.db.send = async command => {
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "SPENDING_ADMISSION")) {
      lost = true; throw Object.assign(new Error("test lost acknowledgement"), { name: "TimeoutError" });
    }
    return result;
  };
  const reply = await f.continue(); expect(lost).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5); expect(f.t.db.get(f.receipt)).toBeDefined();
  const windows = () => f.t.db.transactions().filter(items => items.some(item => {
    const put = item.Put; return typeof put === "object" && put !== null && "Item" in put && typeof put.Item === "object" && put.Item !== null && "entityType" in put.Item && put.Item.entityType === "SPENDING_ADMISSION" && "requestId" in put.Item && put.Item.requestId === f.request.requestId;
  }));
  expect(windows()).toHaveLength(1); expect((await f.continue()).status).toBe(200); expect(windows()).toHaveLength(1);
});
for (const corruption of ["version", "calculation"] as const) it(`Continue refuses corrupt saved ${corruption} without starting another operation`, async () => {
  const f = await continueWindow(); expect((await f.continue()).status).toBe(200);
  const row = f.t.db.get(f.receipt)!, operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), snapshot = f.t.meta(f.task.taskId).spendingStop;
  expect(snapshot).toBeDefined(); f.t.db.set({ ...row, ...(corruption === "version" ? { version: 999 } : { spendingStop: { ...snapshot!, effectiveStopMicrousd: 1 } }) });
  const reply = await f.continue(); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations); expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5);
});
it("Continue refuses a zero current stop without changing the admitted old window", async () => {
  const f = await continueWindow(), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
  const reply = await f.continue(); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: "TASK_STOP_ZERO", message: "Work can't start: the effective spending stop is $0." });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations); expect(f.t.db.get(f.receipt)).toBeUndefined();
});

for (const enrolled of [false, true]) for (const bound of ["path", "requested"] as const) it(`Continue preserves legacy submicro ${bound} only before enrollment=${enrolled}`, async () => {
  const f = await continueWindow(enrolled), before = f.t.meta(f.task.taskId);
  await f.t.set(f.task.taskId, "REMOVE spendingStop");
  f.t.db.set({ ...f.t.meta(f.task.taskId), ...(bound === "path" ? { budgetUsd: 0.0000001 } : { requestedRunLimitUsd: 0.0000001 }) });
  if (!enrolled) f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const reply = await f.continue();
  expect(reply.status, JSON.stringify(reply.body)).toBe(enrolled ? 409 : 200);
  if (enrolled) {
    expect(reply.body.error).toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
    expect(f.t.db.get(f.receipt)).toBeUndefined();
  } else {
    expect(f.t.meta(f.task.taskId).budgetUsd).toBe(bound === "path" ? 0.0000001 : before.budgetUsd);
    expect(f.t.db.get(f.receipt)).toBeUndefined();
  }
});

for (const enrolled of [false, true]) it(`initial human run preserves a legacy submicro requested bound only before enrollment=${enrolled}`, async () => {
  const f = await fixture();
  if (!enrolled) f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const start = () => startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Fix the retry bug" }, origin: "app", owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, runLimitUsd: 0.0000001 });
  if (enrolled) {
    await expect(start()).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
    expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  } else {
    const result = await start(); expect(f.t.meta(result.taskId).budgetUsd).toBe(0.0000001);
    expect(f.t.meta(result.taskId).spendingStop).toBeUndefined();
  }
});

async function pausedTestTransition(spentUsd?: number, history = false, initialMax?: number) {
  const f = await fixture(), agentId = await f.t.agentOf(TRIAGE, { publish: false }), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, ...(initialMax === undefined ? { stopKind: "inherit" } : { stopKind: "limited", maxPerRunUsd: initialMax }) });
  if (initialMax !== undefined) f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  if (history) for (let index = 0; index < 5; index += 1) f.t.db.set({ ...runCostKey(TEST_ORG, "payments", agentId, "AGENT", new Date(Date.now() - index * 1000).toISOString(), randomUUID()), entityType: "RUN_COST", costUsd: 7 });
  const task = await f.t.runOf(agentId, { version: "draft" });
  if (spentUsd !== undefined) {
    const step = f.t.taskOps(task.workspaceId).at(-1)!;
    const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (f.t.outboxOf(step.id)!.invocation as { callbackCapability: string }).callbackCapability } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    f.t.access.setKeySpent(f.t.access.mintedKeys().at(-1)!, spentUsd);
  }
  await f.t.pauseAndEnd(task, { kind: "test", taskId: task.taskId });
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 500_000 } } });
  const request = { requestId: randomUUID() };
  return { ...f, agentId, task, request, transition: () => f.t.api(MAYA, "POST", `/v1/app/tasks/${task.taskId}/continue-as-task`, request) };
}
it("Continue-as-task captures the current stop for its new payer and retains historical testing identity", async () => {
  const f = await pausedTestTransition(), before = f.t.meta(f.task.taskId), reply = await f.transition();
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ origin: "app", budgetUsd: 0.5, spendingStop: { effectiveStopMicrousd: 500_000 }, payer: { kind: "member", developerId: MAYA.developerId }, agent: before.agent });
  expect(f.t.meta(f.task.taskId).budgetPause).toBeUndefined();
});
for (const refusal of ["missing", "zero"] as const) it(`Continue-as-task refuses ${refusal} spending configuration before changing its payer or testing pause`, async () => {
  const f = await pausedTestTransition(), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  if (refusal === "missing") f.t.db.delete(f.policy);
  else f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
  const reply = await f.transition(); expect(reply.status).toBe(409);
  expect(reply.body.error).toMatchObject({ code: refusal === "missing" ? "TASK_STOP_CONFIG_MISSING" : "TASK_STOP_ZERO" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

it("Continue-as-task records its immutable window in the payer transition transaction", async () => {
  const f = await pausedTestTransition(); expect((await f.transition()).status).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ spendingAdmission: { requestId: f.request.requestId, actorId: MAYA.developerId } });
  const key = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${f.request.requestId}` };
  expect(f.t.db.get(key)).toMatchObject({ entityType: "SPENDING_ADMISSION", workKind: "task-window", workId: f.task.taskId, requestId: f.request.requestId, spendingStop: { effectiveStopMicrousd: 500_000 } });
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.db.delete(f.policy); expect((await f.transition()).status).toBe(200);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});
it("Continue-as-task retry repairs a committed payer transition whose acknowledgement was lost before dispatch", async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let lost = false;
  f.t.db.send = async command => {
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":app"] === "app")) {
      lost = true; throw new Error("test acknowledgement lost after payer transition committed");
    }
    return result;
  };
  await f.transition(); expect(lost).toBe(true); expect(f.t.meta(f.task.taskId).origin).toBe("app");
  f.t.db.delete(f.policy);
  expect((await f.transition()).status).toBe(200);
  const resumed = f.t.taskOps(f.task.workspaceId).map(op => op.id); expect(resumed).toHaveLength(operations.length + 1);
  expect((await f.transition()).status).toBe(200); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(resumed);
});

for (const corruption of ["version", "calculation"] as const) it(`Continue-as-task refuses a corrupt ${corruption} receipt before redriving work`, async () => {
  const f = await pausedTestTransition(); expect((await f.transition()).status).toBe(200);
  const key = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${f.request.requestId}` }, row = f.t.db.get(key)!;
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.db.set({ ...row, ...(corruption === "version" ? { version: 999 } : { spendingStop: { ...f.t.meta(f.task.taskId).spendingStop!, effectiveStopMicrousd: 1 } }) });
  const reply = await f.transition(); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});
it("an old Continue-as-task receipt cannot redrive a later paused agent revision", async () => {
  const f = await pausedTestTransition(); expect((await f.transition()).status).toBe(200);
  await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  await f.t.set(f.task.taskId, "REMOVE budgetPause");
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  expect((await f.transition()).status).toBe(200); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

it("Continue-as-task starts its new .5 window after actual historical testing spend", async () => {
  const f = await pausedTestTransition(0.75), reply = await f.transition(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 0.5, budgetBaselineUsd: 0.75 });
  const next = f.t.taskOps(f.task.workspaceId).at(-1)!;
  const minted = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (f.t.outboxOf(next.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  expect(f.t.access.mintKey.mock.calls.at(-1)![0]).toMatchObject({ maxBudgetUsd: 0.5, tags: { origin: "app", payerKind: "member" } });
});

it("Continue-as-task leaves the testing payer and pause intact if historical key spend is unavailable", async () => {
  const f = await pausedTestTransition(0.75), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  f.t.access.keySpend.mockRejectedValueOnce(new Error("test proxy unavailable"));
  const reply = await f.transition(); expect(reply.body.error).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${f.request.requestId}` })).toBeUndefined();
});

for (const loss of ["member", "pointer", "closing", "people"] as const) it(`Continue-as-task fences native ${loss} authority loss before payer/window commit`, async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":app"] === "app")) {
      changed = true;
      if (loss === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      else if (loss === "pointer") f.t.db.delete(developerOrgKey(MAYA.developerId));
      else if (loss === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      else f.t.db.set({ pk: `DEVTASK#${f.task.taskId}`, sk: "PEOPLE", revision: 1, schemaVersion: 999 });
    }
    return send(command);
  };
  const reply = await f.transition(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${f.request.requestId}` })).toBeUndefined();
});
it("Continue-as-task receipt recovery refuses a closing org before redriving the original paused step", async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let lost = false;
  f.t.db.send = async command => {
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":app"] === "app")) {
      lost = true; f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() }); throw new Error("test lost acknowledgement after org began closing");
    }
    return result;
  };
  const reply = await f.transition(); expect(lost).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect((await f.transition()).status).toBe(403); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

for (const loss of ["member", "closing", "people"] as const) it(`Continue-as-task keeps ${loss} authority native through the actual resumed operation commit`, async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      changed = true;
      if (loss === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      else if (loss === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      else f.t.db.set({ pk: `DEVTASK#${f.task.taskId}`, sk: "PEOPLE", revision: 1, schemaVersion: 999 });
    }
    return send(command);
  };
  const reply = await f.transition(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

for (const loss of ["member", "closing", "people"] as const) it(`Continue-as-task fences ${loss} loss before the original paused run is marked resumed`, async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.pk === `DEVTASK#${f.task.taskId}` && item.Put.Item.sk === "AGENT_RUN" && item.Put.Item.state === "RUNNING") && !command.input.TransactItems.some(item => item.Put?.Item?.entityType === "OPERATION")) {
      changed = true;
      if (loss === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      else if (loss === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      else f.t.db.set({ pk: `DEVTASK#${f.task.taskId}`, sk: "PEOPLE", revision: 1, schemaVersion: 999 });
    }
    return send(command);
  };
  const reply = await f.transition(); expect(changed).toBe(true); expect(reply.status, JSON.stringify(reply.body)).toBe(403);
  expect(f.t.db.get(`DEVTASK#${f.task.taskId}`, "AGENT_RUN")).toMatchObject({ state: "PAUSED_BUDGET" });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

for (const loss of ["closing", "people"] as const) it(`platform recovery retains the existing payer-window admission after ${loss} dispatch refusal`, async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      changed = true;
      if (loss === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      else f.t.db.set({ pk: `DEVTASK#${f.task.taskId}`, sk: "PEOPLE", revision: 1, schemaVersion: 999 });
    }
    return send(command);
  };
  expect((await f.transition()).status).toBe(403); expect(changed).toBe(true);
  const admitted = f.t.meta(f.task.taskId).spendingStop; expect(admitted).toBeDefined();
  f.t.db.delete(f.policy);
  const rows = f.t.db.find(row => row.pk === "WORKFLOW_DISPATCH" && row.taskId === f.task.taskId); expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) f.t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.meta(f.task.taskId).spendingStop).toEqual(admitted);
});

for (const receiptState of ["valid", "missing", "corrupt"] as const) it(`platform recovery uses a ${receiptState} committed payer receipt without current money settings`, async () => {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let interrupted = false;
  f.t.db.send = async command => {
    if (!interrupted && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      interrupted = true; throw new Error("test process interrupted before paid operation commit");
    }
    return send(command);
  };
  await f.transition(); expect(interrupted).toBe(true); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  const admitted = f.t.meta(f.task.taskId).spendingStop;
  expect(f.t.db.get(`DEVTASK#${f.task.taskId}`, "AGENT_RUN")).toMatchObject({ spendingAdmission: { requestId: f.request.requestId, actorId: MAYA.developerId } });
  f.t.db.delete(f.policy);
  const receiptKey = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${f.request.requestId}` };
  if (receiptState === "missing") f.t.db.delete(receiptKey);
  if (receiptState === "corrupt") f.t.db.set({ ...f.t.db.get(receiptKey)!, version: 999 });
  const rows = f.t.db.find(row => row.pk === "WORKFLOW_DISPATCH" && row.taskId === f.task.taskId); expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) f.t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + (receiptState === "valid" ? 1 : 0));
  expect(f.t.meta(f.task.taskId).spendingStop).toEqual(admitted); expect(f.t.meta(f.task.taskId).budgetUsd).toBe(0.5);
});

async function queuedPayerTransition() {
  const f = await pausedTestTransition(), send = f.t.db.send.bind(f.t.db); let interrupted = false;
  f.t.db.send = async command => {
    if (!interrupted && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      interrupted = true; throw new Error("test process stopped before accepted operation");
    }
    return send(command);
  };
  await f.transition(); expect(interrupted).toBe(true);
  const rows = f.t.db.find(row => row.pk === "WORKFLOW_DISPATCH" && row.taskId === f.task.taskId); expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) f.t.db.set({ ...row, nextAttemptAt: "2026-01-01T00:00:00.000Z", dispatchDueSk: `2026-01-01T00:00:00.000Z#${String(row.sk)}` });
  return f;
}
for (const source of ["project", "agent"] as const) for (const when of ["before_sweep", "at_commit"] as const) it(`platform payer recovery retains ${source} authority ${when}`, async () => {
  const f = await queuedPayerTransition(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let changed = false;
  const change = async () => {
    changed = true;
    const reply = source === "project" ? await f.t.api(ADA, "PUT", `/v1/app/projects/payments/members/${MAYA.developerId}`, { role: "viewer" })
      : await f.t.api(MAYA, "POST", `/v1/app/agents/${f.t.meta(f.task.taskId).agent!.agentId}/archive`, {});
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  };
  if (when === "before_sweep") await change();
  else f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) await change();
    return send(command);
  };
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" }); expect(changed).toBe(true);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

it("platform recovery retains the accepted frozen recipe after a later draft edit", async () => {
  const f = await queuedPayerTransition(), before = f.t.meta(f.task.taskId), agentId = f.agentId, draft = await f.t.store.getDraft(TEST_ORG, agentId);
  expect(draft).toBeDefined();
  const edited = await f.t.api(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: draft!.revision, overlay: { ...TRIAGE, instructions: "A later draft must not replace accepted work." } });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  f.t.db.delete(f.policy);
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ agent: before.agent, spendingStop: before.spendingStop, budgetUsd: 0.5 });
});

for (const source of ["payer", "budget"] as const) it(`platform recovery fences task ${source} source changes at the actual operation commit`, async () => {
  const f = await queuedPayerTransition(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      changed = true; f.t.db.set({ ...f.t.meta(f.task.taskId), ...(source === "payer" ? { payer: { kind: "project", project: "payments" } } : { budgetUsd: 0.25 }) });
    }
    return send(command);
  };
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" }); expect(changed).toBe(true);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.meta(f.task.taskId)).toMatchObject(source === "payer" ? { payer: { kind: "project", project: "payments" } } : { budgetUsd: 0.25 });
});
it("platform recovery keeps its committed stop after a numeric policy edit at the actual operation commit", async () => {
  const f = await queuedPayerTransition(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      changed = true; f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 250_000 } } });
    }
    return send(command);
  };
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" }); expect(changed).toBe(true);
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 0.5, spendingStop: { effectiveStopMicrousd: 500_000 } });
});

for (const drift of [false, true]) it(`platform source fence shares one task action with a pending note update, drift=${drift}`, async () => {
  const f = await queuedPayerTransition(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db);
  const note = AppNoteSchema.parse({ schemaVersion: 1, source: "app", taskId: f.task.taskId, developerId: MAYA.developerId, name: "Maya", isOwner: true,
    sessionId: String(f.t.meta(f.task.taskId).sessionId), messageId: "msg_00000000000000000001", text: "Keep the accepted task scope.", truncated: false, receivedAt: new Date().toISOString(), workflowRevision: 1 });
  f.t.db.set({ pk: `DEVTASK#${f.task.taskId}`, sk: `NOTE#${note.messageId}`, entityType: "TASK_THREAD_NOTE", ...note });
  await f.t.set(f.task.taskId, "SET threadNoteCount = :count", { ":count": 1 }); let checked = false;
  f.t.db.send = async command => {
    if (!checked && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      checked = true;
      const taskActions = command.input.TransactItems.filter(item => (item.Update?.Key ?? item.ConditionCheck?.Key)?.pk === `DEVTASK#${f.task.taskId}` && (item.Update?.Key ?? item.ConditionCheck?.Key)?.sk === "META");
      expect(taskActions).toHaveLength(1); expect(taskActions[0]?.Update?.UpdateExpression).toContain("threadNotesFedThrough");
      if (drift) f.t.db.set({ ...f.t.meta(f.task.taskId), budgetUsd: 0.25 });
    }
    return send(command);
  };
  await f.t.handler({ source: "agentx.workflow-dispatch-recovery" }); expect(checked).toBe(true);
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + (drift ? 0 : 1));
  expect(f.t.meta(f.task.taskId).threadNotesFedThrough).toBe(drift ? undefined : note.receivedAt);
});

it("an enrolled new run-limit approval above the current ceiling refuses without raising or resuming its task", async () => {
  const f = await fixture(), task = await f.t.plainTask(); await f.t.pauseAndEnd(task);
  const request = f.t.requestOf(task.taskId, "run_limit")[0]!; expect(request.newLimitUsd).toBeGreaterThan(1);
  const before = f.t.meta(task.taskId), operations = f.t.taskOps(task.workspaceId).map(op => op.id);
  await expect(f.t.decide(MAYA, request.spendRequestId)).rejects.toMatchObject({ code: "TASK_STOP_APPROVAL_ABOVE_CEILING" });
  expect(f.t.meta(task.taskId)).toEqual(before); expect(f.t.taskOps(task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.requestOf(task.taskId, "run_limit")[0]!.status).not.toBe("APPROVED");
});
it("a disabled org retains legacy run-limit approval behavior above a lower ceiling", async () => {
  const f = await fixture(); f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const task = await f.t.plainTask(); await f.t.pauseAndEnd(task);
  const request = f.t.requestOf(task.taskId, "run_limit")[0]!; expect(request.newLimitUsd).toBeGreaterThan(1);
  const result = await f.t.decide(BEN, request.spendRequestId); expect(result.spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(task.taskId).budgetUsd).toBe(request.newLimitUsd);
});
it("denying an enrolled above-ceiling request remains allowed and grants no new money", async () => {
  const f = await fixture(), task = await f.t.plainTask(); await f.t.pauseAndEnd(task);
  const request = f.t.requestOf(task.taskId, "run_limit")[0]!, before = f.t.meta(task.taskId).budgetUsd;
  const result = await f.t.decide(MAYA, request.spendRequestId, "DENY"); expect(result.spendRequest.status).toBe("DENIED");
  expect(f.t.meta(task.taskId).budgetUsd).toBe(before);
});

async function approvalWindow(scope?: "company" | "project" | "agent") {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: scope === "company" ? { kind: "limited", stopMicrousd: 2_000_000 } : { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  if (scope === "project") f.t.db.set({ ...f.t.db.get(f.project)!, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 2_000_000 } });
  if (scope === "agent") f.t.db.set({ ...f.t.db.get(f.agent)!, stopKind: "limited", maxPerRunUsd: 2 });
  const task = await f.t.plainTask(); await f.t.pauseAndEnd(task);
  const request = f.t.requestOf(task.taskId, "run_limit")[0]!; expect(request).toBeDefined();
  return { ...f, task, spendRequest: request };
}
it("an allowed run-limit approval commits its newly calculated stop envelope with the existing task cap", async () => {
  const f = await approvalWindow(); expect(f.spendRequest.newLimitUsd).toBe(15);
  const result = await f.t.decide(BEN, f.spendRequest.spendRequestId); expect(result.spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 15, spendingStop: { effectiveStopMicrousd: 15_000_000, approvalCapMicrousd: 20_000_000, calculationInput: { approvedRunLimitMicrousd: 15_000_000 } } });
});
for (const scope of ["company", "project", "agent"] as const) it(`a new run-limit approval cannot lift its explicit ${scope} stop`, async () => {
  const f = await approvalWindow(scope), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  expect(f.spendRequest.newLimitUsd).toBe(7);
  const decision = f.t.decide(MAYA, f.spendRequest.spendRequestId);
  await expect(decision).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  await expect(decision).rejects.toThrow("Spending rules changed; ask again.");
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.requestOf(f.task.taskId, "run_limit")[0]).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});

it("a new enrolled run-limit request stores original task and exact asked/proposed terms", async () => {
  const f = await approvalWindow();
  expect(f.t.requestOf(f.task.taskId, "run_limit")[0]).toMatchObject({ approvalTerms: { version: 1, sourcePresence: true,
    originalFields: { orgId: TEST_ORG, project: "payments", budgetUsd: 10 }, askedFiguresMicrousd: { budget: 10_000_000 }, proposedFiguresMicrousd: { budget: 15_000_000 }, operation: "run_limit" } });
});
for (const field of ["budget", "payer"] as const) it(`an enrolled approval requires a new ask after original task ${field} figures change`, async () => {
  const f = await approvalWindow();
  f.t.db.set({ ...f.t.meta(f.task.taskId), ...(field === "budget" ? { budgetUsd: 20 } : { payer: { kind: "project", project: "payments" } }) });
  const before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.requestOf(f.task.taskId, "run_limit")[0]).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
});
it("an enrolled approval cannot synthesize missing original request terms at decision", async () => {
  const f = await approvalWindow(), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "META" }, row = { ...f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "META" })! };
  delete row.approvalTerms; f.t.db.set(row);
  const before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});

it("original approval request money terms remain native at the final approval commit", async () => {
  const f = await approvalWindow(), send = f.t.db.send.bind(f.t.db), before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "META" };
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      changed = true; f.t.db.set({ ...f.t.db.get(key)!, amountUsd: 35, newLimitUsd: 45 });
    }
    return send(command);
  };
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" }); expect(changed).toBe(true);
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
});
it("policy changes after an ask require a new approval request", async () => {
  const f = await approvalWindow(), before = f.t.meta(f.task.taskId);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 100_000_000 } } });
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.requestOf(f.task.taskId, "run_limit")[0]).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});
it("policy edits after approval capture apply to the next admission without recapturing the accepted approval", async () => {
  const f = await approvalWindow(), send = f.t.db.send.bind(f.t.db); let changed = false, captures = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      changed = true; f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 500_000 } } });
    }
    return send(command);
  };
  expect((await f.t.decide(BEN, f.spendRequest.spendRequestId)).spendRequest.status).toBe("APPROVED"); expect(changed).toBe(true); expect(captures).toBe(1);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 15, spendingStop: { effectiveStopMicrousd: 15_000_000, sourceRevisions: { company: 1 } } });
});

it("original task terms are held while the new request itself is committed", async () => {
  const f = await fixture(); f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const task = await f.t.plainTask(), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "SPEND_REQUEST" && item.Put.Item.kind === "run_limit")) {
      changed = true; f.t.db.set({ ...f.t.meta(task.taskId), budgetUsd: 20 });
    }
    return send(command);
  };
  await expect(createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId: task.taskId, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, amountUsd: 5, newLimitUsd: 15,
    requestedBy: { kind: "member", developerId: MAYA.developerId }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", reason: "A new run window was requested." })).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(changed).toBe(true); expect(f.t.requestOf(task.taskId, "run_limit")).toHaveLength(0); expect(f.t.meta(task.taskId).budgetUsd).toBe(20);
});
it("original task source remains pinned after decision preflight and before native approval commit", async () => {
  const f = await approvalWindow(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      changed = true; f.t.db.set({ ...f.t.meta(f.task.taskId), payer: { kind: "project", project: "payments" } });
    }
    return send(command);
  };
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" }); expect(changed).toBe(true);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 10, payer: { kind: "project", project: "payments" } });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations); expect(f.t.requestOf(f.task.taskId, "run_limit")[0]).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
});
it("corrupt original approval terms expire without synthesizing replacement terms", async () => {
  const f = await approvalWindow(), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "META" }, before = f.t.meta(f.task.taskId);
  f.t.db.set({ ...f.t.db.get(key)!, approvalTerms: { ...f.spendRequest.approvalTerms!, version: 999 } });
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});

it("an allowed agent run-limit approval replaces the previous window binding and resumes from the new committed admission", async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId).budgetUsd).toBe(4);
  await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!; expect(request.newLimitUsd).toBe(9);
  const operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), decisionId = randomUUID();
  const result = await f.t.decide(MAYA, request.spendRequestId, "APPROVE", { requestId: decisionId }); expect(result.spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000 } });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
  expect(f.t.db.get(`DEVTASK#${f.task.taskId}`, "AGENT_RUN")).toMatchObject({ spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  expect(f.t.meta(f.task.taskId)).toMatchObject({ spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${decisionId}` })).toMatchObject({
    entityType: "SPENDING_ADMISSION", workKind: "task-window", workId: f.task.taskId, spendRequestId: request.spendRequestId, spendingStop: { effectiveStopMicrousd: 9_000_000 } });
});

it("an agent approval lost acknowledgement repairs from its atomic new admission without recapturing money", async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  expect((await f.transition()).status).toBe(200); await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!, decisionId = randomUUID(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db);
  let lost = false, captures = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      lost = true; throw new Error("test acknowledgement lost after approval admission committed");
    }
    return result;
  };
  await expect(f.t.decide(MAYA, request.spendRequestId, "APPROVE", { requestId: decisionId })).rejects.toThrow("test acknowledgement lost");
  expect(lost).toBe(true); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get(`DEVTASK#${f.task.taskId}`, "AGENT_RUN")).toMatchObject({ state: "PAUSED_BUDGET", spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000 } });
  expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === f.task.taskId)).toHaveLength(1);
  f.t.db.delete(f.policy); captures = 0;
  expect((await f.t.decide(MAYA, request.spendRequestId, "APPROVE", { requestId: decisionId })).spendRequest.status).toBe("APPROVED");
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  const resumed = f.t.taskOps(f.task.workspaceId).map(op => op.id); expect(resumed).toHaveLength(operations.length + 1);
  expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === f.task.taskId)).toHaveLength(0);
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(resumed); expect(captures).toBe(0);
});

for (const state of ["missing", "corrupt"] as const) it(`an enrolled agent approval refuses ${state} paused-run admission state before approving money`, async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  expect((await f.transition()).status).toBe(200); await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!, key = { pk: `DEVTASK#${f.task.taskId}`, sk: "AGENT_RUN" };
  const before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  if (state === "missing") f.t.db.delete(key); else f.t.db.set({ ...f.t.db.get(key)!, revision: "unreadable" });
  await expect(f.t.decide(MAYA, request.spendRequestId)).rejects.toMatchObject({ code: "TASK_STOP_CONFIG_INVALID" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${request.spendRequestId}`), sk: "META" })).toMatchObject({ status: "PENDING" });
});

for (const race of ["none", "approver", "executor"] as const) it(`a distinct approver retains both native actors at an agent approval commit: ${race}`, async () => {
  const f = await pausedTestTransition(undefined, true);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 40 } });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId).budgetUsd).toBe(14);
  await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!, decisionId = randomUUID(); expect(request.newLimitUsd).toBe(21);
  const before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let intercepted = false;
  f.t.db.send = async command => {
    if (!intercepted && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.transitionKind === "spend-approval")) {
      intercepted = true;
      const keys = command.input.TransactItems.map(item => item.ConditionCheck?.Key ?? item.Update?.Key ?? item.Put?.Item ?? item.Delete?.Key);
      expect(new Set(keys.map(key => `${String(key?.pk)}|${String(key?.sk)}`)).size).toBe(keys.length);
      if (race !== "none") f.t.db.delete(orgMemberKey(TEST_ORG, (race === "approver" ? BEN : MAYA).developerId));
    }
    return send(command);
  };
  const decision = f.t.decide(BEN, request.spendRequestId, "APPROVE", { requestId: decisionId });
  if (race === "none") {
    expect((await decision).spendRequest.status).toBe("APPROVED"); expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
    expect(f.t.db.get(`DEVTASK#${f.task.taskId}`, "AGENT_RUN")).toMatchObject({ spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  } else {
    await expect(decision).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(f.t.meta(f.task.taskId)).toEqual(before);
    expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${request.spendRequestId}`), sk: "META" })).toMatchObject({ status: "PENDING" });
  }
  expect(intercepted).toBe(true);
});

it("an approved agent window resumes when the original answered pause has no notification acknowledgement", async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  expect((await f.transition()).status).toBe(200); await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const key = { pk: `DEVTASK#${f.task.taskId}`, sk: "AGENT_RUN" }, run = f.t.db.get(key)!, pause = { ...run.pause as Record<string, unknown> }; delete pause.notifiedAt;
  f.t.db.set({ ...run, pause });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!, decisionId = randomUUID(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  expect((await f.t.decide(MAYA, request.spendRequestId, "APPROVE", { requestId: decisionId })).spendRequest.status).toBe("APPROVED");
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
  expect(f.t.db.get(key)).toMatchObject({ state: "RUNNING", spendingAdmission: { requestId: decisionId } });
  expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === f.task.taskId)).toHaveLength(0);
});

for (const loss of ["closing", "cap_source"] as const) it(`a plain-task approval fences ${loss} at the actual paid operation commit`, async () => {
  const f = await approvalWindow(), send = f.t.db.send.bind(f.t.db), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === f.task.workspaceId)) {
      changed = true;
      if (loss === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      else f.t.db.set({ ...f.t.meta(f.task.taskId), budgetUsd: 99 });
    }
    return send(command);
  };
  expect((await f.t.decide(BEN, f.spendRequest.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(changed).toBe(true); expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});

for (const receiptState of ["valid", "missing", "corrupt", "changed_reference", "changed_origin", "changed_baseline", "missing_baseline"] as const) it(`plain approval acknowledgement loss uses a ${receiptState} receipt without current financial settings`, async () => {
  const f = await approvalWindow(), decisionId = randomUUID(), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let lost = false, captures = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${f.task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      lost = true; throw new Error("test plain approval acknowledgement lost");
    }
    return result;
  };
  await expect(f.t.decide(BEN, f.spendRequest.spendRequestId, "APPROVE", { requestId: decisionId })).rejects.toThrow("test plain approval acknowledgement lost");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 15, spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${decisionId}` })).toMatchObject({
    transitionKind: "spend-approval", spendRequestId: f.spendRequest.spendRequestId, agentRunRevision: null, spendingStop: { effectiveStopMicrousd: 15_000_000 } });
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
  const receiptKey = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${f.task.taskId}`), sk: `REQUEST#${decisionId}` };
  if (receiptState === "missing") f.t.db.delete(receiptKey);
  if (receiptState === "corrupt") f.t.db.set({ ...f.t.db.get(receiptKey)!, version: 999 });
  if (receiptState === "changed_reference") f.t.db.set({ ...f.t.meta(f.task.taskId), spendingAdmission: { requestId: randomUUID(), actorId: MAYA.developerId, intentHash: "a".repeat(64) } });
  if (receiptState === "changed_origin") f.t.db.set({ ...f.t.meta(f.task.taskId), origin: "app" });
  if (receiptState === "changed_baseline") f.t.db.set({ ...f.t.meta(f.task.taskId), budgetBaselineUsd: 100 });
  if (receiptState === "missing_baseline") { const receipt: Record<string, unknown> = { ...f.t.db.get(receiptKey)! }; delete receipt.budgetBaselineUsd; f.t.db.set(receipt); }
  f.t.db.delete(f.policy); captures = 0;
  expect((await f.t.decide(BEN, f.spendRequest.spendRequestId, "APPROVE", { requestId: decisionId })).spendRequest.status).toBe("APPROVED");
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + (receiptState === "valid" ? 1 : 0));
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + (receiptState === "valid" ? 1 : 0)); expect(captures).toBe(0);
  expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === f.task.taskId)).toHaveLength(receiptState === "valid" ? 0 : 1);
});

for (const recovery of ["valid", "spent_valid", "closing", "cap_source"] as const) it(`workflow planning approval repair retains its original stage and native ${recovery} guard`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const task = await f.t.runOf(agentId); expect(f.t.taskOps(task.workspaceId).at(-1)).toMatchObject({ workflowMode: "PLAN" });
  if (recovery === "spent_valid") {
    const plan = f.t.taskOps(task.workspaceId).at(-1)!;
    const mint = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
    expect(mint.status).toBe(200); f.t.access.setKeySpent(f.t.access.mintedKeys().at(-1)!, 0.75);
  }
  await f.t.pauseAndEnd(task, { kind: "planning", taskId: task.taskId });
  const request = f.t.requestOf(task.taskId, "planning")[0]!, decisionId = randomUUID(), operations = f.t.taskOps(task.workspaceId).map(op => op.id), send = f.t.db.send.bind(f.t.db); let lost = false, captures = 0, changed = false;
  expect(request.approvalTerms).toMatchObject({ operation: "planning", askedFiguresMicrousd: { budget: 2_000_000, maxPerRun: null, baseline: 0, amount: 5_000_000 }, proposedFiguresMicrousd: { budget: 5_000_000, maxPerRun: null, window: "reset" } });
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    if (lost && !changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === task.workspaceId)) {
      changed = true;
      if (recovery === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      if (recovery === "cap_source") f.t.db.set({ ...f.t.meta(task.taskId), budgetUsd: 99 });
    }
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${task.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) {
      lost = true; throw new Error("test workflow approval acknowledgement lost");
    }
    return result;
  };
  await expect(f.t.decide(MAYA, request.spendRequestId, "APPROVE", { requestId: decisionId })).rejects.toThrow("test workflow approval acknowledgement lost");
  expect(f.t.meta(task.taskId)).toMatchObject({ spendingAdmission: { requestId: decisionId, actorId: MAYA.developerId } });
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${decisionId}` })).toMatchObject({ transitionKind: "spend-approval", spendRequestId: request.spendRequestId, agentRunRevision: null });
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${decisionId}` })).toMatchObject({ budgetBaselineUsd: recovery === "spent_valid" ? 0.75 : 0 });
  expect(f.t.meta(task.taskId).budgetBaselineUsd).toBe(recovery === "spent_valid" ? 0.75 : 0);
  f.t.db.delete(f.policy); captures = 0;
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  expect(f.t.taskOps(task.workspaceId)).toHaveLength(operations.length + (recovery === "valid" || recovery === "spent_valid" ? 1 : 0)); expect(changed).toBe(true);
  if (recovery === "valid" || recovery === "spent_valid") expect(f.t.taskOps(task.workspaceId).at(-1)).toMatchObject({ workflowMode: "PLAN" });
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(f.t.taskOps(task.workspaceId)).toHaveLength(operations.length + (recovery === "valid" || recovery === "spent_valid" ? 1 : 0)); expect(captures).toBe(0);
});

for (const source of ["valid", "closing", "cap_source"] as const) it(`a newly reviewed held preparation retains native ${source} authority after cap approval`, async () => {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0 });
  const old = f.t.requestOf(started.taskId)[0]!; await f.t.decide(MAYA, old.spendRequestId, "DENY");
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "enabled" }, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId: started.taskId, kind: "run_limit", scope: { kind: "task", taskId: started.taskId }, amountUsd: 5, newLimitUsd: 5,
    requestedBy: { kind: "system" }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", reason: "Review the held preparation under current spending rules." });
  const task = f.t.meta(started.taskId), prepare = f.t.operations(task.workspaceId).find(operation => operation.kind === "prepare")!, send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${started.taskId}` && item.Update.UpdateExpression === "SET updatedAt = :now REMOVE budgetPause")) {
      changed = true;
      if (source === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      if (source === "cap_source") f.t.db.set({ ...f.t.meta(started.taskId), budgetUsd: 99 });
    }
    return send(command);
  };
  expect((await f.t.decide(MAYA, record.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(changed).toBe(true);
  if (source === "valid") expect(f.t.outboxOf(prepare.id)).toBeDefined(); else expect(f.t.outboxOf(prepare.id)).toBeUndefined();
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  if (source === "valid") expect(f.t.outboxOf(prepare.id)).toBeDefined(); else expect(f.t.outboxOf(prepare.id)).toBeUndefined();
});

for (const recovery of ["valid", "bounded_valid", "closing", "cap_source", "invalid_limit", "wrong_request"] as const) it(`plan acceptance approval repair retains implementation intent and ${recovery} source`, async () => {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 40 } });
  for (let index = 0; index < 5; index += 1) f.t.db.set({ ...runCostKey(TEST_ORG, "payments", ROVARA_CODE_AGENT_ID, "QUICK", new Date(Date.now() - index * 1000).toISOString(), randomUUID()), entityType: "RUN_COST", costUsd: 10 });
  if (recovery === "bounded_valid") f.t.db.set({ ...f.t.db.get(f.agent)!, stopKind: "limited", maxPerRunUsd: 9 });
  const started = await f.t.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" }); expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = String((started.body.task as { taskId: string }).taskId), workspaceId = f.t.meta(taskId).workspaceId;
  await f.t.finish(workspaceId, f.t.operations(workspaceId).find(operation => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
  const plan = f.t.taskOps(workspaceId).at(-1)!;
  await f.t.artifact(workspaceId, plan.id, "plan.md", planAnswer(planDocument())); await f.t.finish(workspaceId, plan.id, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  if (recovery === "bounded_valid") {
    const settings: Record<string, unknown> = { ...f.t.db.get(f.agent)!, revision: 2, stopKind: "inherit" }; delete settings.maxPerRunUsd; f.t.db.set(settings);
  }
  const workflow = f.t.meta(taskId).workflow as { revision: number; artifacts: Array<{ sha256: string }> };
  expect((await f.t.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: workflow.artifacts.at(-1)!.sha256 })).status).toBe(200);
  const request = f.t.requestOf(taskId, "run_limit")[0]!; expect(request).toMatchObject({ resume: "implement", newLimitUsd: 20 });
  const decisionId = randomUUID(), send = f.t.db.send.bind(f.t.db); let lost = false, changed = false, captures = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    if (lost && !changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.workflowMode === "IMPLEMENT" && item.Put.Item.workspaceId === workspaceId)) {
      changed = true;
      if (recovery === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      if (recovery === "cap_source") f.t.db.set({ ...f.t.meta(taskId), budgetUsd: 99 });
    }
    const result = await send(command);
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) { lost = true; throw new Error("test implementation approval acknowledgement lost"); }
    return result;
  };
  await expect(f.t.decide(BEN, request.spendRequestId, "APPROVE", { requestId: decisionId })).rejects.toThrow("test implementation approval acknowledgement lost");
  if (recovery === "invalid_limit" || recovery === "wrong_request") {
    const held = f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === taskId)[0]!;
    f.t.db.set({ ...held, ...(recovery === "invalid_limit" ? { runLimitUsd: 99 } : { spendRequestId: "spr_00000000000000000000" }) });
  }
  expect(f.t.meta(taskId)).toMatchObject({ budgetUsd: recovery === "bounded_valid" ? 9 : 20, spendingStop: { effectiveStopMicrousd: recovery === "bounded_valid" ? 9_000_000 : 20_000_000 } });
  f.t.db.delete(f.policy); captures = 0;
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(changed).toBe(recovery !== "invalid_limit" && recovery !== "wrong_request");
  const implementations = () => f.t.taskOps(workspaceId).filter(operation => operation.workflowMode === "IMPLEMENT");
  expect(implementations()).toHaveLength(recovery === "valid" || recovery === "bounded_valid" ? 1 : 0);
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(implementations()).toHaveLength(recovery === "valid" || recovery === "bounded_valid" ? 1 : 0); expect(captures).toBe(0);
});
for (const source of ["valid", "dispatch_lost", "dispatch_completed", "dispatch_completed_wrong_org", "dispatch_completed_wrong_kind", "changed_operation", "changed_readonly"] as const) it(`held preparation approval lost acknowledgement retains ${source} original dispatch terms`, async () => {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0 });
  const old = f.t.requestOf(started.taskId)[0]!; await f.t.decide(MAYA, old.spendRequestId, "DENY");
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "enabled" }, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId: started.taskId, kind: "run_limit", scope: { kind: "task", taskId: started.taskId }, amountUsd: 5, newLimitUsd: 5,
    requestedBy: { kind: "system" }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", reason: "Review the held preparation under current spending rules." });

  const task = f.t.meta(started.taskId), prepare = f.t.operations(task.workspaceId).find(operation => operation.kind === "prepare")!, send = f.t.db.send.bind(f.t.db), decisionId = randomUUID(); let lost = false, dispatchLost = false, captures = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) captures += 1;
    const result = await send(command);
    if ((source === "dispatch_lost" || source.startsWith("dispatch_completed")) && lost && !dispatchLost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${started.taskId}` && item.Update.UpdateExpression === "SET updatedAt = :now REMOVE budgetPause")) { dispatchLost = true; throw new Error("test committed preparation dispatch acknowledgement lost"); }
    if (!lost && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${started.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) { lost = true; throw new Error("test held approval acknowledgement lost"); }
    return result;
  };
  await expect(f.t.decide(MAYA, record.spendRequestId, "APPROVE", { requestId: decisionId })).rejects.toThrow("test held approval acknowledgement lost");
  const before = f.t.meta(started.taskId), pause = before.budgetPause as { scope: unknown; at: string; firstDispatch: { operationId: string; checkout?: unknown[]; readOnly?: true } };
  if (source === "changed_operation") f.t.db.set({ ...before, budgetPause: { ...pause, firstDispatch: { ...pause.firstDispatch, operationId: randomUUID() } } });
  if (source === "changed_readonly") f.t.db.set({ ...before, budgetPause: { ...pause, firstDispatch: { ...pause.firstDispatch, readOnly: true } } });
  f.t.db.delete(f.policy); captures = 0;
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 });
  if ((source === "valid" || (source === "dispatch_lost" || source.startsWith("dispatch_completed")))) expect(f.t.outboxOf(prepare.id)).toBeDefined(); else expect(f.t.outboxOf(prepare.id)).toBeUndefined();
  if (source.startsWith("dispatch_completed")) {
    await f.t.finish(task.workspaceId, prepare.id, "SUCCEEDED", PREPARED);
    for (const mark of f.t.db.find(row => row.entityType === "SETUP_WATCH" && row.taskId === started.taskId)) f.t.db.delete({ pk: String(mark.pk), sk: String(mark.sk) });
    expect(f.t.operations(task.workspaceId).find(operation => operation.id === prepare.id)).toMatchObject({ status: "SUCCEEDED", kind: "prepare", workspaceId: task.workspaceId });
    if (source !== "dispatch_completed") {
      const operation = f.t.db.find(row => row.entityType === "OPERATION" && row.id === prepare.id)[0]!;
      f.t.db.set({ ...operation, ...(source === "dispatch_completed_wrong_org" ? { orgId: "org_bbbbbbbbbbbbbbbbbbbb" } : { kind: "task" }) });
    }
  }
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(captures).toBe(0);
  if ((source === "dispatch_lost" || source.startsWith("dispatch_completed"))) { expect(dispatchLost).toBe(true); expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === started.taskId)).toHaveLength(source === "dispatch_completed_wrong_org" || source === "dispatch_completed_wrong_kind" ? 1 : 0); }
  if (source !== "valid" && source !== "dispatch_lost" && source !== "dispatch_completed") expect(f.t.db.find(row => row.pk === "HELD_SPEND_STARTS" && row.taskId === started.taskId)).toHaveLength(1);
});

for (const timing of ["before_decision", "at_commit"] as const) it(`held preparation approval retains the original asked dispatch terms ${timing}`, async () => {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Fix the retry bug" }, origin: "app",
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId }, runLimitUsd: 0 });
  const old = f.t.requestOf(started.taskId)[0]!; await f.t.decide(MAYA, old.spendRequestId, "DENY");
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "enabled" }, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId: started.taskId, kind: "run_limit", scope: { kind: "task", taskId: started.taskId }, amountUsd: 5, newLimitUsd: 5,
    requestedBy: { kind: "system" }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", reason: "Review the held preparation under current spending rules." });

  const mutate = () => {
    const task = f.t.meta(started.taskId), pause = task.budgetPause as { scope: unknown; at: string; firstDispatch: { operationId: string } };
    f.t.db.set({ ...task, budgetPause: { ...pause, firstDispatch: { ...pause.firstDispatch, readOnly: true } } });
  };
  let changed = timing === "before_decision"; if (changed) mutate();
  const send = f.t.db.send.bind(f.t.db);
  f.t.db.send = async command => {
    if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === `DEVTASK#${started.taskId}` && item.Update.ExpressionAttributeValues?.[":spendingStop"] !== undefined)) { changed = true; mutate(); }
    return send(command);
  };
  await expect(f.t.decide(MAYA, record.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" }); expect(changed).toBe(true);
  expect(f.t.meta(started.taskId).budgetUsd).toBe(0);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" })).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
});

it("a max-per-run ask retains distinct original/proposed run limit, per-run stop and window facts", async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const agentKeyOf = agentKey(TEST_ORG, f.agentId, "META");
  f.t.db.set({ ...f.t.db.get(agentKeyOf)!, revision: 2, stopKind: "limited", maxPerRunUsd: 4 });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 4 });
  const inherited: Record<string, unknown> = { ...f.t.db.get(agentKeyOf)!, revision: 3, stopKind: "inherit" }; delete inherited.maxPerRunUsd; f.t.db.set(inherited);
  await f.t.pauseAndEnd(f.task, { kind: "max_per_run", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "max_per_run")[0]!; expect(request.newLimitUsd).toBe(9);
  expect(request.approvalTerms).toMatchObject({ operation: "max_per_run", askedFiguresMicrousd: { budget: 4_000_000, maxPerRun: 4_000_000, baseline: 0, amount: 5_000_000 },
    proposedFiguresMicrousd: { budget: 4_000_000, maxPerRun: 9_000_000, window: "keep" } });
});

it("a max-per-run approval above the existing run limit keeps its exact window while the follow-up approval is pending", async () => {
  const f = await pausedTestTransition();
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const agentKeyOf = agentKey(TEST_ORG, f.agentId, "META");
  f.t.db.set({ ...f.t.db.get(agentKeyOf)!, revision: 2, stopKind: "limited", maxPerRunUsd: 4 });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 4 });
  const inherited: Record<string, unknown> = { ...f.t.db.get(agentKeyOf)!, revision: 3, stopKind: "inherit" }; delete inherited.maxPerRunUsd; f.t.db.set(inherited);
  await f.t.pauseAndEnd(f.task, { kind: "max_per_run", taskId: f.task.taskId });

  const request = f.t.requestOf(f.task.taskId, "max_per_run")[0]!, operations = f.t.taskOps(f.task.workspaceId).map(operation => operation.id);
  expect((await f.t.decide(ADA, request.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 9, spendingStop: { effectiveStopMicrousd: 4_000_000, calculationInput: { approvedMaxPerRunMicrousd: 9_000_000 } } });
  const followUp = f.t.requestOf(f.task.taskId, "run_limit").find(record => record.status === "PENDING")!; expect(followUp.newLimitUsd).toBe(9);
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(f.t.taskOps(f.task.workspaceId).map(operation => operation.id)).toEqual(operations);
  expect((await f.t.decide(MAYA, followUp.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 9, maxPerRunUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000 } });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
});

it("an approved per-run raise within the original run limit commits its exact cap and resumes without another ask", async () => {
  const f = await pausedTestTransition(undefined, true);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const agentKeyOf = agentKey(TEST_ORG, f.agentId, "META");
  f.t.db.set({ ...f.t.db.get(agentKeyOf)!, revision: 2, stopKind: "limited", maxPerRunUsd: 4 });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 4 });
  const inherited: Record<string, unknown> = { ...f.t.db.get(agentKeyOf)!, revision: 3, stopKind: "inherit" }; delete inherited.maxPerRunUsd; f.t.db.set(inherited);
  await f.t.pauseAndEnd(f.task, { kind: "max_per_run", taskId: f.task.taskId });

  const request = f.t.requestOf(f.task.taskId, "max_per_run")[0]!;
  expect(request.approvalTerms).toMatchObject({ askedFiguresMicrousd: { budget: 4_000_000, runLimit: 14_000_000, maxPerRun: 4_000_000 }, proposedFiguresMicrousd: { budget: 9_000_000, runLimit: 14_000_000, maxPerRun: 9_000_000, window: "keep" } });
  const operations = f.t.taskOps(f.task.workspaceId).map(operation => operation.id), send = f.t.db.send.bind(f.t.db); let captures = 0;
  f.t.db.send = async command => { if (command instanceof TransactGetCommand) captures += 1; return send(command); };
  expect((await f.t.decide(ADA, request.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 9, maxPerRunUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000, calculationInput: { pathLimitMicrousd: 14_000_000, approvedMaxPerRunMicrousd: 9_000_000 } } });
  expect(f.t.requestOf(f.task.taskId, "run_limit").filter(record => record.status === "PENDING")).toHaveLength(0);
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1); expect(captures).toBe(1);
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
});

it("a later run-limit approval retains the already approved task per-run stop", async () => {
  const f = await pausedTestTransition(undefined, true);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const agentKeyOf = agentKey(TEST_ORG, f.agentId, "META");
  f.t.db.set({ ...f.t.db.get(agentKeyOf)!, revision: 2, stopKind: "limited", maxPerRunUsd: 4 });
  expect((await f.transition()).status).toBe(200); expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 4 });
  const inherited: Record<string, unknown> = { ...f.t.db.get(agentKeyOf)!, revision: 3, stopKind: "inherit" }; delete inherited.maxPerRunUsd; f.t.db.set(inherited);
  await f.t.pauseAndEnd(f.task, { kind: "max_per_run", taskId: f.task.taskId });

  const request = f.t.requestOf(f.task.taskId, "max_per_run")[0]!;

  expect((await f.t.decide(ADA, request.spendRequestId)).spendRequest.status).toBe("APPROVED");
  await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const runRequest = f.t.requestOf(f.task.taskId, "run_limit").find(record => record.status === "PENDING")!; expect(runRequest.newLimitUsd).toBe(14);
  expect(runRequest.approvalTerms).toMatchObject({ proposedFiguresMicrousd: { budget: 9_000_000, runLimit: 14_000_000, maxPerRun: 9_000_000 } });
  const operations = f.t.taskOps(f.task.workspaceId).map(operation => operation.id);
  expect((await f.t.decide(BEN, runRequest.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 9, maxPerRunUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000, calculationInput: { approvedRunLimitMicrousd: 14_000_000, committedMaxPerRunMicrousd: 9_000_000 } } });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
});

async function hardRequestedTask() {
  const f = await fixture(), agentId = await f.t.agentOf(TRIAGE), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId }, input: { text: "Look at the new ticket" }, origin: "app", runLimitUsd: 5,
    owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: { kind: "member", developerId: MAYA.developerId } });
  const workspaceId = f.t.meta(started.taskId).workspaceId;
  await f.t.finish(workspaceId, f.t.operations(workspaceId).find(operation => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
  const task = { taskId: started.taskId, workspaceId };
  expect(f.t.meta(task.taskId)).toMatchObject({ budgetUsd: 4, spendingStop: { calculationInput: { requestedMicrousd: 5_000_000 } } });
  return { ...f, task };
}
it("a later approval cannot silently discard the accepted hard requested bound", async () => {
  const f = await hardRequestedTask(); await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const request = f.t.requestOf(f.task.taskId, "run_limit")[0]!, before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(operation => operation.id); expect(request.newLimitUsd).toBe(9);
  await expect(f.t.decide(MAYA, request.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.meta(f.task.taskId)).toEqual(before); expect(f.t.taskOps(f.task.workspaceId).map(operation => operation.id)).toEqual(operations);
});
it("removing a non-binding saved requested bound invalidates its captured digest", async () => {
  const f = await hardRequestedTask(), saved = f.t.meta(f.task.taskId).spendingStop as { calculationInput: Record<string, unknown> };
  const input = { ...saved.calculationInput }; delete input.requestedMicrousd;
  expect(checkedTaskStopSnapshot(saved).effectiveStopMicrousd).toBe(4_000_000);
  expect(() => checkedTaskStopSnapshot({ ...saved, calculationInput: input })).toThrow("TASK_STOP_CONFIG_INVALID");
});

it("approval at the exact accepted requested bound remains valid and resumes once", async () => {
  const f = await hardRequestedTask(); await f.t.pauseAndEnd(f.task, { kind: "task", taskId: f.task.taskId });
  const original = f.t.requestOf(f.task.taskId, "run_limit")[0]!; await f.t.decide(MAYA, original.spendRequestId, "DENY");
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId: f.task.taskId, kind: "run_limit", scope: { kind: "task", taskId: f.task.taskId }, amountUsd: 1, newLimitUsd: 5,
    requestedBy: { kind: "member", developerId: MAYA.developerId }, requestedFor: { developerId: MAYA.developerId }, resume: "continue", reason: "Finish within the accepted five-dollar bound." });
  const operations = f.t.taskOps(f.task.workspaceId).map(operation => operation.id);
  expect((await f.t.decide(MAYA, record.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 5, spendingStop: { effectiveStopMicrousd: 5_000_000, calculationInput: { requestedMicrousd: 5_000_000, approvedRunLimitMicrousd: 5_000_000 } } });
  expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
  await escalateOwnerRequests(f.t.deps(), { budgetMs: 5000 }); expect(f.t.taskOps(f.task.workspaceId)).toHaveLength(operations.length + 1);
});
it("saved admission digest verification tolerates stored map key reordering", async () => {
  const f = await hardRequestedTask(), saved = checkedTaskStopSnapshot(f.t.meta(f.task.taskId).spendingStop);
  const reordered = { ...saved, calculationInput: Object.fromEntries(Object.entries(saved.calculationInput).reverse()), sourceRevisions: Object.fromEntries(Object.entries(saved.sourceRevisions).reverse()) };
  expect(checkedTaskStopSnapshot(reordered)).toEqual(saved);
});

for (const source of ["valid", "max_source", "missing_before", "changed_before"] as const) it(`Continue retains the approved task per-run stop and native ${source} source`, async () => {
  const f = await fixture();
  f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  f.t.db.set({ ...f.t.db.get(f.agent)!, revision: 2, stopKind: "limited", maxPerRunUsd: 4 });
  const task = await f.t.plainTask();
  const settings: Record<string, unknown> = { ...f.t.db.get(f.agent)!, revision: 3, stopKind: "inherit" }; delete settings.maxPerRunUsd; f.t.db.set(settings);
  await f.t.pauseAndEnd(task, { kind: "max_per_run", taskId: task.taskId });
  const request = f.t.requestOf(task.taskId, "max_per_run")[0]!; await f.t.decide(ADA, request.spendRequestId);
  expect(f.t.meta(task.taskId)).toMatchObject({ budgetUsd: 9, maxPerRunUsd: 9 });
  await f.t.finish(task.workspaceId, f.t.taskOps(task.workspaceId).at(-1)!.id, "SUCCEEDED");
  if (source === "missing_before") { const current = { ...f.t.meta(task.taskId) }; delete current.maxPerRunUsd; f.t.db.set(current); }
  if (source === "changed_before") f.t.db.set({ ...f.t.meta(task.taskId), maxPerRunUsd: 12 });
  const send = f.t.db.send.bind(f.t.db), requestId = randomUUID(), operations = f.t.taskOps(task.workspaceId).map(operation => operation.id); let changed = false;
  f.t.db.send = async command => {
    if (source === "max_source" && !changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "OPERATION" && item.Put.Item.kind === "task" && item.Put.Item.workspaceId === task.workspaceId)) { changed = true; f.t.db.set({ ...f.t.meta(task.taskId), maxPerRunUsd: 12 }); }
    return send(command);
  };
  const reply = await f.t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { requestId, instructions: "Continue within the approved per-run stop." });
  if (source === "valid") {
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(f.t.meta(task.taskId)).toMatchObject({ budgetUsd: 9, maxPerRunUsd: 9, spendingStop: { effectiveStopMicrousd: 9_000_000, calculationInput: { committedMaxPerRunMicrousd: 9_000_000 } } });
  } else {
    expect(changed).toBe(source === "max_source"); expect(reply.status).toBe(409); expect(reply.body.error).toMatchObject({ code: source === "max_source" ? "CHANGE_STALE" : "TASK_STOP_CONFIG_INVALID" });
    expect(f.t.taskOps(task.workspaceId).map(operation => operation.id)).toEqual(operations); expect(f.t.meta(task.taskId).maxPerRunUsd).toBe(source === "missing_before" ? undefined : 12);
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${requestId}` })).toBeUndefined();
  }
});
it("a new payer window retains an existing task per-run stop when current agent settings inherit", async () => {
  const f = await pausedTestTransition(undefined, true, 4), key = agentKey(TEST_ORG, f.agentId, "META");
  const settings: Record<string, unknown> = { ...f.t.db.get(key)!, revision: 2, stopKind: "inherit" }; delete settings.maxPerRunUsd; f.t.db.set(settings);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 3, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
  f.t.db.set({ ...f.t.db.get(agentGuardrailsKey(TEST_ORG))!, revision: 2, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 20 } });
  expect(f.t.meta(f.task.taskId).maxPerRunUsd).toBe(4); expect((await f.transition()).status).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 4, maxPerRunUsd: 4, spendingStop: { effectiveStopMicrousd: 4_000_000, calculationInput: { committedMaxPerRunMicrousd: 4_000_000 } } });
});

for (const corruption of ["valid", "cap", "baseline", "reference", "receipt"] as const) it(`model key issuance checks the immutable admitted window: ${corruption}`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!;
  const stored = f.t.meta(task.taskId), reference = stored.spendingAdmission as { requestId: string };
  if (corruption === "cap") f.t.db.set({ ...stored, budgetUsd: 100 });
  if (corruption === "baseline") f.t.db.set({ ...stored, budgetBaselineUsd: 100 });
  if (corruption === "reference") { const changed = { ...stored }; delete changed.spendingAdmission; f.t.db.set(changed); }
  if (corruption === "receipt") f.t.db.delete({ pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${reference.requestId}` });
  f.t.db.delete(f.policy);
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).toBe(corruption === "valid" ? 200 : 409);
  expect(f.t.access.mintedKeys().length).toBe(before + (corruption === "valid" ? 1 : 0));
});

it("model key record refuses a competing admitted cap write and returns no key", async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true; f.t.db.set({ ...f.t.meta(task.taskId), budgetUsd: 100 });
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(raced).toBe(true); expect(reply.status).not.toBe(200);
  expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined();
  expect(f.t.access.blockKey).toHaveBeenCalledTimes(1);
});

for (const change of ["terminal", "fence"] as const) it(`key recording refuses a competing operation ${change} write`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true; const op = f.t.db.get(operationKey(task.workspaceId, plan.id))!;
      f.t.db.set({ ...op, ...(change === "terminal" ? { status: "SUCCEEDED" } : { fence: Number(op.fence) + 1 }) });
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(raced).toBe(true); expect(reply.status).not.toBe(200);
  expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1);
});

for (const change of ["closing", "member", "project"] as const) it(`key recording refuses competing live authority loss: ${change}`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true;
      if (change === "closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG))!, closingAt: new Date().toISOString() });
      if (change === "member") f.t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
      if (change === "project") f.t.db.set({ ...f.t.db.get(projectMetaKey(TEST_ORG, "payments"))!, ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived" });
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(raced).toBe(true); expect(reply.status).not.toBe(200);
  expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1);
});

for (const change of ["archive", "roster"] as const) it(`key recording refuses competing agent ${change} loss`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true;
      if (change === "archive") f.t.db.set({ ...f.t.db.get(key)!, status: "archived" });
      else f.t.db.delete(projectAgentKey(TEST_ORG, "payments", agentId));
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(raced).toBe(true); expect(reply.status).not.toBe(200);
  expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1);
});

it("initial and planned operations retain their admitted task window reference", async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), reference = f.t.meta(task.taskId).spendingAdmission;
  const operations = f.t.db.find(row => row.entityType === "OPERATION" && row.workspaceId === task.workspaceId);
  expect(operations.length).toBeGreaterThanOrEqual(2);
  for (const operation of operations) expect(operation).toMatchObject({ spendingTaskId: task.taskId, spendingAdmission: reference });
});
it("removing both task admission fields cannot downgrade an admitted operation to legacy key minting", async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, changed = { ...f.t.meta(task.taskId) };
  delete changed.spendingStop; delete changed.spendingAdmission; f.t.db.set(changed);
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).not.toBe(200); expect(f.t.access.mintedKeys().length).toBe(before);
});

it("a prior window callback cannot adopt a valid newly admitted Continue window", async () => {
  const f = await continueWindow(); expect((await f.continue()).status).toBe(200);
  const current = f.t.taskOps(f.task.workspaceId).at(-1)!, currentRow = f.t.db.get(operationKey(f.task.workspaceId, current.id))!;
  expect(currentRow).toMatchObject({ spendingTaskId: f.task.taskId, spendingAdmission: f.t.meta(f.task.taskId).spendingAdmission });
  const prior = f.t.db.get(operationKey(f.task.workspaceId, f.task.operationId))!;
  // A platform restore must retain the old operation's admitted window.
  f.t.db.set({ ...prior, status: "RUNNING" });
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(f.task.operationId)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).not.toBe(200); expect(f.t.access.mintedKeys().length).toBe(before);
});

for (const loss of ["pointer", "task", "pointer_race"] as const) it(`an admitted operation refuses lost task binding: ${loss}`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  if (loss === "pointer") f.t.db.delete(taskPointerKey(task.workspaceId));
  if (loss === "task") f.t.db.delete(taskKey(task.taskId));
  f.t.db.send = async command => {
    if (loss === "pointer_race" && !raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true; f.t.db.delete(taskPointerKey(task.workspaceId));
    }
    return send(command);
  };
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).not.toBe(200);
  if (loss === "pointer_race") { expect(raced).toBe(true); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1); expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); }
  else expect(f.t.access.mintedKeys().length).toBe(before);
});

for (const change of ["operation_org", "operation_id", "task_workspace", "route_between_reads"] as const) it(`model keys refuse contradictory admitted scope identity: ${change}`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, opKey = operationKey(task.workspaceId, plan.id), stored = f.t.db.get(opKey)!;
  if (change === "operation_org") f.t.db.set({ ...stored, orgId: "org_00000000000000000000" });
  if (change === "operation_id") f.t.db.set({ ...stored, id: randomUUID() });
  if (change === "task_workspace") f.t.db.set({ ...f.t.meta(task.taskId), workspaceId: randomUUID() });
  const send = f.t.db.send.bind(f.t.db); let reads = 0;
  f.t.db.send = async command => {
    if (change === "route_between_reads" && command instanceof GetCommand && command.input.Key?.pk === opKey.pk && command.input.Key.sk === opKey.sk && ++reads === 2) f.t.db.set({ ...f.t.db.get(opKey)!, modelRoute: null });
    return send(command);
  };
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  if (change === "route_between_reads") expect(reads).toBeGreaterThanOrEqual(2);
  expect(reply.status).not.toBe(200); expect(f.t.access.mintedKeys().length).toBe(before);
});

it("native key recording holds the actual currentOwner across a takeover race", async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true;
      f.t.db.set({ ...f.t.meta(task.taskId), currentOwner: { developerId: BEN.developerId, name: "Ben", provider: "oidc", since: new Date().toISOString() } });
      f.t.db.delete(orgMemberKey(TEST_ORG, BEN.developerId));
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(raced).toBe(true); expect(reply.status).not.toBe(200);
  expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1);
});

for (const state of ["ownerless", "ownerless_race"] as const) it(`model keys retain canonical task-people work authority: ${state}`, async () => {
  const f = await fixture(), agentId = await f.t.agentOf(CODING), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId), plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db);
  const people = { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: true, people: [] };
  if (state === "ownerless") f.t.db.set(people);
  let raced = false;
  f.t.db.send = async command => {
    if (state === "ownerless_race" && !raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true; f.t.db.set(people);
    }
    return send(command);
  };
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).not.toBe(200);
  if (state === "ownerless") expect(f.t.access.mintedKeys().length).toBe(before);
  else { expect(raced).toBe(true); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1); expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); }
});

for (const state of ["valid", "lost_at_commit", "share_at_commit"] as const) it(`a real registered PEOPLE owner retains model-key work authority: ${state}`, async () => {
  const slackUserId = "U0M47PPL1", creator = { developerId: developerIdForSlackUser(slackUserId), name: "Maya Chen", provider: "slack" as const, sessionId: randomUUID(), slackUserId };
  const f = await fixture(1_234_567, { developerExtra: {
    taskPeopleConfiguration: { peopleChangesEnabled: true },
    taskPersonProof: async input => ({ ok: true, user: { id: input.slackUserId, teamId: SLACK_TEAM, name: creator.name }, memberOf: input.channelIds.filter(id => id === SLACK_CHANNEL) }),
    taskPeopleDisplayRead: async input => input.operation === "proof"
      ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
        user: { id: input.request.slackUserId, teamId: SLACK_TEAM, name: creator.name }, memberOf: input.request.channelIds } }
      : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
        users: [{ id: slackUserId, teamId: SLACK_TEAM, name: creator.name, memberOf: input.request.channelIds }] } },
  } });
  await f.t.orgOf(creator); f.t.grantRole(creator, "maintainer");
  f.t.db.set({ pk: `DEVELOPER#${creator.developerId}`, sk: "META", developerId: creator.developerId, provider: creator.provider,
    displayName: creator.name, slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  const started = await f.t.handler({ source: "agentx.slack-ingress", action: "start-workflow",
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000047" }, userId: slackUserId,
    instructions: "Verify the registered task owner", workflowPath: "QUICK", requestId: randomUUID() });
  expect(started.statusCode).toBe(200);
  const taskId = (JSON.parse(started.body) as { taskId: string }).taskId, workspaceId = String(f.t.meta(taskId).workspaceId);
  const listed = await f.t.handler({ source: "agentx.slack-ingress", action: "task-people-read", taskId,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000047" }, userId: slackUserId });
  expect(listed.statusCode, listed.body).toBe(200);
  const peopleKey = { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }, people = f.t.db.get(peopleKey)!;
  expect(people).toMatchObject({ orphaned: false, people: [{ developerId: creator.developerId, role: "owner" }] });
  const prepare = f.t.operations(workspaceId).find(op => op.kind === "prepare")!;
  await f.t.finish(workspaceId, prepare.id, "SUCCEEDED", PREPARED);
  const plan = f.t.taskOps(workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (state !== "valid" && !raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      raced = true;
      if (state === "lost_at_commit") f.t.db.set({ ...people, revision: Number(people.revision) + 1, orphaned: true, people: [] });
      else {
        const current = f.t.meta(taskId), share = current.share as Record<string, unknown>;
        f.t.db.set({ ...current, share: { ...share, channelId: "C0M47ALT1" }, shareVersion: Number(current.shareVersion ?? 0) + 1 });
      }
    }
    return send(command);
  };
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  expect(reply.status).toBe(state === "valid" ? 200 : 503);
  if (state !== "valid") { expect(raced).toBe(true); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1); expect(f.t.meta(taskId).modelKeyIds).toBeUndefined(); }
});

for (const state of ["valid", "revoked", "revoked_at_commit"] as const) it(`registered OIDC PEOPLE identity remains current for model keys: ${state}`, async () => {
  const issuer = "https://company-identity.example.com", subject = "m47-registered-owner", slackUserId = "U0M47OID1";
  const creator = { developerId: ownerKeyForSubject(issuer, subject), name: "Maya Company", provider: "oidc" as const, sessionId: randomUUID(), slackUserId };
  const f = await fixture(1_234_567, { developerExtra: {
    taskPeopleConfiguration: { peopleChangesEnabled: true },
    taskPersonProof: async input => ({ ok: true, user: { id: input.slackUserId, teamId: SLACK_TEAM, name: creator.name }, memberOf: input.channelIds }),
    taskPeopleDisplayRead: async input => input.operation === "proof"
      ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
        user: { id: input.request.slackUserId, teamId: SLACK_TEAM, name: creator.name }, memberOf: input.request.channelIds } }
      : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
        users: [{ id: slackUserId, teamId: SLACK_TEAM, name: creator.name, memberOf: input.request.channelIds }] } },
  } });
  await f.t.orgOf(creator); f.t.grantRole(creator, "maintainer");
  const identityKey = { pk: `DEVELOPER#${creator.developerId}`, sk: "META" };
  f.t.db.set({ ...identityKey, developerId: creator.developerId, provider: creator.provider, issuer, subject, displayName: creator.name,
    slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  f.t.db.set({ pk: `SESSION#${creator.sessionId}`, sk: "META", sessionId: creator.sessionId, developerId: creator.developerId, amr: creator.provider,
    startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600 });
  const agentId = await f.t.agentOf(CODING, { by: creator }), agent = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(agent)!, revision: 1, stopKind: "inherit" });
  const task = await f.t.runOf(agentId, { who: creator });
  expect((await f.t.dev(creator, "POST", `/v1/dev/tasks/${task.taskId}/share`, { requestId: randomUUID() })).status).toBe(200);
  expect((await f.t.dev(creator, "GET", `/v1/dev/tasks/${task.taskId}/people`)).status).toBe(200);
  expect(f.t.db.get(`DEVTASK#${task.taskId}`, "PEOPLE")).toMatchObject({ orphaned: false, people: [{ developerId: creator.developerId, role: "owner" }] });
  if (state === "revoked") f.t.db.set({ ...f.t.db.get(identityKey)!, revoked: true });
  const plan = f.t.taskOps(task.workspaceId).at(-1)!, send = f.t.db.send.bind(f.t.db); let raced = false;
  let identityTable: string | undefined;
  f.t.db.send = async command => {
    if (command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.ExpressionAttributeNames?.["#ids"] === "modelKeyIds")) {
      identityTable = command.input.TransactItems.find(item => item.ConditionCheck?.Key?.pk === identityKey.pk && item.ConditionCheck.Key.sk === identityKey.sk)?.ConditionCheck?.TableName;
      if (state === "revoked_at_commit" && !raced) { raced = true; f.t.db.set({ ...f.t.db.get(identityKey)!, revoked: true }); }
    }
    return send(command);
  };
  const before = f.t.access.mintedKeys().length;
  const reply = await call(f.t.handler, { method: "GET", path: "/v1/internal/model-access", headers: {
    "x-agentx-callback-capability": (f.t.outboxOf(plan.id)!.invocation as { callbackCapability: string }).callbackCapability } });
  if (state !== "revoked") expect(identityTable).toBe("signin");
  if (state === "valid") expect(reply.status).toBe(200);
  else {
    expect(reply.status).not.toBe(200);
    if (state === "revoked") expect(f.t.access.mintedKeys().length).toBe(before);
    else { expect(raced).toBe(true); expect(f.t.access.blockKey).toHaveBeenCalledTimes(1); expect(f.t.meta(task.taskId).modelKeyIds).toBeUndefined(); }
  }
});

it("spending-rule expiry commits an immutable terminal receipt and replays it without money", async () => {
  const f = await approvalWindow("company"), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "EXPIRY" };
  const before = f.t.meta(f.task.taskId), operations = f.t.taskOps(f.task.workspaceId).map(op => op.id);
  await expect(f.t.decide(MAYA, f.spendRequest.spendRequestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  const receipt = f.t.db.get(key);
  expect(receipt).toMatchObject({ entityType: "SPEND_REQUEST_EXPIRY", version: 1, orgId: TEST_ORG, spendRequestId: f.spendRequest.spendRequestId,
    kind: "run_limit", status: "EXPIRED", reason: "spending_rules_changed", actor: { kind: "system" } });
  expect(receipt?.termsDigest).toMatch(/^[a-f0-9]{64}$/);
  await expect(f.t.decide(MAYA, f.spendRequest.spendRequestId)).rejects.toBeDefined();
  expect(f.t.db.get(key)).toEqual(receipt); expect(f.t.meta(f.task.taskId)).toEqual(before);
  expect(f.t.taskOps(f.task.workspaceId).map(op => op.id)).toEqual(operations);
});
it("a terminal expiry receipt conflict rolls back request expiry and keeps the pending ask", async () => {
  const f = await approvalWindow("company"), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "EXPIRY" };
  f.t.db.set({ ...key, entityType: "TEST_CONFLICT", sentinel: true });
  const before = f.t.meta(f.task.taskId);
  await expect(f.t.decide(MAYA, f.spendRequest.spendRequestId)).rejects.toBeDefined();
  expect(f.t.db.get({ ...key, sk: "META" })).toMatchObject({ status: "PENDING" });
  expect(f.t.db.get(key)).toMatchObject({ sentinel: true }); expect(f.t.meta(f.task.taskId)).toEqual(before);
});
it("expiry cannot attribute a terminal receipt to request terms that changed at commit", async () => {
  const f = await approvalWindow("company"), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${f.spendRequest.spendRequestId}`), sk: "META" }, send = f.t.db.send.bind(f.t.db); let raced = false;
  const winningLimit = (f.spendRequest.newLimitUsd ?? 0) + 1;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("EXPIRED"))) {
      raced = true; f.t.db.set({ ...f.t.db.get(key)!, newLimitUsd: winningLimit });
    }
    return send(command);
  };
  await expect(f.t.decide(MAYA, f.spendRequest.spendRequestId)).rejects.toBeDefined();
  expect(raced).toBe(true); expect(f.t.db.get(key)).toMatchObject({ status: "PENDING", newLimitUsd: winningLimit });
  expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toBeUndefined();
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const race of [false, true]) it(`owner-cap ${resource} ${operation} retains exactly one actual decider fence: race=${race}`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const actorKey = orgMemberKey(TEST_ORG, DEB.developerId), send = f.t.db.send.bind(f.t.db); let checked = false;
  f.t.db.send = async command => {
    if (!checked && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      checked = true;
      const actualActorChecks = command.input.TransactItems.filter(item => item.ConditionCheck?.Key?.pk === actorKey.pk && item.ConditionCheck.Key.sk === actorKey.sk);
      expect(actualActorChecks).toHaveLength(1);
      if (race) {
        for (const key of [actorKey, developerOrgKey(DEB.developerId)]) f.t.db.set({ ...f.t.db.get(key)!, role: "member" });
      }
    }
    return send(command);
  };
  const decision = f.t.decide(DEB, requestId);
  if (race) {
    await expect(decision).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })).toMatchObject({ status: "PENDING" });
  } else {
    expect((await decision).spendRequest.status).toBe("APPROVED"); expect(f.t.ownerTotal(BEN)).toBe(120);
  }
  expect(checked).toBe(true);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} refuses destination removal at native commit`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const actorKey = orgMemberKey(TEST_ORG, BEN.developerId), send = f.t.db.send.bind(f.t.db); let checked = false;
  f.t.db.send = async command => {
    if (!checked && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      checked = true;
      for (const key of [actorKey, developerOrgKey(BEN.developerId)]) f.t.db.delete(key);
    }
    return send(command);
  };
  await expect(f.t.decide(DEB, requestId)).rejects.toBeDefined();
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })?.status).not.toBe("APPROVED");
  expect(checked).toBe(true);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["accountable"] as readonly ("owner" | "accountable")[]) it(`owner-cap ${resource} ${operation} refuses destination project grant loss at native commit`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const send = f.t.db.send.bind(f.t.db); let checked = false;
  f.t.db.send = async command => {
    if (!checked && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      checked = true;
      const key = projectMemberKey(TEST_ORG, BEN.developerId, "payments"); f.t.db.set({ ...f.t.db.get(key)!, projectRole: "contributor" });
    }
    return send(command);
  };
  await expect(f.t.decide(DEB, requestId)).rejects.toBeDefined();
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })?.status).not.toBe("APPROVED");
  expect(checked).toBe(true);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const race of [false]) it(`owner-cap ${resource} ${operation} deduplicates destination equal to the actual decider`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, DEB); await f.t.budgeted(40, DEB);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: DEB.developerId } } : { accountable: { developerId: DEB.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(DEB);
  const actorKey = orgMemberKey(TEST_ORG, DEB.developerId), send = f.t.db.send.bind(f.t.db); let checked = false;
  f.t.db.send = async command => {
    if (!checked && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      checked = true;
      const actualActorChecks = command.input.TransactItems.filter(item => item.ConditionCheck?.Key?.pk === actorKey.pk && item.ConditionCheck.Key.sk === actorKey.sk);
      expect(actualActorChecks).toHaveLength(1);
      if (race) {
        for (const key of [actorKey, developerOrgKey(DEB.developerId)]) f.t.db.set({ ...f.t.db.get(key)!, role: "member" });
      }
    }
    return send(command);
  };
  const decision = f.t.decide(DEB, requestId);
  if (race) {
    await expect(decision).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(DEB)).toBe(totalBefore);
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })).toMatchObject({ status: "PENDING" });
  } else {
    expect((await decision).spendRequest.status).toBe("APPROVED"); expect(f.t.ownerTotal(DEB)).toBe(120);
  }
  expect(checked).toBe(true);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} refuses changed original counted destination total`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  await f.t.budgeted(1, BEN);
  await expect(f.t.decide(DEB, requestId)).rejects.toBeDefined();
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore + 1);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })?.status).not.toBe("APPROVED");
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} refuses original request terms changed at native approval commit`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const requestKey = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" }, send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      raced = true; const request = f.t.db.get(requestKey)!;
      f.t.db.set({ ...request, ownerFinancialTerms: { ...(request.ownerFinancialTerms as Record<string, unknown>), totalUsd: 81 } });
    }
    return send(command);
  };
  await expect(f.t.decide(DEB, requestId)).rejects.toBeDefined();
  expect(raced).toBe(true); expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })?.status).not.toBe("APPROVED");
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const mutation of ["policy_before", "policy_commit", "counter_commit"] as const) it(`owner-cap ${resource} ${operation} pins captured financial authority: ${mutation}`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const send = f.t.db.send.bind(f.t.db); let raced = false;
  const mutate = () => {
    if (mutation === "counter_commit") {
      const key = ownerBudgetKey(TEST_ORG, BEN.developerId), row = f.t.db.get(key)!;
      f.t.db.set({ ...row, version: Number(row.version) + 1, totalUsd: totalBefore + 1 });
    } else {
      const key = orgSettingsKey(TEST_ORG, "SPEND_POLICY");
      f.t.db.set({ ...key, orgId: TEST_ORG, entityType: "SPEND_POLICY", ...defaultSpendPolicy(), revision: 1, ownerAgentBudgetCapUsd: 99 });
    }
  };
  if (mutation === "policy_before") { raced = true; mutate(); }
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) { raced = true; mutate(); }
    return send(command);
  };
  await expect(f.t.decide(DEB, requestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(raced).toBe(true); expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore + (mutation === "counter_commit" ? 1 : 0));
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })?.status).not.toBe("APPROVED");
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} keeps native approval proofs out of the public view`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const record = f.t.requests().find(item => item.spendRequestId === requestId)!;
  expect(record.ownerFinancialTerms).toBeDefined(); expect(record.approvalSource).toBeDefined();
  const shown = spendRequestView({ now: Date.now, confirmOrigin: "https://example.test" }, record, { orgRole: "admin" });
  expect(shown.reason).toBe(record.reason); expect(shown.amountUsd).toBe(record.amountUsd);
  expect(shown).not.toHaveProperty("ownerFinancialTerms"); expect(shown).not.toHaveProperty("approvalSource"); expect(shown).not.toHaveProperty("approvalTerms");
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const field of ["maxPerRunUsd", "revision"] as const) it(`owner-cap ${resource} ${operation} keeps initial source ${field} while asking`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, counterKey = ownerBudgetKey(TEST_ORG, BEN.developerId), send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    const result = await send(command);
    if (!raced && command instanceof GetCommand && command.input.Key?.pk === counterKey.pk && command.input.Key.sk === counterKey.sk) {
      raced = true; const row = f.t.db.get(entityKey)!;
      f.t.db.set({ ...row, [field]: field === "maxPerRunUsd" ? 0.5 : Number(row.revision ?? 0) + 1 });
    }
    return result;
  };
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(raced).toBe(true); expect(ask.status).toBe(409);
  expect(f.t.requests().some(item => item.agentId === id || item.chainId === id)).toBe(false);
});

it("legacy spending-request cutover expires bounded pages with terminal receipts and never enrolls", async () => {
  expect(spendRequests).toHaveProperty("expireLegacySpendingRequests");
  const expire = (spendRequests as unknown as { expireLegacySpendingRequests: (deps: ReturnType<Awaited<ReturnType<typeof fixture>>["t"]["deps"]>, input: { orgId: typeof TEST_ORG; limit: number; cursor?: Record<string, unknown> }) => Promise<{ examined: number; expired: number; complete: boolean; cursor?: Record<string, unknown> }> }).expireLegacySpendingRequests;
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const ids: string[] = [];
  for (const kind of ["run_limit", "max_per_run", "planning", "owner_cap"] as const) {
    const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind, taskId, agentId: ROVARA_CODE_AGENT_ID,
      scope: { kind: "task", taskId }, amountUsd: 1, newLimitUsd: 5, reason: "Legacy stop ask", requestedBy: { kind: "member", developerId: MAYA.developerId },
      ...(kind === "owner_cap" ? { change: { op: "set_budget" as const, budget: { monthlyUsd: 5 } } } : {}) });
    ids.push(record.spendRequestId);
    const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" };
    const { approvalTerms: _taskTerms, ownerFinancialTerms: _ownerTerms, approvalSource: _source, ...legacy } = f.t.db.get(key)!;
    void _taskTerms; void _ownerTerms; void _source; f.t.db.set(legacy);
  }
  const before = f.t.meta(taskId), policy = f.t.db.get(f.policy), operations = f.t.taskOps(before.workspaceId).map(item => item.id);
  const first = await expire(f.t.deps(), { orgId: TEST_ORG, limit: 2 });
  expect(first).toMatchObject({ examined: 2, expired: 2, complete: false }); expect(first.cursor).toBeDefined();
  const second = await expire(f.t.deps(), { orgId: TEST_ORG, limit: 2, cursor: first.cursor! });
  expect(second).toMatchObject({ examined: 2, expired: 2, complete: true });
  for (const id of ids) {
    const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${id}`), sk: "META" };
    expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
    expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toMatchObject({ reason: "spending_rules_changed", actor: { kind: "system" } });
  }
  expect(await expire(f.t.deps(), { orgId: TEST_ORG, limit: 2 })).toMatchObject({ examined: 0, expired: 0, complete: true });
  expect(f.t.meta(taskId)).toEqual(before); expect(f.t.db.get(f.policy)).toEqual(policy); expect(f.t.taskOps(before.workspaceId).map(item => item.id)).toEqual(operations);
});

it("legacy ask expiry preserves complete modern asks and monthly-room requests", async () => {
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const modern = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, kind: "run_limit", scope: { kind: "task", taskId }, amountUsd: 1, newLimitUsd: 5, reason: "Modern ask", requestedBy: { kind: "member", developerId: MAYA.developerId } })).record;
  const monthly = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, kind: "month", scope: { kind: "org" }, amountUsd: 1, newLimitUsd: 5, reason: "Monthly room", requestedBy: { kind: "member", developerId: MAYA.developerId } })).record;
  expect(modern.approvalTerms).toBeDefined();
  const before = [modern, monthly].map(record => f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" }));
  expect(await spendRequests.expireLegacySpendingRequests(f.t.deps(), { orgId: TEST_ORG, limit: 100 })).toMatchObject({ examined: 2, expired: 0, complete: true });
  expect([modern, monthly].map(record => f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" }))).toEqual(before);
});
for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 2, cursor: { pk: "OTHER_ORG", sk: "x" } }, { limit: 2, cursor: { pk: "OTHER_ORG", sk: "x", injected: true } }]) it(`legacy ask expiry refuses invalid page authority ${JSON.stringify(input)}`, async () => {
  const f = await fixture();
  await expect(spendRequests.expireLegacySpendingRequests(f.t.deps(), { orgId: TEST_ORG, ...input })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

for (const laterPage of [false, true]) it(`legacy expiry retries its original page after a native request-source conflict: later=${laterPage}`, async () => {
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  if (laterPage) await createSpendRequest(f.t.deps(() => Date.now() - 60_000), { orgId: TEST_ORG, kind: "month", taskId, scope: { kind: "org" }, amountUsd: 1, newLimitUsd: 5, reason: "Older monthly room", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind: "run_limit", taskId, scope: { kind: "task", taskId }, amountUsd: 1, newLimitUsd: 5, reason: "Legacy ask", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" };
  const { approvalTerms: _terms, ...legacy } = f.t.db.get(key)!; void _terms; f.t.db.set(legacy);
  const send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === key.pk && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("EXPIRED"))) {
      raced = true; f.t.db.set({ ...f.t.db.get(key)!, amountUsd: 2 });
    }
    return send(command);
  };
  const cursor = laterPage ? (await spendRequests.expireLegacySpendingRequests(f.t.deps(), { orgId: TEST_ORG, limit: 1 })).cursor : undefined;
  if (laterPage) expect(cursor).toBeDefined();
  const input = { orgId: TEST_ORG, limit: 1, ...(cursor === undefined ? {} : { cursor }) };
  const first = await spendRequests.expireLegacySpendingRequests(f.t.deps(), input);
  expect(raced).toBe(true); expect(first).toMatchObject({ expired: 0, complete: false }); expect(first.cursor).toEqual(cursor);
  expect(f.t.db.get(key)).toMatchObject({ status: "PENDING", amountUsd: 2 }); expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toBeUndefined();
  expect(await spendRequests.expireLegacySpendingRequests(f.t.deps(), input)).toMatchObject({ expired: 1, complete: true });
});

for (const limit of [0.5, 5]) it(`unenrolled cutover review classifies complete approval ${limit} with the shared calculator`, async () => {
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, kind: "run_limit", scope: { kind: "task", taskId }, amountUsd: limit, newLimitUsd: limit, reason: "Pending reviewed approval", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  expect(record.approvalTerms).toBeDefined(); f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const before = f.t.meta(taskId), policy = f.t.db.get(f.policy);
  const fn: unknown = Reflect.get(spendRequests, "reviewTaskStopCutoverApproval"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("cutover review missing");
  const invoke = fn as (deps: unknown, actor: unknown, request: unknown) => Promise<unknown>;
  expect(await invoke(f.t.deps(), { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" }, record)).toMatchObject({ kind: limit === 5 ? "expire" : "retain", ...(limit === 5 ? { reason: "spending_rules_changed" } : {}) });
  expect(f.t.meta(taskId)).toEqual(before); expect(f.t.db.get(f.policy)).toEqual(policy); expect(f.t.requests().find(item => item.spendRequestId === record.spendRequestId)?.status).toBe("PENDING");
});

for (const failure of ["actor", "seed", "project"] as const) it(`unenrolled cutover review halts on ${failure} authority/config loss`, async () => {
  const limit = 0.5;
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, kind: "run_limit", scope: { kind: "task", taskId }, amountUsd: limit, newLimitUsd: limit, reason: "Pending reviewed approval", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  expect(record.approvalTerms).toBeDefined(); f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  if (failure === "actor") { const key = orgMemberKey(TEST_ORG, ADA.developerId); f.t.db.set({ ...f.t.db.get(key)!, role: "member" }); }
  if (failure === "seed") f.t.db.delete({ pk: orgScoped(TEST_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap" });
  if (failure === "project") f.t.db.delete(f.project);
  const before = f.t.meta(taskId), policy = f.t.db.get(f.policy);
  const fn: unknown = Reflect.get(spendRequests, "reviewTaskStopCutoverApproval"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("cutover review missing");
  const invoke = fn as (deps: unknown, actor: unknown, request: unknown) => Promise<unknown>;
  await expect(invoke(f.t.deps(), { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" }, record)).rejects.toBeDefined();
  expect(f.t.meta(taskId)).toEqual(before); expect(f.t.db.get(f.policy)).toEqual(policy); expect(f.t.requests().find(item => item.spendRequestId === record.spendRequestId)?.status).toBe("PENDING");
});

for (const bounded of [false, true]) for (const race of ["none", "ceiling", "actor", "task", "company", "project", "agent", "org_close", "pointer", "seed", "agent_raw", "company_raw", "enrollment_raw", "agent_status"] as const) it(`cutover expiry binds reviewed native policy, actor and task: ${race}, bounded=${bounded}`, async () => {
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, kind: "run_limit", scope: { kind: "task", taskId }, amountUsd: 5, newLimitUsd: 5, reason: "Complete above-ceiling ask", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const before = f.t.meta(taskId), key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" }, send = f.t.db.send.bind(f.t.db); let attempted = false; let snapshots = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) snapshots += 1;
    if (!attempted && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === key.pk && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("EXPIRED"))) {
      attempted = true;
      const keys = command.input.TransactItems.map(item => { const source = item.Update?.Key ?? item.ConditionCheck?.Key ?? item.Put?.Item ?? item.Delete?.Key; return `${String(source?.pk)}|${String(source?.sk)}`; });
      expect(new Set(keys).size).toBe(keys.length);
      expect(command.input.TransactItems.some(item => item.ConditionCheck?.Key?.pk === orgScoped(TEST_ORG, "TASK_STOP_SEED") && item.ConditionCheck.Key.sk === "V1#upgrade")).toBe(true);
      if (race === "ceiling") { const ceiling = agentGuardrailsKey(TEST_ORG), row = f.t.db.get(ceiling)!; f.t.db.set({ ...row, revision: Number(row.revision) + 1, guardrails: { ...(row.guardrails as Record<string, unknown>), maxPerRunCeilingUsd: 10 } }); }
      if (race === "actor") { const actor = orgMemberKey(TEST_ORG, ADA.developerId); f.t.db.set({ ...f.t.db.get(actor)!, role: "member" }); }
      if (race === "task") f.t.db.set({ ...f.t.db.get(taskKey(taskId))!, budgetUsd: 2 });
      if (race === "company" || race === "project" || race === "agent") { const changed = race === "company" ? f.policy : race === "project" ? f.project : f.agent; const row = f.t.db.get(changed)!; f.t.db.set({ ...row, revision: Number(row.revision) + 1 }); }
      if (race === "org_close") { const org = orgMetaKey(TEST_ORG); f.t.db.set({ ...f.t.db.get(org)!, closingAt: new Date().toISOString() }); }
      if (race === "pointer") { const pointer = developerOrgKey(ADA.developerId); f.t.db.set({ ...f.t.db.get(pointer)!, role: "member" }); }
      if (race === "seed") f.t.db.delete({ pk: orgScoped(TEST_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap" });
      if (race === "agent_raw" || race === "agent_status") f.t.db.set({ ...f.t.db.get(f.agent)!, ...(race === "agent_raw" ? { maxPerRunUsd: 0.5 } : { status: "archived" }) });
      if (race === "company_raw") f.t.db.set({ ...f.t.db.get(f.policy)!, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
      if (race === "enrollment_raw") f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 2, state: "disabled" } });
    }
    return send(command);
  };
  const fn: unknown = Reflect.get(spendRequests, bounded ? "expireUnapprovableTaskStopRequests" : "expireTaskStopCutoverApproval"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("fenced cutover expiry missing");
  const invoke = fn as (deps: unknown, actor: unknown, input: unknown) => Promise<unknown>;
  expect(await invoke(f.t.deps(), { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" }, bounded ? { orgId: TEST_ORG, limit: 1 } : record.spendRequestId)).toMatchObject(bounded ? { expired: race === "none" ? 1 : 0, complete: race === "none" } : { kind: race === "none" ? "expired" : "retry" });
  expect(attempted).toBe(true); expect(snapshots).toBe(1);
  expect(f.t.db.get(key)?.status).toBe(race === "none" ? "EXPIRED" : "PENDING");
  if (race === "none") expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toMatchObject({ reason: "spending_rules_changed", actor: { kind: "system" } });
  else expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toBeUndefined();
  expect(f.t.meta(taskId)).toEqual(race === "task" ? { ...before, budgetUsd: 2 } : before);
  expect(f.t.db.get(f.policy)).toMatchObject({ enrollment: { state: "disabled" } });
});

for (const kind of ["run_limit", "max_per_run", "planning"] as const) it(`bounded task cutover expires above-cap ${kind} asks while preserving accepted caps`, async () => {
  const f = await fixture(), started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const { record } = await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, agentId: ROVARA_CODE_AGENT_ID, kind, scope: { kind: "task", taskId }, amountUsd: 5, newLimitUsd: 5, reason: "Complete unapprovable ask", requestedBy: { kind: "member", developerId: MAYA.developerId } });
  expect(record.approvalTerms).toBeDefined(); f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const before = f.t.meta(taskId), policy = f.t.db.get(f.policy);
  const fn: unknown = Reflect.get(spendRequests, "expireUnapprovableTaskStopRequests"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("bounded task cutover missing");
  const invoke = fn as (deps: unknown, actor: unknown, input: unknown) => Promise<unknown>;
  expect(await invoke(f.t.deps(), { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" }, { orgId: TEST_ORG, limit: 1 })).toMatchObject({ examined: 1, expired: 1, complete: true });
  const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${record.spendRequestId}`), sk: "META" };
  expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
  expect(f.t.db.get({ ...key, sk: "EXPIRY" })).toMatchObject({ reason: "spending_rules_changed", actor: { kind: "system" } });
  expect(f.t.meta(taskId)).toEqual(before); expect(f.t.db.get(f.policy)).toEqual(policy);
});

it("bounded task cutover retains below-cap task asks and never clamps monthly owner or room asks", async () => {
  const f = await fixture(); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN); const agentId = await f.t.budgeted(40);
  const ownerAsk = await f.t.api(ADA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: BEN.developerId } }); expect(ownerAsk.status).toBe(202);
  const started = await f.start(), taskId = (started.body.task as { taskId: string }).taskId;
  const records = [];
  for (const [kind, limit] of [["run_limit", 0.5], ["max_per_run", 5], ["month", 120]] as const) records.push((await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, taskId, agentId: ROVARA_CODE_AGENT_ID, kind, scope: kind === "month" ? { kind: "org" } : { kind: "task", taskId }, amountUsd: limit, newLimitUsd: limit, reason: "Cutover review", requestedBy: { kind: "member", developerId: MAYA.developerId } })).record);
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const before = f.t.meta(taskId), actor = { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" as const };
  const first = await spendRequests.expireUnapprovableTaskStopRequests(f.t.deps(), actor, { orgId: TEST_ORG, limit: 2 });
  expect(first.complete).toBe(false); expect(first.cursor).toBeDefined();
  const second = await spendRequests.expireUnapprovableTaskStopRequests(f.t.deps(), actor, { orgId: TEST_ORG, limit: 2, cursor: first.cursor! });
  expect(second.complete).toBe(true); expect(first.expired + second.expired).toBe(1);
  for (const record of records) expect(f.t.requests().find(item => item.spendRequestId === record.spendRequestId)?.status).toBe(record.kind === "max_per_run" ? "EXPIRED" : "PENDING");
  expect(f.t.requests().find(item => item.spendRequestId === ownerAsk.body.spendRequestId)?.status).toBe("PENDING");
  expect(f.t.ownerTotal(BEN)).toBe(80); expect(f.t.meta(taskId)).toEqual(before);
});

for (const bounded of [false, true]) for (const drift of ["none", "total_before", "source_before", "policy_before", "counter_commit", "actor_commit", "policy_commit", "source_commit"] as const) it(`owner financial cutover preserves monthly semantics and original terms: ${drift}, bounded=${bounded}`, async () => {
  const f = await fixture(); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN); const agentId = await f.t.budgeted(40);
  const ask = await f.t.api(ADA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "member", developerId: BEN.developerId } }); expect(ask.status).toBe(202);
  const id = String(ask.body.spendRequestId), requestKey = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${id}`), sk: "META" };
  if (drift === "total_before" || drift.endsWith("_commit")) await f.t.budgeted(1, BEN);
  if (drift === "source_before") expect((await f.t.setBudget(MAYA, agentId, { monthlyUsd: 39 })).status).toBe(200);
  if (drift === "policy_before") f.t.db.set({ ...orgSettingsKey(TEST_ORG, "SPEND_POLICY"), orgId: TEST_ORG, ...defaultSpendPolicy(), revision: 1, ownerAgentBudgetCapUsd: 99 });
  const before = f.t.agentItem(agentId), total = f.t.ownerTotal(BEN), send = f.t.db.send.bind(f.t.db); let raced = false; let snapshots = 0;
  f.t.db.send = async command => {
    if (command instanceof TransactGetCommand) snapshots += 1;
    if (drift.endsWith("_commit") && !raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === requestKey.pk && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("EXPIRED"))) {
      raced = true;
      if (drift === "counter_commit") { const key = ownerBudgetKey(TEST_ORG, BEN.developerId), row = f.t.db.get(key)!; f.t.db.set({ ...row, totalUsd: total + 1, version: Number(row.version) + 1 }); }
      if (drift === "actor_commit") { const key = orgMemberKey(TEST_ORG, DEB.developerId); f.t.db.set({ ...f.t.db.get(key)!, role: "member" }); }
      if (drift === "policy_commit") f.t.db.set({ ...orgSettingsKey(TEST_ORG, "SPEND_POLICY"), orgId: TEST_ORG, ...defaultSpendPolicy(), revision: 1, ownerAgentBudgetCapUsd: 99 });
      if (drift === "source_commit") { const key = agentKey(TEST_ORG, agentId, "META"); f.t.db.set({ ...f.t.db.get(key)!, maxPerRunUsd: 0.5 }); }
    }
    return send(command);
  };
  const fn: unknown = Reflect.get(spendRequests, bounded ? "expireUnapprovableSpendingRequests" : "expireOwnerCapCutoverApproval"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("owner cutover missing");
  const invoke = fn as (deps: unknown, actor: unknown, input: unknown) => Promise<unknown>;
  expect(await invoke(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, bounded ? { orgId: TEST_ORG, limit: 1 } : id)).toMatchObject(bounded ? { expired: drift === "none" || drift.endsWith("_commit") ? 0 : 1, complete: !drift.endsWith("_commit") } : { kind: drift === "none" ? "retain" : drift.endsWith("_commit") ? "retry" : "expired" });
  expect(f.t.db.get(requestKey)?.status).toBe(drift === "none" || drift.endsWith("_commit") ? "PENDING" : "EXPIRED");
  expect(snapshots).toBe(1); expect(f.t.agentItem(agentId)).toEqual(drift === "source_commit" ? { ...before, maxPerRunUsd: 0.5 } : before); expect(f.t.ownerTotal(BEN)).toBe(total + (drift === "counter_commit" ? 1 : 0));
  if (drift.endsWith("_commit")) expect(raced).toBe(true);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const consumer of ["approve", "approve_commit", "cutover", "cutover_commit"] as const) it(`owner-cap ${resource} ${operation} pins carried source topup for ${consumer}`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const scope = resource === "agent" ? { kind: "agent" as const, agentId: id } : { kind: "chain" as const, chainId: id };
  const month = new Date().toISOString().slice(0, 7);
  const monthly = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind: "month", scope, subject: `MONTH#${month}#${resource}#${id}#${randomUUID()}`, amountUsd: 1, newLimitUsd: 41, reason: "Source month topup", requestedBy: { kind: "system" } })).record;
  let raced = false;
  const send = f.t.db.send.bind(f.t.db);
  if (consumer === "approve_commit") {
    f.t.db.send = async command => {
      if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
        raced = true;
        expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
      }
      return send(command);
    };
    await expect(f.t.decide(DEB, requestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
    expect(raced).toBe(true);
    expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
    expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 1 });
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })).toMatchObject({ status: "EXPIRED" });
    return;
  }
  if (consumer === "cutover_commit") {
    // Make expiry necessary, then change its captured carried row at the final write.
    await f.t.budgeted(1, BEN);
    f.t.db.send = async command => {
      if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`) && Object.values(item.Update.ExpressionAttributeValues ?? {}).includes("EXPIRED"))) {
        raced = true;
        expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
      }
      return send(command);
    };
    expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "retry" });
    expect(raced).toBe(true);
    expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore + 1);
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })).toMatchObject({ status: "PENDING" });
    expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "EXPIRY" })).toBeUndefined();
    expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "expired" });
    return;
  }
  expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 1 });
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  if (consumer === "approve") await expect(f.t.decide(DEB, requestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  else expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "expired" });
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  expect(f.t.db.get({ pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" })).toMatchObject({ status: "EXPIRED" });
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`direct ${resource} ${operation} refuses a carried topup race past the monthly owner cap`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 15 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 15 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), send = f.t.db.send.bind(f.t.db); let raced = false;
  const scope = resource === "agent" ? { kind: "agent" as const, agentId: id } : { kind: "chain" as const, chainId: id };
  const month = new Date().toISOString().slice(0, 7);
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === entityKey.pk && item.Update.Key.sk === entityKey.sk)) {
      raced = true;
      const monthly = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind: "month", scope, subject: `MONTH#${month}#${resource}#${id}#${randomUUID()}`, amountUsd: 6, newLimitUsd: 21, reason: "Concurrent source monthly topup", requestedBy: { kind: "system" } })).record;
      expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
    }
    return send(command);
  };
  const reply = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(raced).toBe(true); expect(reply.status).toBe(409);
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(80);
  expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 6 });
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} retains a valid nonzero original carried proof`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), totalBefore = f.t.ownerTotal(BEN);
  const scope = resource === "agent" ? { kind: "agent" as const, agentId: id } : { kind: "chain" as const, chainId: id };
  const month = new Date().toISOString().slice(0, 7);
  const monthly = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind: "month", scope, subject: `MONTH#${month}#${resource}#${id}#${randomUUID()}`, amountUsd: 1, newLimitUsd: 41, reason: "Source month topup", requestedBy: { kind: "system" } })).record;
  expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 1 });
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  const pending = f.t.requests().find(item => item.spendRequestId === requestId)!;
  expect(pending.ownerFinancialTerms).toMatchObject({ carriedUsd: 1, wouldBeUsd: 121, carriedSource: { exists: true, fields: { amountUsd: 1 } } });
  expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "retain" });
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(totalBefore);
  expect((await f.t.decide(DEB, requestId)).spendRequest.status).toBe("APPROVED");
  expect(f.t.ownerTotal(BEN)).toBe(120); expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 1 });
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) for (const consumer of ["legacy", "decision", "single_cutover"] as const) it(`${consumer} expires ${resource} ${operation} asks missing original carried proof`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(ask.status).toBe(202); const requestId = String(ask.body.spendRequestId);
  const key = { pk: orgScoped(TEST_ORG, `SPEND_REQUEST#${requestId}`), sk: "META" }, row = f.t.db.get(key)!;
  const financial = row.ownerFinancialTerms as Record<string, unknown>, { carriedSource: _source, ...incomplete } = financial; void _source;
  expect(financial.carriedSource).toBeDefined(); f.t.db.set({ ...row, ownerFinancialTerms: incomplete });
  if (consumer === "legacy") expect(await spendRequests.expireLegacySpendingRequests(f.t.deps(), { orgId: TEST_ORG, limit: 100 })).toMatchObject({ expired: 1, complete: true });
  if (consumer === "decision") await expect(f.t.decide(DEB, requestId)).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  if (consumer === "single_cutover") expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "expired" });
  expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});

for (const resource of ["agent", "chain"] as const) it(`strict owner terms retain a same-owner ${resource} budget raise without inventing a carrier proof`, async () => {
  const f = await fixture(); await f.t.budgeted(30); await f.t.budgeted(30);
  let id: string;
  if (resource === "agent") id = await f.t.budgeted(40);
  else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}` }); expect(created.status).toBe(201);
    id = (created.body.chain as { chainId: string }).chainId; expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const reply = resource === "agent" ? await f.t.setBudget(MAYA, id, { monthlyUsd: 41 }) : await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 41 });
  expect(reply.status).toBe(202); const requestId = String(reply.body.spendRequestId), record = f.t.requests().find(item => item.spendRequestId === requestId)!;
  expect(record.ownerFinancialTerms?.carriedSource).toBeUndefined(); expect(record.ownerFinancialTerms).toMatchObject({ owner: MAYA.developerId, wouldBeUsd: 101 });
  expect(await spendRequests.expireLegacySpendingRequests(f.t.deps(), { orgId: TEST_ORG, limit: 100 })).toMatchObject({ expired: 0 });
  expect(await spendRequests.expireOwnerCapCutoverApproval(f.t.deps(), { orgId: TEST_ORG, developerId: DEB.developerId, orgRole: "admin" }, requestId)).toMatchObject({ kind: "retain" });
  expect((await f.t.decide(DEB, requestId)).spendRequest.status).toBe("APPROVED"); expect(f.t.ownerTotal(MAYA)).toBe(101);
});

for (const resource of ["agent", "chain"] as const) for (const operation of ["owner", "accountable"] as const) it(`owner-cap ${resource} ${operation} refuses a carried source race at request creation`, async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer"); await f.t.budgeted(40, BEN); await f.t.budgeted(40, BEN);
  const projectOwned = operation === "accountable";
  let id: string;
  if (resource === "agent") {
    id = await f.t.agentOf(TRIAGE, projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: MAYA } : {});
    expect((await f.t.setBudget(MAYA, id, { monthlyUsd: 40 })).status).toBe(200);
  } else {
    const created = await f.t.api(MAYA, "POST", "/v1/app/chains", { name: `M47 ${randomUUID().slice(0, 8)}`,
      ...(projectOwned ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: MAYA.developerId } } : {}) });
    expect(created.status).toBe(201); id = (created.body.chain as { chainId: string }).chainId;
    expect((await f.t.api(MAYA, "PUT", `/v1/app/chains/${id}/budget`, { monthlyUsd: 40 })).status).toBe(200);
  }
  const path = resource === "agent" ? "agents" : "chains";
  const scope = resource === "agent" ? { kind: "agent" as const, agentId: id } : { kind: "chain" as const, chainId: id };
  const month = new Date().toISOString().slice(0, 7);
  const monthly = (await createSpendRequest(f.t.deps(), { orgId: TEST_ORG, kind: "month", scope, subject: `MONTH#${month}#${resource}#${id}#${randomUUID()}`, amountUsd: 1, newLimitUsd: 41, reason: "Source month topup", requestedBy: { kind: "system" } })).record;
  const entityKey = { pk: orgScoped(TEST_ORG, `${resource === "agent" ? "AGENT" : "CHAIN"}#${id}`), sk: "META" }, before = f.t.db.get(entityKey), total = f.t.ownerTotal(BEN), send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.kind === "owner_cap" && item.Put.Item.status === "PENDING")) {
      raced = true;
      expect((await f.t.decide(MAYA, monthly.spendRequestId)).spendRequest.status).toBe("APPROVED");
    }
    return send(command);
  };
  const ask = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(raced).toBe(true); expect(ask.status).toBe(400);
  expect(f.t.db.get(entityKey)).toEqual(before); expect(f.t.ownerTotal(BEN)).toBe(total);
  expect(f.t.requests().filter(item => item.kind === "owner_cap")).toHaveLength(0);
  expect(f.t.db.get(topUpKey(TEST_ORG, month, scope))).toMatchObject({ amountUsd: 1 });
  const retry = await f.t.api(operation === "owner" ? ADA : MAYA, "PUT", `/v1/app/${path}/${id}/${operation}`, operation === "owner"
    ? { owner: { kind: "member", developerId: BEN.developerId } } : { accountable: { developerId: BEN.developerId } });
  expect(retry.status).toBe(202);
  expect(f.t.requests().find(item => item.kind === "owner_cap")?.ownerFinancialTerms).toMatchObject({ carriedUsd: 1, wouldBeUsd: 121 });
});

for (const origin of ["event", "schedule"] as const) it(`autonomous ${origin} start captures the actual agent stop before paid effects`, async () => {
  const f = await fixture(), agentId = await f.t.budgeted(40), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, orgId: TEST_ORG, agentId, revision: 1, stopKind: "inherit" });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId }, input: { text: "Review this event" }, origin, owner: { developerId: MAYA.developerId }, payer: { kind: "agent", agentId } });
  expect(f.t.meta(started.taskId)).toMatchObject({ budgetUsd: 1.234567, spendingStop: { schemaVersion: 2, orgId: TEST_ORG, agentId, effectiveStopMicrousd: 1234567 } });
});

for (const origin of ["event", "schedule"] as const) for (const setting of ["zero", "missing"] as const) it(`autonomous ${origin} refuses ${setting} stop configuration before a task is accepted`, async () => {
  const f = await fixture(setting === "zero" ? 0 : 1234567), agentId = await f.t.budgeted(40), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, orgId: TEST_ORG, agentId, revision: 1, stopKind: "inherit" });
  if (setting === "missing") f.t.db.delete(f.policy);
  const before = f.t.db.find(row => row.entityType === "DEVELOPER_TASK");
  await expect(startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId }, input: { text: "Review this event" }, origin, owner: { developerId: MAYA.developerId }, payer: { kind: "agent", agentId } })).rejects.toMatchObject({ code: setting === "zero" ? "TASK_STOP_ZERO" : "TASK_STOP_CONFIG_MISSING" });
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toEqual(before);
});
for (const origin of ["event", "schedule"] as const) it(`unenrolled autonomous ${origin} retains its existing run limit`, async () => {
  const f = await fixture(), agentId = await f.t.budgeted(40);
  f.t.db.set({ ...f.t.db.get(f.policy)!, enrollment: { version: 1, state: "disabled" } });
  const started = await startAgentRun(f.t.starter(), { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId }, input: { text: "Review this event" }, origin, owner: { developerId: MAYA.developerId }, payer: { kind: "agent", agentId } });
  expect(f.t.meta(started.taskId)).toMatchObject({ budgetUsd: 4 }); expect(f.t.meta(started.taskId)).not.toHaveProperty("spendingStop");
});

for (const origin of ["event", "schedule"] as const) it(`autonomous ${origin} retry preserves its accepted stop while a fresh run observes tightening`, async () => {
  const f = await fixture(), agentId = await f.t.budgeted(40), key = agentKey(TEST_ORG, agentId, "META");
  f.t.db.set({ ...f.t.db.get(key)!, orgId: TEST_ORG, agentId, revision: 1, stopKind: "inherit" });
  const request = { requestId: randomUUID(), orgId: TEST_ORG, project: "payments", agent: { agentId }, input: { text: "Review this event" }, origin, owner: { developerId: MAYA.developerId }, payer: { kind: "agent" as const, agentId } };
  const started = await startAgentRun(f.t.starter(), request), before = f.t.meta(started.taskId);
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
  const replay = await startAgentRun(f.t.starter(), request);
  expect(replay.taskId).toBe(started.taskId); expect(f.t.meta(started.taskId)).toEqual(before);
  await expect(startAgentRun(f.t.starter(), { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: "TASK_STOP_ZERO" });
  expect(f.t.db.find(row => row.entityType === "DEVELOPER_TASK")).toHaveLength(1);
});

it("setup draft paid start captures the company stop through its actual app route", async () => {
  const f = await fixture();
  f.t.grantRole(MAYA, "maintainer");
  const reply = await f.t.dev(MAYA, "POST", "/v1/app/projects/payments/setup-draft", { requestId: randomUUID() });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const tasks = f.t.db.find(row => row.entityType === "DEVELOPER_TASK");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ purpose: "setup_draft", budgetUsd: 1.234567, spendingStop: { effectiveStopMicrousd: 1234567 } });
});

for (const setting of ["zero", "missing"] as const) it(`setup draft refuses ${setting} spending policy before paid preparation`, async () => {
  const f = await fixture(setting === "zero" ? 0 : 1234567);
  f.t.grantRole(MAYA, "maintainer");
  if (setting === "missing") f.t.db.delete(f.policy);
  const before = f.t.db.find(row => ["DEVELOPER_TASK", "WORKSPACE", "OPERATION", "OUTBOX"].includes(String(row.entityType)));
  const reply = await f.t.dev(MAYA, "POST", "/v1/app/projects/payments/setup-draft", { requestId: randomUUID() });
  expect(reply.status, JSON.stringify(reply.body)).toBe(409);
  expect(reply.body.error).toMatchObject({ code: setting === "zero" ? "TASK_STOP_ZERO" : "TASK_STOP_CONFIG_MISSING" });
  expect(f.t.db.find(row => ["DEVELOPER_TASK", "WORKSPACE", "OPERATION", "OUTBOX"].includes(String(row.entityType)))).toEqual(before);
});
it("setup draft preparation carries the same accepted spending admission", async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer");
  const reply = await f.t.dev(MAYA, "POST", "/v1/app/projects/payments/setup-draft", { requestId: randomUUID() });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const task = f.t.db.find(row => row.entityType === "DEVELOPER_TASK")[0]!;
  const prepare = f.t.db.find(row => row.entityType === "OPERATION" && row.workspaceId === task.workspaceId && row.kind === "prepare");
  expect(prepare).toHaveLength(1);
  expect(prepare[0]).toMatchObject({ spendingTaskId: task.taskId, spendingAdmission: task.spendingAdmission });
  expect(task.spendingAdmission).toBeDefined();
});

it("setup draft callback reuses its admitted window after company tightening", async () => {
  const f = await fixture(); f.t.grantRole(MAYA, "maintainer");
  const reply = await f.t.dev(MAYA, "POST", "/v1/app/projects/payments/setup-draft", { requestId: randomUUID() });
  expect(reply.status, JSON.stringify(reply.body)).toBe(202);
  const task = f.t.db.find(row => row.entityType === "DEVELOPER_TASK")[0]!;
  const workspaceId = String(task.workspaceId), prepare = f.t.operations(workspaceId).find(operation => operation.kind === "prepare")!;
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } } });
  await f.t.finish(workspaceId, prepare.id, "SUCCEEDED", PREPARED);
  const next = f.t.operations(workspaceId).filter(operation => operation.kind === "task");
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ spendingTaskId: task.taskId, spendingAdmission: task.spendingAdmission });
  expect(f.t.meta(String(task.taskId))).toMatchObject({ budgetUsd: 1.234567, spendingStop: task.spendingStop, spendingAdmission: task.spendingAdmission });
});
