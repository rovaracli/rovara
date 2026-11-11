import { afterProjectBootstrap } from "../support/transaction-audit.js";
// Task 18: the Audit Ledger's hooks in Plan 2's code. Each audited action adds its pending audit item to the DynamoDB transaction that
// commits the action, so the action and its audit item are written together or not at all; the flush after the commit is best effort.
//
// Sites: member role change, removal, leave, org close and invite acceptance (OrgStore); a sign-in method linked and unlinked
// (DeveloperSignInStore); a GitHub installation connected, bound from a request, disconnected, and changed by GitHub (the
// installation webhook); a staff decision on an allowed website; a person added to or removed from a project.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { setImmediate as nextMacrotask, setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FLUSH_DEADLINE_MS, auditEventId, auditOperatorId, developerOrgKey, githubConnectStateKey, githubInstallRequestKey, githubInstallRequestQueueKey, githubInstallationKey, orgGithubInstallRequestKey, orgGithubInstallationKey, orgInviteKey, orgMemberKey, orgMetaKey, trialGithubKey, type AuditEventInput } from "@agentx/cloud-contracts";
import { EGRESS_DOMAINS_PK, egressDomainsKey, orgProjectCatalogKey, projectMemberKey, projectRevisionKey, type EgressDomainsItem, type EgressOwner, type OrgId } from "@rovara-code/contracts";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { decideEgressDomain, putEgressDomains, type EgressDomainsDependencies } from "../../packages/broker/src/org/egress-domains.js";
import { removeProjectMember, setProjectMember, type ProjectMemberChangeDependencies } from "../../packages/broker/src/org/project-members.js";
import { auditRuntimeFromEnvironment } from "../../packages/broker/src/audit/runtime.js";
import { developerIdentityStores } from "../../packages/broker/src/aws/developer-identity.js";
import { DeveloperSignInStore, developerIdentityKey, signInIdentityKey } from "../../packages/broker/src/developer/store.js";
import {
  applyInstallationLifecycle, confirmGithubConnect, disconnectGithubInstallation, type GithubConnectionDependencies,
} from "../../packages/broker/src/org/github-connection.js";
import { bindRequestedInstallation, type InstallationCreatedPayload } from "../../packages/broker/src/org/github-install-requests.js";
import { unlockTrial } from "../../packages/broker/src/org/trial.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps, hangingAuditDeps, AUDIT_CAPTURE_TABLE, type AuditCapture } from "../support/audit-capture.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ENV, TEST_ORG } from "../support/orgs.js";
import { call, issuer as brokerIssuer, loadSlackBroker } from "../support/slack-broker.js";

// The first import of the broker module transforms its whole dependency graph, which can pass vitest's 10 s hook default.
beforeAll(loadSlackBroker, 60_000);
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------------------------------------------------
// The shared pieces
// ---------------------------------------------------------------------------------------------------------------------

type Tx = Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> } | undefined>>;

/** Every TransactWriteItems the fake receives, as sent, so a test can see what committed beside the audit item. */
function recordTransactions(db: FakeDynamoDb): Tx[] {
  const seen: Tx[] = [];
  const original = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
    if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") seen.push((command as { input: { TransactItems: Tx } }).input.TransactItems);
    return original(command);
  };
  return seen;
}

const keyText = (value: unknown): string => (typeof value === "string" ? value : "");
const isPendingItem = (item: Tx[number]) => keyText(item.Put?.Item?.pk).startsWith("AUDIT_PENDING#");
const pendingIn = (transaction: Tx) => transaction.filter(isPendingItem).map((item) => (item.Put!.Item as { event: AuditEventInput }).event);
/** The transactions that carry at least one audit item. */
const auditedTransactions = (seen: Tx[]) => seen.filter((transaction) => transaction.some(isPendingItem));
const writes = (transaction: Tx, pk: string, sk?: string) => transaction.some((item) => {
  const key = item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key;
  return key !== undefined && key.pk === pk && (sk === undefined || key.sk === sk);
});

/**
 * Runs a call to its end under fake timers: the flush's deadline timer is set only once the route has reached it, so time moves until the call is done.
 * The call also waits on real work (a first import, a slow disk), which takes as long as the machine is busy, so this keeps going until the call is done
 * (a fixed number of steps ended early on a loaded machine and left the deadline timer never moved: the test hung to its time limit). The real yield between steps (not faked) lets that work run.
 */
async function settle<T>(call: Promise<T>): Promise<T> {
  let finished = false;
  void call.then(() => { finished = true; }, () => { finished = true; });
  while (!finished) {
    await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    if (!finished) await nextMacrotask();
  }
  return call;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const errorOf = (answer: { body: Record<string, unknown> }) => answer.body.error as { code: string; message: string } | undefined;

// ---------------------------------------------------------------------------------------------------------------------
// Members: role, removal, leave, close, invite
// ---------------------------------------------------------------------------------------------------------------------

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

/** The broker with Omar an owner and Maya a member of the install's org, auditing through `capture`. */
async function orgBroker(capture: AuditCapture, options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const harness = await createDeveloperTaskBroker({ ...options, audit: capture, developerExtra: { endDeveloperSessions: async () => ({ ok: true as const }), ...options.developerExtra } });
  seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return { ...harness, transactions: recordTransactions(harness.db) };
}

function person(harness: Harness, name: string, role: "owner" | "admin" | "member"): Developer {
  const developerId = sha(name);
  const who: Developer = { developerId, name, provider: "oidc", sessionId: `s-${name}` };
  harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, email: `${name.toLowerCase()}@example.com`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(harness.db, developerId, { orgId: TEST_ORG, role });
  return who;
}

describe("member.role_changed", () => {
  it("records the change in the same transaction as the member record and the developer pointer", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    const requestId = randomUUID();
    const changed = await h.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId, role: "admin" });
    expect(changed.status).toBe(200);

    const [transaction, ...rest] = auditedTransactions(h.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, `MEMBER#${MAYA.developerId}`)).toBe(true);
    expect(writes(transaction!, `DEVELOPER_ORG#${MAYA.developerId}`)).toBe(true);
    expect(pendingIn(transaction!)).toEqual([{
      eventId: auditEventId("member.role_changed", auditOccurrence(requestId, MAYA.developerId, "admin")), orgId: TEST_ORG, action: "member.role_changed",
      actor: { kind: "member", id: OMAR.developerId }, target: { kind: "member", id: MAYA.developerId },
      occurredAt: expect.any(String) as string, facts: { fromRole: "member", toRole: "admin" },
    }]);
    expect(afterProjectBootstrap(capture.flushed()).map((event) => event.action)).toEqual(["member.role_changed"]);
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("one request id on different targets or roles records each change (the request id alone is not the occurrence)", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    const carl = person(h, "Carl", "member");
    const requestId = randomUUID();
    const change = (who: Developer, role: string) => h.dev(OMAR, "PUT", `/v1/app/org/members/${who.developerId}/role`, { requestId, role });
    expect((await change(MAYA, "admin")).status).toBe(200);
    expect((await change(carl, "admin")).status).toBe(200);
    expect((await change(MAYA, "owner")).status).toBe(200);
    const events = capture.recordedBy("member.role_changed");
    expect(events.map((event) => [event.target, event.facts])).toEqual([
      [{ kind: "member", id: MAYA.developerId }, { fromRole: "member", toRole: "admin" }],
      [{ kind: "member", id: carl.developerId }, { fromRole: "member", toRole: "admin" }],
      [{ kind: "member", id: MAYA.developerId }, { fromRole: "admin", toRole: "owner" }],
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
  });

  it("records nothing for a change to the role the person already has, and nothing for a refused change", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    const change = (who: Developer, role: string) => h.dev(OMAR, "PUT", `/v1/app/org/members/${who.developerId}/role`, { requestId: randomUUID(), role });
    expect((await change(MAYA, "member")).status).toBe(200);
    const refused = await change(OMAR, "member");
    expect(errorOf(refused)).toMatchObject({ code: "LAST_OWNER" });
    expect((await change({ ...MAYA, developerId: "f".repeat(64) }, "admin")).status).toBe(404);
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("commits the role and the audit item together or not at all", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    const failed = await h.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "admin" });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toMatchObject({ role: "member" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("answers as today when the intake queue never answers; the event waits as a pending item", async () => {
    const capture = hangingAuditDeps();
    const h = await orgBroker(capture);
    vi.useFakeTimers();
    const pending = h.dev(OMAR, "PUT", `/v1/app/org/members/${MAYA.developerId}/role`, { requestId: randomUUID(), role: "admin" });
    const changed = await settle(pending);
    expect(changed.status).toBe(200);
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toMatchObject({ role: "admin" });
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action)).toEqual(["member.role_changed"]);
  });
});

