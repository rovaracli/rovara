import { describe, expect, it, vi } from "vitest";
import { BROKER_SETTINGS, ROLLOUT_FEATURE_CATALOG, ROLLOUT_FEATURE_NAMES, orgFeatureRolloutKey, rolloutGateOn, type RolloutFeatureName } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { companyFeatureOn, companyGatedEnv, effectiveFeature, installSwitchOn, ROLLOUT_INSTALL_VARIABLE, settingsFromItem } from "../../packages/broker/src/org/feature-rollout.js";
import { proofEvidenceEnabled } from "../../packages/broker/src/proof/switch.js";
import { testEnvironmentEnabled } from "../../packages/broker/src/test-env/switch.js";
import { testServicesEnabled } from "../../packages/broker/src/test-env/test-services-switch.js";
import { verifyResultsEnabled } from "../../packages/broker/src/verification/switch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// TE-A1: effective = the install switch exactly "1" AND the company's gate on. The truth table, the fail-closed reads and the readers the gated environment reaches.

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const GATED = ["proofEvidence", "verifyResults", "testEnvironment", "testServices"] as const satisfies readonly RolloutFeatureName[];
const INSTALL_VALUES = [undefined, "", "0", "1", "true", " 1", "01", "1 ", "yes"];
const COMPANY_VALUES: Array<[string, unknown]> = [["on", true], ["off", false], ["absent", undefined], ["string true", "true"], ["number 1", 1], ["null", null], ["string yes", "yes"], ["object", {}]];

function store(gates: Record<string, unknown> | undefined, orgId: OrgId = ORG_A, extra: Record<string, unknown> = {}) {
  const db = new FakeDynamoDb({ rolloutGates: "stored" });
  if (gates !== undefined) db.set({ ...orgFeatureRolloutKey(orgId), entityType: "FEATURE_ROLLOUT", orgId, gates, revision: 1, ...extra });
  return { db, deps: { documentClient: db, tableName: "state", now: () => Date.UTC(2026, 10, 13) } };
}

describe("the truth table", () => {
  it("only the exact install \"1\" and a stored company true are on, for every gated feature", () => {
    for (const name of GATED) {
      for (const install of INSTALL_VALUES) {
        for (const [label, company] of COMPANY_VALUES) {
          const env = install === undefined ? {} : { [ROLLOUT_INSTALL_VARIABLE[name]!]: install };
          const expected = install === "1" && company === true;
          expect(effectiveFeature(name, company, env), `${name} install=${String(install)} company=${label}`).toBe(expected);
        }
      }
    }
  });

  it("every catalog default is off today, so an absent company gate is off", () => {
    expect(ROLLOUT_FEATURE_CATALOG.filter((entry) => entry.defaultOn)).toEqual([]);
    for (const name of ROLLOUT_FEATURE_NAMES) expect(rolloutGateOn(name, undefined)).toBe(false);
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

  it("a company with every gate on reaches the readers as the install has them", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, ON))).toEqual({ proof: true, verify: true, testEnv: true, services: true });
  });

  it("a gate that is off, or absent, turns only its own feature off for the readers", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: false, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, ON))).toEqual({ proof: true, verify: false, testEnv: false, services: true });
  });

  it("a company that never chose has everything off; the install's own values are not changed in place", async () => {
    const { deps } = store(undefined);
    const env = { ...ON };
    expect(readers(await companyGatedEnv(deps, ORG_A, env))).toEqual({ proof: false, verify: false, testEnv: false, services: false });
    expect(env).toEqual(ON);
  });

  it("the install switch off stays off whatever the company chose", async () => {
    const { deps } = store({ proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true });
    expect(readers(await companyGatedEnv(deps, ORG_A, { ...ON, PROOF_EVIDENCE_ENABLED: "0", VERIFY_RESULTS_ENABLED: "true", TEST_ENVIRONMENT_ENABLED: undefined }))).toEqual({ proof: false, verify: false, testEnv: false, services: true });
  });

  it("another company's gate never reaches this company's environment", async () => {
    const { deps, db } = store({ proofEvidence: true, verifyResults: true, testEnvironment: true, testServices: true }, ORG_B);
    expect(db.get(orgFeatureRolloutKey(ORG_B))).toBeDefined();
    expect(readers(await companyGatedEnv(deps, ORG_A, ON))).toEqual({ proof: false, verify: false, testEnv: false, services: false });
  });

  it("no company, or a failed read, is off for every gated reader (fail closed) and the failure is logged without data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const broken = { documentClient: { send: async () => { throw new Error("boom " + ORG_A); } }, tableName: "state", now: () => 0 };
    expect(readers(await companyGatedEnv(broken, ORG_A, ON))).toEqual({ proof: false, verify: false, testEnv: false, services: false });
    expect(readers(await companyGatedEnv(store({ proofEvidence: true }).deps, undefined, ON))).toEqual({ proof: false, verify: false, testEnv: false, services: false });
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(lines.some((line) => line.includes("feature_rollout_read_failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain(ORG_A);
  });

  it("reads nothing when the install has every gated switch off", async () => {
    const send = vi.fn(async () => ({}));
    const env = await companyGatedEnv({ documentClient: { send }, tableName: "state", now: () => 0 }, ORG_A, { PROOF_EVIDENCE_ENABLED: "0" });
    expect(send).not.toHaveBeenCalled();
    expect(readers(env)).toEqual({ proof: false, verify: false, testEnv: false, services: false });
  });

  it("companyFeatureOn gives the same answer for one feature, and a gate-only feature needs only the gate", async () => {
    const { deps } = store({ proofEvidence: true, sealedChecks: true, honestCi: false });
    expect(await companyFeatureOn(deps, ORG_A, "proofEvidence", ON)).toBe(true);
    expect(await companyFeatureOn(deps, ORG_A, "proofEvidence", { ...ON, PROOF_EVIDENCE_ENABLED: "0" })).toBe(false);
    expect(await companyFeatureOn(deps, ORG_A, "sealedChecks", {})).toBe(true);
    expect(await companyFeatureOn(deps, ORG_A, "honestCi", {})).toBe(false);
    expect(await companyFeatureOn(deps, ORG_A, "summaryCheck", {})).toBe(false);
    expect(await companyFeatureOn(deps, ORG_B, "sealedChecks", {})).toBe(false);
    expect(await companyFeatureOn(deps, undefined, "sealedChecks", {})).toBe(false);
  });
});
