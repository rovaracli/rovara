// Enterprise foundations I1 + I2 together: the company sign-in's group mapping can give the Auditor role. It works in Enterprise, is refused where the edition has no Auditor (and in
// Public), and a person who matches both a role that works in Rovara and the Auditor is REFUSED at sign-in with a fixed sentence (controller default, pending the owner's answer).
// Starting an audit export needs a fresh sign-in (controller default, pending the owner's answer).
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { AgentXError, GROUP_MAPPING_MESSAGES, editionPolicy, type EditionPolicy } from "@agentx/contracts";
import { decideSignIn, dynamoGroupMappingStore, evaluateGroupMapping } from "../../packages/broker/src/developer/group-mapping.js";
import { decideCompanySignIn } from "../../packages/broker/src/developer/sso-sign-in.js";
import { AUDIT_EXPORT_FRESH_SIGN_IN_MESSAGE } from "../../packages/broker/src/aws/developer-routes/audit-export-fresh.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OIDC_ISSUER, T0, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { fixtureWithSession } from "../support/auditor-sso-mapping-support.js";

const ENTERPRISE = editionPolicy("enterprise");
const PUBLIC = editionPolicy("public");
// An edition with company sign-in but no Auditor: what a future edition between the two could be. The rule that refuses the role must not depend on the edition's name.
const SSO_WITHOUT_AUDITOR: EditionPolicy = { ...ENTERPRISE, features: { ...ENTERPRISE.features, auditorRole: false } };
const BY = "a".repeat(64);

const RULES = [
  { id: "admins", group: "rovara-admins", orgRole: "admin" as const, projectRoles: [] },
  { id: "users", group: "rovara-users", orgRole: "member" as const, projectRoles: [] },
  { id: "auditors", group: "rovara-auditors", orgRole: "auditor" as const, projectRoles: [] },
];
const config = { claim: "groups", version: 1, updatedAt: "2026-10-31T00:00:00.000Z", updatedBy: BY, rules: RULES };
const evaluate = (groups: string[], policy: EditionPolicy = ENTERPRISE) => evaluateGroupMapping({ policy, config, claims: { groups } });

