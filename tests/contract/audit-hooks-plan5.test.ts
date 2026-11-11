// Plan 5 Task 22: the audit ledger records the three Plan 5 changes that move authority or widen who sees a session: a confirmed take-over
// (`session.owner_changed`), a confirmed company-wide share (`session.shared`) and a change to the company's rules for local agents
// (`local_agents.policy_changed`, one event per changed field). Each event is added to the action's own DynamoDB transaction (the outbox, ruling R70) and
// flushed after the commit. Comments, follows, messages, per-person and per-project shares and the removal of a share are not recorded.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_FACT_KEYS, AUDIT_TARGET_KINDS, AuditEventInputSchema, auditEventId, orgSettingsKey, type AuditEventInput, type LocalAgentPolicy, type OrgRole } from "@agentx/cloud-contracts";
import { LOCAL_TOOLS, agentSessionKey, agentXError, liveSessionKey, mySessionsKey, type OrgId } from "@rovara-code/contracts";
import { checkChain, genesisHash, type AuditRecordV1 } from "@rovara/audit-verifier";
import { appendOne, type AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeKms } from "../support/fake-kms.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getAnyApproval, getApprovalSubjectHandler, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { deleteSessionShare, putSessionShare, registerSessionShareApprovals } from "../../packages/broker/src/agent-sessions/shares.js";
import { askTakeOver, registerSessionTakeOverApprovals, type SessionTakeOverDependencies } from "../../packages/broker/src/agent-sessions/take-over.js";
import { auditLocalAgentsPolicyChanged, auditSessionOwnerChanged, auditSessionSharedOrg } from "../../packages/broker/src/audit/events.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { taskIndexKey, taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { routeDeviceRequest, type DeviceRouteDependencies } from "../../packages/broker/src/devices/routes.js";
import { NeedsConfirmationSchema } from "@rovara-code/contracts";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps, hangingAuditDeps, type AuditCapture } from "../support/audit-capture.js";
import { ARJUN, CELL, MAX, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Item = Record<string, unknown>;
type Entry = Record<string, { Item?: Item; Key?: Item } | undefined>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CREATED_AT = "2026-10-22T08:00:00.000Z";
const FULL: LocalAgentPolicy = { allowed: true, tools: [...LOCAL_TOOLS], projects: "all" };
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const PEOPLE_WORDS = /Priya|Max\b|Arjun|Ola|Maya|Omar|Stripe|@/u;

// ---- the sessions: a take-over and a company-wide share

type CaptureKind = "capturing" | "hanging" | "none";

function sessionsWorld(capture: CaptureKind = "capturing") {
  const w = sessionWorld();
  const audit: AuditCapture | undefined = capture === "none" ? undefined : (capture === "hanging" ? hangingAuditDeps : capturingAuditDeps)({ db: w.db, now: () => w.clock.now });
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const sessionDeps: SessionTakeOverDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore,
    admitPayer: async () => undefined,
  };
  const decideStore = new DecideStore({ documentClient: w.db, tableName: "signin", now: () => w.clock.now });
  const deps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
    agentSessions: sessionDeps, ...(audit === undefined ? {} : { audit: audit.audit }),
  } as unknown as ApprovalDependencies;
  const kind = approvalDecideKind(deps);
  const context = (kinds: DecideKinds = { apr: kind }): DecideRequestContext => ({
    store: decideStore, now: () => w.clock.now, cellOrigin: CELL, kinds,
    authenticateBearer: async () => { throw agentXError("AUTH_REQUIRED", "a valid sign-in is required"); },
  });
  deps.mintConfirmUrl = (who, approvalId) => mintConfirmUrl(context(), { developerId: who.developerId, orgId: who.orgId }, approvalId);
  registerSessionShareApprovals();
  registerSessionTakeOverApprovals();
  let counter = 0;
  const confirm = async (developerId: string, approvalId: string, agoSeconds = 30) => {
    counter += 1;
    const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
    const signedInAt = Math.floor(w.clock.now / 1000) - agoSeconds;
    await decideStore.putSession(cookie, { orgId: ORG_A, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 3600 });
    return routeDecidePage(context(), {
      method: "POST", path: `/v1/app/approve/${approvalId}`, requestId: "r",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString(),
    }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
  };
  const idOf = (body: unknown) => new URL(NeedsConfirmationSchema.parse(body).confirmUrl).pathname.split("/").pop()!;
  /** Asks to share with the whole company and returns the approval's id. */
  const askShare = async (who: string, sessionId: string, level: "view" | "use" | "edit" = "view") => {
    const reply = await putSessionShare(sessionDeps, w.caller(who), sessionId, { requestId: randomUUID(), principal: { kind: "org" }, level }, deps);
    if (reply.status !== 202) throw new Error("expected 202");
    return idOf(reply.body);
  };
  const askOver = async (who: string, sessionId: string) => {
    const reply = await askTakeOver(sessionDeps, w.caller(who), sessionId, { requestId: randomUUID() }, deps);
    if (reply.status !== 202) throw new Error("expected 202");
    return idOf(reply.body);
  };
  /** A task session with the rows the start writes for it. */
  const seed = (options: Parameters<typeof w.seedSession>[0] = {}) => {
    const seeded = w.seedSession(options);
    if ((options.kind ?? "task") === "task") {
      const owner = options.owner ?? PRIYA;
      w.db.set({ ...taskIndexKey(owner, CREATED_AT, seeded.taskId), entityType: "DEVELOPER_TASK_INDEX", taskId: seeded.taskId, orgId: ORG_A, project: "web", title: "Bump the Stripe SDK", client: "app", status: "RUNNING", shared: false, startingRevision: 1, workspaceId: "w", createdAt: CREATED_AT, updatedAt: CREATED_AT });
      w.db.set({ ...liveSessionKey(ORG_A, seeded.sessionId), entityType: "LIVE_SESSION", orgId: ORG_A, sessionId: seeded.sessionId, kind: "task", project: "web", ownerId: owner, status: "running", createdAt: CREATED_AT, updatedAt: CREATED_AT });
      w.db.set({ ...mySessionsKey(ORG_A, owner, CREATED_AT, seeded.sessionId), entityType: "MY_SESSION", orgId: ORG_A, sessionId: seeded.sessionId, developerId: owner, createdAt: CREATED_AT });
    }
    return seeded;
  };
  const transactions = () => w.db.transactions() as unknown as Entry[][];
  const approvalOf = async (approvalId: string) => (await getAnyApproval(deps, ORG_A, approvalId))!;
  const taskOf = (taskId: string) => w.db.get(taskKey(taskId)) as unknown as DeveloperTaskRecord & Item;
  const meta = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Item;
  return { ...w, audit, sessionDeps, deps, confirm, askShare, askOver, seed, transactions, approvalOf, taskOf, meta };
}
type SessionsWorld = ReturnType<typeof sessionsWorld>;