describe("member.removed and member.left", () => {
  it("records a removal by an owner in the transaction that deletes the member, naming the owner as the actor", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    const carl = person(h, "Carl", "admin");
    const removed = await h.dev(OMAR, "DELETE", `/v1/app/org/members/${carl.developerId}`);
    expect(removed.status).toBe(200);

    const [transaction, ...rest] = auditedTransactions(h.transactions);
    // The removal's own transaction (S0) holds the member delete and the event; the one after it is the removal's finish, which writes member.removal_completed.
    expect(rest).toHaveLength(1);
    expect(capture.recordedBy("member.removal_completed")).toHaveLength(1);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, `MEMBER#${carl.developerId}`)).toBe(true);
    const [event, ...more] = capture.recordedBy("member.removed");
    expect(more).toEqual([]);
    expect(event).toMatchObject({ orgId: TEST_ORG, actor: { kind: "member", id: OMAR.developerId }, target: { kind: "member", id: carl.developerId }, facts: { role: "admin" } });
    expect(capture.recordedBy("member.left")).toEqual([]);
    expect(pendingIn(transaction!)).toHaveLength(1);
  });

  it("records a person leaving as member.left, with the person as the actor", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status).toBe(200);
    expect(capture.recordedBy("member.removed")).toEqual([]);
    expect(capture.recordedBy("member.left")).toEqual([expect.objectContaining({
      orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId }, target: { kind: "member", id: MAYA.developerId }, facts: { role: "member" },
    })]);
    const [transaction] = auditedTransactions(h.transactions);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, `MEMBER#${MAYA.developerId}`)).toBe(true);
  });

  it("records nothing for a removal that is refused, and the audit item and the removal stand or fall together", async () => {
    const capture = capturingAuditDeps();
    const h = await orgBroker(capture);
    expect(errorOf(await h.dev(MAYA, "DELETE", `/v1/app/org/members/${OMAR.developerId}`))).toMatchObject({ code: "FORBIDDEN" });
    expect(errorOf(await h.dev(OMAR, "POST", "/v1/app/org/leave", { requestId: randomUUID() }))).toMatchObject({ code: "LAST_OWNER" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);

    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" } });
    expect((await h.dev(OMAR, "DELETE", `/v1/app/org/members/${MAYA.developerId}`)).status).toBeGreaterThanOrEqual(500);
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toBeDefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    // The retry removes and records once.
    expect((await h.dev(OMAR, "DELETE", `/v1/app/org/members/${MAYA.developerId}`)).status).toBe(200);
    expect(capture.recordedBy("member.removed")).toHaveLength(1);
  });

  it("a person who is removed, invited back and removed again is recorded twice, each with its own id", async () => {
    const capture = capturingAuditDeps();
    let clock = Date.parse("2026-10-21T10:00:00.000Z");
    const db = new FakeDynamoDb();
    capture.attach(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock, audit: capture.audit });
    await store.addMember({ orgId: TEST_ORG, developerId: "dev-owner", role: "owner" });
    for (const day of [0, 1]) {
      clock = Date.parse("2026-10-21T10:00:00.000Z") + day * 86_400_000;
      await store.addMember({ orgId: TEST_ORG, developerId: "dev-x", role: "member" });
      await store.removeMember({ orgId: TEST_ORG, developerId: "dev-x", emails: [], ban: false, by: { kind: "member", id: "dev-owner" } });
    }
    const events = capture.recordedBy("member.removed");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });
});

