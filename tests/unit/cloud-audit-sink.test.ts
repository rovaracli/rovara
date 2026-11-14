// Convergence A7 (`cloud/audit-sink`): Cloud's AuditSink on Code's port. What must hold:
//  1. every audit event the pinned core records maps to a Cloud ledger event (and a new one fails this test);
//  2. the audit row is staged in the SAME transaction as the core write: both land or neither;
//  3. the row never pushes a transaction past the document store's limits (100 steps, 4 MiB);
//  4. facts carry no secret or email, and names appear only where Cloud's rules put them (a name-keyed target, the org's sealed details);
//  5. the row is Cloud's own outbox row (same key, shape and 14-day expiry), so Cloud's drain, appender and erasure rules apply unchanged.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS, AUDIT_DETAIL_FIELDS_MAX, AUDIT_DETAIL_FIELD_MAX_CHARS, AUDIT_DETAIL_PARTS_MAX, AUDIT_FACT_KEYS, AUDIT_FACT_MAX_CHARS, AUDIT_MAX_FACTS, AUDIT_MAX_RELATED, AUDIT_PENDING_TTL_DAYS, AuditEventInputSchema,
  auditEventId, type AuditEventInput,
} from "@agentx/cloud-contracts";
import { DOCUMENT_STORE_LIMITS, INDEX_EXPIRY_ATTRIBUTE, assertValidTransaction, when, type AuditEvent, type StoredDocument, type TransactItem } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { drainAuditPending } from "../../packages/broker/src/audit/drain.js";
import { AUDIT_DETAIL_STORES } from "../../packages/broker/src/audit/erase.js";
import { auditPending, auditPendingItem, type AuditDeps } from "../../packages/broker/src/audit/outbox.js";
import {
  AUDIT_SINK_GAPS, CORE_AUDIT_EVENT_MAP, CloudAuditSinkError, LAPTOP_ONLY_CORE_EVENTS, auditRoomProblem, cloudActionOf, createCloudAuditSink, toCloudAuditEvent, unmappedCoreActions, type EventMapping,
} from "../../packages/broker/src/cloud/adapters/audit-sink/index.js";
import { NOT_AUDIT_ACTIONS, lessonLibraryAuditActions, lessonLibraryEvents, scanCoreAuditActions } from "../support/core-audit-actions.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const AT = "2026-11-11T09:59:00.000Z";
const person = { type: "person", id: "dev_1" } as const;

// ---- 1. every core event maps -------------------------------------------------------------------------------------------------------------------------------------------------------

/** Every action the pinned core can record: the scan of its source, plus the actions its lessons library records (it names its own ledger events). */
async function coreActions(): Promise<{ all: string[]; scan: Awaited<ReturnType<typeof scanCoreAuditActions>> }> {
  const scan = scanCoreAuditActions();
  const lessons = await lessonLibraryAuditActions();
  return { all: [...scan.actions, ...lessons.recorded].sort(), scan };
}

describe("every audit event of Rovara Code's core maps to a Cloud ledger event", () => {
  it("finds the core's events, and the scan is not blind (it sees the known ones, and no template it cannot read)", async () => {
    const { all, scan } = await coreActions();
    // Every non-literal `action:` (an identifier, a shorthand, a call, a template it cannot read) of an audit-shaped object is either resolved by an allowlisted builder or reported here.
    expect(scan.unresolved).toEqual([]);
    expect(Object.entries(scan.resolverHits).filter(([, hits]) => hits === 0).map(([name]) => name), "an allowlisted resolver nothing uses any more").toEqual([]);
    // The three builders the review named are read as builders, not skipped: script tokens, second review and sessions.
    for (const name of ["core/script-tokens/store.ts input.action", "core/second-review/mode.ts event.action", "core/sessions/control.ts audit.action"]) expect(scan.resolverHits[name], name).toBeGreaterThan(0);
    // Positive controls from every shape the scan reads: a plain literal, a conditional, a template of literals, the MCP and saved-env templates, and the lessons library.
    for (const known of ["task.started", "agent.archived", "agent.unarchived", "decision.approved", "decision.changes_requested", "mcp_server.task_started", "mcp_server.changed_needs_review", "saved_env.build_recorded", "saved_env.setting_changed", "lesson.approved", "script_token.used", "test_services.image_approved", "test_services.image_removed", "lesson.local_tools_switched", "lesson.repo_file_retire_decided"]) {
      expect(all, known).toContain(known);
    }
    expect(all.length).toBeGreaterThan(80);
  });

  it("MUTATION PROOF: a new audit event whose action is an identifier, a shorthand, a call, a constant or a template is reported, not skipped", () => {
    const sources = {
      "core/x/new.ts": [
        `export const a = (deps, action) => deps.audit.stage({ eventId: "e1", actor, action: action, subject, details });`,
        `export const b = (deps, action) => deps.audit.record({ eventId: "e2", actor, action, subject });`,
        `export const c = (deps) => deps.audit.stage({ eventId: "e3", actor, action: pick(deps), subject });`,
        `export const d = (deps) => deps.audit.stage({ eventId: "e4", actor, action: ACTION_NAME, subject });`,
        `export const e = (deps, kind) => deps.audit.stage({ eventId: "e5", actor, action: \`thing.\${kind}\`, subject });`,
        `export const f = (deps) => deps.audit.stage({ eventId: "e6", actor, action: "thing.literal_one", subject });`,
        `export const g = (deps) => deps.store.admit({ idempotencyKey: "k", action: pickAnything(deps) });`,
      ].join("\n"),
    };
    const scan = scanCoreAuditActions(sources);
    expect(scan.unresolved.map((line) => line.split(":")[0])).toEqual(["core/x/new.ts", "core/x/new.ts", "core/x/new.ts", "core/x/new.ts", "core/x/new.ts"]);
    expect(scan.actions.has("thing.literal_one")).toBe(true);
    // The same files, in a file the text 'audit' appears in or not, are read alike: the review's old filter skipped a file with no 'audit' in it.
    expect(scanCoreAuditActions({ "core/y/quiet.ts": `export const z = (s) => s.stage({ eventId: "q", actor, action: someFunction(), subject });` }).unresolved).toHaveLength(1);
  });

  it("has a Cloud event for each, and every Cloud event is one the ledger knows", async () => {
    const { all } = await coreActions();
    expect(unmappedCoreActions(all)).toEqual([]);
    // Every core event is either a Cloud ledger event or listed as laptop-only (which has none, on purpose).
    for (const action of all.filter((name) => !Object.hasOwn(LAPTOP_ONLY_CORE_EVENTS, name))) expect(AUDIT_ACTIONS as readonly string[], action).toContain(cloudActionOf(action));
  });

  it("holds no entry for an event the core no longer records (a stale row would hide a rename)", async () => {
    const { all } = await coreActions();
    expect(Object.keys(CORE_AUDIT_EVENT_MAP).filter((action) => !all.includes(action)).sort()).toEqual([]);
  });

  it("lists as 'not audit' only admission requests, each still present in the core", async () => {
    const { scan } = await coreActions();
    expect([...scan.excludedFound].sort()).toEqual(Object.keys(NOT_AUDIT_ACTIONS).sort());
  });

  it("covers every lessons action: each is recorded under a ledger name or is bookkeeping the library skips on purpose", async () => {
    const lessons = await lessonLibraryAuditActions();
    const { BOOKKEEPING } = (await import("../../vendor/rovara-code/packages/broker/dist/lessons/audit-sink.js")) as { BOOKKEEPING: readonly string[] };
    const { LEDGERED } = (await import("../../vendor/rovara-code/packages/broker/dist/lessons/audit-sink.js")) as { LEDGERED: readonly string[] };
    expect(lessons.named.filter((action) => !LEDGERED.includes(action) && !BOOKKEEPING.includes(action))).toEqual([]);
    expect(unmappedCoreActions(lessons.recorded)).toEqual([]);
  });

  it("MUTATION PROOF: dropping any one mapping makes the check fail, and it names the dropped action", async () => {
    const { all } = await coreActions();
    expect(all.length).toBeGreaterThan(80);
    for (const dropped of all.filter((name) => !Object.hasOwn(LAPTOP_ONLY_CORE_EVENTS, name))) {
      const { [dropped]: _gone, ...rest } = CORE_AUDIT_EVENT_MAP;
      void _gone;
      expect(unmappedCoreActions(all, rest), dropped).toEqual([dropped]);
    }
  });

  it("MUTATION PROOF: a new core event nobody mapped is refused by the sink, not recorded under a guessed name", () => {
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    const unknown: AuditEvent = { eventId: "evt-new", companyId: ORG, at: AT, actor: person, action: "brand_new.thing_happened", subject: { type: "task", id: "t1" } };
    expect(() => sink.stage(unknown)).toThrow(CloudAuditSinkError);
    expect(() => sink.stage(unknown)).toThrow(/unmapped_action/u);
    const skipping = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW, onInvalid: "skip", log: () => undefined });
    expect(skipping.stage(unknown)).toEqual([]);
  });
});

