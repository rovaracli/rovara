// Plan 5 Task 4: sharing a session. A share with a person or a project applies at once, in one transaction with its index item, its event and its
// request item; a share with the whole company waits on Plan 3's confirmation page (R66) and answers 202 with the ticketed link; removing a share
// narrows at once.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentXError, agentSessionKey, changesKey, sessionRequestKey, sharedSessionsKey, type OrgId } from "@rovara-code/contracts";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getAnyApproval, getApprovalSubjectHandler, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { resolveSessionAccess } from "../../packages/broker/src/agent-sessions/access.js";
import { deleteSessionShare, listSessionShares, putSessionShare, registerSessionShareApprovals, type SessionShareDependencies } from "../../packages/broker/src/agent-sessions/shares.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { NeedsConfirmationSchema, SessionEventSchema } from "@rovara-code/contracts";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const VIEWER_TEXT = "Viewers of web can only watch its sessions.";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Item = Record<string, unknown>;

function world() {
  const w = sessionWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const shareDeps: SessionShareDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore,
  };
  const decideStore = new DecideStore({ documentClient: w.db, tableName: "signin", now: () => w.clock.now });
  const deps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
    agentSessions: shareDeps,
  } as unknown as ApprovalDependencies;
  const kind = approvalDecideKind(deps);
  const context = (kinds: DecideKinds = { apr: kind }): DecideRequestContext => ({
    store: decideStore, now: () => w.clock.now, cellOrigin: CELL, kinds,
    authenticateBearer: async (authorization) => {
      const found = new Map<string, { developerId: string; orgId: OrgId }>([["Bearer priya", { developerId: PRIYA, orgId: ORG_A }], ["Bearer ola", { developerId: OLA, orgId: ORG_A }]]).get(authorization);
      if (found === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
      return found;
    },
  });
  deps.mintConfirmUrl = (who, approvalId) => mintConfirmUrl(context(), { developerId: who.developerId, orgId: who.orgId }, approvalId);
  registerSessionShareApprovals();
  let counter = 0;
  const browser = async (developerId: string, approvalId: string, agoSeconds = 30) => {
    counter += 1;
    const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
    const signedInAt = Math.floor(w.clock.now / 1000) - agoSeconds;
    await decideStore.putSession(cookie, { orgId: ORG_A, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 3600 });
    return cookie;
  };
  const decide = (approvalId: string, cookie: string, decision: "approve" | "decline" = "approve") => routeDecidePage(context(), {
    method: "POST", path: `/v1/app/approve/${approvalId}`, requestId: "r",
    headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString(),
  }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
  const share = (who: string, sessionId: string, body: Record<string, unknown>, orgId: OrgId = ORG_A) => putSessionShare(deps.agentSessions!, w.caller(who, orgId), sessionId, { requestId: randomUUID(), ...body }, deps);
  const approvalOf = async (url: string) => (await getAnyApproval(deps, ORG_A, new URL(url).pathname.split("/").pop()!))!;
  const lastTransaction = () => w.db.transactions().at(-1)!;
  const putsOf = (entries: Array<Record<string, unknown>>): Item[] => entries.flatMap((entry) => ((entry.Put as { Item?: Item } | undefined)?.Item === undefined ? [] : [(entry.Put as { Item: Item }).Item]));
  const meta = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Item;
  const shareItem = (sessionId: string, key: string) => w.db.get(agentSessionKey(ORG_A, sessionId, `SHARE#${key}`)) as Item | undefined;
  const events = (sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith("EVENT#"));
  const levelOf = async (who: string, sessionId: string) => (await resolveSessionAccess(shareDeps, w.caller(who), sessionId)).level;
  return { ...w, store, shareDeps, deps, kind, context, browser, decide, share, approvalOf, lastTransaction, putsOf, meta, shareItem, events, levelOf, decideStore };
}
type World = ReturnType<typeof world>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

describe("sharing with a person", () => {
  it("applies at once: one transaction with the share, its index item, the shared event, the revision and the request item", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const reply = await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "use" });
    expect(reply.status).toBe(200);
    const transaction = w.lastTransaction();
    const keys = transaction.map((entry) => {
      const action = Object.values(entry)[0] as { Item?: Item; Key?: Item };
      return `${Object.keys(entry)[0]!} ${String((action.Item ?? action.Key)!.pk).replace(`ORG#${ORG_A}#`, "")}|${String((action.Item ?? action.Key)!.sk).replace(/#\d{4}-.*$/, "#<at>")}`;
    });
    expect(keys.sort()).toEqual([
      `Put AGENT_SESSION#${sessionId}|EVENT#<at>`,
      `Put AGENT_SESSION#${sessionId}|SHARE#MEMBER#${ARJUN}`,
      `Put SESSION_REQUEST#${PRIYA}|${(transaction.at(-1)!.Put as { Item: Item }).Item.sk as string}`,
      `Put SHARED_SESSIONS#MEMBER#${ARJUN}|${sessionId}`,
      `Update AGENT_SESSION#${sessionId}|META`,
    ].sort());
    expect(w.shareItem(sessionId, `MEMBER#${ARJUN}`)).toMatchObject({ principal: { kind: "member", developerId: ARJUN }, level: "use", sharedBy: { developerId: PRIYA, name: "Priya" } });
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, sessionId))).toMatchObject({ sessionId, level: "use" });
    const [event] = w.events(sessionId);
    expect(SessionEventSchema.parse(Object.fromEntries(Object.entries(event!).filter(([key]) => !["pk", "sk", "entityType", "orgId", "sessionId", "indexExpiresAt"].includes(key))))).toMatchObject({
      type: "shared", text: "Priya shared this session with Arjun (can use)", actor: { kind: "member", developerId: PRIYA, name: "Priya" },
    });
    expect(w.meta(sessionId).revision).toBe(2);
    expect(await w.levelOf(ARJUN, sessionId)).toBe("use");
  });

  it("words a project share and changes a person's level when shared again", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ project: null });
    await w.share(PRIYA, sessionId, { principal: { kind: "project", project: "ops" }, level: "view" });
    expect((w.events(sessionId)[0] as Item).text).toBe("Priya shared this session with the ops project (can view)");
    await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" });
    await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "edit" });
    expect(w.shareItem(sessionId, `MEMBER#${ZED}`)).toMatchObject({ level: "edit" });
    expect(await w.levelOf(ZED, sessionId)).toBe("edit");
    expect(w.meta(sessionId).revision).toBe(4);
  });

  it("lets an edit holder share, up to their level, and refuses a person with less than edit", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "use");
    const refused = await code(w.share(ZED, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "edit" }));
    expect(refused).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: 'You need "can edit" on this session to share it. Ask Priya to share it with you.' });
    expect(await code(w.share(ARJUN, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" }))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(w.db.transactions()).toEqual([]);
    expect((await w.share(MAX, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "edit" })).status).toBe(200);
  });

  it("tells the owner, with an undo, when someone else shares the session, and not when the owner does", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" });
    const notices = () => w.db.find((item) => String(item.pk).startsWith(`ORG#${ORG_A}#CHANGES#`));
    expect(notices()).toEqual([]);
    await w.share(MAX, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "view" });
    const [notice] = notices();
    expect(notice).toMatchObject({ type: "session_shared", sessionId, undo: { principalKey: `MEMBER#${ARJUN}` }, by: MAX });
    expect(String(notice!.pk)).toBe(changesKey(ORG_A, PRIYA, "2026-10-22T09:00:00.000Z", 0).pk);
    expect(notice!.indexExpiresAt).toBe(Math.floor(w.clock.now / 1000) + 7 * 86_400);
    // Notices carry ids, kinds and revisions only.
    expect(JSON.stringify(notice)).not.toContain("Arjun");
    expect(JSON.stringify(notice)).not.toContain("Bump");
  });
});

