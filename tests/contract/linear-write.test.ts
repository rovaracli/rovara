// Linear writes for Ask (lane ask-linear, LA-1): Rovara posts an Ask's answer on the Linear issue through the org's EXISTING Linear connection (the saved API key of `OrgConnectionStore`), by Linear's
// GraphQL address only. Held here: only a connection that may write (`read_write`) and holds a secret is used (a service identity first); the comment id is made from a stable key, so a retry of the same
// post is the same comment; what is edited or deleted is only a comment Rovara's own account wrote; the key never appears in a thrown error; the workspace the binding names is the workspace written to.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrgConnectionStore, LINEAR_GRAPHQL, connectionActorIds, connectionWorkspaceKeys } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { linearCommentIdFor, linearWriteOf, LINEAR_COMMENT_MAX_CHARS, LINEAR_RATE_ATTEMPTS, LINEAR_RATE_WAIT_MAX_MS, LINEAR_RATE_WAIT_TOTAL_MS } from "../../packages/broker/src/rovara-code/linear-write.js";
import type { OrgId } from "@rovara-code/contracts";
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
function fakeLinear(options: { workspace?: string; viewer?: string; issueKey?: string; failCreateOnce?: boolean; unkeyed?: boolean } = {}) {
  const workspace = options.workspace ?? "acme";
  const issueKey = options.issueKey ?? "ENG-142";
  const comments = new Map<string, { id: string; body: string; userId: string; issue: string }>([["person-comment-1", { id: "person-comment-1", body: "a person wrote this", userId: PERSON, issue: issueKey }]]);
  const calls: Array<{ url: string; auth: string | null; query: string; variables: Record<string, unknown>; redirect: unknown }> = [];
  let failed = false;
  // Controls a test can set after the fake is made: errors for the comment lookup, whether a missing comment is answered as Linear's real not-found error, and a rate limit.
  const state = { commentReadErrors: undefined as unknown[] | undefined, missingAsError: false, rate: undefined as { times: number; style: "429" | "graphql"; retryAfter?: string } | undefined, rateHits: 0 };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query: string; variables: Record<string, unknown> };
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), auth: headers["authorization"] ?? null, query: body.query, variables: body.variables ?? {}, redirect: init?.redirect });
    if (state.rate !== undefined && state.rate.times > 0 && !/viewer/u.test(body.query)) {
      state.rate.times -= 1;
      state.rateHits += 1;
      const headers = state.rate.retryAfter === undefined ? {} : { "retry-after": state.rate.retryAfter };
      return state.rate.style === "429" ? new Response("{}", { status: 429, headers }) : new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }), { status: 400, headers });
    }
    const json = (data: unknown, errors?: unknown) => new Response(JSON.stringify({ data, ...(errors === undefined ? {} : { errors }) }), { status: 200 });
    const v = body.variables ?? {};
    if (/viewer/u.test(body.query)) return json({ viewer: { id: options.viewer ?? ROVARA, organization: options.unkeyed === true ? null : { urlKey: workspace } } });
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
      if (state.commentReadErrors !== undefined) return json(null, state.commentReadErrors);
      const found = comments.get(String(v["id"]));
      if (found === undefined && state.missingAsError) return json(null, [{ message: "Entity not found: Comment", extensions: { code: "INVALID_INPUT", userError: true } }]);
      return json({ comment: found === undefined ? null : { id: found.id, user: { id: found.userId }, issue: { identifier: found.issue } } });
    }
    if (/issue\(id/u.test(body.query)) {
      return json({ issue: String(v["id"]).toUpperCase() === issueKey ? { id: "issue-uuid-1", identifier: issueKey, url: `https://linear.app/${workspace}/issue/${issueKey}/the-title` } : null });
    }
    return json(null, [{ message: "unknown" }]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, comments, state, mutations: () => calls.filter((call) => /mutation/u.test(call.query)) };
}

async function world(connections: Array<{ id: string; key: string; access?: "read" | "read_write"; identity?: "service" | "personal"; unchecked?: boolean; linear: ReturnType<typeof fakeLinear> }>, orgId: OrgId = ORG_A, options: { sleeps?: number[] } = {}) {
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
    if (connection.unchecked !== true) await store.check(orgId, connection.id);
  }
  return { deps, store, db, port: linearWriteOf({ deps, fetch: fetchImpl, sleep: async (ms) => { options.sleeps?.push(ms); } }), fetchImpl };
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
    expect(posted).toEqual({ workspace: "acme", commentId: linearCommentIdFor(ORG_A, "ask:ask_1") });
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

