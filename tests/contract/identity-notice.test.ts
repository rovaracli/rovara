// Plan 2, Task 8: a notice for each new sign-in method, and unlinking one. The email goes to the account's address when a second sign-in
// route is linked to it; a person can remove that route (agentx signin unlink), which ends its sessions and nothing else.
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlinkIdentityRequest } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { IDENTITY_NOTICE_SUBJECT, sendIdentityLinkedNotice } from "../../packages/broker/src/developer/identity-notice.js";
import { UNLINK_FIRST_IDENTITY, UNLINK_ONLY_IDENTITY, DeveloperSignInStore, developerIdentityKey, endedByUnlink, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { ISSUER, identityHarness, type FakeGithubUser, type FakeOidcUser } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const FROM = "Rovara <signin@rovara.dev>";
const CELL = "https://rovara.dev";
const priya: FakeOidcUser = { sub: "priya-cloud-1", name: "Priya Rao", email: "priya@acme.dev", email_verified: true };
const octo: FakeGithubUser = { id: 4711, login: "octo", name: "Priya R.", emails: [{ email: "priya@acme.dev", primary: true, verified: true }] };
const cloudId = ownerKeyForSubject(OIDC_ISSUER, priya.sub);
const githubId = ownerKeyForSubject(GITHUB_ISSUER, "4711");

type Harness = ReturnType<typeof identityHarness>;
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

/** A fake SES client that records the commands it was sent, and can be told to fail. */
function fakeSes(failWith?: Error) {
  const sent: SendEmailCommand[] = [];
  return {
    sent,
    client: {
      send: vi.fn(async (command: unknown) => {
        if (failWith !== undefined) throw failWith;
        sent.push(command as SendEmailCommand);
        return { MessageId: "m-1" };
      }),
    } as never,
  };
}

async function signIn(h: Harness, method: "cloud" | "github", who: string): Promise<{ claims: Record<string, unknown>; token: string; refresh: string; location: URL }> {
  const location = await h.signIn(method, who);
  const code = location.searchParams.get("code");
  if (code === null) return { claims: {}, token: "", refresh: "", location };
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return { claims: claimsOf(exchanged.body.access_token), token: String(exchanged.body.access_token), refresh: String(exchanged.body.refresh_token), location };
}

beforeEach(() => { vi.useFakeTimers({ now: T0, toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });

/** The broker over a copy of the harness's tables; `unlinkIdentity` is the harness's own sign-in function, as the Lambda invoke would be. */
async function brokerCall(h: Harness, method: string, path: string, token: string, extra: { body?: unknown; unlinkIdentity?: DeveloperApiConfiguration["unlinkIdentity"] | null } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const broker: { db?: FakeDynamoDb } = {};
  const copied = new Set<string>();
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true, cloud: true, github: true }, signInTableName: "signin",
    channelMembers: async () => ({ ok: true as const, memberOf: [] }),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await h.signer.publicJwk()], now: () => Date.now() }),
    // The sign-in function writes the harness's table; the broker's copy of it is brought up to date after the invoke, as the one real table is.
    ...(extra.unlinkIdentity === null ? {} : { unlinkIdentity: extra.unlinkIdentity ?? (async (request: UnlinkIdentityRequest) => {
      const answer = await h.handler(request) as never;
      for (const [key, item] of [...h.db.items]) if (JSON.stringify(broker.db?.items.get(key)) !== JSON.stringify(item)) broker.db?.set(structuredClone(item));
      for (const key of copied) if (!h.db.items.has(key)) { const [pk, sk] = key.split("\u0000") as [string, string]; broker.db?.delete(pk, sk); }
      return answer;
    }) }),
  };
  const { db, handler } = await createAdminBroker({ developer: config });
  broker.db = db;
  for (const source of [h.db, h.state]) for (const item of source.items.values()) db.set(structuredClone(item));
  for (const key of h.db.items.keys()) copied.add(key);
  const response = await handler({
    rawPath: path, headers: { authorization: `Bearer ${token}` }, routeKey: "ANY /v1/app/{proxy+}",
    ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
    requestContext: { requestId: "r", http: { method } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

const emailsSent = (ses: ReturnType<typeof fakeSes>) => ses.sent.map((command) => command.input);

describe("the notice of a newly linked sign-in method", () => {
  it("a GitHub sign-in that links to an existing account emails that account's address, once, with the exact words", async () => {
    const ses = fakeSes();
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] }, notice: { ses: ses.client, from: FROM, cellUrl: CELL } });
    await signIn(h, "cloud", priya.sub);
    expect(emailsSent(ses)).toEqual([]);
    await signIn(h, "github", "4711");
    const [email] = emailsSent(ses);
    expect(emailsSent(ses)).toHaveLength(1);
    expect(email!.FromEmailAddress).toBe(FROM);
    expect(email!.Destination).toEqual({ ToAddresses: ["priya@acme.dev"] });
    expect(email!.Content!.Simple!.Subject!.Data).toBe("A new way to sign in to your Rovara account");
    expect(IDENTITY_NOTICE_SUBJECT).toBe("A new way to sign in to your Rovara account");
    const sentence = "GitHub account octo can now sign in to your Rovara account. If this was you, there is nothing to do. "
      + "If it wasn't, remove it now: run agentx signin unlink github, or sign in at https://rovara.dev and remove it from your account.";
    expect(email!.Content!.Simple!.Body!.Text!.Data).toBe(sentence);
    expect(email!.Content!.Simple!.Body!.Html!.Data).toBe(`<p>${sentence.replace("wasn't", "wasn&#39;t")}</p>`);
    // The log names the provider and nothing about the person.
    expect(h.logs.filter((entry) => entry.event === "signin.identity_linked")).toEqual([{ event: "signin.identity_linked", provider: "github" }]);
  });

  it("an email-code sign-in linked to a GitHub account is called Email code, with no login", async () => {
    const ses = fakeSes();
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] }, notice: { ses: ses.client, from: FROM, cellUrl: CELL } });
    await signIn(h, "github", "4711");
    await signIn(h, "cloud", priya.sub);
    const [email] = emailsSent(ses);
    expect(emailsSent(ses)).toHaveLength(1);
    expect(email!.Content!.Simple!.Body!.Text!.Data).toMatch(/^Email code account can now sign in to your Rovara account\. /);
    expect(email!.Content!.Simple!.Body!.Text!.Data).toContain("run agentx signin unlink cloud,");
  });

  it("sends nothing for a first sign-in (new-self) or a return visit (existing)", async () => {
    const ses = fakeSes();
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] }, notice: { ses: ses.client, from: FROM, cellUrl: CELL } });
    await signIn(h, "cloud", priya.sub);
    await signIn(h, "cloud", priya.sub);
    expect(emailsSent(ses)).toEqual([]);
    await signIn(h, "github", "4711");
    await signIn(h, "github", "4711");
    await signIn(h, "cloud", priya.sub);
    expect(emailsSent(ses)).toHaveLength(1);
  });

  it("a send that fails never fails the sign-in, and the failure is logged without the address or the login", async () => {
    const ses = fakeSes(Object.assign(new Error("MessageRejected: priya@acme.dev octo"), { name: "MessageRejected" }));
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] }, notice: { ses: ses.client, from: FROM, cellUrl: CELL } });
    await signIn(h, "cloud", priya.sub);
    const second = await signIn(h, "github", "4711");
    expect(second.location.searchParams.get("error")).toBeNull();
    expect(second.claims).toMatchObject({ sub: cloudId, amr: "github" });
    expect(h.logs.filter((entry) => String(entry.event).startsWith("signin.identity_link_notice"))).toEqual([{ event: "signin.identity_link_notice_failed", provider: "github", error: "MessageRejected" }]);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain("priya@acme.dev");
    expect(logged).not.toContain("octo");
  });

  it("with no sender configured nothing is sent and the skip is logged", async () => {
    const ses = fakeSes();
    for (const notice of [{ ses: ses.client, from: undefined, cellUrl: CELL }, { ses: ses.client, from: "", cellUrl: CELL }, undefined]) {
      const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] }, ...(notice === undefined ? {} : { notice }) });
      await signIn(h, "cloud", priya.sub);
      const second = await signIn(h, "github", "4711");
      expect(second.claims).toMatchObject({ sub: cloudId });
      expect(h.logs.filter((entry) => String(entry.event).startsWith("signin.identity_link_notice"))).toEqual([{ event: "signin.identity_link_notice_skipped", provider: "github", reason: "no_sender" }]);
    }
    expect(ses.sent).toEqual([]);
  });

  it("sendIdentityLinkedNotice leaves out a login that is not a GitHub login, and escapes what it quotes", async () => {
    const ses = fakeSes();
    const log = vi.fn();
    const sent = await sendIdentityLinkedNotice({ ses: ses.client, from: FROM, log }, { to: "a@b.dev", provider: "github", login: "x<script>\r\nBcc: z", cellUrl: "https://rovara.dev/?a=1&b=2" });
    expect(sent).toBe("sent");
    const body = emailsSent(ses)[0]!.Content!.Simple!.Body!;
    expect(body.Text!.Data).toMatch(/^GitHub account can now sign in/);
    expect(body.Text!.Data).not.toContain("<script>");
    expect(body.Html!.Data).toContain("https://rovara.dev/?a=1&amp;b=2");
    expect(log).toHaveBeenCalledWith({ event: "signin.identity_linked", provider: "github" });
  });

  it("sendIdentityLinkedNotice with no SES client or sender is skipped", async () => {
    const log = vi.fn();
    expect(await sendIdentityLinkedNotice({ ses: undefined, from: FROM, log }, { to: "a@b.dev", provider: "cloud", cellUrl: CELL })).toBe("skipped");
    expect(log).toHaveBeenCalledWith({ event: "signin.identity_link_notice_skipped", provider: "cloud", reason: "no_sender" });
  });
});