describe("a mapping rule that grants the Auditor", () => {
  it("works in Enterprise: a person only in the auditors group is an Auditor, with no project roles", () => {
    expect(evaluate(["rovara-auditors"])).toMatchObject({ ok: true, access: { orgRole: "auditor", projectRoles: [], matchedRuleIds: ["auditors"] } });
  });

  it("is refused in Public (the company sign-in itself is Enterprise), and where the edition has company sign-in but no Auditor (a broken mapping, never a member)", () => {
    expect(evaluate(["rovara-auditors"], PUBLIC)).toEqual({ ok: false, reason: "edition_off" });
    expect(evaluate(["rovara-auditors"], SSO_WITHOUT_AUDITOR)).toEqual({ ok: false, reason: "config_invalid" });
  });

  it("cannot be SAVED where the edition has no Auditor, and is saved in Enterprise", async () => {
    const body = { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00.000Z", updatedBy: BY };
    const without = dynamoGroupMappingStore({ documentClient: new FakeDynamoDb(), tableName: "state", policy: SSO_WITHOUT_AUDITOR });
    await expect(without.put(TEST_ORG, body, 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await without.get(TEST_ORG)).toBeUndefined();
    const store = dynamoGroupMappingStore({ documentClient: new FakeDynamoDb(), tableName: "state", policy: ENTERPRISE });
    expect((await store.put(TEST_ORG, body, 0)).version).toBe(1);
    await expect(dynamoGroupMappingStore({ documentClient: new FakeDynamoDb(), tableName: "state", policy: PUBLIC }).put(TEST_ORG, body, 0)).rejects.toBeDefined();
  });
});

describe("a person matched to both a role that works in Rovara and the Auditor", () => {
  it.each([["admin", "rovara-admins"], ["member", "rovara-users"]])("is refused (not made the %s) with a fixed sentence that tells them to ask their administrator", (_role, group) => {
    const result = evaluate([group, "rovara-auditors"]);
    expect(result).toEqual({ ok: false, reason: "auditor_and_writer" });
    expect(GROUP_MAPPING_MESSAGES.auditor_and_writer).toMatch(/administrator/u);
    // The order of the groups in the claim does not matter.
    expect(evaluate(["rovara-auditors", group])).toEqual(result);
  });

  it("is refused at the sign-in decision, an owner and a named break-glass owner included (it is not a broken mapping)", () => {
    const ownerId = "c".repeat(64);
    const input = { policy: ENTERPRISE, config, claims: { groups: ["rovara-users", "rovara-auditors"] }, personId: ownerId, breakGlass: [{ personId: ownerId }], now: 1 };
    for (const currentRole of ["member", "owner", undefined] as const) {
      expect(decideSignIn({ ...input, currentRole }), String(currentRole)).toEqual({ allow: false, reason: "auditor_and_writer", message: GROUP_MAPPING_MESSAGES.auditor_and_writer });
    }
  });

  it("does not refuse a person in two writer groups or two groups of one Auditor rule, nor an Auditor in an unmapped group as well", () => {
    expect(evaluate(["rovara-admins", "rovara-users"])).toMatchObject({ ok: true, access: { orgRole: "admin" } });
    expect(evaluate(["rovara-auditors", "some-unmapped-group"])).toMatchObject({ ok: true, access: { orgRole: "auditor" } });
  });

  it("an owner who is only in the auditors group keeps their owner role (the mapping decides entry, never an owner's role)", () => {
    expect(decideSignIn({ policy: ENTERPRISE, config, claims: { groups: ["rovara-auditors"] }, currentRole: "owner", personId: BY, breakGlass: [], now: 1 })).toMatchObject({ allow: true, orgRole: "owner" });
  });
});

// ---- through the company sign-in (the real server): tokens, the member record, the audit trail ------------------------------------------------------------

const NOW_SECONDS = Math.floor(T0 / 1000);
const users: FakeOidcUser[] = [
  { sub: "aud", name: "Audra", email: "audra@example.test", email_verified: true, groups: ["rovara-auditors"], auth_time: NOW_SECONDS },
  { sub: "both", name: "Both", email: "both@example.test", email_verified: true, groups: ["rovara-users", "rovara-auditors"], auth_time: NOW_SECONDS },
  { sub: "una", name: "Una", email: "una@example.test", email_verified: true, groups: ["rovara-users"], auth_time: NOW_SECONDS },
];

async function world(policy: EditionPolicy) {
  const capture = capturingAuditDeps();
  const h = identityHarness({ oidc: {}, oidcUsers: users, editionPolicy: policy, sso: true, audit: capture });
  await h.orgs.ensureOrg(TEST_ORG, "staging");
  await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
  return { h, capture };
}
async function signInAs(h: Awaited<ReturnType<typeof world>>["h"], sub: string) {
  let started = await h.http(httpEvent("GET", authorizeQuery()));
  if (started.statusCode === 200) started = await h.http(httpEvent("GET", /href="([^"]*method=oidc)"/.exec(started.body)![1]!.replaceAll("&amp;", "&")));
  const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, sub)));
  const redirect = new URL(back.headers.location ?? "https://none.invalid/");
  const code = redirect.searchParams.get("code");
  return { redirect, tokens: code === null ? undefined : (await h.exchange(code)).body };
}

