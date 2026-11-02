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
import type { ApprovalCaller, ApprovalDependencies } from "../agents/approvals.js";
import { confirmedKnownFailingApproval, requestKnownFailingCard, type KnownFailingScope } from "../org/known-failing-approval.js";
import type { SecondPersonPort } from "../org/test-environment.js";
import { verifyResultsEnabled } from "../verification/switch.js";

type FixSetupItem = Extract<DecisionItem, { kind: "fix_setup" }>;
interface Who { orgId: string; developerId: string }
/** A press that came from a live browser session (the web boundary vouched for the cookie and the CSRF token); a token or an AI tool never has it. */
interface Presser extends Who { browserSession?: true | undefined; orgRole?: ApprovalCaller["orgRole"] | undefined }

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
 * What a Fix setup card can say about a check that failed on the original code too, from the broker's own evidence pack (class `already_failing`, outcome `failed`) and the project's USABLE nightly baseline
 * (`nightlyFailing`: recent, the task's base branch, whole; empty when there is none). Owner decision (Opus re-check M2): such a check where every failing test is on the nightly list is a setup problem, and those
 * tests may be marked; but if it has ANY failing test the nightly list does not show, a failing test the change added (`newTests`), or failing tests the pack does not name, the old failure is hiding a new one: that is
 * the CODE's fault (`codeFault`), the result is Code failed, and nothing is offered. With no usable nightly, every failing test of such a check is unconfirmed. `unconfirmed` counts them.
 * Undefined (the card has no mark) when there is no pack, no qualifying check, a check with no test counts, nothing confirmed, or more confirmed than one card shows.
 */
export function failingOnOriginalTests(pack: EvidencePack | undefined, nightlyFailing: readonly string[]): { tests: MarkableTest[]; unconfirmed: number; codeFault: boolean } | undefined {
  if (pack === undefined) return undefined;
  const checks = pack.checks.filter((check) => check.after === "failed" && check.class === "already_failing");
  if (checks.length === 0) return undefined;
  const nightly = new Set(nightlyFailing);
  const confirmed = new Map<string, MarkableTest>();
  let unconfirmed = 0;
  for (const check of checks) {
    if (check.tests === undefined) return undefined;
    const declared = check.tests.failed + check.tests.errored;
    if (declared === 0) return undefined;
    const failed = check.tests.names.filter((test) => test.status === "failed" || test.status === "errored");
    // Failing tests the pack does not name cannot be confirmed.
    unconfirmed += Math.max(0, declared - failed.length);
    const added = new Set(check.tests.newTests);
    for (const test of failed) {
      if (!added.has(test.name) && nightly.has(test.name) && KnownFailingTestId.safeParse(test.name).success) confirmed.set(`${check.checkId}\u0000${test.name}`, { name: test.name, checkId: check.checkId });
      else unconfirmed += 1;
    }
  }
  if (unconfirmed > 0) return { tests: [], unconfirmed, codeFault: true };
  return confirmed.size > 0 && confirmed.size <= FIX_SETUP_TESTS_MAX ? { tests: [...confirmed.values()], unconfirmed: 0, codeFault: false } : undefined;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- the record

export const FixSetupRecordSchema = z.object({
  // An auto-fix code (a task blocked by the environment) or one of the health lane's cause words (a nightly night, `snake_case`): codes use hyphens, so the two cannot meet.
  cause: z.union([z.enum(FIX_SETUP_CAUSES), z.string().regex(/^[a-z][a-z_]{0,39}$/u)]),
  status: z.enum(["open", "closed"]),
  /** The highest project-health version that touched this record (0: only tasks did). A health call older than this is refused (the L4 race). */
  healthVersion: z.number().int().min(0).default(0),
  version: z.number().int().min(1),
  epoch: z.number().int().min(1),
  openedAt: z.string().datetime(),
  lastAt: z.string().datetime(),
  taskIds: z.array(z.string().uuid()).max(FIX_SETUP_TASKS_MAX),
  taskCount: z.number().int().min(0).max(FIX_SETUP_TASKS_MAX),
  tests: z.array(z.object({ name: KnownFailingTestId, checkId: z.string().min(1).max(64) }).strict()).max(FIX_SETUP_TESTS_MAX),
  testsTruncated: z.boolean(),
  /** Failing tests of the qualifying checks that were not confirmed by the nightly baseline (so not offered). */
  unconfirmed: z.number().int().min(0).max(100_000).default(0),
  closedAt: z.string().datetime().optional(),
  closedReason: z.enum(["dismissed", "known_failing", "resolved"]).optional(),
  closedBy: z.string().max(200).optional(),
}).passthrough();
export type FixSetupRecord = z.infer<typeof FixSetupRecordSchema>;

const PREFIX = "FIXSETUP#";
export const fixSetupKeyOf = (orgId: OrgId, project: string, cause: string) => ({ pk: projectPk(orgId, project), sk: `${PREFIX}${cause}` });
/** What version of a card the person is shown: any join, close or reopen changes it, so an earlier "evidence opened" does not carry over. */
export const fixSetupContentVersion = (record: Pick<FixSetupRecord, "epoch" | "version">): string => sha(`fixsetup:${String(record.epoch)}:${String(record.version)}`).slice(0, 32);

export type FixSetupStore = Pick<TestEnvDeps, "documentClient" | "tableName" | "now">;

export async function readFixSetupRecord(store: FixSetupStore, orgId: OrgId, project: string, cause: string): Promise<FixSetupRecord | undefined | "unreadable"> {
  const found = await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: fixSetupKeyOf(orgId, project, cause), ConsistentRead: true })) as { Item?: unknown };
  if (found.Item === undefined) return undefined;
  const parsed = FixSetupRecordSchema.safeParse(found.Item);
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