// ---- samples: one rich core event per mapped action ---------------------------------------------------------------------------------------------------------------------------------

const SUBJECT_TYPES: Readonly<Record<string, string>> = {
  agent: "agent", chain: "chain", connection: "connection", diagnosis: "diagnosis", lesson: "lesson", mcp_server: "mcp-server", session: "session", script_token: "script_token", task: "task", trigger: "trigger", project: "project",
};

/** A secret-shaped value built at run time (never a literal in the file). */
const SECRET = ["sk", "live", "0123456789abcdef0123456789abcdef"].join("_");
const EMAIL = ["pat", "example.com"].join("@");
const PROJECT_NAME = "Secret Payments Project";
const LESSON_PROJECT = "payments-web";
const REPOSITORY = "acme/secret-repo";

/** A core event for `action`: the subject its mapping needs, and details that hold what the core really sends plus things it must never leak (an email, a token, an unknown key). */
function sampleOf(action: string, mapping: EventMapping): AuditEvent {
  const target = mapping.target;
  const needsCompany = typeof target === "object" && target !== null && ("org" in target || "bySubject" in target);
  const type = needsCompany ? ("bySubject" in target ? "company" : "company") : "name" in target ? "project" : "id" in target ? (SUBJECT_TYPES[target.id] ?? target.id) : "task";
  const subject = { type, id: needsCompany ? ORG : type === "project" ? PROJECT_NAME : `${type}-1` };
  return {
    eventId: action.startsWith("decision.") ? "approval:req-1" : `evt-${action}`,
    companyId: ORG, at: AT, actor: person, action, subject,
    details: {
      project: PROJECT_NAME, repository: REPOSITORY, number: 7, label: "My server", sourceId: "src-1", changeId: "chg-1", requestId: "req-1",
      leakedEmail: EMAIL, leakedToken: SECRET, note: `contact ${EMAIL}`, token: SECRET,
      mode: "window", seconds: 600, previous: { mode: "window", seconds: 300 },
      pin: { integrity: "sha512-x", lockfileHash: "a".repeat(64), bundleHash: "b".repeat(64), toolsHash: "c".repeat(64), destinationCount: 1, secretCount: 1, secretVersion: "v1", destinations: "api.example.com:443", secretNames: "TOKEN_A" },
      revision: 3, policyDigest: "d".repeat(64), previousDigest: "e".repeat(64),
      reference: `docker.io/library/postgres@sha256:${"a".repeat(64)}`, requested: "postgres:16", verdict: "keep", missing: 2, enabled: true, scope: "project",
      hasToken: true, addresses: "api.example.com", name: "pkg", reason: "done",
    },
  };
}

describe("a core event becomes a valid Cloud ledger event", () => {
  const entries = Object.entries(CORE_AUDIT_EVENT_MAP);

  it("for every mapped action: valid, mapped to its Cloud action, with a stable id", () => {
    for (const [action, mapping] of entries) {
      const made = toCloudAuditEvent(sampleOf(action, mapping));
      expect(made.ok, `${action}: ${made.ok ? "" : made.refusal}`).toBe(true);
      if (!made.ok) continue;
      expect(AuditEventInputSchema.safeParse(made.event).success, action).toBe(true);
      expect(made.event.action, action).toBe(mapping.cloud);
      // The same core event gives the same ledger id; a different core event id, a different one.
      expect(toCloudAuditEvent(sampleOf(action, mapping))).toEqual(made);
      const other = toCloudAuditEvent({ ...sampleOf(action, mapping), eventId: "another-occurrence" });
      if (!action.startsWith("decision.")) expect(other.ok && other.event.eventId).not.toBe(made.event.eventId);
    }
  });

  it("maps a person actor to a member, the system to the system, and an agent to the system with the agent as a related record", () => {
    const base = sampleOf("task.closed", CORE_AUDIT_EVENT_MAP["task.closed"]!);
    const made = (actor: AuditEvent["actor"]) => { const result = toCloudAuditEvent({ ...base, actor }); if (!result.ok) throw new Error(result.refusal); return result.event; };
    expect(made(person).actor).toEqual({ kind: "member", id: "dev_1" });
    expect(made({ type: "system", id: "anything-here" }).actor).toEqual({ kind: "system", id: "rovara" });
    const agent = made({ type: "agent", id: "agent-7" });
    expect(agent.actor).toEqual({ kind: "system", id: "rovara" });
    expect(agent.related).toContain("agent-7");
    expect(toCloudAuditEvent({ ...base, actor: { type: "person", id: "x".repeat(101) } })).toEqual({ ok: false, refusal: "bad_actor" });
  });

  it("refuses what the ledger would refuse: a company id that is not one, a time that is not a time, no subject for a name-keyed target", () => {
    const base = sampleOf("task.closed", CORE_AUDIT_EVENT_MAP["task.closed"]!);
    expect(toCloudAuditEvent({ ...base, companyId: "not-an-org" })).toEqual({ ok: false, refusal: "invalid_event" });
    expect(toCloudAuditEvent({ ...base, at: "yesterday" })).toEqual({ ok: false, refusal: "bad_time" });
    const { subject: _s, ...noSubject } = base;
    void _s;
    expect(toCloudAuditEvent(noSubject)).toEqual({ ok: false, refusal: "bad_target" });
  });

  it("names the pull request by the ledger's opaque id and keeps the repository out of every fact and the target", () => {
    const event = sampleOf("pull_request.opened", CORE_AUDIT_EVENT_MAP["pull_request.opened"]!);
    const made = toCloudAuditEvent({ ...event, details: { repository: REPOSITORY, number: "7" } });
    if (!made.ok) throw new Error(made.refusal);
    expect(made.event.target).toMatchObject({ kind: "pull_request", id: expect.stringMatching(/^pr_[0-9a-f]{32}$/u) as string });
    expect(made.event.facts).toEqual({ number: 7 });
    expect(made.event.details).toEqual([{ subject: "org", fields: { repository: REPOSITORY } }]);
    expect(JSON.stringify([made.event.facts, made.event.target, made.event.related])).not.toContain("secret-repo");
  });
});