describe("B1: every comment Rovara posts can be edited or deleted later, and \"gone\" means Linear's real not-found only", () => {
  it("(a) a connection that was never checked as an account posts nothing", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear, unchecked: true }]);
    linear.calls.length = 0;
    await expect(t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "hello", commentKey: "ask:ask_20" })).rejects.toThrow(/not set up/u);
    expect(linear.mutations()).toHaveLength(0);
    expect(linear.calls).toHaveLength(0);
    // With a checked connection beside it, only the checked one writes.
    const other = fakeLinear();
    const both = await world([{ id: CON_1, key: KEY_1, linear, unchecked: true }, { id: CON_2, key: KEY_2, linear: other }]);
    const posted = await both.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "hello", commentKey: "ask:ask_21" });
    expect(other.comments.has(posted.commentId)).toBe(true);
    expect(linear.comments.has(posted.commentId)).toBe(false);
  });

  it("(b) an error from Linear that is not its real not-found (permission, a 200 with errors) is a fault to retry, never \"gone\": remove and update throw and nothing is deleted", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "named Maya", commentKey: "ask:ask_22" });
    linear.state.commentReadErrors = [{ message: "You do not have access to this comment", extensions: { code: "FORBIDDEN" } }];
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "x" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    linear.state.commentReadErrors = [{ message: "Something went wrong" }];
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(linear.comments.has(posted.commentId)).toBe(true);
    expect(linear.comments.get(posted.commentId)!.body).toBe("named Maya");
    // Mixed with a real not-found in the same answer is still not a plain not-found.
    linear.state.commentReadErrors = [{ message: "Entity not found: Comment" }, { message: "You do not have access" }];
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("(b) Linear's real not-found answers (a null comment, or the \"Entity not found\" error) are gone: remove is done and update says NOT_FOUND", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const missing = linearCommentIdFor(ORG_A, "ask:never");
    await expect(t.port.remove({ orgId: ORG_A, commentId: missing })).resolves.toBeUndefined();
    await expect(t.port.update({ orgId: ORG_A, commentId: missing, text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    linear.state.missingAsError = true;
    await expect(t.port.remove({ orgId: ORG_A, commentId: missing })).resolves.toBeUndefined();
    await expect(t.port.update({ orgId: ORG_A, commentId: missing, text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("(b) with two connections, one that is refused does not hide the comment another can see; but a refusal with no sight of it is a fault", async () => {
    const one = fakeLinear({ workspace: "acme" });
    const two = fakeLinear({ workspace: "other" });
    const t = await world([{ id: CON_1, key: KEY_1, linear: one }, { id: CON_2, key: KEY_2, linear: two }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "named Maya", commentKey: "ask:ask_23", workspace: "acme" });
    one.state.commentReadErrors = [{ message: "no access", extensions: { code: "FORBIDDEN" } }];
    // CON_1 is refused and CON_2 knows no such comment: nothing proves it is gone.
    two.state.missingAsError = true;
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(one.comments.has(posted.commentId)).toBe(true);
  });

  it("(c) a comment whose author is not the connection's account (the connection was re-keyed to another account) is refused, not gone", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "named Maya", commentKey: "ask:ask_24" });
    linear.comments.get(posted.commentId)!.userId = PERSON;
    await expect(t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("(c) with no connection that can be used any more, an edit or a delete is a retryable fault, not gone", async () => {
    const linear = fakeLinear();
    const t = await world([{ id: CON_1, key: KEY_1, linear }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "named Maya", commentKey: "ask:ask_25" });
    await t.store.remove({ orgId: ORG_A, connectionId: CON_1, by: "dev-admin" });
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(linear.comments.has(posted.commentId)).toBe(true);
  });
});

describe("S4: Linear's rate limits are waited out as it asks, a bounded number of times", () => {
  it("an HTTP 429 with Retry-After waits that long and then posts once", async () => {
    const linear = fakeLinear();
    const sleeps: number[] = [];
    const t = await world([{ id: CON_1, key: KEY_1, linear }], ORG_A, { sleeps });
    linear.state.rate = { times: 1, style: "429", retryAfter: "2" };
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "after a wait", commentKey: "ask:ask_26" });
    expect(sleeps).toEqual([2000]);
    expect([...linear.comments.values()].filter((comment) => comment.body === "after a wait")).toHaveLength(1);
    expect(posted.commentId).toBe(linearCommentIdFor(ORG_A, "ask:ask_26"));
  });

  it("a RATELIMITED answer (Linear sends it with a 400) is the same, and a wait longer than the bound is cut to it", async () => {
    const linear = fakeLinear();
    const sleeps: number[] = [];
    const t = await world([{ id: CON_1, key: KEY_1, linear }], ORG_A, { sleeps });
    linear.state.rate = { times: 1, style: "graphql", retryAfter: "600" };
    await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "later", commentKey: "ask:ask_27" });
    expect(sleeps).toEqual([LINEAR_RATE_WAIT_MAX_MS]);
  });

  it("a limit that does not lift is TOO_MANY_REQUESTS after the bounded tries, with no key or text in the fault, and writes nothing", async () => {
    const linear = fakeLinear();
    const sleeps: number[] = [];
    const t = await world([{ id: CON_1, key: KEY_1, linear }], ORG_A, { sleeps });
    linear.state.rate = { times: 99, style: "429" };
    const error = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "SECRET-WORDS", commentKey: "ask:ask_28" }).then(() => undefined, (caught: Error & { code?: string }) => caught);
    expect(error).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(JSON.stringify(error?.message)).not.toMatch(/SECRET-WORDS|lin_api_/u);
    expect(sleeps.length).toBe(LINEAR_RATE_ATTEMPTS - 1);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(LINEAR_RATE_WAIT_TOTAL_MS);
    expect(linear.state.rateHits).toBe(LINEAR_RATE_ATTEMPTS);
    expect(linear.comments.size).toBe(1);
  });
});