const isPending = (entry: Entry): boolean => { const pk = entry.Put?.Item?.pk; return typeof pk === "string" && pk.startsWith("AUDIT_PENDING#"); };
const pendingEvents = (entries: Entry[]): AuditEventInput[] => entries.filter(isPending).map((entry) => (entry.Put!.Item as unknown as { event: AuditEventInput }).event);
/** The transaction that holds an item the test names: the audit item must be in this very one. */
const transactionWith = (w: SessionsWorld, has: (entry: Entry) => boolean): Entry[] => {
  const found = w.transactions().filter((entries) => entries.some(has));
  expect(found).toHaveLength(1);
  return found[0]!;
};
const putsSk = (prefix: string) => (entry: Entry) => { const sk = entry.Put?.Item?.sk; return typeof sk === "string" && sk.startsWith(prefix); };

describe("the catalog", () => {
  it("lists the three new actions with their facts, and the session target kind", () => {
    for (const action of ["session.owner_changed", "session.shared", "local_agents.policy_changed"] as const) expect(AUDIT_ACTIONS).toContain(action);
    expect(AUDIT_FACT_KEYS["session.owner_changed"]).toEqual(["sessionKind", "payerMoved"]);
    expect(AUDIT_FACT_KEYS["session.shared"]).toEqual(["level", "principalKind"]);
    expect(AUDIT_FACT_KEYS["local_agents.policy_changed"]).toEqual(["field", "from", "to"]);
    expect(AUDIT_TARGET_KINDS).toContain("session");
  });

  it("builds events that fit the schema, with ids that a retry repeats and a later occurrence does not", () => {
    const base = { orgId: ORG_A, actor: { kind: "member", id: PRIYA } as const, occurredAt: "2026-10-22T09:00:00.000Z" };
    const shared = auditSessionSharedOrg({ ...base, occurrence: "apr_aaaaaaaaaaaaaaaaaaaa", sessionId: "ses_1", level: "view", related: [PRIYA] });
    expect(AuditEventInputSchema.parse(shared)).toMatchObject({ action: "session.shared", target: { kind: "session", id: "ses_1" }, facts: { level: "view", principalKind: "org" } });
    expect(shared.eventId).toBe(auditEventId("session.shared", "apr_aaaaaaaaaaaaaaaaaaaa"));
    expect(auditSessionSharedOrg({ ...base, occurrence: "apr_aaaaaaaaaaaaaaaaaaaa", sessionId: "ses_1", level: "view", related: [PRIYA] }).eventId).toBe(shared.eventId);
    expect(auditSessionSharedOrg({ ...base, occurrence: "apr_bbbbbbbbbbbbbbbbbbbb", sessionId: "ses_1", level: "view" }).eventId).not.toBe(shared.eventId);

    const rule = (revision: number, field: string) => auditLocalAgentsPolicyChanged({ ...base, occurrence: String(revision), field, from: "a", to: "b" });
    expect(AuditEventInputSchema.parse(rule(3, "tools"))).toMatchObject({ action: "local_agents.policy_changed", target: { kind: "org", id: ORG_A }, facts: { field: "tools", from: "a", to: "b" } });
    expect(rule(3, "tools").eventId).toBe(auditEventId("local_agents.policy_changed", "3", "tools"));
    expect(rule(3, "tools").eventId).toBe(rule(3, "tools").eventId);
    expect(rule(3, "tools").eventId).not.toBe(rule(3, "projects").eventId);
    expect(rule(3, "tools").eventId).not.toBe(rule(4, "tools").eventId);
    expect(auditSessionOwnerChanged({ ...base, occurrence: "apr_x", sessionId: "ses_1", sessionKind: "task", payerMoved: false }).facts).toEqual({ sessionKind: "task", payerMoved: false });
  });
});