describe("org.closed", () => {
  const T0 = Date.parse("2026-10-21T00:00:00.000Z");
  const setup = (capture: AuditCapture, plan: "trial" | "team" = "team") => {
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "dev-owner", plan });
    db.set({ ...orgMemberKey(TEST_ORG, "dev-owner"), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: "dev-owner", role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ ...developerOrgKey("dev-owner"), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit });
    const hooks = { archiveProjects: async () => undefined, clearEgress: async () => undefined };
    return { db, store, transactions, hooks };
  };

  it("commits org.closed, the shred-due item and audit.org_shred_scheduled in the one transaction that sets closedAt", async () => {
    const capture = capturingAuditDeps();
    const { db, store, transactions, hooks } = setup(capture, "trial");
    await store.closeOrg(TEST_ORG, hooks);

    const closedAt = new Date(T0).toISOString();
    expect(db.get(orgMetaKey(TEST_ORG))).toMatchObject({ closedAt });
    const [transaction, ...rest] = auditedTransactions(transactions);
    expect(rest).toEqual([]);
    expect(transaction!.some((item) => item.Update?.Key?.pk === `ORG#${TEST_ORG}` && String((item.Update as { UpdateExpression?: string }).UpdateExpression).includes("closedAt"))).toBe(true);
    const due = transaction!.filter((item) => item.Put?.Item?.pk === "AUDIT_SHRED_DUE");
    expect(due).toHaveLength(1);
    expect(due[0]!.Put!.Item).toMatchObject({ orgId: TEST_ORG, closedAt });
    expect(pendingIn(transaction!).map((event) => event.action).sort()).toEqual(["audit.org_shred_scheduled", "org.closed"]);
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toHaveLength(1);

    const closed = capture.recordedBy("org.closed");
    expect(closed).toEqual([expect.objectContaining({
      eventId: auditEventId("org.closed", closedAt), orgId: TEST_ORG, actor: { kind: "member", id: "dev-owner" },
      target: { kind: "org", id: TEST_ORG }, occurredAt: closedAt, facts: { plan: "trial" },
    })]);
    expect(capture.recordedBy("audit.org_shred_scheduled")).toHaveLength(1);
    // The flush sent both; nothing is left pending.
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("a close that fails in its transaction records and schedules nothing, and the retry does both once", async () => {
    const capture = capturingAuditDeps();
    const { db, store, hooks } = setup(capture);
    db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_SHRED_DUE"), error: { name: "InternalServerError" } });
    await expect(store.closeOrg(TEST_ORG, hooks)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(db.get(orgMetaKey(TEST_ORG))?.closedAt).toBeUndefined();
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toEqual([]);
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);

    await store.closeOrg(TEST_ORG, hooks);
    expect(capture.recordedBy("org.closed")).toHaveLength(1);
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toHaveLength(1);
  });

  it("an org that is already closed records nothing more", async () => {
    const capture = capturingAuditDeps();
    const { db, store, hooks } = setup(capture);
    await store.closeOrg(TEST_ORG, hooks);
    const before = afterProjectBootstrap(capture.recorded()).length;
    await store.closeOrg(TEST_ORG, hooks);
    expect(afterProjectBootstrap(capture.recorded())).toHaveLength(before);
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toHaveLength(1);
  });

  it("a legacy install (no ledger) closes as before, with no due item", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "x", createdBy: "dev-owner", plan: "team" });
    db.set({ ...orgMemberKey(TEST_ORG, "dev-owner"), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: "dev-owner", role: "owner", joinedAt: "x" });
    db.set({ ...developerOrgKey("dev-owner"), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "owner", joinedAt: "x" });
    await new OrgStore({ documentClient: db, tableName: "state", now: () => T0 }).closeOrg(TEST_ORG, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
    expect(db.get(orgMetaKey(TEST_ORG))?.closedAt).toBeDefined();
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE" || String(item.pk).startsWith("AUDIT_PENDING#"))).toEqual([]);
  });

  it("through the leave route: a sole owner leaving a cloud org closes it with the audit items in the closing transaction", async () => {
    const capture = capturingAuditDeps();
    const orgA: OrgId = `org_${"a".repeat(20)}`;
    const zed: Developer = { developerId: sha("zed"), name: "Zed Yu", provider: "oidc", sessionId: "s-zed" };
    const h = await createDeveloperTaskBroker({
      audit: capture, brokerExtra: { cloud: true },
      orgResolver: async ({ developerId }) => (developerId === zed.developerId ? orgA : TEST_ORG),
      developerExtra: { endDeveloperSessions: async () => ({ ok: true as const }) },
    });
    h.db.set({ pk: `SESSION#${zed.sessionId}`, sk: "META", sessionId: zed.sessionId, developerId: zed.developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${zed.developerId}`, sk: "META", developerId: zed.developerId, provider: "oidc", displayName: zed.name, email: "zed@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(zed);
    seedMembership(h.db, zed.developerId, { orgId: orgA, role: "owner" });
    const transactions = recordTransactions(h.db);

    const left = await h.dev(zed, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    const [transaction, ...rest] = auditedTransactions(transactions);
    expect(rest).toEqual([]);
    expect(pendingIn(transaction!).map((event) => event.action).sort()).toEqual(["audit.org_shred_scheduled", "org.closed"]);
    expect(h.db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toHaveLength(1);
    expect(capture.recordedBy("org.closed")).toEqual([expect.objectContaining({ orgId: orgA, actor: { kind: "member", id: zed.developerId } })]);
  });
});

describe("member.joined", () => {
  const T0 = Date.parse("2026-10-21T00:00:00.000Z");
  const TOKEN_HASH = () => inviteTokenHash("invite-token-1");

  async function inviteWorld(capture: AuditCapture) {
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit });
    db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "x", createdBy: "dev-owner", plan: "team" });
    const hexHash = Buffer.from(TOKEN_HASH(), "base64url").toString("hex");
    db.set({ ...orgInviteKey(hexHash), entityType: "ORG_INVITE", orgId: TEST_ORG, tokenHash: hexHash, role: "admin", createdBy: "dev-owner", createdAt: "2026-10-20T00:00:00.000Z", expiresAt: new Date(T0 + 86_400_000).toISOString() });
    return { db, store, transactions, hexHash };
  }

  it("records the join in the transaction that accepts the invite, with the inviter as a related person", async () => {
    const capture = capturingAuditDeps();
    const { db, store, transactions, hexHash } = await inviteWorld(capture);
    const joined = await store.acceptInvite({ tokenHash: TOKEN_HASH(), developerId: "dev-new" });
    expect(joined).toEqual({ orgId: TEST_ORG, role: "admin" });

    const [transaction, ...rest] = auditedTransactions(transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, `ORG_INVITE#${hexHash}`)).toBe(true);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, "MEMBER#dev-new")).toBe(true);
    expect(capture.recordedBy("member.joined")).toEqual([{
      eventId: auditEventId("member.joined", TOKEN_HASH()), orgId: TEST_ORG, action: "member.joined", actor: { kind: "member", id: "dev-new" },
      target: { kind: "member", id: "dev-new" }, occurredAt: new Date(T0).toISOString(), related: ["dev-owner"], facts: { role: "admin", via: "invite" },
    }]);
    expect(db.get(orgMemberKey(TEST_ORG, "dev-new"))).toMatchObject({ role: "admin" });
  });

  it("an org made with its owner, and a person joining a single-org install, are recorded as joins in the transaction that makes them", async () => {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit, newOrgId: () => TEST_ORG });
    const at = new Date(T0).toISOString();
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "dev-owner" });
    await store.addMember({ orgId, developerId: "dev-new", role: "member" });

    const audited = auditedTransactions(transactions);
    expect(audited).toHaveLength(2);
    expect(writes(audited[0]!, `ORG#${orgId}`, "META")).toBe(true);
    expect(writes(audited[1]!, `ORG#${orgId}`, "MEMBER#dev-new")).toBe(true);
    expect(capture.recordedBy("member.joined")).toEqual([
      {
        eventId: auditEventId("member.joined", auditOccurrence("dev-owner", at)), orgId, action: "member.joined", actor: { kind: "member", id: "dev-owner" },
        target: { kind: "member", id: "dev-owner" }, occurredAt: at, facts: { role: "owner", via: "org_created" },
      },
      {
        eventId: auditEventId("member.joined", auditOccurrence("dev-new", at)), orgId, action: "member.joined", actor: { kind: "member", id: "dev-new" },
        target: { kind: "member", id: "dev-new" }, occurredAt: at, facts: { role: "member", via: "sign_in" },
      },
    ]);
  });

  it("a join that is refused (already in an org) records nothing", async () => {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit });
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "dev-owner" });
    const before = afterProjectBootstrap(capture.recorded()).length;
    await expect(store.addMember({ orgId, developerId: "dev-owner", role: "member" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    await expect(store.createOrgWithOwner({ name: "Second", developerId: "dev-owner" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    expect(afterProjectBootstrap(capture.recorded()).length).toBe(before);
  });

  it("records nothing for an invite that is used, expired or refused, and a second acceptance records nothing", async () => {
    const capture = capturingAuditDeps();
    const { store } = await inviteWorld(capture);
    await store.acceptInvite({ tokenHash: TOKEN_HASH(), developerId: "dev-new" });
    await expect(store.acceptInvite({ tokenHash: TOKEN_HASH(), developerId: "dev-other" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash("unknown"), developerId: "dev-third" })).rejects.toMatchObject({ code: "INVITE_INVALID" });
    expect(capture.recordedBy("member.joined")).toHaveLength(1);
  });

  it("a person who is already in an org is refused, and nothing is recorded or burnt", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = await inviteWorld(capture);
    db.set({ ...developerOrgKey("dev-new"), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "member", joinedAt: "x" });
    await expect(store.acceptInvite({ tokenHash: TOKEN_HASH(), developerId: "dev-new" })).rejects.toMatchObject({ code: "ALREADY_IN_ORG" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    expect(await store.acceptInvite({ tokenHash: TOKEN_HASH(), developerId: "dev-fresh" })).toMatchObject({ role: "admin" });
    expect(capture.recordedBy("member.joined")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sign-in methods: identity.linked and identity.unlinked
// ---------------------------------------------------------------------------------------------------------------------

const SIGNIN_T0 = Date.parse("2026-10-21T09:00:00.000Z");
const OIDC_ISSUER = "https://idp.example.test";
const GITHUB_ISSUER = "https://github.com";
const cloudId = ownerKeyForSubject(OIDC_ISSUER, "priya-cloud-1");
const githubId = ownerKeyForSubject(GITHUB_ISSUER, "4711");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("identity.linked and identity.unlinked", () => {
  const linkBody = (provider: "cloud" | "github", issuer: string, subject: string, at: string) => ({ entityType: "IDENTITY_LINK", provider, issuer, subject, linkedAt: at, lastSignInAt: at });
  const githubLink = { identityKey: githubId, developerId: cloudId, provider: "github" as const, issuer: GITHUB_ISSUER, subject: "4711", email: "priya@example.com", login: "priya-dev" };

  /** Priya signed in with the cloud method and belongs to an org; she has a fresh session to change her methods with. */
  function signInWorld(capture: AuditCapture, options: { inOrg?: boolean; github?: "linked" | "unlinked" | "absent" } = {}) {
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => SIGNIN_T0, audit: capture.audit });
    db.set({ pk: `DEVELOPER#${cloudId}`, sk: "META", entityType: "DEVELOPER", developerId: cloudId, provider: "cloud", issuer: OIDC_ISSUER, subject: "priya-cloud-1", displayName: "Priya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ pk: `SESSION#${SESSION_ID}`, sk: "META", entityType: "SESSION", sessionId: SESSION_ID, developerId: cloudId, amr: "cloud", identityKey: cloudId, startedAt: new Date(SIGNIN_T0 - 60_000).toISOString(), authTime: new Date(SIGNIN_T0 - 60_000).toISOString(), endsAt: Math.floor(SIGNIN_T0 / 1000) + 86_400 });
    const cloud = linkBody("cloud", OIDC_ISSUER, "priya-cloud-1", "2026-09-01T00:00:00.000Z");
    db.set({ ...signInIdentityKey(cloudId), developerId: cloudId, ...cloud });
    db.set({ ...developerIdentityKey(cloudId, cloudId), developerId: cloudId, ...cloud });
    if (options.inOrg !== false) seedMembership(db, cloudId, { orgId: TEST_ORG, role: "member" });
    const github = linkBody("github", GITHUB_ISSUER, "4711", "2026-09-02T00:00:00.000Z");
    if (options.github === "linked") {
      db.set({ ...signInIdentityKey(githubId), developerId: cloudId, ...github });
      db.set({ ...developerIdentityKey(cloudId, githubId), developerId: cloudId, ...github });
    }
    if (options.github === "unlinked") db.set({ ...signInIdentityKey(githubId), developerId: cloudId, ...github, unlinkedFrom: cloudId, unlinkedAt: "2026-09-03T00:00:00.000Z" });
    return { db, store, transactions };
  }

  it("a first link records identity.linked in the link's own transaction, with the org read from the developer's pointer", async () => {
    const capture = capturingAuditDeps();
    const { db, store, transactions } = signInWorld(capture);
    expect(await store.linkIdentity(githubLink)).toEqual({ developerId: cloudId, created: true });

    const [transaction, ...rest] = auditedTransactions(transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, `SIGNIN_IDENTITY#${githubId}`)).toBe(true);
    expect(writes(transaction!, `DEVELOPER#${cloudId}`, `IDENTITY#${githubId}`)).toBe(true);
    const at = new Date(SIGNIN_T0).toISOString();
    expect(capture.recordedBy("identity.linked")).toEqual([{
      eventId: auditEventId("identity.linked", auditOccurrence(githubId, at)), orgId: TEST_ORG, action: "identity.linked",
      actor: { kind: "member", id: cloudId }, target: { kind: "member", id: cloudId }, occurredAt: at, facts: { provider: "github" },
    }]);
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ developerId: cloudId, provider: "github" });
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("a repeat sign-in records nothing, and a second link that races the first records nothing", async () => {
    const capture = capturingAuditDeps();
    const { store } = signInWorld(capture);
    await store.linkIdentity(githubLink);
    expect(await store.linkIdentity(githubLink)).toEqual({ developerId: cloudId, created: false });
    expect(capture.recordedBy("identity.linked")).toHaveLength(1);

    // The same identity linked to the same developer between the read and the write: the create-only attempt fails, nothing is recorded.
    const second = capturingAuditDeps();
    const world = signInWorld(second);
    world.db.injectFault({
      command: "TransactWriteCommand",
      match: () => {
        const at = new Date(SIGNIN_T0 - 1000).toISOString();
        world.db.set({ ...signInIdentityKey(githubId), developerId: cloudId, ...linkBody("github", GITHUB_ISSUER, "4711", at) });
        return false;
      },
      error: { name: "TransactionCanceledException" },
    });
    expect(await world.store.linkIdentity(githubLink)).toEqual({ developerId: cloudId, created: false });
    expect(second.recorded()).toEqual([]);
  });

  it("links a person who has no org yet without an event (the chain is an org's)", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = signInWorld(capture, { inOrg: false });
    expect(await store.linkIdentity(githubLink)).toMatchObject({ created: true });
    expect(db.get(signInIdentityKey(githubId))).toBeDefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("an identity unlinked earlier and now linked to its own developer again is a new link and records one", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = signInWorld(capture, { github: "unlinked" });
    // The identity's own developer: its key is the developer id.
    db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", entityType: "DEVELOPER", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Octo", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(db, githubId, { orgId: TEST_ORG, role: "member" });
    expect(await store.linkIdentity({ ...githubLink, developerId: githubId })).toEqual({ developerId: githubId, created: true });
    expect(capture.recordedBy("identity.linked")).toEqual([expect.objectContaining({ actor: { kind: "member", id: githubId }, orgId: TEST_ORG })]);
  });

  it("two sign-ins of an identity over its own tombstone, racing, record one link", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = signInWorld(capture, { github: "unlinked" });
    db.set({ pk: `DEVELOPER#${githubId}`, sk: "META", entityType: "DEVELOPER", developerId: githubId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", displayName: "Octo", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(db, githubId, { orgId: TEST_ORG, role: "member" });
    // The other sign-in links the identity to its own developer between this one's read and its write; the item keeps the tombstone's unlinkedFrom.
    db.injectFault({
      command: "TransactWriteCommand",
      match: () => { db.set({ ...db.get(signInIdentityKey(githubId))!, developerId: githubId }); return false; },
      error: { name: "TransactionCanceledException" },
    });
    expect(await store.linkIdentity({ ...githubLink, developerId: githubId })).toEqual({ developerId: githubId, created: false });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("the link and its audit item are written together or not at all", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = signInWorld(capture);
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(store.linkIdentity(githubLink)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(db.get(signInIdentityKey(githubId))).toBeUndefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    expect(await store.linkIdentity(githubLink)).toMatchObject({ created: true });
    expect(capture.recordedBy("identity.linked")).toHaveLength(1);
  });

  it("a legacy install (no ledger) links as before and writes no audit item", async () => {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => SIGNIN_T0 });
    expect(await store.linkIdentity(githubLink)).toMatchObject({ created: true });
    expect(db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toEqual([]);
  });

  it("unlinking a method records identity.unlinked once, in the transaction that tombstones the link", async () => {
    const capture = capturingAuditDeps();
    const { db, store, transactions } = signInWorld(capture, { github: "linked" });
    expect(await store.unlinkIdentity({ developerId: cloudId, sessionId: SESSION_ID, provider: "github" })).toEqual({ identityKey: githubId });

    const [transaction, ...rest] = auditedTransactions(transactions);
    expect(rest).toEqual([]);
    expect(transaction!.some((item) => item.Delete?.Key?.pk === `DEVELOPER#${cloudId}` && item.Delete.Key.sk === `IDENTITY#${githubId}`)).toBe(true);
    const at = new Date(SIGNIN_T0).toISOString();
    expect(capture.recordedBy("identity.unlinked")).toEqual([{
      eventId: auditEventId("identity.unlinked", auditOccurrence(githubId, at)), orgId: TEST_ORG, action: "identity.unlinked",
      actor: { kind: "member", id: cloudId }, target: { kind: "member", id: cloudId }, occurredAt: at, facts: { provider: "github" },
    }]);
    // Unlinking what is no longer linked is refused and records nothing more.
    await expect(store.unlinkIdentity({ developerId: cloudId, sessionId: SESSION_ID, provider: "github" })).rejects.toThrow("not linked");
    expect(capture.recordedBy("identity.unlinked")).toHaveLength(1);
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ unlinkedFrom: cloudId });
  });

  it("an unlink that is refused or fails records nothing", async () => {
    const capture = capturingAuditDeps();
    const { db, store } = signInWorld(capture, { github: "linked" });
    // The method the account was created with cannot be removed.
    await expect(store.unlinkIdentity({ developerId: cloudId, sessionId: SESSION_ID, provider: "cloud" })).rejects.toBeDefined();
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(store.unlinkIdentity({ developerId: cloudId, sessionId: SESSION_ID, provider: "github" })).rejects.toMatchObject({ name: "InternalServerError" });
    expect(db.get(developerIdentityKey(cloudId, githubId))).toBeDefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("adding a removed method back records identity.linked, in the relink's transaction", async () => {
    const capture = capturingAuditDeps();
    const { db, store, transactions } = signInWorld(capture, { github: "unlinked" });
    expect(await store.relinkIdentity({ ...githubLink, by: { method: "cloud" } })).toEqual({ developerId: cloudId });
    const [transaction] = auditedTransactions(transactions);
    expect(writes(transaction!, `SIGNIN_IDENTITY#${githubId}`)).toBe(true);
    expect(capture.recordedBy("identity.linked")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "member", id: cloudId }, facts: { provider: "github" } })]);
    expect(db.get(signInIdentityKey(githubId))).toMatchObject({ relinkedBy: cloudId });
  });

  it("answers as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const { db, store } = signInWorld(capture);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const linked = await settle(store.linkIdentity(githubLink));
    expect(linked).toMatchObject({ created: true });
    expect(db.get(signInIdentityKey(githubId))).toBeDefined();
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action)).toEqual(["identity.linked"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// GitHub: connected, bound from a request, disconnected, changed by GitHub
// ---------------------------------------------------------------------------------------------------------------------

const GH_NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const GH_OWNER = "owner-dev";
const GH_REQUESTER = "admin-dev";
const REQUESTER_GITHUB_ID = 4343;
const COOKIE = "c".repeat(43);
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

/** A cloud org with an owner and an admin whose GitHub account is linked, over one table, auditing through `capture`. */
function githubWorld(capture: AuditCapture, options: { plan?: "trial" | "team" } = {}) {
  const db = new FakeDynamoDb();
  capture.attach(db);
  const transactions = recordTransactions(db);
  db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme <Corp>", createdAt: "2026-10-01T00:00:00.000Z", createdBy: GH_OWNER, plan: options.plan ?? "trial" });
  db.set({ ...orgMetaKey(ORG_B), entityType: "ORG", orgId: ORG_B, name: "Beta", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "b-owner", plan: "trial" });
  for (const [developerId, role] of [[GH_OWNER, "owner"], [GH_REQUESTER, "admin"]] as const) {
    db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  }
  const identityKey = ownerKeyForSubject(GITHUB_ISSUER, String(REQUESTER_GITHUB_ID));
  const fields = { developerId: GH_REQUESTER, provider: "github", issuer: GITHUB_ISSUER, subject: String(REQUESTER_GITHUB_ID), linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
  db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...fields });
  db.set({ pk: `DEVELOPER#${GH_REQUESTER}`, sk: "META", developerId: GH_REQUESTER, provider: "github", displayName: "Rhea", firstSignInAt: "x", lastSignInAt: "x", revoked: false, issuer: GITHUB_ISSUER, subject: String(REQUESTER_GITHUB_ID) });
  const acme = { login: "acme", id: 900, type: "Organization" as const };
  const memberships: Record<string, { state: string; role: string }> = { "acme/rhea": { state: "active", role: "member" }, "acme/gh-admin": { state: "active", role: "admin" } };
  const logs: Array<Record<string, unknown>> = [];
  const deps: GithubConnectionDependencies = {
    documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => GH_NOW, cloud: true, origin: CELL,
    app: {
      appSlug: async () => "rovara-cloud",
      oauthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
      installation: async (id) => ({ id, account: acme, repositorySelection: "selected", suspendedAt: null }),
      orgMembership: async (_installationId, org, login) => memberships[`${org}/${login}`],
    },
    identities: new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => GH_NOW }),
    orgs: new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => GH_NOW }),
    unlockTrial: (input) => unlockTrial({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => GH_NOW }, input),
    log: (entry) => logs.push(entry),
    audit: capture.audit,
  };
  /** A connect that reached its confirm page: the state is stored by hash, bound to `developerId`, with the binding GitHub described. */
  const confirmable = (over: { installationId?: number; accountType?: "User" | "Organization"; githubUserId?: string; connect?: string } = {}) => {
    const connect = over.connect ?? sha(`state-${String(over.installationId ?? 501)}`);
    db.set({
      ...githubConnectStateKey(connect), entityType: "GITHUB_CONNECT_STATE", orgId: TEST_ORG, developerId: GH_OWNER, expiresAt: GH_NOW + 900_000, callbackAt: GH_NOW, confirmHash: sha(COOKIE),
      pending: { installationId: over.installationId ?? 501, accountLogin: "acme", accountId: 900, accountType: over.accountType ?? "Organization", repositorySelection: "selected", status: "active", githubUserId: over.githubUserId ?? "4242" },
    });
    return connect;
  };
  const bound = (installationId: number, over: { status?: "active" | "suspended" | "removed"; orgId?: OrgId } = {}) => {
    const orgId = over.orgId ?? TEST_ORG;
    const record = {
      installationId, orgId, accountLogin: "acme", accountId: 900, accountType: "Organization", repositorySelection: "selected", installedByGithubUserId: "4242",
      boundByDeveloperId: GH_OWNER, status: over.status ?? "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    };
    db.set({ ...githubInstallationKey(installationId), entityType: "GITHUB_INSTALLATION", ...record });
    db.set({ ...orgGithubInstallationKey(orgId, installationId), entityType: "ORG_GITHUB_INSTALLATION", ...record });
  };
  /** A waiting request by the admin, as the callback of GitHub's "Request" leaves it. */
  const requested = () => {
    const record = { orgId: TEST_ORG, developerId: GH_REQUESTER, githubUserId: String(REQUESTER_GITHUB_ID), githubLogin: "rhea", requestedAt: GH_NOW, expiresAt: GH_NOW + 7 * 24 * HOUR, status: "waiting" };
    db.set({ ...githubInstallRequestKey(String(REQUESTER_GITHUB_ID)), entityType: "GITHUB_INSTALL_REQUEST", ...record });
    db.set({ ...orgGithubInstallRequestKey(TEST_ORG, String(REQUESTER_GITHUB_ID)), entityType: "GITHUB_INSTALL_REQUEST", ...record });
    db.set({ ...githubInstallRequestQueueKey(GH_NOW, String(REQUESTER_GITHUB_ID)), entityType: "GITHUB_INSTALL_REQUEST_QUEUE", orgId: TEST_ORG });
  };
  const created = (over: { id?: number } = {}): InstallationCreatedPayload => ({
    installation: { id: over.id ?? 601, created_at: new Date(GH_NOW + HOUR).toISOString(), account: acme },
    requester: { id: REQUESTER_GITHUB_ID, login: "rhea" },
    sender: { id: 777, login: "gh-admin" },
  });
  return { db, deps, transactions, confirmable, bound, requested, created, logs };
}

describe("github.connected: confirmGithubConnect", () => {
  const confirm = (w: ReturnType<typeof githubWorld>, connect: string, decision: "connect" | "cancel" = "connect") =>
    confirmGithubConnect(w.deps, { connect, decision }, COOKIE, CELL);

  it("records the connection in the bind transaction: the person who confirmed, the installation, the account type and the account's name in the details", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    const connect = w.confirmable();
    expect(await confirm(w, connect)).toMatchObject({ outcome: "connected" });

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, "GITHUB_INSTALLATION#501", "ORG")).toBe(true);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, "GITHUB_INSTALLATION#501")).toBe(true);
    expect(capture.recordedBy("github.connected")).toEqual([{
      eventId: auditEventId("github.connected", connect), orgId: TEST_ORG, action: "github.connected", actor: { kind: "member", id: GH_OWNER },
      target: { kind: "github_installation", id: "501" }, occurredAt: new Date(GH_NOW).toISOString(),
      facts: { accountType: "Organization", result: "connected" }, details: [{ subject: "org", fields: { accountLogin: "acme" } }],
    }]);
    expect(JSON.stringify(capture.recordedBy("github.connected")[0]!.facts)).not.toContain("acme");
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("records connected_trial_used when the GitHub account already started another organization's trial", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.db.set({ ...trialGithubKey("4242"), entityType: "TRIAL_GITHUB", orgId: ORG_B, claimedAt: 1 });
    expect(await confirm(w, w.confirmable())).toMatchObject({ outcome: "connected_trial_used" });
    expect(capture.recordedBy("github.connected")).toEqual([expect.objectContaining({ facts: { accountType: "Organization", result: "connected_trial_used" } })]);
    // The connection stands, in the same transaction as its event.
    expect(w.db.get(githubInstallationKey(501))).toMatchObject({ orgId: TEST_ORG });
  });

  it("records a team org's connection as connected, and a user account's type", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture, { plan: "team" });
    expect(await confirm(w, w.confirmable({ accountType: "User" }))).toMatchObject({ outcome: "connected" });
    expect(capture.recordedBy("github.connected")).toEqual([expect.objectContaining({ facts: { accountType: "User", result: "connected" } })]);
  });

  it("records nothing for a cancel, a connection another org holds, or a state that is gone, and one confirmation only once", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    expect(await confirm(w, w.confirmable({ connect: sha("a") }), "cancel")).toMatchObject({ outcome: "cancelled" });
    w.bound(502, { orgId: ORG_B });
    expect(await confirm(w, w.confirmable({ installationId: 502 }))).toMatchObject({ outcome: "taken" });
    expect(await confirm(w, sha("unknown"))).toMatchObject({ outcome: "expired" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);

    const connect = w.confirmable({ installationId: 503 });
    await confirm(w, connect);
    expect(await confirm(w, connect)).toMatchObject({ outcome: "expired" });
    expect(capture.recordedBy("github.connected")).toHaveLength(1);
  });

  it("commits the connection and its event together or not at all", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    const connect = w.confirmable();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" } });
    expect(await confirm(w, connect)).toMatchObject({ outcome: "expired" });
    expect(w.db.get(githubInstallationKey(501))).toBeUndefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("answers as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const w = githubWorld(capture);
    const connect = w.confirmable();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await settle(confirm(w, connect))).toMatchObject({ outcome: "connected" });
    expect(w.db.get(githubInstallationKey(501))).toMatchObject({ orgId: TEST_ORG });
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action)).toEqual(["github.connected"]);
  });
});

