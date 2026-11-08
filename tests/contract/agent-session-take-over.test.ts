// Plan 5 Task 12b: taking a session over. A take-over moves authority, so it is a pending change (Plan 3's approval) that the person who asks confirms in a browser
// signed in within ten minutes; confirming moves the session's owner, the task's current owner, who pays from now on and the owner's People entries in ONE
// transaction, conditional on the session's revision and on the task's owner; the previous owner keeps "can edit"; and it is audited.
import { createHash, randomUUID } from "node:crypto";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, agentXError, approvalKey, approverIndexKey, changesKey, liveSessionKey, mySessionsKey, orgMemberKey, sessionChannel, sessionEventId, sharedSessionsKey, userChannel, type OrgId, type Payer } from "@agentx/contracts";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { createWriteApprovalRecord, getAnyApproval, getApprovalSubjectHandler, getApproverRule, listApprovalsFor, mayDecideApproval, type AnyApprovalRecord, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { WRITE_APPROVER_RULE } from "../../packages/broker/src/agents/write-gate.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { onMembersMerged } from "../../packages/broker/src/agents/lifecycle.js";
import { resolveSessionAccess } from "../../packages/broker/src/agent-sessions/access.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { registerSessionTakeOverApprovals, askTakeOver, type ChainOwnerMover, type SessionTakeOverDependencies } from "../../packages/broker/src/agent-sessions/take-over.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { resolveTaskDispatchPeople } from "../../packages/broker/src/developer/task-people.js";
import { effectiveTaskOwner, taskIndexKey, taskKey, taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { mintTagsFor, paymentOfTask } from "../../packages/broker/src/spend/payer.js";
import { NeedsConfirmationSchema, SessionEventSchema } from "../../packages/contracts/src/index.js";
import { FORMER_MEMBER_NAME, chosenNameKey, eraseChosenName } from "../../packages/broker/src/developer/chosen-name.js";
import { forgetResolvedNames } from "../../packages/broker/src/developer/name-resolver.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Item = Record<string, unknown>;
const CREATED_AT = "2026-10-22T08:00:00.000Z";
const BUDGET_TEXT = "Max's monthly AI budget is used up, so Rovara can't start new work for them.";
const CHANGED_TEXT = "This session changed since you asked. Ask again.";
const NOT_SET_UP = "Take-overs aren't set up in this deployment.";
const START_WORK = "You need a role on web that can start work to take this over.";

function world(options: { audit?: boolean; sessions?: boolean; chain?: boolean } = {}) {
  const w = sessionWorld();
  const audit = options.audit === true ? capturingAuditDeps({ db: w.db, now: () => w.clock.now }) : undefined;
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const admissions: Array<{ developerId: string; project: string }> = [];
  const paths: string[] = [];
  const live = { budgetRefusal: undefined as string | undefined, chainPayer: undefined as Payer | undefined, stepTaskId: undefined as string | undefined };
  const published: Array<{ channel: string; events: string[] }> = [];
  const chainCalls: Array<Record<string, unknown>> = [];
  const chain: ChainOwnerMover = {
    read: async () => ({ payer: live.chainPayer ?? { kind: "member", developerId: PRIYA }, ...(live.stepTaskId === undefined ? {} : { runningStepTaskId: live.stepTaskId }) }),
    ownerItems: (input) => {
      chainCalls.push(input);
      return [{ Put: { TableName: "state", Item: { pk: `CHAIN_RUN#${input.chainRunId}`, sk: "OWNER", owner: input.to.developerId, payerMovesTo: input.payer.kind === "member" ? input.to.developerId : undefined } } }];
    },
  };
  const sessionDeps: SessionTakeOverDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore,
    admitPayer: async (input) => { paths.push(input.path); admissions.push({ developerId: input.payer.kind === "member" ? input.payer.developerId : "", project: input.project }); if (live.budgetRefusal !== undefined) throw agentXError("BUDGET_EXCEEDED", live.budgetRefusal); },
    realtimePublish: {
      endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetch: (async (_url: unknown, init: { body: string }) => { published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); }) as never,
    },
    ...(options.chain === true ? { chainOwner: chain } : {}),
  };
  const decideStore = new DecideStore({ documentClient: w.db, tableName: "signin", now: () => w.clock.now });
  const deps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
    ...(options.sessions === false ? {} : { agentSessions: sessionDeps }), ...(audit === undefined ? {} : { audit: audit.audit }),
  } as unknown as ApprovalDependencies;
  const kind = approvalDecideKind(deps);
  const context = (kinds: DecideKinds = { apr: kind }): DecideRequestContext => ({
    store: decideStore, now: () => w.clock.now, cellOrigin: CELL, kinds,
    authenticateBearer: async (authorization) => {
      const found = new Map<string, { developerId: string; orgId: OrgId }>([["Bearer max", { developerId: MAX, orgId: ORG_A }], ["Bearer priya", { developerId: PRIYA, orgId: ORG_A }]]).get(authorization);
      if (found === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
      return found;
    },
  });
  deps.mintConfirmUrl = (who, approvalId) => mintConfirmUrl(context(), { developerId: who.developerId, orgId: who.orgId }, approvalId);
  registerSessionTakeOverApprovals();
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
  const ask = (who: string, sessionId: string, requestId: string = randomUUID()) => askTakeOver(sessionDeps, w.caller(who), sessionId, { requestId }, deps);
  /** Asks and answers with the approval's id. */
  const asked = async (who: string, sessionId: string) => {
    const reply = await ask(who, sessionId);
    if (reply.status !== 202) throw new Error("expected 202");
    const confirmation = NeedsConfirmationSchema.parse(reply.body);
    return { approvalId: new URL(confirmation.confirmUrl).pathname.split("/").pop()!, confirmation };
  };
  const confirm = async (who: string, approvalId: string, agoSeconds = 30) => decide(approvalId, await browser(who, approvalId, agoSeconds));
  const approvalOf = async (approvalId: string) => (await getAnyApproval(deps, ORG_A, approvalId))!;
  const meta = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Item;
  const events = (sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith("EVENT#"));
  const taskOf = (taskId: string) => w.db.get(taskKey(taskId)) as unknown as DeveloperTaskRecord & Item;
  /** The creator's task-list row, and the session's live tile, as the start writes them. */
  const seedRows = (sessionId: string, taskId: string, owner = PRIYA) => {
    w.db.set({ ...taskIndexKey(owner, CREATED_AT, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, orgId: ORG_A, project: "web", title: "Bump the Stripe SDK", client: "app", status: "RUNNING", shared: false, startingRevision: 1, workspaceId: "w", createdAt: CREATED_AT, updatedAt: CREATED_AT });
    w.db.set({ ...liveSessionKey(ORG_A, sessionId), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId, kind: "task", project: "web", ownerId: owner, status: "running", createdAt: CREATED_AT, updatedAt: CREATED_AT });
    w.db.set({ ...mySessionsKey(ORG_A, owner, CREATED_AT, sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId, developerId: owner, createdAt: CREATED_AT });
  };
  const feed = (developerId: string) => w.db.find((item) => item.pk === changesKey(ORG_A, developerId, CREATED_AT, 0).pk);
  return { ...w, audit, store, sessionDeps, deps, kind, context, browser, decide, ask, asked, confirm, approvalOf, meta, events, taskOf, seedRows, feed, admissions, paths, live, published, chainCalls, decideStore };
}
type World = ReturnType<typeof world>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const sessionSeed = (w: World, options: Parameters<World["seedSession"]>[0] = {}) => {
  const seeded = w.seedSession(options);
  if ((options.kind ?? "task") === "task") w.seedRows(seeded.sessionId, seeded.taskId, options.owner ?? PRIYA);
  return seeded;
};

describe("asking to take a session over", () => {
  it("checks the taker's budget for a process-layer task on the same floor as a Rovara Code task (TASK)", async () => {
    const w = world();
    const plain = sessionSeed(w);
    await w.ask(MAX, plain.sessionId);
    const layer = sessionSeed(w);
    w.db.set({ ...w.taskOf(layer.taskId), agent: { agentId: "agt_pppppppppppppppppppp", name: "web process", version: 1, builtin: false, process: true, digest: "d".repeat(64) } });
    await w.ask(MAX, layer.sessionId);
    expect(w.paths).toEqual(["TASK", "TASK"]);
  });

  it("answers 202 with the ticketed link and the changes, and changes nothing until it is confirmed", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const before = { meta: structuredClone(w.meta(sessionId)), task: structuredClone(w.taskOf(taskId)), items: w.db.items.size };
    const reply = await w.ask(MAX, sessionId);
    expect(reply.status).toBe(202);
    const confirmation = NeedsConfirmationSchema.parse(reply.body);
    expect(confirmation).toMatchObject({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" });
    expect(confirmation.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/apr_[0-9a-z]{20}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(confirmation.changes).toEqual(['Max becomes the owner of "Bump the Stripe SDK".', "New AI spend counts against Max's budget.", 'Priya keeps "can edit".']);
    const record = await w.approvalOf(new URL(confirmation.confirmUrl).pathname.split("/").pop()!);
    expect(record).toMatchObject({
      kind: "change", status: "PENDING", requestedBy: MAX, subject: { kind: "session_owner", sessionId, to: MAX, sessionRevision: 1 },
      approvers: { kind: "rule", rule: "session_take_over", candidates: [MAX] },
    });
    // Nothing about the session moved: only the approval's own items were written.
    expect(w.meta(sessionId)).toEqual(before.meta);
    expect(w.taskOf(taskId)).toEqual(before.task);
    expect(w.events(sessionId)).toEqual([]);
    expect(w.admissions).toEqual([{ developerId: MAX, project: "web" }]);
  });

  it("answers a repeat of the request with the same approval, and writes no second one", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const requestId = randomUUID();
    const first = NeedsConfirmationSchema.parse((await w.ask(MAX, sessionId, requestId)).body);
    const second = NeedsConfirmationSchema.parse((await w.ask(MAX, sessionId, requestId)).body);
    expect(new URL(second.confirmUrl).pathname).toBe(new URL(first.confirmUrl).pathname);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(1);
  });

  it("refuses the owner with the exact words, a person with less than edit naming it, and a person with no role that can start work with the exact words", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    expect(await code(w.ask(PRIYA, sessionId))).toEqual({ code: "CONFIG_INVALID", message: "You already own this session." });
    // An org admin with no grant has only `view` (I5); a contributor too.
    for (const who of [OLA, ARJUN]) expect(await code(w.ask(who, sessionId))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: 'You need "can edit" on this session to take it over. Ask Priya to share it with you.' });
    // A viewer of the project with an edit share is capped at view.
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "edit");
    expect(await code(w.ask(MIA, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    // A member with an edit share and no role on the project cannot start work there.
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "edit");
    expect(await code(w.ask(ZED, sessionId))).toEqual({ code: "FORBIDDEN", message: START_WORK });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });

  it("does not need a Slack link or a channel: a maintainer with neither asks", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    expect((await w.ask(MAX, sessionId)).status).toBe(202);
  });

  it("refuses a session on a Mac with SESSION_ON_MAC and writes no approval", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w, { kind: "local" });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MAX }, "edit");
    expect(await code(w.ask(MAX, sessionId))).toEqual({ code: "SESSION_ON_MAC", message: "This session runs on Priya's Mac. Ask Priya to move it to the cloud first." });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });

  it("refuses a session that has ended, and another org's person with 404", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w, { ended: true });
    expect(await code(w.ask(MAX, sessionId))).toMatchObject({ code: "SESSION_ENDED" });
    const open = sessionSeed(w);
    expect(await code(askTakeOver(w.sessionDeps, w.caller(BO, "org_bbbbbbbbbbbbbbbbbbbb"), open.sessionId, { requestId: randomUUID() }, w.deps))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a body with a field it does not take or a bad request id, and with no approvals set up says it is unavailable", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    expect(await code(askTakeOver(w.sessionDeps, w.caller(MAX), sessionId, { requestId: randomUUID(), extra: 1 }, w.deps))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(askTakeOver(w.sessionDeps, w.caller(MAX), sessionId, { requestId: "nope" }, w.deps))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(askTakeOver(w.sessionDeps, w.caller(MAX), sessionId, { requestId: randomUUID() }, undefined))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses with the budget refusal and writes nothing when the taker would pay and has no room", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.live.budgetRefusal = BUDGET_TEXT;
    expect(await code(w.ask(MAX, sessionId))).toEqual({ code: "BUDGET_EXCEEDED", message: BUDGET_TEXT });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });

  it("asks no admission when the payer is not a member (a project pays and keeps paying)", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.db.set({ ...w.taskOf(taskId), payer: { kind: "project", project: "web" } });
    w.live.budgetRefusal = BUDGET_TEXT;
    const { confirmation } = await w.asked(MAX, sessionId);
    expect(confirmation.changes[1]).toBe("New AI spend counts against the web project's budget.");
    expect(w.admissions).toEqual([]);
  });
});

