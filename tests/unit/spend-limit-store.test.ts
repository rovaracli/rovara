// Lead 3 B1: the company store's per-project and per-person monthly limit items (company-store.ts SpendLimit). The same cases run against the
// memory store and the DynamoDB store on FakeDynamoDb (which evaluates the store's own condition expressions and all-or-nothing transactions).
// A write is conditional on exactly what was read (the override's version and amount, and the settings version the default came from);
// a row that does not read as exactly this company's, kind's and id's is an outage, never "none saved"; two companies never meet.
import { describe, expect, it } from "vitest";
import {
  CompanyStoreConflict, DynamoCompanyStore, LocalCompanyStore, SPEND_LIMITS_MAX, SPEND_LIMIT_SORT_PREFIX, defaultCompanySettings,
  type CompanyStore, type SpendLimitBasis,
} from "../../packages/cloud-server/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const P1 = "1".repeat(64);
const at = "2026-11-17T12:00:00.000Z";
const by = "d".repeat(64);
const none = (settingsVersion: number): SpendLimitBasis => ({ override: undefined, settingsVersion });

interface Harness { name: string; make: () => { store: CompanyStore; damage: (companyId: string, kind: "project" | "person", id: string, change: Record<string, unknown>) => void } }
const harnesses: Harness[] = [
  { name: "LocalCompanyStore", make: () => { const store = new LocalCompanyStore(); return { store, damage: (c, k, i) => store.corruptSpendLimit(c, k, i) }; } },
  {
    name: "DynamoCompanyStore (FakeDynamoDb)",
    make: () => {
      const fake = new FakeDynamoDb();
      const store = new DynamoCompanyStore(fake, "cloud-companies");
      return { store, damage: (c, k, i, change) => { const key = { pk: `COMPANY#${c}`, sk: `${SPEND_LIMIT_SORT_PREFIX[k]}${i}` }; fake.set({ ...fake.get(key)!, ...change }); } };
    },
  },
];

