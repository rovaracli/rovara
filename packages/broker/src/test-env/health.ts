// Setup and test health SH28 (design setup-test-health.md, section 6.2): the project's health, set by the nightly run and by tasks that were blocked by the environment. Behind the `nh` switch (off by default).
//
// The states, and what each night (SH27/SH6 class) does to them:
//   unknown       nothing has set the health yet (only tasks blocked fewer than 3 times have been seen). Never shown as healthy.
//   healthy       a passing night, or a newly proved setup. Open Fix setup cards for the project are closed.
//   needs_repair  "Setup needs repair": a night whose SETUP (not its tests) failed, or 3 tasks blocked by the same environment cause within 24 hours. A Fix setup card goes to the maintainers (one per project per
//                 cause; later tasks join it). New tasks STILL START (owner decision 7): they only get a banner, "testing may be blocked". Nothing in this file can refuse or pause a start.
//   tests_failing a night that ran with assertion failures next to passes. When the night PROVES the setup works (`setupProved`: a check ran, the code was put in place, both test steps ran), an earlier repair state
//                 ends and its card closes (owner decision 2026-11-02, replacing design 6.2's "only a passing nightly"); the failing tests are the already-failing set (nightly.ts). A thin night (no evidence the
//                 setup works) leaves a repair state and its cards as they are. If the project turned on `nightly.proposeFixTask` (OFF by default), ONE proposed task is open per project, for the newest set of
//                 failing tests, never started on its own.
//   not_sure      an unclear night ("Rovara isn't sure"). It never clears a repair state and never closes a card: only a passing night, a night that shows the setup works, or a newly proved setup does.
// A night that carries no step words (an older worker) changes nothing.
//
// Data: one item per project (`TESTENV#HEALTH`) holding the state and the small bounded facts it needs (the recent blocked tasks, the failing set's key and first day), written with a version check
// and re-tried when two events meet. The Fix setup card and the proposed task are PORTS: SH17 (the Fix setup card, lane sh-results-wire) and the proposed-task store are wired to them by the controller. Each port
// call is repeatable (it is keyed by the cause or by the set) and is made AFTER the state is stored, from the state itself, so a retry of a failed call does the same thing.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, NIGHTLY_FAILED_MAX, agentXError, canonicalJson, projectAllows, projectPk, type OrgId, type ProjectRole, type StoredNightlyHealth, type TestingBlockedReason } from "@agentx/contracts";
import { z } from "zod";
import { auditOccurrence, auditProjectTestHealthSettingChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent } from "../audit/outbox.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import { nightlyHealthEnabled } from "./health-switch.js";
import type { NightlyRecorded } from "./nightly.js";
import { testEnvironmentEnabled } from "./switch.js";

/** `unknown`: nothing has told the health yet (only a task blocked once or twice has been seen). It is never shown as healthy. */
export const PROJECT_HEALTH_STATES = ["unknown", "healthy", "needs_repair", "tests_failing", "not_sure"] as const;
export type ProjectHealthState = (typeof PROJECT_HEALTH_STATES)[number];

const HOUR_MS = 3_600_000;
/** Blocked tasks older than this no longer count. */
export const BLOCKED_WINDOW_MS = 24 * HOUR_MS;
/** This many tasks blocked by the same cause inside the window set "Setup needs repair". */
export const BLOCKED_TASKS_FOR_REPAIR = 3;
const BLOCKED_KEPT_MAX = 20;
const PROPOSED_TEST_IDS_MAX = 20;
const WRITE_ATTEMPTS = 4;
/** The request ids of a project's setting changes that are remembered, so a replay of any of them is recognised. */
const SETTING_REQUESTS_KEPT = 20;
/** The health item expires this long after it was last written, so a project nobody checks any more does not keep a repair state for ever. A nightly run writes it at least every few days. */
const HEALTH_TTL_MS = 60 * 24 * HOUR_MS;

/**
 * Whether a "Blocked by environment" reason counts toward "3 tasks, same cause" (design 6.2). Only reasons that point at the project's setup count. A busy runner, a provider outage, a renewed or expired test
 * machine, a failed executor, and a test that also fails on the original code (which has its own "Mark as known failing") are the platform's or one test's, not the setup's. Exhaustive on purpose: a new reason
 * does not compile until someone decides.
 */
