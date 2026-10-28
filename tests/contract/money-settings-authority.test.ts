// The existing project-AI and spend-policy writers must refuse actor loss in their commit.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { defaultSpendPolicy, orgMemberKey, developerOrgKey, orgMetaKey, orgSettingsKey, projectAiKey } from "@agentx/contracts";
import { writeProjectAi, writeSpendPolicy } from "../../packages/broker/src/spend/settings.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const kind of ["project", "policy"] as const) for (const mode of ["route", "store"] as const) for (const loss of ["member_role", "removed", "pointer", "closed"] as const) {
  it(`refuses ${kind} ${mode} settings commit after ${loss} and permits restored writer`, async () => {
    const t = await setup(), capture = capturingAuditDeps({ db: t.db }), deps = { ...t.deps(), audit: capture.audit };
    const key = kind === "project" ? projectAiKey(TEST_ORG, "payments") : orgSettingsKey(TEST_ORG, "SPEND_POLICY");
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
    expect(t.db.get(key)?.revision).toBe(1);
  });
}
for (const kind of ["project", "policy"] as const) for (const mismatch of ["missing", "actor", "request"] as const) {
  it(`refuses request-bearing ${kind} writer with ${mismatch} authority context`, async () => {
    const t = await setup(), request = { orgId: TEST_ORG, developerId: mismatch === "request" ? "a".repeat(64) : DEB.developerId, requestId: randomUUID(), fingerprint: "settings-bound" };
    const options = { request, ...(mismatch === "missing" ? {} : { actor: { developerId: mismatch === "actor" ? "a".repeat(64) : DEB.developerId, role: "admin" as const } }) };
    const write = kind === "project" ? writeProjectAi(t.deps(), TEST_ORG, "payments", { projectPays: false }, DEB.developerId, options) : writeSpendPolicy(t.deps(), TEST_ORG, defaultSpendPolicy(), DEB.developerId, options);
    expect((await write.then(() => undefined, (error: { code?: string }) => error))?.code).toBe("FORBIDDEN");
  });
}