describe("a confirmed take-over", () => {
  it("commits session.owner_changed in the transaction that moves the owner, with a member payer moved and the decision recorded", async () => {
    const w = sessionsWorld();
    const { sessionId, taskId } = w.seed();
    const approvalId = await w.askOver(MAX, sessionId);
    const done = await w.confirm(MAX, approvalId, 5 * 60);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX }, lastTakeOverApprovalId: approvalId });

    const transaction = transactionWith(w, (entry) => entry.Put?.Item?.type === "take_over");
    expect(transaction.some((entry) => entry.Update?.Key?.pk === agentSessionKey(ORG_A, sessionId, "META").pk && entry.Update.Key.sk === "META")).toBe(true);
    const inTransaction = pendingEvents(transaction);
    expect(inTransaction.map((event) => event.action)).toEqual(["session.owner_changed"]);
    expect(inTransaction[0]).toMatchObject({
      eventId: auditEventId("session.owner_changed", approvalId), orgId: ORG_A, actor: { kind: "member", id: MAX }, target: { kind: "session", id: sessionId },
      facts: { sessionKind: "task", payerMoved: true }, related: [PRIYA, taskId],
    });
    const recorded = w.audit!.recordedBy("session.owner_changed");
    expect(recorded).toHaveLength(1);
    // After the commit it was sent to the queue and its pending item deleted.
    expect(w.audit!.flushed().filter((event) => event.action === "session.owner_changed")).toHaveLength(1);
    expect(w.audit!.pending()).toEqual([]);
    // The decision of the same approval is in the ledger beside it.
    expect(w.audit!.recordedBy("approval.decided")).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toMatch(PEOPLE_WORDS);
  });

  it("says a project payer did not move", async () => {
    const w = sessionsWorld();
    const { sessionId, taskId } = w.seed();
    w.db.set({ ...w.taskOf(taskId), payer: { kind: "project", project: "web" } });
    await w.confirm(MAX, await w.askOver(MAX, sessionId));
    expect(w.audit!.recordedBy("session.owner_changed")).toMatchObject([{ facts: { sessionKind: "task", payerMoved: false } }]);
  });

  it("records it once when the handler is told again after the answer was lost", async () => {
    const w = sessionsWorld();
    const { sessionId } = w.seed();
    const approvalId = await w.askOver(MAX, sessionId);
    await w.confirm(MAX, approvalId);
    const before = { transactions: w.transactions().length, recorded: w.audit!.recordedBy("session.owner_changed").length };
    await getApprovalSubjectHandler("session_owner")!(w.deps, await w.approvalOf(approvalId));
    expect({ transactions: w.transactions().length, recorded: w.audit!.recordedBy("session.owner_changed").length }).toEqual({ transactions: before.transactions, recorded: 1 });
  });

  it("goes through when the audit queue never answers, and leaves the event pending for the drain", async () => {
    const w = sessionsWorld("hanging");
    const { sessionId } = w.seed();
    const approvalId = await w.askOver(MAX, sessionId);
    expect((await w.confirm(MAX, approvalId)).statusCode).toBe(200);
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: MAX } });
    expect(w.audit!.pending().filter((event) => event.action === "session.owner_changed")).toHaveLength(1);
  }, 20_000);

  it("adds nothing to the transaction on an install with no ledger", async () => {
    const w = sessionsWorld("none");
    const { sessionId } = w.seed();
    expect((await w.confirm(MAX, await w.askOver(MAX, sessionId))).statusCode).toBe(200);
    expect(w.transactions().some((entries) => entries.some(isPending))).toBe(false);
  });
});

