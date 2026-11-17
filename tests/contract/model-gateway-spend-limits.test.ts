// Lead 3 B1: the gateway reads the per-project and per-person limits Cloud's company store writes. Cloud's own store (DynamoCompanyStore) saves an
// override; the gateway's own reader (CompanyBudgetCaps) reads that very item back through its wire-level client. The keys, the field names, the
// ceiling and the id formats have to agree, or this fails. Two companies never see each other's limits.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import {
  DynamoCompanyStore, SPEND_LIMIT_KINDS, SPEND_LIMIT_MICROS_MAX, SPEND_LIMIT_SCOPES, defaultCompanySettings, validateCompanySettings,
} from "../../packages/cloud-server/src/index.js";
import { validCaps } from "../../packages/model-gateway/src/caps.js";
import { CompanyBudgetCaps, readSpendLimit } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_SPEND_LIMITS } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { PERSON, PROJECT } from "../../packages/model-gateway/src/model-gateway-token.js";
import { SPEND_LIMIT_TABLES } from "../../packages/ui/src/api/admin-spend-limits.js";
import { existsSync, readFileSync } from "node:fs";
import { WireDynamo } from "../unit/model-gateway-wire-dynamo.js";

const TABLE = "cloud-companies";
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const P1 = "1".repeat(64);
const at = "2026-11-17T12:00:00.000Z";
const by = "d".repeat(64);
const scope = (cid: string, extra: Record<string, string> = {}) => ({ iss: "https://install.example/v1/auth", cid, pid: "web", tid: "task_1", per: P1, ...extra });

function both() {
  const wire = new WireDynamo([TABLE]);
  const store = new DynamoCompanyStore(wire.fake, TABLE);
  const caps = new CompanyBudgetCaps(new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport }), TABLE);
  const settings = async (companyId: string) => {
    const read = validateCompanySettings({ ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: 50_000_000, projectMonthlyUsdMicros: 100_000_000, taskUsdMicros: 2_000_000 } });
    if (!read.ok) throw new Error(read.problem);
    await store.putSettings(companyId, read.settings, 0, by, at);
  };
  return { wire, store, caps, settings };
}

