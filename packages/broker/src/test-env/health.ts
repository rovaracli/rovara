// Setup and test health SH28 (design setup-test-health.md, section 6.2): the project's health, set by the nightly run and by tasks that were blocked by the environment. Behind the `nh` switch (off by default).
//
// The states, and what each night (SH27/SH6 class) does to them:
//   unknown       nothing has set the health yet (only tasks blocked fewer than 3 times have been seen). Never shown as healthy.
//   healthy       a passing night, or a newly proved setup. Open Fix setup cards for the project are closed.
//   needs_repair  "Setup needs repair": a night whose SETUP (not its tests) failed, or 3 tasks blocked by the same environment cause within 24 hours. A Fix setup card goes to the maintainers (one per project per
//                 cause; later tasks join it). New tasks STILL START (owner decision 7): they only get a banner, "testing may be blocked". Nothing in this file can refuse or pause a start.
//   tests_failing a night that ran and had assertion failures next to passes. The environment works (the setup steps passed, the tests ran), so an earlier repair state ends and its card closes; the failing tests are the
//                 already-failing set (nightly.ts). If the project turned on `nightly.proposeFixTask` (OFF by default), ONE proposed task is made per new set of failing tests, never started on its own.
//   not_sure      an unclear night ("Rovara isn't sure"). It never clears a repair state and never closes a card: only a passing night, a night that shows the setup works, or a newly proved setup does.
// A night that carries no step words (an older worker) changes nothing.
//
// Data: one item per project (`TESTENV#HEALTH`) holding the state and the small bounded facts it needs (the recent blocked tasks, the failing set's key, the keys already proposed), written with a version check
// and re-tried when two events meet. The Fix setup card and the proposed task are PORTS: SH17 (the Fix setup card, lane sh-results-wire) and the proposed-task store are wired to them by the controller. Each port
// call is repeatable (it is keyed by the cause or by the set), because a failed write is retried from the start.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { NIGHTLY_FAILED_MAX, agentXError, canonicalJson, projectAllows, projectPk, type OrgId, type ProjectRole, type StoredNightlyHealth, type TestingBlockedReason } from "@agentx/contracts";
import { z } from "zod";
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
const PROPOSED_KEYS_KEPT = 5;
const PROPOSED_TEST_IDS_MAX = 20;
const WRITE_ATTEMPTS = 4;

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
    lastNightly: z.object({ slotId: Sha256, finishedAt: Iso, headSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict().optional(),
    /** Recent tasks blocked by a setup cause, newest last. */
    blocked: z.array(z.object({ taskId: TaskId, cause: Cause, at: Iso }).strict()).max(BLOCKED_KEPT_MAX),
    /** The current set of failing tests (a hash of their ids), the day it first failed, and how many. */
    failingSet: z.object({ key: Sha256, count: z.number().int().min(1).max(NIGHTLY_FAILED_MAX), sinceDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict().optional(),
    /** The sets a task was proposed for, newest last. */
    proposedKeys: z.array(Sha256).max(PROPOSED_KEYS_KEPT),
  })
  .strict();
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

// ---- ports (what SH17 and the proposed-task store give)

export interface FixSetupCardPort {
  /** Opens the project's Fix setup card for this cause, or joins the open one (later tasks join it). Repeating the same call changes nothing. */
  openOrJoin(input: { orgId: OrgId; project: string; cause: string; source: "nightly" | "tasks"; taskIds: readonly string[] }): Promise<void>;
  /** Closes the project's open Fix setup cards: the setup is working again. */
  resolve(input: { orgId: OrgId; project: string; reason: "nightly_passed" | "nightly_setup_ok" | "setup_proved" }): Promise<void>;
}

export interface ProposedFixTaskPort {
  /** Makes one PROPOSED task (never started on its own). `key` names the set of failing tests: the same key is the same proposal, so repeating the call makes no second one. */
  propose(input: { orgId: OrgId; project: string; key: string; title: string; failingCount: number; testIds: readonly string[] }): Promise<void>;
}

export interface HealthPorts { cards: FixSetupCardPort; proposals: ProposedFixTaskPort }

// ---- storage

const keyOf = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const HEALTH_SK = "TESTENV#HEALTH";
const SETTINGS_SK = "TESTENV#HEALTH#SETTINGS";
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const iso = (ms: number): string => new Date(ms).toISOString();

/** The project's stored health, or undefined when none was ever recorded. A stored item that does not read back is an error: damaged health is never "no health" and never "healthy". */
export async function readProjectHealth(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<ProjectHealth | undefined> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, HEALTH_SK), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return undefined;
  const parsed = ProjectHealthSchema.safeParse(item.health);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the project health could not be read");
  return parsed.data;
}

type Effect = () => Promise<void>;
interface Plan { next: ProjectHealth; effects: Effect[] }

/** Runs `plan` against the current state: its effects first (each is repeatable), then the state with a version check. A write that meets another write starts again from what is stored now. */
async function applyPlan(deps: TestEnvDeps, orgId: OrgId, project: string, plan: (previous: ProjectHealth | undefined, now: number) => Plan | undefined): Promise<ProjectHealth | undefined> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const previous = await readProjectHealth(deps, orgId, project);
    const now = deps.now();
    const planned = plan(previous, now);
    if (planned === undefined) return previous;
    for (const effect of planned.effects) await effect();
    const next = ProjectHealthSchema.parse({ ...planned.next, version: (previous?.version ?? 0) + 1, updatedAt: iso(now) });
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...keyOf(orgId, project, HEALTH_SK), entityType: "TEST_ENV_HEALTH", orgId, project, version: next.version, health: next },
        ConditionExpression: previous === undefined ? "attribute_not_exists(pk)" : "version = :version",
        ...(previous === undefined ? {} : { ExpressionAttributeValues: { ":version": previous.version } }),
      }));
      return next;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw agentXError("CHANGE_STALE", "the project health changed while it was being updated");
}