describe("the company sign-in, end to end", () => {
  it("signs an Auditor in with the auditor role, which is recorded as the person's role and in the audit trail", async () => {
    const { h, capture } = await world(ENTERPRISE);
    const signed = await signInAs(h, "aud");
    expect(decodeJwt(String(signed.tokens!.access_token)).org_role).toBe("auditor");
    expect((await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, "aud")))?.role).toBe("auditor");
    expect(capture.recordedBy("sso.sign_in")[0]).toMatchObject({ facts: { source: "mapping", role: "auditor" } });
  });

  it("refuses a person who is both, with the fixed sentence, before anything is written about them, and records the refusal word", async () => {
    const { h, capture } = await world(ENTERPRISE);
    const refused = await signInAs(h, "both");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error")).toBe("access_denied");
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.auditor_and_writer);
    const id = ownerKeyForSubject(OIDC_ISSUER, "both");
    expect(await h.orgs.orgForDeveloper(id)).toBeUndefined();
    expect(await h.deps.store.getDeveloper(id)).toBeUndefined();
    expect(capture.recordedBy("sso.sign_in_refused")[0]).toMatchObject({ facts: { refusal: "auditor_and_writer" } });
    expect(capture.recordedBy("sso.sign_in")).toEqual([]);
    // An ordinary member in the same install still signs in.
    expect(decodeJwt(String((await signInAs(h, "una")).tokens!.access_token)).org_role).toBe("member");
  });

  it("the decision function says the same without the server (the audit event carries the refusal word)", async () => {
    const { h } = await world(ENTERPRISE);
    const decided = await decideCompanySignIn({
      policy: ENTERPRISE, stores: h.deps.sso, method: "oidc", orgId: TEST_ORG, identity: { claims: { groups: ["rovara-users", "rovara-auditors"] }, authTime: NOW_SECONDS }, developerId: BY,
      currentRole: undefined, occurrence: "req-1", auditAvailable: true, nowMs: T0,
    });
    expect(decided).toMatchObject({ allow: false, reason: "auditor_and_writer", message: GROUP_MAPPING_MESSAGES.auditor_and_writer, event: { action: "sso.sign_in_refused", facts: { refusal: "auditor_and_writer" } } });
  });
});

// ---- starting an audit export needs a fresh sign-in ------------------------------------------------------------------------------------------------------------

describe("starting an audit export", () => {
  const exportBody = { requestId: "export-1", fromSeq: 1, toSeq: 4 };
  const stale = new Date(Date.parse("2026-10-26T12:00:00Z") - 11 * 60_000).toISOString();
  const fresh = new Date(Date.parse("2026-10-26T12:00:00Z") - 5 * 60_000).toISOString();

  it.each(["owner", "admin", "auditor"] as const)("needs a fresh sign-in for an %s: a session signed in 11 minutes ago, or with no readable sign-in time, is sent to sign in again", async (role) => {
    for (const authTime of [stale, undefined, "not a time"]) {
      const f = fixtureWithSession(role, authTime);
      for (const path of ["/v1/app/org/audit/exports", "/v1/dev/org/audit/exports"]) {
        expect(await f.call("POST", path, exportBody), `${role} ${path} ${authTime}`).toMatchObject({ code: "REAUTH_REQUIRED", message: expect.stringContaining(AUDIT_EXPORT_FRESH_SIGN_IN_MESSAGE) as string });
      }
    }
  });

  it("goes on to the export when the sign-in is fresh (the route then answers as it did before: here there is no ledger)", async () => {
    for (const role of ["owner", "admin", "auditor"] as const) {
      const f = fixtureWithSession(role, fresh);
      expect(await f.call("POST", "/v1/app/org/audit/exports", exportBody), role).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("does not ask for it to read records or status or to look at an export, and a caller who may not read the log is told that, not asked to sign in again", async () => {
    const f = fixtureWithSession("admin", stale);
    for (const path of ["/v1/app/org/audit/records", "/v1/app/org/audit/status", "/v1/app/org/audit/exports/abc"]) {
      expect(await f.call("GET", path), path).not.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    const member = fixtureWithSession("member", stale);
    expect(await member.call("POST", "/v1/app/org/audit/exports", exportBody)).toMatchObject({ code: "FORBIDDEN" });
  });
});

void AgentXError;
