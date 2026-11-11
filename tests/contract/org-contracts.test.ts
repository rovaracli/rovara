import { describe, expect, it } from "vitest";
import { OrgIdSchema, orgPk, orgScoped, singleOrgIdForEnv } from "@rovara-code/contracts";
import { OrgRoleSchema, developerOrgKey, newOrgId, orgEmailKey, orgInviteKey, orgMemberKey, orgMetaKey, slackTeamOrgKey } from "../../packages/cloud-contracts/src/org-node.js";
import * as contracts from "@rovara-code/contracts";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;

describe("org ids", () => {
  it("newOrgId matches the schema and differs between calls", () => {
    const a = newOrgId();
    const b = newOrgId();
    expect(OrgIdSchema.safeParse(a).success).toBe(true);
    expect(OrgIdSchema.safeParse(b).success).toBe(true);
    expect(a).not.toBe(b);
  });

  it("newOrgId derives deterministically from injected random bytes", () => {
    const zeros = newOrgId(() => new Uint8Array(32));
    expect(zeros).toBe(newOrgId(() => new Uint8Array(32)));
    expect(OrgIdSchema.safeParse(zeros).success).toBe(true);
    expect(OrgIdSchema.safeParse(newOrgId(() => new Uint8Array(32).fill(255))).success).toBe(true);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["org_short", "ORG_aaaaaaaaaaaaaaaaaaaa", "org_AAAAAAAAAAAAAAAAAAAA", `${ORG}a`, ""]) {
      expect(OrgIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("singleOrgIdForEnv is deterministic, schema-valid and env-specific", () => {
    expect(singleOrgIdForEnv("staging")).toBe(singleOrgIdForEnv("staging"));
    expect(singleOrgIdForEnv("staging")).not.toBe(singleOrgIdForEnv("prod"));
    expect(OrgIdSchema.safeParse(singleOrgIdForEnv("staging")).success).toBe(true);
    expect(OrgIdSchema.safeParse(singleOrgIdForEnv("")).success).toBe(true);
  });

  it("pins the derived id of the staging environment: the ids are persisted, so a refactor must not silently re-key them", () => {
    expect(singleOrgIdForEnv("staging")).toBe("org_5t5gp58cc1ibgg6e3aoj");
  });

  it("is exported from the contracts index", () => {
    expect(contracts.OrgIdSchema).toBe(OrgIdSchema);
  });
});

describe("org roles", () => {
  it("accepts known roles and rejects others", () => {
    expect(OrgRoleSchema.parse("owner")).toBe("owner");
    expect(() => OrgRoleSchema.parse("guest")).toThrow();
  });
});

describe("org keys", () => {
  it("builds org-scoped keys", () => {
    expect(orgPk(ORG)).toBe(`ORG#${ORG}`);
    expect(orgScoped(ORG, "PROJECT#web")).toBe("ORG#org_aaaaaaaaaaaaaaaaaaaa#PROJECT#web");
    expect(orgMetaKey(ORG)).toEqual({ pk: `ORG#${ORG}`, sk: "META" });
    expect(orgMemberKey(ORG, "dev_1")).toEqual({ pk: `ORG#${ORG}`, sk: "MEMBER#dev_1" });
    expect(developerOrgKey("dev_1")).toEqual({ pk: "DEVELOPER_ORG#dev_1", sk: "ORG" });
    expect(orgInviteKey("abc")).toEqual({ pk: "ORG_INVITE#abc", sk: "META" });
    expect(slackTeamOrgKey("T1")).toEqual({ pk: "SLACK_TEAM#T1", sk: "ORG" });
  });

  it("normalizes emails", () => {
    expect(orgEmailKey(" Priya@Acme.COM ")).toEqual({ pk: "ORG_EMAIL#priya@acme.com", sk: "DEVELOPER" });
  });
});
