import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { BREAK_GLASS_NOT_FRESH_MESSAGE, BREAK_GLASS_NOT_RECORDED_MESSAGE, ENTERPRISE_SESSION_MAX_SECONDS, GROUP_MAPPING_MESSAGES, editionPolicy, orgMetaKey } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { decideCompanySignIn } from "../../packages/broker/src/developer/sso-sign-in.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OIDC_ISSUER, T0, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

// Enterprise foundations I1 wiring: the company sign-in decides from the person's groups, before anything about them is written.

const enterprise = editionPolicy("enterprise");
const ADMIN_GROUP = "rovara-admins";
const USER_GROUP = "rovara-users";
const BY = "a".repeat(64);
const NOW_SECONDS = Math.floor(T0 / 1000);

const una: FakeOidcUser = { sub: "una", name: "Una", email: "una@example.test", email_verified: true, groups: [USER_GROUP] };
const ada: FakeOidcUser = { sub: "ada", name: "Ada", email: "ada@example.test", email_verified: true, groups: [ADMIN_GROUP, USER_GROUP] };
const nobody: FakeOidcUser = { sub: "nobody", name: "Nobody", email: "nobody@example.test", email_verified: true, groups: ["some-other-group"] };
const noClaim: FakeOidcUser = { sub: "noclaim", name: "No Claim", email: "noclaim@example.test", email_verified: true };
const owner: FakeOidcUser = { sub: "owner-1", name: "Olga", email: "olga@example.test", email_verified: true, groups: [], auth_time: NOW_SECONDS };
const ownerId = ownerKeyForSubject(OIDC_ISSUER, "owner-1");

const RULES = [
  { id: "admins", group: ADMIN_GROUP, orgRole: "admin" as const, projectRoles: [] },
  { id: "users", group: USER_GROUP, orgRole: "member" as const, projectRoles: [] },
];

async function world(options: { users?: FakeOidcUser[]; mapping?: boolean; policy?: typeof enterprise | undefined; audit?: boolean; breakGlass?: boolean } = {}) {
  const capture = options.audit === false ? undefined : capturingAuditDeps();
  const h = identityHarness({
    oidc: {}, oidcUsers: options.users ?? [una, ada, nobody, noClaim, owner],
    ...("policy" in options ? (options.policy === undefined ? {} : { editionPolicy: options.policy }) : { editionPolicy: enterprise }), sso: true,
    ...(capture === undefined ? {} : { audit: capture }),
  });
  await h.orgs.ensureOrg(TEST_ORG, "staging");
  await h.orgs.addMember({ orgId: TEST_ORG, developerId: ownerId, role: "owner" });
  h.db.set({ ...orgMetaKey(TEST_ORG) });
  if (options.mapping !== false) await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
  if (options.breakGlass === true) await h.deps.sso!.breakGlass.put(TEST_ORG, [{ personId: ownerId, expiresAt: T0 + 3_600_000 }], BY, 0, T0);
  return { h, capture };
}

type World = Awaited<ReturnType<typeof world>>["h"];

/** The whole CLI sign-in: the code, then the tokens. */
async function signInAs(h: World, sub: string, claims?: Partial<FakeOidcUser>): Promise<{ redirect: URL; tokens?: Record<string, unknown> }> {
  let started = await h.http(httpEvent("GET", authorizeQuery()));
  // An edition that offers several methods shows the picker first; choose the company's.
  if (started.statusCode === 200) started = await h.http(httpEvent("GET", /href="([^"]*method=oidc)"/.exec(started.body)![1]!.replaceAll("&amp;", "&")));
  const providerUrl = started.headers.location!;
  const callback = h.oidc.approve(providerUrl, sub, claims === undefined ? {} : { claims });
  const back = await h.http(httpEvent("GET", callback));
  const redirect = new URL(back.headers.location ?? "https://none.invalid/");
  const code = redirect.searchParams.get("code");
  if (code === null) return { redirect };
  return { redirect, tokens: (await h.exchange(code)).body };
}

const roleOf = (tokens: Record<string, unknown> | undefined): unknown => (tokens === undefined ? undefined : decodeJwt(String(tokens.access_token)).org_role);
const sessionEndsAtOf = async (h: World, tokens: Record<string, unknown>) => (await h.deps.store.getSession(String(decodeJwt(String(tokens.access_token)).sid)))?.endsAt;