describe("github.connected: bindRequestedInstallation", () => {
  it("records the binding with both GitHub logins in the details, in the bind transaction", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.requested();
    const delivery = "11111111-2222-4333-8444-555555555555";
    expect(await bindRequestedInstallation(w.deps, delivery, w.created())).toBe("bound");

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, "GITHUB_INSTALLATION#601", "ORG")).toBe(true);
    const [event, ...more] = capture.recordedBy("github.connected");
    expect(more).toEqual([]);
    expect(event).toEqual({
      eventId: auditEventId("github.connected", delivery), orgId: TEST_ORG, action: "github.connected", actor: { kind: "member", id: GH_REQUESTER },
      target: { kind: "github_installation", id: "601" }, occurredAt: new Date(GH_NOW).toISOString(), facts: { accountType: "Organization", result: "connected" },
      details: [
        { subject: GH_REQUESTER, fields: { requesterGithubLogin: "rhea" } },
        { subject: "org", fields: { accountLogin: "acme", approverGithubLogin: "gh-admin" } },
      ],
    });
  });

  it("records connected_trial_used when the requester's GitHub account already started another organization's trial, as a confirmation does", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.requested();
    w.db.set({ ...trialGithubKey(String(REQUESTER_GITHUB_ID)), entityType: "TRIAL_GITHUB", orgId: ORG_B, claimedAt: 1 });
    expect(await bindRequestedInstallation(w.deps, "d-trial", w.created())).toBe("bound");
    expect(capture.recordedBy("github.connected")).toEqual([expect.objectContaining({ facts: { accountType: "Organization", result: "connected_trial_used" } })]);
    // The binding stands either way.
    expect(w.db.get(githubInstallationKey(601))).toMatchObject({ orgId: TEST_ORG });
  });

  it("records nothing when the delivery is ignored, a replay, or refused, and a redelivery of the bound one records nothing more", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.requested();
    // No requester, a requester with no open request, an installation outside the request's window.
    expect(await bindRequestedInstallation(w.deps, "d-none", { ...w.created(), requester: null })).toBe("ignored");
    expect(await bindRequestedInstallation(w.deps, "d-stranger", { ...w.created(), requester: { id: 9999, login: "stranger" } })).toBe("ignored");
    expect(await bindRequestedInstallation(w.deps, "d-early", { ...w.created(), installation: { ...w.created().installation, created_at: new Date(GH_NOW - 3 * HOUR).toISOString() } })).toBe("ignored");
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);

    expect(await bindRequestedInstallation(w.deps, "d-good", w.created())).toBe("bound");
    expect(await bindRequestedInstallation(w.deps, "d-good", w.created())).toBe("ignored");
    expect(capture.recordedBy("github.connected")).toHaveLength(1);
  });

  it("commits the binding and its event together or not at all", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.requested();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" } });
    await expect(bindRequestedInstallation(w.deps, "d-try", w.created())).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.db.get(githubInstallationKey(601))).toBeUndefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    expect(await bindRequestedInstallation(w.deps, "d-try", w.created())).toBe("bound");
    expect(capture.recordedBy("github.connected")).toHaveLength(1);
  });
});

