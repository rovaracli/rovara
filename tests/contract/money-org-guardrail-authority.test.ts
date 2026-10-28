// Existing company/member budget and guardrail writes: authority and exact replaced snapshot.
import { randomUUID } from "node:crypto";
import { decideApproval, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, orgSettingsKey, orgMemberKey, developerOrgKey, orgMetaKey } from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { writeBudgets } from "../../packages/broker/src/org/budget.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { ADA, DEB, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
for (const kind of ["budgets", "guardrails"] as const) for (const mode of ["route", "store"] as const) for (const existing of [false, true]) for (const loss of ["member_role", "removed", "pointer", "closed"] as const) {
  it(`refuses ${kind} ${mode} ${existing ? "existing" : "first"} write after ${loss}`, async () => {
    const t = await setup(), capture = capturingAuditDeps({ db: t.db }), access = fakeModelAccess();
    const deps = { documentClient: t.db, tableName: "state", access, audit: capture.audit, now: Date.now };
    const store = new AgentStore(deps), key = kind === "budgets" ? orgSettingsKey(TEST_ORG, "BUDGET") : agentGuardrailsKey(TEST_ORG);
    if (existing) t.db.set({ ...key, entityType: kind === "budgets" ? "ORG_BUDGET" : "AGENT_GUARDRAILS", ...(kind === "budgets" ? { orgMonthlyUsd: 500, memberOverrides: {} } : { guardrails: DEFAULT_AGENT_GUARDRAILS }), revision: 1 });
    const before = t.db.get(key), org = t.db.get(orgMetaKey(TEST_ORG))!, actor = { developerId: DEB.developerId, role: "admin" as const };
    const options = { authority: actor }, guardInput = { orgId: TEST_ORG, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 90 }, expectedRevision: existing ? 1 : 0, by: DEB.developerId, actor };
    const write = () => kind === "budgets" ? writeBudgets(deps, TEST_ORG, { orgMonthlyUsd: 800, memberOverrides: {} }, DEB.developerId, new Date().toISOString(), options) : store.putGuardrails(guardInput);
    const call = () => t.api(DEB, "PUT", kind === "budgets" ? "/v1/dev/org/budget" : "/v1/app/org/agent-guardrails", kind === "budgets" ? { orgMonthlyUsd: 800 } : { expectedRevision: existing ? 1 : 0, guardrails: guardInput.guardrails });
    const send = t.db.send.bind(t.db); let changed = false;
    t.db.send = async command => {
      const input = command.input as { Item?: { pk?: string }; TransactItems?: Array<{ Put?: { Item?: { pk?: string } } }> };
      if (!changed && (input.Item?.pk === key.pk || input.TransactItems?.some(item => item.Put?.Item?.pk === key.pk))) {
        changed = true;
        const TransactItems = loss === "member_role" ? [{ Update: { TableName: "state", Key: orgMemberKey(TEST_ORG, DEB.developerId), UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } }]
          : loss === "closed" ? [{ Update: { TableName: "state", Key: orgMetaKey(TEST_ORG), UpdateExpression: "SET closingAt = :at", ExpressionAttributeValues: { ":at": new Date().toISOString() } } }]
            : [{ Delete: { TableName: "state", Key: loss === "removed" ? orgMemberKey(TEST_ORG, DEB.developerId) : developerOrgKey(DEB.developerId) } }];
        await send(new TransactWriteCommand({ TransactItems }));
      }
      return send(command);
    };
    if (mode === "route") expect((await call()).status).toBe(403);
    else expect((await write().then(() => undefined, (e: { code?: string }) => e))?.code).toBe("FORBIDDEN");
    expect(changed).toBe(true); expect(t.db.get(key)).toEqual(before); expect(capture.recorded()).toHaveLength(0); expect(capture.pending()).toHaveLength(0); expect(access.upsertOrg).not.toHaveBeenCalled();
    seedMembership(t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" }); t.db.set(org);
    if (mode === "route") expect((await call()).status).toBe(200); else await write();
    expect(t.db.get(key)?.revision).toBe(existing ? 2 : 1);
  });
}
for (const legacy of [false, true]) it(`refuses a concurrent org budget overwrite and audits exact replaced amounts (${legacy ? "legacy" : "versioned"})`, async () => {
  const t = await setup(), capture = capturingAuditDeps({ db: t.db }), deps = { documentClient: t.db, tableName: "state", access: fakeModelAccess(), audit: capture.audit };
  const key = orgSettingsKey(TEST_ORG, "BUDGET"); t.db.set({ ...key, entityType: "ORG_BUDGET", orgMonthlyUsd: 500, memberOverrides: {}, ...(legacy ? {} : { revision: 1 }) });
  const send = t.db.send.bind(t.db); let raced = false;
  const write = (usd: number, owner = false) => writeBudgets(deps, TEST_ORG, { orgMonthlyUsd: usd, memberOverrides: {} }, owner ? ADA.developerId : DEB.developerId, new Date().toISOString(), { authority: { developerId: owner ? ADA.developerId : DEB.developerId, role: owner ? "owner" : "admin" } });
  t.db.send = async command => {
    const input = command.input as { Item?: { pk?: string }; TransactItems?: Array<{ Put?: { Item?: { pk?: string } } }> };
    if (!raced && (input.Item?.pk === key.pk || input.TransactItems?.some(item => item.Put?.Item?.pk === key.pk))) { raced = true; await write(800, true); }
    return send(command);
  };
  expect((await write(900).then(() => undefined, (e: { code?: string }) => e))?.code).toBe("CHANGE_STALE");
  expect(raced).toBe(true); expect(t.db.get(key)?.orgMonthlyUsd).toBe(800);
  expect(capture.recorded().map(e => ({ from: e.facts?.fromCents, to: e.facts?.toCents }))).toEqual([{ from: 50000, to: 80000 }]);
  await write(900);
  expect(capture.recorded().map(e => ({ from: e.facts?.fromCents, to: e.facts?.toCents }))).toEqual([{ from: 50000, to: 80000 }, { from: 80000, to: 90000 }]);
  expect(t.db.get(key)?.revision).toBe(legacy ? 2 : 3);
});

