// Linear writes for Ask (lane ask-linear, LA-1): Rovara posts an Ask's answer on the Linear issue through the org's EXISTING Linear connection (the saved API key of `OrgConnectionStore`), by Linear's
// GraphQL address only. Held here: only a connection that may write (`read_write`) and holds a secret is used (a service identity first); the comment id is made from a stable key, so a retry of the same
// post is the same comment; what is edited or deleted is only a comment Rovara's own account wrote; the key never appears in a thrown error; the workspace the binding names is the workspace written to.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrgConnectionStore, LINEAR_GRAPHQL, connectionActorIds, connectionWorkspaceKeys } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { linearCommentIdFor, linearWriteOf, LINEAR_COMMENT_MAX_CHARS } from "../../packages/broker/src/rovara-code/linear-write.js";
import type { OrgId } from "../../packages/contracts/src/org-node.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const CON_1 = "con_aaaaaaaaaaaaaaaaaaaa";
const CON_2 = "con_bbbbbbbbbbbbbbbbbbbb";
const KEY_1 = "lin_api_ONE_SECRET_0123456789";
const KEY_2 = "lin_api_TWO_SECRET_0123456789";
const ROVARA = "linear-user-rovara";
const PERSON = "linear-user-person";

/** A Linear that holds issues and comments, enforces the key, and dedupes a comment by the id the client chose. */
function fakeLinear(options: { workspace?: string; viewer?: string; issueKey?: string; failCreateOnce?: boolean } = {}) {
  const workspace = options.workspace ?? "acme";
  const issueKey = options.issueKey ?? "ENG-142";
  const comments = new Map<string, { id: string; body: string; userId: string; issue: string }>([["person-comment-1", { id: "person-comment-1", body: "a person wrote this", userId: PERSON, issue: issueKey }]]);
  const calls: Array<{ url: string; auth: string | null; query: string; variables: Record<string, unknown>; redirect: unknown }> = [];
  let failed = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query: string; variables: Record<string, unknown> };
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), auth: headers["authorization"] ?? null, query: body.query, variables: body.variables ?? {}, redirect: init?.redirect });
    const json = (data: unknown, errors?: unknown) => new Response(JSON.stringify({ data, ...(errors === undefined ? {} : { errors }) }), { status: 200 });
    const v = body.variables ?? {};
    if (/viewer/u.test(body.query)) return json({ viewer: { id: options.viewer ?? ROVARA, organization: { urlKey: workspace } } });
    if (/commentCreate/u.test(body.query)) {
      const input = v["input"] as { id: string; issueId: string; body: string };
      if (options.failCreateOnce === true && !failed) { failed = true; comments.set(input.id, { id: input.id, body: input.body, userId: options.viewer ?? ROVARA, issue: issueKey }); return json(null, [{ message: "network lost after the write" }]); }
      if (comments.has(input.id)) return json(null, [{ message: "Entity already exists" }]);
      comments.set(input.id, { id: input.id, body: input.body, userId: options.viewer ?? ROVARA, issue: issueKey });
      return json({ commentCreate: { success: true, comment: { id: input.id } } });
    }
    if (/commentUpdate/u.test(body.query)) {
      const found = comments.get(String(v["id"]));
      if (found === undefined) return json(null, [{ message: "not found" }]);
      found.body = (v["input"] as { body: string }).body;
      return json({ commentUpdate: { success: true } });
    }
    if (/commentDelete/u.test(body.query)) { comments.delete(String(v["id"])); return json({ commentDelete: { success: true } }); }
    if (/comment\(id/u.test(body.query)) {
      const found = comments.get(String(v["id"]));
      return json({ comment: found === undefined ? null : { id: found.id, user: { id: found.userId }, issue: { identifier: found.issue } } });
    }
    if (/issue\(id/u.test(body.query)) {
      return json({ issue: String(v["id"]).toUpperCase() === issueKey ? { id: "issue-uuid-1", identifier: issueKey, url: `https://linear.app/${workspace}/issue/${issueKey}/the-title` } : null });
    }
    return json(null, [{ message: "unknown" }]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, comments, mutations: () => calls.filter((call) => /mutation/u.test(call.query)) };
}

async function world(connections: Array<{ id: string; key: string; access?: "read" | "read_write"; identity?: "service" | "personal"; linear: ReturnType<typeof fakeLinear> }>, orgId: OrgId = ORG_A) {
  const clock = { now: Date.parse("2026-11-02T09:00:00.000Z") };
  const fake = new FakeOrgSecrets({ env: ENV, now: () => clock.now });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => clock.now });
  const deps = { documentClient: db, tableName: "T", env: ENV, secrets, now: () => clock.now };
  // One fetch for the whole install: each fake Linear answers for the key that belongs to it.
  const byKey = new Map(connections.map((connection) => [connection.key, connection.linear]));
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)["authorization"];
    const linear = byKey.get(auth ?? "");
    if (linear === undefined) return new Response("{}", { status: 401 });
    return linear.fetchImpl(url, init);
  }) as unknown as typeof fetch;
  const store = new OrgConnectionStore({ ...deps, fetch: fetchImpl });
  for (const connection of connections) {
    await store.put({ orgId, by: "dev-admin", connection: { connectionId: connection.id, type: "linear", label: "Linear", access: connection.access ?? "read_write", ...(connection.identity === undefined ? {} : { identity: connection.identity }) }, secret: { apiKey: connection.key } });
    await store.check(orgId, connection.id);
  }
  return { deps, store, db, port: linearWriteOf({ deps, fetch: fetchImpl }), fetchImpl };
}

