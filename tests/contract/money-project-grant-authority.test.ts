import { seedMembership } from "../support/developer-task-broker.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
// M31: one existing maintainer accept-only settings flow, using real table grants.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { OrgIdSchema, projectMemberKey } from "@rovara-code/contracts";
import { projectAiKey } from "@agentx/cloud-contracts";
import { writeProjectAi } from "../../packages/broker/src/spend/settings.js";
import { createProjectMembers } from "../../packages/broker/src/org/project-members.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { BEN, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const existing of [false, true]) for (const loss of ["delete", "demote", "replace"] as const) it(`refuses ${loss} of the selected grant at ${existing ? "existing" : "first"} project settings commit`, async () => {
  const capture = capturingAuditDeps(), t = await setup({ extra: { audit: capture.audit } }); capture.attach(t.db);
  const key = projectAiKey(TEST_ORG, "payments"), grantKey = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), grant = t.db.get(grantKey)!;
  if (existing) t.db.set({ ...key, entityType: "PROJECT_AI", projectPays: false, memberAcceptRunLimitUpToUsd: 1, revision: 1 });
  const before = t.db.get(key), send = t.db.send.bind(t.db); let raced = false;
  t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) {
      raced = true;
      await send(new TransactWriteCommand({ TransactItems: loss === "delete" ? [{ Delete: { TableName: "state", Key: grantKey } }] : [{ Put: { TableName: "state", Item: { ...grant, ...(loss === "demote" ? { projectRole: "contributor" } : { grantId: randomUUID() }) } } }] }));
    }
    return send(command);
  };
  expect((await t.api(BEN, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 2 })).status).toBe(403);
  expect(raced).toBe(true); expect(t.db.get(key)).toEqual(before); expect(capture.recorded()).toHaveLength(0); expect(capture.pending()).toHaveLength(0);
  t.db.set(grant);
  expect((await t.api(BEN, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 2 })).status).toBe(200);
  expect(t.db.get(key)?.revision).toBe(existing ? 2 : 1);
});
it("an org admin needs no project grant", async () => {
  const t = await setup(); t.db.delete(projectMemberKey(TEST_ORG, DEB.developerId, "payments"));
  expect((await t.api(DEB, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 2 })).status).toBe(200);
});
it("an internal member writer cannot bypass the project grant or change broader settings", async () => {
  const t = await setup(), actor = { developerId: BEN.developerId, role: "member" as const }, key = projectAiKey(TEST_ORG, "payments");
  const grantKey = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), grant = t.db.get(grantKey)!; t.db.delete(grantKey);
  await expect(writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false, memberAcceptRunLimitUpToUsd: 2 }, BEN.developerId, { actor })).rejects.toMatchObject({ code: "FORBIDDEN" });
  t.db.set(grant);
  await expect(writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: true }, BEN.developerId, { actor })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(t.db.get(key)).toBeUndefined();
  await writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false, memberAcceptRunLimitUpToUsd: 2 }, BEN.developerId, { actor });
});
it("the real resolver exposes its existing survivor-first maintainer grant selection (synthetic retained-member source control)", async () => {
  const t = await setup(), survivor = "a".repeat(64), grant = t.db.get(projectMemberKey(TEST_ORG, BEN.developerId, "payments"))!;
  t.db.set({ ...grant, ...projectMemberKey(TEST_ORG, survivor, "payments"), ownerKey: survivor, grantId: randomUUID() });
  const members = createProjectMembers({ documentClient: t.db, tableName: "state", developerRecord: id => Promise.resolve(id === BEN.developerId ? { mergedInto: survivor } : {}) });
  expect(await members.roleOf(TEST_ORG, "payments", { developerId: BEN.developerId, orgRole: "member" })).toBe("maintainer");
  t.db.set({ ...t.db.get(projectMemberKey(TEST_ORG, survivor, "payments"))!, projectRole: "contributor" });
  expect(await members.roleOf(TEST_ORG, "payments", { developerId: BEN.developerId, orgRole: "member" })).toBe("contributor");
});
for (const role of ["viewer", "contributor"] as const) it(`a ${role} and an unrelated project's grant cannot authorize the settings writer`, async () => {
  const t = await setup(), key = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), original = t.db.get(key)!;
  t.db.set({ ...original, projectRole: role });
  t.db.set({ ...original, ...projectMemberKey(TEST_ORG, BEN.developerId, "other"), projectName: "other" });
  await expect(writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false, memberAcceptRunLimitUpToUsd: 2 }, BEN.developerId, { actor: { developerId: BEN.developerId, role: "member" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("a grant in a different company cannot authorize this company", async () => {
  const t = await setup(), key = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), grant = t.db.get(key)!;
  t.db.delete(key);
  const foreign = OrgIdSchema.parse("org_" + "b".repeat(20));
  // Another company has the same project and person but is never an authority source here.
  t.db.set({ ...grant, ...projectMemberKey(foreign, BEN.developerId, "payments") });
  await expect(writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false, memberAcceptRunLimitUpToUsd: 2 }, BEN.developerId, { actor: { developerId: BEN.developerId, role: "member" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("the writer refuses a supplied survivor grant even with live source membership", async () => {
  const t = await setup(), source = "a".repeat(64), own = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), grant = t.db.get(own)!;
  t.db.delete(own); t.db.set({ ...grant, ...projectMemberKey(TEST_ORG, source, "payments"), ownerKey: source });
  seedMembership(t.db, source, { orgId: TEST_ORG, role: "owner" });
  await expect(writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false, memberAcceptRunLimitUpToUsd: 2 }, BEN.developerId, { actor: { developerId: BEN.developerId, role: "member" }, projectGrantDeveloperId: source })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(t.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
});
it("the route cannot borrow a survivor grant when the own grant is absent (synthetic source control)", async () => {
  const t = await setup(), survivor = "a".repeat(64), own = projectMemberKey(TEST_ORG, BEN.developerId, "payments"), grant = t.db.get(own)!;
  t.db.delete(own); t.db.set({ ...grant, ...projectMemberKey(TEST_ORG, survivor, "payments"), ownerKey: survivor });
  seedMembership(t.db, survivor, { orgId: TEST_ORG, role: "owner" });
  const members = createProjectMembers({ documentClient: t.db, tableName: "state", developerRecord: id => Promise.resolve(id === BEN.developerId ? { mergedInto: survivor } : {}) });
  const path = "/v1/app/projects/payments/ai", request = { method: "PUT", path, headers: {}, requestId: randomUUID(), body: JSON.stringify({ requestId: randomUUID(), memberAcceptRunLimitUpToUsd: 2 }) };
  await expect(routeAgentRequest({ ...t.deps(), projectMembers: members }, t.caller(BEN), request, new URL(path, "https://cell.example.test"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(t.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
});

it("the HTTP body cannot select its own authority grant", async () => {
  const t = await setup();
  expect((await t.api(BEN, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 2, projectGrantDeveloperId: DEB.developerId })).status).toBe(400);
  expect(t.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
});