export const BLOCKED_REASON_POINTS_AT_SETUP: Readonly<Record<TestingBlockedReason, boolean>> = {
  check_could_not_start: true, check_runner_failed: true, check_command_broken: true, timed_out: true, executor_failed: false, mock_unavailable: true, provider_outage: false, runner_busy: false,
  test_machine_renewed: false, test_machine_expired: false, test_machine_unusable: true, test_machine_drifted: true, login_failed: true, setup_changed_files: true, leftover_processes: true,
  fails_on_original_code: false, setup_failed_in_task: true, host_blocked: true, build_host_offline: true,
};

const Cause = z.string().regex(/^[a-z_]{1,40}$/u);
const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/u);
const Iso = z.string().datetime();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ProjectHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Counts writes; a write names the version it read. */
    version: z.number().int().min(1),
    state: z.enum(PROJECT_HEALTH_STATES),
    /** A fixed word: a nightly cause (`setup_failed`, ...) or a blocked reason (`host_blocked`, ...). Present with `needs_repair` and `not_sure`. */
    cause: Cause.optional(),
    source: z.enum(["nightly", "tasks", "setup_proved"]),
    /** When the state last changed. */
    since: Iso,
    updatedAt: Iso,
    /** The last night read. `recordedAt` is the BROKER's clock when it recorded the night, and is what orders nights; `finishedAt` is the worker's word, shown only. */
    lastNightly: z.object({ slotId: Sha256, finishedAt: Iso, recordedAt: Iso, headSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().optional(),
    /** Recent tasks blocked by a setup cause, newest last. */
    blocked: z.array(z.object({ taskId: TaskId, cause: Cause, at: Iso }).strict()).max(BLOCKED_KEPT_MAX),
    /** The current set of failing tests (a hash of their ids), the day it first failed, and how many. */
    failingSet: z.object({ key: Sha256, count: z.number().int().min(1).max(NIGHTLY_FAILED_MAX), sinceDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict().optional(),
  })
  .strict();
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

// ---- ports (what SH17 and the proposed-task store give)

export interface FixSetupCardPort {
  /** Opens the project's Fix setup card for this cause, or joins the open one (later tasks join it). Repeating the same call changes nothing. */
  openOrJoin(input: { orgId: OrgId; project: string; cause: string; source: "nightly" | "tasks"; taskIds: readonly string[]; /** The stored health version this call comes from. The card keeps the highest it has seen and refuses an older one (a late call can no longer undo a newer one). */ version: number }): Promise<void>;
  /** Closes the project's open Fix setup cards: the setup is working again. */
  resolve(input: { orgId: OrgId; project: string; reason: "nightly_passed" | "nightly_setup_ok" | "setup_proved"; /** As for `openOrJoin`. */ version: number }): Promise<void>;
}

/**
 * The port that does nothing. `healthPortsOf` (health-wiring.ts) now builds the real one, over SH17's records (`healthFixSetupCards`, test-env/fix-setup-health.ts); this stays for tests that want no card.
 */
export const FIX_SETUP_CARDS_PENDING_SH17: FixSetupCardPort = { openOrJoin: () => Promise.resolve(), resolve: () => Promise.resolve() };

export interface ProposedFixTaskPort {
  /**
   * Makes one PROPOSED task (never started on its own). `key` names the set of failing tests. REQUIREMENT: the port dedupes DURABLY by `key`: while the key is stored (open or dismissed, until it expires) a
   * repeated call changes nothing. The health logic calls it on every night that has the set, because it keeps no memory of what it proposed; a port that forgets would propose again. `testIds` and `title` are
   * DATA: whatever builds a task from a proposal must never put them into an instruction as if they were text to follow.
   */
  propose(input: { orgId: OrgId; project: string; key: string; title: string; failingCount: number; testIds: readonly string[] }): Promise<void>;
}

export interface HealthPorts { cards: FixSetupCardPort; proposals: ProposedFixTaskPort }

// ---- storage

/** What a read needs: the table and the clock (no audit). */
export type ReadDeps = Pick<TestEnvDeps, "documentClient" | "tableName" | "now">;

const keyOf = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const HEALTH_SK = "TESTENV#HEALTH";
const SETTINGS_SK = "TESTENV#HEALTH#SETTINGS";
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const iso = (ms: number): string => new Date(ms).toISOString();

type Stored =
  | { kind: "none" }
  | { kind: "ok"; health: ProjectHealth }
  /** The item is there but is not a health of this version. `rawVersion` is its own write counter when it has a sane one; `rawCounter` is whatever its `version` attribute holds, of any type (undefined: it has none), so the replacing write can be conditioned on it exactly. */
  | { kind: "unreadable"; rawVersion: number | undefined; rawCounter: unknown }
  /** Written by a newer release (schemaVersion above 1): this release leaves it alone. */
  | { kind: "newer" };

async function readStored(deps: ReadDeps, orgId: OrgId, project: string): Promise<Stored> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, HEALTH_SK), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return { kind: "none" };
  const written = item.health as { schemaVersion?: unknown } | null | undefined;
  if (typeof written?.schemaVersion === "number" && written.schemaVersion > 1) return { kind: "newer" };
  const parsed = ProjectHealthSchema.safeParse(item.health);
  if (parsed.success) return { kind: "ok", health: parsed.data };
  return { kind: "unreadable", rawVersion: typeof item.version === "number" && Number.isInteger(item.version) && item.version >= 0 && item.version < 1_000_000_000 ? item.version : undefined, rawCounter: item.version };
}

