import { describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, ROLLOUT_FEATURE_CATALOG, orgFeatureRolloutKey, rolloutGateOn } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { companyFeatureOn, companyGatedEnv, createGateReader, effectiveFeature, installSwitchOn, ROLLOUT_INSTALL_VARIABLE, settingsFromItem } from "../../packages/broker/src/org/feature-rollout.js";
import { proofEvidenceEnabled } from "../../packages/broker/src/proof/switch.js";
import { testEnvironmentEnabled } from "../../packages/broker/src/test-env/switch.js";
import { testServicesEnabled } from "../../packages/broker/src/test-env/test-services-switch.js";
import { verifyResultsEnabled } from "../../packages/broker/src/verification/switch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// TE-A1: effective = the install switch exactly "1" AND the company's gate on. The truth table, the fail-closed reads and the readers the gated environment reaches.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const INSTALL_VALUES = [undefined, "", "0", "1", "true", " 1", "01", "1 ", "yes"];
const COMPANY_VALUES: Array<[string, unknown]> = [["on", true], ["off", false], ["absent", undefined], ["string true", "true"], ["number 1", 1], ["null", null], ["string yes", "yes"], ["object", {}]];

function store(gates: Record<string, unknown> | undefined, orgId: OrgId = ORG_A, extra: Record<string, unknown> = {}) {
  const db = new FakeDynamoDb();
  if (gates !== undefined) db.set({ ...orgFeatureRolloutKey(orgId), entityType: "FEATURE_ROLLOUT", orgId, gates, revision: 1, ...extra });
  let sends = 0;
  const documentClient = { send: (command: unknown) => { sends += 1; return db.send(command as never); } };
  return { db, deps: { documentClient, tableName: "state", now: () => Date.UTC(2026, 10, 13) }, sends: () => sends };
}

describe("the truth table", () => {
  const EXISTING = ["proofEvidence", "verifyResults", "testEnvironment", "testServices"] as const;
  const NEW = ["sealedChecks", "honestCi", "summaryCheck"] as const;

  it("an existing feature is on only with the install \"1\" and a company that is on or has chosen nothing; an explicit off, or an odd stored value, is off", () => {
    for (const name of EXISTING) {
      for (const install of INSTALL_VALUES) {
        for (const [label, company] of COMPANY_VALUES) {
          const env = install === undefined ? {} : { [ROLLOUT_INSTALL_VARIABLE[name]!]: install };
          const expected = install === "1" && (company === true || company === undefined);
          expect(effectiveFeature(name, company, env), `${name} install=${String(install)} company=${label}`).toBe(expected);
        }
      }
    }
  });

  it("existing feature, no row: follows the install switch (install on: on, install off: off); explicit row off: off either way", () => {
    for (const name of EXISTING) {
      const variable = ROLLOUT_INSTALL_VARIABLE[name]!;
      expect(effectiveFeature(name, undefined, { [variable]: "1" }), name).toBe(true);
      expect(effectiveFeature(name, undefined, { [variable]: "0" }), name).toBe(false);
      expect(effectiveFeature(name, undefined, {}), name).toBe(false);
      expect(effectiveFeature(name, false, { [variable]: "1" }), name).toBe(false);
      expect(effectiveFeature(name, false, { [variable]: "0" }), name).toBe(false);
    }
  });

  it("a new feature (no install switch yet), no row: off; only a stored true is on", () => {
    for (const name of NEW) {
      expect(effectiveFeature(name, undefined, {}), name).toBe(false);
      expect(effectiveFeature(name, false, {}), name).toBe(false);
      expect(effectiveFeature(name, "true", {}), name).toBe(false);
      expect(effectiveFeature(name, true, {}), name).toBe(true);
    }
  });

  it("the catalog defaults: the four existing features on, the three new ones off", () => {
    expect(ROLLOUT_FEATURE_CATALOG.filter((entry) => entry.defaultOn).map((entry) => entry.name)).toEqual([...EXISTING]);
    for (const name of EXISTING) expect(rolloutGateOn(name, undefined), name).toBe(true);
    for (const name of NEW) expect(rolloutGateOn(name, undefined), name).toBe(false);
  });

  it("a feature without an install switch is decided by its company gate alone", () => {
    for (const name of ["sealedChecks", "honestCi", "summaryCheck"] as const) {
      expect(installSwitchOn(name, {})).toBe(true);
      expect(effectiveFeature(name, true, {})).toBe(true);
      expect(effectiveFeature(name, false, {})).toBe(false);
      expect(effectiveFeature(name, undefined, {})).toBe(false);
    }
  });

  it("the install variables are the ones the existing readers use", () => {
    expect(ROLLOUT_INSTALL_VARIABLE).toEqual({
      proofEvidence: BROKER_SETTINGS.proofEvidence.variable, verifyResults: BROKER_SETTINGS.verifyResults.variable,
      testEnvironment: BROKER_SETTINGS.testEnvironment.variable, testServices: BROKER_SETTINGS.testServices.variable,
    });
  });
});