describe("the gateway's override reader matches the company store", () => {
  it("names the same ceiling, and the same id format for each scope", () => {
    expect(SPEND_LIMIT_MICROS_MAX).toBe(GATEWAY_COMPANY_BUDGET_MAX);
    expect(SPEND_LIMIT_SCOPES.project.id.source).toBe(PROJECT.source);
    expect(SPEND_LIMIT_SCOPES.person.id.source).toBe(PERSON.source);
    expect(`^${SPEND_LIMIT_SCOPES.project.idSource}$`).toBe(PROJECT.source);
    expect(`^${SPEND_LIMIT_SCOPES.person.idSource}$`).toBe(PERSON.source);
  });

  it("reads back each company's own overrides as the meter's caps; a change applies to the next read (two companies)", async () => {
    const { store, caps, settings } = both();
    await settings(A); await settings(B);
    const base = await caps.capsFor(scope(A));
    expect(base).toMatchObject({ task: 2_000_000, projectMonth: 100_000_000, personMonth: 50_000_000, companyMonth: 500_000_000 });
    await store.putSpendLimit({ companyId: A, kind: "project_month", id: "web", monthlyUsdMicros: 7_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    await store.putSpendLimit({ companyId: A, kind: "person_month", id: P1, monthlyUsdMicros: 3_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    expect(await caps.capsFor(scope(A))).toMatchObject({ task: 2_000_000, projectMonth: 7_000_000, personMonth: 3_000_000, companyMonth: 500_000_000 });
    // Company B, same project name and same person: its own defaults.
    expect(await caps.capsFor(scope(B))).toEqual(base);
    await store.putSpendLimit({ companyId: B, kind: "project_month", id: "web", monthlyUsdMicros: 9_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    expect(await caps.capsFor(scope(B))).toMatchObject({ projectMonth: 9_000_000, personMonth: 50_000_000 });
    expect(await caps.capsFor(scope(A))).toMatchObject({ projectMonth: 7_000_000 });
    // Lower, then remove: the gateway follows.
    await store.putSpendLimit({ companyId: A, kind: "project_month", id: "web", monthlyUsdMicros: 1_000_000, updatedAt: at, updatedBy: by }, { override: { version: 1, monthlyUsdMicros: 7_000_000 }, settingsVersion: 1 });
    expect((await caps.capsFor(scope(A))).projectMonth).toBe(1_000_000);
    await store.removeSpendLimit(A, "project_month", "web", { override: { version: 2, monthlyUsdMicros: 1_000_000 }, settingsVersion: 1 });
    expect((await caps.capsFor(scope(A))).projectMonth).toBe(100_000_000);
  });

  it("an item another company's key holds (attribute names the other company) refuses at the gateway and is an outage in Cloud", async () => {
    const { wire, store, caps, settings } = both();
    await settings(A);
    wire.fake.set({ pk: `COMPANY#${A}`, sk: "SPEND_LIMIT#PROJECT#web", companyId: B, kind: "project_month", id: "web", monthlyUsdMicros: 1, version: 1, updatedAt: at, updatedBy: by });
    expect(validCaps(await caps.capsFor(scope(A)))).toBe(false);
    await expect(store.spendLimit(A, "project_month", "web")).rejects.toThrow();
    // The other project of the same company is unaffected.
    expect(validCaps(await caps.capsFor(scope(A, { pid: "api" })))).toBe(true);
  });
});

// ---- Every kind in the tables: a new kind is an entry in each table, and these walk them all ----
const EXAMPLE_ID = { project: "web", person: "1".repeat(64) } as const;
const GATEWAY_KINDS = GATEWAY_COMPANY_SPEND_LIMITS.kinds;
const DEFS = SPEND_LIMIT_KINDS.map((def) => def);

describe("the tables of limit kinds", () => {
  it("list the same kinds, scopes and key prefixes in Cloud and at the gateway; no prefix begins another; names, list members and paths are unique", () => {
    expect(GATEWAY_COMPANY_SPEND_LIMITS.partitionPrefix).toBe("COMPANY#");
    expect(DEFS.map(({ kind, scope, sortPrefix }) => ({ kind, scope, sortPrefix }))).toEqual(GATEWAY_KINDS.map(({ kind, scope, sortPrefix }) => ({ kind, scope, sortPrefix })));
    const prefixes = DEFS.map((def) => def.sortPrefix);
    for (const one of prefixes) for (const other of prefixes) if (one !== other) expect(one.startsWith(other), `${other} begins ${one}`).toBe(false);
    for (const field of ["kind", "listKey", "segment", "sortPrefix"] as const) expect(new Set(DEFS.map((def) => def[field])).size, field).toBe(DEFS.length);
    for (const def of DEFS) {
      expect(def.sortPrefix).toMatch(/^SPEND_LIMIT#[A-Z_]+#$/u);
      expect(def.max).toBeGreaterThan(0);
      expect(def.kind).toMatch(/^[a-z][a-z_]{0,40}$/u);
    }
  });

  it("name each meter cap at most once, so one kind's amount can never replace another's (a kind with caps null has none)", () => {
    const caps = GATEWAY_KINDS.map((def) => def.caps).filter((cap) => cap !== null);
    expect(new Set(caps).size).toBe(caps.length);
  });

  it("have their how-to-add doc committed (a file CI sees), naming every kind and the three tables", () => {
    expect(existsSync("docs/model-gateway-spend-limits.md")).toBe(true);
    const doc = readFileSync("docs/model-gateway-spend-limits.md", "utf8");
    expect(doc).toContain("Adding a kind");
    for (const table of ["SPEND_LIMIT_KINDS", "GATEWAY_COMPANY_SPEND_LIMITS", "SPEND_LIMIT_TABLES", "readSpendLimit"]) expect(doc, table).toContain(table);
    expect(readFileSync(".gitignore", "utf8")).toContain("!docs/model-gateway-spend-limits.md");
  });

  it("are drawn by the page's table: one entry for each kind, with the same list member, path segment and scope", () => {
    expect(SPEND_LIMIT_TABLES.map(({ listKey, segment, scope }) => ({ listKey, segment, scope }))).toEqual(DEFS.map(({ listKey, segment, scope }) => ({ listKey, segment, scope })));
  });

  for (const def of DEFS) {
    describe(`kind ${def.kind}`, () => {
      const id = EXAMPLE_ID[def.scope];
      const item = (company: string, more: Record<string, unknown> = {}) => ({ pk: `COMPANY#${company}`, sk: `${def.sortPrefix}${id}`, companyId: company, kind: def.kind, id, monthlyUsdMicros: 4_000_000, version: 1, updatedAt: at, updatedBy: by, ...more });

      it("is written under COMPANY#<org> / <prefix><id> as exactly the item the gateway reads back, per company", async () => {
        const { wire, store } = both();
        const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
        const read = (company: string) => readSpendLimit(db, TABLE, def.kind, company, id);
        expect(await read(A)).toBeUndefined();
        await store.putSpendLimit({ companyId: A, kind: def.kind, id, monthlyUsdMicros: 4_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 0 });
        expect(wire.fake.get(`COMPANY#${A}`, `${def.sortPrefix}${id}`)).toEqual(item(A));
        expect(await read(A)).toBe(4_000_000);
        // Company B has the same id and none of A's limit.
        expect(await read(B)).toBeUndefined();
        await store.putSpendLimit({ companyId: B, kind: def.kind, id, monthlyUsdMicros: 9, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 0 });
        expect([await read(A), await read(B)]).toEqual([4_000_000, 9]);
        expect((await store.spendLimits(A)).limits[def.kind].map((l) => [l.companyId, l.monthlyUsdMicros])).toEqual([[A, 4_000_000]]);
        // Other kinds' lists are untouched by this kind's item.
        for (const other of DEFS.filter((d) => d.kind !== def.kind)) expect((await store.spendLimits(A)).limits[other.kind]).toEqual([]);
        await store.removeSpendLimit(A, def.kind, id, { override: { version: 1, monthlyUsdMicros: 4_000_000 }, settingsVersion: 0 });
        expect(await read(A)).toBeUndefined();
        expect(await read(B)).toBe(9);
      });

      it("fails closed on an item that does not read as exactly this company's, kind's and id's, in Cloud (throws) and at the gateway (null)", async () => {
        const otherKind = DEFS.find((d) => d.kind !== def.kind)?.kind ?? "another_kind";
        const damages: Array<[string, Record<string, unknown>]> = [
          ["another company's attribute", { companyId: B }], ["another kind", { kind: otherKind }], ["no kind", { kind: undefined }], ["another id", { id: id === "web" ? "api" : "2".repeat(64) }],
          ["no id", { id: undefined }], ["a negative amount", { monthlyUsdMicros: -1 }], ["a fraction", { monthlyUsdMicros: 1.5 }], ["a text amount", { monthlyUsdMicros: "5" }], ["no amount", { monthlyUsdMicros: undefined }],
          ["an amount past the ceiling", { monthlyUsdMicros: GATEWAY_COMPANY_BUDGET_MAX + 1 }], ["no version", { version: undefined }], ["version 0", { version: 0 }],
          // Cloud's store and the gateway agree on what reads: the author and time Cloud writes are required by both.
          ["no author", { updatedBy: undefined }], ["no time", { updatedAt: undefined }], ["a numeric author", { updatedBy: 7 }],
        ];
        for (const [label, change] of damages) {
          const { wire, store } = both();
          const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
          const row: Record<string, unknown> = { ...item(A), ...change };
          for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
          wire.fake.set(row);
          // Null, or a throw (an item the wire reader cannot even read): either way the call is refused.
          expect(await readSpendLimit(db, TABLE, def.kind, A, id).catch(() => null), label).toBeNull();
          await expect(store.spendLimit(A, def.kind, id), label).rejects.toThrow();
          await expect(store.spendLimits(A), label).rejects.toThrow();
        }
      });

      it("refuses an id that is not in the scope's format without a read, an unknown kind, and throws when the read fails", async () => {
        const { wire } = both();
        const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
        const before = wire.calls.length;
        for (const bad of ["", "Web", "a/b", "x".repeat(65), `${id}!`]) expect(await readSpendLimit(db, TABLE, def.kind, A, bad), bad).toBeNull();
        expect(await readSpendLimit(db, TABLE, "no_such_kind", A, id)).toBeNull();
        expect(await readSpendLimit(db, TABLE, def.kind, "COMPANY#x", id)).toBeNull();
        expect(wire.calls.length).toBe(before);
        wire.fault(() => true, { kind: "error", status: 400, type: "AccessDeniedException" });
        await expect(readSpendLimit(db, TABLE, def.kind, A, id)).rejects.toThrow();
        // The read is strongly consistent.
        const strong = both();
        const strongDb = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: strong.wire.transport });
        await readSpendLimit(strongDb, TABLE, def.kind, A, id);
        expect(strong.wire.calls.at(-1)?.input.ConsistentRead).toBe(true);
      });
    });
  }
});