describe("a person in a mapped group", () => {
  it("comes in with the mapped role, for at most the edition's session cap, and the sign-in is audited with the rules that matched", async () => {
    const { h, capture } = await world();
    const user = await signInAs(h, "una");
    expect(roleOf(user.tokens)).toBe("member");
    expect(await sessionEndsAtOf(h, user.tokens!)).toBeLessThanOrEqual(NOW_SECONDS + ENTERPRISE_SESSION_MAX_SECONDS);
    expect(await sessionEndsAtOf(h, user.tokens!)).toBeGreaterThan(NOW_SECONDS);
    const [event] = capture!.recordedBy("sso.sign_in");
    expect(event).toMatchObject({ orgId: TEST_ORG, facts: { source: "mapping", role: "member", rules: 1 }, details: [{ subject: "org", fields: { matchedRuleIds: "users" } }] });
    // The groups themselves are never recorded.
    expect(JSON.stringify(capture!.recorded())).not.toContain(USER_GROUP);
  });

  it("gets the strongest mapped role of the groups the token carries", async () => {
    const { h } = await world();
    const admin = await signInAs(h, "ada");
    expect(roleOf(admin.tokens)).toBe("admin");
    expect((await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, "ada")))?.role).toBe("admin");
  });

  it("loses the role at the next sign-in when a group is taken away, and the access when the last one is", async () => {
    const { h } = await world();
    expect(roleOf((await signInAs(h, "ada")).tokens)).toBe("admin");
    expect(roleOf((await signInAs(h, "ada", { groups: [USER_GROUP] })).tokens)).toBe("member");
    const gone = await signInAs(h, "ada", { groups: ["unrelated"] });
    expect(gone.tokens).toBeUndefined();
    expect(gone.redirect.searchParams.get("error_description")).toContain(GROUP_MAPPING_MESSAGES.no_group);
  });

  it("a group claim that is one string is one group, never split", async () => {
    const { h } = await world();
    expect(roleOf((await signInAs(h, "una", { groups: USER_GROUP as never })).tokens)).toBe("member");
    expect((await signInAs(h, "una", { groups: `${USER_GROUP} ${ADMIN_GROUP}` as never })).tokens).toBeUndefined();
  });
});

describe("refusals (fail closed, and before anything is written about the person)", () => {
  it.each([
    ["a person in no mapped group", "nobody", "no_group"],
    ["a token with no group claim (a person in no group)", "noclaim", "no_group"],
  ] as const)("%s", async (_name, sub, reason) => {
    const { h, capture } = await world();
    const lookup = vi.spyOn(h.deps.directory, "lookupByEmail");
    const refused = await signInAs(h, sub);
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("code")).toBeNull();
    expect(refused.redirect.searchParams.get("error")).toBe("access_denied");
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES[reason]);
    const id = ownerKeyForSubject(OIDC_ISSUER, sub);
    // No membership, no developer record, no session, no Slack lookup.
    expect(await h.orgs.orgForDeveloper(id)).toBeUndefined();
    expect(await h.deps.store.getDeveloper(id)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(capture!.recordedBy("sso.sign_in_refused")[0]).toMatchObject({ facts: { refusal: reason } });
    expect(capture!.recordedBy("sso.sign_in")).toEqual([]);
  });

  it("no saved mapping refuses everyone who is not a break-glass owner", async () => {
    const { h } = await world({ mapping: false });
    const refused = await signInAs(h, "ada");
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.not_configured);
  });

  it("a saved mapping that cannot be read refuses, with its own sentence", async () => {
    const { h } = await world();
    // Stored in a shape the schema does not accept (a rule granting owner).
    const key = { pk: `ORG#${TEST_ORG}`, sk: "SSO_GROUP_MAPPING" };
    h.state.set({ ...(h.state.get(key.pk, key.sk) as Record<string, unknown>), rules: [{ id: "x", group: USER_GROUP, orgRole: "owner", projectRoles: [] }] });
    const refused = await signInAs(h, "una");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.config_invalid);
  });

  it("the invite page's sign-in is decided the same way: a refused join is a page and no session, an allowed one a session that ends within the cap", async () => {
    const { h } = await world();
    const join = async (sub: string) => {
      const { token } = await h.orgs.createInvite({ orgId: TEST_ORG, createdBy: ownerId, role: "member" });
      const start = await h.http(httpEvent("GET", `/v1/auth/join/start?invite=${token}`));
      const cookie = start.cookies!.find((value) => value.startsWith("__Host-rovara_join_pkce="))!.split(";")[0]!;
      return h.http({ ...httpEvent("GET", h.oidc.approve(start.headers.location!, sub)), headers: { cookie } });
    };
    const refused = await join("nobody");
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(GROUP_MAPPING_MESSAGES.no_group);
    expect(refused.cookies?.some((value) => value.startsWith("__Host-agentx_review_session="))).toBeFalsy();
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(0);
    expect(await h.orgs.orgForDeveloper(ownerKeyForSubject(OIDC_ISSUER, "nobody"))).toBeUndefined();

    const joined = await join("una");
    const cookie = joined.cookies!.find((value) => value.startsWith("__Host-agentx_review_session="))!;
    const session = await h.deps.store.getSession(cookie.split(";")[0]!.split("=")[1]!);
    expect(session!.endsAt).toBeLessThanOrEqual(NOW_SECONDS + ENTERPRISE_SESSION_MAX_SECONDS);
  });
});