describe("confirming a take-over", () => {
  it("moves the owner, the task's current owner and payer, the taker's list row and the previous owner's access, in one transaction with the event and the audit item", async () => {
    const w = world({ audit: true });
    const { sessionId, taskId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const done = await w.confirm(MAX, approvalId, 5 * 60);
    expect(done.statusCode, done.body).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: MAX });
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX, name: "Max" }, revision: 2, lastTakeOverApprovalId: approvalId, payer: { kind: "member", developerId: MAX } });
    const task = w.taskOf(taskId);
    expect(task.currentOwner).toMatchObject({ developerId: MAX, name: "Max", provider: "oidc", since: "2026-10-22T09:00:00.000Z" });
    expect(task.payer).toEqual({ kind: "member", developerId: MAX });
    expect(effectiveTaskOwner(task).developerId).toBe(MAX);
    // The creator's own fields and the task's principal are history and never move.
    expect(task).toMatchObject({ developerId: PRIYA, developerName: "Priya", ownerKey: `owner-${PRIYA.slice(0, 6)}` });
    expect(w.db.get(taskIndexKey(MAX, CREATED_AT, taskId))).toMatchObject({ taskId, orgId: ORG_A, project: "web", title: "Bump the Stripe SDK", status: "RUNNING" });
    expect(w.db.get(taskIndexKey(PRIYA, CREATED_AT, taskId))).toBeDefined();
    expect(w.db.get(mySessionsKey(ORG_A, MAX, CREATED_AT, sessionId))).toMatchObject({ sessionId, developerId: MAX });
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ ownerId: MAX });
    // The previous owner keeps "can edit", through a share and its index item.
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `SHARE#MEMBER#${PRIYA}`))).toMatchObject({ principal: { kind: "member", developerId: PRIYA }, level: "edit", sharedBy: { developerId: MAX } });
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: PRIYA }, sessionId))).toMatchObject({ level: "edit" });
    const access = await resolveSessionAccess(w.sessionDeps, w.caller(PRIYA), sessionId);
    expect(access).toMatchObject({ level: "edit", owner: false, effectiveOwner: { developerId: MAX } });
    expect((await resolveSessionAccess(w.sessionDeps, w.caller(MAX), sessionId)).owner).toBe(true);
    // The event, exact, written last in the same transaction.
    const [event] = w.events(sessionId);
    expect(SessionEventSchema.parse(Object.fromEntries(Object.entries(event!).filter(([key]) => !["pk", "sk", "entityType", "orgId", "sessionId", "indexExpiresAt"].includes(key))))).toMatchObject({
      type: "take_over", text: "Max took over from Priya.", actor: { kind: "member", developerId: MAX, name: "Max" },
    });
    const transaction = w.db.transactions().find((entries) => entries.some((entry) => (entry.Put as { Item?: Item } | undefined)?.Item?.type === "take_over"))!;
    expect(transaction).toBeDefined();
    expect((Object.values(transaction.at(-1)!)[0] as { Item?: Item }).Item?.pk).not.toBeUndefined();
    const audited = w.audit!.recordedBy("session.owner_changed");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actor: { kind: "member" }, target: { kind: "session", id: sessionId }, facts: { sessionKind: "task", payerMoved: true }, related: [PRIYA, taskId] });
    expect(JSON.stringify(audited[0])).not.toMatch(/Priya|Max|Stripe/u);
    expect(w.audit!.recordedBy("approval.decided")).toHaveLength(1);
  });

  it("tells the previous owner (feed and channel), the session's channel and the followers, with ids and a revision only", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.follower(ORG_A, sessionId, ARJUN);
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    const channels = w.published.map((entry) => entry.channel);
    expect(channels).toEqual(expect.arrayContaining([sessionChannel(ORG_A, sessionId as never), userChannel(ORG_A, PRIYA), userChannel(ORG_A, ARJUN)]));
    for (const entry of w.published) for (const text of entry.events) expect(JSON.parse(text)).toMatchObject({ type: "session.updated", sessionId });
    expect(w.feed(PRIYA).length).toBeGreaterThan(0);
    expect(JSON.stringify(w.published)).not.toMatch(/Priya|Max|Stripe/u);
  });

  it("is not applied by a browser signed in eleven minutes ago, or by a token, and a fresh sign-in applies it", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const stale = await w.browser(MAX, approvalId, 11 * 60);
    const request = (headers: Record<string, string>) => ({ method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, headers, body: "{}" });
    const staleError = await requireDecideSession(w.context(), request({ cookie: `${DECIDE_COOKIE}=${stale}` })).then(() => undefined, (error: { code: string; details?: { signInUrl?: string } }) => error);
    expect(staleError).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(staleError?.details?.signInUrl).toContain(approvalId);
    for (const bearer of ["Bearer max"]) {
      const token = await requireDecideSession(w.context(), request({ authorization: bearer })).then(() => undefined, (error: { code: string; statusCode: number }) => error);
      expect(token).toMatchObject({ code: "REAUTH_REQUIRED", statusCode: 401 });
    }
    expect((await w.decide(approvalId, stale)).statusCode).not.toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "PENDING" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    expect((await w.confirm(MAX, approvalId, 30)).statusCode).toBe(200);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX });
  });

  it("lets only the person who asked decide it, and only while they still can: the page refuses them when they were demoted", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const rule = getApproverRule("session_take_over")!;
    const record = await w.approvalOf(approvalId);
    const caller = (developerId: string) => ({ orgId: ORG_A, developerId, orgRole: "member" as const });
    expect(await rule(w.deps, record, caller(MAX))).toBe(true);
    expect(await rule(w.deps, record, caller(PRIYA))).toBe(false);
    expect(await rule(w.deps, record, caller(OLA))).toBe(false);
    // Demoted to a viewer between asking and confirming.
    w.grant(MAX, "web", "viewer");
    expect(await rule(w.deps, record, caller(MAX))).toBe(false);
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: MAX, approvalId })).toMatchObject({ status: "forbidden" });
    expect(await code(w.confirm(MAX, approvalId).then((reply) => { if (reply.statusCode === 200) throw new Error("applied"); return undefined; }))).toBeUndefined();
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
  });

  it("shows the page's facts: the session, the project, who owns it now, the new owner, who pays from now and when it expires", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const inspected = await w.kind.inspect({ orgId: ORG_A, developerId: MAX, approvalId });
    expect(inspected).toMatchObject({ status: "open", view: { title: "Take over a session" } });
    const view = (inspected as { view: { facts: Array<{ label: string; value: string }>; paragraphs: string[] } }).view;
    expect(Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]))).toMatchObject({
      Session: "Bump the Stripe SDK", Project: "web", "Owner now": "Priya", "New owner": "Max", "Who pays from now": "Max's budget",
    });
    expect(view.facts.map((fact) => fact.label)).toContain("Expires");
    expect(view.paragraphs).toEqual(['Max becomes the owner of "Bump the Stripe SDK".', "New AI spend counts against Max's budget.", 'Priya keeps "can edit".']);
  });

  it("ends the approval APPROVED_FAILED with the exact text when the session changed since it was asked (two confirmations at the same revision: one applies)", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    w.grant(ARJUN, "web", "maintainer");
    const first = await w.asked(MAX, sessionId);
    const second = await w.asked(ARJUN, sessionId);
    expect((await w.confirm(MAX, first.approvalId)).statusCode).toBe(200);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX });
    const lost = await w.confirm(ARJUN, second.approvalId);
    expect(lost.statusCode).toBe(200);
    expect(await w.approvalOf(second.approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: CHANGED_TEXT });
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX }, revision: 2, lastTakeOverApprovalId: first.approvalId });
  });

  it("returns done when the handler is called again for the one that applied (a lost answer), and writes nothing", async () => {
    const w = world({ audit: true });
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    const record = await w.approvalOf(approvalId);
    const before = { items: w.db.items.size, transactions: w.db.transactions().length, events: w.events(sessionId).length, audited: w.audit!.recordedBy("session.owner_changed").length };
    await getApprovalSubjectHandler("session_owner")!(w.deps, record);
    expect({ items: w.db.items.size, transactions: w.db.transactions().length, events: w.events(sessionId).length, audited: w.audit!.recordedBy("session.owner_changed").length }).toEqual(before);
  });

  it("is not made to fail by a follow or a summary refresh between asking and confirming", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    // A follow (follower count), a summary refresh (summary revision) and a presence-like event do not touch the revision.
    w.db.set({ ...w.meta(sessionId), followerCount: 3, summaryRevision: 7, summary: { ...(w.meta(sessionId).summary as Item), status: "needs_person" } });
    w.follower(ORG_A, sessionId, ARJUN);
    expect((await w.confirm(MAX, approvalId)).statusCode).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_DONE" });
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX }, followerCount: 3, summaryRevision: 7, revision: 2 });
  });

  it("ends APPROVED_FAILED with the budget text when the taker has no room at confirmation, and changes nothing", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    w.live.budgetRefusal = BUDGET_TEXT;
    expect((await w.confirm(MAX, approvalId)).statusCode).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: BUDGET_TEXT });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    expect(w.taskOf(taskId).currentOwner).toBeUndefined();
  });

  it("ends APPROVED_FAILED with the exact text when no session dependencies are set up", async () => {
    const w = world({ sessions: false });
    const { sessionId } = sessionSeed(w);
    // The ask has its own dependencies; the approvals' own are the ones missing.
    const { approvalId } = await w.asked(MAX, sessionId);
    const record = await w.approvalOf(approvalId);
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, { ...record, status: "EXECUTING", decidedBy: MAX })).rejects.toThrow(NOT_SET_UP);
  });

  it("refuses to apply for a taker who lost edit, an owner who is now the taker, or a session that ended, with words, and writes nothing", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const record = { ...(await w.approvalOf(approvalId)), status: "EXECUTING" as const, decidedBy: MAX };
    w.grant(MAX, "web", "contributor");
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, record)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    w.grant(MAX, "web", "maintainer");
    w.db.set({ ...w.meta(sessionId), endedAt: "2026-10-22T08:45:00.000Z" });
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, record)).rejects.toMatchObject({ code: "SESSION_ENDED" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    // An approval nobody decided is never applied: the take-over would be credited to the asker.
    const undecided: Partial<typeof record> = { ...record };
    delete undecided.decidedBy;
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, undecided as typeof record)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("who pays after a take-over", () => {
  it("makes the taker the explicit payer of a task that recorded none, and the next key's tags name them", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const first = paymentOfTask(w.taskOf(taskId));
    expect(first.payer).toEqual({ kind: "member", developerId: PRIYA });
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    const after = paymentOfTask(w.taskOf(taskId));
    expect(after.payer).toEqual({ kind: "member", developerId: MAX });
    expect(mintTagsFor({ payer: after.payer, place: after.place, agentId: after.agentId, origin: "app", taskId }).payerId).toBe(MAX);
    // A key minted before keeps the first payer: the tags were taken then.
    expect(mintTagsFor({ payer: first.payer, place: first.place, agentId: first.agentId, origin: "app", taskId }).payerId).toBe(PRIYA);
  });

  it("moves a member payer who was not the owner to the taker too, and keeps a project payer as it is", async () => {
    const member = world({ audit: true });
    const a = sessionSeed(member);
    member.db.set({ ...member.taskOf(a.taskId), payer: { kind: "member", developerId: ARJUN } });
    await member.confirm(MAX, (await member.asked(MAX, a.sessionId)).approvalId);
    expect(member.taskOf(a.taskId).payer).toEqual({ kind: "member", developerId: MAX });
    expect(member.audit!.recordedBy("session.owner_changed")[0]).toMatchObject({ facts: { payerMoved: true } });

    const project = world({ audit: true });
    const b = sessionSeed(project);
    project.db.set({ ...project.taskOf(b.taskId), payer: { kind: "project", project: "web" } });
    await project.confirm(MAX, (await project.asked(MAX, b.sessionId)).approvalId);
    expect(project.taskOf(b.taskId).payer).toEqual({ kind: "project", project: "web" });
    expect(project.meta(b.sessionId).payer).toBeUndefined();
    expect(project.audit!.recordedBy("session.owner_changed")[0]).toMatchObject({ facts: { payerMoved: false } });
  });
});