describe("what a share refuses", () => {
  it("refuses a member who isn't in the company and a project that doesn't exist, with the exact words", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    // The words are fixed: they never name a person who is in another company.
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: BO }, level: "view" }))).toEqual({ code: "CONFIG_INVALID", message: "That person isn't in your company." });
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: "1".repeat(64) }, level: "view" }))).toEqual({ code: "CONFIG_INVALID", message: "That person isn't in your company." });
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "project", project: "nope" }, level: "view" }))).toEqual({ code: "PROJECT_NOT_FOUND", message: "project `nope` doesn't exist in this AgentX" });
    expect(w.db.transactions()).toEqual([]);
  });

  it("refuses a use or edit share to a project viewer with the viewer message, and allows view", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: MIA }, level: "use" }))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: MIA }, level: "edit" }))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: VIEWER_TEXT });
    expect((await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: MIA }, level: "view" })).status).toBe(200);
  });

  it("says it isn't available when a share with the whole company has nothing to confirm it with", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const body = { requestId: randomUUID(), principal: { kind: "org" }, level: "view" };
    expect(await code(putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });

  it("refuses a body with an unknown field, a bad request id or a level of none", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const put = (body: Record<string, unknown>) => code(putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps));
    const good = { requestId: randomUUID(), principal: { kind: "member", developerId: ZED }, level: "view" };
    expect(await put({ ...good, extra: 1 })).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await put({ ...good, requestId: "not-a-uuid" })).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await put({ ...good, level: "none" })).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await put({ ...good, principal: { kind: "member", developerId: "short" } })).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses the 51st share, but still lets one of the 50 change level", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    for (let index = 0; index < 50; index += 1) w.seedShare(ORG_A, sessionId, { kind: "member", developerId: index.toString(16).padStart(64, "0") }, "view");
    const refused = await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" }));
    expect(refused).toEqual({ code: "CONFIG_INVALID", message: "A session can be shared with at most 50 people or groups." });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "view");
    // 51 items now (the seeding bypassed the limit), so the check is on adding, not on changing.
    w.db.delete(agentSessionKey(ORG_A, sessionId, `SHARE#MEMBER#${"0".repeat(64)}`));
    expect((await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "use" })).status).toBe(200);
  });

  it("answers another org's person with 404 and writes nothing", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    expect(await code(w.share(BO, sessionId, { principal: { kind: "member", developerId: BO }, level: "view" }, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.share(ZED, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.db.transactions()).toEqual([]);
  });

  it("holds the share to the revision it read: a session that changed in between is the conflict, and nothing is written", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    // Just before the transaction is sent, someone else changes the session (as a take-over or another share would).
    let moved = false;
    const original = w.db.send;
    w.db.send = async (command) => {
      if (!moved && command.constructor.name === "TransactWriteCommand") { moved = true; w.db.set({ ...w.meta(sessionId), revision: 9 }); }
      return original(command);
    };
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" }))).toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(w.shareItem(sessionId, `MEMBER#${ZED}`)).toBeUndefined();
    expect(w.events(sessionId)).toEqual([]);
  });

  it("answers a lost race on the session's revision with the conflict text, and writes nothing", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] } });
    expect(await code(w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ZED }, level: "view" }))).toEqual({
      code: "SESSION_REVISION_CONFLICT", message: "This session changed since you loaded it. Reload it and try again.",
    });
    expect(w.shareItem(sessionId, `MEMBER#${ZED}`)).toBeUndefined();
  });
});

