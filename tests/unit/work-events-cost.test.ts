// Work events (U3): `cost_settled` rides in the spend settlement's own conditional transaction: one event per amount counted, none for a settle that adds nothing or loses its race, and nothing that can throw into the money path.
import { describe, expect, it, vi } from "vitest";
import { modelKeyKey, workEventExpiresAt } from "@agentx/cloud-contracts";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { registerKey, settleKey, type KeyInput, type LedgerDependencies } from "../../packages/broker/src/spend/ledger.js";
import { mintTagsFor } from "../../packages/broker/src/spend/payer.js";
import { costSettledEvent } from "../../packages/broker/src/work-events/cost.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const project = "billing-service";
describe("cost settled in the settlement", () => {
  const MONTH = "2026-11";
  const clock = Date.parse("2026-11-10T12:00:00.000Z");
  const setup = (on: boolean) => {
    const db = new FakeDynamoDb();
    const access = fakeModelAccess();
    const deps = (): LedgerDependencies => ({ documentClient: db, tableName: "state", access, now: () => clock, ...(on ? { workEvents: {} } : {}) });
    const secret = "sk-ledger-key-0001";
    const input = (extra: Partial<KeyInput> = {}): KeyInput => ({
      orgId, month: MONTH, keyId: keyIdOf(secret), capUsd: 5, scopes: [{ key: { kind: "org" } }],
      tags: mintTagsFor({ payer: { kind: "member", developerId: ownerId }, place: { project }, agentId: "agt_aaaaaaaaaaaaaaaaaaaaaaaa", origin: "app", taskId, operationId: "op-1" }),
      model: "claude-sonnet-4-6", expiresAt: clock + 3_600_000, ...extra,
    });
    const rows = () => db.find((item) => item.entityType === "WORK_EVENT");
    return { db, access, deps, secret, input, rows };
  };

  it("writes one event with the settlement, in whole micro-dollars, and none for a settle that adds nothing", async () => {
    const t = setup(true);
    const key = t.input();
    await registerKey(t.deps(), key);
    t.access.setKeySpent(t.secret, 1.2);
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ kind: "cost_settled", micros: 1_200_000, currency: "USD", orgId, project, taskId, actor: { kind: "system" } });
    expect(t.rows()[0]![INDEX_EXPIRY_ATTRIBUTE]).toBe(workEventExpiresAt(String(t.rows()[0]!.at)));
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toHaveLength(1);
    t.access.setKeySpent(t.secret, 2);
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows().map((row) => Number(row.micros)).sort((a, b) => a - b)).toEqual([800_000, 1_200_000]);
  });

  it("writes nothing when the install has work events off, and nothing for spend with no task", async () => {
    const off = setup(false);
    await registerKey(off.deps(), off.input());
    off.access.setKeySpent(off.secret, 1);
    await settleKey(off.deps(), orgId, off.input().keyId);
    expect(off.rows()).toEqual([]);
    const noTask = setup(true);
    const key = noTask.input({ tags: mintTagsFor({ payer: { kind: "member", developerId: ownerId }, place: { project }, agentId: "agt_aaaaaaaaaaaaaaaaaaaaaaaa", origin: "app" }) });
    await registerKey(noTask.deps(), key);
    noTask.access.setKeySpent(noTask.secret, 1);
    await settleKey(noTask.deps(), orgId, key.keyId);
    expect(noTask.rows()).toEqual([]);
    expect(noTask.db.get(modelKeyKey(orgId, key.keyId))).toBeDefined();
  });

  it("writes none when the settle loses its race (another settler counted first): the transaction is refused whole", async () => {
    const t = setup(true);
    const key = t.input();
    await registerKey(t.deps(), key);
    t.access.setKeySpent(t.secret, 1.2);
    // The record already counts this amount, so the settle sees nothing new and writes nothing at all.
    t.db.set({ ...t.db.get(modelKeyKey(orgId, key.keyId)), pk: modelKeyKey(orgId, key.keyId).pk, sk: modelKeyKey(orgId, key.keyId).sk, settledUsd: 1.2 });
    await settleKey(t.deps(), orgId, key.keyId);
    expect(t.rows()).toEqual([]);
  });
});

describe("the cost event builder", () => {
  const input = { orgId, project, taskId, keyId: "key-1", sequence: 3, at: "2026-11-10T12:00:00.000Z", deltaUsd: 1.2345678, source: "model" };
  it("makes one event in whole micro-dollars, with the settlement's own id", () => {
    expect(costSettledEvent(input)).toMatchObject({ kind: "cost_settled", micros: 1_234_568, currency: "USD", source: "model", actor: { kind: "system" } });
  });
  it("makes none for spend that belongs to no task or project, or for nothing", () => {
    expect(costSettledEvent({ ...input, taskId: undefined })).toBeUndefined();
    expect(costSettledEvent({ ...input, project: undefined })).toBeUndefined();
    expect(costSettledEvent({ ...input, deltaUsd: 0 })).toBeUndefined();
  });
  it("turns a source that is not a short code, or is missing, into other, never the text undefined", () => {
    expect(costSettledEvent({ ...input, source: "Slack turn for Priya" })).toMatchObject({ source: "other" });
    expect(costSettledEvent({ ...input, source: undefined })).toMatchObject({ source: "other" });
  });
});

describe("the money path", () => {
  it("still counts a settlement when the event cannot be built: nothing there throws into the money path", async () => {
    vi.resetModules();
    vi.doMock("../../packages/broker/src/work-events/cost.js", () => ({ costSettledEvent: () => { throw new Error("a future change broke the event"); } }));
    try {
      const ledger = await import("../../packages/broker/src/spend/ledger.js");
      const db = new FakeDynamoDb();
      const access = fakeModelAccess();
      const logs: Array<Record<string, unknown>> = [];
      const clock = Date.parse("2026-11-10T12:00:00.000Z");
      const deps: LedgerDependencies = { documentClient: db, tableName: "state", access, now: () => clock, workEvents: {}, log: (entry) => { logs.push(entry); } };
      const secret = "sk-ledger-key-0001";
      const key: KeyInput = {
        orgId, month: "2026-11", keyId: keyIdOf(secret), capUsd: 5, scopes: [{ key: { kind: "org" } }],
        tags: mintTagsFor({ payer: { kind: "member", developerId: ownerId }, place: { project }, agentId: "agt_aaaaaaaaaaaaaaaaaaaaaaaa", origin: "app", taskId, operationId: "op-1" }),
        model: "claude-sonnet-4-6", expiresAt: clock + 3_600_000,
      };
      await ledger.registerKey(deps, key);
      access.setKeySpent(secret, 1.2);
      expect(await ledger.settleKey(deps, orgId, key.keyId)).toMatchObject({ deltaUsd: 1.2, settledUsd: 1.2 });
      expect(db.find((item) => item["entityType"] === "WORK_EVENT")).toEqual([]);
      expect(logs).toMatchObject([{ event: "work_event.skipped", reason: "cost_event_failed", error: "Error" }]);
    } finally {
      vi.doUnmock("../../packages/broker/src/work-events/cost.js");
      vi.resetModules();
    }
  });
});