describe("a chain session", () => {
  const seedChain = (w: World) => {
    const seeded = w.seedSession({ kind: "chain" });
    w.seedShare(ORG_A, seeded.sessionId, { kind: "member", developerId: MAX }, "edit");
    return seeded;
  };

  it("moves the run's owner and member payer through the chain mover in the same transaction, and the running step's task as a task is moved", async () => {
    const w = world({ chain: true });
    const { sessionId } = seedChain(w);
    const stepTask = randomUUID();
    w.db.set({ ...taskKey(stepTask), entityType: "DEVELOPER_TASK", taskId: stepTask, orgId: ORG_A, developerId: PRIYA, developerName: "Priya", provider: "oidc", project: "web", workspaceId: randomUUID(), ownerKey: "k", createdAt: CREATED_AT, updatedAt: CREATED_AT, chain: { chainRunId: sessionId, stepId: "s1" }, payer: { kind: "member", developerId: PRIYA } });
    w.live.stepTaskId = stepTask;
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX }, revision: 2 });
    expect(w.db.get({ pk: `CHAIN_RUN#${sessionId}`, sk: "OWNER" })).toMatchObject({ owner: MAX, payerMovesTo: MAX });
    expect(w.taskOf(stepTask).currentOwner).toMatchObject({ developerId: MAX });
    expect(w.taskOf(stepTask).payer).toEqual({ kind: "member", developerId: MAX });
    // One transaction held the session, the run and the step.
    const together = w.db.transactions().some((entries) => entries.some((entry) => (entry.Put as { Item?: Item } | undefined)?.Item?.pk === `CHAIN_RUN#${sessionId}`) && entries.some((entry) => (entry.Update as { Key?: Item } | undefined)?.Key?.pk === `DEVTASK#${stepTask}`));
    expect(together).toBe(true);
  });

  it("keeps a chain-paid run's payer and records payerMoved false", async () => {
    const w = world({ chain: true, audit: true });
    const { sessionId } = seedChain(w);
    w.live.chainPayer = { kind: "project", project: "web" };
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    expect(w.chainCalls[0]).toMatchObject({ payer: { kind: "project" } });
    expect(w.db.get({ pk: `CHAIN_RUN#${sessionId}`, sk: "OWNER" })).toMatchObject({ owner: MAX });
    expect(w.db.get({ pk: `CHAIN_RUN#${sessionId}`, sk: "OWNER" })?.payerMovesTo).toBeUndefined();
    expect(w.audit!.recordedBy("session.owner_changed")[0]).toMatchObject({ facts: { sessionKind: "chain", payerMoved: false } });
  });

  it("says it is not available when Plan 4's chain mover is not supplied, and writes no approval", async () => {
    const w = world();
    const { sessionId } = seedChain(w);
    expect(await code(w.ask(MAX, sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toEqual([]);
  });
});

describe("a Slack-shared task with a People list", () => {
  it("is taken over by a member with no Slack link: every other owner is lowered in the transaction, dispatch stays ALLOWED for the taker, and the creator is no authority", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w, { people: [{ developerId: PRIYA, role: "owner" }, { developerId: ARJUN, role: "owner" }, { developerId: ZED, role: "commenter" }] });
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    const people = w.db.get(`DEVTASK#${taskId}`, "PEOPLE") as unknown as { revision: number; orphaned: boolean; people: Array<{ developerId: string; role: string }> };
    expect(Object.fromEntries(people.people.map((entry) => [entry.developerId, entry.role]))).toEqual({ [PRIYA]: "commenter", [ARJUN]: "commenter", [ZED]: "commenter" });
    expect(people).toMatchObject({ revision: 2, orphaned: false });
    const task = w.taskOf(taskId);
    const dispatch = await resolveTaskDispatchPeople({ documentClient: w.db, tableName: "state", checkTaskPerson: async () => { throw new Error("no Slack proof"); } }, task);
    expect(dispatch).toEqual({ peopleRevision: 2, ownerActorIds: [taskOwnerKey(MAX, taskId)], status: "ALLOWED" });
  });

  it("fails the whole take-over (writes nothing) when the People list changed between the read and the write, and applies on the next confirmation", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w, { people: [{ developerId: PRIYA, role: "owner" }] });
    const { approvalId } = await w.asked(MAX, sessionId);
    let moved = false;
    const original = w.db.send;
    w.db.send = async (command) => {
      if (!moved && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("lastTakeOverApprovalId")) {
        moved = true;
        w.db.set({ ...(w.db.get(`DEVTASK#${taskId}`, "PEOPLE") as Item), revision: 9 });
      }
      return original(command);
    };
    await w.confirm(MAX, approvalId);
    expect(moved).toBe(true);
    // The write was refused whole: the session and the task are as they were, and the approval says why.
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    expect(w.taskOf(taskId).currentOwner).toBeUndefined();
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: CHANGED_TEXT });
  });
});