describe("a repeated request", () => {
  it("returns the stored outcome and writes nothing, for the same body; another body under that id is a conflict", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const body = { requestId: randomUUID(), principal: { kind: "member", developerId: ARJUN }, level: "use" };
    const first = await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps);
    const before = { transactions: w.db.transactions().length, items: w.db.items.size, revision: w.meta(sessionId).revision };
    expect(await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps)).toEqual(first);
    expect({ transactions: w.db.transactions().length, items: w.db.items.size, revision: w.meta(sessionId).revision }).toEqual(before);
    expect(await code(putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, { ...body, level: "edit" }, w.deps))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // A late replay after the opposite action changes nothing.
    await deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, `MEMBER#${ARJUN}`);
    expect(await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps)).toEqual(first);
    expect(w.shareItem(sessionId, `MEMBER#${ARJUN}`)).toBeUndefined();
  });

  it("records only the request item for a share that changes nothing", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    await w.share(PRIYA, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "use" });
    const revision = w.meta(sessionId).revision;
    const events = w.events(sessionId).length;
    const again = { requestId: randomUUID(), principal: { kind: "member", developerId: ARJUN }, level: "use" };
    expect((await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, again, w.deps)).status).toBe(200);
    expect(w.meta(sessionId).revision).toBe(revision);
    expect(w.events(sessionId)).toHaveLength(events);
    expect(w.db.get(sessionRequestKey(ORG_A, PRIYA, again.requestId))).toBeDefined();
  });
});

