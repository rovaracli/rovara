import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_AGENT_GUARDRAILS, ROVARA_CODE_AGENT_ID, agentGuardrailsKey, builtinSettingsKey, orgSettingsKey, orgScoped, projectAiKey, orgProjectCatalogKey } from "@agentx/contracts";
import { MAYA } from "../support/developer-task-broker.js";
import { setup } from "../support/spend-world.js";
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