describe("github.disconnected", () => {
  const owner = { developerId: GH_OWNER, orgId: TEST_ORG, orgRole: "owner" as const };

  it("records the disconnect in the transaction that deletes both bindings, naming the person", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    await disconnectGithubInstallation(w.deps, owner, 501);

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, "GITHUB_INSTALLATION#501", "ORG")).toBe(true);
    expect(writes(transaction!, `ORG#${TEST_ORG}`, "GITHUB_INSTALLATION#501")).toBe(true);
    expect(capture.recordedBy("github.disconnected")).toEqual([{
      eventId: auditEventId("github.disconnected", auditOccurrence("501", "2026-10-01T00:00:00.000Z")), orgId: TEST_ORG, action: "github.disconnected",
      actor: { kind: "member", id: GH_OWNER }, target: { kind: "github_installation", id: "501" }, occurredAt: new Date(GH_NOW).toISOString(),
      facts: { accountType: "Organization" }, details: [{ subject: "org", fields: { accountLogin: "acme" } }],
    }]);
  });

  it("records nothing for a member, another org's installation, or an installation already disconnected", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    w.bound(502, { orgId: ORG_B });
    await expect(disconnectGithubInstallation(w.deps, { ...owner, orgRole: "member" }, 501)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disconnectGithubInstallation(w.deps, owner, 502)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    await disconnectGithubInstallation(w.deps, owner, 501);
    await expect(disconnectGithubInstallation(w.deps, owner, 501)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(capture.recordedBy("github.disconnected")).toHaveLength(1);
  });
});

describe("github.installation_changed", () => {
  it("an installation.deleted delivery records status removed, by github, in the transaction that changes the binding", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    expect(await applyInstallationLifecycle(w.deps, "delivery-1", { kind: "installation", action: "deleted", installationId: 501 })).toBe("applied");

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, "GITHUB_INSTALLATION#501", "ORG")).toBe(true);
    expect(capture.recordedBy("github.installation_changed")).toEqual([{
      eventId: auditEventId("github.installation_changed", "delivery-1"), orgId: TEST_ORG, action: "github.installation_changed", actor: { kind: "github", id: "501" },
      target: { kind: "github_installation", id: "501" }, occurredAt: new Date(GH_NOW).toISOString(), facts: { status: "removed", accountType: "Organization" },
    }]);
  });

  it("records once per delivery id: a replay of the delivery, and a later delivery of the same news, record nothing more", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    const deleted = { kind: "installation", action: "deleted", installationId: 501 } as const;
    await applyInstallationLifecycle(w.deps, "delivery-1", deleted);
    expect(await applyInstallationLifecycle(w.deps, "delivery-1", deleted)).toBe("ignored");
    expect(await applyInstallationLifecycle(w.deps, "delivery-2", deleted)).toBe("ignored");
    expect(capture.recordedBy("github.installation_changed")).toHaveLength(1);
  });

  it("records a suspension and its lifting, and nothing for a repository-selection change or an installation nobody bound", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    await applyInstallationLifecycle(w.deps, "d-suspend", { kind: "installation", action: "suspend", installationId: 501 });
    await applyInstallationLifecycle(w.deps, "d-unsuspend", { kind: "installation", action: "unsuspend", installationId: 501 });
    expect(capture.recordedBy("github.installation_changed").map((event) => event.facts?.status)).toEqual(["suspended", "active"]);
    await applyInstallationLifecycle(w.deps, "d-repos", { kind: "repositories", installationId: 501, repositorySelection: "all" });
    await applyInstallationLifecycle(w.deps, "d-unbound", { kind: "installation", action: "deleted", installationId: 999 });
    expect(capture.recordedBy("github.installation_changed")).toHaveLength(2);
  });

  it("a delivery whose transaction fails records nothing and changes nothing, and its retry records once", async () => {
    const capture = capturingAuditDeps();
    const w = githubWorld(capture);
    w.bound(501);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(applyInstallationLifecycle(w.deps, "delivery-1", { kind: "installation", action: "deleted", installationId: 501 })).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.db.get(githubInstallationKey(501))).toMatchObject({ status: "active" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    expect(await applyInstallationLifecycle(w.deps, "delivery-1", { kind: "installation", action: "deleted", installationId: 501 })).toBe("applied");
    expect(capture.recordedBy("github.installation_changed")).toHaveLength(1);
  });
});

