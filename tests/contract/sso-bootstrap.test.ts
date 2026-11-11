import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { singleOrgIdForEnv } from "@rovara-code/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { bootstrapSso, SSO_BOOTSTRAP_EDITION_MESSAGE, SSO_BOOTSTRAP_EXISTS_MESSAGE, type SsoBootstrapInput } from "../../packages/broker/src/developer/sso-bootstrap.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OIDC_ISSUER, T0, authorizeQuery, httpEvent, identityHarness } from "../support/developer-fakes.js";

// Enterprise foundations I-5: the first-run bootstrap writes the first mapping, the owners and the emergency list, once.

const enterprise = editionPolicy("enterprise");
const ORG = singleOrgIdForEnv("staging");
const INPUT: SsoBootstrapInput = {
  env: "staging", oidcIssuer: `${OIDC_ISSUER}/`, recordedEdition: "enterprise", claim: "groups", adminGroups: ["rovara-admins"], memberGroups: ["rovara-users"],
  ownerSubjects: ["olga"], breakGlassDays: 30, installerArn: "arn:aws:sts::123456789012:assumed-role/Deploy/alice", nowMs: T0,
};

function world() {
  const capture = capturingAuditDeps();
  const h = identityHarness({
    oidc: {}, oidcUsers: [
      { sub: "olga", name: "Olga", email: "olga@example.test", email_verified: true, groups: ["rovara-admins"] },
      { sub: "una", name: "Una", email: "una@example.test", email_verified: true, groups: ["rovara-users"] },
    ], editionPolicy: enterprise, sso: true, audit: capture, slack: false,
  });
  const deps = (audit = capture.audit) => ({ documentClient: h.state as never, tableName: "state", policy: enterprise, audit });
  return { h, capture, deps };
}

describe("bootstrapSso", () => {
  it("makes the named people owners, writes the first mapping and the emergency list, and records both", async () => {
    const { h, capture, deps } = world();
    const result = await bootstrapSso(deps(), INPUT);
    const olga = ownerKeyForSubject(OIDC_ISSUER, "olga");
    expect(result).toMatchObject({ orgId: ORG, ownerIds: [olga], rules: 2 });
    expect(await h.orgs.orgForDeveloper(olga)).toEqual({ orgId: ORG, role: "owner" });
    expect(await h.deps.sso!.mappings.get(ORG)).toMatchObject({ claim: "groups", version: 1, rules: [{ id: "admins-1", group: "rovara-admins", orgRole: "admin" }, { id: "members-1", group: "rovara-users", orgRole: "member" }] });
    expect(await h.deps.sso!.breakGlass.get(ORG)).toMatchObject({ version: 1, owners: [{ personId: olga, expiresAt: T0 + 30 * 86_400_000 }] });
    expect(capture.recordedBy("sso.group_mapping_changed")[0]).toMatchObject({ actor: { kind: "operator" }, facts: { fromVersion: 0, toVersion: 1, rules: 2 } });
    expect(capture.recordedBy("sso.break_glass_changed")).toHaveLength(1);
    // The installer's ARN is never recorded, only a hash.
    expect(JSON.stringify(capture.recorded())).not.toContain("alice");
  });

  it("the people it names can then sign in: the owner stays owner, a member of the other group joins as member", async () => {
    const { h, deps } = world();
    await bootstrapSso(deps(), INPUT);
    const signIn = async (sub: string) => {
      const started = await h.http(httpEvent("GET", authorizeQuery()));
      const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, sub)));
      const code = new URL(back.headers.location!).searchParams.get("code");
      return code === null ? undefined : decodeJwt(String((await h.exchange(code)).body.access_token)).org_role;
    };
    expect(await signIn("olga")).toBe("owner");
    expect(await signIn("una")).toBe("member");
  });

  it("refuses once a mapping or a list exists, and changes nothing", async () => {
    const { h, deps } = world();
    await bootstrapSso(deps(), INPUT);
    const before = JSON.stringify(h.state.find(() => true));
    await expect(bootstrapSso(deps(), { ...INPUT, ownerSubjects: ["mallory"], adminGroups: ["everyone"] })).rejects.toThrow(SSO_BOOTSTRAP_EXISTS_MESSAGE);
    expect(JSON.stringify(h.state.find(() => true))).toBe(before);
    expect(await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, "mallory"))).toBeUndefined();
    // A list alone also blocks it.
    const other = world();
    await other.h.deps.sso!.breakGlass.put(ORG, [{ personId: "a".repeat(64), expiresAt: T0 + 1000 * 3600 }], "b".repeat(64), 0, T0);
    await expect(bootstrapSso(other.deps(), INPUT)).rejects.toThrow(SSO_BOOTSTRAP_EXISTS_MESSAGE);
  });

  it("is for an Enterprise install only: the recorded edition must say so, and the policy must have company sign-in", async () => {
    const { deps } = world();
    for (const recordedEdition of [undefined, "public", "Enterprise"]) await expect(bootstrapSso(deps(), { ...INPUT, recordedEdition })).rejects.toThrow(SSO_BOOTSTRAP_EDITION_MESSAGE);
    await expect(bootstrapSso({ ...deps(), policy: editionPolicy("public") }, INPUT)).rejects.toThrow(/Enterprise edition/);
  });

  it("is not made without the audit ledger", async () => {
    const { h, deps } = world();
    await expect(bootstrapSso({ ...deps(), audit: undefined }, INPUT)).rejects.toThrow(/audit ledger/);
    expect(await h.deps.sso!.mappings.get(ORG)).toBeUndefined();
  });

  it("refuses malformed input before writing anything", async () => {
    const { h, deps } = world();
    const bad: Array<Partial<SsoBootstrapInput>> = [
      { ownerSubjects: [] }, { ownerSubjects: ["a", "b", "c"] }, { ownerSubjects: ["a", "a"] }, { adminGroups: [] }, { breakGlassDays: 0 }, { breakGlassDays: 91 },
      { claim: "email" }, { adminGroups: ["same"], memberGroups: ["same"] },
    ];
    for (const change of bad) await expect(bootstrapSso(deps(), { ...INPUT, ...change }), JSON.stringify(change)).rejects.toThrow();
    expect(await h.deps.sso!.mappings.get(ORG)).toBeUndefined();
    expect(h.state.find((item) => String(item.sk).startsWith("MEMBER#"))).toEqual([]);
  });
});