const blank = (now: number, over: Partial<ProjectHealth> & Pick<ProjectHealth, "state" | "source">): ProjectHealth => ({ schemaVersion: 1, version: 1, since: iso(now), updatedAt: iso(now), blocked: [], proposedKeys: [], ...over });

// ---- the project's setting: proposed fix tasks (off by default)

/** `nightly.proposeFixTask`: whether a night with failing tests makes one proposed task. Off unless a maintainer turned it on; an unreadable setting is off. */
export async function readProposeFixTask(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<boolean> {
  try {
    const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, SETTINGS_SK), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    return item?.proposeFixTask === true;
  } catch {
    return false;
  }
}

/** Turns `nightly.proposeFixTask` on or off. Needs `edit_settings` (a project maintainer). */
export async function setProposeFixTask(deps: TestEnvDeps, input: { orgId: OrgId; project: string; role: ProjectRole | undefined; changedBy: string; enabled: boolean }): Promise<{ proposeFixTask: boolean }> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change whether failing tests propose a fix task");
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...keyOf(input.orgId, input.project, SETTINGS_SK), entityType: "TEST_ENV_HEALTH_SETTINGS", orgId: input.orgId, project: input.project, proposeFixTask: input.enabled === true, changedBy: input.changedBy, changedAt: iso(deps.now()) },
  }));
  return { proposeFixTask: input.enabled === true };
}

// ---- events

export const failingSetKey = (testIds: readonly string[]): string => createHash("sha256").update(canonicalJson([...new Set(testIds)].sort())).digest("hex");
const safeBranch = (branch: string): string => (/^[A-Za-z0-9._/-]{1,60}$/u.test(branch) ? branch : "the default branch");
const proposalTitle = (count: number, branch: string, sinceDay: string): string => `${count} ${count === 1 ? "test" : "tests"} failing on ${safeBranch(branch)} since ${sinceDay}`;

