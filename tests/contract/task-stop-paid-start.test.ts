import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, builtinSettingsKey, orgSettingsKey, orgScoped, projectAiKey, orgProjectCatalogKey, orgMemberKey, developerOrgKey, orgMetaKey, projectMetaKey, projectMemberKey, agentKey } from "@agentx/contracts";
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
  expect(reply.body.error).toMatchObject({ code: failure === "zero" ? "TASK_STOP_BUDGET_EXCEEDED" : "TASK_STOP_CONFIG_MISSING" });
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