describe("a session that has ended", () => {
  it("gives every item a share writes an expiry, a year after the session ended", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ ended: true });
    await w.share(MAX, sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "view" });
    const expected = Math.floor(Date.parse("2026-10-22T08:30:00.000Z") / 1000) + 365 * 86_400;
    const puts = w.putsOf(w.lastTransaction());
    expect(puts.length).toBeGreaterThanOrEqual(4);
    for (const item of puts) expect(typeof item.indexExpiresAt, `${String(item.pk)}|${String(item.sk)}`).toBe("number");
    // The share and its index item expire with the session; the event and the request keep their own times.
    for (const item of puts.filter((put) => String(put.sk).startsWith("SHARE#") || String(put.pk).includes("SHARED_SESSIONS#"))) expect(item.indexExpiresAt).toBe(expected);
    // An open session's items carry none, except the events and the request, which always expire.
    const open = world();
    const live = open.seedSession();
    await open.share(PRIYA, live.sessionId, { principal: { kind: "member", developerId: ARJUN }, level: "view" });
    expect(open.shareItem(live.sessionId, `MEMBER#${ARJUN}`)).not.toHaveProperty("indexExpiresAt");
    expect(open.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: ARJUN }, live.sessionId))).not.toHaveProperty("indexExpiresAt");
  });
});