/**
 * A night was recorded (bind this to `recordNightlyResult`'s listener with `nightlyHealthListener`). See the file header for what each class does. A night older than the one on record changes nothing. The effects
 * (the card, the proposed task) are repeatable, so a failed attempt is simply run again by the worker's retry.
 */
export async function applyNightlyRecorded(deps: TestEnvDeps, ports: HealthPorts, event: NightlyRecorded, options: { proposeFixTask: boolean }): Promise<ProjectHealth | undefined> {
  const night: StoredNightlyHealth | undefined = event.health;
  if (night === undefined) return undefined;
  const { orgId, project } = event;
  const lastNightly = { slotId: event.slotId, finishedAt: event.baseline.finishedAt, headSha: event.baseline.headSha };
  return applyPlan(deps, orgId, project, (previous, now) => {
    if (previous?.lastNightly !== undefined && Date.parse(previous.lastNightly.finishedAt) > Date.parse(lastNightly.finishedAt)) return undefined;
    const keep = { lastNightly, blocked: previous?.blocked ?? [], proposedKeys: previous?.proposedKeys ?? [] };
    const changed = (state: ProjectHealthState, cause: string | undefined): string => (previous?.state === state && previous.cause === cause ? previous.since : iso(now));
    switch (night.class) {
      case "passed":
        return {
          next: blank(now, { state: "healthy", source: "nightly", since: changed("healthy", undefined), lastNightly, proposedKeys: keep.proposedKeys }),
          effects: [() => ports.cards.resolve({ orgId, project, reason: "nightly_passed" })],
        };
      case "environment": {
        const cause = night.cause ?? "other";
        return {
          next: blank(now, { state: "needs_repair", cause, source: "nightly", since: changed("needs_repair", cause), lastNightly, proposedKeys: keep.proposedKeys, blocked: keep.blocked }),
          effects: [() => ports.cards.openOrJoin({ orgId, project, cause, source: "nightly", taskIds: [] })],
        };
      }
      case "tests": {
        const effects: Effect[] = [() => ports.cards.resolve({ orgId, project, reason: "nightly_setup_ok" })];
        // The set can be named only when it fit whole (the same test the already-failing set uses): a truncated set is never proposed.
        const { baseline } = event;
        const nameable = baseline.tests.failed > 0 && baseline.tests.failed <= NIGHTLY_FAILED_MAX && baseline.failed.length === baseline.tests.failed;
        let failingSet: ProjectHealth["failingSet"];
        let proposedKeys = keep.proposedKeys;
        if (nameable) {
          const key = failingSetKey(baseline.failed);
          failingSet = { key, count: baseline.failed.length, sinceDay: previous?.failingSet?.key === key ? previous.failingSet.sinceDay : iso(Date.parse(baseline.finishedAt)).slice(0, 10) };
          if (options.proposeFixTask && !proposedKeys.includes(key)) {
            const { count, sinceDay } = failingSet;
            const testIds = baseline.failed.slice(0, PROPOSED_TEST_IDS_MAX);
            effects.push(() => ports.proposals.propose({ orgId, project, key, title: proposalTitle(count, baseline.branch, sinceDay), failingCount: count, testIds }));
            proposedKeys = [...proposedKeys, key].slice(-PROPOSED_KEYS_KEPT);
          }
        }
        return { next: blank(now, { state: "tests_failing", source: "nightly", since: changed("tests_failing", undefined), lastNightly, proposedKeys, ...(failingSet === undefined ? {} : { failingSet }) }), effects };
      }
      case "unclear":
        // Never clears a repair state and never closes a card. A project that was fine, or failing tests, is "not sure"; one that needs repair stays so.
        return previous?.state === "needs_repair"
          ? { next: { ...previous, lastNightly }, effects: [] }
          : { next: blank(now, { state: "not_sure", cause: night.cause ?? "other", source: "nightly", since: changed("not_sure", night.cause ?? "other"), lastNightly, proposedKeys: keep.proposedKeys, blocked: keep.blocked }), effects: [] };
    }
  });
}