describe("the browser sign-in (a task page, the app)", () => {
  it("is decided the same way, and its session ends within the cap", async () => {
    const { h } = await world();
    const browser = async (sub: string) => {
      const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent("/app")}`));
      const cookie = start.cookies!.find((value) => value.startsWith("__Host-agentx_review_pkce="))!.split(";")[0]!;
      return h.http({ ...httpEvent("GET", h.oidc.approve(start.headers.location!, sub)), headers: { cookie } });
    };
    const refused = await browser("nobody");
    expect(refused.cookies?.some((value) => value.startsWith("__Host-agentx_review_session="))).toBeFalsy();
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(0);
    const allowed = await browser("una");
    const cookie = allowed.cookies!.find((value) => value.startsWith("__Host-agentx_review_session="))!;
    const session = await h.deps.store.getSession(cookie.split(";")[0]!.split("=")[1]!);
    expect(session!.endsAt).toBeLessThanOrEqual(NOW_SECONDS + ENTERPRISE_SESSION_MAX_SECONDS);
  });
});

describe("the pieces", () => {
  it("the provider hands the sign-in the group claims of the verified token and nothing else of it", async () => {
    const { h } = await world();
    const provider = h.deps.providers.oidc!;
    const url = await provider.authorizeUrl({ state: "s", nonce: "n-1", redirectUri: "https://x.example.test/cb" });
    const code = new URL(h.oidc.approve(url, "una")).searchParams.get("code")!;
    const result = await provider.complete({ code, nonce: "n-1", redirectUri: "https://x.example.test/cb" });
    if (!result.ok) throw new Error("test setup: the provider refused");
    expect(result.identity.claims).toEqual({ groups: [USER_GROUP] });
  });

  it("a mapping reads only the company's own sign-in: any other method is refused as not configured", async () => {
    const { h } = await world();
    for (const method of ["slack", "cloud", "github"]) {
      const outcome = await decideCompanySignIn({
        policy: enterprise, stores: h.deps.sso, method, orgId: TEST_ORG, identity: { claims: { groups: [ADMIN_GROUP] } }, developerId: ownerKeyForSubject(OIDC_ISSUER, "x"),
        currentRole: undefined, occurrence: "r1", auditAvailable: true, nowMs: T0,
      });
      expect(outcome.allow, method).toBe(false);
      expect(outcome.allow ? undefined : outcome.reason, method).toBe("not_configured");
    }
  });
});

describe("owners", () => {
  it("an owner in no mapped group is refused: removing the person from the group is how the company takes access away", async () => {
    const { h } = await world({ breakGlass: true });
    const refused = await signInAs(h, "owner-1");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.no_group);
  });

  it("a listed owner whose token carries no groups claim at all is refused too (the provider leaves an empty claim out): not break-glass, because the mapping is fine", async () => {
    const { h, capture } = await world({ breakGlass: true, users: [{ ...owner, groups: undefined } as FakeOidcUser] });
    const refused = await signInAs(h, "owner-1");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.no_group);
    expect(capture!.recordedBy("sso.break_glass_used")).toEqual([]);
  });

  it("an owner in a mapped group stays an owner (a mapping never changes an owner's role)", async () => {
    const { h } = await world();
    expect(roleOf((await signInAs(h, "owner-1", { groups: [USER_GROUP] })).tokens)).toBe("owner");
  });

  it("a listed owner gets in when the mapping is broken: audited durably, one hour, alerted", async () => {
    const { h, capture } = await world({ mapping: false, breakGlass: true });
    const result = await signInAs(h, "owner-1");
    expect(roleOf(result.tokens)).toBe("owner");
    expect(await sessionEndsAtOf(h, result.tokens!)).toBeLessThanOrEqual(NOW_SECONDS + 3600);
    expect(capture!.recordedBy("sso.break_glass_used")).toHaveLength(1);
    expect(capture!.recordedBy("sso.break_glass_used")[0]).toMatchObject({ facts: { role: "owner", sessionSeconds: 3600 } });
    expect(h.logs.some((entry) => entry.event === "signin.break_glass_used" && entry.level === "alert")).toBe(true);
  });

  it("break-glass needs the break-glass list: with none stored, a broken mapping locks the owner out too", async () => {
    const { h } = await world({ mapping: false });
    expect((await signInAs(h, "owner-1")).tokens).toBeUndefined();
  });

  it("break-glass is for a broken mapping only: a working mapping that does not name the owner still refuses", async () => {
    const { h } = await world({ breakGlass: true });
    expect((await signInAs(h, "owner-1")).tokens).toBeUndefined();
  });

  it("break-glass needs a sign-in the provider made a moment ago (a stale or missing time is refused)", async () => {
    const stale = await world({ mapping: false, breakGlass: true });
    const old = await signInAs(stale.h, "owner-1", { auth_time: NOW_SECONDS - 3600 });
    expect(old.tokens).toBeUndefined();
    expect(old.redirect.searchParams.get("error_description")).toBe(BREAK_GLASS_NOT_FRESH_MESSAGE);
    const withoutTime: FakeOidcUser = { sub: owner.sub, name: owner.name!, email: owner.email!, email_verified: true, groups: [] };
    const none = await world({ mapping: false, breakGlass: true, users: [withoutTime] });
    expect((await signInAs(none.h, "owner-1")).tokens).toBeUndefined();
  });

  it("break-glass does not take a sign-in the provider dates in the future", async () => {
    const { h } = await world({ mapping: false, breakGlass: true });
    expect((await signInAs(h, "owner-1", { auth_time: NOW_SECONDS + 3600 })).tokens).toBeUndefined();
  });

  it("a code whose session cap has already passed starts no session", async () => {
    const short = { ...enterprise, sessionMaxSeconds: 5 };
    const capture = capturingAuditDeps();
    const h = identityHarness({ oidc: {}, oidcUsers: [una], editionPolicy: short, sso: true, audit: capture });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: BY }, 0);
    const started = await h.http(httpEvent("GET", authorizeQuery()));
    const back = await h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, "una")));
    const code = new URL(back.headers.location!).searchParams.get("code")!;
    h.tick(10_000);
    const exchanged = await h.exchange(code);
    expect(exchanged.status).toBe(400);
    expect(h.db.find((item) => String(item.pk).startsWith("SESSION#"))).toHaveLength(0);
  });

  it("break-glass is refused when it cannot be recorded (no ledger, or the record cannot be put)", async () => {
    const noLedger = await world({ mapping: false, breakGlass: true, audit: false });
    const refused = await signInAs(noLedger.h, "owner-1");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(BREAK_GLASS_NOT_RECORDED_MESSAGE);

    const down = await world({ mapping: false, breakGlass: true });
    down.h.state.injectFault({ command: "PutCommand", match: (input) => String((input as { Item?: { pk?: string } }).Item?.pk ?? "").startsWith("AUDIT_PENDING#"), error: { name: "ProvisionedThroughputExceededException" }, times: 5 });
    const failed = await signInAs(down.h, "owner-1");
    expect(failed.tokens).toBeUndefined();
  });

  it("an expired break-glass entry does nothing", async () => {
    const { h } = await world({ mapping: false });
    await h.deps.sso!.breakGlass.put(TEST_ORG, [{ personId: ownerId, expiresAt: T0 + 1000 }], BY, 0, T0);
    h.tick(10_000);
    expect((await signInAs(h, "owner-1", { auth_time: NOW_SECONDS + 10 })).tokens).toBeUndefined();
  });
});

describe("other editions are untouched", () => {
  it("Public and an install deployed before editions sign in with the company provider as before, with no mapping", async () => {
    for (const policy of [editionPolicy("public"), undefined]) {
      const { h, capture } = await world({ policy, mapping: false, audit: true });
      const result = await signInAs(h, "nobody");
      expect(roleOf(result.tokens), String(policy?.edition)).toBe("member");
      expect(capture!.recorded().filter((event) => event.action.startsWith("sso."))).toEqual([]);
    }
  });

  it("the edition with company sign-in but no stores wired refuses every sign-in", async () => {
    const h = identityHarness({ oidc: {}, oidcUsers: [una], editionPolicy: enterprise });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    const refused = await signInAs(h, "una");
    expect(refused.tokens).toBeUndefined();
    expect(refused.redirect.searchParams.get("error_description")).toBe(GROUP_MAPPING_MESSAGES.not_configured);
  });
});
