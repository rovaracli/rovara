import "../support/automations-on.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentKey, chainKey } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey, ownerBudgetKey } from "@agentx/cloud-contracts";
import { ADA, BEN, DEB, TRIAGE, setup } from "../support/spend-world.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { TEST_ORG } from "../support/orgs.js";

async function fixture(kind: "agent" | "chain", active = false) {
  const t = await setup({ decide: true });
  let id: string;
  if (kind === "agent") id = await t.agentOf(TRIAGE, { by: BEN, owner: { kind: "project", project: "payments" }, accountable: BEN });
  else {
    const created = await t.api(BEN, "POST", "/v1/app/chains", { name: `Fence ${randomUUID().slice(0, 8)}`, owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    expect(created.status).toBe(201);
    const value: unknown = created.body.chain;
    if (typeof value !== "object" || value === null || !("chainId" in value) || typeof value.chainId !== "string") throw new Error("chain fixture missing id");
    id = value.chainId;
  }
  const path = `/v1/app/${kind === "agent" ? "agents" : "chains"}/${id}`;
  expect((await t.api(ADA, "PUT", path + "/budget", { monthlyUsd: 10 })).status).toBe(200);
  if (!active) expect((await t.api(DEB, "POST", path + "/archive", {})).status).toBe(200);
  const key = kind === "agent" ? agentKey(TEST_ORG, id, "META") : chainKey(TEST_ORG, id, "META");
  const state = () => ({ resource: t.db.get(key), events: t.db.find(row => row.pk === key.pk && typeof row.sk === "string" && row.sk.startsWith("EVENT#")),
    receipts: t.db.find(row => row.entityType === "AGENT_REQUEST"), total: t.db.get(ownerBudgetKey(TEST_ORG, BEN.developerId)) });
  const store = kind === "agent" ? t.deps().store : new ChainStore({ documentClient: t.db, tableName: "state", now: Date.now, agents: t.deps().store });
  return { t, id, store, key, path, state };
}
for (const kind of ["agent", "chain"] as const) {
  for (const active of [false, true]) {
    for (const loss of ["member_removed", "member_role", "pointer_removed", "pointer_moved", "org_closing", "org_closed"] as const) {
      it(`${kind} ${active ? "active no-op" : "archived"} unarchive refuses ${loss} at its actual transaction`, async () => {
        const f = await fixture(kind, active), before = f.state(), send = f.t.db.send.bind(f.t.db);
        let raced = false;
        f.t.db.send = async command => {
          if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => {
            const key = item.Update?.Key ?? item.ConditionCheck?.Key;
            return key?.pk === f.key.pk && key.sk === f.key.sk;
          })) {
            raced = true;
            if (loss === "member_removed") f.t.db.delete(orgMemberKey(TEST_ORG, DEB.developerId));
            if (loss === "member_role") f.t.db.set({ ...f.t.db.get(orgMemberKey(TEST_ORG, DEB.developerId)), role: "member" });
            if (loss === "pointer_removed") f.t.db.delete(developerOrgKey(DEB.developerId));
            if (loss === "pointer_moved") f.t.db.set({ ...f.t.db.get(developerOrgKey(DEB.developerId)), orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
            if (loss === "org_closing") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG)), closingAt: "now" });
            if (loss === "org_closed") f.t.db.set({ ...f.t.db.get(orgMetaKey(TEST_ORG)), closedAt: "now" });
          }
          return send(command);
        };
        expect((await f.t.api(DEB, "POST", f.path + "/unarchive", { requestId: randomUUID() })).status).toBe(403);
        expect(raced).toBe(true); expect(f.state()).toEqual(before);
      });
    }
  }
  it(`${kind} preserves a legitimate ordinary unarchive without enabling triggers`, async () => {
    const f = await fixture(kind);
    expect((await f.t.api(DEB, "POST", f.path + "/unarchive", {})).status).toBe(200);
    expect(f.t.db.get(f.key)?.status).toBe("active");
  });
}
it("agent unarchive pins the per-run figure even if a concurrent edit shares its millisecond timestamp", async () => {
  const f = await fixture("agent"), send = f.t.db.send.bind(f.t.db);
  let raced = false;
  f.t.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === f.key.pk && item.Update.Key.sk === f.key.sk)) {
      raced = true;
      f.t.db.set({ ...f.t.db.get(f.key), maxPerRunUsd: 7 });
    }
    return send(command);
  };
  expect((await f.t.api(DEB, "POST", f.path + "/unarchive", {})).status).toBe(409);
  expect(raced).toBe(true); expect(f.t.db.get(f.key)?.status).toBe("archived");
});

for (const kind of ["agent", "chain"] as const) {
  it(`${kind} rejects missing or mismatched actor identity before reading its monetary source`, async () => {
    const f = await fixture(kind), send = f.t.db.send.bind(f.t.db);
    let sourceReads = 0;
    f.t.db.send = async command => {
      if (command.constructor.name === "GetCommand") sourceReads++;
      return send(command);
    };
    await expect(f.store.unarchive(TEST_ORG, f.id, DEB.developerId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.store.unarchive(TEST_ORG, f.id, DEB.developerId, undefined, { actor: { developerId: ADA.developerId, role: "owner" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sourceReads).toBe(0);
  });
  it(`${kind} preserves explicit SYSTEM plus cause unarchive compatibility`, async () => {
    const f = await fixture(kind);
    expect(await f.store.unarchive(TEST_ORG, f.id, "system", undefined, { cause: { kind: "member_removed", developerId: DEB.developerId } })).toMatchObject({ status: "active" });
  });
}