/**
 * A task ended "Blocked by environment" (design 6.2: 3 tasks in 24 hours with the same cause set "Setup needs repair"). Only reasons that point at the setup count (`BLOCKED_REASON_POINTS_AT_SETUP`); any
 * other reason changes nothing. A task counts once. When the project already needs repair for this cause, the task joins the open card.
 */
export async function noteBlockedTask(deps: TestEnvDeps, ports: HealthPorts, input: { orgId: OrgId; project: string; taskId: string; reason: TestingBlockedReason }): Promise<ProjectHealth | undefined> {
  const taskId = TaskId.safeParse(input.taskId);
  if (!taskId.success || BLOCKED_REASON_POINTS_AT_SETUP[input.reason] !== true) return undefined;
  const { orgId, project } = input;
  const cause = input.reason;
  return applyPlan(deps, orgId, project, (previous, now) => {
    const recent = (previous?.blocked ?? []).filter((entry) => now - Date.parse(entry.at) < BLOCKED_WINDOW_MS && entry.taskId !== taskId.data);
    const blocked = [...recent, { taskId: taskId.data, cause, at: iso(now) }].slice(-BLOCKED_KEPT_MAX);
    const same = blocked.filter((entry) => entry.cause === cause);
    if (same.length >= BLOCKED_TASKS_FOR_REPAIR) {
      const alreadyRepairing = previous?.state === "needs_repair";
      const taskIds = same.map((entry) => entry.taskId);
      return {
        next: blank(now, {
          state: "needs_repair", source: previous?.state === "needs_repair" ? previous.source : "tasks",
          // An earlier cause (the night's, which names the step) stays the project's cause; this one has its own card.
          cause: alreadyRepairing ? previous.cause ?? cause : cause, since: alreadyRepairing ? previous.since : iso(now),
          blocked, proposedKeys: previous?.proposedKeys ?? [], ...(previous?.lastNightly === undefined ? {} : { lastNightly: previous.lastNightly }), ...(previous?.failingSet === undefined ? {} : { failingSet: previous.failingSet }),
        }),
        effects: [() => ports.cards.openOrJoin({ orgId, project, cause, source: "tasks", taskIds })],
      };
    }
    // Fewer than three: the state does not move. A task blocked for the cause the project already needs repair for joins that card.
    const joins = previous?.state === "needs_repair" && previous.cause === cause;
    return {
      next: previous === undefined ? blank(now, { state: "unknown", source: "tasks", blocked }) : { ...previous, blocked },
      effects: joins ? [() => ports.cards.openOrJoin({ orgId, project, cause, source: "tasks", taskIds: [taskId.data] })] : [],
    };
  });
}

/** A setup was newly proved (a new approved environment revision). A project that needs repair is healthy again and its cards close; the blocked tasks before it no longer count. Anything else is left as it is. */
export async function noteSetupProved(deps: TestEnvDeps, ports: HealthPorts, input: { orgId: OrgId; project: string }): Promise<ProjectHealth | undefined> {
  const { orgId, project } = input;
  return applyPlan(deps, orgId, project, (previous, now) => {
    if (previous === undefined) return undefined;
    if (previous.state !== "needs_repair") return previous.blocked.length === 0 ? undefined : { next: { ...previous, blocked: [] }, effects: [] };
    return {
      next: blank(now, { state: "healthy", source: "setup_proved", proposedKeys: previous.proposedKeys, ...(previous.lastNightly === undefined ? {} : { lastNightly: previous.lastNightly }) }),
      effects: [() => ports.cards.resolve({ orgId, project, reason: "setup_proved" })],
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
export async function taskStartNotice(deps: TestEnvDeps, orgId: OrgId, project: string, env: NodeJS.ProcessEnv = process.env): Promise<TaskStartNotice> {
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
