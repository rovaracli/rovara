// The gateway reads budgets the Cloud company backend writes (PrepLabsAI/Rovara-cloud#52): this pins the two to one truth.
// The backend's own store (DynamoCompanyStore) writes a company's settings into a table; the gateway's own reader
// (CompanyBudgetCaps) reads that very item back through its wire-level client. Field names, the key, the ceiling and the
// "null means no cap of this kind" meaning all have to agree, or this fails.
import { denyNetwork } from "../unit/model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { COMPANY_SETTINGS_LIMITS, DEFAULT_COMPANY_SETTINGS, DynamoCompanyStore, defaultCompanySettings, validateCompanySettings } from "../../packages/cloud-server/src/index.js";
import { CompanyBudgetCaps, CompanyLessonsSwitch, NO_CAP } from "../../packages/model-gateway/src/company-caps.js";
import { validCaps } from "../../packages/model-gateway/src/caps.js";
import { GATEWAY_COMPANY_BUDGET_FIELDS, GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_LESSONS_GATE, GATEWAY_COMPANY_SETTINGS } from "../../packages/model-gateway/src/deploy.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "../unit/model-gateway-wire-dynamo.js";

const TABLE = "cloud-companies";
const cid = `org_${"c".repeat(20)}`;
const scope = { iss: "https://install.example/v1/auth", cid, pid: "web", tid: "task_1" };

function both() {
  const wire = new WireDynamo([TABLE]);
  // The backend talks to DynamoDB through the document client; FakeDynamoDb is that client's fake, and WireDynamo's own store.
  const store = new DynamoCompanyStore(wire.fake, TABLE);
  const caps = new CompanyBudgetCaps(new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport }), TABLE);
  return { wire, store, caps };
}

describe("the gateway's budget reader matches the company backend's store", () => {
  it("names the same budget fields, the same key and the same ceiling", () => {
    expect(Object.keys(DEFAULT_COMPANY_SETTINGS.budgets).sort()).toEqual([...GATEWAY_COMPANY_BUDGET_FIELDS].sort());
    expect(COMPANY_SETTINGS_LIMITS.usdMicrosMax).toBe(GATEWAY_COMPANY_BUDGET_MAX);
    expect(GATEWAY_COMPANY_SETTINGS).toEqual({ partitionPrefix: "COMPANY#", sortKey: "SETTINGS" });
  });

  it("reads back the budgets an admin saved through the backend, as the meter's caps", async () => {
    const { wire, store, caps } = both();
    const settings = { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: 500_000_000, memberMonthlyUsdMicros: 50_000_000, projectMonthlyUsdMicros: 100_000_000, taskUsdMicros: 2_000_000 } };
    expect(validateCompanySettings(settings).ok).toBe(true);
    await store.putSettings(cid, settings, 0, "a".repeat(64), "2026-11-15T12:00:00.000Z");
    expect(wire.fake.get(`${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${cid}`, GATEWAY_COMPANY_SETTINGS.sortKey)).toBeDefined();
    expect(await caps.capsFor(scope)).toEqual({ task: 2_000_000, projectMonth: 100_000_000, personMonth: 50_000_000, companyMonth: 500_000_000 });
    // Another company's calls never see this company's budgets.
    expect(validCaps(await caps.capsFor({ ...scope, cid: `org_${"d".repeat(20)}` }))).toBe(false);
  });

  it("the backend's default settings (every budget null) give no company cap, so the gateway refuses: fail closed", async () => {
    const { store, caps } = both();
    await store.putSettings(cid, defaultCompanySettings(), 0, "a".repeat(64), "2026-11-15T12:00:00.000Z");
    expect(validCaps(await caps.capsFor(scope))).toBe(false);
  });

  it("under a company cap, the backend's null task/project/member caps read as no cap of that kind", async () => {
    const { store, caps } = both();
    const settings = { ...defaultCompanySettings(), budgets: { companyMonthlyUsdMicros: GATEWAY_COMPANY_BUDGET_MAX, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null } };
    expect(validateCompanySettings(settings).ok).toBe(true);
    await store.putSettings(cid, settings, 0, "a".repeat(64), "2026-11-15T12:00:00.000Z");
    expect(await caps.capsFor(scope)).toEqual({ task: NO_CAP, projectMonth: NO_CAP, companyMonth: GATEWAY_COMPANY_BUDGET_MAX });
  });
});

describe("the gateway's lessons switch reader matches the company backend's store (DEC 226)", () => {
  const lessons = (wire: WireDynamo) => new CompanyLessonsSwitch(new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport }), TABLE);
  it("the gate name is one the backend accepts", () => {
    expect(validateCompanySettings({ ...defaultCompanySettings(), featureGates: { [GATEWAY_COMPANY_LESSONS_GATE]: true } }).ok).toBe(true);
  });
  it("on after an admin saves the lessons gate on; off by default, when saved off, and for another company", async () => {
    const { wire, store } = both();
    expect(await lessons(wire).isOn(cid)).toBe(false);
    await store.putSettings(cid, defaultCompanySettings(), 0, "a".repeat(64), "2026-11-15T12:00:00.000Z");
    expect(await lessons(wire).isOn(cid)).toBe(false);
    await store.putSettings(cid, { ...defaultCompanySettings(), featureGates: { [GATEWAY_COMPANY_LESSONS_GATE]: true } }, 1, "a".repeat(64), "2026-11-15T12:01:00.000Z");
    expect(await lessons(wire).isOn(cid)).toBe(true);
    expect(await lessons(wire).isOn(`org_${"d".repeat(20)}`)).toBe(false);
    await store.putSettings(cid, { ...defaultCompanySettings(), featureGates: { [GATEWAY_COMPANY_LESSONS_GATE]: false } }, 2, "a".repeat(64), "2026-11-15T12:02:00.000Z");
    expect(await lessons(wire).isOn(cid)).toBe(false);
  });
});