describe("AL-1: a comment is gone only when a connection in the posting workspace says so", () => {
  const CON_3 = "con_cccccccccccccccccccc";
  const KEY_3 = "lin_api_THREE_SECRET_0123456789";
  const OTHER_ACCOUNT = "linear-user-other";

  /** Rovara posts in "acme" through CON_1; CON_2 is a connection to another workspace, "other", which knows no such comment. */
  async function twoWorkspaces() {
    const acme = fakeLinear({ workspace: "acme" });
    const other = fakeLinear({ workspace: "other", viewer: OTHER_ACCOUNT });
    const t = await world([{ id: CON_1, key: KEY_1, linear: acme }, { id: CON_2, key: KEY_2, linear: other }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "It is blocked.", commentKey: "ask:al1", workspace: "acme" });
    return { t, acme, other, posted };
  }

  it("with the posting connection removed and another workspace's connection left, remove is NOT done: nothing is read as gone", async () => {
    const { t, acme, posted } = await twoWorkspaces();
    await t.store.remove({ orgId: ORG_A, connectionId: CON_1, by: "dev-admin" });
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "x", workspace: "acme" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // The comment is still on Linear, untouched.
    expect(acme.comments.has(posted.commentId)).toBe(true);
  });

  it("with both connections present, the posting workspace's connection finds and deletes it", async () => {
    const { t, acme, posted } = await twoWorkspaces();
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).resolves.toBeUndefined();
    expect(acme.comments.has(posted.commentId)).toBe(false);
  });

  it("a connection of the posting workspace that answers not-found makes it gone, even when another workspace's connection is also asked", async () => {
    const { t, acme, posted } = await twoWorkspaces();
    acme.comments.delete(posted.commentId);
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).resolves.toBeUndefined();
    await expect(t.port.update({ orgId: ORG_A, commentId: posted.commentId, text: "x", workspace: "acme" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a second connection to the posting workspace can still answer for it when the first is removed", async () => {
    const acme = fakeLinear({ workspace: "acme" });
    const t = await world([{ id: CON_1, key: KEY_1, linear: acme }, { id: CON_3, key: KEY_3, linear: acme }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "It is blocked.", commentKey: "ask:al1b", workspace: "acme" });
    await t.store.remove({ orgId: ORG_A, connectionId: CON_1, by: "dev-admin" });
    acme.comments.delete(posted.commentId);
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).resolves.toBeUndefined();
  });

  it("the reply tells which workspace it posted in (the connection's own, checked, workspace)", async () => {
    const { posted } = await twoWorkspaces();
    expect(posted).toMatchObject({ workspace: "acme" });
  });

  it("a connection whose workspace was never read still confirms \"gone\" when no connection is known to be in the posting workspace (as before AL-1)", async () => {
    const unkeyed = fakeLinear({ workspace: "acme", unkeyed: true });
    const t = await world([{ id: CON_1, key: KEY_1, linear: unkeyed }]);
    expect([...await connectionWorkspaceKeys(t.deps, ORG_A)]).toEqual([]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "It is blocked.", commentKey: "ask:al1c", workspace: "acme" });
    unkeyed.comments.delete(posted.commentId);
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).resolves.toBeUndefined();
  });

  it("but not when a connection known to be in the posting workspace is there and did not say so: the unkeyed one's not-found is no proof then", async () => {
    const acme = fakeLinear({ workspace: "acme" });
    const unkeyed = fakeLinear({ workspace: "acme", unkeyed: true, viewer: "linear-user-unkeyed" });
    const t = await world([{ id: CON_1, key: KEY_1, linear: acme }, { id: CON_3, key: KEY_3, linear: unkeyed }]);
    const posted = await t.port.reply({ orgId: ORG_A, issueKey: "ENG-142", text: "It is blocked.", commentKey: "ask:al1d", workspace: "acme" });
    // The keyed connection fails (not "not found"): only the unkeyed one says not found, which proves nothing while the posting workspace's own connection could not answer.
    acme.state.commentReadErrors = [{ message: "boom" }];
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId, workspace: "acme" })).rejects.toBeDefined();
    expect(acme.comments.has(posted.commentId)).toBe(true);
  });

  it("without a recorded workspace the pass is what it was (every connection must say not-found)", async () => {
    const { t, acme, posted } = await twoWorkspaces();
    acme.comments.delete(posted.commentId);
    await expect(t.port.remove({ orgId: ORG_A, commentId: posted.commentId })).resolves.toBeUndefined();
  });
});