describe("GitHub through the broker", () => {
  const SECRET = "whsec-audit-hooks-plan2";

  /** A cloud broker auditing through `capture`, with a GitHub App that knows installation 55 and the organization membership checks. */
  async function cloudBroker(capture: AuditCapture) {
    const memberships: Record<string, { state: string; role: string }> = { "acme/rhea": { state: "active", role: "member" }, "acme/gh-admin": { state: "active", role: "admin" } };
    const h = await createDeveloperTaskBroker({
      audit: capture,
      brokerExtra: {
        cloud: true, githubWebhookSecret: async () => SECRET,
        githubPullRequests: {
          reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(),
          appSlug: async () => "rovara-cloud", oauthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
          installation: async (id: number) => ({ id, account: { login: "acme", id: 900, type: "Organization" }, repositorySelection: "selected", suspendedAt: null }),
          organizationMembership: async (_installationId: number, org: string, login: string) => memberships[`${org}/${login}`],
        },
      },
    });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const bind = (installationId: number) => {
      const record = {
        installationId, orgId: TEST_ORG, accountLogin: "acme", accountId: 900, accountType: "Organization", repositorySelection: "selected", installedByGithubUserId: "4242",
        boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
      };
      h.db.set({ ...githubInstallationKey(installationId), entityType: "GITHUB_INSTALLATION", ...record });
      h.db.set({ ...orgGithubInstallationKey(TEST_ORG, installationId), entityType: "ORG_GITHUB_INSTALLATION", ...record });
    };
    const signed = (event: string, payload: object, deliveryId: string) => {
      const raw = JSON.stringify(payload);
      return h.handler({
        version: "2.0", routeKey: "POST /v1/github/webhooks", rawPath: "/v1/github/webhooks", rawQueryString: "",
        headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`, "x-github-delivery": deliveryId, "x-github-event": event },
        body: raw, requestContext: { requestId: randomUUID(), http: { method: "POST" } },
      });
    };
    return { ...h, bind, signed };
  }

  it("the installation.deleted webhook records github.installation_changed, once however often the delivery arrives", async () => {
    const capture = capturingAuditDeps();
    const h = await cloudBroker(capture);
    h.bind(55);
    const delivery = randomUUID();
    const payload = { action: "deleted", installation: { id: 55 }, sender: { id: 777, login: "gh-admin" } };
    expect((await h.signed("installation", payload, delivery)).statusCode).toBe(202);
    expect((await h.signed("installation", payload, delivery)).statusCode).toBe(202);
    expect(capture.recordedBy("github.installation_changed")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "github", id: "55" }, facts: { status: "removed", accountType: "Organization" } })]);
    expect(h.db.get(githubInstallationKey(55))).toMatchObject({ status: "removed" });
  });

  it("the installation.created webhook that binds a request records github.connected", async () => {
    const capture = capturingAuditDeps();
    const h = await cloudBroker(capture);
    const requesterId = 4343;
    const identityKey = ownerKeyForSubject(GITHUB_ISSUER, String(requesterId));
    const fields = { developerId: MAYA.developerId, provider: "github", issuer: GITHUB_ISSUER, subject: String(requesterId), linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    h.db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...fields });
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    const requestedAt = Date.now();
    const record = { orgId: TEST_ORG, developerId: MAYA.developerId, githubUserId: String(requesterId), githubLogin: "rhea", requestedAt, expiresAt: requestedAt + 7 * 24 * HOUR, status: "waiting" };
    h.db.set({ ...githubInstallRequestKey(String(requesterId)), entityType: "GITHUB_INSTALL_REQUEST", ...record });
    h.db.set({ ...orgGithubInstallRequestKey(TEST_ORG, String(requesterId)), entityType: "GITHUB_INSTALL_REQUEST", ...record });
    h.db.set({ ...githubInstallRequestQueueKey(requestedAt, String(requesterId)), entityType: "GITHUB_INSTALL_REQUEST_QUEUE", orgId: TEST_ORG });
    const delivery = randomUUID();
    const reply = await h.signed("installation", {
      action: "created", installation: { id: 601, created_at: new Date(requestedAt + HOUR).toISOString(), account: { login: "acme", id: 900, type: "Organization" } },
      requester: { id: requesterId, login: "rhea" }, sender: { id: 777, login: "gh-admin" },
    }, delivery);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(h.db.get(githubInstallationKey(601))).toMatchObject({ orgId: TEST_ORG });
    expect(capture.recordedBy("github.connected")).toEqual([expect.objectContaining({ eventId: auditEventId("github.connected", delivery), orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId } })]);
  });

  it("DELETE /v1/app/github/installations/{id} records github.disconnected for the owner who asked", async () => {
    const capture = capturingAuditDeps();
    const h = await cloudBroker(capture);
    h.bind(55);
    const gone = await h.dev(OMAR, "DELETE", "/v1/app/github/installations/55");
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(capture.recordedBy("github.disconnected")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "member", id: OMAR.developerId }, target: { kind: "github_installation", id: "55" } })]);
    expect(h.db.get(githubInstallationKey(55))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Allowed websites: staff decisions
// ---------------------------------------------------------------------------------------------------------------------

const WEB: EgressOwner = { kind: "project", project: "web" };
const STAFF = { subject: "staff-subject", admin: true };

describe("egress_domain.decided", () => {
  /** An org's project `web` asked for a.acme.dev and b.acme.dev on Rovara Cloud; both wait for staff. */
  async function egressWorld(capture: AuditCapture) {
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    const sync = vi.fn(async () => ({ ok: true }));
    const deps: EgressDomainsDependencies = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, cloud: true, now: () => new Date("2026-10-21T12:00:00.000Z"), sync, audit: capture.audit };
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-maya" });
    transactions.length = 0;
    return { db, deps, transactions, sync };
  }
  const operator = auditOperatorId("https://issuer.example", "staff-subject");
  // The item's `updatedAt` always moves forward: the decision is stamped one millisecond after the request, which was made at the clock's time.
  const EGRESS_DECIDED_AT = "2026-10-21T12:00:00.001Z";

  it("records an approval in the transaction that changes the item, with the operator's pseudonym as the actor and the project's name in the details only", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    const requestId = randomUUID();
    await decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-subject", requestId, auditActor: { kind: "operator", id: operator } });

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(transaction!.some((item) => item.Put?.Item?.pk === EGRESS_DOMAINS_PK)).toBe(true);
    const [event, ...more] = capture.recordedBy("egress_domain.decided");
    expect(more).toEqual([]);
    expect(event).toEqual({
      eventId: auditEventId("egress_domain.decided", auditOccurrence(requestId, "a.acme.dev", "project:web")), orgId: TEST_ORG, action: "egress_domain.decided",
      actor: { kind: "operator", id: operator }, target: { kind: "domain", name: "a.acme.dev" }, occurredAt: EGRESS_DECIDED_AT, facts: { decision: "approved" },
      details: [{ subject: "org", fields: { project: "web" } }],
    });
    expect(JSON.stringify(event!.actor)).not.toContain("staff-subject");
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("records a rejection with the reason in the details", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    await decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "b.acme.dev", decision: "rejected", operatorId: "staff-subject", reason: "not an artifact host", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } });
    expect(capture.recordedBy("egress_domain.decided")).toEqual([expect.objectContaining({
      facts: { decision: "rejected" }, details: [{ subject: "org", fields: { project: "web", reason: "not an artifact host" } }],
    })]);
  });

  // Plan 2's fix wave (ea3fc3e2) applies the one request-id pattern to staff egress decisions: a request id names one
  // decision, so reusing it for another domain or owner is IDEMPOTENCY_CONFLICT and records nothing more.
  it("two domains decided with their own request ids are two events; reusing one id for another domain is refused", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    for (const domain of ["a.acme.dev", "b.acme.dev"]) {
      await decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain, decision: "approved", operatorId: "staff-subject", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } });
    }
    expect(new Set(capture.recordedBy("egress_domain.decided").map((event) => event.eventId)).size).toBe(2);
    await putEgressDomains(w.deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev", "c.acme.dev", "d.acme.dev"], { developerId: "dev-maya" });
    const reused = randomUUID();
    await decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "c.acme.dev", decision: "approved", operatorId: "staff-subject", requestId: reused, auditActor: { kind: "operator", id: operator } });
    await expect(decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "d.acme.dev", decision: "approved", operatorId: "staff-subject", requestId: reused, auditActor: { kind: "operator", id: operator } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(capture.recordedBy("egress_domain.decided")).toHaveLength(3);
  });

  it("the same domain on another owner, with its own request id, is another decision", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    const docs: EgressOwner = { kind: "project", project: "docs" };
    await putEgressDomains(w.deps, TEST_ORG, docs, ["a.acme.dev"], { developerId: "dev-maya" });
    for (const owner of [WEB, docs]) {
      await decideEgressDomain(w.deps, { orgId: TEST_ORG, owner, domain: "a.acme.dev", decision: "approved", operatorId: "staff-subject", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } });
    }
    expect(capture.recordedBy("egress_domain.decided").map((event) => event.details)).toEqual([[{ subject: "org", fields: { project: "web" } }], [{ subject: "org", fields: { project: "docs" } }]]);
  });

  it("records nothing for a domain that is not pending, and a second decision on the same domain records nothing more", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    const decide = (domain: string) => decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain, decision: "approved", operatorId: "staff-subject", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } });
    await expect(decide("unknown.acme.dev")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    await decide("a.acme.dev");
    await expect(decide("a.acme.dev")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(capture.recordedBy("egress_domain.decided")).toHaveLength(1);
  });

  it("commits the decision and its event together or not at all, and a decision that lost a race to a save is recorded once, by the attempt that held", async () => {
    const capture = capturingAuditDeps();
    const w = await egressWorld(capture);
    const decide = () => decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-subject", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } });
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(decide()).rejects.toMatchObject({ name: "InternalServerError" });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    expect((w.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains[0]).toMatchObject({ status: "pending" });

    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] } });
    await decide();
    expect(capture.recordedBy("egress_domain.decided")).toHaveLength(1);
  });

  it("answers as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const w = await egressWorld(capture);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await settle(decideEgressDomain(w.deps, { orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev", decision: "approved", operatorId: "staff-subject", requestId: randomUUID(), auditActor: { kind: "operator", id: operator } }));
    expect((w.db.get(egressDomainsKey(TEST_ORG, WEB)) as unknown as EgressDomainsItem).domains[0]).toMatchObject({ status: "approved" });
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action)).toEqual(["egress_domain.decided"]);
  });

  it("POST /v1/admin/egress/approve and /reject record the decision with the staff member's pseudonym, never their subject", async () => {
    const capture = capturingAuditDeps();
    const h = await createDeveloperTaskBroker({ audit: capture, brokerExtra: { cloud: true, egressDomainsSync: async () => ({ ok: true }) } });
    const deps: EgressDomainsDependencies = { documentClient: h.db, tableName: AUDIT_CAPTURE_TABLE, cloud: true, now: () => new Date(), sync: async () => ({ ok: true }) };
    await putEgressDomains(deps, TEST_ORG, WEB, ["a.acme.dev", "b.acme.dev"], { developerId: "dev-maya" });
    const requestId = randomUUID();
    const approved = await call(h.handler, { method: "POST", path: "/v1/admin/egress/approve", user: STAFF, body: { requestId, orgId: TEST_ORG, owner: WEB, domain: "a.acme.dev" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const rejected = await call(h.handler, { method: "POST", path: "/v1/admin/egress/reject", user: STAFF, body: { requestId: randomUUID(), orgId: TEST_ORG, owner: WEB, domain: "b.acme.dev", reason: "no" } });
    expect(rejected.status).toBe(200);
    const events = capture.recordedBy("egress_domain.decided");
    expect(events.map((event) => event.facts?.decision).sort()).toEqual(["approved", "rejected"]);
    for (const event of events) {
      // The pseudonym of the staff member's issuer and subject, as the budget route names an operator: the same person is one id throughout the chain.
      expect(event.actor).toEqual({ kind: "operator", id: auditOperatorId(brokerIssuer, "staff-subject") });
      expect(JSON.stringify(event)).not.toContain("staff-subject");
    }
    expect(events.find((event) => event.facts?.decision === "approved")!.eventId).toBe(auditEventId("egress_domain.decided", auditOccurrence(requestId, "a.acme.dev", "project:web")));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Projects: people added, changed and removed
// ---------------------------------------------------------------------------------------------------------------------

describe("project_member.changed and project_member.removed", () => {
  const PRIYA = "p".repeat(64);
  const SAM = "s".repeat(64);
  const BINDING = {
    deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
    subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
  } as const;
  const seedProject = (db: FakeDynamoDb, name = "payments") => {
    db.set({
      ...projectRevisionKey(TEST_ORG, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
      definition: { name, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
    });
    db.set({ ...orgProjectCatalogKey(TEST_ORG, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  };

  function memberWorld(capture: AuditCapture) {
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    seedProject(db);
    for (const developerId of [PRIYA, SAM]) db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role: "member", joinedAt: "2026-10-01T00:00:00.000Z" });
    const deps: ProjectMemberChangeDependencies = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => new Date("2026-10-21T12:00:00.000Z"), audit: capture.audit };
    const set = (role: "maintainer" | "contributor" | "viewer", requestId = randomUUID()) => setProjectMember(deps, TEST_ORG, "payments", { requestId, developerId: SAM, role, actor: { developerId: PRIYA } });
    const remove = (requestId = randomUUID()) => removeProjectMember(deps, TEST_ORG, "payments", { requestId, developerId: SAM, actor: { developerId: PRIYA } });
    return { db, deps, transactions, set, remove };
  }

  it("a person added as a viewer is recorded in the transaction that writes the grant and the request record", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    const requestId = randomUUID();
    await w.set("viewer", requestId);

    const [transaction, ...rest] = auditedTransactions(w.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, `ORG#${TEST_ORG}#MEMBER#${SAM}`)).toBe(true);
    expect(transaction!.some((item) => keyText(item.Put?.Item?.sk).startsWith("MEMBER_REQUEST#"))).toBe(true);
    expect(capture.recordedBy("project_member.changed")).toEqual([{
      eventId: auditEventId("project_member.changed", auditOccurrence(requestId, "payments", SAM, "viewer")), orgId: TEST_ORG, action: "project_member.changed", actor: { kind: "member", id: PRIYA },
      target: { kind: "project", name: "payments" }, occurredAt: "2026-10-21T12:00:00.000Z", related: [SAM], facts: { toRole: "viewer" },
    }]);
    expect(afterProjectBootstrap(capture.pending())).toEqual([]);
  });

  it("a change of role records the role the person had and the role they have", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    await w.set("contributor");
    await w.set("viewer");
    expect(capture.recordedBy("project_member.changed").map((event) => event.facts)).toEqual([{ toRole: "contributor" }, { fromRole: "contributor", toRole: "viewer" }]);
  });

  it("a replay of the request, and a change to the role the person already has, record nothing more", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    const requestId = randomUUID();
    await w.set("viewer", requestId);
    await w.set("viewer", requestId);
    await w.set("viewer");
    expect(capture.recordedBy("project_member.changed")).toHaveLength(1);
  });

  it("one request id used on another project records that project's change too", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    seedProject(w.db, "billing");
    const requestId = randomUUID();
    for (const project of ["payments", "billing"]) await setProjectMember(w.deps, TEST_ORG, project, { requestId, developerId: SAM, role: "viewer", actor: { developerId: PRIYA } });
    expect(capture.recordedBy("project_member.changed").map((event) => event.target)).toEqual([{ kind: "project", name: "payments" }, { kind: "project", name: "billing" }]);
    for (const project of ["payments", "billing"]) await removeProjectMember(w.deps, TEST_ORG, project, { requestId: randomUUID(), developerId: SAM, actor: { developerId: PRIYA } });
    expect(capture.recordedBy("project_member.removed")).toHaveLength(2);
  });

  it("a removal records the role taken away, in the transaction that deletes the grant", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    await w.set("contributor");
    w.transactions.length = 0;
    const requestId = randomUUID();
    await w.remove(requestId);
    const [transaction] = auditedTransactions(w.transactions);
    expect(transaction!.some((item) => item.Delete?.Key?.pk === `ORG#${TEST_ORG}#MEMBER#${SAM}`)).toBe(true);
    expect(capture.recordedBy("project_member.removed")).toEqual([{
      eventId: auditEventId("project_member.removed", auditOccurrence(requestId, "payments", SAM)), orgId: TEST_ORG, action: "project_member.removed", actor: { kind: "member", id: PRIYA },
      target: { kind: "project", name: "payments" }, occurredAt: "2026-10-21T12:00:00.000Z", related: [SAM], facts: { role: "contributor" },
    }]);
  });

  it("removing a person with no grant records nothing, though the request is remembered", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    expect(await w.remove()).toMatchObject({ removed: false });
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
  });

  it("the grant and its event are written together or not at all", async () => {
    const capture = capturingAuditDeps();
    const w = memberWorld(capture);
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.set("viewer")).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.db.get(projectMemberKey(TEST_ORG, SAM, "payments"))).toBeUndefined();
    expect(afterProjectBootstrap(capture.recorded())).toEqual([]);
    await w.set("viewer");
    expect(capture.recordedBy("project_member.changed")).toHaveLength(1);
  });

  it("answers as today when the intake queue never answers", async () => {
    const capture = hangingAuditDeps();
    const w = memberWorld(capture);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await settle(w.set("viewer"))).toEqual({ developerId: SAM, role: "viewer" });
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action)).toEqual(["project_member.changed"]);
  });

  it("through the routes: PUT and DELETE /v1/app/projects/{name}/members/{id} record the change and the removal for the maintainer who made them", async () => {
    const capture = capturingAuditDeps();
    const h = await createDeveloperTaskBroker({ audit: capture });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    seedProject(h.db);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
    const put = await h.dev(OMAR, "PUT", `/v1/app/projects/payments/members/${MAYA.developerId}`, { requestId: randomUUID(), role: "viewer" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const del = await h.dev(OMAR, "DELETE", `/v1/app/projects/payments/members/${MAYA.developerId}`, { requestId: randomUUID() });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(capture.recordedBy("project_member.changed")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "member", id: OMAR.developerId }, related: [MAYA.developerId], facts: { toRole: "viewer" } })]);
    expect(capture.recordedBy("project_member.removed")).toEqual([expect.objectContaining({ facts: { role: "viewer" } })]);
  });
});