// ---- 2. the same transaction --------------------------------------------------------------------------------------------------------------------------------------------------------

const changeDoc = (n = 1): StoredDocument => ({ pk: "TASK#t1", sk: "STATE", entityType: "TASK", status: "CLOSED", n });
const closedEvent = (): AuditEvent => ({ eventId: "task.closed:t1", companyId: ORG, at: AT, actor: person, action: "task.closed", subject: { type: "task", id: "t1" }, details: { project: PROJECT_NAME } });

describe("the audit row commits with the change, or neither does", () => {
  const pendingRows = async (store: MemoryDocumentStore): Promise<StoredDocument[]> => {
    const rows: StoredDocument[] = [];
    for (let shard = 0; shard < 10; shard += 1) rows.push(...(await store.query({ pk: `AUDIT_PENDING#${String(shard)}` })).items);
    return rows;
  };

  it("stages exactly one put: Cloud's pending row, in the shard its event id names", () => {
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    const steps = sink.stage(closedEvent());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "put" });
    expect(sink.stage(closedEvent())).toEqual(steps);
    assertValidTransaction([{ kind: "put", item: changeDoc() }, ...steps]);
  });

  it("both land: the change and the pending row are in the store after one transact", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    const result = await store.transact([{ kind: "put", item: changeDoc(), condition: when.absent() }, ...sink.stage(closedEvent())]);
    expect(result).toEqual({ applied: true });
    expect(await store.get({ pk: "TASK#t1", sk: "STATE" })).toMatchObject({ status: "CLOSED" });
    const rows = await pendingRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: { action: "task.closed", orgId: ORG } });
  });

  it("neither lands when the change's condition fails (the audit row is not left behind)", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    await store.put({ item: changeDoc(1) });
    const result = await store.transact([{ kind: "put", item: changeDoc(2), condition: when.absent() }, ...sink.stage(closedEvent())]);
    expect(result.applied).toBe(false);
    expect(await store.get({ pk: "TASK#t1", sk: "STATE" })).toMatchObject({ n: 1 });
    expect(await pendingRows(store)).toEqual([]);
  });

  it("neither lands when the audit row's own step fails (a bad event never leaves the change half-recorded)", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    // A row that is already there under the same key but is checked absent: the transaction is refused whole.
    const [step] = sink.stage(closedEvent());
    await store.put({ item: (step as { item: StoredDocument }).item });
    const result = await store.transact([{ kind: "put", item: changeDoc(), condition: when.absent() }, { ...(step as object), condition: when.absent() } as TransactItem]);
    expect(result.applied).toBe(false);
    expect(await store.get({ pk: "TASK#t1", sk: "STATE" })).toBeUndefined();
  });

  it("an event the ledger cannot take stops the change before it is attempted (the default), instead of recording nothing", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    const build = (): readonly TransactItem[] => [{ kind: "put", item: changeDoc() }, ...sink.stage({ ...closedEvent(), action: "nobody.mapped_this" })];
    expect(build).toThrow(CloudAuditSinkError);
    expect(await store.get({ pk: "TASK#t1", sk: "STATE" })).toBeUndefined();
  });

  it("a repeat of one occurrence writes an identical row (one pending item), as Cloud's own staging does", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    await store.transact([{ kind: "put", item: changeDoc(1) }, ...sink.stage(closedEvent())]);
    await store.transact([{ kind: "put", item: changeDoc(2) }, ...sink.stage(closedEvent())]);
    expect(await pendingRows(store)).toHaveLength(1);
  });

  it("record() writes the same row for a caller with no transaction", async () => {
    const store = new MemoryDocumentStore();
    const sink = createCloudAuditSink({ store: () => store, now: () => NOW });
    await sink.record(closedEvent());
    await sink.record(closedEvent());
    const rows = await pendingRows(store);
    expect(rows).toHaveLength(1);
    const [step] = sink.stage(closedEvent());
    expect(rows[0]).toEqual((step as { item: StoredDocument }).item);
  });
});

// ---- 3. the size limits -----------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The largest core transaction that stages an audit event, measured in the pinned core's own tests (lane A7: a hook on `MemoryDocumentStore.transact` over 196 test files covering task start, close, merge,
 * sessions, decisions, automation, saved environments, second review, playbook, diagnosis, lessons and the workflow end-to-end suites; 105 growth points logged): a TASK START, 20 steps and 9,824 bytes
 * (core/task-flow/start.ts: charge, admission, audit, workspace, prepare items, task, index, pointer, conversation, idempotency, dispatch row, pins). It includes the test sink's own one-put audit step, so
 * Cloud's one-put sink changes the step count by nothing. Every other transaction measured is smaller (the next is 9 steps). The only 100-step transaction seen is the lessons store's contract test, which
 * fills the store's own limit on purpose; a lessons commit holds at most 30 lessons (MAX_COMMIT_WRITES) and the pinned core stages no audit event into it (`emit` records after the commit).
 * The core stages at most TWO audit events in one transaction (the playbook store: the file change and the design review setting).
 */
const MEASURED_LARGEST_CORE_TRANSACTION = { steps: 20, bytes: 9_824, auditEventsStaged: 2 } as const;