describe("unlinking a sign-in method", () => {
  it("ends the unlinked method's sessions and only those; the next sign-in with it starts its own developer", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const cloud = await signIn(h, "cloud", priya.sub);
    const github = await signIn(h, "github", "4711");
    expect(github.claims).toMatchObject({ sub: cloudId, amr: "github" });
    expect((await brokerCall(h, "GET", "/v1/app/me", github.token)).status).toBe(200);

    h.tick(1000);
    const removed = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", github.token);
    expect(removed.status).toBe(200);
    expect((removed.body.identities as Array<{ provider: string }>).map((identity) => identity.provider)).toEqual(["cloud"]);

    // The GitHub session is refused at once; the cloud session keeps working.
    const refused = await brokerCall(h, "GET", "/v1/app/me", github.token);
    expect(refused.status).toBe(401);
    expect(String((refused.body.error as { message: string }).message)).toContain("this sign-in method was removed from your account");
    expect((await brokerCall(h, "GET", "/v1/app/me", cloud.token)).status).toBe(200);
    // Its refresh token no longer works; the cloud one does.
    expect((await h.refresh(github.refresh)).status).toBe(400);
    expect((await h.refresh(cloud.refresh)).status).toBe(200);
    expect(h.logs).toContainEqual({ event: "signin.identity_unlinked", developerId: cloudId, provider: "github" });

    // The items: the reverse item is gone, the forward item remembers where it came from.
    expect(h.db.get(developerIdentityKey(cloudId, githubId))).toBeUndefined();
    expect(h.db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: cloudId, provider: "github", unlinkedFrom: cloudId, unlinkedAt: new Date(T0 + 1000).toISOString() });

    // The same GitHub account, same verified email, signs in again: a separate developer, never relinked.
    h.tick(1000);
    const again = await signIn(h, "github", "4711");
    expect(again.claims.sub).toBe(githubId);
    expect(again.claims.sub).not.toBe(cloudId);
    expect(h.db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: githubId, unlinkedFrom: cloudId });
    expect(h.db.get(developerIdentityKey(cloudId, githubId))).toBeUndefined();
    expect((await brokerCall(h, "GET", "/v1/app/me", again.token)).status).toBe(200);
    // And that new session is not caught by the old developer's mark.
    expect((await brokerCall(h, "GET", "/v1/app/me", cloud.token)).status).toBe(200);
  });

  it("a sign-in code issued before the unlink cannot start a session after it", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    await signIn(h, "cloud", priya.sub);
    const location = await h.signIn("github", "4711");
    const code = location.searchParams.get("code")!;
    expect(code).not.toBeNull();
    expect(await h.handler({ kind: "unlink-identity", developerId: cloudId, provider: "github" })).toEqual({ ok: true });
    const exchanged = await h.exchange(code);
    expect(exchanged.status).toBe(400);
    expect(exchanged.body.error).toBe("invalid_grant");
    expect(h.db.find((item) => item.entityType === "SESSION" && item.amr === "github")).toEqual([]);
  });

  it("refuses the only way to sign in, and the sign-in the account was created with, in exact words", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const cloud = await signIn(h, "cloud", priya.sub);
    // Only one method is linked.
    const only = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", cloud.token);
    expect(only.status).toBe(400);
    expect((only.body.error as { message: string }).message).toBe(UNLINK_ONLY_IDENTITY);
    expect(UNLINK_ONLY_IDENTITY).toBe("this is your only way to sign in, so it can't be removed");
    // Two are linked, but the first one is the account's own.
    await signIn(h, "github", "4711");
    const first = await brokerCall(h, "DELETE", "/v1/app/me/identities/cloud", cloud.token);
    expect(first.status).toBe(400);
    expect((first.body.error as { message: string }).message).toBe(UNLINK_FIRST_IDENTITY);
    expect(UNLINK_FIRST_IDENTITY).toBe("this is the sign-in your account was created with, so it can't be removed");
    // Nothing changed, and nothing was marked.
    expect(h.db.get(developerIdentityKey(cloudId, cloudId))).toBeDefined();
    expect(Object.keys(h.db.get(`DEVELOPER#${cloudId}`, "META") ?? {}).filter((key) => key.startsWith("sessionsEndedBy"))).toEqual([]);
    expect((await brokerCall(h, "GET", "/v1/app/me", cloud.token)).status).toBe(200);
  });

  it("answers not-found for a method that is not linked, and 400 for one that cannot be unlinked", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    const cloud = await signIn(h, "cloud", priya.sub);
    const missing = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", cloud.token);
    expect(missing.status).toBe(404);
    expect((missing.body.error as { message: string }).message).toContain("that sign-in method is not linked to your account");
    const slack = await brokerCall(h, "DELETE", "/v1/app/me/identities/slack", cloud.token);
    expect(slack.status).toBe(400);
    expect((slack.body.error as { message: string }).message).toContain("cloud or github");
    const notSetUp = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", cloud.token, { unlinkIdentity: null });
    expect(notSetUp.status).toBe(404);
  });

  it("the route passes the session's developer to the invoke, never a body value, and answers what is left", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    await signIn(h, "cloud", priya.sub);
    const github = await signIn(h, "github", "4711");
    const unlinkIdentity = vi.fn(async (request: UnlinkIdentityRequest) => await h.handler(request) as never);
    const other = "f".repeat(64);
    const answer = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", github.token, { body: { developerId: other, provider: "cloud", kind: "end-developer-sessions" }, unlinkIdentity });
    expect(answer.status).toBe(200);
    expect(unlinkIdentity).toHaveBeenCalledTimes(1);
    expect(unlinkIdentity).toHaveBeenCalledWith({ kind: "unlink-identity", developerId: cloudId, provider: "github" });
    expect(JSON.stringify(answer.body)).not.toMatch(/issuer|subject/);
  });

  it("the route reports an invoke that did not complete as unavailable", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya], github: { users: [octo] } });
    await signIn(h, "cloud", priya.sub);
    const github = await signIn(h, "github", "4711");
    const down = await brokerCall(h, "DELETE", "/v1/app/me/identities/github", github.token, { unlinkIdentity: async () => ({ ok: false, error: "unavailable" }) });
    expect(down.status).toBe(503);
  });

  it("the sign-in function refuses a request that is not one", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [priya] });
    expect(await h.handler({ kind: "unlink-identity", developerId: "nope", provider: "github" } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await h.handler({ kind: "unlink-identity", developerId: cloudId, provider: "slack" } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await h.handler({ kind: "unlink-identity", developerId: cloudId, provider: "github", extra: 1 } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await h.handler({ kind: "unlink-identity", developerId: cloudId, provider: "github" })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("DeveloperSignInStore.unlinkIdentity", () => {
  const body = (provider: "cloud" | "github", issuer: string, subject: string, at: string) => ({ entityType: "IDENTITY_LINK", provider, issuer, subject, linkedAt: at, lastSignInAt: at });
  function setup() {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => T0 + 5000 });
    db.set({ pk: `DEVELOPER#${cloudId}`, sk: "META", entityType: "DEVELOPER", developerId: cloudId, provider: "cloud", issuer: OIDC_ISSUER, subject: priya.sub, displayName: "Priya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    for (const [key, link] of [[cloudId, body("cloud", OIDC_ISSUER, priya.sub, "2026-09-01T00:00:00.000Z")], [githubId, body("github", GITHUB_ISSUER, "4711", "2026-09-02T00:00:00.000Z")]] as const) {
      db.set({ ...signInIdentityKey(key), developerId: cloudId, ...link });
      db.set({ ...developerIdentityKey(cloudId, key), developerId: cloudId, ...link });
    }
    return { db, store };
  }

  it("deletes the reverse item, tombstones the forward item, and marks the developer for that identity and method, in one transaction", async () => {
    const { db, store } = setup();
    expect(await store.unlinkIdentity({ developerId: cloudId, provider: "github" })).toEqual({ identityKey: githubId });
    const at = new Date(T0 + 5000).toISOString();
    expect(db.get(developerIdentityKey(cloudId, githubId))).toBeUndefined();
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", unlinkedFrom: cloudId, unlinkedAt: at });
    expect(db.get(`DEVELOPER#${cloudId}`, "META")).toMatchObject({ [`sessionsEndedByIdentity#${githubId}`]: at, "sessionsEndedByMethod#github": at });
    expect(db.get(`DEVELOPER#${cloudId}`, "META")).not.toHaveProperty("sessionsEndedAt");
    expect((await store.identitiesOf(cloudId)).map((identity) => identity.provider)).toEqual(["cloud"]);
    // The first identity is untouched.
    expect(db.get(developerIdentityKey(cloudId, cloudId))).toBeDefined();
    expect(db.get(signInIdentityKey(cloudId))).not.toHaveProperty("unlinkedFrom");
  });

  it("endedByUnlink: a session of the unlinked identity that started before the mark is ended; a later one, another identity's, and a legacy one of another method are not", async () => {
    const { db, store } = setup();
    await store.unlinkIdentity({ developerId: cloudId, provider: "github" });
    const developer = db.get(`DEVELOPER#${cloudId}`, "META")!;
    const before = new Date(T0).toISOString();
    const after = new Date(T0 + 6000).toISOString();
    expect(endedByUnlink({ startedAt: before, amr: "github", identityKey: githubId }, developer)).toBe(true);
    expect(endedByUnlink({ startedAt: after, amr: "github", identityKey: githubId }, developer)).toBe(false);
    expect(endedByUnlink({ startedAt: before, amr: "cloud", identityKey: cloudId }, developer)).toBe(false);
    // A session from before sessions recorded an identity is matched by its method.
    expect(endedByUnlink({ startedAt: before, amr: "github" }, developer)).toBe(true);
    expect(endedByUnlink({ startedAt: before, amr: "cloud" }, developer)).toBe(false);
  });

  it("unlinks every identity of a method when two are linked, and keeps the others", async () => {
    const { db, store } = setup();
    const second = ownerKeyForSubject(GITHUB_ISSUER, "9001");
    const link = body("github", GITHUB_ISSUER, "9001", "2026-09-03T00:00:00.000Z");
    db.set({ ...signInIdentityKey(second), developerId: cloudId, ...link });
    db.set({ ...developerIdentityKey(cloudId, second), developerId: cloudId, ...link });
    await store.unlinkIdentity({ developerId: cloudId, provider: "github" });
    expect((await store.identitiesOf(cloudId)).map((identity) => identity.provider)).toEqual(["cloud"]);
    expect(db.get(signInIdentityKey(second))).toHaveProperty("unlinkedFrom", cloudId);
    expect(db.get(signInIdentityKey(githubId))).toHaveProperty("unlinkedFrom", cloudId);
  });

  it("never touches another developer's identity: a method this developer does not have is not found", async () => {
    const { db, store } = setup();
    const stranger = "e".repeat(64);
    db.set({ pk: `DEVELOPER#${stranger}`, sk: "META", entityType: "DEVELOPER", developerId: stranger, provider: "cloud", issuer: "i", subject: "s", displayName: "S", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await expect(store.unlinkIdentity({ developerId: stranger, provider: "github" })).rejects.toThrow("not linked");
    expect(db.get(developerIdentityKey(cloudId, githubId))).toBeDefined();
    expect(db.get(signInIdentityKey(githubId))).not.toHaveProperty("unlinkedFrom");
  });

  it("a race: when the link changed between the read and the transaction, nothing is half done", async () => {
    const { db, store } = setup();
    let raced = false;
    db.injectFault({
      command: "TransactWriteCommand",
      match: () => {
        if (raced) return false;
        raced = true;
        // Another unlink lands first.
        db.set({ ...signInIdentityKey(githubId), developerId: cloudId, unlinkedFrom: cloudId, unlinkedAt: "y", provider: "github", issuer: GITHUB_ISSUER, subject: "4711", linkedAt: "x", lastSignInAt: "x" });
        return false;
      },
      error: { name: "TransactionCanceledException" },
    });
    await expect(store.unlinkIdentity({ developerId: cloudId, provider: "github" })).rejects.toThrow("changed while this ran");
    expect(db.get(`DEVELOPER#${cloudId}`, "META")).not.toHaveProperty("sessionsEndedByMethod#github");
  });
});