describe("a take-over of a task already taken over (A to B to C)", () => {
  it("fences on the owner it read: the second taker moves it from the first, whose owner entry is lowered, and the history keeps the creator", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w, { people: [{ developerId: PRIYA, role: "commenter" }, { developerId: MAX, role: "owner" }] });
    // Max took it over earlier (written as the earlier take-over wrote it).
    w.db.set({ ...w.taskOf(taskId), currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: "2026-10-22T08:30:00.000Z" } });
    w.db.set({ ...w.meta(sessionId), owner: { developerId: MAX, name: "Max" }, revision: 2 });
    w.grant(ARJUN, "web", "maintainer");
    const { approvalId } = await w.asked(ARJUN, sessionId);
    await w.confirm(ARJUN, approvalId);
    expect(w.taskOf(taskId).currentOwner).toMatchObject({ developerId: ARJUN });
    expect(w.taskOf(taskId)).toMatchObject({ developerId: PRIYA });
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: ARJUN }, revision: 3 });
    expect(w.events(sessionId).map((event) => event.text)).toEqual(["Arjun took over from Max."]);
    const people = w.db.get(`DEVTASK#${taskId}`, "PEOPLE") as unknown as { people: Array<{ developerId: string; role: string }> };
    expect(Object.fromEntries(people.people.map((entry) => [entry.developerId, entry.role]))).toEqual({ [PRIYA]: "commenter", [MAX]: "commenter" });
  });

  it("refuses a second take-over that read the owner before another landed, and leaves the first intact", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.grant(ARJUN, "web", "maintainer");
    const second = await w.asked(ARJUN, sessionId);
    // Another take-over lands on the task after the handler read it but before it writes (the owner fence), with the session revision as asked.
    let landed = false;
    const original = w.db.send;
    w.db.send = async (command) => {
      if (!landed && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("lastTakeOverApprovalId")) {
        landed = true;
        w.db.set({ ...w.taskOf(taskId), currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: "2026-10-22T09:00:00.000Z" } });
      }
      return original(command);
    };
    await w.confirm(ARJUN, second.approvalId);
    expect(landed).toBe(true);
    expect(w.taskOf(taskId).currentOwner).toMatchObject({ developerId: MAX });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    expect(await w.approvalOf(second.approvalId)).toMatchObject({ status: "APPROVED_FAILED", failure: CHANGED_TEXT });
  });
});

