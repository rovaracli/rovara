// Both identities of a merged decider must retain their own current-org membership at commit.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { orgMemberKey, developerOrgKey, spendRequestKey, topUpKey, type BudgetScope, type SpendRequestRecord } from "@agentx/cloud-contracts";
import { agentKey } from "@rovara-code/contracts";
import { createSpendRequest, decideSpendRequest, type SpendRequestHost } from "../../packages/broker/src/spend/requests.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, seedMembership } from "../support/developer-task-broker.js";
import { BEN, DEB, month, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
type Kind = "run" | "month" | "owner_cap";
async function fixture(kind: Kind, survivorRole: "admin" | "owner" = "admin") {
  const t = await setup(); let record: SpendRequestRecord, taskId: string | undefined, agentId: string | undefined;
  const scope: BudgetScope = { kind: "org" };
  if (kind === "run") {
    const task = await t.plainTask(); taskId = task.taskId;
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 80 }); await t.pauseAndEnd(task);
    record = t.requestOf(task.taskId, "run_limit")[0]!;
  } else if (kind === "month") {
    const base = (await effectiveLimits({ documentClient: t.db, tableName: "state", cloud: true }, { orgId: TEST_ORG, month: month(), scopes: [scope] })).get("ORG");
    if (base === undefined) throw new Error("Fixture monthly source missing");
    record = (await createSpendRequest(t.deps(), { orgId: TEST_ORG, kind: "month", scope, amountUsd: 10, newLimitUsd: base + 10, reason: "A bounded monthly request", requestedBy: { kind: "system" } })).record;
  } else {
    await t.budgeted(40); await t.budgeted(40); agentId = await t.budgeted(1);
    const reply = await t.api(MAYA, "PUT", `/v1/app/agents/${agentId}/budget`, { monthlyUsd: 31 });
    expect(reply.status).toBe(202); record = t.requests().find(r => r.kind === "owner_cap")!;
  }
  expect(record.status).toBe("PENDING");
  seedMembership(t.db, BEN.developerId, { orgId: TEST_ORG, role: survivorRole });
  t.db.set({ ...t.db.get(`DEVELOPER#${DEB.developerId}`, "META")!, mergedInto: BEN.developerId });
  const capture = capturingAuditDeps({ db: t.db }), resumes: unknown[] = [], base = t.deps();
  const host: SpendRequestHost = { ...base.spendRequests, resumeTask: async input => { resumes.push(input); } };
  const deps = { ...base, audit: capture.audit, spendRequests: host };
  const decide = (decision: "APPROVE" | "DENY") => decideSpendRequest(deps, t.caller(DEB, "admin"), record.spendRequestId, { requestId: randomUUID(), decision });
  return { t, record, taskId, agentId, scope, capture, resumes, decide };
}
for (const kind of ["run", "month", "owner_cap"] as const) for (const decision of ["APPROVE", "DENY"] as const) for (const loss of ["demoted", "member_only", "removed", "pointer", "survivor"] as const) {
  it(`refuses merged ${kind} ${decision} when ${loss} wins before commit`, async () => {
    const f = await fixture(kind), requestKey = spendRequestKey(TEST_ORG, f.record.spendRequestId);
    const beforeBudget = f.taskId === undefined ? undefined : f.t.meta(f.taskId).budgetUsd;
    const agent = f.agentId === undefined ? undefined : f.t.db.get(agentKey(TEST_ORG, f.agentId, "META"));
    const top = topUpKey(TEST_ORG, month(), f.scope), beforeTop = f.t.db.get(top);
    const send = f.t.db.send.bind(f.t.db); let changed = false;
    f.t.db.send = async command => {
      const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
      if (!changed && items?.some(item => item.Update?.Key?.pk === requestKey.pk && item.Update.Key.sk === requestKey.sk)) {
        changed = true; const who = loss === "survivor" ? BEN : DEB;
        const TransactItems = loss === "demoted" || loss === "member_only" || loss === "survivor" ? [orgMemberKey(TEST_ORG, who.developerId), ...(loss === "member_only" ? [] : [developerOrgKey(who.developerId)])].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } }))
          : [{ Delete: { TableName: "state", Key: loss === "removed" ? orgMemberKey(TEST_ORG, who.developerId) : developerOrgKey(who.developerId) } }];
        await send(new TransactWriteCommand({ TransactItems }));
      }
      return send(command);
    };
    const error = await f.decide(decision).then(() => undefined, (failure: { code?: string }) => failure);
    expect(changed).toBe(true); expect(error?.code).toBe("FORBIDDEN"); expect(f.t.db.get(requestKey)?.status).toBe("PENDING");
    if (f.taskId !== undefined) expect(f.t.meta(f.taskId).budgetUsd).toBe(beforeBudget);
    if (f.agentId !== undefined) expect(f.t.db.get(agentKey(TEST_ORG, f.agentId, "META"))).toEqual(agent);
    expect(f.t.db.get(top)).toEqual(beforeTop); expect(f.capture.recorded()).toHaveLength(0); expect(f.capture.pending()).toHaveLength(0); expect(f.resumes).toHaveLength(0);
  });
}
for (const kind of ["run", "month", "owner_cap"] as const) for (const role of ["admin", "owner"] as const) {
  it(`allows legitimate merged ${kind} approval with survivor's own ${role} role and unique transaction keys`, async () => {
    const f = await fixture(kind, role), send = f.t.db.send.bind(f.t.db); let checked = false;
    f.t.db.send = async command => {
      const items = (command.input as { TransactItems?: Array<Record<string, { Key?: { pk?: string; sk?: string }; Item?: { pk?: string; sk?: string } }>> }).TransactItems;
      if (items?.some(item => item.Update?.Key?.sk === spendRequestKey(TEST_ORG, f.record.spendRequestId).sk)) {
        checked = true; const keys = items.map(item => { const op = Object.values(item)[0]!; const key = op.Key ?? op.Item!; return `${key.pk}|${key.sk}`; });
        expect(new Set(keys).size).toBe(keys.length);
      }
      return send(command);
    };
    await f.decide("APPROVE"); expect(checked).toBe(true);
    expect(f.t.db.get(spendRequestKey(TEST_ORG, f.record.spendRequestId))?.status).toBe("APPROVED");
  });
}