/** The biggest event the ledger's schema allows, as a pending row: every field at its limit. */
function largestEvent(): AuditEventInput {
  const facts: Record<string, string> = {};
  for (let index = 0; index < AUDIT_MAX_FACTS; index += 1) facts[`f${String(index)}`] = "x".repeat(AUDIT_FACT_MAX_CHARS);
  const fields: Record<string, string> = {};
  for (let index = 0; index < AUDIT_DETAIL_FIELDS_MAX; index += 1) fields[`d${String(index)}`] = "y".repeat(AUDIT_DETAIL_FIELD_MAX_CHARS);
  return {
    eventId: auditEventId("task.closed", "o"), orgId: ORG, action: "task.closed", actor: { kind: "member", id: "m".repeat(100) }, target: { kind: "project", name: "n".repeat(200) },
    occurredAt: AT, related: Array.from({ length: AUDIT_MAX_RELATED }, () => "r".repeat(100)),
    details: Array.from({ length: AUDIT_DETAIL_PARTS_MAX }, (_, part) => ({ subject: `s${String(part)}`.padEnd(100, "s"), fields })),
  };
}

describe("the audit row never pushes a transaction past the document store's limits", () => {
  const bytesOf = (items: readonly TransactItem[]): number => items.reduce((sum, item) => sum + (item.kind === "put" ? Buffer.byteLength(JSON.stringify(item.item)) : 0), 0);

  it("adds one step for an event, and the core stages at most two events in a transaction", () => {
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    expect(sink.stage(closedEvent())).toHaveLength(1);
    expect(MEASURED_LARGEST_CORE_TRANSACTION.auditEventsStaged).toBe(2);
  });

  it("the largest row the schema allows is a small fraction of a transaction (and of a document)", () => {
    const row = JSON.parse(JSON.stringify(auditPendingItem(largestEvent(), NOW))) as StoredDocument;
    const bytes = Buffer.byteLength(JSON.stringify(row));
    expect(bytes).toBeLessThan(30_000);
    expect(bytes).toBeLessThan(DOCUMENT_STORE_LIMITS.maxDocumentBytes);
    // The event is valid: this really is the biggest the ledger takes.
    expect(AuditEventInputSchema.safeParse(largestEvent()).success).toBe(true);
  });

  it("the largest core transaction measured, with the worst audit rows added, stays far inside 100 steps and 4 MiB", () => {
    const worstRow = Buffer.byteLength(JSON.stringify(auditPendingItem(largestEvent(), NOW)));
    expect(MEASURED_LARGEST_CORE_TRANSACTION.steps + MEASURED_LARGEST_CORE_TRANSACTION.auditEventsStaged).toBeLessThanOrEqual(DOCUMENT_STORE_LIMITS.maxTransactItems);
    expect(MEASURED_LARGEST_CORE_TRANSACTION.bytes + MEASURED_LARGEST_CORE_TRANSACTION.auditEventsStaged * worstRow).toBeLessThan(DOCUMENT_STORE_LIMITS.maxTransactBytes);
  });

  it("a transaction at the edge: 99 steps plus one row is allowed, 100 plus one is not, and a transaction near 4 MiB is caught before the store refuses it", () => {
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    const staged = sink.stage(closedEvent());
    const filler = (count: number, bytes = 10): TransactItem[] => Array.from({ length: count }, (_, index) => ({ kind: "put", item: { pk: `F#${String(index)}`, sk: "S", pad: "z".repeat(bytes) } }));
    expect(auditRoomProblem(filler(99), staged)).toBeUndefined();
    assertValidTransaction([...filler(99), ...staged]);
    expect(auditRoomProblem(filler(100), staged)).toBe("steps");
    expect(() => assertValidTransaction([...filler(100), ...staged])).toThrow();
    const nearLimit = filler(10, Math.floor((DOCUMENT_STORE_LIMITS.maxTransactBytes - 100) / 10));
    expect(auditRoomProblem(nearLimit, staged)).toBe("bytes");
    expect(bytesOf(nearLimit) + bytesOf(staged)).toBeGreaterThan(DOCUMENT_STORE_LIMITS.maxTransactBytes);
    expect(() => assertValidTransaction([...nearLimit, ...staged])).toThrow();
    // Two steps on one key are refused too: a core step must not collide with the pending row's key.
    expect(auditRoomProblem([...staged], staged)).toBe("same_key");
  });
});

// ---- 4. no secrets, no emails -------------------------------------------------------------------------------------------------------------------------------------------------------

describe("facts carry no secret or email, and names go only where Cloud's rules put them", () => {
  const emailShaped = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

  it("for every mapped action: facts hold only the action's allowed keys with safe values; an unknown detail, an email and a token never reach the event", () => {
    for (const [action, mapping] of Object.entries(CORE_AUDIT_EVENT_MAP)) {
      const made = toCloudAuditEvent(sampleOf(action, mapping));
      if (!made.ok) throw new Error(`${action}: ${made.refusal}`);
      const allowed = AUDIT_FACT_KEYS[mapping.cloud];
      for (const [key, value] of Object.entries(made.event.facts ?? {})) {
        expect(allowed, `${action}.${key}`).toContain(key);
        if (typeof value === "string") {
          expect(emailShaped.test(value), `${action}.${key}`).toBe(false);
          expect(value, `${action}.${key}`).not.toContain(SECRET);
          expect(value.length).toBeLessThanOrEqual(AUDIT_FACT_MAX_CHARS);
        }
      }
      const serialised = JSON.stringify(made.event);
      expect(serialised, action).not.toContain(SECRET);
      expect(serialised, action).not.toContain(EMAIL);
      // A name is in the name-keyed target or the org's details: never in a fact, a related id or the event id.
      for (const where of [made.event.facts, made.event.related, made.event.eventId]) {
        expect(JSON.stringify(where ?? null), action).not.toContain(PROJECT_NAME);
        expect(JSON.stringify(where ?? null), action).not.toContain(REPOSITORY);
      }
      // The only details the event has are the org's, and only the fields the mapping names.
      for (const part of made.event.details ?? []) {
        expect(part.subject, action).toBe("org");
        expect(Object.keys(part.fields).every((name) => Object.hasOwn(mapping.org ?? {}, name)), action).toBe(true);
      }
    }
  });

  it("a fact value that is an email, a long text, a non-integer or non-ASCII is left out; the rest of the event still goes in", () => {
    const mapping = CORE_AUDIT_EVENT_MAP["task.started"]!;
    const base = sampleOf("task.started", mapping);
    const bad = (details: NonNullable<AuditEvent["details"]>) => { const made = toCloudAuditEvent({ ...base, details }); if (!made.ok) throw new Error(made.refusal); return made.event; };
    expect(bad({ project: PROJECT_NAME, workflow: true, path: EMAIL }).facts).toEqual({ workflow: true });
    expect(bad({ project: PROJECT_NAME, workflow: true, path: "p".repeat(AUDIT_FACT_MAX_CHARS + 1) }).facts).toEqual({ workflow: true });
    expect(bad({ project: PROJECT_NAME, workflow: true, path: "café" }).facts).toEqual({ workflow: true });
    expect(bad({ project: PROJECT_NAME, workflow: 1.5, path: "QUICK" }).facts).toEqual({ path: "QUICK" });
    // A value outside the fixed words of the key is left out too (no implicit pull: a word that merely looks tidy is not enough).
    expect(bad({ project: PROJECT_NAME, workflow: true, path: "pat-smith" }).facts).toEqual({ workflow: true });
  });

  it("the core's decision event reports the same facts Cloud's approval.decided carries, from the core's own words", () => {
    const made = toCloudAuditEvent({ ...sampleOf("decision.rejected", CORE_AUDIT_EVENT_MAP["decision.rejected"]!), subject: { type: "plan", id: "t1" }, details: { kind: "plan", risk: "high", revision: 3, method: "local-session", proofToken: SECRET } });
    if (!made.ok) throw new Error(made.refusal);
    expect(made.event).toMatchObject({ action: "approval.decided", target: { kind: "approval", id: "req-1" }, facts: { decision: "rejected", subjectKind: "plan", kind: "plan" } });
    expect(JSON.stringify(made.event)).not.toContain(SECRET);
  });
});