describe("old data", () => {
  it("takes over a session stored before payers, live tiles and list rows were kept (none of them there): only what exists is moved", async () => {
    const w = world();
    const { sessionId, taskId } = w.seedSession();
    const { approvalId } = await w.asked(MAX, sessionId);
    expect((await w.confirm(MAX, approvalId)).statusCode).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_DONE" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX });
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toBeUndefined();
    expect(w.db.get(taskIndexKey(MAX, CREATED_AT, taskId))).toMatchObject({ taskId, orgId: ORG_A });
  });
});

describe("the route", () => {
  const route = (w: World, who: string, method: string, sessionId: string, body?: unknown) => routeAgentSessionRequest(
    { ...w.sessionDeps, origin: CELL, approvals: w.deps as never, taskView: async () => ({}) as never },
    w.caller(who), { method, path: `/v1/app/sessions/${sessionId}/take-over`, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    new URL(`${CELL}/v1/app/sessions/${sessionId}/take-over`),
  );

  it("answers POST /v1/app/sessions/{id}/take-over with a 202 whose body is the confirmation, and refuses any other method", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const answer = await route(w, MAX, "POST", sessionId, { requestId: randomUUID() });
    expect(answer).toBeInstanceOf(StatusReply);
    expect((answer as StatusReply).statusCode).toBe(202);
    expect(NeedsConfirmationSchema.parse((answer as StatusReply).body)).toMatchObject({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" });
    for (const method of ["GET", "PUT", "DELETE"]) expect(await code(route(w, MAX, method, sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers a body that is not JSON with CONFIG_INVALID, and the owner with the exact words", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    expect(await code(route(w, PRIYA, "POST", sessionId, { requestId: randomUUID() }))).toEqual({ code: "CONFIG_INVALID", message: "You already own this session." });
    expect(await code(route(w, MAX, "POST", sessionId, { requestId: 5 }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("lists a pending take-over among what the asker may decide on the session", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const { decidingOf } = await import("../../packages/broker/src/agent-sessions/routes.js");
    const listed = await decidingOf(w.deps as never).approvals({ orgId: ORG_A, developerId: MAX, orgRole: "member" } as never, { sessionId, subject: { kind: "task", taskId: "t" } } as never);
    expect(listed).toEqual([{ approvalId, title: 'Max becomes the owner of "Bump the Stripe SDK".' }]);
  });
});

describe("faults and races", () => {
  const handler = () => getApprovalSubjectHandler("session_owner")!;
  const decided = async (w: World, sessionId: string) => ({ ...(await w.approvalOf((await w.asked(MAX, sessionId)).approvalId)), status: "EXECUTING" as const, decidedBy: MAX });

  it("answers a budget check that could not be made (the proxy is down) with a retryable fault at the ask and at the apply, never a refusal of the person", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const down = Object.assign(new Error("proxy"), { name: "AgentXError", code: "MODEL_PROXY_UNAVAILABLE" });
    w.sessionDeps.admitPayer = async () => { throw down; };
    expect(await code(w.ask(MAX, sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    w.sessionDeps.admitPayer = async () => undefined;
    const record = await decided(w, sessionId);
    w.sessionDeps.admitPayer = async () => { throw down; };
    await expect(handler()(w.deps, record)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
  });

  it("never applies a take-over that someone other than the person it names decided", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const record = await decided(w, sessionId);
    await expect(handler()(w.deps, { ...record, decidedBy: ARJUN })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
  });

  it("is refused whole when the session ended between the read and the write", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const record = await decided(w, sessionId);
    let ended = false;
    const original = w.db.send;
    w.db.send = async (command) => {
      if (!ended && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("lastTakeOverApprovalId")) { ended = true; w.db.set({ ...w.meta(sessionId), endedAt: "2026-10-22T09:00:00.000Z" }); }
      return original(command);
    };
    await expect(handler()(w.deps, record)).rejects.toThrow(`SESSION_REVISION_CONFLICT: ${CHANGED_TEXT}`);
    expect(ended).toBe(true);
    expect(w.taskOf(taskId).currentOwner).toBeUndefined();
  });

  it("tries again later when another transaction holds the same items at that moment, and is refused whole on any other fault", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const record = await decided(w, sessionId);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }] } });
    await expect(handler()(w.deps, record)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(handler()(w.deps, record)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
    expect(w.taskOf(taskId).currentOwner).toBeUndefined();
    // And then it applies, once.
    await handler()(w.deps, record);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX });
  });

  it("reads a session whose task is another org's as no session", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w, { taskOrgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(await code(w.ask(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("applies when the person who took it over has no recorded name: they are shown as 'a member' and stay the owner by id", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.db.set({ pk: `DEVELOPER#${MAX}`, sk: "META", developerId: MAX, provider: "oidc", displayName: "", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const { approvalId } = await w.asked(MAX, sessionId);
    expect((await w.confirm(MAX, approvalId)).statusCode).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_DONE" });
    expect(effectiveTaskOwner(w.taskOf(taskId))).toMatchObject({ developerId: MAX, name: "a member" });
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX, name: "a member" });
    expect(w.events(sessionId).map((event) => event.text)).toEqual(["a member took over from Priya."]);
  });
});

describe("what the first round of mutation showed was not yet pinned", () => {
  it("does not wait on a request that was declined: asking again under the same request id says it was decided", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const requestId = randomUUID();
    const first = NeedsConfirmationSchema.parse((await w.ask(MAX, sessionId, requestId)).body);
    const approvalId = new URL(first.confirmUrl).pathname.split("/").pop()!;
    expect((await w.decide(approvalId, await w.browser(MAX, approvalId), "decline")).statusCode).toBe(200);
    expect(await code(w.ask(MAX, sessionId, requestId))).toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("lets only the person the take-over names decide it: a record whose target is not its asker, or an asker who is not the caller, is refused even for someone who could take the session over", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const { approvalId } = await w.asked(MAX, sessionId);
    const record = await w.approvalOf(approvalId);
    const rule = getApproverRule("session_take_over")!;
    const caller = (developerId: string) => ({ orgId: ORG_A, developerId, orgRole: "member" as const });
    expect(await rule(w.deps, record, caller(MAX))).toBe(true);
    // Arjun holds edit and a role that starts work, but is not the asker.
    expect(await rule(w.deps, record, caller(ARJUN))).toBe(false);
    // A record naming someone else as the taker is not the asker's to decide.
    const other = { ...record, subject: { ...(record.subject as object), to: ARJUN } } as typeof record;
    expect(await rule(w.deps, other, caller(MAX))).toBe(false);
  });

  it("says exactly who may decide, on the page, to someone who may not", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: PRIYA, approvalId })).toEqual({ status: "forbidden", who: "the person who asked, while they can still take the session over" });
  });

  it("applies with the exact event id, the decision's proof in the audit event, and the taker's Slack id on the task when they have one", async () => {
    const w = world({ audit: true });
    const { sessionId, taskId } = sessionSeed(w);
    w.db.set({ pk: `DEVELOPER#${MAX}`, sk: "META", developerId: MAX, provider: "slack", displayName: "Max", slackUserId: "U0MAX00001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const { approvalId } = await w.asked(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    expect(w.events(sessionId).map((event) => event.eventId)).toEqual([sessionEventId("take_over", approvalId)]);
    expect(w.audit!.recordedBy("session.owner_changed")[0]).toMatchObject({ proof: { kind: "fresh_sign_in", method: "email_code" } });
    expect(w.taskOf(taskId).currentOwner).toMatchObject({ developerId: MAX, provider: "slack", slackUserId: "U0MAX00001" });
  });

  it("does not tell the taker as if someone else had changed their session: a taker who follows it gets no feed notice", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.follower(ORG_A, sessionId, MAX);
    w.follower(ORG_A, sessionId, ARJUN);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(w.feed(MAX)).toEqual([]);
    expect(w.feed(ARJUN).length).toBeGreaterThan(0);
  });

  it("ends with the code CONFIG_INVALID, not a retryable fault, when no session dependencies are set up", async () => {
    const w = world({ sessions: false });
    const { sessionId } = sessionSeed(w);
    const record = { ...(await w.approvalOf((await w.asked(MAX, sessionId)).approvalId)), status: "EXECUTING" as const, decidedBy: MAX };
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, record)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses an approval nobody decided with the words that say so", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const record: Partial<AnyApprovalRecord> = { ...(await w.approvalOf((await w.asked(MAX, sessionId)).approvalId)), status: "EXECUTING" };
    delete record.decidedBy;
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, record as AnyApprovalRecord)).rejects.toThrow("has not been decided by anyone");
  });

  it("is refused whole when the live tile vanished between the read and the write", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const { approvalId } = await w.asked(MAX, sessionId);
    const record = { ...(await w.approvalOf(approvalId)), status: "EXECUTING" as const, decidedBy: MAX };
    let gone = false;
    const original = w.db.send;
    w.db.send = async (command) => {
      if (!gone && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("lastTakeOverApprovalId")) { gone = true; w.db.delete(liveSessionKey(ORG_A, sessionId)); }
      return original(command);
    };
    await expect(getApprovalSubjectHandler("session_owner")!(w.deps, record)).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    expect(gone).toBe(true);
    expect(w.taskOf(taskId).currentOwner).toBeUndefined();
  });

  it("names the owner now from the task when the session's own copy of the owner is stale", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.grant(ARJUN, "web", "maintainer");
    w.db.set({ ...w.taskOf(taskId), currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: "2026-10-22T08:30:00.000Z" } });
    const { approvalId } = await w.asked(ARJUN, sessionId);
    const view = (await w.kind.inspect({ orgId: ORG_A, developerId: ARJUN, approvalId })) as { view: { facts: Array<{ label: string; value: string }> } };
    expect(view.view.facts.find((fact) => fact.label === "Owner now")?.value).toBe("Max");
  });

  it("lists only the take-over of this session among what the asker may decide on it", async () => {
    const w = world();
    const mine = sessionSeed(w);
    const other = sessionSeed(w);
    await w.asked(MAX, other.sessionId);
    const { decidingOf } = await import("../../packages/broker/src/agent-sessions/routes.js");
    const listed = await decidingOf(w.deps as never).approvals({ orgId: ORG_A, developerId: MAX, orgRole: "member" } as never, { sessionId: mine.sessionId, subject: { kind: "task", taskId: "t" } } as never);
    expect(listed).toEqual([]);
  });
});