describe("a stored row", () => {
  it("reads only booleans as choices; a stored non-boolean reads as off and is not an error", () => {
    const s = settingsFromItem({ revision: 2, gates: { proofEvidence: true, verifyResults: "yes", testEnvironment: false, notAGate: true } });
    expect(s.gates).toEqual({ proofEvidence: true, verifyResults: false, testEnvironment: false });
    expect(s.revision).toBe(2);
  });

  it("a row without a usable revision reads every gate as off", () => {
    for (const revision of [undefined, 0, -1, 1.5, "2", null]) {
      const s = settingsFromItem({ gates: { proofEvidence: true, testServices: true }, ...(revision === undefined ? {} : { revision }) });
      expect(Object.values(s.gates).every((value) => value === false), String(revision)).toBe(true);
      expect(s.revision).toBe(0);
    }
  });

  it("a gates field that is not a map reads every gate as off", () => {
    for (const gates of ["on", 1, ["proofEvidence"], null]) {
      const s = settingsFromItem({ revision: 3, gates });
      expect(Object.values(s.gates).every((value) => value === false), String(gates)).toBe(true);
    }
  });
});

describe("the gated environment", () => {
  const ON = { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "1", TEST_ENVIRONMENT_ENABLED: "1", TEST_SERVICES_ENABLED: "1" };
  const readers = (env: NodeJS.ProcessEnv) => ({ proof: proofEvidenceEnabled(env), verify: verifyResultsEnabled(env), testEnv: testEnvironmentEnabled(env), services: testServicesEnabled(env) });
  const ALL_ON = { proof: true, verify: true, testEnv: true, services: true };
  const ALL_OFF = { proof: false, verify: false, testEnv: false, services: false };
  const brokenStore = (log?: () => void) => ({ documentClient: { send: async () => { log?.(); throw new Error("boom " + ORG_A); } }, tableName: "state", now: () => 0 });

  it("a company with every gate on reaches the readers as the install has them", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, ON))).toEqual(ALL_ON);
  });

  it("a gate that is off turns only its own feature off; a gate with no stored choice follows the install", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: false, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, ON))).toEqual({ proof: true, verify: false, testEnv: true, services: true });
  });

  it("a company that never chose follows the install switch for the four existing features; the install's own values are not changed in place", async () => {
    const { deps } = store(undefined);
    const env = { ...ON };
    expect(readers(await companyGatedEnv(deps, ORG_A, env))).toEqual(ALL_ON);
    expect(env).toEqual(ON);
    expect(readers(await companyGatedEnv(deps, ORG_A, { PROOF_EVIDENCE_ENABLED: "0", VERIFY_RESULTS_ENABLED: "1" }))).toEqual({ ...ALL_OFF, verify: true });
  });

  it("the install switch off stays off whatever the company chose", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, { ...ON, PROOF_EVIDENCE_ENABLED: "0", VERIFY_RESULTS_ENABLED: "true", TEST_ENVIRONMENT_ENABLED: undefined }))).toEqual({ proof: false, verify: false, testEnv: false, services: true });
  });

  it("another company's gate never reaches this company's environment", async () => {
    const off = store({ proofEvidence: false, verifyResults: false, testEnvironment: false, testServices: false }, ORG_B);
    expect(off.db.get(orgFeatureRolloutKey(ORG_B))).toBeDefined();
    expect(readers(await companyGatedEnv(off.deps, ORG_A, ON))).toEqual(ALL_ON);
    expect(readers(await companyGatedEnv(off.deps, ORG_B, ON))).toEqual(ALL_OFF);
  });

  it("no company is off for every gated reader; a read that fails is off by default and logged without data (fail closed)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(readers(await companyGatedEnv(brokenStore(), ORG_A, ON))).toEqual(ALL_OFF);
    expect(readers(await companyGatedEnv(store({ proofEvidence: true }).deps, undefined, ON))).toEqual(ALL_OFF);
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(lines.some((line) => line.includes("feature_rollout_read_failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain(ORG_A);
  });

  it("a read that fails with onReadFailure \"throw\" is RUNTIME_UNAVAILABLE in fixed words (a queue or a caller retries); no company is still off, not a failure", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = await companyGatedEnv(brokenStore(), ORG_A, ON, { onReadFailure: "throw" }).catch((caught: unknown) => caught as Error);
    log.mockRestore();
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((error as Error).message).not.toContain(ORG_A);
    expect(readers(await companyGatedEnv(store({ proofEvidence: true }).deps, undefined, ON, { onReadFailure: "throw" }))).toEqual(ALL_OFF);
  });

  it("a read that fails with onReadFailure \"default\" follows the catalog default: the four existing features follow the install, and the log says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(readers(await companyGatedEnv(brokenStore(), ORG_A, ON, { onReadFailure: "default" }))).toEqual(ALL_ON);
    expect(readers(await companyGatedEnv(brokenStore(), ORG_A, { PROOF_EVIDENCE_ENABLED: "0", VERIFY_RESULTS_ENABLED: "1" }, { onReadFailure: "default" }))).toEqual({ ...ALL_OFF, verify: true });
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(lines.some((line) => line.includes("feature_rollout_read_failed"))).toBe(true);
  });

  it("reads nothing when the install has every gated switch off", async () => {
    const send = vi.fn(async () => ({}));
    const env = await companyGatedEnv({ documentClient: { send }, tableName: "state", now: () => 0 }, ORG_A, { PROOF_EVIDENCE_ENABLED: "0" });
    expect(send).not.toHaveBeenCalled();
    expect(readers(env)).toEqual(ALL_OFF);
  });

  it("companyFeatureOn gives the same answer for one feature, and a gate-only feature needs a stored gate", async () => {
    const { deps } = store({ proofEvidence: true, sealedChecks: true, honestCi: false });
    expect(await companyFeatureOn(deps, ORG_A, "proofEvidence", ON)).toBe(true);
    expect(await companyFeatureOn(deps, ORG_A, "proofEvidence", { ...ON, PROOF_EVIDENCE_ENABLED: "0" })).toBe(false);
    expect(await companyFeatureOn(deps, ORG_A, "sealedChecks", {})).toBe(true);
    expect(await companyFeatureOn(deps, ORG_A, "honestCi", {})).toBe(false);
    expect(await companyFeatureOn(deps, ORG_A, "summaryCheck", {})).toBe(false);
    expect(await companyFeatureOn(deps, ORG_B, "sealedChecks", {})).toBe(false);
    expect(await companyFeatureOn(deps, undefined, "sealedChecks", {})).toBe(false);
    // An existing feature with no stored choice follows the install.
    expect(await companyFeatureOn(deps, ORG_B, "proofEvidence", ON)).toBe(true);
    expect(await companyFeatureOn(deps, ORG_B, "proofEvidence", {})).toBe(false);
  });
});