/** The project's stored health, or undefined when none was ever recorded. A stored item this release cannot read is an error: damaged health is never "no health" and never "healthy". */
export async function readProjectHealth(deps: ReadDeps, orgId: OrgId, project: string): Promise<ProjectHealth | undefined> {
  const stored = await readStored(deps, orgId, project);
  if (stored.kind === "none") return undefined;
  if (stored.kind !== "ok") throw agentXError("RUNTIME_UNAVAILABLE", "the project health could not be read");
  return stored.health;
}

/** What a plan wants done once its state is stored. Every effect is repeatable. */
type Effect =
  | { kind: "open_card"; cause: string; source: "nightly" | "tasks"; taskIds: readonly string[] }
  | { kind: "resolve_cards"; reason: "nightly_passed" | "nightly_setup_ok" | "setup_proved" }
  | { kind: "propose"; key: string; title: string; failingCount: number; testIds: readonly string[] };
interface Plan { next: ProjectHealth; effects: Effect[] }

const logHealth = (event: string, orgId: OrgId, project: string): void => { console.log(JSON.stringify({ component: "broker", level: "warn", event, orgId, project })); };

/** The card effects that say the project needs repair, from the state itself (so a retry after a failed effect does the same thing). */
function repairCardOf(next: ProjectHealth): Effect {
  const tasks = next.source === "tasks";
  return { kind: "open_card", cause: next.cause ?? "other", source: tasks ? "tasks" : "nightly", taskIds: tasks ? next.blocked.filter((entry) => entry.cause === next.cause).map((entry) => entry.taskId) : [] };
}

/**
 * Runs the effects of a plan AFTER its state is stored, so a write that lost to another can never leave a card behind. Before a card effect the stored state is read again: if another event has written since,
 * an effect that contradicts it (opening a card for a project that no longer needs repair, closing cards for one that does) is skipped, and that event's own effects stand. The window between this read and the
 * port call is the port's to close; it is a single read wide.
 */
async function runEffects(deps: ReadDeps, ports: HealthPorts, orgId: OrgId, project: string, next: ProjectHealth, effects: readonly Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "propose") {
      await ports.proposals.propose({ orgId, project, key: effect.key, title: effect.title, failingCount: effect.failingCount, testIds: effect.testIds });
      continue;
    }
    const current = await readStored(deps, orgId, project);
    if (current.kind === "ok" && current.health.version !== next.version) {
      const repairing = current.health.state === "needs_repair";
      if (effect.kind === "open_card" ? !repairing : repairing) continue;
    }
    if (effect.kind === "open_card") await ports.cards.openOrJoin({ orgId, project, cause: effect.cause, source: effect.source, taskIds: effect.taskIds, version: next.version });
    else await ports.cards.resolve({ orgId, project, reason: effect.reason, version: next.version });
  }
}