describe("a refusal keeps its meaning when the transaction carries an audit item", () => {
  /** An org with an owner and a second owner; the capture records into the same table. */
  async function ownersWorld() {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => Date.parse("2026-10-21T00:00:00.000Z"), audit: capture.audit });
    const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner" });
    await store.addMember({ orgId, developerId: "dev-2", role: "owner" });
    // The two joins that made the org are recorded too; what a test looks at is what comes after them.
    const setupIds = new Set(afterProjectBootstrap(capture.recorded()).map(event => event.eventId));
    const afterSetup = () => afterProjectBootstrap(capture.recorded()).filter(event => !setupIds.has(event.eventId));
    const beforeTransaction = (change: () => void) => {
      let armed = true;
      const real = db.send.bind(db) as (command: unknown) => Promise<unknown>;
      (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
        if (armed && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { armed = false; change(); }
        return real(command);
      };
    };
    return { capture, db, store, orgId, beforeTransaction, afterSetup };
  }

  it("a demotion of the last other owner between the read and the transaction is LAST_OWNER for a role change and for a removal, and nothing is recorded", async () => {
    const { db, store, orgId, beforeTransaction, afterSetup } = await ownersWorld();
    beforeTransaction(() => db.set({ ...db.get(orgMemberKey(orgId, "dev-2"))!, role: "member" }));
    await expect(store.setRole({ orgId, developerId: "owner", role: "member", by: { kind: "member", id: "owner" }, requestId: randomUUID() })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(db.get(orgMemberKey(orgId, "owner"))).toMatchObject({ role: "owner" });

    const second = await ownersWorld();
    second.beforeTransaction(() => second.db.set({ ...second.db.get(orgMemberKey(second.orgId, "dev-2"))!, role: "member" }));
    await expect(second.store.removeMember({ orgId: second.orgId, developerId: "owner", emails: [], ban: false, by: { kind: "member", id: "owner" } })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(second.db.get(orgMemberKey(second.orgId, "owner"))).toBeDefined();
    expect([...afterSetup(), ...second.afterSetup()]).toEqual([]);
  });

  it("a promotion between the read and the removal is CHANGE_STALE, and nothing is removed or recorded", async () => {
    const { db, store, orgId, beforeTransaction, afterSetup } = await ownersWorld();
    await store.addMember({ orgId, developerId: "dev-3", role: "member" });
    const joined = afterSetup().length;
    beforeTransaction(() => db.set({ ...db.get(orgMemberKey(orgId, "dev-3"))!, role: "admin" }));
    await expect(store.removeMember({ orgId, developerId: "dev-3", emails: [], ban: false, expectedRole: "member", by: { kind: "member", id: "owner" } })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(db.get(orgMemberKey(orgId, "dev-3"))).toMatchObject({ role: "admin" });
    expect(afterSetup()).toHaveLength(joined);
  });

  it("an invite into an org that has closed is INVITE_INVALID, the invite is not burnt, and nothing is recorded", async () => {
    const { capture, db, store, orgId, afterSetup } = await ownersWorld();
    const { token } = await store.createInvite({ orgId, createdBy: "owner", role: "member" });
    const created = afterSetup();expect(created.map(event => event.action)).toEqual(["org.invite_created"]);
    db.set({ ...db.get(orgMetaKey(orgId))!, closedAt: "2026-10-20T00:00:00.000Z" });
    await expect(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-new" })).rejects.toMatchObject({ code: "INVITE_INVALID", message: expect.stringContaining("closed") as string });
    expect(afterSetup()).toEqual(created);
    db.set({ ...db.get(orgMetaKey(orgId))!, closedAt: undefined });
    delete db.get(orgMetaKey(orgId))!.closedAt;
    expect(await store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-new" })).toMatchObject({ orgId });
    expect(capture.recordedBy("member.joined").filter((event) => event.facts?.via === "invite")).toHaveLength(1);
  });
});

describe("answers as today when the intake queue never answers (the remaining sites)", () => {
  it("settle keeps moving the fake clock while the call still waits on slow real work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = (async () => { await realDelay(300); await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_DEADLINE_MS)); return "done"; })();
    expect(await settle(slow)).toBe("done");
  });

  it("a removal and a leave", async () => {
    const capture = hangingAuditDeps();
    const h = await orgBroker(capture);
    const carl = person(h, "Carl", "admin");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect((await settle(h.dev(OMAR, "DELETE", `/v1/app/org/members/${carl.developerId}`))).status).toBe(200);
    expect((await settle(h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() }))).status).toBe(200);
    expect(h.db.get(orgMemberKey(TEST_ORG, carl.developerId))).toBeUndefined();
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toBeUndefined();
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action).sort()).toEqual(["member.left", "member.removal_completed", "member.removal_completed", "member.removed"]);
  });

  it("closing an org", async () => {
    const capture = hangingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "x", createdBy: "dev-owner", plan: "team" });
    db.set({ ...orgMemberKey(TEST_ORG, "dev-owner"), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: "dev-owner", role: "owner", joinedAt: "x" });
    db.set({ ...developerOrgKey("dev-owner"), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "owner", joinedAt: "x" });
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => Date.parse("2026-10-21T00:00:00.000Z"), audit: capture.audit });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await settle(store.closeOrg(TEST_ORG, { archiveProjects: async () => undefined, clearEgress: async () => undefined }));
    expect(db.get(orgMetaKey(TEST_ORG))?.closedAt).toBeDefined();
    expect(db.find((item) => item.pk === "AUDIT_SHRED_DUE")).toHaveLength(1);
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action).sort()).toEqual(["audit.org_shred_scheduled", "org.closed"]);
  });

  it("accepting an invite, creating an org and joining one", async () => {
    const capture = hangingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const store = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => Date.parse("2026-10-21T00:00:00.000Z"), audit: capture.audit });
    const orgId = await (async () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); return settle(store.createOrgWithOwner({ name: "Acme", developerId: "dev-owner" })); })();
    const { token } = await settle(store.createInvite({ orgId, createdBy: "dev-owner", role: "member" }));
    expect(await settle(store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId: "dev-new" }))).toMatchObject({ orgId });
    await settle(store.addMember({ orgId, developerId: "dev-third", role: "member" }));
    expect(db.get(orgMemberKey(orgId, "dev-new"))).toBeDefined();
    expect(afterProjectBootstrap(capture.pending()).filter(event => event.action === "member.joined").map((event) => event.facts?.via).sort()).toEqual(["invite", "org_created", "sign_in"]);
    expect(afterProjectBootstrap(capture.pending()).filter(event => event.action === "org.invite_created").length).toBe(1);
  });

  it("binding a requested installation, disconnecting one, and GitHub's own change", async () => {
    const capture = hangingAuditDeps();
    const w = githubWorld(capture);
    w.requested();
    w.bound(501);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await settle(bindRequestedInstallation(w.deps, "d-hang", w.created()))).toBe("bound");
    await settle(disconnectGithubInstallation(w.deps, { developerId: GH_OWNER, orgId: TEST_ORG, orgRole: "owner" }, 501));
    w.bound(502);
    expect(await settle(applyInstallationLifecycle(w.deps, "d-hang-2", { kind: "installation", action: "deleted", installationId: 502 }))).toBe("applied");
    expect(w.db.get(githubInstallationKey(601))).toMatchObject({ orgId: TEST_ORG });
    expect(w.db.get(githubInstallationKey(501))).toBeUndefined();
    expect(w.db.get(githubInstallationKey(502))).toMatchObject({ status: "removed" });
    expect(afterProjectBootstrap(capture.pending()).map((event) => event.action).sort()).toEqual(["github.connected", "github.disconnected", "github.installation_changed"]);
  });
});

