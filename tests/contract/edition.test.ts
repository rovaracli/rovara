import { describe, expect, it } from "vitest";
import {
  ENTERPRISE_SESSION_MAX_SECONDS, assertEditionUnchanged, editionAtSynth,
  EDITION_FEATURES, EDITION_FEATURE_TABLE, EDITION_MISSING_MESSAGE, EDITION_UNKNOWN_MESSAGE, ENTERPRISE_ONLY_MESSAGE, InstallInfoSchema, NOT_AVAILABLE_YET_MESSAGE,
  NOT_IN_THIS_EDITION_MESSAGE, editionPolicy, featureEnabled, installInfo, requireFeature, resolveEdition, type EditionFeature,
} from "../../packages/contracts/src/edition.js";

// The feature table of the Enterprise foundations design (section 3.1), written out again here so that changing a row in the code is a change a reviewer sees in two places.
/** What a call throws, or undefined. */
function thrown(run: () => void): { code?: string; message: string } | undefined {
  try { run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
}

const EXPECTED: Record<EditionFeature, { enterprise: boolean; public: boolean }> = {
  groups: { enterprise: true, public: false },
  companyLocksSimple: { enterprise: true, public: true },
  companyLocksGroup: { enterprise: true, public: false },
  auditorRole: { enterprise: true, public: false },
  sso: { enterprise: true, public: false },
  scim: { enterprise: false, public: false },
  auditExportOnDemand: { enterprise: true, public: true },
  auditExportContinuous: { enterprise: true, public: false },
  codeHostPlugins: { enterprise: true, public: false },
  customModelEndpoint: { enterprise: true, public: false },
  privateRegistries: { enterprise: true, public: true },
  egressApprovalByCustomerAdmin: { enterprise: true, public: false },
  staffRoutes: { enterprise: false, public: true },
  trialAndBilling: { enterprise: false, public: true },
  updateCheck: { enterprise: true, public: false },
  telemetry: { enterprise: false, public: false },
  publicSignInMethods: { enterprise: false, public: true },
  aiNavigationUncharged: { enterprise: true, public: false },
  privateMcpServers: { enterprise: true, public: false },
  stdioMcpServers: { enterprise: true, public: false },
  diagnosisSupportEscalation: { enterprise: false, public: true },
  diagnosisSupportBundle: { enterprise: true, public: false },
};

describe("edition feature table", () => {
  it.each(Object.entries(EXPECTED))("%s is on or off in each edition as designed", (feature, expected) => {
    expect(featureEnabled(editionPolicy("enterprise"), feature as EditionFeature)).toBe(expected.enterprise);
    expect(featureEnabled(editionPolicy("public"), feature as EditionFeature)).toBe(expected.public);
  });

  it("lists every feature once, and the expectation lists no other", () => {
    expect([...EDITION_FEATURES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(EDITION_FEATURES).size).toBe(EDITION_FEATURES.length);
    expect(Object.keys(EDITION_FEATURE_TABLE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("keeps Public free of everything the design keeps out of it: groups, Auditor, SSO, custom model endpoints", () => {
    const publicPolicy = editionPolicy("public");
    for (const feature of ["groups", "auditorRole", "sso", "customModelEndpoint", "companyLocksGroup", "codeHostPlugins"] as const) expect(publicPolicy.features[feature]).toBe(false);
  });

  it("has one organization per Enterprise install and many on Public", () => {
    expect(editionPolicy("enterprise").multiTenant).toBe(false);
    expect(editionPolicy("public").multiTenant).toBe(true);
  });

  it("starts Enterprise record sources at C and Public at D, with Public Slack fixed at B (a setting cannot raise it)", () => {
    expect(editionPolicy("enterprise").defaults.teamRecordRetention).toEqual({ slack: "C", github: "C", tickets: "C", rovara: "C" });
    expect(editionPolicy("public").defaults.teamRecordRetention).toEqual({ slack: "B", github: "D", tickets: "D", rovara: "D" });
    expect(editionPolicy("public").defaults.slack).toEqual({ defaultRetention: "B", ceiling: "B" });
    expect(editionPolicy("enterprise").defaults.slack.defaultRetention).toBe("C");
  });

  it("hands out frozen policies, so no caller can turn a feature on", () => {
    const policy = editionPolicy("public");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.features)).toBe(true);
    expect(() => { (policy.features as Record<string, boolean>).sso = true; }).toThrow();
    expect(editionPolicy("public").features.sso).toBe(false);
  });
});

describe("resolveEdition", () => {
  const derive = { allowDerivedFromCloud: true } as const;
  it.each(["enterprise", "public"] as const)("accepts %s exactly", (edition) => {
    expect(resolveEdition({ configured: edition, cloud: undefined, allowDerivedFromCloud: false })).toBe(edition);
  });

  it.each(["Enterprise", "PUBLIC", "", " public", "private", "cloud", "enterprise\n"])("refuses the value %j, even when the cloud flag could answer", (configured) => {
    for (const cloud of [true, false, undefined]) {
      expect(() => resolveEdition({ configured, cloud, ...derive })).toThrow(EDITION_UNKNOWN_MESSAGE);
    }
  });

  it("does not let the cloud flag override a configured edition", () => {
    expect(resolveEdition({ configured: "enterprise", cloud: true, ...derive })).toBe("enterprise");
    expect(resolveEdition({ configured: "public", cloud: false, ...derive })).toBe("public");
  });

  it("refuses a missing edition once derivation is off, naming the parameter", () => {
    expect(() => resolveEdition({ configured: undefined, cloud: true, allowDerivedFromCloud: false })).toThrow(EDITION_MISSING_MESSAGE);
    expect(EDITION_MISSING_MESSAGE).toContain("ROVARA_EDITION");
  });

  it("derives a missing edition from the old cloud flag in the first release: cloud is Public, everything else Enterprise", () => {
    expect(resolveEdition({ configured: undefined, cloud: true, ...derive })).toBe("public");
    expect(resolveEdition({ configured: undefined, cloud: false, ...derive })).toBe("enterprise");
    expect(resolveEdition({ configured: undefined, cloud: undefined, ...derive })).toBe("enterprise");
  });

  it("throws CONFIG_INVALID", () => {
    expect(thrown(() => resolveEdition({ configured: "x", cloud: undefined, ...derive }))?.code).toBe("CONFIG_INVALID");
  });
});

describe("requireFeature", () => {
  const enterprise = editionPolicy("enterprise");
  const publicPolicy = editionPolicy("public");

  it("passes a feature the edition has", () => {
    expect(() => requireFeature(enterprise, "auditorRole")).not.toThrow();
    expect(() => requireFeature(publicPolicy, "staffRoutes")).not.toThrow();
  });

  it("refuses an Enterprise-only feature on Public with the fixed sentence", () => {
    const error = thrown(() => requireFeature(publicPolicy, "auditorRole"));
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.message).toContain(ENTERPRISE_ONLY_MESSAGE);
    expect(ENTERPRISE_ONLY_MESSAGE).toBe("This feature is part of the Enterprise edition.");
  });

  it("refuses a Public-only feature on Enterprise without calling it an Enterprise feature", () => {
    for (const feature of ["staffRoutes", "trialAndBilling"] as const) {
      const error = thrown(() => requireFeature(enterprise, feature));
      expect(error?.code).toBe("FORBIDDEN");
      expect(error?.message).toContain(NOT_IN_THIS_EDITION_MESSAGE);
      expect(error?.message).not.toContain("Enterprise edition");
    }
  });

  it("refuses a feature that is off everywhere as not available yet", () => {
    expect(thrown(() => requireFeature(enterprise, "scim"))?.message).toContain(NOT_AVAILABLE_YET_MESSAGE);
    expect(thrown(() => requireFeature(publicPolicy, "telemetry"))?.message).toContain(NOT_AVAILABLE_YET_MESSAGE);
  });

  it("refuses an unknown feature name, and never echoes it", () => {
    for (const name of ["nope", "__proto__", "constructor", "toString"]) {
      const error = thrown(() => requireFeature(enterprise, name as EditionFeature));
      expect(error?.code).toBe("FORBIDDEN");
      expect(error?.message).not.toContain(name);
    }
  });
});

describe("install info", () => {
  it("answers the edition and every feature, in the shape the app reads", () => {
    for (const edition of ["enterprise", "public"] as const) {
      const info = installInfo(editionPolicy(edition));
      expect(InstallInfoSchema.parse(info)).toEqual(info);
      expect(Object.keys(info.features).sort()).toEqual([...EDITION_FEATURES].sort());
    }
  });

  it("rejects an answer with an unknown edition or an extra field", () => {
    expect(InstallInfoSchema.safeParse({ edition: "cloud", features: {} }).success).toBe(false);
    expect(InstallInfoSchema.safeParse({ edition: "public", features: {}, extra: 1 }).success).toBe(false);
  });
});

describe("the session cap", () => {
  it("is 8 hours in Enterprise, so a group removal takes effect within it, and none on Public", () => {
    expect(editionPolicy("enterprise").sessionMaxSeconds).toBe(ENTERPRISE_SESSION_MAX_SECONDS);
    expect(ENTERPRISE_SESSION_MAX_SECONDS).toBe(28_800);
    expect(editionPolicy("public").sessionMaxSeconds).toBeUndefined();
  });
  it("turns the hosted sign-in methods off in Enterprise (E3 gates the routes by this row)", () => {
    expect(featureEnabled(editionPolicy("enterprise"), "publicSignInMethods")).toBe(false);
    expect(featureEnabled(editionPolicy("public"), "publicSignInMethods")).toBe(true);
  });
});

describe("the edition at synth", () => {
  it("derives once: the hosted cloud is Public; an existing install with no explicit edition gets none, and is never made Enterprise", () => {
    expect(editionAtSynth({ explicit: undefined, cloud: true })).toBe("public");
    expect(editionAtSynth({ explicit: undefined, cloud: false })).toBeUndefined();
    expect(editionAtSynth({ explicit: "enterprise", cloud: false })).toBe("enterprise");
    expect(editionAtSynth({ explicit: "public", cloud: true })).toBe("public");
  });
  it("refuses a new install that has not chosen an edition, and accepts one that has", () => {
    expect(thrown(() => editionAtSynth({ explicit: undefined, cloud: false, newInstall: true }))?.message).toContain("must choose its edition");
    expect(editionAtSynth({ explicit: "enterprise", cloud: false, newInstall: true })).toBe("enterprise");
    expect(editionAtSynth({ explicit: undefined, cloud: true, newInstall: true })).toBe("public");
  });
  it("refuses Enterprise with the hosted cloud, and Public without it", () => {
    expect(thrown(() => editionAtSynth({ explicit: "enterprise", cloud: true }))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => editionAtSynth({ explicit: "public", cloud: false }))?.code).toBe("CONFIG_INVALID");
  });
  it("refuses a redeploy that changes the recorded edition", () => {
    assertEditionUnchanged(undefined, "enterprise");
    assertEditionUnchanged("enterprise", "enterprise");
    expect(thrown(() => assertEditionUnchanged("enterprise", "public"))?.code).toBe("CONFIG_INVALID");
    expect(thrown(() => assertEditionUnchanged("public", "enterprise"))?.message).toContain("cannot change");
  });
});
