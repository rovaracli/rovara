import { fixtureProject } from "../support/project-ai-source.js";
import { projectMemberKey } from "@agentx/contracts";
import { fixtureActor } from "../support/money-authority.js";
// Task 19: the Audit Ledger's hooks in Plan 3's code. Each audited action adds its pending audit item to the DynamoDB transaction that commits
// the action, so the action and its audit item are written together or not at all; the flush after the commit is best effort.
//
// Sites built so far and hooked here: the decide session's proof (what a decision will carry), the agent store (publish, rollback, adopting a
// built-in's version, owner, accountable maintainer, agent budget, the company's guardrails), the project AI settings and the org's spend policy,
// the org connection store (save, remove), and the member budget overrides that a member's removal or a merge rewrites.
// Not built yet (Tasks 21, 21a-wiring, 32, 33, 11, 12b, 13, 14): approvals decided and expired, write executions, spend requests, project
// connectors, opt-outs. Their hand-offs are listed in the Task 19 report.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AUDIT_FLUSH_DEADLINE_MS,
  agentGuardrailsKey,
  agentKey,
  agentVersionSk,
  auditEventId,
  builtinSettingsKey,
  connectionKey,
  orgProjectCatalogKey,
  orgSettingsKey,
  projectAiKey,
  type AuditEventInput,
  type OrgId,
} from "../../packages/contracts/src/index.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { decisionProofOf } from "../../packages/broker/src/audit/plan3-hooks.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { AgentStore, type BuiltinSource } from "../../packages/broker/src/agents/store.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import {
  DECIDE_COOKIE,
  DecideStore,
  csrfTokenFor,
  requireDecideSession,
  type DecideRequestContext,
} from "../../packages/broker/src/developer/decide-session.js";
import type { DecideInspection, DecideKind, DecideTarget } from "../../packages/broker/src/developer/decide-kinds.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { getApprovalSubjectHandler, type ApprovalDependencies, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { writeProjectAi, writeSpendPolicy } from "../../packages/broker/src/spend/settings.js";
import { BUILTIN_AGENTS, builtinRecipe, builtinDefaultPin, currentBuiltinVersion } from "../../packages/contracts/src/agent-templates.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { RUN_LIMIT_MULTIPLIER, defaultSpendPolicy } from "../../packages/contracts/src/spend.js";
import type { AgentId, AgentOwner } from "../../packages/contracts/src/agent-node.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { capturingAuditDeps, hangingAuditDeps, AUDIT_CAPTURE_TABLE, type AuditCapture } from "../support/audit-capture.js";
import { MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

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

/** Runs a call to its end under fake timers: the flush's deadline timer is set only once the call has reached it, so time moves until it is done. */
async function settle<T>(call: Promise<T>): Promise<T> {
  let finished = false;
  void call.then(() => { finished = true; }, () => { finished = true; });
  for (let step = 0; step < 100 && !finished; step += 1) await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
  return call;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const DIGEST = "d".repeat(64);
const STEP = { id: "work", name: "Work", kind: "agent", workspace: "none" } as const;
const SAFE = { instructions: "Summarise the open tickets.", sequence: [STEP] };
const MEMBER_ALICE: AgentOwner = { kind: "member", developerId: ALICE };

// ---------------------------------------------------------------------------------------------------------------------
// The decide session's proof
// ---------------------------------------------------------------------------------------------------------------------

describe("the decide session's proof", () => {
  const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
  const APR = "apr_aaaaaaaaaaaaaaaaaaaa";
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const seconds = (ms: number) => Math.floor(ms / 1000);

  function decideSetup() {
    let clock = T0;
    const db = new FakeDynamoDb();
    const store = new DecideStore({ documentClient: db, tableName: "signin", now: () => clock });
    const seen: Array<{ target: DecideTarget; decision: string; proof: unknown }> = [];
    const kind: DecideKind = {
      async inspect(): Promise<DecideInspection> { return { status: "open", view: { title: "Run a write", facts: [] } }; },
      async decide(target, decision, proof) { seen.push({ target, decision, proof }); return { message: "Approved." }; },
    };
    const context: DecideRequestContext = { store, now: () => clock, cellOrigin: CELL, kinds: { apr: kind } };
    const sessionFor = async (agoSeconds: number, cookie = `cookie-${"x".repeat(40)}`) => {
      const signedInAt = seconds(clock) - agoSeconds;
      await store.putSession(cookie, { orgId: ORG, developerId: ALICE, approvalId: APR, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
      return { cookie, signedInAt };
    };
    return { db, store, context, seen, sessionFor, tick: (ms: number) => { clock += ms; } };
  }
  const post = (cookie: string) => ({
    method: "POST", path: `/v1/app/approve/${APR}`,
    headers: { origin: CELL, "content-type": "application/x-www-form-urlencoded", cookie: `${DECIDE_COOKIE}=${cookie}` },
    body: new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString(),
  });

  it("is a fresh sign-in by email code, with the session's own sign-in time and a hash of the session's key", async () => {
    const s = decideSetup();
    const { cookie, signedInAt } = await s.sessionFor(120);
    const authority = await requireDecideSession(s.context, post(cookie));
    expect(authority.proof).toEqual({
      kind: "fresh_sign_in", method: "email_code", authTime: new Date(signedInAt * 1000).toISOString(),
      sessionRef: sha(`DECIDE_SESSION#${sha(cookie)}`),
    });
    // The time of the sign-in, not of the decision, and never the cookie itself.
    expect(JSON.stringify(authority.proof)).not.toContain(cookie);
  });

  it("is also on a read of the page, so the page and the decision see the same session", async () => {
    const s = decideSetup();
    const { cookie } = await s.sessionFor(30);
    const authority = await requireDecideSession(s.context, { method: "GET", path: `/v1/app/approve/${APR}`, headers: { cookie: `${DECIDE_COOKIE}=${cookie}` } });
    expect(authority.proof).toMatchObject({ kind: "fresh_sign_in", method: "email_code" });
  });

  it("is handed to the kind that makes the decision", async () => {
    const s = decideSetup();
    const { cookie, signedInAt } = await s.sessionFor(200);
    const reply = await routeDecidePage(s.context, { ...post(cookie), requestId: "r" }, new URL(`${CELL}/v1/app/approve/${APR}`));
    expect(reply.statusCode).toBe(200);
    expect(s.seen).toEqual([{
      target: { orgId: ORG, developerId: ALICE, approvalId: APR }, decision: "approve",
      proof: { kind: "fresh_sign_in", method: "email_code", authTime: new Date(signedInAt * 1000).toISOString(), sessionRef: sha(`DECIDE_SESSION#${sha(cookie)}`) },
    }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The agent store
// ---------------------------------------------------------------------------------------------------------------------

function builtinsWithRelease(release: { ticketTriage: number }): BuiltinSource {
  return {
    currentVersion: (id) => (id === "ticket-triage" ? release.ticketTriage : currentBuiltinVersion(id as "rovara-code")),
    defaultPin: (id) => (id === "ticket-triage" ? release.ticketTriage : builtinDefaultPin(id as "rovara-code")),
    recipe: (id, version) => {
      if (id !== "ticket-triage" || version <= currentBuiltinVersion("ticket-triage")) return builtinRecipe(id as "rovara-code", version);
      if (version > release.ticketTriage) return builtinRecipe(id, version);
      const v1 = builtinRecipe("ticket-triage", 1);
      return { ...v1, chain: [{ ...v1.chain[0]!, version }], instructions: [{ agentName: "Ticket triage", text: `release ${String(version)}` }] };
    },
    name: (id) => BUILTIN_AGENTS[id as "rovara-code"].name,
  };
}

function storeSetup(options: { capture?: AuditCapture | "none" } = {}) {
  const capture = options.capture === "none" ? undefined : options.capture ?? capturingAuditDeps();
  const db = new FakeDynamoDb();
  capture?.attach(db);
  const transactions = recordTransactions(db);
  const clock = { now: T0 };
  const release = { ticketTriage: 1 };
  let counter = 0;
  const store = new AgentStore({
    documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, newId: () => `agt_${String(++counter).padStart(20, "0")}`,
    builtins: builtinsWithRelease(release), ...(capture === undefined ? {} : { audit: capture.audit }),
  });
  const eventItems = (agentId: string) => db.find((item) => item.pk === agentKey(TEST_ORG, agentId, "META").pk && String(item.sk).startsWith("EVENT#")).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  const make = (name = "Release notes", owner: AgentOwner = MEMBER_ALICE, extra: { accountable?: { developerId: string } } = {}) =>
    store.create({ orgId: TEST_ORG, name, owner, overlay: SAFE, createdBy: ALICE, ...(extra.accountable === undefined ? {} : { accountable: extra.accountable }) });
  const publish = async (agentId: AgentId, extra: { safety?: "safe" | "less_safe"; by?: string } = {}) => {
    const agent = (await store.get(TEST_ORG, agentId))!;
    return store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: DIGEST, by: extra.by ?? ALICE, ...(extra.safety === undefined ? {} : { safety: extra.safety }) });
  };
  return { capture, db, transactions, clock, release, store, eventItems, make, publish };
}

/** The `EVENT#` item a store write left for the agent, last one of its kind. */
const lastEventOf = (s: ReturnType<typeof storeSetup>, agentId: string, kind: string) => s.eventItems(agentId).filter((item) => item.kind === kind).at(-1)!;

describe("agent.published", () => {
  it("records a safe publish in the transaction that writes the version, with the store's event as its occurrence", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.publish(agent.agentId);

    const [transaction, ...rest] = auditedTransactions(s.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, agentKey(TEST_ORG, agent.agentId, "META").pk, agentVersionSk(1))).toBe(true);
    expect(writes(transaction!, agentKey(TEST_ORG, agent.agentId, "META").pk, "META")).toBe(true);
    const event = lastEventOf(s, agent.agentId, "published");
    expect(pendingIn(transaction!)).toEqual([{
      eventId: auditEventId("agent.published", String(event.sk)), orgId: TEST_ORG, action: "agent.published",
      actor: { kind: "member", id: ALICE }, target: { kind: "agent", id: agent.agentId }, occurredAt: String(event.at), facts: { version: 1, safety: "safe" },
    }]);
    expect(s.capture!.flushed().map((flushed) => flushed.action)).toEqual(["agent.published"]);
    expect(s.capture!.pending()).toEqual([]);
  });

  it("says a publish that a person confirmed was less safe, and names the person who confirmed it as the actor", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.publish(agent.agentId, { safety: "less_safe", by: BOB });
    expect(s.capture!.recordedBy("agent.published")).toMatchObject([{ actor: { kind: "member", id: BOB }, facts: { version: 1, safety: "less_safe" } }]);
  });

  it("numbers each publish apart: the same facts later are another occurrence", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.publish(agent.agentId);
    s.clock.now += 1000;
    await s.publish(agent.agentId);
    const events = s.capture!.recordedBy("agent.published");
    expect(events.map((event) => event.facts)).toEqual([{ version: 1, safety: "safe" }, { version: 2, safety: "safe" }]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records nothing for a publish that is refused, and nothing again for a repeat of the same request", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await expect(s.store.publish({ orgId: TEST_ORG, agentId: agent.agentId, expectedDraftRevision: 9, digest: DIGEST, by: ALICE })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(s.capture!.recorded()).toEqual([]);

    const request = { orgId: TEST_ORG, developerId: ALICE, requestId: randomUUID(), fingerprint: "f".repeat(64) };
    const input = { orgId: TEST_ORG, agentId: agent.agentId, expectedDraftRevision: 1, digest: DIGEST, by: ALICE, request };
    await s.store.publish(input);
    await expect(s.store.publish(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(s.capture!.recordedBy("agent.published")).toHaveLength(1);
  });

  it("returns at the flush deadline when the queue never answers, and leaves the event pending for the drain", async () => {
    vi.useFakeTimers();
    const hanging = hangingAuditDeps();
    const s = storeSetup({ capture: hanging });
    const agent = await settle(s.make());
    const published = await settle(s.publish(agent.agentId));
    expect(published.version).toBe(1);
    expect(hanging.pending().map((event) => event.action)).toEqual(["agent.published"]);
  });

  it("goes on without an event when the event is not valid, and says so in the log without a value", async () => {
    const s = storeSetup();
    const agent = await s.make();
    const published = await s.publish(agent.agentId, { by: "x".repeat(101) });
    expect(published.version).toBe(1);
    expect(s.capture!.recorded()).toEqual([]);
    expect(s.capture!.logs).toEqual([expect.objectContaining({ event: "audit.record_invalid", level: "error", action: "agent.published" })]);
    expect(JSON.stringify(s.capture!.logs)).not.toContain("xxxx");
  });

  it("on an install with no ledger adds no item to the transaction", async () => {
    const s = storeSetup({ capture: "none" });
    const agent = await s.make();
    await s.publish(agent.agentId);
    expect(s.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toEqual([]);
    expect(s.transactions.every((transaction) => !transaction.some(isPendingItem))).toBe(true);
  });
});

describe("agent.rolled_back and builtin.adopted", () => {
  it("records a rollback in the transaction that moves the current version", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.publish(agent.agentId);
    s.clock.now += 1000;
    await s.publish(agent.agentId);
    s.clock.now += 1000;
    await s.store.rollback({ orgId: TEST_ORG, agentId: agent.agentId, version: 1, expectedCurrentVersion: 2, by: BOB });

    const transaction = auditedTransactions(s.transactions).at(-1)!;
    expect(writes(transaction, agentKey(TEST_ORG, agent.agentId, "META").pk, "META")).toBe(true);
    const event = lastEventOf(s, agent.agentId, "rolled_back");
    expect(pendingIn(transaction)).toEqual([{
      eventId: auditEventId("agent.rolled_back", String(event.sk)), orgId: TEST_ORG, action: "agent.rolled_back",
      actor: { kind: "member", id: BOB }, target: { kind: "agent", id: agent.agentId }, occurredAt: String(event.at), facts: { fromVersion: 2, toVersion: 1 },
    }]);
  });

  it("records no rollback that is refused because the current version moved", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.publish(agent.agentId);
    await expect(s.store.rollback({ orgId: TEST_ORG, agentId: agent.agentId, version: 1, expectedCurrentVersion: 7, by: BOB })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(s.capture!.recordedBy("agent.rolled_back")).toEqual([]);
  });

  it("records adopting a built-in's version with the built-in as the target", async () => {
    const s = storeSetup();
    await s.store.ensureBuiltinSettings(TEST_ORG, "ticket-triage", ALICE);
    s.release.ticketTriage = 2;
    s.clock.now += 1000;
    await s.store.adoptBuiltinVersion({ orgId: TEST_ORG, agentId: "ticket-triage", version: 2, expectedPinnedVersion: 1, by: BOB });

    const transaction = auditedTransactions(s.transactions).at(-1)!;
    expect(writes(transaction, builtinSettingsKey(TEST_ORG, "ticket-triage").pk, "ticket-triage")).toBe(true);
    const event = lastEventOf(s, "ticket-triage", "base_updated");
    expect(pendingIn(transaction)).toEqual([{
      eventId: auditEventId("builtin.adopted", String(event.sk)), orgId: TEST_ORG, action: "builtin.adopted",
      actor: { kind: "member", id: BOB }, target: { kind: "agent", id: "ticket-triage" }, occurredAt: String(event.at), facts: { version: 2 },
    }]);
  });
});

describe("agent.owner_changed", () => {
  it("records a move to another member in the owner transaction, naming both people and nothing personal in the facts", async () => {
    const s = storeSetup();
    const agent = await s.make();
    s.clock.now += 1000;
    await s.store.setOwner(TEST_ORG, agent.agentId, { kind: "member", developerId: BOB }, ALICE, undefined, undefined, { actor: fixtureActor(s.store, TEST_ORG, ALICE) });

    const transaction = auditedTransactions(s.transactions).at(-1)!;
    expect(writes(transaction, agentKey(TEST_ORG, agent.agentId, "META").pk, "META")).toBe(true);
    const event = lastEventOf(s, agent.agentId, "owner_changed");
    expect(pendingIn(transaction)).toEqual([{
      eventId: auditEventId("agent.owner_changed", String(event.sk)), orgId: TEST_ORG, action: "agent.owner_changed",
      actor: { kind: "member", id: ALICE }, target: { kind: "agent", id: agent.agentId }, occurredAt: String(event.at), related: [ALICE, BOB], facts: { field: "owner" },
    }]);
  });

  it("puts a project's name in the details, never in the facts, the target or the related ids", async () => {
    const s = storeSetup();
    const agent = await s.make();
    s.clock.now += 1000;
    await s.store.setOwner(TEST_ORG, agent.agentId, { kind: "project", project: "web" }, ALICE, { developerId: BOB }, undefined, { actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    const [event] = s.capture!.recordedBy("agent.owner_changed");
    expect(event).toMatchObject({ facts: { field: "owner" }, related: [ALICE, BOB], details: [{ subject: "org", fields: { toProject: "web" } }] });
    expect(JSON.stringify({ ...event, details: undefined })).not.toContain("web");
  });

  it("records a change of the accountable maintainer, for a project's agent and for a built-in", async () => {
    const s = storeSetup();
    const agent = await s.make("Web helper", { kind: "project", project: "web" }, { accountable: { developerId: ALICE } });
    s.clock.now += 1000;
    await s.store.setAccountable(TEST_ORG, agent.agentId, { developerId: BOB }, ALICE, undefined, { actor: fixtureActor(s.db, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await s.store.setAccountable(TEST_ORG, "ticket-triage", { developerId: BOB }, fixtureActor(s.store, TEST_ORG, ALICE, true).developerId, undefined, { actor: fixtureActor(s.store, TEST_ORG, ALICE, true) });
    const events = s.capture!.recordedBy("agent.owner_changed");
    expect(events).toMatchObject([
      { target: { kind: "agent", id: agent.agentId }, facts: { field: "accountable" }, related: [BOB, ALICE] },
      { target: { kind: "agent", id: "ticket-triage" }, facts: { field: "accountable" }, related: [BOB] },
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("records no move that is refused", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await expect(s.store.setOwner(TEST_ORG, agent.agentId, { kind: "project", project: "web" }, ALICE, undefined, undefined, { actor: fixtureActor(s.store, TEST_ORG, ALICE) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(s.capture!.recorded()).toEqual([]);
  });
});

describe("budget.changed on an agent", () => {
  it("records each limit the write changes, with its own id, in the budget transaction", async () => {
    const s = storeSetup();
    const agent = await s.make();
    s.clock.now += 1000;
    await s.store.setBudget(TEST_ORG, agent.agentId, { monthlyUsd: 40, maxPerRunUsd: 5 }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });

    const transaction = auditedTransactions(s.transactions).at(-1)!;
    expect(writes(transaction, agentKey(TEST_ORG, agent.agentId, "META").pk, "META")).toBe(true);
    const event = lastEventOf(s, agent.agentId, "budget_changed");
    const budget = (field: string, toCents: number) => ({
      eventId: auditEventId("budget.changed", auditOccurrence(String(event.sk), field)), orgId: TEST_ORG, action: "budget.changed",
      actor: { kind: "member", id: ALICE }, target: { kind: "budget", id: agent.agentId }, occurredAt: String(event.at), facts: { scopeKind: "agent", field, toCents },
    });
    expect(pendingIn(transaction)).toEqual([budget("agent_monthly_limit", 4000), budget("agent_max_per_run", 500)]);
  });

  it("gives the old figure when there was one, leaves the new one out when a limit is cleared, and records nothing when nothing changed", async () => {
    const s = storeSetup();
    const agent = await s.make();
    await s.store.setBudget(TEST_ORG, agent.agentId, { monthlyUsd: 40 }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await s.store.setBudget(TEST_ORG, agent.agentId, { monthlyUsd: 25.5 }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await s.store.setBudget(TEST_ORG, agent.agentId, { monthlyUsd: 25.5 }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await s.store.setBudget(TEST_ORG, agent.agentId, { monthlyUsd: null }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    expect(s.capture!.recordedBy("budget.changed").map((event) => event.facts)).toEqual([
      { scopeKind: "agent", field: "agent_monthly_limit", toCents: 4000 },
      { scopeKind: "agent", field: "agent_monthly_limit", fromCents: 4000, toCents: 2550 },
      { scopeKind: "agent", field: "agent_monthly_limit", fromCents: 2550 },
    ]);
  });

  it("records a built-in's budget against the built-in", async () => {
    const s = storeSetup();
    await s.store.setBudget(TEST_ORG, "ticket-triage", { monthlyUsd: 10 }, fixtureActor(s.store, TEST_ORG, ALICE).developerId, undefined, { ...({}), actor: fixtureActor(s.store, TEST_ORG, ALICE) });
    expect(s.capture!.recordedBy("budget.changed")).toMatchObject([{ target: { kind: "budget", id: "ticket-triage" }, facts: { scopeKind: "agent", field: "agent_monthly_limit", toCents: 1000 } }]);
  });
});

describe("guardrails.changed", () => {
  it("records the new revision in the guardrails transaction, and whether the change widened what agents may do", async () => {
    const s = storeSetup();
    await s.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 0, by: ALICE }), by: fixtureActor(s.store, TEST_ORG, ALICE, true).developerId, actor: fixtureActor(s.store, TEST_ORG, ALICE, true) });
    s.clock.now += 1000;
    await s.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 1, by: BOB, widened: true }), by: fixtureActor(s.store, TEST_ORG, BOB, true).developerId, actor: fixtureActor(s.store, TEST_ORG, BOB, true) });

    const [first, second] = auditedTransactions(s.transactions);
    expect(writes(first!, agentGuardrailsKey(TEST_ORG).pk)).toBe(true);
    expect(pendingIn(first!)).toEqual([{
      eventId: auditEventId("guardrails.changed", auditOccurrence("1")), orgId: TEST_ORG, action: "guardrails.changed",
      actor: { kind: "member", id: ALICE }, target: { kind: "guardrails", id: TEST_ORG }, occurredAt: "2026-10-22T09:00:00.000Z", facts: { revision: 1, widened: false },
    }]);
    expect(pendingIn(second!)).toMatchObject([{ actor: { kind: "member", id: BOB }, facts: { revision: 2, widened: true } }]);
  });

  it("records nothing for a write against a revision that moved", async () => {
    const s = storeSetup();
    await s.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 0, by: ALICE }), by: fixtureActor(s.store, TEST_ORG, ALICE, true).developerId, actor: fixtureActor(s.store, TEST_ORG, ALICE, true) });
    await expect(s.store.putGuardrails({ ...({ orgId: TEST_ORG, guardrails: DEFAULT_AGENT_GUARDRAILS, expectedRevision: 0, by: BOB }), by: fixtureActor(s.store, TEST_ORG, BOB, true).developerId, actor: fixtureActor(s.store, TEST_ORG, BOB, true) })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(s.capture!.recordedBy("guardrails.changed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Project AI settings and the spend policy
// ---------------------------------------------------------------------------------------------------------------------

describe("budget.changed on a project, and spend_policy.changed", () => {
  function settingsSetup() {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    fixtureProject(db, TEST_ORG, "web");
    capture.attach(db);
    const transactions = recordTransactions(db);
    const clock = { now: T0 };
    const deps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: capture.audit };
    return { capture, db, transactions, clock, deps };
  }

  it("records a project's monthly budget in the transaction that writes the settings; the project is a name-keyed target", async () => {
    const s = settingsSetup();
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, monthlyBudgetUsd: 200 }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, monthlyBudgetUsd: 300 }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });

    const [first, second] = auditedTransactions(s.transactions);
    expect(writes(first!, projectAiKey(TEST_ORG, "web").pk, "SETTINGS")).toBe(true);
    expect(pendingIn(first!)).toEqual([{
      eventId: auditEventId("budget.changed", auditOccurrence("web", "1", "project_monthly_limit")), orgId: TEST_ORG, action: "budget.changed",
      actor: { kind: "member", id: ALICE }, target: { kind: "project", name: "web" }, occurredAt: "2026-10-22T09:00:00.000Z",
      facts: { scopeKind: "project", field: "project_monthly_limit", toCents: 20000 },
    }]);
    expect(pendingIn(second!)).toMatchObject([{ facts: { scopeKind: "project", field: "project_monthly_limit", fromCents: 20000, toCents: 30000 } }]);
  });

  it("records each planning limit that moved, and nothing for a change that moves no money", async () => {
    const s = settingsSetup();
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, planningLimitUsd: { QUICK: 4 } }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: true, planningLimitUsd: { QUICK: 4, FULL: 9 } }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    s.clock.now += 1000;
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, planningLimitUsd: { QUICK: 4, FULL: 9 } }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 2 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    expect(s.capture.recordedBy("budget.changed").map((event) => event.facts)).toEqual([
      { scopeKind: "project", field: "project_planning_limit_quick", toCents: 400 },
      { scopeKind: "project", field: "project_planning_limit_full", toCents: 900 },
    ]);
  });

  it("records nothing for a write that is refused because the settings moved", async () => {
    const s = settingsSetup();
    await writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, monthlyBudgetUsd: 200 }, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    await expect(writeProjectAi(s.deps, TEST_ORG, "web", { projectPays: false, monthlyBudgetUsd: 500 }, fixtureActor(s.deps, TEST_ORG, BOB).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, BOB) })).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    expect(s.capture.recordedBy("budget.changed")).toHaveLength(1);
  });

  it("records each spend policy figure that changed, as whole numbers: cents, and the multiplier in hundredths", async () => {
    const s = settingsSetup();
    const first = { ...defaultSpendPolicy(), leadApprovalThresholdUsd: 20, runLimitMultiplier: 3 };
    await writeSpendPolicy(s.deps, TEST_ORG, first, fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });

    const [transaction] = auditedTransactions(s.transactions);
    expect(writes(transaction!, orgSettingsKey(TEST_ORG, "SPEND_POLICY").pk, "SPEND_POLICY")).toBe(true);
    const defaults = defaultSpendPolicy();
    expect(pendingIn(transaction!)).toEqual([
      {
        eventId: auditEventId("spend_policy.changed", auditOccurrence("1", "leadApprovalThresholdUsd")), orgId: TEST_ORG, action: "spend_policy.changed",
        actor: { kind: "member", id: ALICE }, target: { kind: "spend_policy", id: TEST_ORG }, occurredAt: "2026-10-22T09:00:00.000Z",
        facts: { field: "leadApprovalThresholdUsd", from: defaults.leadApprovalThresholdUsd * 100, to: 2000 },
      },
      expect.objectContaining({ facts: { field: "runLimitMultiplier", from: RUN_LIMIT_MULTIPLIER * 100, to: 300 } }),
    ]);

    s.clock.now += 1000;
    await writeSpendPolicy(s.deps, TEST_ORG, { ...first, ownerAgentBudgetCapUsd: 150.5 }, fixtureActor(s.deps, TEST_ORG, BOB).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(s.deps, TEST_ORG, BOB) });
    expect(s.capture.recordedBy("spend_policy.changed").at(-1)).toMatchObject({ actor: { kind: "member", id: BOB }, facts: { field: "ownerAgentBudgetCapUsd", from: defaults.ownerAgentBudgetCapUsd * 100, to: 15050 } });
  });

  it("records nothing for a write that changes no figure, and nothing on an install with no ledger", async () => {
    const s = settingsSetup();
    await writeSpendPolicy(s.deps, TEST_ORG, defaultSpendPolicy(), fixtureActor(s.deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(s.deps, TEST_ORG, ALICE) });
    expect(s.capture.recorded()).toEqual([]);

    const plain = new FakeDynamoDb();
    const plainTransactions = recordTransactions(plain);
    await writeSpendPolicy({ documentClient: plain, tableName: "state", now: () => T0 }, TEST_ORG, { ...defaultSpendPolicy(), leadApprovalThresholdUsd: 20 }, fixtureActor({ documentClient: plain, tableName: "state", now: () => T0 }, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor({ documentClient: plain, tableName: "state", now: () => T0 }, TEST_ORG, ALICE) });
    expect(plainTransactions.every((transaction) => !transaction.some(isPendingItem))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Org connections
// ---------------------------------------------------------------------------------------------------------------------

describe("connection.saved and connection.removed", () => {
  const CON = "con_aaaaaaaaaaaaaaaaaaaa";
  const LINEAR_KEY = "lin_api_SECRETKEYVALUE0123456789";
  const LINEAR = { connectionId: CON, type: "linear", label: "Team Linear", access: "read" } as const;

  function connectionSetup(capture: AuditCapture | "none" = capturingAuditDeps()) {
    const clock = { now: T0 };
    const db = new FakeDynamoDb();
    const real = capture === "none" ? undefined : capture;
    real?.attach(db);
    const transactions = recordTransactions(db);
    const fake = new FakeOrgSecrets({ env: "staging", now: () => clock.now });
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => clock.now });
    const store = new OrgConnectionStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, env: "staging", secrets, now: () => clock.now, ...(real === undefined ? {} : { audit: real.audit }) });
    return { capture: real, db, transactions, clock, store };
  }

  it("records a new connection in the transaction that writes it, with no part of the secret or the label anywhere in the event", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });

    const [transaction, ...rest] = auditedTransactions(s.transactions);
    expect(rest).toEqual([]);
    expect(writes(transaction!, connectionKey(TEST_ORG, CON).pk)).toBe(true);
    expect(pendingIn(transaction!)).toEqual([{
      eventId: auditEventId("connection.saved", auditOccurrence(CON, "2026-10-22T09:00:00.000Z")), orgId: TEST_ORG, action: "connection.saved",
      actor: { kind: "member", id: ALICE }, target: { kind: "connection", id: CON }, occurredAt: "2026-10-22T09:00:00.000Z", facts: { connectorType: "linear" },
    }]);
    const everything = JSON.stringify([s.capture!.flushed(), s.capture!.pendingItems(), s.transactions.map((tx) => tx.filter(isPendingItem)), s.capture!.logs]);
    expect(everything).not.toContain(LINEAR_KEY);
    expect(everything).not.toContain("Team Linear");
  });

  it("records a change of an existing connection in the single write that changes it, and uses the request id when it has one", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    s.clock.now += 1000;
    const requestId = randomUUID();
    await s.store.put({ orgId: TEST_ORG, connection: { ...LINEAR, access: "read_write" }, by: BOB, requestId });

    // The change and its audit item are one transaction: two audited transactions in all (the create, then this one), and the second holds the request's event.
    const audited = auditedTransactions(s.transactions);
    expect(audited).toHaveLength(2);
    expect(writes(audited[1]!, connectionKey(TEST_ORG, CON).pk)).toBe(true);
    expect(pendingIn(audited[1]!)).toMatchObject([{ eventId: auditEventId("connection.saved", auditOccurrence(requestId, CON)), actor: { kind: "member", id: BOB } }]);
    expect(s.capture!.recordedBy("connection.saved")).toHaveLength(2);
  });

  it("records the removal in the transaction that deletes the records, with the connection's type", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    s.clock.now += 1000;
    await s.store.remove({ orgId: TEST_ORG, connectionId: CON, by: BOB });

    const transaction = auditedTransactions(s.transactions).at(-1)!;
    expect(transaction.filter((item) => item.Delete !== undefined)).toHaveLength(2);
    expect(pendingIn(transaction)).toEqual([{
      eventId: auditEventId("connection.removed", auditOccurrence(CON, "2026-10-22T09:00:01.000Z")), orgId: TEST_ORG, action: "connection.removed",
      actor: { kind: "member", id: BOB }, target: { kind: "connection", id: CON }, occurredAt: "2026-10-22T09:00:01.000Z", facts: { connectorType: "linear" },
    }]);
  });

  it("records the removal by Rovara itself only when the caller says \"system\", and nothing when the connection does not exist", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, by: ALICE });
    await expect(s.store.remove({ orgId: TEST_ORG, connectionId: "con_bbbbbbbbbbbbbbbbbbbb", by: BOB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    s.clock.now += 1000;
    await s.store.remove({ orgId: TEST_ORG, connectionId: CON, by: "system" });
    expect(s.capture!.recordedBy("connection.removed")).toMatchObject([{ actor: { kind: "system", id: "rovara" } }]);
  });

  it("refuses a removal that names nobody, so a person's removal is never recorded as Rovara's", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, by: ALICE });
    const removal = s.store.remove({ orgId: TEST_ORG, connectionId: CON } as unknown as Parameters<typeof s.store.remove>[0]);
    await expect(removal).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await s.store.get(TEST_ORG, CON)).toBeDefined();
    expect(s.capture!.recordedBy("connection.removed")).toEqual([]);
  });

  it("of two removes at once only one commits and records; the other finds no connection", async () => {
    const s = connectionSetup();
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, by: ALICE });
    s.clock.now += 1000;
    const outcomes = await Promise.allSettled([
      s.store.remove({ orgId: TEST_ORG, connectionId: CON, by: ALICE }),
      s.store.remove({ orgId: TEST_ORG, connectionId: CON, by: BOB }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FOUND" });
    expect(s.capture!.recordedBy("connection.removed")).toHaveLength(1);
  });

  it("records nothing for a save that is refused before anything is written", async () => {
    const s = connectionSetup();
    await expect(s.store.put({ orgId: TEST_ORG, connection: LINEAR, secret: { token: "wrong shape" }, by: ALICE })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(s.capture!.recorded()).toEqual([]);
  });

  it("returns at the flush deadline when the queue never answers, with the change committed and the event pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = hangingAuditDeps();
    const s = connectionSetup(hanging);
    await settle(s.store.put({ orgId: TEST_ORG, connection: LINEAR, by: ALICE }));
    expect(await s.store.get(TEST_ORG, CON)).toMatchObject({ connectionId: CON });
    expect(hanging.pending().map((event) => event.action)).toEqual(["connection.saved"]);
  });

  it("on an install with no ledger adds no item to either write", async () => {
    const s = connectionSetup("none");
    await s.store.put({ orgId: TEST_ORG, connection: LINEAR, by: ALICE });
    await s.store.put({ orgId: TEST_ORG, connection: { ...LINEAR, access: "read_write" }, by: ALICE });
    await s.store.remove({ orgId: TEST_ORG, connectionId: CON, by: ALICE });
    expect(s.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A member's budget override, rewritten by Rovara
// ---------------------------------------------------------------------------------------------------------------------

describe("budget.changed when Rovara rewrites a member's override", () => {
  const OWNER = "o".repeat(64);
  const seedBudget = (db: FakeDynamoDb, orgId: OrgId, item: Record<string, unknown>) => db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", updatedBy: OWNER, updatedAt: "2026-10-01T00:00:00.000Z", ...item });

  async function removalSetup() {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const transactions = recordTransactions(db);
    const orgs = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit });
    const orgId = await orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER });
    await orgs.addMember({ orgId, developerId: ALICE, role: "member" });
    return { capture, db, transactions, orgs, orgId };
  }

  it("records removing a member's own limit in the same write, by the system, as a fall back to the default", async () => {
    const s = await removalSetup();
    seedBudget(s.db, s.orgId, { orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 20, memberOverrides: { [ALICE]: 40, [BOB]: 10 } });
    await s.orgs.removeMember({ orgId: s.orgId, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: OWNER } });

    const budgetKey = orgSettingsKey(s.orgId, "BUDGET");
    const withBudget = auditedTransactions(s.transactions).filter((transaction) => writes(transaction, budgetKey.pk, budgetKey.sk));
    expect(withBudget).toHaveLength(1);
    const events = s.capture.recordedBy("budget.changed");
    expect(events).toEqual([{
      eventId: expect.stringMatching(/^aev_[0-9a-f]{40}$/) as string, orgId: s.orgId, action: "budget.changed", actor: { kind: "system", id: "rovara" },
      target: { kind: "budget", id: ALICE }, occurredAt: expect.any(String) as string, related: [ALICE],
      facts: { scopeKind: "member", field: "member_monthly_limit", fromCents: 4000, toCents: 2000 },
    }]);
    // The person's removal is recorded too, and the other member's override stays.
    expect(s.capture.recordedBy("member.removed")).toHaveLength(1);
    expect(s.db.get(budgetKey)).toMatchObject({ memberOverrides: { [BOB]: 10 } });
  });

  it("records nothing when the member had no limit of their own", async () => {
    const s = await removalSetup();
    seedBudget(s.db, s.orgId, { orgMonthlyUsd: 500, memberDefaultMonthlyUsd: 20, memberOverrides: { [BOB]: 10 } });
    await s.orgs.removeMember({ orgId: s.orgId, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: OWNER } });
    expect(s.capture.recordedBy("budget.changed")).toEqual([]);
  });

  it("records nothing more when the removal is run again after it finished", async () => {
    const s = await removalSetup();
    seedBudget(s.db, s.orgId, { memberDefaultMonthlyUsd: 20, memberOverrides: { [ALICE]: 40 } });
    await s.orgs.removeMember({ orgId: s.orgId, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: OWNER } });
    await expect(s.orgs.removeMember({ orgId: s.orgId, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: OWNER } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.capture.recordedBy("budget.changed")).toHaveLength(1);
  });

  async function mergeWorld(overrides: Record<string, number>, at = T0) {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => T0 });
    const orgs = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0 });
    const survivor = ownerKeyForSubject("https://idp.example.test", "priya-cloud-1");
    const duplicate = ownerKeyForSubject("https://github.com", "4711");
    const email = "priya@acme.dev";
    const record = (developerId: string, provider: string, issuer: string, subject: string) =>
      ({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider, issuer, subject, displayName: "Priya", email, firstSignInAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-02T00:00:00.000Z", revoked: false });
    db.set(record(survivor, "cloud", "https://idp.example.test", "priya-cloud-1"));
    db.set(record(duplicate, "github", "https://github.com", "4711"));
    const orgId = await orgs.createOrgWithOwner({ name: "Priya's team", developerId: survivor, email });
    await orgs.addMember({ orgId, developerId: duplicate, role: "member" });
    seedBudget(db, orgId, { memberDefaultMonthlyUsd: 20, memberOverrides: Object.fromEntries(Object.entries(overrides).map(([who, limit]) => [who === "survivor" ? survivor : duplicate, limit])) });
    const merged = await mergeDuplicateMember(
      { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, signInStore: signIn, now: () => at, audit: capture.audit },
      { orgId, survivorId: survivor, duplicateId: duplicate, duplicateIdentityKey: duplicate },
    );
    return { capture, db, merged, survivor, duplicate };
  }

  it("records a merge that moves the duplicate's limit to the survivor as two changes, by the system", async () => {
    const w = await mergeWorld({ duplicate: 35 });
    expect(w.merged.overrideMoved).toBe(true);
    expect(w.capture.recordedBy("budget.changed").map((event) => [event.target, event.facts, event.actor, event.related])).toEqual([
      [{ kind: "budget", id: w.duplicate }, { scopeKind: "member", field: "member_monthly_limit", fromCents: 3500, toCents: 2000 }, { kind: "system", id: "rovara" }, [w.duplicate]],
      [{ kind: "budget", id: w.survivor }, { scopeKind: "member", field: "member_monthly_limit", fromCents: 2000, toCents: 3500 }, { kind: "system", id: "rovara" }, [w.survivor]],
    ]);
  });

  it("gives the same merge at another time other event ids, since the rewrite does not change the settings' updatedAt", async () => {
    const first = await mergeWorld({ duplicate: 35 });
    const later = await mergeWorld({ duplicate: 35 }, T0 + 60_000);
    const ids = (w: typeof first) => w.capture.recordedBy("budget.changed").map((event) => event.eventId);
    expect(ids(first)).toHaveLength(2);
    expect(ids(first).filter((id) => ids(later).includes(id))).toEqual([]);
  });

  it("records only the duplicate's change when the survivor already has a limit of their own, and nothing when the duplicate had none", async () => {
    const own = await mergeWorld({ duplicate: 35, survivor: 50 });
    expect(own.merged.overrideMoved).toBe(false);
    expect(own.capture.recordedBy("budget.changed").map((event) => event.target)).toEqual([{ kind: "budget", id: own.duplicate }]);
    const none = await mergeWorld({ survivor: 50 });
    expect(none.capture.recordedBy("budget.changed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Through the broker's routes
// ---------------------------------------------------------------------------------------------------------------------

describe("through the routes", () => {
  const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
  const DANA = person("1", "Dana"); // org admin
  const MAX = person("2", "Max"); // maintainer of web
  const CARL = person("3", "Carl"); // maintainer of web

  async function routeSetup(capture: AuditCapture = capturingAuditDeps()) {
    const members = new FakeProjectMembers();
    const h = await createDeveloperTaskBroker({ register: false, audit: capture, brokerExtra: { agents: { projectMembers: members } } });
    const transactions = recordTransactions(h.db);
    const enroll = async (who: Developer, role: "admin" | "member") => {
      h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
      h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      await h.orgOf(who);
      seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
    };
    await enroll(DANA, "admin");
    await enroll(MAX, "member");
    await enroll(CARL, "member");
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
    fixtureProject(h.db, TEST_ORG, "web");
    members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
    h.db.set({ ...projectMemberKey(TEST_ORG, MAX.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: MAX.developerId, projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
    members.grant(TEST_ORG, "web", CARL.developerId, "maintainer");
    h.db.set({ ...projectMemberKey(TEST_ORG, CARL.developerId, "web"), entityType: "MEMBERSHIP", ownerKey: CARL.developerId, projectName: "web", grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
    // What a page confirming a change hands to the registered handler: a store of its own on the broker's table, auditing into the same capture.
    const store = new AgentStore({ documentClient: h.db, tableName: AUDIT_CAPTURE_TABLE, now: Date.now, audit: capture.audit });
    const deps: ApprovalDependencies = {
      store, projectMembers: members, documentClient: h.db, tableName: AUDIT_CAPTURE_TABLE, now: Date.now, confirmOrigin: "https://cell.example.com",
      signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
    };
    const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as ApprovalRecord[];
    const call = (who: Developer, method: string, path: string, body?: Record<string, unknown>) =>
      h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const create = async (who: Developer) => {
      const created = await call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay: SAFE });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return (created.body.agent as { agentId: AgentId }).agentId;
    };
    return { h, capture, transactions, members, call, create, deps, approvals };
  }

  it("a safe publish records agent.published and nothing else", async () => {
    const s = await routeSetup();
    const agentId = await s.create(MAYA);
    const published = await s.call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 1 });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(s.capture.recorded().map((event) => [event.action, event.actor, event.facts])).toEqual([
      ["agent.published", { kind: "member", id: MAYA.developerId }, { version: 1, safety: "safe" }],
    ]);
  });

  it("a budget, an owner and a maintainer change on an agent are recorded with the caller as the actor", async () => {
    const s = await routeSetup();
    const agentId = await s.create(MAYA);
    expect((await s.call(MAYA, "PUT", `/v1/app/agents/${agentId}/budget`, { monthlyUsd: 30 })).status).toBe(200);
    const owner = await s.call(DANA, "PUT", `/v1/app/agents/${agentId}/owner`, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const accountable = await s.call(DANA, "PUT", `/v1/app/agents/${agentId}/accountable`, { accountable: { developerId: CARL.developerId } });
    expect(accountable.status, JSON.stringify(accountable.body)).toBe(200);
    expect(s.capture.recorded().map((event) => [event.action, event.actor.id, event.facts])).toEqual([
      ["budget.changed", MAYA.developerId, { scopeKind: "agent", field: "agent_monthly_limit", toCents: 3000 }],
      ["agent.owner_changed", DANA.developerId, { field: "owner" }],
      ["agent.owner_changed", DANA.developerId, { field: "accountable" }],
    ]);
  });

  it("PUT /v1/app/projects/web/ai records budget.changed for the project, and a repeat of the request records nothing more", async () => {
    const s = await routeSetup();
    const requestId = randomUUID();
    const body = { requestId, monthlyBudgetUsd: 150 };
    const saved = await s.h.dev(DANA, "PUT", "/v1/app/projects/web/ai", body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(s.capture.recorded()).toMatchObject([{
      action: "budget.changed", actor: { kind: "member", id: DANA.developerId }, target: { kind: "project", name: "web" },
      facts: { scopeKind: "project", field: "project_monthly_limit", toCents: 15000 },
    }]);
    expect((await s.h.dev(DANA, "PUT", "/v1/app/projects/web/ai", body)).status).toBe(200);
    expect(s.capture.recorded()).toHaveLength(1);
  });

  it("PUT /v1/app/projects/web/ai records the change of what a member may accept as a run limit, with a maintainer as the actor", async () => {
    const s = await routeSetup();
    const saved = await s.h.dev(MAX, "PUT", "/v1/app/projects/web/ai", { requestId: randomUUID(), memberAcceptRunLimitUpToUsd: 25 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(s.capture.recorded()).toMatchObject([{
      action: "budget.changed", actor: { kind: "member", id: MAX.developerId }, target: { kind: "project", name: "web" },
      facts: { scopeKind: "project", field: "project_member_accept_run_limit", toCents: 2500 },
    }]);
  });

  it("PUT /v1/app/org/spend-policy records spend_policy.changed; PUT /v1/app/org/agent-guardrails records guardrails.changed", async () => {
    const s = await routeSetup();
    const policy = await s.call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 250 });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const tighter = { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: DEFAULT_AGENT_GUARDRAILS.maxAgentMonthlyUsd - 1 };
    const guardrails = await s.call(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 0, guardrails: tighter });
    expect(guardrails.status, JSON.stringify(guardrails.body)).toBe(200);
    expect(s.capture.recorded().map((event) => [event.action, event.actor.id, event.facts])).toEqual([
      ["spend_policy.changed", DANA.developerId, { field: "ownerAgentBudgetCapUsd", from: defaultSpendPolicy().ownerAgentBudgetCapUsd * 100, to: 25000 }],
      ["guardrails.changed", DANA.developerId, { revision: 1, widened: false }],
    ]);
  });

  it("a less-safe publish that a person confirmed records agent.published as less safe, with the person who confirmed it as the actor", async () => {
    const s = await routeSetup();
    const agentId = await s.create(MAYA);
    expect((await s.call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 1 })).status).toBe(200);
    const draft = await s.call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: 1, overlay: { ...SAFE, allowMentions: true } });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const asked = await s.call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 2 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    // Asking changes nothing and records nothing.
    expect(s.capture.recordedBy("agent.published")).toHaveLength(1);

    const [record] = s.approvals();
    await getApprovalSubjectHandler("agent_publish")!(s.deps, { ...record!, decidedBy: DANA.developerId });
    expect(s.capture.recordedBy("agent.published").map((event) => [event.actor.id, event.facts])).toEqual([
      [MAYA.developerId, { version: 1, safety: "safe" }],
      [DANA.developerId, { version: 2, safety: "less_safe" }],
    ]);
  });

  it("a guardrails change that a person confirmed records guardrails.changed as widened; the tightening before it was not", async () => {
    const s = await routeSetup();
    const tighter = { ...DEFAULT_AGENT_GUARDRAILS, maxAgentMonthlyUsd: DEFAULT_AGENT_GUARDRAILS.maxAgentMonthlyUsd - 10 };
    expect((await s.call(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 0, guardrails: tighter })).status).toBe(200);
    const asked = await s.call(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: 1, guardrails: DEFAULT_AGENT_GUARDRAILS });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(s.capture.recordedBy("guardrails.changed")).toHaveLength(1);

    const [record] = s.approvals();
    seedMembership(s.deps.documentClient as FakeDynamoDb, CARL.developerId, { orgId: TEST_ORG, role: "admin" });
    await getApprovalSubjectHandler("guardrails")!(s.deps, { ...record!, decidedBy: CARL.developerId });
    expect(s.capture.recordedBy("guardrails.changed").map((event) => [event.actor.id, event.facts])).toEqual([
      [DANA.developerId, { revision: 1, widened: false }],
      [CARL.developerId, { revision: 2, widened: true }],
    ]);
  });

  it("with an intake queue that never answers, the same calls return as they do today and the events wait for the drain", async () => {
    const hanging = hangingAuditDeps();
    const s = await routeSetup(hanging);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agentId = await settle(s.create(MAYA));
    const published = await settle(s.call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: 1 }));
    expect(published.status).toBe(200);
    const policy = await settle(s.call(DANA, "PUT", "/v1/app/org/spend-policy", { ownerAgentBudgetCapUsd: 250 }));
    expect(policy.status).toBe(200);
    // Pending items are in time order, and two calls inside one millisecond tie: the order is not what this test is about.
    expect(hanging.pending().map((event) => event.action).sort()).toEqual(["agent.published", "spend_policy.changed"]);
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------------------------------------------------

describe("the proof a decision's event carries", () => {
  it("is the caller's decide proof, and {kind: none} when the caller has none", () => {
    const proof = { kind: "fresh_sign_in", method: "email_code", authTime: "2026-10-22T09:00:00.000Z", sessionRef: "a".repeat(64) } as const;
    expect(decisionProofOf({ decideProof: proof })).toEqual(proof);
    expect(decisionProofOf({})).toEqual({ kind: "none" });
  });
});

describe("the figures an event compares with", () => {
  it("are not taken from a read at another revision than the write is conditioned on", async () => {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const deps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => T0, audit: capture.audit };
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), leadApprovalThresholdUsd: 20 }, fixtureActor(deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 0 }), actor: fixtureActor(deps, TEST_ORG, ALICE) });
    // The first read of the policy (the hook's, when the caller passes no `before`) sees a newer revision than the one the write is conditioned on.
    const key = orgSettingsKey(TEST_ORG, "SPEND_POLICY");
    const original = db.send.bind(db) as (command: unknown) => Promise<unknown>;
    let stale = true;
    (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const reply = await original(command) as { Item?: Record<string, unknown> };
      if (stale && (command as { constructor: { name: string } }).constructor.name === "GetCommand" && (command as { input: { Key: { pk: string } } }).input.Key.pk === key.pk) {
        stale = false;
        return { Item: { ...reply.Item, revision: 2, leadApprovalThresholdUsd: 50 } };
      }
      return reply;
    };
    await writeSpendPolicy(deps, TEST_ORG, { ...defaultSpendPolicy(), leadApprovalThresholdUsd: 30 }, fixtureActor(deps, TEST_ORG, ALICE).developerId, { ...({ expectedRevision: 1 }), actor: fixtureActor(deps, TEST_ORG, ALICE) });
    expect(capture.recordedBy("spend_policy.changed").map((event) => event.facts)).toEqual([{ field: "leadApprovalThresholdUsd", from: defaultSpendPolicy().leadApprovalThresholdUsd * 100, to: 2000 }]);
  });
});

describe("a member's limit rewritten twice", () => {
  it("records both rewrites: each is its own occurrence even when the settings' updatedAt did not change", async () => {
    const capture = capturingAuditDeps();
    const db = new FakeDynamoDb();
    capture.attach(db);
    const clock = { now: T0 };
    const orgs = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: capture.audit });
    const owner = "o".repeat(64);
    const orgId = await orgs.createOrgWithOwner({ name: "Acme", developerId: owner });
    const seed = () => db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_BUDGET", updatedBy: owner, updatedAt: "2026-10-01T00:00:00.000Z", memberDefaultMonthlyUsd: 20, memberOverrides: { [ALICE]: 40 } });
    for (let round = 0; round < 2; round += 1) {
      await orgs.addMember({ orgId, developerId: ALICE, role: "member" });
      seed();
      clock.now += 60_000;
      await orgs.removeMember({ orgId, developerId: ALICE, emails: [], ban: false, by: { kind: "member", id: owner } });
    }
    const events = capture.recordedBy("budget.changed");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });
});