describe("the sign-in function's wiring", () => {
  it("auditRuntimeFromEnvironment is absent without the intake queue and built from its environment with it", () => {
    expect(auditRuntimeFromEnvironment({ STATE_TABLE_NAME: "state-table" }, { component: "developer-identity" })).toBeUndefined();
    expect(auditRuntimeFromEnvironment({ AUDIT_INTAKE_QUEUE_URL: "", STATE_TABLE_NAME: "state-table" }, { component: "developer-identity" })).toBeUndefined();
    const runtime = auditRuntimeFromEnvironment({ AUDIT_INTAKE_QUEUE_URL: "https://sqs.test/queue.fifo", STATE_TABLE_NAME: "state-table", AWS_REGION: "us-east-1" }, { component: "developer-identity" });
    expect(runtime).toMatchObject({ queueUrl: "https://sqs.test/queue.fifo", tableName: "state-table" });
    expect(() => auditRuntimeFromEnvironment({ AUDIT_INTAKE_QUEUE_URL: "https://sqs.test/queue.fifo" }, { component: "developer-identity" })).toThrow("STATE_TABLE_NAME");
  });

  it("the stores it builds record a link and an accepted invite when given the runtime, and write plainly without it", async () => {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const input = { documentClient: db as never, stateTableName: AUDIT_CAPTURE_TABLE, signInTableName: "signin", now: () => SIGNIN_T0 };
    const audited = developerIdentityStores({ ...input, audit: capture.audit });
    seedMembership(db, cloudId, { orgId: TEST_ORG, role: "member" });
    await audited.store.linkIdentity({ identityKey: githubId, developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711" });
    expect(capture.recordedBy("identity.linked")).toHaveLength(1);

    const plainDb = new FakeDynamoDb();
    const plain = developerIdentityStores({ ...input, documentClient: plainDb as never });
    seedMembership(plainDb, cloudId, { orgId: TEST_ORG, role: "member" });
    await plain.store.linkIdentity({ identityKey: githubId, developerId: cloudId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711" });
    expect(plainDb.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toEqual([]);
    expect(audited.orgs).toBeInstanceOf(OrgStore);
  });
});

void [MAYA, TEST_ENV];