describe("a taker merged into another member between the request and the decision (12b review I-1)", () => {
  /** Max's account is merged into Arjun's: the sign-in record says so, and the member movers run as the merge sweep runs them. */
  const mergeMaxIntoArjun = async (w: World) => {
    w.db.set({ ...(w.db.get(`DEVELOPER#${MAX}`, "META") as Item), mergedInto: ARJUN });
    await onMembersMerged(w.deps, { orgId: ORG_A, survivorId: ARJUN, duplicateId: MAX });
  };

  it("moves the pending take-over to the survivor, who decides it, and the merged-away id never becomes the owner", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const { approvalId } = await w.asked(MAX, sessionId);
    await mergeMaxIntoArjun(w);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "PENDING", subject: { kind: "session_owner", to: ARJUN } });
    const done = await w.confirm(ARJUN, approvalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "APPROVED_DONE", decidedBy: ARJUN });
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: ARJUN, name: "Arjun" }, payer: { kind: "member", developerId: ARJUN } });
    expect(w.taskOf(taskId).currentOwner).toMatchObject({ developerId: ARJUN });
    expect(w.taskOf(taskId).payer).toEqual({ kind: "member", developerId: ARJUN });
    expect(w.db.get(mySessionsKey(ORG_A, ARJUN, CREATED_AT, sessionId))).toBeDefined();
    expect(w.db.get(mySessionsKey(ORG_A, MAX, CREATED_AT, sessionId))).toBeUndefined();
    expect(w.db.get(taskIndexKey(MAX, CREATED_AT, taskId))).toBeUndefined();
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ ownerId: ARJUN });
  });

  it("applies when only the stored target is the merged-away id (a record the mover has not reached yet)", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    const { approvalId } = await w.asked(MAX, sessionId);
    w.db.set({ ...(w.db.get(`DEVELOPER#${MAX}`, "META") as Item), mergedInto: ARJUN });
    const record = { ...(await w.approvalOf(approvalId)), status: "EXECUTING" as const, decidedBy: ARJUN };
    await getApprovalSubjectHandler("session_owner")!(w.deps, record);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: ARJUN });
  });
});