describe("a company-wide share", () => {
  it("commits session.shared in the transaction that writes the share, the index item and the revision", async () => {
    const w = sessionsWorld();
    const { sessionId, taskId } = w.seed();
    const approvalId = await w.askShare(PRIYA, sessionId, "use");
    // Asking records nothing: the change has not been made.
    expect(w.audit!.recordedBy("session.shared")).toEqual([]);
    const done = await w.confirm(PRIYA, approvalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "SHARE#ORG"))).toMatchObject({ level: "use" });

    const transaction = transactionWith(w, putsSk("SHARE#ORG"));
    expect(transaction.some((entry) => entry.Update?.Key?.sk === "META")).toBe(true);
    const inTransaction = pendingEvents(transaction);
    expect(inTransaction.map((event) => event.action)).toEqual(["session.shared"]);
    expect(inTransaction[0]).toMatchObject({
      eventId: auditEventId("session.shared", approvalId), orgId: ORG_A, actor: { kind: "member", id: PRIYA }, target: { kind: "session", id: sessionId },
      facts: { level: "use", principalKind: "org" }, related: [PRIYA, taskId], proof: { kind: "fresh_sign_in", method: "email_code" },
    });
    expect(w.audit!.recordedBy("session.shared")).toHaveLength(1);
    // After the commit it was sent to the queue and its pending item deleted.
    expect(w.audit!.flushed().filter((event) => event.action === "session.shared")).toHaveLength(1);
    expect(w.audit!.pending()).toEqual([]);
    expect(w.audit!.recordedBy("approval.decided")).toHaveLength(1);
    expect(JSON.stringify(w.audit!.recorded())).not.toMatch(PEOPLE_WORDS);
  });

  it("credits the share to the person who confirmed it, who may be an editor other than the owner", async () => {
    const w = sessionsWorld();
    const { sessionId } = w.seed();
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MAX }, "edit");
    await w.confirm(MAX, await w.askShare(MAX, sessionId));
    expect(w.audit!.recordedBy("session.shared")).toMatchObject([{ actor: { kind: "member", id: MAX }, related: [PRIYA, expect.any(String)] }]);
  });

  it("records it once when the handler is told again, and again for a later change of level under its own approval", async () => {
    const w = sessionsWorld();
    const { sessionId } = w.seed();
    const first = await w.askShare(PRIYA, sessionId, "view");
    await w.confirm(PRIYA, first);
    await getApprovalSubjectHandler("session_share_org")!(w.deps, await w.approvalOf(first));
    expect(w.audit!.recordedBy("session.shared")).toHaveLength(1);
    const second = await w.askShare(PRIYA, sessionId, "edit");
    await w.confirm(PRIYA, second);
    const events = w.audit!.recordedBy("session.shared");
    expect(events.map((event) => event.facts)).toEqual([{ level: "view", principalKind: "org" }, { level: "edit", principalKind: "org" }]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records nothing for a share with a person or a project, a share taken back, or a share that was only asked for", async () => {
    const w = sessionsWorld();
    const { sessionId } = w.seed({ project: null });
    await putSessionShare(w.sessionDeps, w.caller(PRIYA), sessionId, { requestId: randomUUID(), principal: { kind: "member", developerId: ARJUN }, level: "use" }, w.deps);
    await putSessionShare(w.sessionDeps, w.caller(PRIYA), sessionId, { requestId: randomUUID(), principal: { kind: "project", project: "ops" }, level: "view" }, w.deps);
    await deleteSessionShare(w.sessionDeps, w.caller(PRIYA), sessionId, `MEMBER#${ARJUN}`);
    await w.askShare(PRIYA, sessionId);
    expect(w.audit!.recorded()).toEqual([]);
    expect(w.transactions().some((entries) => entries.some(isPending))).toBe(false);
  });

  it("goes through when the audit queue never answers, and leaves the event pending for the drain", async () => {
    const w = sessionsWorld("hanging");
    const { sessionId } = w.seed();
    expect((await w.confirm(PRIYA, await w.askShare(PRIYA, sessionId))).statusCode).toBe(200);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "SHARE#ORG"))).toBeDefined();
    expect(w.audit!.pending().map((event) => event.action).filter((action) => action === "session.shared")).toHaveLength(1);
  }, 20_000);

  it("adds nothing to the transaction on an install with no ledger", async () => {
    const w = sessionsWorld("none");
    const { sessionId } = w.seed();
    expect((await w.confirm(PRIYA, await w.askShare(PRIYA, sessionId))).statusCode).toBe(200);
    expect(w.transactions().some((entries) => entries.some(isPending))).toBe(false);
  });
});