// ---- 4b. no implicit facts ----------------------------------------------------------------------------------------------------------------------------------------------------------

/** A free-text value a person could type into a branch, a title or a label: spaces, a slash, an `@`, capitals, non-ASCII. */
// Printable ASCII on purpose, and no email shape: the ledger's own last-line guard (ASCII, 128 characters, no email) would drop a marker that breaks them and hide a missing check in the map.
const MARKER = "Pat Smith fix-login/for jane";
const MARKER_WORDS = ["Pat Smith", "fix-login", "jane"];

/** Details with the marker under EVERY key a Cloud action may carry as a fact (and under the nested names the core uses), and under the names of the mapped sources. */
function markedDetails(mapping: EventMapping): NonNullable<AuditEvent["details"]> {
  const keys = [...AUDIT_FACT_KEYS[mapping.cloud], ...Object.keys(mapping.facts ?? {}), ...(mapping.alternate === undefined ? [] : [...AUDIT_FACT_KEYS[mapping.alternate.mapping.cloud], ...Object.keys(mapping.alternate.mapping.facts ?? {})]), "branch", "target", "source", "type", "scope", "model", "operator", "cause", "kind", "mode", "name", "reason", "label", "project", "repository", "title", "message", "reference", "requested"];
  const flat = Object.fromEntries(keys.map((key) => [key, MARKER]));
  return { ...flat, previous: { ...flat }, pin: { ...flat } };
}

describe("a core detail never reaches a fact under an allowed key's name (no implicit facts)", () => {
  it("for every mapped action: a free-text marker under every allowed fact key, and under the keys the mapping reads, is in no fact, related id, event id or id target", () => {
    for (const [action, mapping] of Object.entries(CORE_AUDIT_EVENT_MAP)) {
      const base = sampleOf(action, mapping);
      const made = toCloudAuditEvent({ ...base, details: markedDetails(mapping) });
      // A mapping with a required fact, or a target built from details, refuses the event when the marker fails its check: that is the fail-closed outcome.
      if (!made.ok) { expect(["invalid_event", "bad_target"], action).toContain(made.refusal); continue; }
      const visible = JSON.stringify([made.event.facts ?? {}, made.event.related ?? [], made.event.eventId, "id" in made.event.target ? made.event.target.id : null]);
      for (const word of MARKER_WORDS) expect(visible, `${action}: ${word}`).not.toContain(word);
    }
  });

  it("the alternate mapping of the sign-in setting also keeps free text out of its facts", () => {
    const base = sampleOf("setting.approval_sign_in_changed", CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!);
    const made = toCloudAuditEvent({ ...base, details: { ...markedDetails(CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!), mode: "any-active", revision: 2, seconds: MARKER, previous: { mode: "window", seconds: MARKER, note: MARKER } } });
    if (!made.ok) throw new Error(made.refusal);
    expect(made.event).toMatchObject({ action: "company.approval_sign_in_changed", facts: { mode: "any-active", fromMode: "window", revision: 2 } });
    expect(JSON.stringify(made.event.facts)).not.toContain("Pat Smith");
  });

  it("MUTATION M3: session.retried keeps no 'branch' from a core detail (the core sends none; a free-text branch name would otherwise land in the fact)", () => {
    const made = toCloudAuditEvent({ ...sampleOf("session.retried", CORE_AUDIT_EVENT_MAP["session.retried"]!), details: { branch: "pat-smith/fix-login-for-jane", sessionKind: "task", label: "pat-smith/fix-login-for-jane" } });
    if (!made.ok) throw new Error(made.refusal);
    expect(made.event.facts).toBeUndefined();
    expect(JSON.stringify(made.event)).not.toContain("pat-smith");
  });

  it("a mapping names only keys its Cloud action allows, and checks every fact it names", () => {
    for (const [action, mapping] of Object.entries(CORE_AUDIT_EVENT_MAP)) {
      for (const variant of [mapping, ...(mapping.alternate === undefined ? [] : [mapping.alternate.mapping])]) {
        for (const key of Object.keys(variant.facts ?? {})) expect(AUDIT_FACT_KEYS[variant.cloud], `${action}.${key}`).toContain(key);
        for (const key of variant.required ?? []) expect(Object.keys(variant.facts ?? {}), `${action} requires ${key}`).toContain(key);
      }
    }
  });

  it("a refused or skipped event logs a fixed reason and the core's action name, never a value, and in skip mode adds no step", () => {
    const logs: Array<Record<string, unknown>> = [];
    const skipping = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW, onInvalid: "skip", log: (entry) => logs.push(entry) });
    const secretEvent: AuditEvent = { eventId: `evt-${SECRET}`, companyId: ORG, at: AT, actor: person, action: "nobody.mapped_this", subject: { type: "task", id: SECRET }, details: { note: SECRET, email: EMAIL } };
    expect(skipping.stage(secretEvent)).toEqual([]);
    expect(logs).toEqual([{ event: "audit.record_invalid", level: "error", reason: "unmapped_action", coreAction: "nobody.mapped_this" }]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    const required = { ...sampleOf("model.policy.changed", CORE_AUDIT_EVENT_MAP["model.policy.changed"]!), details: { revision: 1 } };
    expect(skipping.stage(required)).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ reason: "invalid_event" });
  });

  it("a value inside a key's own check is kept (the checks let real values through)", () => {
    const retried = toCloudAuditEvent({ ...sampleOf("automatic_run.started", CORE_AUDIT_EVENT_MAP["automatic_run.started"]!), details: { job: "nightly", setupApprovedBy: "dev_9", runsThisMonth: 4, cap: 31, project: PROJECT_NAME } });
    if (!retried.ok) throw new Error(retried.refusal);
    expect(retried.event.facts).toEqual({ job: "nightly", setupApprovedBy: "dev_9", runsThisMonth: 4, cap: 31 });
  });
});