describe("approvals already waiting when the session is taken over (12b review I-2)", () => {
  /** A write approval the previous owner's run is waiting on, listed for them as Plan 3 lists it. */
  const waitingWrite = async (w: World, taskId: string, approvalId = "apr_aaaaaaaaaaaaaaaaaaaa") => {
    const made = await createWriteApprovalRecord({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, {
      orgId: ORG_A, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create a Linear issue", class: "consequential", approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: [PRIYA] }, status: "PENDING", project: "web",
      owner: { developerId: PRIYA, name: "Priya" }, attempts: 0, createdAt: "2026-10-22T08:30:00.000Z", expiresAt: "2026-10-29T08:30:00.000Z",
    } as never, [], 8);
    expect(made).toBe("created");
    return approvalId;
  };
  const listed = async (w: World, developerId: string) => (await listApprovalsFor(w.deps, { orgId: ORG_A, developerId, orgRole: "member" })).map((record) => record.approvalId);

  it("lists them for the taker and no longer for the previous owner, and shows the taker what they may decide on the session", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const approvalId = await waitingWrite(w, taskId);
    expect(await listed(w, PRIYA)).toEqual([approvalId]);
    expect(await listed(w, MAX)).toEqual([]);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(await listed(w, MAX)).toEqual([approvalId]);
    expect(await listed(w, PRIYA)).toEqual([]);
    expect(await w.approvalOf(approvalId)).toMatchObject({ status: "PENDING", owner: { developerId: MAX, name: "Max" } });
    const { decidingOf } = await import("../../packages/broker/src/agent-sessions/routes.js");
    const deciding = await decidingOf(w.deps as never).approvals({ orgId: ORG_A, developerId: MAX, orgRole: "member" } as never, { sessionId, subject: { kind: "task", taskId } } as never);
    expect(deciding).toEqual([{ approvalId, title: "Create a Linear issue" }]);
  });

  it("leaves the previous owner's row when they still hold approve_writes on the project, and leaves other tasks' approvals alone", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.grant(PRIYA, "web", "maintainer");
    const mine = await waitingWrite(w, taskId);
    const other = sessionSeed(w);
    const elsewhere = await waitingWrite(w, other.taskId, "apr_bbbbbbbbbbbbbbbbbbbb");
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect((await listed(w, PRIYA)).sort()).toEqual([mine, elsewhere].sort());
    expect(await listed(w, MAX)).toEqual([mine]);
    expect(await w.approvalOf(elsewhere)).toMatchObject({ owner: { developerId: PRIYA } });
  });

  // Approvals routed to a list of ids: being listed and holding start_tasks IS the authority to decide, so the previous owner must leave the list unless they qualify on their own.
  const waitingByIds = async (w: World, taskId: string, ids: string[], approvalId = "apr_cccccccccccccccccccc") => {
    const made = await createWriteApprovalRecord({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, {
      orgId: ORG_A, approvalId, kind: "write", subject: { kind: "agent_run", taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create a Linear issue", class: "consequential", approvers: { kind: "ids", ids }, status: "PENDING", project: "web",
      owner: { developerId: PRIYA, name: "Priya" }, attempts: 0, createdAt: "2026-10-22T08:30:00.000Z", expiresAt: "2026-10-29T08:30:00.000Z",
    } as never, [], 8);
    expect(made).toBe("created");
    return approvalId;
  };
  const mayDecide = async (w: World, developerId: string, approvalId: string) =>
    mayDecideApproval(w.deps, { orgId: ORG_A, developerId, orgRole: "member" }, await w.approvalOf(approvalId));

  it("takes the previous owner out of an approval routed to ids, so they can no longer decide it, and the taker can", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const approvalId = await waitingByIds(w, taskId, [PRIYA]);
    expect(await mayDecide(w, PRIYA, approvalId)).toBe(true);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(((await w.approvalOf(approvalId)).approvers as unknown as { ids: string[] }).ids).toEqual([MAX]);
    expect(await mayDecide(w, PRIYA, approvalId)).toBe(false);
    expect(await mayDecide(w, MAX, approvalId)).toBe(true);
  });

  it("keeps a previous owner who is a maintainer of the project (they qualify on their own), and no one else on the list", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.grant(PRIYA, "web", "maintainer");
    const approvalId = await waitingByIds(w, taskId, [PRIYA, ARJUN]);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(((await w.approvalOf(approvalId)).approvers as unknown as { ids: string[] }).ids.sort()).toEqual([ARJUN, MAX, PRIYA].sort());
    expect(await mayDecide(w, PRIYA, approvalId)).toBe(true);
  });

  it("fails closed when the previous owner's role cannot be read: they leave the list instead of staying on it", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.grant(PRIYA, "web", "maintainer");
    const approvalId = await waitingByIds(w, taskId, [PRIYA]);
    const asked = await w.asked(MAX, sessionId);
    const roleOf = w.members.roleOf;
    w.members.roleOf = (orgId, project, who) => (who.developerId === PRIYA ? Promise.reject(new Error("the roster is down")) : roleOf(orgId, project, who));
    await w.confirm(MAX, asked.approvalId);
    w.members.roleOf = roleOf;
    expect(((await w.approvalOf(approvalId)).approvers as unknown as { ids: string[] }).ids).toEqual([MAX]);
    expect(await listed(w, PRIYA)).toEqual([]);
  });

  it("finishes the move when the handler is told again after a lost answer", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    const approvalId = await waitingWrite(w, taskId);
    const asked = await w.asked(MAX, sessionId);
    await w.confirm(MAX, asked.approvalId);
    // The follow-up was lost: the mark is still owed, the previous owner's row is back and the record still names them.
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `TAKE_OVER_FOLLOW_UP#${asked.approvalId}`))).toBeUndefined();
    w.db.set({ ...agentSessionKey(ORG_A, sessionId, `TAKE_OVER_FOLLOW_UP#${asked.approvalId}`), entityType: "AGENT_SESSION_TAKE_OVER_FOLLOW_UP", orgId: ORG_A, sessionId, taskId, from: PRIYA, to: MAX, toName: "Max", project: "web" });
    w.db.set({ ...approverIndexKey(ORG_A, PRIYA, approvalId), entityType: "APPROVER_INDEX", approvalId });
    w.db.set({ ...(w.db.get(approvalKey(ORG_A, approvalId)) as Item), owner: { developerId: PRIYA, name: "Priya" } });
    const record = { ...(await w.approvalOf(asked.approvalId)), status: "EXECUTING" as const, decidedBy: MAX };
    await getApprovalSubjectHandler("session_owner")!(w.deps, record);
    expect(await listed(w, MAX)).toEqual([approvalId]);
    expect(await listed(w, PRIYA)).toEqual([]);
  });
});