describe("the ledger accepts the new actions", () => {
  it("appends them to the chain, and the verifier's chain check passes over them", async () => {
    // The events a real run of each site made, taken from the capture, go through the appender and the verifier's own chain check.
    const sessions = sessionsWorld();
    const { sessionId } = sessions.seed();
    await sessions.confirm(PRIYA, await sessions.askShare(PRIYA, sessionId));
    const second = sessions.seed();
    await sessions.confirm(MAX, await sessions.askOver(MAX, second.sessionId));
    const rules = rulesWorld();
    await rules.put(rules.as(OLA), { allowed: false, tools: ["codex"], projects: ["web"] }, 0);
    const events = [...sessions.audit!.recorded(), ...rules.audit!.recorded()].filter((event) => ["session.shared", "session.owner_changed", "local_agents.policy_changed"].includes(event.action));
    expect(events.map((event) => event.action).sort()).toEqual(["local_agents.policy_changed", "local_agents.policy_changed", "local_agents.policy_changed", "session.owner_changed", "session.shared"]);

    const db = new FakeDynamoDb();
    const kms = new FakeKms(KEY_ARN);
    const clock = { now: Date.parse("2026-10-22T10:00:00.000Z") };
    const keyring = new AuditKeyring({ documentClient: db as never, keysTable: "keys", kms: kms.client, keyId: KEY_ARN, now: () => clock.now });
    const deps: AppenderDeps = { documentClient: db as never, ledgerTable: "ledger", keyring, now: () => clock.now, log: () => undefined, sleep: async () => undefined };
    for (const event of events) expect(await appendOne(deps, event)).toBe("appended");
    // A repeat of an event is recognised, not appended twice.
    expect(await appendOne(deps, events[0]!)).toBe("duplicate");
    const records = db.find((entry) => entry.pk === `AUDIT#${ORG_A}` && String(entry.sk).startsWith("SEQ#")).sort((left, right) => String(left.sk).localeCompare(String(right.sk)))
      .map((entry) => { const { pk: _pk, sk: _sk, sealedDetails: _sealed, ...record } = entry; void _pk; void _sk; void _sealed; return record as unknown as AuditRecordV1; });
    expect(records).toHaveLength(5);
    expect(checkChain(records, { seq: 0, hash: genesisHash(ORG_A), orgId: ORG_A })).toStrictEqual({ ok: true });
    expect(records.map((record) => record.action).sort()).toEqual(events.map((event) => event.action).sort());
    // The project names are in the sealed details, never in the record the chain hashes.
    expect(JSON.stringify(records)).not.toMatch(/"web"/u);
  });
});

// ---- the company's rules for local agents

