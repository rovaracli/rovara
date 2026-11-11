// Rovara Code (Plan 6 Task 14): which member of an org a GitHub account is. One account to one member, both ways, in one transaction, per org; written when a member signs
// in with GitHub, removed when they unlink it, and filled in for earlier sign-ins by the first tracking pass of the org.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubMemberKey, memberGithubKey } from "@rovara-code/contracts";
import { backfillGithubMembers, githubUserOfMember, linkGithubMember, memberForGithubUser, unlinkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as typeof TEST_ORG;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const world = () => { const db = new FakeDynamoDb(); return { db, deps: { documentClient: db, tableName: "state", now: () => NOW } }; };

describe("the link between a GitHub account and a member", () => {
  it("is written both ways and read back, and a repeat of the same link changes nothing", async () => {
    const { db, deps } = world();
    expect(await linkGithubMember(deps, TEST_ORG, "dev-1", "4711")).toBe("linked");
    expect(await linkGithubMember(deps, TEST_ORG, "dev-1", "4711")).toBe("linked");
    expect(await memberForGithubUser(deps, TEST_ORG, "4711")).toBe("dev-1");
    expect(await githubUserOfMember(deps, TEST_ORG, "dev-1")).toBe("4711");
    expect(db.get(githubMemberKey(TEST_ORG, "4711"))).toMatchObject({ orgId: TEST_ORG, developerId: "dev-1", githubUserId: "4711" });
    expect(db.get(memberGithubKey(TEST_ORG, "dev-1"))).toMatchObject({ orgId: TEST_ORG, developerId: "dev-1", githubUserId: "4711" });
  });

  it("does not move an account to another member, or a member to another account (the first link stands), and writes neither half", async () => {
    const { db, deps } = world();
    await linkGithubMember(deps, TEST_ORG, "dev-1", "4711");
    expect(await linkGithubMember(deps, TEST_ORG, "dev-2", "4711")).toBe("taken");
    expect(await linkGithubMember(deps, TEST_ORG, "dev-1", "9999")).toBe("taken");
    expect(await memberForGithubUser(deps, TEST_ORG, "4711")).toBe("dev-1");
    expect(db.get(memberGithubKey(TEST_ORG, "dev-2"))).toBeUndefined();
    expect(db.get(githubMemberKey(TEST_ORG, "9999"))).toBeUndefined();
  });

  it("is per org: another org does not see it, and may link the same account to its own member", async () => {
    const { deps } = world();
    await linkGithubMember(deps, TEST_ORG, "dev-1", "4711");
    expect(await memberForGithubUser(deps, OTHER_ORG, "4711")).toBeUndefined();
    expect(await githubUserOfMember(deps, OTHER_ORG, "dev-1")).toBeUndefined();
    expect(await linkGithubMember(deps, OTHER_ORG, "dev-9", "4711")).toBe("linked");
    expect(await memberForGithubUser(deps, TEST_ORG, "4711")).toBe("dev-1");
  });

  it("reads an item that does not name this org or this account as no link, and refuses an account id that is not one", async () => {
    const { db, deps } = world();
    db.set({ ...githubMemberKey(TEST_ORG, "4711"), orgId: OTHER_ORG, githubUserId: "4711", developerId: "dev-1" });
    expect(await memberForGithubUser(deps, TEST_ORG, "4711")).toBeUndefined();
    db.set({ ...githubMemberKey(TEST_ORG, "5"), orgId: TEST_ORG, githubUserId: "6", developerId: "dev-1" });
    expect(await memberForGithubUser(deps, TEST_ORG, "5")).toBeUndefined();
    expect(await memberForGithubUser(deps, TEST_ORG, "not-a-number")).toBeUndefined();
    await expect(linkGithubMember(deps, TEST_ORG, "dev-1", "x#y")).rejects.toThrow();
  });

  it("is removed both ways by an unlink, and an unlink of a member with no link removes nothing", async () => {
    const { db, deps } = world();
    await linkGithubMember(deps, TEST_ORG, "dev-1", "4711");
    expect(await unlinkGithubMember(deps, TEST_ORG, "dev-1")).toBe(true);
    expect(db.get(githubMemberKey(TEST_ORG, "4711"))).toBeUndefined();
    expect(db.get(memberGithubKey(TEST_ORG, "dev-1"))).toBeUndefined();
    expect(await unlinkGithubMember(deps, TEST_ORG, "dev-1")).toBe(false);
    // An account another member holds is not removed by this member's unlink.
    await linkGithubMember(deps, TEST_ORG, "dev-2", "4711");
    db.set({ ...memberGithubKey(TEST_ORG, "dev-1"), entityType: "MEMBER_GITHUB", orgId: TEST_ORG, developerId: "dev-1", githubUserId: "4711" });
    expect(await unlinkGithubMember(deps, TEST_ORG, "dev-1")).toBe(false);
    expect(await memberForGithubUser(deps, TEST_ORG, "4711")).toBe("dev-2");
  });
});

describe("the first tracking pass of an org links earlier sign-ins", () => {
  it("links every member with a GitHub sign-in once, and does not run again", async () => {
    const { deps } = world();
    const members = vi.fn(async () => [{ developerId: "dev-1", githubUserId: "11" }, { developerId: "dev-2", githubUserId: "22" }, { developerId: "dev-3", githubUserId: "bad id" }]);
    expect(await backfillGithubMembers(deps, TEST_ORG, members)).toBe(2);
    expect(await memberForGithubUser(deps, TEST_ORG, "22")).toBe("dev-2");
    expect(await backfillGithubMembers(deps, TEST_ORG, members)).toBe(0);
    expect(members).toHaveBeenCalledTimes(1);
    // Another org has its own first pass.
    expect(await backfillGithubMembers(deps, OTHER_ORG, async () => [{ developerId: "dev-1", githubUserId: "11" }])).toBe(1);
  });

  it("leaves a member whose account is held by another as not linked, and counts only the links it made", async () => {
    const { deps } = world();
    await linkGithubMember(deps, TEST_ORG, "dev-1", "11");
    expect(await backfillGithubMembers(deps, TEST_ORG, async () => [{ developerId: "dev-2", githubUserId: "11" }, { developerId: "dev-3", githubUserId: "33" }])).toBe(1);
    expect(await memberForGithubUser(deps, TEST_ORG, "11")).toBe("dev-1");
  });

  it("is not marked done when the member list could not be read, so the next pass tries again", async () => {
    const { db, deps } = world();
    await expect(backfillGithubMembers(deps, TEST_ORG, async () => { throw new Error("sign-in table unavailable"); })).rejects.toThrow();
    expect(db.find((item) => item.entityType === "GITHUB_MEMBER_BACKFILL")).toEqual([]);
    expect(await backfillGithubMembers(deps, TEST_ORG, async () => [{ developerId: "dev-1", githubUserId: "11" }])).toBe(1);
  });
});

describe("the sign-in server tells the org", () => {
  const T0 = Date.parse("2026-09-27T12:00:00.000Z");
  const priya: FakeOidcUser = { sub: "priya-cloud-1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
  const octo: FakeGithubUser = { id: 4711, login: "octo", name: "Priya R.", emails: [{ email: "priya@acme.dev", primary: true, verified: true }] };
  const cloudId = ownerKeyForSubject("https://idp.example.test", priya.sub);
  beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const claimsOf = (token: unknown) => JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const signIn = async (h: ReturnType<typeof identityHarness>, method: "cloud" | "github", who: string) => {
    const code = (await h.signIn(method, who)).searchParams.get("code")!;
    const exchanged = await h.exchange(code);
    return claimsOf(exchanged.body.access_token);
  };

  it("hands a GitHub sign-in's org, account and developer to the hook, and an unlink's org and developer to the other", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const signedIn = vi.fn(async () => undefined);
    const unlinked = vi.fn(async () => undefined);
    h.deps.onGithubSignIn = signedIn;
    h.deps.onGithubUnlinked = unlinked;
    const cloud = await signIn(h, "cloud", priya.sub);
    expect(signedIn).not.toHaveBeenCalled();
    await signIn(h, "github", "4711");
    expect(signedIn).toHaveBeenCalledWith({ orgId: cloud.org, githubUserId: "4711", developerId: cloudId });
    const answer = await h.handler({ kind: "unlink-identity", developerId: cloudId, sessionId: String(cloud.sid), provider: "github" } as never);
    expect(answer).toEqual({ ok: true });
    expect(unlinked).toHaveBeenCalledWith({ orgId: cloud.org, developerId: cloudId });
  });

  it("does not tell the org about the unlink of another method, or of a method that was refused, and never fails the unlink for the hook", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const unlinked = vi.fn(async () => { throw new Error("table down"); });
    h.deps.onGithubUnlinked = unlinked;
    const cloud = await signIn(h, "cloud", priya.sub);
    await signIn(h, "github", "4711");
    // The account's own sign-in cannot be removed: refused, the hook is not called.
    const refused = await h.handler({ kind: "unlink-identity", developerId: cloudId, sessionId: String(cloud.sid), provider: "cloud" } as never);
    expect(refused).toMatchObject({ ok: false });
    expect(unlinked).not.toHaveBeenCalled();
    const answer = await h.handler({ kind: "unlink-identity", developerId: cloudId, sessionId: String(cloud.sid), provider: "github" } as never);
    expect(answer).toEqual({ ok: true });
    expect(unlinked).toHaveBeenCalledTimes(1);
    expect(h.logs.some((entry) => entry.event === "signin.github_member_unlink_failed")).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain("table down");
  });

  it("knows a developer's GitHub account from the sign-in store, and only that one", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    await signIn(h, "cloud", priya.sub);
    const store = new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: () => T0 });
    expect(await store.githubUserIdOf(cloudId)).toBeUndefined();
    await signIn(h, "github", "4711");
    expect(await store.githubUserIdOf(cloudId)).toBe("4711");
    expect(await store.githubUserIdOf("0".repeat(64))).toBeUndefined();
  });
});
