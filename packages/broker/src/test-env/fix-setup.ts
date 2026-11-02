// Setup and test health SH17 (design setup-test-health.md, section 4.3): the Fix setup card. When the test ENVIRONMENT, not the code, kept a task's checks from giving a verdict, the ask that used to be the
// generic "ask card" is one card for the project's maintainers. Replaces: the generic ask card for environment faults (the decision, its limits and its order do not change).
//
// What is stored: one small record per project and cause (`FIXSETUP#<cause>`). The cause is an auto-fix code the broker itself derived (`AUTO_FIX_ENVIRONMENT_CODES`), never a word a worker, a model, a check or a
// repository printed. A later task blocked by the same cause JOINS the open record (a bounded list of task ids and a count); a card the maintainers put away ("Not now") or acted on stays closed until the cause
// comes back, and then a new one opens. The tests a "Mark as known failing" would add come from the broker's own evidence pack (checks that failed on the original code), are recorded here at the time the task
// blocks, and are bounded: a list that would not fit is dropped whole, so a partial mark is never offered.
//
// What is decided here: only the two things that need the server's friction. "Mark as known failing" (the card's approve; medium, so the evidence is opened first) adds the record's own tests to the project's
// already-failing set in the same transaction that closes the card and records the audit event. "Not now" closes the record. Run setup agent, Fix with agent and Retry task checks are done on the pages the
// card opens (the setup page, the affected task's page). Every decision here checks the caller's live authority over the project again, reads the record again and refuses a card whose record changed.
//
// Gated by `vx` (verification/switch.ts): with it off nothing is recorded and no card is listed.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AUTO_FIX_ENVIRONMENT_CODES, agentXError, projectPk, type AutoFixCode, type EvidencePack, type OrgId } from "@agentx/contracts";
import { autoFixCodeSentence } from "../developer/autofix-messages.js";
import { tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { auditProjectKnownFailingMarked } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type TransactItem } from "../audit/outbox.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import type { DecisionItem } from "../decisions/project.js";
import { FIX_SETUP_BROWSER_MESSAGE, type FixSetupAnswer } from "../decisions/performer.js";
import { KnownFailingTestId, knownFailingWrite, nextKnownFailing, readKnownFailingRow, type KnownFailingMark } from "./known-failing.js";
import { verifyResultsEnabled } from "../verification/switch.js";

type FixSetupItem = Extract<DecisionItem, { kind: "fix_setup" }>;
interface Who { orgId: string; developerId: string }
/** A press that came from a live browser session (the web boundary vouched for the cookie and the CSRF token); a token or an AI tool never has it. */
interface Presser extends Who { browserSession?: true | undefined }

/** A test a card could mark, with the check it failed in (a mark is for that test in that check). */
export interface MarkableTest { name: string; checkId: string }

/** The causes a Fix setup card can be about: the environment codes of the auto-fix policy, in the table's order (the first one an ask names is the cause). */
export const FIX_SETUP_CAUSES = AUTO_FIX_ENVIRONMENT_CODES;
export type FixSetupCause = (typeof FIX_SETUP_CAUSES)[number];
/** The only cause with tests to mark. */
export const FIX_SETUP_MARKABLE_CAUSE: FixSetupCause = "fails-on-original-code";

export const FIX_SETUP_TASKS_MAX = 25;
/** The most tests one card can offer to mark. Every one is shown in full on the card (names are at most 200 characters), so nothing is marked that was not read. */
export const FIX_SETUP_TESTS_MAX = 20;
/** The most projects and card records one listing reads, so a listing is bounded. */
export const FIX_SETUP_PROJECTS_MAX = 25;
export const FIX_SETUP_TASK_TITLES_MAX = 5;
const WRITE_ATTEMPTS = 4;

/** The failing step in the card's words, one per cause. */
export const FIX_SETUP_STEP: Readonly<Record<FixSetupCause, string>> = {
  "deadline-exceeded": "Checks ran out of time", "executor-failed": "Test machine", "executor-result-mismatch": "Test machine", "mock-unavailable": "Mocked service",
  "check-runner-failed": "Check runner", "check-not-started": "Starting a check", "provider-outage": "AI provider", "runner-busy": "Check runner",
  "setup-failed-in-task": "Setup", "host-blocked": "Website access", "build-host-offline": "Build host", "runtime-renewed": "Test machine",
  "runtime-environment-drifted": "Test machine", "runtime-expired": "Test machine", "runtime-unusable": "Test machine", "login-failed": "Test login",
  "setup-changed-files": "Setup", "leftover-processes": "Clean-up", "check-broken": "Check command", "fails-on-original-code": "Tests failing before this change",
};