describe("the connection's check learns the workspace", () => {
  it("records the account and the workspace's url key, and shows neither to a member", async () => {
    const t = await world([{ id: CON_1, key: KEY_1, linear: fakeLinear({ workspace: "acme" }) }]);
    expect([...await connectionActorIds(t.deps, ORG_A, "linear")]).toEqual([ROVARA]);
    expect([...await connectionWorkspaceKeys(t.deps, ORG_A)]).toEqual(["acme"]);
    expect(JSON.stringify(await t.store.get(ORG_A, CON_1))).not.toContain("acme");
    expect(await t.store.get(ORG_A, CON_1)).not.toHaveProperty("workspaceKey");
  });
});

describe("posting an answer", () => {
  it("writes one comment on the issue, to Linear's address only, under the saved key, with an id made from the key it was given", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    linear.calls.length = 0;
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "It is blocked on a check.", commentKey: "ask:ask_1" });
    expect(posted).toEqual({ commentId: linearCommentIdFor(ORG_A, "ask:ask_1") });
    expect(linear.calls.map((call) => call.url)).toEqual([LINEAR_GRAPHQL, LINEAR_GRAPHQL]);
    expect(linear.calls.every((call) => call.auth === KEY_1 && call.redirect === "error")).toBe(true);
    expect(linear.comments.get(posted.commentId)).toMatchObject({ body: "It is blocked on a check.", userId: ROVARA, issue: "ENG-142" });
    expect(linear.mutations()).toHaveLength(1);
  });

  it("the same key again is the same comment: it is not written twice, even when the first write's answer was lost", async () => {
    const linear = fakeLinear({ failCreateOnce: true });
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const first = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "once", commentKey: "ask:ask_2" });
    const second = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "once", commentKey: "ask:ask_2" });
    expect(second).toEqual(first);
    expect([...linear.comments.values()].filter((comment) => comment.body === "once")).toHaveLength(1);
    // Another key is another comment.
    const other = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "twice", commentKey: "ask:ask_3" });
    expect(other.commentId).not.toBe(first.commentId);
  });

  it("a comment id belongs to its org: the same key in another org is another id", () => {
    expect(linearCommentIdFor(ORG_A, "ask:x")).not.toBe(linearCommentIdFor(ORG_B, "ask:x"));
    expect(linearCommentIdFor(ORG_A, "ask:x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(linearCommentIdFor(ORG_A, "ask:x")).toBe(linearCommentIdFor(ORG_A, "ask:x"));
  });

  it("writes only through a connection that may write and holds a secret: a read-only connection posts nothing", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, access: "read", linear }]);
    linear.calls.length = 0;
    await expect(t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "hello", commentKey: "ask:ask_4" })).rejects.toThrow(/not set up/u);
    expect(linear.calls).toHaveLength(0);
    expect(await t.port.ownActorId(ORG_A)).toBeUndefined();
  });

  it("prefers the service identity, and writes as that account", async () => {
    const personal = fakeLinear({ viewer: "linear-user-personal" });
    const service = fakeLinear({ viewer: "linear-user-service" });
    const t = await world([{ id: CON_1, key: KEY_1, identity: "personal", linear: personal }, { id: CON_2, key: KEY_2, identity: "service", linear: service }]);
    personal.calls.length = 0; service.calls.length = 0;
    await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "hi", commentKey: "ask:ask_5" });
    expect(personal.mutations()).toHaveLength(0);
    expect(service.mutations()).toHaveLength(1);
    expect(await t.port.ownActorId(ORG_A)).toBe("linear-user-service");
  });

  it("writes to the workspace the binding names: a connection of another workspace is skipped, and an issue whose link is in another workspace gets nothing", async () => {
    const acme = fakeLinear({ workspace: "acme" });
    const other = fakeLinear({ workspace: "othercorp" });
    const t = await world([{ id: CON_1, key: KEY_1, linear: acme }, { id: CON_2, key: KEY_2, linear: other }]);
    acme.calls.length = 0; other.calls.length = 0;
    await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "for othercorp", commentKey: "ask:ask_6", workspace: "othercorp" });
    expect(acme.mutations()).toHaveLength(0);
    expect(other.mutations()).toHaveLength(1);
    // Only one connection, whose Linear says the issue is in acme, while the binding says othercorp: refused before any write.
    const lone = fakeLinear({ workspace: "acme" });
    const u = await world([{ id: CON_1, key: KEY_1, linear: lone }]);
    lone.calls.length = 0;
    await expect(u.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "x", commentKey: "ask:ask_7", workspace: "othercorp" })).rejects.toThrow();
    expect(lone.mutations()).toHaveLength(0);
  });

  it("an issue Linear does not have, or whose key is not an issue key, gets nothing; so does an org with no connection", async () => {
    const linear = fakeLinear({ issueKey: "ENG-999" });
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    linear.calls.length = 0;
    await expect(t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "x", commentKey: "ask:ask_8" })).rejects.toThrow();
    await expect(t.port.reply({ orgId: ORG_A, issueKey: "not a key; drop table", text: "x", commentKey: "ask:ask_9" })).rejects.toThrow();
    expect(linear.mutations()).toHaveLength(0);
    await expect(t.port.reply({ orgId: ORG_B, issueKey: "ENG-999", text: "x", commentKey: "ask:ask_10" })).rejects.toThrow();
  });

  it("an empty text is not posted and a long one is cut to the limit", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    await expect(t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "   ", commentKey: "ask:ask_11" })).rejects.toThrow();
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "a".repeat(LINEAR_COMMENT_MAX_CHARS + 500), commentKey: "ask:ask_12" });
    expect(linear.comments.get(posted.commentId)!.body).toHaveLength(LINEAR_COMMENT_MAX_CHARS);
  });

  it("a failed call says nothing of the key, the request or the answer", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const broken = linearWriteOf({ deps: t.deps, fetch: async () => { throw new Error(`network down for ${KEY_1} while sending the answer`); } });
    const error = await broken.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "the secret answer", commentKey: "ask:ask_13" }).then(() => undefined, (caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(`${error!.message} ${error!.name} ${JSON.stringify(error)}`).not.toMatch(/lin_api|the secret answer|network down/u);
  });
});