describe("project-level lesson events, with the real vendored lessons sink", () => {
  it("never put the project's name in the chain as an id: a name-keyed target, the name only in the org's details", async () => {
    const projectLevel = await lessonLibraryEvents({ lessonId: undefined });
    expect(projectLevel.length).toBeGreaterThan(20);
    for (const core of projectLevel) {
      // The vendored sink really does name the project in the subject's id: this is the shape the fix is for.
      expect(core.subject?.id, core.action).toBe(LESSON_PROJECT);
      const made = toCloudAuditEvent(core);
      if (!made.ok) throw new Error(`${core.action}: ${made.refusal}`);
      expect(made.event.target, core.action).toEqual({ kind: "lesson", name: LESSON_PROJECT });
      const chainVisible = JSON.stringify({ ...made.event, target: "id" in made.event.target ? made.event.target : { kind: made.event.target.kind }, details: undefined });
      expect(chainVisible, core.action).not.toContain(LESSON_PROJECT);
      expect(made.event.details, core.action).toEqual([{ subject: "org", fields: { project: LESSON_PROJECT } }]);
    }
  });

  it("a lesson's own event targets the lesson by its id", async () => {
    const lessonLevel = await lessonLibraryEvents({ lessonId: "les_aaaa1111" });
    for (const core of lessonLevel) {
      const made = toCloudAuditEvent(core);
      if (!made.ok) throw new Error(`${core.action}: ${made.refusal}`);
      expect(made.event.target, core.action).toEqual({ kind: "lesson", id: "les_aaaa1111" });
    }
  });

  it("MUTATION: a mapping that targets the subject's id for a project-level event puts the name in the chain, and this test sees it", async () => {
    const [core] = await lessonLibraryEvents({ lessonId: undefined });
    const naive = { ...CORE_AUDIT_EVENT_MAP, [core!.action]: { ...CORE_AUDIT_EVENT_MAP[core!.action]!, target: { id: "lesson" as const } } };
    const made = toCloudAuditEvent(core!, naive);
    if (!made.ok) throw new Error(made.refusal);
    expect(JSON.stringify(made.event.target)).toContain(LESSON_PROJECT);
  });
});

describe("laptop-only core events, and the two lessons settings", () => {
  const REFERENCE = `docker.io/library/postgres@sha256:${"b".repeat(64)}`;
  const imageEvent = (action: string): AuditEvent => ({ eventId: `test_services.${action}.x.1`, companyId: ORG, at: AT, actor: { type: "person", id: "owner" }, action: `test_services.${action}`, details: { reference: REFERENCE, requested: "postgres:16" } });

  it("the scan still lists the owner's test-service image events, and they are accounted for as laptop-only (the strict check stays)", async () => {
    const { all } = await coreActions();
    for (const action of ["test_services.image_approved", "test_services.image_removed"]) {
      expect(all, action).toContain(action);
      expect(Object.keys(LAPTOP_ONLY_CORE_EVENTS), action).toContain(action);
      expect(LAPTOP_ONLY_CORE_EVENTS[action]!.length, action).toBeGreaterThan(20);
    }
    expect(unmappedCoreActions(all)).toEqual([]);
    // Without the laptop-only list the same events would be unmapped: the list is what accounts for them.
    expect(unmappedCoreActions(all, CORE_AUDIT_EVENT_MAP, {})).toEqual(["test_services.image_approved", "test_services.image_removed"]);
  });

  it("every laptop-only entry is still something the core records (a stale entry fails), and none is also mapped", async () => {
    const { all } = await coreActions();
    expect(Object.keys(LAPTOP_ONLY_CORE_EVENTS).filter((action) => !all.includes(action))).toEqual([]);
    expect(Object.keys(LAPTOP_ONLY_CORE_EVENTS).filter((action) => Object.hasOwn(CORE_AUDIT_EVENT_MAP, action))).toEqual([]);
    expect(Object.keys(LAPTOP_ONLY_CORE_EVENTS).map(cloudActionOf)).toEqual([undefined, undefined]);
  });

  it("MUTATION PROOF: mapping a laptop-only event again (to company_image.* or anything) fails the disjoint check, and the sink still refuses it", () => {
    const remapped = { ...CORE_AUDIT_EVENT_MAP, "test_services.image_approved": { cloud: "company_image.approved", target: { org: true as const } } } as const;
    expect(Object.keys(LAPTOP_ONLY_CORE_EVENTS).filter((action) => Object.hasOwn(remapped, action))).toEqual(["test_services.image_approved"]);
    expect(toCloudAuditEvent(imageEvent("image_approved"), remapped)).toEqual({ ok: false, refusal: "laptop_only" });
  });

  it("a stray one arriving in Cloud is refused and logged as a wiring fault, and writes nothing: in refuse mode it throws, in skip mode it adds no step", async () => {
    const store = new MemoryDocumentStore();
    const logs: Array<Record<string, unknown>> = [];
    for (const action of ["image_approved", "image_removed"]) {
      const refusing = createCloudAuditSink({ store: () => store, now: () => NOW, log: (entry) => logs.push(entry) });
      expect(() => refusing.stage(imageEvent(action))).toThrow(/laptop_only/u);
      await expect(refusing.record(imageEvent(action))).rejects.toThrow(CloudAuditSinkError);
      const skipping = createCloudAuditSink({ store: () => store, now: () => NOW, onInvalid: "skip", log: (entry) => logs.push(entry) });
      expect(skipping.stage(imageEvent(action))).toEqual([]);
      await skipping.record(imageEvent(action));
    }
    expect(await store.query({ pk: "AUDIT_PENDING#0" })).toMatchObject({ items: [] });
    for (let shard = 0; shard < 10; shard += 1) expect((await store.query({ pk: `AUDIT_PENDING#${String(shard)}` })).items).toEqual([]);
    expect(logs.length).toBeGreaterThanOrEqual(8);
    for (const entry of logs) expect(entry).toEqual({ event: "audit.record_invalid", level: "error", reason: "laptop_only", fault: "wiring", coreAction: expect.stringMatching(/^test_services\.image_(approved|removed)$/u) as string });
    expect(JSON.stringify(logs)).not.toContain("postgres");
  });

  it("lesson.local_tools_switched and lesson.repo_file_retire_decided keep their Cloud names, with a project or company scope, a verdict word and a count", async () => {
    const events = [...(await lessonLibraryEvents({ lessonId: undefined })), ...(await lessonLibraryEvents({ lessonId: "les_aaaa1111" }))].filter((core) => ["lesson.local_tools_switched", "lesson.repo_file_retire_decided"].includes(core.action));
    expect(events).toHaveLength(4);
    for (const core of events) {
      const made = toCloudAuditEvent(core);
      if (!made.ok) throw new Error(`${core.action}: ${made.refusal}`);
      expect(made.event.action).toBe(core.action);
      expect(AuditEventInputSchema.safeParse(made.event).success).toBe(true);
    }
    const direct = (action: string, facts: NonNullable<AuditEvent["details"]>) => toCloudAuditEvent({ eventId: "e", companyId: ORG, at: AT, actor: person, action, subject: { type: "lesson", id: "_workspace" }, details: { project: "_workspace", ...facts } });
    expect(direct("lesson.local_tools_switched", { scope: "company", enabled: false })).toMatchObject({ ok: true, event: { target: { kind: "lesson", name: "_workspace" }, facts: { scope: "company", enabled: false } } });
    expect(direct("lesson.repo_file_retire_decided", { verdict: "retire", missing: 4 })).toMatchObject({ ok: true, event: { facts: { verdict: "retire", missing: 4 } } });
    expect(direct("lesson.repo_file_retire_decided", { verdict: "pat smith", missing: 4 })).toMatchObject({ ok: true, event: { facts: { missing: 4 } } });
  });
});

