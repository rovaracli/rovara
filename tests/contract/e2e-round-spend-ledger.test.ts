// Proof and test environment E13 (review I1, I2): the round's key through the REAL mintOperationKey and spend ledger. The proxy is asked for exactly the round's worst case, and the key is reserved on the ledger
// (project, org and member scopes each hold the cap) before the grant is returned. A room smaller than the worst case refuses the round and leaves no hold behind.
import { describe, expect, it } from "vitest";
import { scopeKey, spendCounterKey, type BudgetScope } from "@agentx/contracts";
import { mintRoundKeyPort, startE2eRoundSpend } from "../../packages/broker/src/e2e/model-spend.js";
import { admitWork, mintOperationKey } from "../../packages/broker/src/spend/admission.js";
import { finalizeKey, type LedgerDependencies } from "../../packages/broker/src/spend/ledger.js";
import { budgetScopesFor, mintTagsFor } from "../../packages/broker/src/spend/payer.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import type { TransactItem } from "../../packages/broker/src/agents/table-writes.js";

const MONTH = "2026-10";
const T0 = Date.parse("2026-10-21T12:00:00.000Z");
// The fake proxy gives every key one fixed expiry (2026-10-19T13:00Z): the round starts before it.
const ROUND_NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MAYA = "1".repeat(64);
const WEB: BudgetScope = { kind: "project", project: "web" };
const MEMBER: BudgetScope = { kind: "member", developerId: MAYA };
const PRICE = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const WORST = 5.444;
const payer = { kind: "member", developerId: MAYA } as const;

function setup(memberSpentUsd = 0) {
  const db = new FakeDynamoDb();
  const access = fakeModelAccess();
  access.setMemberSpent(TEST_ORG, MAYA, memberSpentUsd);
  access.setOrgSpent(TEST_ORG, 0);
  const deps = { documentClient: db, tableName: "state", access, now: () => T0, cloud: true };
  const ledger: LedgerDependencies = { documentClient: db, tableName: "state", access, now: () => T0, cloud: true };
  const base = {
    orgId: TEST_ORG, developerId: MAYA, refId: "op-1", agentName: "Rovara Code", taskKeyIds: [] as string[], operationKeyIds: [] as string[],
    scopes: budgetScopesFor(payer, { project: "web" }, { agentId: "rovara-code" }),
    tags: mintTagsFor({ payer, place: { project: "web" }, agentId: "rovara-code", origin: "app", taskId: "task-1", operationId: "op-1" }),
    keepEarlierKeys: true,
    // The task-stop guard of the wiring (handleModelAccess builds the real one from the task); this test task has no stop, so it passes the items through.
    guardRecord: (items: readonly TransactItem[]) => [...items],
  };
  const committed = (scope: BudgetScope) => (db.get(spendCounterKey(TEST_ORG, MONTH, scopeKey(scope))) as { committedUsd?: number } | undefined)?.committedUsd ?? 0;
  const ports = (withLedger = true) => ({
    admit: () => admitWork(deps, { orgId: TEST_ORG, payer, project: "web", agentId: "rovara-code", agentName: "Rovara Code", path: "FULL" }),
    mint: mintRoundKeyPort({ mintOperationKey, deps: withLedger ? { ...deps, ledger } : deps, base }),
    close: async (_org: string, keyId: string) => { await access.blockKey(keyId); return finalizeKey(ledger, TEST_ORG, keyId); },
    proxyBaseUrl: "https://proxy.example/v1",
    now: () => ROUND_NOW,
  });
  const input = { orgId: TEST_ORG, operationId: "op-1", routeAlias: "e2e-nav", groups: 3, price: PRICE, roundSeconds: 1_800 };
  return { access, committed, ports, input };
}

describe("a round's key over the real admission, proxy and ledger", () => {
  it("asks the proxy for exactly the worst case, for the e2e route only, and holds it on every scope before the grant", async () => {
    const t = setup();
    const result = await startE2eRoundSpend(t.ports(), t.input);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.worstCaseUsd).toBe(WORST);
    expect(result.grant.capUsd).toBe(WORST);
    expect(t.access.mintKey.mock.calls.map((call) => ({ max: call[0].maxBudgetUsd, models: call[0].models }))).toEqual([{ max: WORST, models: ["e2e-nav"] }]);
    for (const scope of [WEB, { kind: "org" } as BudgetScope, MEMBER]) expect(t.committed(scope), scopeKey(scope)).toBeCloseTo(WORST, 6);
  });
  it("closing the round gives the unspent cap back on every scope", async () => {
    const t = setup();
    const result = await startE2eRoundSpend(t.ports(), t.input);
    if (!result.ok) throw new Error("refused");
    expect(await t.ports().close(TEST_ORG, result.grant.keyId)).toBe(true);
    for (const scope of [WEB, { kind: "org" } as BudgetScope, MEMBER]) expect(t.committed(scope), scopeKey(scope)).toBe(0);
  });
  it("a room smaller than the worst case refuses the round and leaves no hold behind", async () => {
    const t = setup(29);
    const result = await startE2eRoundSpend(t.ports(), t.input);
    expect(result.ok).toBe(false);
    for (const scope of [WEB, { kind: "org" } as BudgetScope, MEMBER]) expect(t.committed(scope), scopeKey(scope)).toBe(0);
  });
  it("without the ledger there is no reservation to claim: the binding cannot be built", () => {
    const t = setup();
    expect(() => t.ports(false)).toThrow(RangeError);
  });
});