/**
 * Runs `plan` against the stored state and writes the result with a version check, then runs the plan's effects. A write that meets another write starts again from what is stored now.
 *   - an item this release cannot read (damaged, schemaVersion 1): it is replaced by a Put conditioned on its raw version, and the plan starts from NOTHING: a blocked-task tally is never built on damaged data;
 *   - an item from a newer release: logged and left alone, nothing is written.
 */
async function applyPlan(deps: TestEnvDeps, ports: HealthPorts, orgId: OrgId, project: string, plan: (previous: ProjectHealth | undefined, now: number) => Plan | undefined): Promise<ProjectHealth | undefined> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const stored = await readStored(deps, orgId, project);
    if (stored.kind === "newer") { logHealth("project_health.newer_schema_skipped", orgId, project); return undefined; }
    if (stored.kind === "unreadable") logHealth("project_health.unreadable_replaced", orgId, project);
    const previous = stored.kind === "ok" ? stored.health : undefined;
    const now = deps.now();
    const planned = plan(previous, now);
    if (planned === undefined) return previous;
    const baseVersion = stored.kind === "ok" ? stored.health.version : stored.kind === "unreadable" ? (stored.rawVersion ?? 0) : 0;
    const next = ProjectHealthSchema.parse({ ...planned.next, version: baseVersion + 1, updatedAt: iso(now) });
    let condition: { ConditionExpression: string; ExpressionAttributeValues?: Record<string, unknown> };
    if (stored.kind === "none") condition = { ConditionExpression: "attribute_not_exists(pk)" };
    else if (stored.kind === "ok") condition = { ConditionExpression: "version = :version", ExpressionAttributeValues: { ":version": stored.health.version } };
    // Whatever the damaged counter holds (a string, a fraction, a negative or huge number), the replacing write is conditioned on exactly that value, so it can never jam on it.
    else if (stored.rawCounter !== undefined) condition = { ConditionExpression: "version = :version", ExpressionAttributeValues: { ":version": stored.rawCounter } };
    else condition = { ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(version)" };
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...keyOf(orgId, project, HEALTH_SK), entityType: "TEST_ENV_HEALTH", orgId, project, version: next.version, health: next, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + HEALTH_TTL_MS) / 1000) },
        ...condition,
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      continue;
    }
    await runEffects(deps, ports, orgId, project, next, planned.effects);
    return next;
  }
  throw agentXError("CHANGE_STALE", "the project health changed while it was being updated");
}

const blank = (now: number, over: Partial<ProjectHealth> & Pick<ProjectHealth, "state" | "source">): ProjectHealth => ({ schemaVersion: 1, version: 1, since: iso(now), updatedAt: iso(now), blocked: [], ...over });

// ---- the project's setting: proposed fix tasks (off by default)

/** `nightly.proposeFixTask`: whether a night with failing tests makes one proposed task. Off unless a maintainer turned it on; an unreadable setting is off. */
export async function readProposeFixTask(deps: ReadDeps, orgId: OrgId, project: string): Promise<boolean> {
  try {
    const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, SETTINGS_SK), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    return item?.proposeFixTask === true;
  } catch {
    return false;
  }
}

/**
 * Turns `nightly.proposeFixTask` on or off. Needs `edit_settings` (a project maintainer). The change and its audit event commit together; the same `requestId` again changes nothing more (the event is deduplicated
 * by it). The event names the setting and whether it is on: no ids, no text.
 */
