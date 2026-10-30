import { fixtureProject } from "../support/project-ai-source.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactWriteCommand, TransactGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, builtinSettingsKey, orgSettingsKey, orgScoped, projectAiKey, orgProjectCatalogKey, orgMemberKey, developerOrgKey, orgMetaKey, projectMetaKey, projectMemberKey, agentKey, projectRevisionKey, projectAgentKey } from "@agentx/contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { setup, CODING, DEB, ADA } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
async function fixture(amount = 1_234_567) {
  const t = await setup(), policy = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY"), project = projectAiKey(TEST_ORG, "payments"), agent = builtinSettingsKey(TEST_ORG, ROVARA_CODE_AGENT_ID);
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
async function continueWindow() {
  const f = await fixture(), task = await f.t.plainTask();
  await f.t.finish(task.workspaceId, task.operationId, "SUCCEEDED");
  f.t.db.set({ ...f.t.db.get(f.policy)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 500_000 } } });
  const request = { requestId: randomUUID(), instructions: "Continue the accepted task." };
  const receipt = { pk: orgScoped(TEST_ORG, `SPENDING_ADMISSION#task-window#${task.taskId}`), sk: `REQUEST#${request.requestId}` };
  return { ...f, task, request, receipt, continue: () => f.t.api(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, request) };
}
it("Continue opens a newly captured exact window and commits its receipt with the operation", async () => {
  const f = await continueWindow(), reply = await f.continue(); expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(f.t.meta(f.task.taskId)).toMatchObject({ budgetUsd: 0.5, spendingStop: { effectiveStopMicrousd: 500_000 }, budgetBaselineUsd: 0 });
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
    const put = item.Put; return typeof put === "object" && put !== null && "Item" in put && typeof put.Item === "object" && put.Item !== null && "entityType" in put.Item && put.Item.entityType === "SPENDING_ADMISSION";
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
  const f = await continueWindow(), before = f.t.meta(f.task.taskId);
  const { spendingStop: _stop, ...legacy } = before;
  f.t.db.set({ ...legacy, ...(bound === "path" ? { budgetUsd: 0.0000001 } : { requestedRunLimitUsd: 0.0000001 }) });
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