describe("what a take-over leaves behind in the lists and on the tile (12b review minors)", () => {
  /** The live tile as the summary refresh writes it, owner and revision included. */
  const seedTile = (w: World, sessionId: string, owner = PRIYA) => w.db.set({ ...liveSessionKey(ORG_A, sessionId), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId, kind: "task", project: "web", ownerId: owner, owner: { developerId: owner, name: "Priya" }, revision: 1, status: "running", createdAt: CREATED_AT, updatedAt: CREATED_AT });

  it("updates the live tile's owner, owner name and revision together", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    seedTile(w, sessionId);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ ownerId: MAX, owner: { developerId: MAX, name: "Max" }, revision: 2 });
  });

  it("is not undone by a summary refresh that read the session before the take-over: the refresh looks again and writes the new owner", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    seedTile(w, sessionId);
    const { approvalId } = await w.asked(MAX, sessionId);
    const original = w.db.send;
    let raced = false;
    w.db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("summaryRevision")) {
        raced = true;
        w.db.send = original;
        await w.confirm(MAX, approvalId);
      }
      return original(command);
    };
    await refreshSessionSummary({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A, sessionId);
    expect(raced).toBe(true);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: MAX });
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ ownerId: MAX, owner: { developerId: MAX }, revision: 2 });
  });

  it("takes the session out of the previous owner's own list and leaves it in their shared list", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(w.db.get(mySessionsKey(ORG_A, PRIYA, CREATED_AT, sessionId))).toBeUndefined();
    expect(w.db.get(mySessionsKey(ORG_A, MAX, CREATED_AT, sessionId))).toBeDefined();
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: PRIYA }, sessionId))).toMatchObject({ level: "edit" });
  });

  it("A to B to C: the middle owner's task-list row and own-session row go too, and the creator's task-list row stays as history", async () => {
    const w = world();
    const { sessionId, taskId } = sessionSeed(w);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    await w.confirm(MAX, (await w.asked(MAX, sessionId)).approvalId);
    expect(w.db.get(taskIndexKey(MAX, CREATED_AT, taskId))).toBeDefined();
    const second = await w.asked(ARJUN, sessionId);
    const decided = await w.decide(second.approvalId, await w.browser(ARJUN, second.approvalId));
    expect(decided.statusCode, decided.body).toBe(200);
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: ARJUN });
    expect(w.db.get(taskIndexKey(ARJUN, CREATED_AT, taskId))).toBeDefined();
    expect(w.db.get(taskIndexKey(MAX, CREATED_AT, taskId))).toBeUndefined();
    expect(w.db.get(mySessionsKey(ORG_A, MAX, CREATED_AT, sessionId))).toBeUndefined();
    expect(w.db.get(taskIndexKey(PRIYA, CREATED_AT, taskId))).toBeDefined();
    expect(w.db.get(sharedSessionsKey(ORG_A, { kind: "member", developerId: MAX }, sessionId))).toMatchObject({ level: "edit" });
  });
});

describe("a previous owner who was erased or removed (ERASE-NAME-2)", () => {
  it("names an erased owner as 'A former member' in the approval's changes, the take-over event and the 'owner now' error, though the session stored the real name", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    expect(NeedsConfirmationSchema.parse((await w.ask(MAX, sessionId)).body).changes).toContain('Priya keeps "can edit".');
    await eraseChosenName(w.db, "state", PRIYA, CREATED_AT);
    const { approvalId, confirmation } = await w.asked(MAX, sessionId);
    expect(confirmation.changes).toEqual(['Max becomes the owner of "Bump the Stripe SDK".', "New AI spend counts against Max's budget.", `${FORMER_MEMBER_NAME} keeps "can edit".`]);
    expect(JSON.stringify(await w.approvalOf(approvalId))).not.toContain("Priya");
    const decided = await w.confirm(MAX, approvalId);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(w.events(sessionId).map((event) => event.text)).toEqual([`Max took over from ${FORMER_MEMBER_NAME}.`]);
    // Someone who is not the owner and may not take it over is told whom to ask by the same name.
    const refused = await code(w.ask(ZED, sessionId));
    expect(JSON.stringify(refused)).not.toContain("Priya");
  });

  it("names an erased owner who came back 'A former member' for a session from before the new membership (ERASED-REJOIN-NAME), and a session of the new membership by the new name", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    // The session began at CREATED_AT, before the erase; the person came back and chose a new name afterwards.
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, erased: true, erasedAt: CREATED_AT, name: "Pri Newname", chosenAt: new Date(Date.parse(CREATED_AT) + 86_400_000).toISOString() });
    const { approvalId, confirmation } = await w.asked(MAX, sessionId);
    expect(confirmation.changes.at(-1)).toBe(`${FORMER_MEMBER_NAME} keeps "can edit".`);
    expect(JSON.stringify(await w.approvalOf(approvalId))).not.toContain("Priya");
    expect(JSON.stringify(await w.approvalOf(approvalId))).not.toContain("Pri Newname");
    // A session that began after the new name was chosen shows the new name.
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!;
    w.db.set({ ...meta, createdAt: new Date(Date.parse(CREATED_AT) + 2 * 86_400_000).toISOString() });
    forgetResolvedNames();
    const later = await w.asked(MAX, sessionId);
    expect(later.confirmation.changes.at(-1)).toBe('Pri Newname keeps "can edit".');
  });

  it("names a removed owner by the placeholder, never the name stored with the session", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    w.db.set({ ...chosenNameKey(PRIYA), entityType: "DEVELOPER_NAME", developerId: PRIYA, removed: true, removedAt: CREATED_AT });
    w.db.delete(orgMemberKey(ORG_A, PRIYA));
    const { confirmation } = await w.asked(MAX, sessionId);
    expect(confirmation.changes.at(-1)).toBe(`${placeholderDisplayName(PRIYA)} keeps "can edit".`);
  });

  it("shows a generic name when the name lookup fails, and still lets the take-over be asked", async () => {
    const w = world();
    const { sessionId } = sessionSeed(w);
    const send = w.db.send.bind(w.db);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    w.db.send = ((command: Parameters<typeof send>[0]) => (command instanceof BatchGetCommand ? Promise.reject(new Error("throttled")) : send(command)));
    try {
      const { confirmation } = await w.asked(MAX, sessionId);
      expect(confirmation.changes.at(-1)).toBe('A member keeps "can edit".');
    } finally {
      w.db.send = send;
      quiet.mockRestore();
    }
  });
});
