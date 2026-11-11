// Task 7: org invites. The routes that issue an invite link, the `invite` parameter that carries it through
// sign-in, and what the sign-in answers when the invite could not be used.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgInviteKey, orgInviteRequestKey } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { createDeveloperApiConfiguration } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { DEFAULT_ROVARA_WEB_ORIGIN, inviteTokenHash, webOriginFromEnvironment } from "../../packages/broker/src/org/invite-url.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { OIDC_ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

const bea: FakeOidcUser = { sub: "bea-cloud-1", name: "Bea Ortiz", email: "bea@example.com", email_verified: true };
const carl: FakeOidcUser = { sub: "carl-cloud-1", name: "Carl Wu", email: "carl@example.com", email_verified: true };
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
/** The token in an invite link, whether it rides the query (a private install) or the fragment (a cloud install). */
const tokenOf = (inviteUrl: unknown) => { const url = new URL(String(inviteUrl)); return (url.searchParams.get("invite") ?? new URLSearchParams(url.hash.slice(1)).get("invite"))!; };

/** The broker, with Maya an owner of the install's org (Omar stays a member). */
async function brokerWithOwner(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const harness = await createDeveloperTaskBroker(options);
  seedMembership(harness.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
  const invite = async (who: typeof MAYA, body: Record<string, unknown> = {}) =>
    harness.dev(who, "POST", "/v1/dev/org/invites", { requestId: randomUUID(), role: "member", ...body });
  return { ...harness, invite };
}

describe("POST /v1/dev/org/invites", () => {
  it("lets an owner create an invite link on the cell's own join page, for the owner's own org", async () => {
    const { invite, db } = await brokerWithOwner();
    const created = await invite(MAYA);
    expect(created.status).toBe(200);
    expect(String(created.body.inviteUrl)).toMatch(new RegExp(`^${DEV_ISSUER}/join\\?invite=[A-Za-z0-9_-]{43}$`));
    expect(db.get(orgInviteKey(sha256Hex(tokenOf(created.body.inviteUrl))))).toMatchObject({ orgId: TEST_ORG, role: "member", createdBy: MAYA.developerId });
  });

  // UX1: the app's own origin (the sign-in server's, where /app is served) answers /join itself, so the link no longer goes through rovara.dev.
  it("builds a cloud install's link on the app's own origin, with the token in the fragment, whatever the web origin setting", async () => {
    const cloud = await brokerWithOwner({ brokerExtra: { cloud: true } });
    expect(String((await cloud.invite(MAYA)).body.inviteUrl)).toMatch(/^https:\/\/abc123\.execute-api\.us-east-1\.amazonaws\.com\/join#invite=[A-Za-z0-9_-]{43}$/);
    const { invite } = await brokerWithOwner({ brokerExtra: { cloud: true }, developerExtra: { webOrigin: "http://localhost:3000" } });
    expect(String((await invite(MAYA)).body.inviteUrl)).toMatch(/^https:\/\/abc123\.execute-api\.us-east-1\.amazonaws\.com\/join#invite=/);
  });

  it("refuses a member with 403 FORBIDDEN and writes no invite", async () => {
    const { invite, db } = await brokerWithOwner();
    const refused = await invite(OMAR);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(db.find((item) => item.entityType === "ORG_INVITE")).toHaveLength(0);
  });

  it("lets an admin invite members but only an owner invite admins", async () => {
    const { invite, db } = await brokerWithOwner();
    seedMembership(db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await invite(OMAR, { role: "member" })).status).toBe(200);
    const refused = await invite(OMAR, { role: "admin" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(db.find((item) => item.entityType === "ORG_INVITE")).toHaveLength(1);
    const byOwner = await invite(MAYA, { role: "admin" });
    expect(byOwner.status).toBe(200);
    expect(db.get(orgInviteKey(sha256Hex(tokenOf(byOwner.body.inviteUrl))))).toMatchObject({ role: "admin" });
  });

  it("stores an email for the invite, lower-cased", async () => {
    const { invite, db } = await brokerWithOwner();
    const created = await invite(MAYA, { email: "Bea@Example.com" });
    expect(db.get(orgInviteKey(sha256Hex(tokenOf(created.body.inviteUrl))))).toMatchObject({ email: "bea@example.com" });
  });

  it("refuses a replay of the same requestId with 409 and issues no second invite", async () => {
    const { invite, db } = await brokerWithOwner();
    const requestId = randomUUID();
    expect((await invite(MAYA, { requestId })).status).toBe(200);
    const replay = await invite(MAYA, { requestId });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((replay.body.error as { message: string }).message).toContain("invite already created for this request");
    expect(db.find((item) => item.entityType === "ORG_INVITE")).toHaveLength(1);
    expect(db.get(orgInviteRequestKey(TEST_ORG, requestId))).toBeDefined();
    expect((await invite(MAYA)).status).toBe(200);
  });

  it.each([
    ["no requestId", { requestId: undefined }],
    ["a requestId that is not a UUID", { requestId: "again" }],
    ["the owner role", { role: "owner" }],
    ["no role", { role: undefined }],
    ["a malformed email", { email: "not-an-email" }],
    ["an org of its own choosing", { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }],
  ])("refuses %s with 400 CONFIG_INVALID", async (_name, patch) => {
    const { dev, db } = await brokerWithOwner();
    const refused = await dev(MAYA, "POST", "/v1/dev/org/invites", { requestId: randomUUID(), role: "member", ...patch });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(db.find((item) => item.entityType === "ORG_INVITE")).toHaveLength(0);
  });
});

describe("GET /v1/dev/org", () => {
  it("answers the caller's org and their role", async () => {
    const { dev } = await brokerWithOwner();
    const owner = await dev(MAYA, "GET", "/v1/dev/org");
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ org: { orgId: TEST_ORG, name: "staging", plan: "team" }, role: "owner" });
    expect(Object.keys(owner.body.org as object).sort()).toEqual(["name", "orgId", "plan"]);
    expect((await dev(OMAR, "GET", "/v1/dev/org")).body).toMatchObject({ org: { orgId: TEST_ORG }, role: "member" });
  });
});

describe("an invite through sign-in", () => {
  async function inviteFrom(broker: Awaited<ReturnType<typeof brokerWithOwner>>, body: Record<string, unknown> = {}) {
    const created = await broker.invite(MAYA, body);
    expect(created.status).toBe(200);
    return tokenOf(created.body.inviteUrl);
  }
  const signInWith = async (h: ReturnType<typeof identityHarness>, who: FakeOidcUser, query: Record<string, string> = {}) => {
    const back = await h.signIn("cloud", who.sub, { query });
    const code = back.searchParams.get("code");
    const exchanged = code === null ? undefined : await h.exchange(code);
    return { back, claims: exchanged === undefined ? undefined : claimsOf(exchanged.body.access_token) };
  };

  it("makes a new person a member of the inviting org", async () => {
    const broker = await brokerWithOwner();
    const token = await inviteFrom(broker);
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], state: broker.db });
    const { back, claims } = await signInWith(h, bea, { invite: token });
    expect(back.searchParams.has("inviteError")).toBe(false);
    expect(claims).toMatchObject({ sub: ownerKeyForSubject(OIDC_ISSUER, bea.sub), org: TEST_ORG, org_role: "member" });
    expect(broker.db.get(orgInviteKey(sha256Hex(token)))).toMatchObject({ acceptedBy: ownerKeyForSubject(OIDC_ISSUER, bea.sub) });
  });

  it("gives an admin invite the admin role", async () => {
    const broker = await brokerWithOwner();
    const token = await inviteFrom(broker, { role: "admin" });
    const h = identityHarness({ cloud: {}, oidcUsers: [bea], state: broker.db });
    expect((await signInWith(h, bea, { invite: token })).claims).toMatchObject({ org: TEST_ORG, org_role: "admin" });
  });

  it("leaves a person already in another org there, reports ALREADY_IN_ORG, and keeps the invite for someone else", async () => {
    const broker = await brokerWithOwner();
    const token = await inviteFrom(broker);
    const h = identityHarness({ cloud: {}, oidcUsers: [bea, carl], state: broker.db });
    const own = (await signInWith(h, bea)).claims!;
    expect(own.org).not.toBe(TEST_ORG);

    const again = await signInWith(h, bea, { invite: token });
    expect(again.back.searchParams.get("inviteError")).toBe("ALREADY_IN_ORG");
    expect(again.claims).toMatchObject({ org: own.org, org_role: "owner" });
    expect(broker.db.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();

    const other = await signInWith(h, carl, { invite: token });
    expect(other.back.searchParams.has("inviteError")).toBe(false);
    expect(other.claims).toMatchObject({ org: TEST_ORG, org_role: "member" });
  });

  it("answers INVITE_INVALID for an unknown, used or expired invite, and the person gets an org of their own", async () => {
    const broker = await brokerWithOwner();
    const h = identityHarness({ cloud: {}, oidcUsers: [bea, carl], state: broker.db });
    const unknown = await signInWith(h, bea, { invite: "A".repeat(43) });
    expect(unknown.back.searchParams.get("inviteError")).toBe("INVITE_INVALID");
    expect(unknown.claims).toMatchObject({ org_role: "owner" });
    expect(unknown.claims?.org).not.toBe(TEST_ORG);

    const token = await inviteFrom(broker);
    expect((await signInWith(identityHarness({ cloud: {}, oidcUsers: [carl], state: broker.db }), carl, { invite: token })).claims).toMatchObject({ org: TEST_ORG });
    const used = await signInWith(identityHarness({ cloud: {}, oidcUsers: [{ ...bea, sub: "bea-cloud-2", email: "bea2@example.com" }], state: broker.db }), { ...bea, sub: "bea-cloud-2" }, { invite: token });
    expect(used.back.searchParams.get("inviteError")).toBe("INVITE_INVALID");
  });

  it("holds an email-targeted invite for that verified email: another email is refused and the invite stays", async () => {
    const broker = await brokerWithOwner();
    const token = await inviteFrom(broker, { email: "bea@example.com" });
    const h = identityHarness({ cloud: {}, oidcUsers: [bea, carl], state: broker.db });
    const wrong = await signInWith(h, carl, { invite: token });
    expect(wrong.back.searchParams.get("inviteError")).toBe("INVITE_WRONG_EMAIL");
    expect(wrong.claims?.org).not.toBe(TEST_ORG);
    expect(broker.db.get(orgInviteKey(sha256Hex(token)))?.acceptedAt).toBeUndefined();
    expect((await signInWith(h, bea, { invite: token })).claims).toMatchObject({ org: TEST_ORG, org_role: "member" });
  });

  it("refuses a malformed invite parameter at authorize, and stores no sign-in request", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea] });
    for (const invite of ["short", "A".repeat(44), `${"A".repeat(42)}!`, `${"A".repeat(42)}=`, ""]) {
      const refused = await h.signIn("cloud", bea.sub, { query: { invite } });
      expect(refused.searchParams.get("error"), invite).toBe("invalid_request");
      expect(refused.searchParams.get("state"), invite).toBe("cli-state");
    }
    expect(h.db.find((item) => item.entityType === "AUTH_REQUEST")).toHaveLength(0);
  });

  it("keeps the invite's hash, never the token, on the sign-in request until the callback, in the sign-in table", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [bea] });
    const token = "B".repeat(43);
    await h.http(httpEvent("GET", authorizeQuery({ invite: token })));
    const request = h.db.find((item) => item.entityType === "AUTH_REQUEST")[0]!;
    expect(request).toMatchObject({ inviteTokenHash: inviteTokenHash(token) });
    expect(request).not.toHaveProperty("inviteToken");
    expect(JSON.stringify(request)).not.toContain(token);
  });
});