export async function setProposeFixTask(deps: TestEnvDeps, input: { orgId: OrgId; project: string; role: ProjectRole | undefined; changedBy: string; enabled: boolean; requestId: string }): Promise<{ proposeFixTask: boolean }> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change whether failing tests propose a fix task");
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) throw agentXError("CONFIG_INVALID", "requestId: a request id of 8 to 64 letters, digits, - or _");
  const enabled = input.enabled === true;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(input.orgId, input.project, SETTINGS_SK), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    const seen = Array.isArray(stored?.requestIds) ? stored.requestIds.filter((id): id is string => typeof id === "string") : [];
    // A request id already applied is a replay, whatever came after it: on(X), off(Y), on(X) leaves it off, writes nothing and audits nothing.
    if (seen.includes(input.requestId)) return { proposeFixTask: stored?.proposeFixTask === true };
    const at = iso(deps.now());
    const event = await tryAuditEvent(deps, () => auditProjectTestHealthSettingChanged({
      orgId: input.orgId, actor: { kind: "member", id: input.changedBy }, occurredAt: at, occurrence: auditOccurrence(input.project, input.requestId, String(enabled)), projectName: input.project, setting: "propose_fix_task", enabled,
    }));
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: {
                ...keyOf(input.orgId, input.project, SETTINGS_SK), entityType: "TEST_ENV_HEALTH_SETTINGS", orgId: input.orgId, project: input.project, proposeFixTask: enabled, changedBy: input.changedBy, changedAt: at,
                lastRequestId: input.requestId, requestIds: [...seen, input.requestId].slice(-SETTING_REQUESTS_KEPT),
              },
              // Written only if no other change landed since it was read.
              ...(stored === undefined
                ? { ConditionExpression: "attribute_not_exists(pk)" }
                : typeof stored.lastRequestId === "string"
                  ? { ConditionExpression: "lastRequestId = :last", ExpressionAttributeValues: { ":last": stored.lastRequestId } }
                  : { ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(lastRequestId)" }),
            },
          },
          ...(event === undefined ? [] : auditPending(deps, event)),
        ],
      }));
    } catch (error) {
      if (errorName(error) === "TransactionCanceledException") continue;
      throw error;
    }
    if (event !== undefined) await flushAuditEvents(deps, [event]);
    return { proposeFixTask: enabled };
  }
  throw agentXError("CHANGE_STALE", "the setting changed while it was being updated; try again");
}

// ---- events

export const failingSetKey = (testIds: readonly string[]): string => createHash("sha256").update(canonicalJson([...new Set(testIds)].sort())).digest("hex");
const safeBranch = (branch: string): string => (/^[A-Za-z0-9._/-]{1,60}$/u.test(branch) ? branch : "the default branch");
/** Fixed words, a count, a plain branch name and a day. Test ids never go into it. */
const proposalTitle = (count: number, branch: string, sinceDay: string): string => `${count} ${count === 1 ? "test" : "tests"} failing on ${safeBranch(branch)} since ${sinceDay}`;

/**
 * A night was recorded (bind this to `recordNightlyResult`'s listener with `nightlyHealthListener`). See the file header for what each class does. Nights are ordered by the BROKER's clock (`recordedAt`); a night
 * recorded before the one on record changes nothing. The card and the proposed task are done after the state is stored and follow from the state, so the worker's retry of a failed attempt does them again.
 */