/** The cause an ask is about: the first environment code (in the policy table's order) among its codes. Undefined when none is one. */
export function fixSetupCauseOf(codes: readonly AutoFixCode[]): FixSetupCause | undefined {
  return FIX_SETUP_CAUSES.find((cause) => codes.includes(cause));
}

/**
 * The tests a "Mark as known failing" could add. Two things must both hold for a test to be offered: it failed in a check that failed on the original code too (the broker's evidence pack: class
 * `already_failing`, outcome `failed`), AND the project's last nightly baseline on the default branch (`nightlyFailing`, broker-stored, empty when unknown or truncated) lists it as failing. The worker's report of the
 * change's own run decides neither alone: a test the change broke in a check that also failed on old code (B), or a test the change added (C, `newTests`), is never offered. `unconfirmed` counts the failing tests of
 * those checks that were not offered, so the card can say so. Undefined (the card has no such action) when there is no nightly data, no check qualifies, the pack does not name every failing test of a qualifying check,
 * nothing is confirmed, or more tests are confirmed than one card can show.
 */
export function failingOnOriginalTests(pack: EvidencePack | undefined, nightlyFailing: readonly string[]): { tests: MarkableTest[]; unconfirmed: number } | undefined {
  if (pack === undefined || nightlyFailing.length === 0) return undefined;
  const checks = pack.checks.filter((check) => check.after === "failed" && check.class === "already_failing");
  if (checks.length === 0) return undefined;
  const nightly = new Set(nightlyFailing);
  const confirmed = new Map<string, MarkableTest>();
  let unconfirmed = 0;
  for (const check of checks) {
    if (check.tests === undefined) return undefined;
    const failed = check.tests.names.filter((test) => test.status === "failed" || test.status === "errored");
    if (check.tests.failed + check.tests.errored === 0 || failed.length !== check.tests.failed + check.tests.errored) return undefined;
    const added = new Set(check.tests.newTests);
    for (const test of failed) {
      if (!added.has(test.name) && nightly.has(test.name) && KnownFailingTestId.safeParse(test.name).success) confirmed.set(`${check.checkId}\u0000${test.name}`, { name: test.name, checkId: check.checkId });
      else unconfirmed += 1;
    }
  }
  return confirmed.size > 0 && confirmed.size <= FIX_SETUP_TESTS_MAX ? { tests: [...confirmed.values()], unconfirmed } : undefined;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- the record

const RecordSchema = z.object({
  cause: z.enum(FIX_SETUP_CAUSES),
  status: z.enum(["open", "closed"]),
  version: z.number().int().min(1),
  epoch: z.number().int().min(1),
  openedAt: z.string().datetime(),
  lastAt: z.string().datetime(),
  taskIds: z.array(z.string().uuid()).max(FIX_SETUP_TASKS_MAX),
  taskCount: z.number().int().min(1).max(FIX_SETUP_TASKS_MAX),
  tests: z.array(z.object({ name: KnownFailingTestId, checkId: z.string().min(1).max(64) }).strict()).max(FIX_SETUP_TESTS_MAX),
  testsTruncated: z.boolean(),
  /** Failing tests of the qualifying checks that were not confirmed by the nightly baseline (so not offered). */
  unconfirmed: z.number().int().min(0).max(100_000).default(0),
  closedAt: z.string().datetime().optional(),
  closedReason: z.enum(["dismissed", "known_failing"]).optional(),
  closedBy: z.string().max(200).optional(),
}).passthrough();
export type FixSetupRecord = z.infer<typeof RecordSchema>;

const PREFIX = "FIXSETUP#";
const keyOf = (orgId: OrgId, project: string, cause: FixSetupCause) => ({ pk: projectPk(orgId, project), sk: `${PREFIX}${cause}` });
/** What version of a card the person is shown: any join, close or reopen changes it, so an earlier "evidence opened" does not carry over. */
export const fixSetupContentVersion = (record: Pick<FixSetupRecord, "epoch" | "version">): string => sha(`fixsetup:${String(record.epoch)}:${String(record.version)}`).slice(0, 32);

export type FixSetupStore = Pick<TestEnvDeps, "documentClient" | "tableName" | "now">;

async function readRecord(store: FixSetupStore, orgId: OrgId, project: string, cause: FixSetupCause): Promise<FixSetupRecord | undefined | "unreadable"> {
  const found = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: keyOf(orgId, project, cause), ConsistentRead: true })) as { Item?: unknown };
  if (found.Item === undefined) return undefined;
  const parsed = RecordSchema.safeParse(found.Item);
  return parsed.success ? parsed.data : "unreadable";
}