for (const { name, make } of harnesses) {
  describe(name, () => {
    const withSettings = async (store: CompanyStore, companyId = A) => { await store.putSettings(companyId, defaultCompanySettings(), 0, by, at); };

    it("saves an override at version 1, reads it back as that company's, and nothing for another company or id", async () => {
      const { store } = make(); await withSettings(store);
      expect(await store.spendLimit(A, "project", "web")).toBeUndefined();
      expect(await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 5_000_000, updatedAt: at, updatedBy: by }, none(1))).toBe(1);
      expect(await store.spendLimit(A, "project", "web")).toEqual({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 5_000_000, version: 1, updatedAt: at, updatedBy: by });
      expect(await store.spendLimit(B, "project", "web")).toBeUndefined();
      expect(await store.spendLimit(A, "project", "api")).toBeUndefined();
      expect(await store.spendLimit(A, "person", "web")).toBeUndefined();
    });

    it("two companies keep the same project name and the same person apart", async () => {
      const { store } = make(); await withSettings(store, A); await withSettings(store, B);
      await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 1, updatedAt: at, updatedBy: by }, none(1));
      await store.putSpendLimit({ companyId: B, kind: "project", id: "web", monthlyUsdMicros: 2, updatedAt: at, updatedBy: by }, none(1));
      await store.putSpendLimit({ companyId: A, kind: "person", id: P1, monthlyUsdMicros: 3, updatedAt: at, updatedBy: by }, none(1));
      expect((await store.spendLimit(A, "project", "web"))?.monthlyUsdMicros).toBe(1);
      expect((await store.spendLimit(B, "project", "web"))?.monthlyUsdMicros).toBe(2);
      expect((await store.spendLimits(A)).people.map((l) => l.id)).toEqual([P1]);
      expect((await store.spendLimits(B)).people).toEqual([]);
      expect((await store.spendLimits(B)).projects.map((l) => [l.companyId, l.monthlyUsdMicros])).toEqual([[B, 2]]);
      await store.removeSpendLimit(A, "project", "web", { override: { version: 1, monthlyUsdMicros: 1 }, settingsVersion: 1 });
      expect(await store.spendLimit(B, "project", "web")).toBeDefined();
    });

    it("writes only while the override is exactly as read (version and amount) and the settings are at the version the default came from", async () => {
      const { store } = make(); await withSettings(store);
      const limit = (monthlyUsdMicros: number) => ({ companyId: A, kind: "project" as const, id: "web", monthlyUsdMicros, updatedAt: at, updatedBy: by });
      await store.putSpendLimit(limit(10), none(1));
      // Creating again when one exists, or against the wrong version or amount, or the wrong settings version, is a conflict that changes nothing.
      await expect(store.putSpendLimit(limit(20), none(1))).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.putSpendLimit(limit(20), { override: { version: 2, monthlyUsdMicros: 10 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.putSpendLimit(limit(20), { override: { version: 1, monthlyUsdMicros: 11 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.putSpendLimit(limit(20), { override: { version: 1, monthlyUsdMicros: 10 }, settingsVersion: 2 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect((await store.spendLimit(A, "project", "web"))?.monthlyUsdMicros).toBe(10);
      expect(await store.putSpendLimit(limit(20), { override: { version: 1, monthlyUsdMicros: 10 }, settingsVersion: 1 })).toBe(2);
      expect(await store.spendLimit(A, "project", "web")).toMatchObject({ monthlyUsdMicros: 20, version: 2 });
      // The settings moved on (an admin raised the default): the same basis is now refused.
      await store.putSettings(A, defaultCompanySettings(), 1, by, at);
      await expect(store.putSpendLimit(limit(30), { override: { version: 2, monthlyUsdMicros: 20 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.removeSpendLimit(A, "project", "web", { override: { version: 2, monthlyUsdMicros: 20 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect((await store.spendLimit(A, "project", "web"))?.version).toBe(2);
    });

    it("a company with no saved settings is settings version 0, and a basis of 0 holds only while none are saved", async () => {
      const { store } = make();
      await store.putSpendLimit({ companyId: A, kind: "person", id: P1, monthlyUsdMicros: 1, updatedAt: at, updatedBy: by }, none(0));
      await withSettings(store);
      await expect(store.putSpendLimit({ companyId: A, kind: "person", id: P1, monthlyUsdMicros: 2, updatedAt: at, updatedBy: by }, { override: { version: 1, monthlyUsdMicros: 1 }, settingsVersion: 0 })).rejects.toBeInstanceOf(CompanyStoreConflict);
    });

    it("removes only the override that was read; a removal with no override, or a stale one, is a conflict", async () => {
      const { store } = make(); await withSettings(store);
      await expect(store.removeSpendLimit(A, "project", "web", none(1))).rejects.toBeInstanceOf(CompanyStoreConflict);
      await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 7, updatedAt: at, updatedBy: by }, none(1));
      await expect(store.removeSpendLimit(A, "project", "web", { override: { version: 1, monthlyUsdMicros: 8 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.removeSpendLimit(A, "project", "web", { override: { version: 3, monthlyUsdMicros: 7 }, settingsVersion: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.spendLimit(A, "project", "web")).toBeDefined();
      await store.removeSpendLimit(A, "project", "web", { override: { version: 1, monthlyUsdMicros: 7 }, settingsVersion: 1 });
      expect(await store.spendLimit(A, "project", "web")).toBeUndefined();
    });

    it("lists each kind in order, bounded: at most SPEND_LIMITS_MAX of a kind, and says when there were more", async () => {
      const { store } = make(); await withSettings(store);
      for (let i = 0; i < SPEND_LIMITS_MAX.project + 1; i++) {
        await store.putSpendLimit({ companyId: A, kind: "project", id: `p${String(i).padStart(3, "0")}`, monthlyUsdMicros: i, updatedAt: at, updatedBy: by }, none(1));
      }
      const listed = await store.spendLimits(A);
      expect(listed.projects).toHaveLength(SPEND_LIMITS_MAX.project);
      expect(listed.partial).toBe(true);
      expect(listed.projects[0]?.id).toBe("p000");
      const { store: small } = make(); await withSettings(small);
      await small.putSpendLimit({ companyId: A, kind: "project", id: "b", monthlyUsdMicros: 1, updatedAt: at, updatedBy: by }, none(1));
      await small.putSpendLimit({ companyId: A, kind: "project", id: "a", monthlyUsdMicros: 1, updatedAt: at, updatedBy: by }, none(1));
      expect(await small.spendLimits(A)).toMatchObject({ partial: false, people: [] });
      expect((await small.spendLimits(A)).projects.map((l) => l.id)).toEqual(["a", "b"]);
    });

    describe("a row that does not read is an outage (throws), never none saved", () => {
      const damages: Array<[string, Record<string, unknown>]> = [
        ["another company's attribute", { companyId: B }], ["another kind", { kind: "person" }], ["another id", { id: "api" }],
        ["a negative amount", { monthlyUsdMicros: -1 }], ["a text amount", { monthlyUsdMicros: "5" }], ["an amount past the ceiling", { monthlyUsdMicros: 1_000_000_000_001 }],
        ["no version", { version: 0 }], ["no author", { updatedBy: undefined }],
      ];
      for (const [label, change] of damages) {
        it(label, async () => {
          const { store, damage } = make(); await withSettings(store);
          await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 5, updatedAt: at, updatedBy: by }, none(1));
          damage(A, "project", "web", change);
          await expect(store.spendLimit(A, "project", "web")).rejects.toThrow();
          await expect(store.spendLimits(A)).rejects.toThrow();
          // A neighbouring company is not affected by the damaged row.
          await expect(store.spendLimits(B)).resolves.toMatchObject({ projects: [] });
        });
      }
    });
  });
}

describe("DynamoCompanyStore: what it writes", () => {
  it("writes the override and the settings check in one transaction, under COMPANY#<org> / SPEND_LIMIT#<KIND>#<id>, with the item the gateway reads", async () => {
    const fake = new FakeDynamoDb(); const store = new DynamoCompanyStore(fake, "cloud-companies");
    await store.putSettings(A, defaultCompanySettings(), 0, by, at);
    await store.putSpendLimit({ companyId: A, kind: "person", id: P1, monthlyUsdMicros: 9, updatedAt: at, updatedBy: by }, none(1));
    expect(fake.get(`COMPANY#${A}`, `SPEND_LIMIT#PERSON#${P1}`)).toEqual({ pk: `COMPANY#${A}`, sk: `SPEND_LIMIT#PERSON#${P1}`, companyId: A, kind: "person", id: P1, monthlyUsdMicros: 9, version: 1, updatedAt: at, updatedBy: by });
    const last = fake.transactions().at(-1)!;
    expect(last.map((entry) => Object.keys(entry)[0]).sort()).toEqual(["ConditionCheck", "Put"]);
  });
});
