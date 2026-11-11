// The existing project-AI and spend-policy writers must refuse actor loss in their commit.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { defaultSpendPolicy, orgMemberKey, developerOrgKey, orgMetaKey, orgSettingsKey, projectAiKey } from "@agentx/cloud-contracts";
import { writeProjectAi, writeSpendPolicy } from "../../packages/broker/src/spend/settings.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { BEN, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const kind of ["project", "policy"] as const) for (const mode of ["route", "store"] as const) for (const existing of [false, true]) for (const loss of ["member_role", "removed", "pointer", "closed"] as const) {
  it(`refuses ${kind} ${mode} ${existing ? "existing" : "first"} settings commit after ${loss} and permits restored writer`, async () => {
    const t = await setup(), capture = capturingAuditDeps({ db: t.db }), deps = { ...t.deps(), audit: capture.audit };
    const key = kind === "project" ? projectAiKey(TEST_ORG, "payments") : orgSettingsKey(TEST_ORG, "SPEND_POLICY");
    if (existing) t.db.set({ ...key, entityType: kind === "project" ? "PROJECT_AI" : "ORG_SPEND_POLICY", ...(kind === "project" ? { projectPays: false, monthlyBudgetUsd: 100 } : defaultSpendPolicy()), revision: 1 });
    const before = t.db.get(key), originalOrg = t.db.get(orgMetaKey(TEST_ORG))!;
    const request = { orgId: TEST_ORG, developerId: DEB.developerId, requestId: randomUUID(), fingerprint: "settings-authority" };
    const options = { request, actor: { developerId: DEB.developerId, role: "admin" as const } };
    const write = () => kind === "project" ? writeProjectAi(deps, TEST_ORG, "payments", { projectPays: false, monthlyBudgetUsd: 200 }, DEB.developerId, options)
      : writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), ownerAgentBudgetCapUsd: 150 }, DEB.developerId, options);
    const call = () => t.api(DEB, "PUT", kind === "project" ? "/v1/app/projects/payments/ai" : "/v1/app/org/spend-policy", kind === "project" ? { monthlyBudgetUsd: 200 } : { ownerAgentBudgetCapUsd: 150 });
    const send = t.db.send.bind(t.db); let changed = false;
    t.db.send = async command => {
      const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string; sk?: string } } }> }).TransactItems;
      if (!changed && items?.some(item => item.Put?.Item?.pk === key.pk && item.Put.Item.sk === key.sk)) {
        changed = true;
        const TransactItems = loss === "member_role" ? [{ Update: { TableName: "state", Key: orgMemberKey(TEST_ORG, DEB.developerId), UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } }]
          : loss === "closed" ? [{ Update: { TableName: "state", Key: orgMetaKey(TEST_ORG), UpdateExpression: "SET closingAt = :at", ExpressionAttributeValues: { ":at": new Date().toISOString() } } }]
            : [{ Delete: { TableName: "state", Key: loss === "removed" ? orgMemberKey(TEST_ORG, DEB.developerId) : developerOrgKey(DEB.developerId) } }];
        await send(new TransactWriteCommand({ TransactItems }));
      }
      return send(command);
    };
    if (mode === "route") expect((await call()).status).toBe(403);
    else expect((await write().then(() => undefined, (error: { code?: string }) => error))?.code).toBe("FORBIDDEN");
    expect(changed).toBe(true); expect(t.db.get(key)).toEqual(before); expect(capture.recorded()).toHaveLength(0); expect(capture.pending()).toHaveLength(0);
    seedMembership(t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" }); t.db.set(originalOrg);
    if (mode === "route") expect((await call()).status).toBe(200); else await write();
    expect(t.db.get(key)?.revision).toBe(existing ? 2 : 1);
  });
}
for (const kind of ["project", "policy"] as const) for (const mismatch of ["missing", "actor", "request"] as const) {
  it(`refuses request-bearing ${kind} writer with ${mismatch} authority context`, async () => {
    const t = await setup(), request = { orgId: TEST_ORG, developerId: mismatch === "request" ? "a".repeat(64) : DEB.developerId, requestId: randomUUID(), fingerprint: "settings-bound" };
    const options = { request, ...(mismatch === "missing" ? {} : { actor: { developerId: mismatch === "actor" ? "a".repeat(64) : DEB.developerId, role: "admin" as const } }) };
    const unsafe = options as { request: typeof request; actor: { developerId: string; role: "admin" } };
    const write = kind === "project" ? writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false }, DEB.developerId, unsafe) : writeSpendPolicy(t.deps(), TEST_ORG, defaultSpendPolicy(), DEB.developerId, unsafe);
    expect((await write.then(() => undefined, (error: { code?: string }) => error))?.code).toBe("FORBIDDEN");
  });
}

it("fences the existing maintainer accept-only path when company membership is removed at commit", async () => {
  const t = await setup(), key = projectAiKey(TEST_ORG, "payments"), send = t.db.send.bind(t.db); let changed = false;
  t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string } } }> }).TransactItems;
    if (!changed && items?.some(item => item.Put?.Item?.pk === key.pk)) { changed = true; await send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: "state", Key: orgMemberKey(TEST_ORG, BEN.developerId) } }] })); }
    return send(command);
  };
  expect((await t.api(BEN, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 1 })).status).toBe(403);
  expect(changed).toBe(true); expect(t.db.get(key)).toBeUndefined();
  seedMembership(t.db, BEN.developerId, { orgId: TEST_ORG, role: "member" });
  expect((await t.api(BEN, "PUT", "/v1/app/projects/payments/ai", { memberAcceptRunLimitUpToUsd: 1 })).status).toBe(200);
});
for (const kind of ["project", "policy"] as const) it(`refuses ${kind} settings with neither request nor actor`, async () => {
  const t = await setup();
  const options = {} as unknown as { actor: { developerId: string; role: "admin" } };
  const job = kind === "project" ? writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false }, DEB.developerId, options) : writeSpendPolicy(t.deps(), TEST_ORG, defaultSpendPolicy(), DEB.developerId, options);
  expect((await job.then(() => undefined, (e: { code?: string }) => e))?.code).toBe("FORBIDDEN");
});