export async function applyNightlyRecorded(deps: TestEnvDeps, ports: HealthPorts, event: NightlyRecorded, options: { proposeFixTask: boolean }): Promise<ProjectHealth | undefined> {
  const night: StoredNightlyHealth | undefined = event.health;
  if (night === undefined) return undefined;
  const { orgId, project } = event;
  const lastNightly = { slotId: event.slotId, finishedAt: event.baseline.finishedAt, recordedAt: event.baseline.recordedAt, headSha: event.baseline.headSha };
  return applyPlan(deps, ports, orgId, project, (previous, now) => {
    if (previous?.lastNightly !== undefined && Date.parse(previous.lastNightly.recordedAt) > Date.parse(lastNightly.recordedAt)) return undefined;
    const blocked = previous?.blocked ?? [];
    const changed = (state: ProjectHealthState, cause: string | undefined): string => (previous?.state === state && previous.cause === cause ? previous.since : iso(now));
    // The set of failing tests carries through nights that say nothing about it, so the day it started does not reset.
    const carried = previous?.failingSet === undefined ? {} : { failingSet: previous.failingSet };
    switch (night.class) {
      case "passed":
        return { next: blank(now, { state: "healthy", source: "nightly", since: changed("healthy", undefined), lastNightly }), effects: [{ kind: "resolve_cards", reason: "nightly_passed" }] };
      case "environment": {
        const cause = night.cause ?? "other";
        const next = blank(now, { state: "needs_repair", cause, source: "nightly", since: changed("needs_repair", cause), lastNightly, blocked, ...carried });
        return { next, effects: [repairCardOf(next)] };
      }
      case "tests": {
        // The set can be named only when it fit whole (the same test the already-failing set uses): a truncated set is never proposed.
        const { baseline } = event;
        const nameable = baseline.tests.failed > 0 && baseline.tests.failed <= NIGHTLY_FAILED_MAX && baseline.failed.length === baseline.tests.failed;
        let failingSet: ProjectHealth["failingSet"];
        const effects: Effect[] = [];
        if (nameable) {
          const key = failingSetKey(baseline.failed);
          failingSet = { key, count: baseline.failed.length, sinceDay: previous?.failingSet?.key === key ? previous.failingSet.sinceDay : iso(Date.parse(baseline.finishedAt)).slice(0, 10) };
          // Asked on every night that has the set: the store keeps what it already has (the port's requirement), the health keeps no memory of it.
          if (options.proposeFixTask) effects.push({ kind: "propose", key, title: proposalTitle(failingSet.count, baseline.branch, failingSet.sinceDay), failingCount: failingSet.count, testIds: baseline.failed.slice(0, PROPOSED_TEST_IDS_MAX) });
        }
        const setupProved = night.setupProved === true;
        // A repair state ends only on a night that PROVES the setup works (every setup step ran and passed, a check ran, both test steps ran). A thin night with failing tests leaves it, and its cards, as they are.
        if (previous?.state === "needs_repair" && !setupProved) {
          const next: ProjectHealth = { ...previous, lastNightly, ...(failingSet === undefined ? {} : { failingSet }) };
          return { next, effects: [repairCardOf(next), ...effects] };
        }
        if (setupProved) effects.unshift({ kind: "resolve_cards", reason: "nightly_setup_ok" });
        return { next: blank(now, { state: "tests_failing", source: "nightly", since: changed("tests_failing", undefined), lastNightly, ...(failingSet === undefined ? {} : { failingSet }) }), effects };
      }
      case "unclear": {
        // Never clears a repair state and never closes a card. A project that was fine, or failing tests, is "not sure"; one that needs repair stays so.
        if (previous?.state === "needs_repair") {
          const next: ProjectHealth = { ...previous, lastNightly };
          return { next, effects: [repairCardOf(next)] };
        }
        const cause = night.cause ?? "other";
        return { next: blank(now, { state: "not_sure", cause, source: "nightly", since: changed("not_sure", cause), lastNightly, blocked, ...carried }), effects: [] };
      }
    }
  });
}

/**
 * A task ended "Blocked by environment" (design 6.2: 3 tasks in 24 hours with the same cause set "Setup needs repair"). Only reasons that point at the setup count (`BLOCKED_REASON_POINTS_AT_SETUP`); any
 * other reason changes nothing. A task counts once per cause. When the project already needs repair for this cause, the task joins the open card. A caller retries an error from this: the state may be stored
 * and the card not yet opened, and a repeat does the card again.
 */
export async function noteBlockedTask(deps: TestEnvDeps, ports: HealthPorts, input: { orgId: OrgId; project: string; taskId: string; reason: TestingBlockedReason }): Promise<ProjectHealth | undefined> {
  const taskId = TaskId.safeParse(input.taskId);
  if (!taskId.success || BLOCKED_REASON_POINTS_AT_SETUP[input.reason] !== true) return undefined;
  const { orgId, project } = input;
  const cause = input.reason;
  return applyPlan(deps, ports, orgId, project, (previous, now) => {
    const recent = (previous?.blocked ?? []).filter((entry) => now - Date.parse(entry.at) < BLOCKED_WINDOW_MS && !(entry.taskId === taskId.data && entry.cause === cause));
    const blocked = [...recent, { taskId: taskId.data, cause, at: iso(now) }].slice(-BLOCKED_KEPT_MAX);
    const same = blocked.filter((entry) => entry.cause === cause);
    const carried = { ...(previous?.lastNightly === undefined ? {} : { lastNightly: previous.lastNightly }), ...(previous?.failingSet === undefined ? {} : { failingSet: previous.failingSet }) };
    if (same.length >= BLOCKED_TASKS_FOR_REPAIR) {
      const repairing = previous?.state === "needs_repair" ? previous : undefined;
      // An earlier cause (the night's, which names the step) stays the project's cause; this one has its own card.
      const next = blank(now, { state: "needs_repair", source: repairing?.source ?? "tasks", cause: repairing?.cause ?? cause, since: repairing?.since ?? iso(now), blocked, ...carried });
      return { next, effects: [{ kind: "open_card", cause, source: "tasks", taskIds: same.map((entry) => entry.taskId) }] };
    }
    // Fewer than three: the state does not move. A task blocked for the cause the project already needs repair for joins that card.
    const joins = previous?.state === "needs_repair" && previous.cause === cause;
    return {
      next: previous === undefined ? blank(now, { state: "unknown", source: "tasks", blocked }) : { ...previous, blocked },
      effects: joins ? [{ kind: "open_card", cause, source: "tasks", taskIds: [taskId.data] }] : [],
    };
  });
}