describe("one read for a request (no TTL: a new request reads again)", () => {
  const ON = { PROOF_EVIDENCE_ENABLED: "1", VERIFY_RESULTS_ENABLED: "1" };
  it("a gate reader reads a company once however many times it is asked, for every helper, and a second reader reads again", async () => {
    const s = store({ proofEvidence: true, verifyResults: false });
    const gates = createGateReader(s.deps);
    const withGates = { ...s.deps, gates };
    const before = s.sends();
    expect(await companyFeatureOn(withGates, ORG_A, "proofEvidence", ON)).toBe(true);
    expect(await companyFeatureOn(withGates, ORG_A, "verifyResults", ON)).toBe(false);
    expect((await companyGatedEnv(withGates, ORG_A, ON)).VERIFY_RESULTS_ENABLED).toBe("0");
    expect(s.sends() - before).toBe(1);
    // Another company is its own read; a new request's reader sees a change at once.
    await companyFeatureOn(withGates, ORG_B, "proofEvidence", ON);
    expect(s.sends() - before).toBe(2);
    s.db.set({ ...orgFeatureRolloutKey(ORG_A), entityType: "FEATURE_ROLLOUT", orgId: ORG_A, gates: { proofEvidence: false }, revision: 2 });
    expect(await companyFeatureOn(withGates, ORG_A, "proofEvidence", ON)).toBe(true);
    expect(await companyFeatureOn({ ...s.deps, gates: createGateReader(s.deps) }, ORG_A, "proofEvidence", ON)).toBe(false);
  });

  it("a failed read is not remembered: the next ask reads again", async () => {
    let fail = true;
    const db = new FakeDynamoDb();
    db.set({ ...orgFeatureRolloutKey(ORG_A), entityType: "FEATURE_ROLLOUT", orgId: ORG_A, gates: { proofEvidence: true }, revision: 1 });
    const deps = { documentClient: { send: (command: unknown) => (fail ? Promise.reject(new Error("down")) : db.send(command as never)) }, tableName: "state", now: () => 0 };
    const withGates = { ...deps, gates: createGateReader(deps) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await companyFeatureOn(withGates, ORG_A, "proofEvidence", ON)).toBe(false);
    fail = false;
    expect(await companyFeatureOn(withGates, ORG_A, "proofEvidence", ON)).toBe(true);
    log.mockRestore();
  });
});
