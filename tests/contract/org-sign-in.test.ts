// Task 5 (ruling R2): a sign-in puts the developer in an org, and every access token carries it.
import { describe, expect, it } from "vitest";
import { agentXError } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { resolveOrgOnSignIn } from "../../packages/broker/src/org/sign-in.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const mayaId = ownerKeyForSubject("https://slack.com", "U0MAYA001");
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

async function signedIn(h: ReturnType<typeof identityHarness>) {
  const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return exchanged.body;
}

describe("resolveOrgOnSignIn (rules 1 and 5; cloud-sign-in.test.ts has the rest)", () => {
  const input = (developerId: string) => ({ method: "slack" as const, developerId, displayName: "Maya", emailVerified: true });
  const store = () => new OrgStore({ documentClient: new FakeDynamoDb(), tableName: "state", now: () => Date.parse("2026-10-19T00:00:00.000Z") });

  it("joins the install's single org as a member, creating the org record on first use", async () => {
    const orgs = store();
    expect(await resolveOrgOnSignIn({ orgs, singleOrgId: TEST_ORG, singleOrgName: TEST_ENV }, input("a".repeat(64)))).toEqual({ orgId: TEST_ORG, role: "member" });
    expect(await orgs.getOrg(TEST_ORG)).toMatchObject({ name: TEST_ENV });
    expect(await orgs.orgForDeveloper("a".repeat(64))).toEqual({ orgId: TEST_ORG, role: "member" });
  });

  it("returns an existing membership unchanged, whatever the install's single org is", async () => {
    const orgs = store();
    const owned = await orgs.createOrgWithOwner({ name: "Maya's team", developerId: "a".repeat(64) });
    expect(await resolveOrgOnSignIn({ orgs, singleOrgId: TEST_ORG }, input("a".repeat(64)))).toEqual({ orgId: owned, role: "owner" });
  });

  it("refuses with CONFIG_INVALID when the install has no single org and the person has none", async () => {
    await expect(resolveOrgOnSignIn({ orgs: store() }, input("a".repeat(64)))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("returns the membership a concurrent sign-in of the same person created", async () => {
    const real = store();
    const racing = {
      orgForDeveloper: (async (developerId: string) => (reads++ === 0 ? undefined : real.orgForDeveloper(developerId))) as OrgStore["orgForDeveloper"],
      ensureOrg: real.ensureOrg.bind(real),
      developerForVerifiedEmail: real.developerForVerifiedEmail.bind(real),
      createOrgWithOwner: real.createOrgWithOwner.bind(real),
      acceptInvite: real.acceptInvite.bind(real),
      peekInvite: real.peekInvite.bind(real),
      isBanned: real.isBanned.bind(real),
      addMember: (async () => { throw agentXError("ALREADY_IN_ORG", "this developer already belongs to an organization"); }) as OrgStore["addMember"],
    };
    let reads = 0;
    await real.ensureOrg(TEST_ORG, TEST_ENV);
    await real.addMember({ orgId: TEST_ORG, developerId: "a".repeat(64), role: "member" });
    expect(await resolveOrgOnSignIn({ orgs: racing, singleOrgId: TEST_ORG }, input("a".repeat(64)))).toEqual({ orgId: TEST_ORG, role: "member" });
  });
});

describe("the sign-in server's tokens carry the org", () => {
  it("puts a first sign-in in the install's single org and issues org and org_role claims", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const body = await signedIn(h);
    expect(claimsOf(body.access_token)).toMatchObject({ sub: mayaId, org: TEST_ORG, org_role: "member" });
    expect(h.state.get(orgMetaKey(TEST_ORG).pk, "META")).toMatchObject({ orgId: TEST_ORG, name: "staging" });
    expect(h.state.get(orgMemberKey(TEST_ORG, mayaId).pk, orgMemberKey(TEST_ORG, mayaId).sk)).toMatchObject({ role: "member" });
    expect(h.state.get(developerOrgKey(mayaId).pk, "ORG")).toMatchObject({ orgId: TEST_ORG, role: "member" });
  });

  it("carries the org into the access token a refresh issues, reading the membership again", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const refreshed = await h.refresh(String((await signedIn(h)).refresh_token));
    expect(refreshed.status).toBe(200);
    expect(claimsOf(refreshed.body.access_token)).toMatchObject({ org: TEST_ORG, org_role: "member" });
    // A promotion made since is in the next token.
    h.state.set({ ...h.state.get(developerOrgKey(mayaId).pk, "ORG")!, role: "admin" });
    const promoted = await h.refresh(String(refreshed.body.refresh_token));
    expect(claimsOf(promoted.body.access_token)).toMatchObject({ org: TEST_ORG, org_role: "admin" });
  });

  it("refuses a refresh once the developer has no org, and ends the session", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const body = await signedIn(h);
    h.state.delete(developerOrgKey(mayaId).pk, "ORG");
    const refused = await h.refresh(String(body.refresh_token));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "invalid_grant" });
    expect((await h.refresh(String(body.refresh_token))).status).toBe(400);
  });

  it("refuses a first sign-in with CONFIG_INVALID's answer when the install has no org to join", async () => {
    const h = identityHarness({ slackUsers: [maya], singleOrg: false });
    const location = await h.signIn("slack", maya.userId);
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBeTruthy();
  });
});