/** A repeat of the same approval within this long closes the cards again (the first attempt may have stored the state and failed on the card). */
const PROVED_REPLAY_MS = 10 * 60_000;

/** A setup was newly proved (a new approved environment revision). A project that needs repair is healthy again and its cards close; the blocked tasks before it no longer count. Anything else is left as it is. */
export async function noteSetupProved(deps: TestEnvDeps, ports: HealthPorts, input: { orgId: OrgId; project: string }): Promise<ProjectHealth | undefined> {
  const { orgId, project } = input;
  return applyPlan(deps, ports, orgId, project, (previous, now) => {
    if (previous === undefined) return undefined;
    if (previous.state === "healthy" && previous.source === "setup_proved" && now - Date.parse(previous.since) < PROVED_REPLAY_MS) return { next: previous, effects: [{ kind: "resolve_cards", reason: "setup_proved" }] };
    if (previous.state !== "needs_repair") return previous.blocked.length === 0 ? undefined : { next: { ...previous, blocked: [] }, effects: [] };
    return {
      next: blank(now, { state: "healthy", source: "setup_proved", ...(previous.lastNightly === undefined ? {} : { lastNightly: previous.lastNightly }), ...(previous.failingSet === undefined ? {} : { failingSet: previous.failingSet }) }),
      effects: [{ kind: "resolve_cards", reason: "setup_proved" }],
    };
  });
}

// ---- what people see

export interface TaskStartNotice {
  /** Always true: "Setup needs repair" never pauses a start (owner decision 7). */
  allowed: true;
  /** Shown on the new task and the start screen when the project needs repair. */
  banner?: { text: string; state: "needs_repair" };
}

export const TESTING_MAY_BE_BLOCKED_TEXT = "Testing may be blocked: this project's setup needs repair. The task will still start.";

/**
 * What a new task start shows for the project's health. It never refuses: the answer is always `allowed`, with a banner while the project needs repair. Off (`nh`), unreadable or no health: no banner.
 */
export async function taskStartNotice(deps: ReadDeps, orgId: OrgId, project: string, env: NodeJS.ProcessEnv = process.env): Promise<TaskStartNotice> {
  if (!nightlyHealthEnabled(env) || !testEnvironmentEnabled(env)) return { allowed: true };
  const health = await readProjectHealth(deps, orgId, project).catch(() => undefined);
  return health?.state === "needs_repair" ? { allowed: true, banner: { text: TESTING_MAY_BE_BLOCKED_TEXT, state: "needs_repair" } } : { allowed: true };
}

/**
 * The listener for `recordNightlyResult` (its fourth argument). Undefined while the switch is off (or the test environment is), so the record path is exactly today's; the setting is read at the time of the night.
 */
export function nightlyHealthListener(deps: TestEnvDeps, ports: HealthPorts, env: NodeJS.ProcessEnv = process.env): ((event: NightlyRecorded) => Promise<void>) | undefined {
  if (!nightlyHealthEnabled(env) || !testEnvironmentEnabled(env)) return undefined;
  return async (event) => {
    const proposeFixTask = await readProposeFixTask(deps, event.orgId, event.project);
    await applyNightlyRecorded(deps, ports, event, { proposeFixTask });
  };
}