async function guardrailApproval() {
  const t = await setup();
  expect((await t.api(DEB, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 0, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 90 } })).status).toBe(200);
  expect((await t.api(DEB, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 1, guardrails: DEFAULT_AGENT_GUARDRAILS })).status).toBe(202);
  const capture = capturingAuditDeps({ db: t.db }), deps = { ...t.deps(), audit: capture.audit, store: new AgentStore({ documentClient: t.db, tableName: "state", now: Date.now, audit: capture.audit }) };
  const record = t.db.find(item => item.entityType === "APPROVAL" && item.status === "PENDING")[0] as unknown as ApprovalRecord;
  expect(record.subject.kind).toBe("guardrails");
  const decide = () => decideApproval(deps, { orgId: TEST_ORG, developerId: ADA.developerId, orgRole: "owner" }, record.approvalId, { requestId: randomUUID(), decision: "APPROVE" });
  return { t, capture, decide };
}
for (const loss of ["demoted", "removed"] as const) it(`refuses real guardrails confirmation when actual decider is ${loss} at money commit`, async () => {
  const f = await guardrailApproval(), key = agentGuardrailsKey(TEST_ORG), before = f.t.db.get(key), send = f.t.db.send.bind(f.t.db); let changed = false;
  f.t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Put?: { Item?: { pk?: string } } }> }).TransactItems;
    if (!changed && items?.some(item => item.Put?.Item?.pk === key.pk)) {
      changed = true;
      await send(new TransactWriteCommand({ TransactItems: loss === "demoted" ? [{ Update: { TableName: "state", Key: orgMemberKey(TEST_ORG, ADA.developerId), UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } }] : [{ Delete: { TableName: "state", Key: orgMemberKey(TEST_ORG, ADA.developerId) } }] }));
    }
    return send(command);
  };
  expect((await f.decide()).status).toBe("APPROVED_FAILED"); expect(changed).toBe(true); expect(f.t.db.get(key)).toEqual(before);
  expect(f.capture.recordedBy("guardrails.changed")).toHaveLength(0);
  const control = await guardrailApproval(); expect((await control.decide()).status).toBe("APPROVED_DONE");
  expect(control.capture.recordedBy("guardrails.changed")).toHaveLength(1);
});
for (const kind of ["budgets", "guardrails"] as const) it(`refuses low-level ${kind} writer with no actor even without a request`, async () => {
  const t = await setup();
  const job = kind === "budgets" ? writeBudgets({ documentClient: t.db, tableName: "state", access: fakeModelAccess() }, TEST_ORG, { orgMonthlyUsd: 800, memberOverrides: {} }, DEB.developerId, new Date().toISOString(), {} as Parameters<typeof writeBudgets>[5])
    : t.store.putGuardrails({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 0, by: DEB.developerId } as Parameters<AgentStore["putGuardrails"]>[0]);
  expect((await job.then(() => undefined, (e: { code?: string }) => e))?.code).toBe("FORBIDDEN");
});