describe("a share with the whole company", () => {
  const ask = async (w: World, sessionId: string, level: "view" | "use" = "view", who = PRIYA) => {
    const reply = await w.share(who, sessionId, { principal: { kind: "org" }, level });
    return reply;
  };

  it("answers 202 with the ticketed link, and changes nothing until it is confirmed", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const reply = await ask(w, sessionId);
    expect(reply.status).toBe(202);
    const confirmation = NeedsConfirmationSchema.parse(reply.body);
    expect(confirmation).toMatchObject({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" });
    expect(confirmation.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/apr_[0-9a-z]{20}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(confirmation.changes).toEqual([`Share "Bump the Stripe SDK" with everyone in your company (can view)`]);
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
    expect(w.meta(sessionId).revision).toBe(1);
    expect(w.events(sessionId)).toEqual([]);
    const record = await w.approvalOf(confirmation.confirmUrl);
    expect(record).toMatchObject({ kind: "change", status: "PENDING", requestedBy: PRIYA, subject: { kind: "session_share_org", sessionId, level: "view" }, approvers: { kind: "rule", rule: "session_share_org" } });
    // The same request asks once.
    const body = { requestId: randomUUID(), principal: { kind: "org" }, level: "view" };
    const a = await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps);
    const b = await putSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, body, w.deps);
    expect(new URL((b.body as { confirmUrl: string }).confirmUrl).pathname).toBe(new URL((a.body as { confirmUrl: string }).confirmUrl).pathname);
  });

  it("applies when the sharer confirms in a browser signed in within ten minutes, and shows it to everyone", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const confirmation = NeedsConfirmationSchema.parse((await ask(w, sessionId)).body);
    const approvalId = new URL(confirmation.confirmUrl).pathname.split("/").pop()!;
    expect(await code(resolveSessionAccess(w.shareDeps, w.caller(ZED), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    const done = await w.decide(approvalId, await w.browser(PRIYA, approvalId, 30));
    expect(done.statusCode, done.body).toBe(200);
    expect(await getAnyApproval(w.deps, ORG_A, approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: PRIYA });
    expect(w.shareItem(sessionId, "ORG")).toMatchObject({ principal: { kind: "org" }, level: "view", sharedBy: { developerId: PRIYA } });
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "org" }, sessionId))).toBeDefined();
    expect((w.events(sessionId)[0] as Item).text).toBe("Priya shared this session with everyone in your company (can view)");
    expect(await w.levelOf(ZED, sessionId)).toBe("view");
  });

  it("is not applied by a browser signed in eleven minutes ago, or by a token", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const confirmation = NeedsConfirmationSchema.parse((await ask(w, sessionId)).body);
    const approvalId = new URL(confirmation.confirmUrl).pathname.split("/").pop()!;
    const stale = await w.browser(PRIYA, approvalId, 11 * 60);
    const request = (headers: Record<string, string>) => ({ method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, headers, body: "{}" });
    const staleError = await requireDecideSession(w.context(), request({ cookie: `${DECIDE_COOKIE}=${stale}` })).then(() => undefined, (error: { code: string; details?: { signInUrl?: string } }) => error);
    expect(staleError).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(staleError?.details?.signInUrl).toContain(approvalId);
    const token = await requireDecideSession(w.context(), request({ authorization: "Bearer priya" })).then(() => undefined, (error: { code: string; statusCode: number; details?: { confirmUrl?: string } }) => error);
    expect(token).toMatchObject({ code: "REAUTH_REQUIRED", statusCode: 401 });
    expect(token?.details?.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${approvalId}\\?ticket=`));
    const posted = await w.decide(approvalId, stale);
    expect(posted.statusCode).not.toBe(200);
    expect(await getAnyApproval(w.deps, ORG_A, approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
  });

  it("can be decided only by the person who asked, and only while they may still share it", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId)).body).confirmUrl).pathname.split("/").pop()!;
    // An org admin, who is not the asker, can't decide it.
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: OLA, approvalId })).toEqual({ status: "forbidden", who: "the person who asked, while they can still share the session" });
    // Nor can another person who holds edit on the session.
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: MAX, approvalId })).toMatchObject({ status: "forbidden" });
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId })).toMatchObject({ status: "open" });
    // A take-over moved the session to Arjun, and Priya kept no edit: she may not confirm now.
    w.db.set({ ...w.meta(sessionId), owner: { developerId: ARJUN, name: "Arjun" } });
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId })).toMatchObject({ status: "forbidden" });
    const cookie = await w.browser(PRIYA, approvalId);
    expect((await w.decide(approvalId, cookie)).statusCode).toBe(403);
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
  });

  it("shows what is being shared on the confirmation page", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId, "use")).body).confirmUrl).pathname.split("/").pop()!;
    const inspected = await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId });
    expect(inspected).toMatchObject({ status: "open", view: { title: "Share a session with everyone" } });
    const view = (inspected as { view: { facts: Array<{ label: string; value: string }> } }).view;
    expect(view.facts).toEqual(expect.arrayContaining([{ label: "Session", value: "Bump the Stripe SDK" }, { label: "Everyone in your company", value: "can use" }]));
  });

  it("applies once when the handler runs twice, and says done when the share is already there", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId)).body).confirmUrl).pathname.split("/").pop()!;
    await w.decide(approvalId, await w.browser(PRIYA, approvalId));
    const record = (await getAnyApproval(w.deps, ORG_A, approvalId))!;
    const handler = getApprovalSubjectHandler("session_share_org")!;
    const revision = w.meta(sessionId).revision;
    const events = w.events(sessionId).length;
    await handler(w.deps, record);
    await handler(w.deps, record);
    expect(w.meta(sessionId).revision).toBe(revision);
    expect(w.events(sessionId)).toHaveLength(events);
  });

  it("is refused by the handler for a person who may no longer share the session", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId)).body).confirmUrl).pathname.split("/").pop()!;
    const record = { ...(await getAnyApproval(w.deps, ORG_A, approvalId))!, decidedBy: ARJUN };
    await expect(getApprovalSubjectHandler("session_share_org")!(w.deps, record)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
  });

  it("says done at once, with no new approval, when the company already has the session at that level", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "org" }, "view");
    const reply = await ask(w, sessionId);
    expect(reply).toMatchObject({ status: 200, body: { share: { principal: { kind: "org" }, level: "view" } } });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
    // Another level is a new question.
    expect((await ask(w, sessionId, "use")).status).toBe(202);
  });

  it("is refused by the handler when sessions aren't wired, rather than applied by someone else", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId)).body).confirmUrl).pathname.split("/").pop()!;
    const record = { ...(await getAnyApproval(w.deps, ORG_A, approvalId))!, decidedBy: PRIYA };
    const handler = getApprovalSubjectHandler("session_share_org")!;
    const { agentSessions: _agentSessions, ...rest } = w.deps; // eslint-disable-line @typescript-eslint/no-unused-vars -- the dependency is what is missing
    await expect(handler(rest as ApprovalDependencies, record)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(handler(w.deps, { ...record, decidedBy: undefined } as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
  });

  it("is declined without a trace, and a decline leaves the share unmade", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const approvalId = new URL(NeedsConfirmationSchema.parse((await ask(w, sessionId)).body).confirmUrl).pathname.split("/").pop()!;
    expect((await w.decide(approvalId, await w.browser(PRIYA, approvalId), "decline")).statusCode).toBe(200);
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
    expect(w.meta(sessionId).revision).toBe(1);
  });
});

describe("removing a share", () => {
  it("narrows at once, deletes the index item, records the event and drops followers whose level falls to none", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "org" }, "view");
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: OLA }, "view");
    w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "org" }, sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId, level: "view" });
    for (const who of [ZED, ARJUN, OLA]) w.follower(ORG_A, sessionId, who);
    const reply = await deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, "ORG");
    expect(reply).toEqual({ removed: true });
    expect(w.shareItem(sessionId, "ORG")).toBeUndefined();
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "org" }, sessionId))).toBeUndefined();
    expect((w.events(sessionId)[0] as Item).text).toBe("Priya stopped sharing this session with everyone in your company");
    expect(w.meta(sessionId).revision).toBe(2);
    const followers = w.db.find((item) => String(item.sk).startsWith("FOLLOWER#")).map((item) => String(item.sk).replace("FOLLOWER#", "")).sort();
    // Zed had it only through the company share; Arjun is on the project; Ola holds a member share and is an org admin.
    expect(followers).toEqual([ARJUN, OLA].sort());
    expect(await code(resolveSessionAccess(w.shareDeps, w.caller(ZED), sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets the owner, an edit holder and the person who made the share remove it, and no one else", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    const seed = () => w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "view", ARJUN);
    seed();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "view");
    expect(await code(deleteSessionShare(w.shareDeps, w.caller(MIA), sessionId, `MEMBER#${ZED}`))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await code(deleteSessionShare(w.shareDeps, w.caller(OLA), sessionId, `MEMBER#${ZED}`))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await deleteSessionShare(w.shareDeps, w.caller(ARJUN), sessionId, `MEMBER#${ZED}`)).toEqual({ removed: true });
    seed();
    expect(await deleteSessionShare(w.shareDeps, w.caller(MAX), sessionId, `MEMBER#${ZED}`)).toEqual({ removed: true });
    seed();
    expect(await deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, `MEMBER#${ZED}`)).toEqual({ removed: true });
  });

  it("tells a person who may not remove a share to ask the session's owner now, not the one who handed it over (Plan 5 Task 12a)", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ currentOwner: ARJUN });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "view", PRIYA);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "view");
    const refused = await code(deleteSessionShare(w.shareDeps, w.caller(MIA), sessionId, `MEMBER#${ZED}`));
    expect(refused).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(refused?.message).toContain("Arjun");
    expect(refused?.message).not.toContain("Priya");
  });

  it("answers a share that isn't there as removed: false and writes nothing, and refuses a bad key", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    expect(await deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, `MEMBER#${ZED}`)).toEqual({ removed: false });
    expect(w.db.transactions()).toEqual([]);
    expect(await code(deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, "MEMBER#short"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(deleteSessionShare(w.shareDeps, w.caller(PRIYA), sessionId, "SOMETHING"))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(deleteSessionShare(w.shareDeps, w.caller(BO, ORG_B), sessionId, `MEMBER#${ZED}`))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listing shares", () => {
  it("shows who a session is shared with to anyone who can view it, and not to another org", async () => {
    const w = world();
    const { sessionId } = w.seedSession();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "use");
    w.seedShare(ORG_A, sessionId, { kind: "project", project: "ops" }, "view", MAX);
    const listed = await listSessionShares(w.shareDeps, w.caller(ARJUN), sessionId);
    expect(listed.shares.map((row) => `${row.principal.kind}:${row.level}:${row.sharedBy.name}`).sort()).toEqual(["member:use:Priya", "project:view:Max"]);
    expect(await code(listSessionShares(w.shareDeps, w.caller(BO, ORG_B), sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(listSessionShares(w.shareDeps, w.caller("1".repeat(64)), sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });
});