describe("ROVARA_WEB_ORIGIN", () => {
  it("defaults to https://rovara.dev and accepts an https origin or http://localhost", () => {
    expect(webOriginFromEnvironment({})).toBe(DEFAULT_ROVARA_WEB_ORIGIN);
    expect(webOriginFromEnvironment({ ROVARA_WEB_ORIGIN: "" })).toBe("https://rovara.dev");
    expect(webOriginFromEnvironment({ ROVARA_WEB_ORIGIN: "https://app.rovara.example" })).toBe("https://app.rovara.example");
    expect(webOriginFromEnvironment({ ROVARA_WEB_ORIGIN: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it.each(["http://rovara.dev", "rovara.dev", "ftp://rovara.dev", "https://rovara.dev/join", "https://user@rovara.dev", "http://localhost.evil.test"])(
    "refuses %s with CONFIG_INVALID", (value) => {
      expect(() => webOriginFromEnvironment({ ROVARA_WEB_ORIGIN: value })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    });

  it("fails the developer configuration at startup, and carries a good origin into it", () => {
    const env = { DEVELOPER_TOKEN_ISSUER: "https://abc.example/v1/auth", DEVELOPER_IDENTITY_FUNCTION_NAME: "identity", DEVELOPER_SIGNIN_TABLE_NAME: "signin", AGENTX_ENV: "staging" };
    const integrations = () => ({}) as never;
    expect(() => createDeveloperApiConfiguration({ ...env, ROVARA_WEB_ORIGIN: "http://rovara.dev" }, integrations)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(createDeveloperApiConfiguration(env, integrations)?.webOrigin).toBe("https://rovara.dev");
    expect(createDeveloperApiConfiguration({ ...env, ROVARA_WEB_ORIGIN: "http://localhost:3000" }, integrations)?.webOrigin).toBe("http://localhost:3000");
  });
});