for (const kind of ["run", "month", "owner_cap"] as const) {
  it(`refuses stale merged ${kind} session after real retirement and accepts survivor's own session`, async () => {
    const f = await fixture(kind), deps = f.t.deps();
    const duplicate = { ...f.t.db.get(`DEVELOPER#${DEB.developerId}`, "META")! }; delete duplicate.mergedInto; duplicate.issuer = "https://identity.example.test"; duplicate.subject = "merged-admin"; f.t.db.set(duplicate);
    await mergeDuplicateMember({ documentClient: f.t.db, tableName: "state", signInStore: new DeveloperSignInStore({ documentClient: f.t.db, tableName: "state", now: Date.now }), now: Date.now }, {
      orgId: TEST_ORG, survivorId: BEN.developerId, duplicateId: DEB.developerId, duplicateIdentityKey: ownerKeyForSubject("https://identity.example.test", "merged-admin"),
    });
    expect(f.t.db.get(orgMemberKey(TEST_ORG, DEB.developerId))).toBeUndefined();
    expect(f.t.db.get(developerOrgKey(DEB.developerId))).toBeUndefined();
    const error = await f.decide("APPROVE").then(() => undefined, (failure: { code?: string }) => failure);
    expect(error?.code).toBe("FORBIDDEN"); expect(f.t.db.get(spendRequestKey(TEST_ORG, f.record.spendRequestId))?.status).toBe("PENDING");
    await decideSpendRequest(deps, f.t.caller(BEN, "admin"), f.record.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" });
    expect(f.t.db.get(spendRequestKey(TEST_ORG, f.record.spendRequestId))?.status).toBe("APPROVED");
  });
}