/** Tests the card would mark: valid, once each per check; a list over the bound is dropped whole (`truncated`), never cut. */
function normalizedTests(tests: readonly MarkableTest[] | undefined): { tests: MarkableTest[]; truncated: boolean } {
  const unique = new Map<string, MarkableTest>();
  for (const test of tests ?? []) if (KnownFailingTestId.safeParse(test.name).success && test.checkId.length > 0 && test.checkId.length <= 64) unique.set(`${test.checkId}\u0000${test.name}`, { name: test.name, checkId: test.checkId });
  return unique.size > FIX_SETUP_TESTS_MAX ? { tests: [], truncated: true } : { tests: [...unique.values()], truncated: false };
}

const conditionFailed = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

export type FixSetupRecorded = "opened" | "joined" | "unchanged" | "unreadable";

/**
 * A task blocked by `cause`: opens the project's card for that cause, or joins the open one. Idempotent for one task. Tests (for `fails-on-original-code` only) are the broker's own evidence of checks that
 * failed on the original code. Throws only for an infrastructure fault after a few attempts; the caller (the auto-fix runner) logs it and goes on, since the ask itself is already stored.
 */
export async function recordFixSetup(store: FixSetupStore, input: { orgId: OrgId; project: string; taskId: string; cause: FixSetupCause; tests?: readonly MarkableTest[] | undefined; unconfirmed?: number | undefined }): Promise<FixSetupRecorded> {
  const wanted = input.cause === FIX_SETUP_MARKABLE_CAUSE ? normalizedTests(input.tests) : { tests: [], truncated: false };
  const unconfirmed = input.cause === FIX_SETUP_MARKABLE_CAUSE ? Math.max(0, Math.min(100_000, Math.trunc(input.unconfirmed ?? 0))) : 0;
  const nowIso = new Date(store.now()).toISOString();
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const found = await readRecord(store, input.orgId, input.project, input.cause);
    if (found === "unreadable") return "unreadable";
    const base = { entityType: "FIX_SETUP", orgId: input.orgId, project: input.project, ...keyOf(input.orgId, input.project, input.cause), cause: input.cause };
    try {
      if (found === undefined || found.status === "closed") {
        const record: FixSetupRecord = { cause: input.cause, status: "open", version: (found?.version ?? 0) + 1, epoch: (found?.epoch ?? 0) + 1, openedAt: nowIso, lastAt: nowIso, taskIds: [input.taskId], taskCount: 1, tests: wanted.tests, testsTruncated: wanted.truncated, unconfirmed };
        await store.documentClient.send(new PutCommand({
          TableName: store.tableName, Item: { ...base, ...record },
          ...(found === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#version = :version AND #status = :closed", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":version": found.version, ":closed": "closed" } }),
        }));
        return "opened";
      }
      if (found.taskIds.includes(input.taskId)) return "unchanged";
      // A full record changes nothing: its tests are those of its first tasks, which are the ones the card has shown.
      if (found.taskIds.length >= FIX_SETUP_TASKS_MAX) return "unchanged";
      const truncated = found.testsTruncated || wanted.truncated;
      const union = normalizedTests(truncated ? [] : [...found.tests, ...wanted.tests]);
      const record: FixSetupRecord = {
        ...found, version: found.version + 1, lastAt: nowIso, taskIds: [...found.taskIds, input.taskId], taskCount: found.taskCount + 1,
        tests: truncated || union.truncated ? [] : union.tests, testsTruncated: truncated || union.truncated, unconfirmed: Math.max(found.unconfirmed, unconfirmed),
      };
      await store.documentClient.send(new PutCommand({
        TableName: store.tableName, Item: { ...base, ...record },
        ConditionExpression: "#version = :version AND #status = :open", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":version": found.version, ":open": "open" },
      }));
      return "joined";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // Someone else wrote first: read again and decide again.
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the Fix setup record kept changing");
}

// ---- the card source

export interface FixSetupCardPorts {
  store: FixSetupStore;
  /** The projects the caller may edit the settings of (a maintainer), at most `FIX_SETUP_PROJECTS_MAX` are read. */
  maintainedProjects(caller: Who): Promise<string[]>;
  task(taskId: string): Promise<DeveloperTaskRecord | undefined>;
}

const stepOf = (cause: FixSetupCause): string => FIX_SETUP_STEP[cause];

/** The card's item for one open record. The tests to mark are shown by count and by name in the details, and are the record's, never a request's. */
function itemOf(project: string, orgId: string, record: FixSetupRecord, titles: readonly string[]): FixSetupItem {
  const marks = record.testsTruncated ? 0 : record.tests.length;
  const details: Array<{ title: string; lines: string[] }> = [
    { title: "What failed", lines: [autoFixCodeSentence(record.cause)] },
    ...(titles.length === 0 ? [] : [{ title: "Tasks waiting on this", lines: [...titles, ...(record.taskCount > titles.length ? [`and ${String(record.taskCount - titles.length)} more`] : [])] }]),
    // Every name that would be marked is listed in full (the record holds at most FIX_SETUP_TESTS_MAX names of at most 200 characters); a longer list could not be offered at all.
    ...(marks === 0 ? [] : [{ title: "Tests that would be marked as already failing", lines: [...record.tests.slice(0, FIX_SETUP_TESTS_MAX).map((test) => test.name), ...(record.tests.length > FIX_SETUP_TESTS_MAX ? [`and ${String(record.tests.length - FIX_SETUP_TESTS_MAX)} more`] : [])] }]),
  ];
  return {
    kind: "fix_setup", subjectId: `${sha(`${orgId}:${project}`).slice(0, 24)}-${record.cause}`, project, title: `Fix setup: ${stepOf(record.cause)}`, createdAt: record.openedAt,
    openPath: `/app/onboard?project=${encodeURIComponent(project)}&step=setup`, contentVersion: fixSetupContentVersion(record), details,
    cause: record.cause, step: stepOf(record.cause), taskCount: record.taskCount, knownFailingTests: marks, unconfirmedFailing: record.unconfirmed,
  };
}

/**
 * The open Fix setup cards of the projects the caller maintains. Empty while `vx` is off. A project or record that cannot be read is left out (fail closed). A task's title is named only to its own current owner
 * (a maintainer is not shown another person's task title), for open tasks of this company and project, at most five; the count covers all of them.
 */
export async function fixSetupItemsFor(ports: FixSetupCardPorts, caller: Who, env: NodeJS.ProcessEnv = process.env): Promise<DecisionItem[]> {
  if (!verifyResultsEnabled(env)) return [];
  const found: DecisionItem[] = [];
  for (const project of (await ports.maintainedProjects(caller)).slice(0, FIX_SETUP_PROJECTS_MAX)) {
    try {
      const rows = (await ports.store.documentClient.send(new QueryCommand({
        TableName: ports.store.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(caller.orgId, project), ":prefix": PREFIX },
        ConsistentRead: true, Limit: FIX_SETUP_CAUSES.length + 5,
      }))) as { Items?: unknown[] };
      for (const row of rows.Items ?? []) {
        const record = RecordSchema.safeParse(row);
        if (!record.success || record.data.status !== "open") continue;
        const titles: string[] = [];
        for (const taskId of record.data.taskIds.slice(0, FIX_SETUP_TASK_TITLES_MAX)) {
          try {
            const task = await ports.task(taskId);
            if (task !== undefined && task.orgId === caller.orgId && task.project === project && task.closedAt === undefined && tryEffectiveTaskOwner(task)?.developerId === caller.developerId) titles.push(task.title);
          } catch { /* a task that cannot be read is not named */ }
        }
        found.push(itemOf(project, caller.orgId, record.data, titles));
      }
    } catch { /* a project whose cards cannot be read has none */ }
  }
  return found;
}

