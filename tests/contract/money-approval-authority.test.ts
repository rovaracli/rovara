import { afterProjectBootstrap } from "../support/transaction-audit.js";
// The existing owner-cap approval boundary, across agent and chain money/ownership changes.
import { fixtureActor } from "../support/money-authority.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { agentKey, chainKey, orgMemberKey, developerOrgKey, spendRequestKey } from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { decideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR, seedMembership } from "../support/developer-task-broker.js";
import { ADA, BEN, DEB, TRIAGE, setup, type World } from "../support/spend-world.js";
import { TEST_ORG } from "../support/orgs.js";
type Kind = "agent" | "chain";
type Op = "budget" | "owner" | "accountable" | "unarchive";
async function subject(t: World, kind: Kind, project = false) {
  const plural = kind === "agent" ? "agents" : "chains";
  const created = await t.api(project ? BEN : MAYA, "POST", `/v1/app/${plural}`, { name: `Money ${randomUUID().slice(0, 8)}`, ...(kind === "agent" ? { overlay: TRIAGE } : {}), ...(project ? { owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } } : {}) });
  expect(created.status).toBe(201);
  const id = String((created.body[kind] as Record<string, unknown>)[kind === "agent" ? "agentId" : "chainId"]);
  const key = kind === "agent" ? agentKey(TEST_ORG, id, "META") : chainKey(TEST_ORG, id, "META");
  return { id, key, path: `/v1/app/${plural}/${id}` };
}
async function approval(kind: Kind, op: Op) {
  const t = await setup();
  if (op === "owner") { await t.budgeted(40, OMAR); await t.budgeted(40, OMAR); }
  if (op === "budget" || op === "accountable") { await t.budgeted(40); await t.budgeted(40); }
  if (op === "accountable") t.grantRole(MAYA, "maintainer");
  const s = await subject(t, kind, op === "accountable");
  if (op !== "budget") expect((await t.api(ADA, "PUT", s.path + "/budget", { monthlyUsd: 30 })).status).toBe(200);
  if (op === "unarchive") {
    expect((await t.api(ADA, "POST", s.path + "/archive", {})).status).toBe(200);
    await t.budgeted(40); await t.budgeted(40);
  }
  const result = op === "budget" ? await t.api(ADA, "PUT", s.path + "/budget", { monthlyUsd: 30 })
    : op === "owner" ? await t.api(ADA, "PUT", s.path + "/owner", { owner: { kind: "member", developerId: OMAR.developerId } })
      : op === "accountable" ? await t.api(ADA, "PUT", s.path + "/accountable", { accountable: { developerId: MAYA.developerId } })
        : await t.api(ADA, "POST", s.path + "/unarchive", {});
  expect(result.status).toBe(202); const requestId = String(result.body.spendRequestId);
  const capture = capturingAuditDeps({ db: t.db });
  const store = new AgentStore({ documentClient: t.db, tableName: "state", now: Date.now, audit: capture.audit });
  const chains = new ChainStore({ documentClient: t.db, tableName: "state", now: Date.now, agents: store, audit: capture.audit });
  const deps = { ...t.deps(), store, chains, audit: capture.audit };
  const decide = (decision: "APPROVE" | "DENY" = "APPROVE") => decideSpendRequest(deps, t.caller(DEB, "admin"), requestId, { requestId: randomUUID(), decision });
  return { t, s, requestId, capture, store, chains, decide };
}
for (const kind of ["agent", "chain"] as const) for (const op of ["budget", "owner", "accountable", "unarchive"] as const) {
  it(`refuses a demoted approver atomically for ${kind} ${op}`, async () => {
    const f = await approval(kind, op), before = f.t.db.get(f.s.key), totals = [f.t.ownerTotal(MAYA), f.t.ownerTotal(OMAR), f.t.ownerTotal(BEN)];
    const send = f.t.db.send.bind(f.t.db); let demoted = false;
    f.t.db.send = async command => {
      const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
      if (!demoted && items?.some(item => item.Update?.Key?.pk === f.s.key.pk && item.Update.Key.sk === f.s.key.sk)) {
        demoted = true;
        await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(TEST_ORG, DEB.developerId), developerOrgKey(DEB.developerId)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
      }
      return send(command);
    };
    const error = await f.decide().then(() => undefined, (failure: { code?: string }) => failure);
    expect(demoted).toBe(true); expect(error?.code).toBe("FORBIDDEN");
    expect(f.t.db.get(f.s.key)).toEqual(before); expect([f.t.ownerTotal(MAYA), f.t.ownerTotal(OMAR), f.t.ownerTotal(BEN)]).toEqual(totals);
    expect(f.t.db.get(spendRequestKey(TEST_ORG, f.requestId))?.status).toBe("PENDING");
    expect(afterProjectBootstrap(f.capture.recorded())).toHaveLength(0); expect(afterProjectBootstrap(f.capture.pending())).toHaveLength(0);
    seedMembership(f.t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" });
    await f.decide(); expect(f.t.db.get(spendRequestKey(TEST_ORG, f.requestId))?.status).toBe("APPROVED");
    expect(afterProjectBootstrap(f.capture.recorded()).length).toBeGreaterThan(0);
  });
}
it("refuses a direct chain budget write when actor demotion wins the commit race", async () => {
  const t = await setup(), s = await subject(t, "chain"), before = t.db.get(s.key), send = t.db.send.bind(t.db); let demoted = false;
  t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!demoted && items?.some(item => item.Update?.Key?.pk === s.key.pk && item.Update.Key.sk === s.key.sk)) {
      demoted = true; await send(new TransactWriteCommand({ TransactItems: [orgMemberKey(TEST_ORG, DEB.developerId), developerOrgKey(DEB.developerId)].map(Key => ({ Update: { TableName: "state", Key, UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": "member" } } })) }));
    }
    return send(command);
  };
  expect((await t.api(DEB, "PUT", s.path + "/budget", { monthlyUsd: 20 })).status).toBe(403);
  expect(demoted).toBe(true); expect(t.db.get(s.key)).toEqual(before);
  seedMembership(t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" });
  expect((await t.api(DEB, "PUT", s.path + "/budget", { monthlyUsd: 20 })).status).toBe(200);
});
for (const kind of ["agent", "chain"] as const) it(`preserves a competing committed budget and audit during ${kind} owner approval`, async () => {
  const f = await approval(kind, "owner"), send = f.t.db.send.bind(f.t.db); let raced = false;
  f.t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
    if (!raced && items?.some(item => item.Update?.Key?.pk === f.s.key.pk && item.Update.Key.sk === f.s.key.sk)) {
      raced = true;
      if (kind === "agent") await f.store.setBudget(TEST_ORG, f.s.id, { monthlyUsd: 25 }, MAYA.developerId, undefined, { actor: { developerId: MAYA.developerId, role: "member" } });
      else await f.chains.setBudget(TEST_ORG, f.s.id, 25, MAYA.developerId, undefined, { actor: { developerId: MAYA.developerId, role: "member" } });
    }
    return send(command);
  };
  const error = await f.decide().then(() => undefined, (failure: { code?: string }) => failure);
  expect(raced).toBe(true); expect(error?.code).toBe("SPENDING_APPROVAL_STALE");
  expect(f.t.db.get(f.s.key)?.monthlyBudgetUsd).toBe(25); expect(f.t.db.get(f.s.key)?.owner).toEqual({ kind: "member", developerId: MAYA.developerId });
  expect(f.t.db.get(spendRequestKey(TEST_ORG, f.requestId))).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
  expect(afterProjectBootstrap(f.capture.recorded())).toHaveLength(2); expect(afterProjectBootstrap(f.capture.pending())).toHaveLength(0);
});

it("fences the deciding actor when an owner-cap request is denied", async () => {
  const f = await approval("chain", "owner"), before = f.t.db.get(f.s.key), send = f.t.db.send.bind(f.t.db); let removed = false;
  f.t.db.send = async command => {
    const items = (command.input as { TransactItems?: Array<{ Update?: { Key?: { pk?: string; sk?: string } } }> }).TransactItems;
    const key = spendRequestKey(TEST_ORG, f.requestId);
    if (!removed && items?.some(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk)) {
      removed = true; await send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: "state", Key: orgMemberKey(TEST_ORG, DEB.developerId) } }] }));
    }
    return send(command);
  };
  const error = await f.decide("DENY").then(() => undefined, (failure: { code?: string }) => failure);
  expect(removed).toBe(true); expect(error?.code).toBe("FORBIDDEN");
  expect(f.t.db.get(f.s.key)).toEqual(before); expect(f.t.db.get(spendRequestKey(TEST_ORG, f.requestId))?.status).toBe("PENDING");
  expect(afterProjectBootstrap(f.capture.recorded())).toHaveLength(0);
  seedMembership(f.t.db, DEB.developerId, { orgId: TEST_ORG, role: "admin" });
  await f.decide("DENY"); expect(f.t.db.get(spendRequestKey(TEST_ORG, f.requestId))?.status).toBe("DENIED");
  expect(f.t.db.get(f.s.key)).toEqual(before); expect(afterProjectBootstrap(f.capture.recorded()).length).toBeGreaterThan(0);
});

it("refuses direct chain money after ownership moves between manage access and the store read", async () => {
  const t = await setup(), s = await subject(t, "chain"), send = t.db.send.bind(t.db); let moved = false;
  t.db.send = async command => {
    const result = await send(command), key = (command.input as { Key?: { pk?: string; sk?: string } }).Key;
    if (!moved && command.constructor.name === "GetCommand" && key?.pk === s.key.pk && key.sk === s.key.sk) {
      moved = true; await t.deps().chains!.setOwner(TEST_ORG, s.id, { kind: "member", developerId: OMAR.developerId }, ADA.developerId, undefined, undefined, { actor: fixtureActor(t.db, TEST_ORG, ADA.developerId) });
    }
    return result;
  };
  expect((await t.api(MAYA, "PUT", s.path + "/budget", { monthlyUsd: 20 })).status).toBe(409);
  expect(moved).toBe(true); expect(t.db.get(s.key)?.monthlyBudgetUsd).toBeUndefined();
  expect(t.db.get(s.key)?.owner).toEqual({ kind: "member", developerId: OMAR.developerId });
});