/** What opening or joining a record needs, the same for a task that was blocked and for the health lane's call. */
export interface JoinInput { cause: string; taskIds: readonly string[]; tests: { tests: MarkableTest[]; truncated: boolean }; unconfirmed: number; nowIso: string; healthVersion?: number | undefined }

/**
 * The record after `found` is opened or joined by `input`, or undefined when nothing would change. A closed (or absent) record opens a new epoch; an open one takes the new task ids that fit (a FULL record changes
 * nothing: its tests are those of its first tasks, which are the ones the card has shown). Pure.
 */
export function planFixSetupJoin(found: FixSetupRecord | undefined, input: JoinInput): { record: FixSetupRecord; kind: "opened" | "joined" } | undefined {
  const health = input.healthVersion ?? 0;
  if (found === undefined || found.status === "closed") {
    const taskIds = [...new Set(input.taskIds)].slice(0, FIX_SETUP_TASKS_MAX);
    return { kind: "opened", record: {
      cause: input.cause, status: "open", healthVersion: health, version: (found?.version ?? 0) + 1, epoch: (found?.epoch ?? 0) + 1, openedAt: input.nowIso, lastAt: input.nowIso,
      taskIds, taskCount: taskIds.length, tests: input.tests.tests, testsTruncated: input.tests.truncated, unconfirmed: input.unconfirmed,
    } };
  }
  const fresh = [...new Set(input.taskIds)].filter((id) => !found.taskIds.includes(id));
  const room = FIX_SETUP_TASKS_MAX - found.taskIds.length;
  const added = fresh.slice(0, Math.max(0, room));
  const raisesHealth = health > found.healthVersion;
  if (added.length === 0 && !raisesHealth) return undefined;
  if (added.length === 0) return { kind: "joined", record: { ...found, healthVersion: health, version: found.version + 1, lastAt: input.nowIso } };
  const truncated = found.testsTruncated || input.tests.truncated;
  const union = normalizedTests(truncated ? [] : [...found.tests, ...input.tests.tests]);
  return { kind: "joined", record: {
    ...found, healthVersion: Math.max(found.healthVersion, health), version: found.version + 1, lastAt: input.nowIso, taskIds: [...found.taskIds, ...added], taskCount: found.taskCount + added.length,
    tests: truncated || union.truncated ? [] : union.tests, testsTruncated: truncated || union.truncated, unconfirmed: Math.max(found.unconfirmed, input.unconfirmed),
  } };
}