// ---- the two decisions

export interface FixSetupDecisionPorts {
  store: TestEnvDeps;
  /** Whether the caller may edit the project's settings now (a live check of their role, never a claim). */
  mayEditSettings(caller: Who, project: string): Promise<boolean>;
  /** Whether a second person must confirm a mark (default `fixSetupNeedsSecondPerson`: no one). */
  secondPersonNeed?: typeof fixSetupNeedsSecondPerson;
}

/** The record a card was built from, still open and unchanged, or the answer to give instead. */
async function currentRecord(ports: FixSetupDecisionPorts, caller: Who, item: FixSetupItem): Promise<FixSetupRecord | "stale"> {
  if (!(await ports.mayEditSettings(caller, item.project))) throw agentXError("FORBIDDEN", "only a project maintainer can decide this");
  const cause = FIX_SETUP_CAUSES.find((candidate) => candidate === item.cause);
  if (cause === undefined) return "stale";
  const record = await readRecord(ports.store, caller.orgId, item.project, cause);
  if (record === undefined || record === "unreadable" || record.status !== "open" || fixSetupContentVersion(record) !== item.contentVersion) return "stale";
  return record;
}

const closeItem = (store: FixSetupStore, orgId: OrgId, project: string, record: FixSetupRecord, reason: "dismissed" | "known_failing", by: string, nowIso: string): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: { entityType: "FIX_SETUP", orgId, project, ...keyOf(orgId, project, record.cause), ...record, status: "closed", version: record.version + 1, closedAt: nowIso, closedReason: reason, closedBy: by },
    ConditionExpression: "#version = :version AND #status = :open", ExpressionAttributeNames: { "#version": "version", "#status": "status" }, ExpressionAttributeValues: { ":version": record.version, ":open": "open" },
  },
});