describe("changing or removing what Rovara posted", () => {
  it("updates and deletes a comment Rovara's own account wrote", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "named Maya", commentKey: "ask:ask_14" });
    await t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "named @former-member" });
    expect(linear.comments.get(posted.commentId)!.body).toBe("named @former-member");
    await t.port.remove({ orgId: ORG_A, commentId: posted.commentId });
    expect(linear.comments.has(posted.commentId)).toBe(false);
  });

  it("never touches a comment somebody else wrote, whatever id it is given", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    linear.calls.length = 0;
    await expect(t.port.update({ orgId: ORG_A, commentId: "person-comment-1", text: "overwritten" })).rejects.toThrow();
    await expect(t.port.remove({ orgId: ORG_A, commentId: "person-comment-1" })).rejects.toThrow();
    expect(linear.comments.get("person-comment-1")!.body).toBe("a person wrote this");
    expect(linear.mutations()).toHaveLength(0);
  });

  it("a comment that is already gone is gone: removing it again is not an error", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    await expect(t.port.remove({ orgId: ORG_A, commentId: linearCommentIdFor(ORG_A, "ask:never-posted") })).resolves.toBeUndefined();
  });
});

describe("the id", () => {
  it("is derived from the org and the key with a fixed formula (a stored record can name it before it is posted)", () => {
    const digest = createHash("sha256").update("rovara-linear-comment\0" + ORG_A + "\0" + "ask:ask_1", "utf8").digest();
    const hex = digest.subarray(0, 16).toString("hex");
    expect(linearCommentIdFor(ORG_A, "ask:ask_1").replace(/-/gu, "").length).toBe(32);
    expect(linearCommentIdFor(ORG_A, "ask:ask_1").slice(0, 8)).toBe(hex.slice(0, 8));
  });
});