describe("one pull request, one id; one approval window setting, one action", () => {
  const opened = (details: NonNullable<AuditEvent["details"]>) => toCloudAuditEvent({ ...sampleOf("pull_request.opened", CORE_AUDIT_EVENT_MAP["pull_request.opened"]!), details });
  const requested = (details: NonNullable<AuditEvent["details"]>) => toCloudAuditEvent({ ...sampleOf("pull_request.merge_requested", CORE_AUDIT_EVENT_MAP["pull_request.merge_requested"]!), details });
  const idOf = (result: ReturnType<typeof opened>): string => { if (!result.ok || !("id" in result.event.target)) throw new Error("no id"); return result.event.target.id; };

  it("opened and merge_requested agree on the id when they name the repository the same way (the repository key), whatever its case", () => {
    const a = opened({ repositoryKey: "Acme/Web", repository: "web", number: "7" });
    const b = requested({ repository: "acme/web", number: 7, method: "squash", requestId: "req-1" });
    expect(idOf(a)).toBe(idOf(b));
    const orgDetails = (result: typeof a) => (result.ok ? result.event.details : undefined);
    expect(orgDetails(a)).toEqual([{ subject: "org", fields: { repository: "acme/web" } }]);
    expect(orgDetails(b)).toEqual(orgDetails(a));
    expect(a.ok && a.event.facts).toEqual({ number: 7 });
  });

  it("until Code sends the key, opened names the repository by its id, and says so: the gap is listed, and its org detail is the string the id was made from", () => {
    const a = opened({ repository: "web", number: 7 });
    expect(a.ok && a.event.details).toEqual([{ subject: "org", fields: { repository: "web" } }]);
    expect(AUDIT_SINK_GAPS.map((gap) => gap.id)).toContain("A7-G1-pull-request-repository-key");
    expect(idOf(a)).not.toBe(idOf(requested({ repository: "acme/web", number: 7, method: "squash" })));
  });

  it("the core's pull_request.merged (merge tracking, since the 0.5.17 pin) maps to Cloud's own event, on the same pull request id as merge_requested, with the number as its only fact", () => {
    const merged = toCloudAuditEvent({
      ...sampleOf("pull_request.merged", CORE_AUDIT_EVENT_MAP["pull_request.merged"]!),
      actor: { type: "system", id: "merge-tracking" },
      details: { repository: "Acme/Web", number: 7, taskId: "task-1", mergeCommit: "a".repeat(40), mergedBy: "someone" },
    });
    if (!merged.ok) throw new Error(merged.refusal);
    expect(merged.event).toMatchObject({ action: "pull_request.merged", facts: { number: 7 }, details: [{ subject: "org", fields: { repository: "acme/web" } }] });
    expect(idOf(merged)).toBe(idOf(requested({ repository: "acme/web", number: 7, method: "squash" })));
    expect(JSON.stringify(merged.event)).not.toContain("someone");
  });

  it("the merge method fact is one of the merge methods", () => {
    const made = requested({ repository: "acme/web", number: 7, method: "pat-smith" });
    expect(made.ok && made.event.facts).toEqual({ number: 7 });
  });

  it("the approval sign-in setting is Cloud's company.approval_window_changed: seconds before and after, a direct change", () => {
    const made = toCloudAuditEvent({ ...sampleOf("setting.approval_sign_in_changed", CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!), details: { mode: "window", seconds: 7_200, revision: 4, previous: { mode: "window", seconds: 3_600, isDefault: false } } });
    if (!made.ok) throw new Error(made.refusal);
    expect(made.event).toMatchObject({ action: "company.approval_window_changed", target: { kind: "org", id: ORG }, facts: { from: 3_600, to: 7_200, mode: "direct", revision: 4 } });
  });

  it("a change between two windows is company.approval_window_changed, whichever way the seconds move", () => {
    const base = sampleOf("setting.approval_sign_in_changed", CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!);
    for (const [from, to] of [[3_600, 600], [600, 3_600]] as const) {
      const made = toCloudAuditEvent({ ...base, details: { mode: "window", seconds: to, revision: 6, previous: { mode: "window", seconds: from } } });
      expect(made.ok && made.event.action).toBe("company.approval_window_changed");
      expect(made.ok && made.event.facts).toEqual({ from, to, mode: "direct", revision: 6 });
    }
  });

  it("anything to or from 'trust any active company sign-in' is company.approval_sign_in_changed: mode words, the seconds a side has, the revision", () => {
    const base = sampleOf("setting.approval_sign_in_changed", CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!);
    const toAny = toCloudAuditEvent({ ...base, details: { mode: "any-active", revision: 5, previous: { mode: "window", seconds: 3_600, isDefault: false } } });
    expect(toAny.ok && toAny.event).toMatchObject({ action: "company.approval_sign_in_changed", target: { kind: "org", id: ORG }, facts: { mode: "any-active", fromMode: "window", fromSeconds: 3_600, revision: 5 } });
    expect(toAny.ok && toAny.event.facts).not.toHaveProperty("seconds");
    const fromAny = toCloudAuditEvent({ ...base, details: { mode: "window", seconds: 600, revision: 6, previous: { mode: "any-active" } } });
    expect(fromAny.ok && fromAny.event).toMatchObject({ action: "company.approval_sign_in_changed", facts: { mode: "window", fromMode: "any-active", seconds: 600, revision: 6 } });
    expect(fromAny.ok && fromAny.event.facts).not.toHaveProperty("fromSeconds");
    // Seconds count only on a side that is a window: a stray value on an any-active side is not a fact.
    const both = toCloudAuditEvent({ ...base, details: { mode: "any-active", seconds: 30, revision: 7, previous: { mode: "any-active", seconds: 99 } } });
    expect(both.ok && both.event.facts).toEqual({ mode: "any-active", fromMode: "any-active", revision: 7 });
  });

  it("a change with neither side readable, or a mode word that is not one of the two, is refused", () => {
    const base = sampleOf("setting.approval_sign_in_changed", CORE_AUDIT_EVENT_MAP["setting.approval_sign_in_changed"]!);
    expect(toCloudAuditEvent({ ...base, details: { revision: 5 } })).toEqual({ ok: false, refusal: "invalid_event" });
    expect(toCloudAuditEvent({ ...base, details: { mode: "window", revision: 5, previous: { mode: "window", seconds: 60 } } })).toEqual({ ok: false, refusal: "invalid_event" });
    expect(toCloudAuditEvent({ ...base, details: { mode: "any-active", revision: 5, previous: { mode: "pat-smith/fix login" } } })).toEqual({ ok: false, refusal: "invalid_event" });
  });

  it("script tokens carry their related record (the owner on a revoke, the task on a use), as Cloud's own writers do", () => {
    const revoked = toCloudAuditEvent({ ...sampleOf("script_token.revoked", CORE_AUDIT_EVENT_MAP["script_token.revoked"]!), details: { tokenId: "tok_1", by: "admin", related: "dev_owner" } });
    const used = toCloudAuditEvent({ ...sampleOf("script_token.used", CORE_AUDIT_EVENT_MAP["script_token.used"]!), details: { tokenId: "tok_1", day: "2026-11-11", permission: "start", related: "task-1" } });
    expect(revoked.ok && revoked.event.related).toEqual(["dev_owner"]);
    expect(used.ok && used.event).toMatchObject({ related: ["task-1"], facts: { day: "2026-11-11", permission: "start" } });
  });

  it("a decision targets the approval (the core's request id) and relates the task it is about", () => {
    const made = toCloudAuditEvent({ ...sampleOf("decision.approved", CORE_AUDIT_EVENT_MAP["decision.approved"]!), subject: { type: "plan", id: "task-9" }, details: { kind: "plan", risk: "high" } });
    expect(made.ok && made.event).toMatchObject({ action: "approval.decided", target: { kind: "approval", id: "req-1" }, related: ["task-9"], facts: { decision: "approved", kind: "plan", subjectKind: "plan" } });
  });
});