async function send(store: FixSetupStore, items: TransactItem[]): Promise<boolean> {
  try {
    await store.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
}

/** Whether a second person must confirm a mark. The seam for the owner's decision on a presser who owns one of the affected tasks (a person could mark the tests their own change broke): for now no one is needed. */
export type SecondPersonNeed = "needed" | "not_needed";
export function fixSetupNeedsSecondPerson(input: { caller: Who; record: Pick<FixSetupRecord, "taskIds" | "cause" | "epoch">; project: string }): Promise<SecondPersonNeed> {
  void input;
  return Promise.resolve("not_needed");
}

const hashOf = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

/**
 * "Mark as known failing": adds the record's tests to the project's already-failing set, closes the card and records the audit event, in ONE transaction that holds only while the record and the set are as read.
 * Only a live browser session may press it (FORBIDDEN otherwise, so a stolen token or an AI tool cannot change how results are judged), and the caller must still be a maintainer of the project. A card with
 * nothing to mark is "not_ready" (no partial mark); a card whose record changed or closed since it was shown is "stale"; a list that would pass its limit is refused with its own sentence. Each mark keeps who made
 * it, when, on which card and for which check.
 */
export async function markKnownFailing(ports: FixSetupDecisionPorts, caller: Presser, item: FixSetupItem, requestId: string): Promise<FixSetupAnswer> {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", FIX_SETUP_BROWSER_MESSAGE);
  const record = await currentRecord(ports, caller, item);
  if (record === "stale") return "stale";
  if (record.cause !== FIX_SETUP_MARKABLE_CAUSE || record.testsTruncated || record.tests.length === 0) return "not_ready";
  if ((await (ports.secondPersonNeed ?? fixSetupNeedsSecondPerson)({ caller, record, project: item.project })) === "needed") return "second_person";
  const orgId = caller.orgId;
  const before = await readKnownFailingRow(ports.store, orgId, item.project);
  if (before === undefined) return "not_ready";
  const nowIso = new Date(ports.store.now()).toISOString();
  const added: KnownFailingMark[] = record.tests.map((test) => ({ name: test.name, checkId: test.checkId, markedBy: caller.developerId, markedAt: nowIso, epoch: record.epoch }));
  // Throws the limit's own refusal ("This project's known-failing list is full (500)...").
  const next = nextKnownFailing(before, added);
  const event = await tryAuditEvent(ports.store, () => auditProjectKnownFailingMarked({
    orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: nowIso, occurrence: requestId, projectName: item.project, cause: record.cause, testCount: next.length - before.marks.length,
    recordEpoch: record.epoch, taskCount: record.taskCount, taskIdsSha256: hashOf([...record.taskIds].sort()),
    testSetSha256: hashOf(record.tests.map((test) => `${test.checkId}\t${test.name}`).sort()), rowVersionAfter: before.version + 1, totalAfter: next.length,
  }));
  const done = await send(ports.store, [
    knownFailingWrite(ports.store, orgId, item.project, before, next, nowIso),
    closeItem(ports.store, orgId, item.project, record, "known_failing", caller.developerId, nowIso),
    ...(event === undefined ? [] : auditPending(ports.store, event)),
  ]);
  if (!done) return "stale";
  if (event !== undefined) await flushAuditEvents(ports.store, [event]);
  return "done";
}

/** "Not now": closes the record, so the card goes away until the cause comes back. Changes no setting, so no audit event. */
export async function dismissFixSetup(ports: FixSetupDecisionPorts, caller: Who, item: FixSetupItem): Promise<FixSetupAnswer> {
  const record = await currentRecord(ports, caller, item);
  if (record === "stale") return "stale";
  const done = await send(ports.store, [closeItem(ports.store, caller.orgId, item.project, record, "dismissed", caller.developerId, new Date(ports.store.now()).toISOString())]);
  return done ? "done" : "stale";
}