function rulesWorld(capture: CaptureKind = "capturing") {
  const w = sessionWorld();
  const audit: AuditCapture | undefined = capture === "none" ? undefined : (capture === "hanging" ? hangingAuditDeps : capturingAuditDeps)({ db: w.db, now: () => w.clock.now });
  const deps: DeviceRouteDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined, ...(audit === undefined ? {} : { audit: audit.audit }) };
  const as = (developerId: string, orgRole: OrgRole = "admin", orgId: OrgId = ORG_A): DeveloperCaller => ({ ...w.caller(developerId, orgId), orgRole });
  const put = (caller: DeveloperCaller, change: Partial<LocalAgentPolicy>, revision: number, requestId = randomUUID()) =>
    routeDeviceRequest(deps, caller, { method: "PUT", path: "/v1/app/org/local-agents", headers: {}, requestId: "r", body: JSON.stringify({ requestId, revision, policy: { ...FULL, ...change } }) }, new URL(`${CELL}/v1/app/org/local-agents`)) as Promise<{ policy: LocalAgentPolicy; revision: number }>;
  const transactions = () => w.db.transactions() as unknown as Entry[][];
  const policyItem = (orgId: OrgId = ORG_A) => w.db.get(orgSettingsKey(orgId, "LOCAL_AGENTS")) as Item | undefined;
  return { ...w, audit, deps, as, put, transactions, policyItem };
}

