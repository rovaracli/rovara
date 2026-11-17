// Lead 3 B1: the gateway reads the per-project and per-person limits Cloud's company store writes. Cloud's own store (DynamoCompanyStore) saves an
// override; the gateway's own reader (CompanyBudgetCaps) reads that very item back through its wire-level client. The keys, the field names, the
// ceiling and the id formats have to agree, or this fails. Two companies never see each other's limits.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import {
  DynamoCompanyStore, SPEND_LIMITS_MAX, SPEND_LIMIT_ID, SPEND_LIMIT_KINDS, SPEND_LIMIT_MICROS_MAX, SPEND_LIMIT_SORT_PREFIX, defaultCompanySettings, validateCompanySettings,
} from "../../packages/cloud-server/src/index.js";
import { validCaps } from "../../packages/model-gateway/src/caps.js";
import { CompanyBudgetCaps } from "../../packages/model-gateway/src/company-caps.js";
import { GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_SPEND_LIMIT } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { PERSON, PROJECT } from "../../packages/model-gateway/src/model-gateway-token.js";
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
  it("names the same keys, the same ceiling and the same id formats", () => {
    expect(GATEWAY_COMPANY_SPEND_LIMIT).toEqual({ partitionPrefix: "COMPANY#", projectSortPrefix: SPEND_LIMIT_SORT_PREFIX.project, personSortPrefix: SPEND_LIMIT_SORT_PREFIX.person });
    expect(SPEND_LIMIT_MICROS_MAX).toBe(GATEWAY_COMPANY_BUDGET_MAX);
    expect(SPEND_LIMIT_ID.project.source).toBe(PROJECT.source);
    expect(SPEND_LIMIT_ID.person.source).toBe(PERSON.source);
    expect([...SPEND_LIMIT_KINDS]).toEqual(["project", "person"]);
    expect(SPEND_LIMITS_MAX.project).toBeGreaterThan(0);
  });

  it("reads back each company's own overrides as the meter's caps; a change applies to the next read (two companies)", async () => {
    const { store, caps, settings } = both();
    await settings(A); await settings(B);
    const base = await caps.capsFor(scope(A));
    expect(base).toMatchObject({ task: 2_000_000, projectMonth: 100_000_000, personMonth: 50_000_000, companyMonth: 500_000_000 });
    await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 7_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    await store.putSpendLimit({ companyId: A, kind: "person", id: P1, monthlyUsdMicros: 3_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    expect(await caps.capsFor(scope(A))).toMatchObject({ task: 2_000_000, projectMonth: 7_000_000, personMonth: 3_000_000, companyMonth: 500_000_000 });
    // Company B, same project name and same person: its own defaults.
    expect(await caps.capsFor(scope(B))).toEqual(base);
    await store.putSpendLimit({ companyId: B, kind: "project", id: "web", monthlyUsdMicros: 9_000_000, updatedAt: at, updatedBy: by }, { override: undefined, settingsVersion: 1 });
    expect(await caps.capsFor(scope(B))).toMatchObject({ projectMonth: 9_000_000, personMonth: 50_000_000 });
    expect(await caps.capsFor(scope(A))).toMatchObject({ projectMonth: 7_000_000 });
    // Lower, then remove: the gateway follows.
    await store.putSpendLimit({ companyId: A, kind: "project", id: "web", monthlyUsdMicros: 1_000_000, updatedAt: at, updatedBy: by }, { override: { version: 1, monthlyUsdMicros: 7_000_000 }, settingsVersion: 1 });
    expect((await caps.capsFor(scope(A))).projectMonth).toBe(1_000_000);
    await store.removeSpendLimit(A, "project", "web", { override: { version: 2, monthlyUsdMicros: 1_000_000 }, settingsVersion: 1 });
    expect((await caps.capsFor(scope(A))).projectMonth).toBe(100_000_000);
  });

  it("an item another company's key holds (attribute names the other company) refuses at the gateway and is an outage in Cloud", async () => {
    const { wire, store, caps, settings } = both();
    await settings(A);
    wire.fake.set({ pk: `COMPANY#${A}`, sk: "SPEND_LIMIT#PROJECT#web", companyId: B, kind: "project", id: "web", monthlyUsdMicros: 1, version: 1, updatedAt: at, updatedBy: by });
    expect(validCaps(await caps.capsFor(scope(A)))).toBe(false);
    await expect(store.spendLimit(A, "project", "web")).rejects.toThrow();
    // The other project of the same company is unaffected.
    expect(validCaps(await caps.capsFor(scope(A, { pid: "api" })))).toBe(true);
  });
});
