// Remaining run-limit and monthly decision commits: actor loss must beat retry, reroute and resume.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { orgMemberKey, developerOrgKey, orgMetaKey, spendRequestKey, agentKey, topUpKey, type BudgetScope, type SpendRequestRecord } from "@agentx/contracts";
import { createSpendRequest, decideSpendRequest, type SpendRequestHost } from "../../packages/broker/src/spend/requests.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, seedMembership } from "../support/developer-task-broker.js";
import { DEB, month, setup } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
async function fixture(kind: "run" | "month") {
  const t = await setup(); let record: SpendRequestRecord, taskId: string | undefined;
  const scope: BudgetScope = { kind: "org" };
  if (kind === "run") {
    const task = await t.plainTask(); taskId = task.taskId;
    await t.set(task.taskId, "SET budgetUsd = :limit", { ":limit": 80 }); await t.pauseAndEnd(task);
    record = t.requestOf(task.taskId, "run_limit")[0]!;
  } else {
    const base = (await effectiveLimits({ documentClient: t.db, tableName: "state", cloud: true }, { orgId: TEST_ORG, month: month(), scopes: [scope] })).get("ORG");
    if (base === undefined) throw new Error("Fixture monthly source missing");
    record = (await createSpendRequest(t.deps(), { orgId: TEST_ORG, kind: "month", scope, amountUsd: 10, newLimitUsd: base + 10, reason: "A bounded monthly request", requestedBy: { kind: "system" } })).record;
  }
  expect(record.status).toBe("PENDING"); expect(record.approverIds.includes(DEB.developerId)).toBe(true);
  const capture = capturingAuditDeps({ db: t.db }), resumes: unknown[] = [], base = t.deps();
  const host: SpendRequestHost = { ...base.spendRequests, resumeTask: async input => { resumes.push(input); } };
  const deps = { ...base, audit: capture.audit, spendRequests: host };
  const decide = (decision: "APPROVE" | "DENY") => decideSpendRequest(deps, t.caller(DEB, "admin"), record.spendRequestId, { requestId: randomUUID(), decision });
  return { t, record, taskId, scope, capture, resumes, decide };
}
for (const kind of ["run", "month"] as const) for (const decision of ["APPROVE", "DENY"] as const) for (const loss of ["demoted", "removed", "pointer", "closed"] as const) {
  it(`refuses ${kind} ${decision} atomically when decider is ${loss} just before commit`, async () => {
    const f = await fixture(kind), requestKey = spendRequestKey(TEST_ORG, f.record.spendRequestId), originalOrg = f.t.db.get(orgMetaKey(TEST_ORG))!;
    const beforeBudget = f.taskId === undefined ? undefined : f.t.meta(f.taskId).budgetUsd;
    const topKey = topUpKey(TEST_ORG, month(), f.scope), beforeTop = f.t.db.get(topKey);
    const send = f.t.db.send.bind(f.t.db); let changed = false;
    f.t.db.send = async command => {
      const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
      if (!changed && items?.some(item => item.Update?.Key?.pk === requestKey.pk && item.Update.Key.sk === requestKey.sk)) {
        changed = true;
        const TransactItems = loss === "demoted" ? [orgMemberKey(TEST_ORG, DEB.developerId), developerOrgKey(DEB.developerId)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } }))
          : loss === "closed" ? [{ Update: { TableName: "state", Key: orgMetaKey(TEST_ORG), UpdateExpression: "SET closingAt = :at", ExpressionAttributeValues: { ":at": new Date().toISOString() } } }]
            : [{ Delete: { TableName: "state", Key: loss === "removed" ? orgMemberKey(TEST_ORG, DEB.developerId) : developerOrgKey(DEB.developerId) } }];
        await send(new TransactWriteCommand({ TransactItems }));
      }
      return send(command);
    };
    const error = await f.decide(decision).then(() => undefined, (failure: { code?: string }) => failure);
    expect(changed).toBe(true); expect(error?.code).toBe("FORBIDDEN");
    expect(f.t.db.get(requestKey)?.status).toBe("PENDING");
    if (f.taskId !== undefined) expect(f.t.meta(f.taskId).budgetUsd).toBe(beforeBudget);
    expect(f.t.db.get(topKey)).toEqual(beforeTop); expect(f.capture.recorded()).toHaveLength(0); expect(f.capture.pending()).toHaveLength(0); expect(f.resumes).toHaveLength(0);
    seedMembership(f.t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" }); f.t.db.set(originalOrg);
    await f.decide(decision); expect(f.t.db.get(requestKey)?.status).toBe(decision === "APPROVE" ? "APPROVED" : "DENIED");
    expect(f.capture.recorded().length).toBeGreaterThan(0);
  });
}
it("prioritizes monthly actor loss over a simultaneous owner-counter reroute", async () => {
  const t = await setup(), id = await t.budgeted(30), scope: BudgetScope = { kind: "agent", agentId: id };
  const request = (await createSpendRequest(t.deps(), { orgId: TEST_ORG, kind: "month", scope, amountUsd: 10, newLimitUsd: 40, reason: "A bounded agent top-up", requestedBy: { kind: "system" } })).record;
  expect(request.approverIds.includes(MAYA.developerId)).toBe(true);
  const capture = capturingAuditDeps({ db: t.db }), store = new AgentStore({ documentClient: t.db, tableName: "state", now: Date.now, audit: capture.audit });
  const deps = { ...t.deps(), store, audit: capture.audit }, send = t.db.send.bind(t.db), requestKey = spendRequestKey(TEST_ORG, request.spendRequestId); let raced = false;
  t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Update?.Key?.pk === requestKey.pk && item.Update.Key.sk === requestKey.sk)) {
      raced = true; await store.setBudget(TEST_ORG, id, { monthlyUsd: 31 }, MAYA.developerId, undefined, { actor: { developerId: MAYA.developerId, role: "member" } });
      await send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: "state", Key: orgMemberKey(TEST_ORG, MAYA.developerId) } }] }));
    }
    return send(command);
  };
  const result = await decideSpendRequest(deps, t.caller(MAYA, "member"), request.spendRequestId, { requestId: randomUUID(), decision: "APPROVE" }).then(value => ({ value, code: undefined }), (error: { code?: string }) => ({ value: undefined, code: error.code }));
  expect(raced).toBe(true); expect(result.code).toBe("FORBIDDEN");
  expect(t.db.get(requestKey)?.status).toBe("PENDING"); expect(t.db.get(requestKey)?.approverRole).toBe(request.approverRole);
  expect(t.db.get(topUpKey(TEST_ORG, month(), scope))).toBeUndefined(); expect(t.db.get(agentKey(TEST_ORG, id, "META"))?.monthlyBudgetUsd).toBe(31);
  expect(capture.recorded()).toHaveLength(1); expect(capture.pending()).toHaveLength(0);
});