// ---- 5. Cloud's own row, drain and erasure rules ----------------------------------------------------------------------------------------------------------------------------------

describe("the staged row is Cloud's own outbox row, so Cloud's drain and erasure rules apply unchanged", () => {
  const made = (): AuditEventInput => { const result = toCloudAuditEvent(closedEvent()); if (!result.ok) throw new Error(result.refusal); return result.event; };

  it("is byte-for-byte the item Cloud's own auditPending writes for the same event, with the same 14-day expiry", () => {
    const deps: AuditDeps = { audit: { sqs: new FakeAuditSqs().client, queueUrl: "q", documentClient: {} as DynamoDBDocumentClient, tableName: "state", now: () => NOW, log: () => undefined } };
    const cloudsOwn = auditPending(deps, made())[0]!.Put!.Item;
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    const [step] = sink.stage(closedEvent());
    expect((step as { item: StoredDocument }).item).toEqual(JSON.parse(JSON.stringify(cloudsOwn)));
    expect((step as { item: StoredDocument }).item[INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(NOW / 1000) + AUDIT_PENDING_TTL_DAYS * 86_400);
    // Retention is unchanged (decision 74): the longest a copy of details lives in a pending row is still the 14 days the erasure promise counts.
    expect(AUDIT_DETAIL_STORES.find((store) => store.id === "pending-items")?.maxDays).toBe(AUDIT_PENDING_TTL_DAYS);
  });

  it("a row the sink staged is delivered by Cloud's drain, once, as the event, and deleted", async () => {
    const db = new FakeDynamoDb();
    const sqs = new FakeAuditSqs();
    const documentClient = { send: db.send } as unknown as DynamoDBDocumentClient;
    const deps: AuditDeps = { audit: { sqs: sqs.client, queueUrl: "q", documentClient, tableName: "state", now: () => NOW, log: () => undefined } };
    const sink = createCloudAuditSink({ store: () => new MemoryDocumentStore(), now: () => NOW });
    const [step] = sink.stage(closedEvent());
    const item = (step as { item: StoredDocument }).item;
    // The same transaction shape Cloud's hooked sites use: the action's item and the pending item.
    await documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "TASK#t1", sk: "STATE" } } }, { Put: { TableName: "state", Item: item } }] }));
    const result = await drainAuditPending(deps, NOW + 31_000);
    expect(result).toMatchObject({ examined: 1, sent: 1, failed: 0 });
    expect(sqs.queue).toHaveLength(1);
    expect(AuditEventInputSchema.parse(JSON.parse(sqs.queue[0]!.body))).toEqual(made());
    expect(db.find((row) => String(row.pk).startsWith("AUDIT_PENDING#"))).toHaveLength(0);
  });

  it("erasure: a person's details are only ever in the org's sealed details part, which Cloud's erasure and shred already cover; a person is the actor id, as in Cloud's own events", () => {
    for (const [action, mapping] of Object.entries(CORE_AUDIT_EVENT_MAP)) {
      const result = toCloudAuditEvent(sampleOf(action, mapping));
      if (!result.ok) throw new Error(`${action}: ${result.refusal}`);
      // No part is keyed by a person: the core hands this sink an id, never a name, and an id-keyed part would need a per-person key the sink has no right to make.
      expect((result.event.details ?? []).map((part) => part.subject).filter((subject) => subject !== "org"), action).toEqual([]);
      expect(result.event.actor.kind === "member" ? result.event.actor.id : "rovara").toBe(result.event.actor.id);
    }
  });

  it("the sink adds nothing to Cloud's live audit path: it is not imported by the audit module or the broker's routes, only by the Cloud root's module list", async () => {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync("git", ["grep", "-l", "adapters/audit-sink", "--", "packages/broker/src", ":!packages/broker/src/cloud/adapters/audit-sink"], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
    // S3 item 7 (S0-OWED-POINTS) registered the sink as the core's `audit-sink` point in the composition root (cloud/app/cloud-modules.ts), which runs only for core tasks (behind the combined switch). That
    // is the one importer allowed: the audit module and the broker's routes still never import it, so Cloud's own audit path is unchanged.
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual(["packages/broker/src/cloud/app/cloud-modules.ts"]);
  });
});