/** The Put that stores `planned` over `found` (conditional on `found` being exactly as read), as a plain command input so it can sit in a transaction. */
export function fixSetupPut(store: FixSetupStore, orgId: OrgId, project: string, found: FixSetupRecord | undefined, record: FixSetupRecord) {
  const item = { entityType: "FIX_SETUP", orgId, project, ...fixSetupKeyOf(orgId, project, record.cause), ...record };
  return found === undefined
    ? { TableName: store.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" }
    : { TableName: store.tableName, Item: item, ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": found.version } };
}

/**
 * A task blocked by `cause`: opens the project's card for that cause, or joins the open one. Idempotent for one task. Tests (for `fails-on-original-code` only) are the broker's own evidence of checks that
 * failed on the original code. Throws only for an infrastructure fault after a few attempts; the caller (the auto-fix runner) logs it and goes on, since the ask itself is already stored.
 */
export async function recordFixSetup(store: FixSetupStore, input: { orgId: OrgId; project: string; taskId: string; cause: FixSetupCause; tests?: readonly MarkableTest[] | undefined; unconfirmed?: number | undefined }): Promise<FixSetupRecorded> {
  const wanted = input.cause === FIX_SETUP_MARKABLE_CAUSE ? normalizedTests(input.tests) : { tests: [], truncated: false };
  const unconfirmed = input.cause === FIX_SETUP_MARKABLE_CAUSE ? Math.max(0, Math.min(100_000, Math.trunc(input.unconfirmed ?? 0))) : 0;
  const nowIso = new Date(store.now()).toISOString();
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const found = await readFixSetupRecord(store, input.orgId, input.project, input.cause);
    if (found === "unreadable") return "unreadable";
    const planned = planFixSetupJoin(found, { cause: input.cause, taskIds: [input.taskId], tests: wanted, unconfirmed, nowIso });
    if (planned === undefined) return "unchanged";
    try {
      await store.documentClient.send(new PutCommand(fixSetupPut(store, input.orgId, input.project, found, planned.record)));
      return planned.kind;
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

/** The failing step and the sentence for a cause the health lane's nightly run found (the night's own words, fixed here). */
const NIGHTLY_CAUSE_WORDS: Readonly<Record<string, { step: string; sentence: string }>> = {
  pull_failed: { step: "Getting the code", sentence: "The nightly run could not get the project's code." },
  update_failed: { step: "Getting the code", sentence: "The nightly run could not bring the code up to date." },
  setup_failed: { step: "Setup", sentence: "The nightly run could not set the project up." },
  build_failed: { step: "Build", sentence: "The nightly run could not build the project." },
  boot_failed: { step: "Starting the app", sentence: "The nightly run could not start the app." },
  mocks_failed: { step: "Mocked service", sentence: "The nightly run could not start a stand-in for an outside service." },
  preprod_unreachable: { step: "Pre-production access", sentence: "The nightly run could not reach the pre-production service." },
  check_never_started: { step: "Starting a check", sentence: "The nightly run could not start a check." },
  check_timed_out: { step: "Checks ran out of time", sentence: "A check in the nightly run ran out of time." },
  no_tests_collected: { step: "Finding tests", sentence: "The nightly run found no tests to run." },
  no_report_written: { step: "Test report", sentence: "A check in the nightly run wrote no test report." },
  collection_errors: { step: "Finding tests", sentence: "The nightly run could not load many of the project's tests." },
};
const stepOf = (cause: string): string => (FIX_SETUP_CAUSES as readonly string[]).includes(cause) ? FIX_SETUP_STEP[cause as FixSetupCause] : NIGHTLY_CAUSE_WORDS[cause]?.step ?? "Setup";
const sentenceOf = (cause: string): string => (FIX_SETUP_CAUSES as readonly string[]).includes(cause) ? autoFixCodeSentence(cause as AutoFixCode) : NIGHTLY_CAUSE_WORDS[cause]?.sentence ?? "The test setup could not give a verdict.";

/** The card's item for one open record. The tests to mark are shown by count and by name in the details, and are the record's, never a request's. */
function itemOf(project: string, orgId: string, record: FixSetupRecord, titles: readonly string[]): FixSetupItem {
  const marks = record.testsTruncated ? 0 : record.tests.length;
  const details: Array<{ title: string; lines: string[] }> = [
    { title: "What failed", lines: [sentenceOf(record.cause)] },
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
        const record = FixSetupRecordSchema.safeParse(row);
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
  /** Who owns the affected tasks and the company's "always two people" setting (absent: a second person is always needed). */
  policy?: SecondPersonPolicyPorts | undefined;
  /** The second person's confirmation: the approval cards and the check over the company's records (absent: a mark that needs a second person is refused). */
  approvals?: { deps: ApprovalDependencies; secondPerson: SecondPersonPort } | undefined;
  /** For tests: replaces `fixSetupNeedsSecondPerson`. */
  secondPersonNeed?: (input: Parameters<typeof fixSetupNeedsSecondPerson>[0]) => Promise<SecondPersonNeed>;
}

/** The record a card was built from, still open and unchanged, or the answer to give instead. */
async function currentRecord(ports: FixSetupDecisionPorts, caller: Who, item: FixSetupItem): Promise<FixSetupRecord | "stale"> {
  if (!(await ports.mayEditSettings(caller, item.project))) throw agentXError("FORBIDDEN", "only a project maintainer can decide this");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(item.cause)) return "stale";
  const record = await readFixSetupRecord(ports.store, caller.orgId, item.project, item.cause);
  if (record === undefined || record === "unreadable" || record.status !== "open" || fixSetupContentVersion(record) !== item.contentVersion) return "stale";
  return record;
}

const closeItem = (store: FixSetupStore, orgId: OrgId, project: string, record: FixSetupRecord, reason: "dismissed" | "known_failing", by: string, nowIso: string): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: { entityType: "FIX_SETUP", orgId, project, ...fixSetupKeyOf(orgId, project, record.cause), ...record, status: "closed", version: record.version + 1, closedAt: nowIso, closedReason: reason, closedBy: by },
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

/**
 * Why a second person is or is not needed for a mark (owner decision F4, option D). By default ONE maintainer may mark. A second, different maintainer or admin must confirm when the presser is the effective owner of any
 * task that was waiting on the card (they could otherwise excuse the tests their own change broke), when an owner cannot be told (a task that cannot be read, or the card is full at 25 tasks and not every owner is
 * known), and always when the company turned on "always two people". Fixed words; they go into the audit event.
 */
export type SecondPersonWhy = "not_needed" | "owner_of_affected_task" | "owner_unknown" | "record_full" | "always_two";
export interface SecondPersonNeed { need: "needed" | "not_needed"; why: SecondPersonWhy }

export interface SecondPersonPolicyPorts {
  task(taskId: string): Promise<DeveloperTaskRecord | undefined>;
  /** The company's "always two people" setting (`org/known-failing-policy.ts`); unreadable must answer true. */
  alwaysTwoPeople(orgId: string): Promise<boolean>;
}

export async function fixSetupNeedsSecondPerson(input: { caller: Who; record: Pick<FixSetupRecord, "taskIds" | "taskCount" | "cause" | "epoch">; project: string; policy: SecondPersonPolicyPorts | undefined }): Promise<SecondPersonNeed> {
  const { caller, record, policy } = input;
  // Without the ports to tell, a second person is needed (fail closed).
  if (policy === undefined) return { need: "needed", why: "owner_unknown" };
  let always: boolean;
  try { always = await policy.alwaysTwoPeople(caller.orgId); } catch { always = true; }
  if (always) return { need: "needed", why: "always_two" };
  if (record.taskCount >= FIX_SETUP_TASKS_MAX) return { need: "needed", why: "record_full" };
  for (const taskId of record.taskIds) {
    let owner: string | undefined;
    try {
      const task = await policy.task(taskId);
      owner = task === undefined || task.orgId !== caller.orgId ? undefined : tryEffectiveTaskOwner(task)?.developerId;
    } catch { owner = undefined; }
    if (owner === undefined) return { need: "needed", why: "owner_unknown" };
    if (owner === caller.developerId) return { need: "needed", why: "owner_of_affected_task" };
  }
  return { need: "not_needed", why: "not_needed" };
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
  const orgId = caller.orgId;
  const needed = await (ports.secondPersonNeed ?? fixSetupNeedsSecondPerson)({ caller, record, project: item.project, policy: ports.policy });
  const testSetSha256 = hashOf(record.tests.map((test) => `${test.checkId}\t${test.name}`).sort());
  // The second person (owner decision F4): their confirmation card is bound to this Fix setup card version and this exact set of tests. Without a standing confirmation, the card is asked for (once) and the press is
  // answered "someone else has to decide this". With one, both people's live authority and the company's sole-owner switch are read again, and the check's commit conditions go into the same transaction.
  let second: { approverId: string; signedInAtMs: number; sessionRef: string; mode: "second_person" | "sole_owner_exception"; conditions: TransactItem[] } | undefined;
  if (needed.need === "needed") {
    if (ports.approvals === undefined || caller.orgRole === undefined) throw agentXError("FORBIDDEN", "A second person has to confirm this, and confirmations are not set up here.");
    const scope: KnownFailingScope = { orgId, project: item.project, cause: record.cause, epoch: record.epoch, recordVersion: record.version, testSetSha256, askedBy: caller.developerId };
    const confirmation = await confirmedKnownFailingApproval(ports.approvals.deps, scope);
    if (confirmation === undefined) {
      await requestKnownFailingCard(ports.approvals.deps, { orgId, developerId: caller.developerId, orgRole: caller.orgRole }, { project: item.project, cause: record.cause, epoch: record.epoch, recordVersion: record.version, testSetSha256, tests: record.tests });
      return "second_person";
    }
    // Throws FORBIDDEN when the approver is no longer eligible, when it is the same person and they are not the company's only owner, and when the company turned the sole-owner exception off.
    const check = await ports.approvals.secondPerson({ orgId, project: item.project, proposerId: caller.developerId, approverId: confirmation.approverId });
    second = { approverId: confirmation.approverId, signedInAtMs: confirmation.signedInAtMs, sessionRef: confirmation.sessionRef, mode: check.mode, conditions: check.conditions };
  }
  const before = await readKnownFailingRow(ports.store, orgId, item.project);
  if (before === undefined) return "not_ready";
  const nowIso = new Date(ports.store.now()).toISOString();
  const added: KnownFailingMark[] = record.tests.map((test) => ({ name: test.name, checkId: test.checkId, markedBy: caller.developerId, markedAt: nowIso, epoch: record.epoch }));
  // Throws the limit's own refusal ("This project's known-failing list is full (500)...").
  const next = nextKnownFailing(before, added);
  const event = await tryAuditEvent(ports.store, () => auditProjectKnownFailingMarked({
    orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: nowIso, occurrence: requestId, projectName: item.project, cause: record.cause, testCount: next.length - before.marks.length,
    recordEpoch: record.epoch, taskCount: record.taskCount, taskIdsSha256: hashOf([...record.taskIds].sort()),
    testSetSha256, rowVersionAfter: before.version + 1, totalAfter: next.length,
    approvalMode: second === undefined ? "single" : second.mode, secondPersonWhy: needed.why,
    // Who the second person was and how they proved it: their id and the fresh sign-in proof (their session, hashed).
    ...(second === undefined ? {} : { related: [second.approverId], proof: { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date(second.signedInAtMs).toISOString(), sessionRef: second.sessionRef } }),
  }));
  const done = await send(ports.store, [
    knownFailingWrite(ports.store, orgId, item.project, before, next, nowIso),
    closeItem(ports.store, orgId, item.project, record, "known_failing", caller.developerId, nowIso),
    // Both people's live authority, pinned to the moment of commit.
    ...(second === undefined ? [] : second.conditions),
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