describe("a change to the company's rules for local agents", () => {
  it("records one event per changed field, in the transaction that writes the rule, with different ids", async () => {
    const w = rulesWorld();
    const stored = await w.put(w.as(OLA), { tools: ["claude-code", "codex"], projects: ["web", "ops"] }, 0);
    expect(stored.revision).toBe(1);
    const transaction = w.transactions().find((entries) => entries.some((entry) => entry.Put?.Item?.entityType === "ORG_LOCAL_AGENTS"))!;
    expect(transaction).toBeDefined();
    const inTransaction = pendingEvents(transaction);
    expect(inTransaction.map((event) => (event.facts as { field: string }).field).sort()).toEqual(["projects", "tools"]);
    expect(new Set(inTransaction.map((event) => event.eventId)).size).toBe(2);
    const tools = inTransaction.find((event) => (event.facts as { field: string }).field === "tools")!;
    const projects = inTransaction.find((event) => (event.facts as { field: string }).field === "projects")!;
    expect(tools).toMatchObject({
      eventId: auditEventId("local_agents.policy_changed", "1", "tools"), orgId: ORG_A, actor: { kind: "member", id: OLA }, target: { kind: "org", id: ORG_A },
      facts: { field: "tools", from: "rovara,claude-code,codex,gemini-cli,cursor-cli", to: "claude-code,codex" },
    });
    // A project's name is personal data: the facts hold only "all" or a count; the names go in the sealed details.
    expect(projects.facts).toEqual({ field: "projects", from: "all", to: 2 });
    expect(JSON.stringify(projects.facts)).not.toMatch(/web|ops/u);
    expect(projects.details).toEqual([{ subject: "org", fields: { projectsFrom: "all", projectsTo: "ops,web" } }]);
    expect(w.audit!.recordedBy("local_agents.policy_changed")).toHaveLength(2);
    // After the commit both were sent to the queue and their pending items deleted.
    expect(w.audit!.flushed()).toHaveLength(2);
    expect(w.audit!.pending()).toEqual([]);
    for (const event of w.audit!.recorded()) expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
  });

  it("records the switch as booleans and an empty list of tools as none", async () => {
    const w = rulesWorld();
    await w.put(w.as(OLA), { allowed: false, tools: [] }, 0);
    const byField = Object.fromEntries(w.audit!.recordedBy("local_agents.policy_changed").map((event) => [(event.facts as { field: string }).field, event.facts]));
    expect(byField).toEqual({
      allowed: { field: "allowed", from: true, to: false },
      tools: { field: "tools", from: "rovara,claude-code,codex,gemini-cli,cursor-cli", to: "none" },
    });
  });

  it("gives a later change under a later revision its own ids", async () => {
    const w = rulesWorld();
    await w.put(w.as(OLA), { allowed: false }, 0);
    await w.put(w.as(OLA), { allowed: true }, 1);
    const events = w.audit!.recordedBy("local_agents.policy_changed");
    expect(events.map((event) => event.facts)).toEqual([{ field: "allowed", from: true, to: false }, { field: "allowed", from: false, to: true }]);
    expect(events.map((event) => event.eventId)).toEqual([auditEventId("local_agents.policy_changed", "1", "allowed"), auditEventId("local_agents.policy_changed", "2", "allowed")]);
  });

  it("keeps a long list of projects inside the details limit", async () => {
    const w = rulesWorld();
    const names = Array.from({ length: 100 }, (_, index) => `project-${String(index).padStart(3, "0")}-${"x".repeat(40)}`);
    await w.put(w.as(OLA), { projects: names }, 0);
    const [event] = w.audit!.recordedBy("local_agents.policy_changed");
    expect(event).toBeDefined();
    expect(event!.facts).toEqual({ field: "projects", from: "all", to: 100 });
    const projectsTo = (event!.details as Array<{ fields: Record<string, string> }>)[0]!.fields.projectsTo!;
    expect(projectsTo.length).toBeLessThanOrEqual(500);
    expect(projectsTo.startsWith("project-000-")).toBe(true);
  });

  it("records nothing for a change that changes nothing, a repeat of the same request, a stale revision or a member's attempt", async () => {
    const w = rulesWorld();
    const requestId = randomUUID();
    await w.put(w.as(OLA), { allowed: false }, 0, requestId);
    expect(w.audit!.recordedBy("local_agents.policy_changed")).toHaveLength(1);
    const writes = w.transactions().length;
    // The same request again answers the first outcome.
    await w.put(w.as(OLA), { allowed: false }, 0, requestId);
    // The same rule again changes nothing.
    await w.put(w.as(OLA), { allowed: false }, 1);
    // A stale revision and a member are refused.
    await expect(w.put(w.as(OLA), { allowed: true }, 0)).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    await expect(w.put(w.as(ZED, "member"), { allowed: true }, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.audit!.recordedBy("local_agents.policy_changed")).toHaveLength(1);
    // Only the unchanged rule's request item was written.
    expect(w.transactions().length).toBe(writes + 1);
    expect(pendingEvents(w.transactions().at(-1)!)).toEqual([]);
  });

  it("is the org's own: another org's rule is unaffected and its events name that org", async () => {
    const w = rulesWorld();
    await w.put(w.as(OLA), { allowed: false }, 0);
    expect(w.policyItem(ORG_B)).toBeUndefined();
    expect(w.audit!.recorded().every((event) => event.orgId === ORG_A)).toBe(true);
  });

  it("goes through when the audit queue never answers, and leaves the events pending for the drain", async () => {
    const w = rulesWorld("hanging");
    const stored = await w.put(w.as(OLA), { allowed: false, tools: [] }, 0);
    expect(stored.revision).toBe(1);
    expect(w.policyItem()).toMatchObject({ allowed: false, revision: 1 });
    expect(w.audit!.pending().filter((event) => event.action === "local_agents.policy_changed")).toHaveLength(2);
  }, 20_000);

  it("adds nothing to the transaction on an install with no ledger", async () => {
    const w = rulesWorld("none");
    await w.put(w.as(OLA), { allowed: false }, 0);
    expect(w.transactions().some((entries) => entries.some(isPending))).toBe(false);
    expect(w.policyItem()).toMatchObject({ allowed: false, revision: 1 });
  });

  it("reaches the ledger through the developer API", async () => {
    const audit = capturingAuditDeps();
    const harness = await createDeveloperTaskBroker({ audit });
    seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const changed = await harness.dev(OMAR, "PUT", "/v1/app/org/local-agents", { requestId: randomUUID(), revision: 0, policy: { ...FULL, allowed: false } });
    expect(changed.status).toBe(200);
    expect(audit.recordedBy("local_agents.policy_changed")).toMatchObject([{ orgId: TEST_ORG, actor: { kind: "member", id: OMAR.developerId }, facts: { field: "allowed", from: true, to: false } }]);
    const denied = await harness.dev(MAYA, "PUT", "/v1/app/org/local-agents", { requestId: randomUUID(), revision: 1, policy: FULL });
    expect(denied.status).toBe(403);
    expect(audit.recordedBy("local_agents.policy_changed")).toHaveLength(1);
    expect(AUDIT_CAPTURE_TABLE).toBe("state");
  });
});
