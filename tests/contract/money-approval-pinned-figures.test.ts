import { randomUUID } from "node:crypto";
// The chain cases drive /v1/app/chains, which answers only while WEB_FEATURES names `chains` (chains/automations-gate.ts).
import "../support/automations-on.js";
import { expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentKey, chainKey } from "@rovara-code/contracts";
import { spendRequestKey } from "@agentx/cloud-contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { decideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
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
  for (const phase of ["between_ask_and_decision", "at_native_commit"] as const) {
    it(`C101 ${kind} ${op} requires a new ask when figures change ${phase}`, async () => {
      const f = await approval(kind, op);
      const change = async () => {
        // This is a real authorized competing HTTP write, not a malformed raw
        // item. Archived budget edits count no active share until unarchive.
        const edit = await f.t.api(ADA, "PUT", f.s.path + "/budget", { monthlyUsd: op === "budget" ? 20 : 31 });
        expect(edit.status).toBe(200);
      };
      let changed = false;
      if (phase === "between_ask_and_decision") { await change(); changed = true; }
      else {
        const send = f.t.db.send.bind(f.t.db);
        f.t.db.send = async command => {
          if (!changed && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => {
            const key = item.Update?.Key;
            return key?.pk === f.s.key.pk && key.sk === f.s.key.sk;
          })) { changed = true; await change(); }
          return send(command);
        };
      }
      await expect(f.decide()).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
      expect(changed).toBe(true);
      const request = f.t.db.get(spendRequestKey(TEST_ORG, f.requestId));
      expect(request).toMatchObject({ status: "EXPIRED", endedBecause: "figures_changed" });
      expect(f.t.db.get(f.s.key)?.monthlyBudgetUsd).toBe(op === "budget" ? 20 : 31);
      if (op === "unarchive") expect(f.t.db.get(f.s.key)?.status).toBe("archived");
    });
  }
}
it("C101 leaves a real unchanged ask decidable by the actual second person", async () => {
  const f = await approval("agent", "owner");
  await expect(f.decide()).resolves.toMatchObject({ spendRequest: { status: "APPROVED" } });
});
for (const invalid of ["missing", "missing_key", "wrong_version"] as const) it(`C101 expires ${invalid} original terms without a money write`, async () => {
  const f = await approval("agent", "owner");
  const key = spendRequestKey(TEST_ORG, f.requestId), row = f.t.db.get(key)!;
  if (invalid === "missing") delete row.approvalSource;
  else row.approvalSource = invalid === "missing_key" ? { version: 1, exists: true, fields: {} } : { version: 999 };
  f.t.db.set(row); const before = f.t.db.get(f.s.key);
  await expect(f.decide()).rejects.toMatchObject({ code: "SPENDING_APPROVAL_STALE" });
  expect(f.t.db.get(f.s.key)).toEqual(before);
  // M47: incomplete original approval terms expire as spending_rules_changed, without a financial write.
  expect(f.t.db.get(key)).toMatchObject({ status: "EXPIRED", endedBecause: "spending_rules_changed" });
});
