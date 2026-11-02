// Proof and test environment E6 (design proof-test-env, section 4.5): the nightly full baseline. A schedule per project fires at the environment's `cronUtc`; the fire decides, from what is stored NOW, whether a
// run starts; the run's result is recorded and feeds test selection (the coverage map), the "already failing" set (a known failure is not a regression of a task) and the flaky set.
//
// A fire starts a run only when: the project has an approved environment with `nightly.enabled`; the fire is not old (an hour, the scheduler's own retry horizon); something merged since the last recorded run
// (the branch head moved; an unreadable head is a skip, never a run, so cost stays bounded); no run for this project is still in flight; and this slot has not been handled. The slot is claimed with a conditional
// write BEFORE the run starts, so two fires of one slot start one run. The run itself is started through `startRun` (the worker's CHECKS mode, wired by the controller), which this module only asks.
//
// Schedule: EventBridge Scheduler, one per project, in the environment's group (the same settings the trigger schedules use). The expression is the environment's five-field cron, converted to the scheduler's
// six fields (unix day-of-week 0-6 becomes 1-7, and one of day-of-month and day-of-week is `?`). A cron that sets both is refused, as the scheduler would.
import { createHash } from "node:crypto";
import { CreateScheduleCommand, DeleteScheduleCommand, FlexibleTimeWindowMode, ScheduleState, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  CoverageMapSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  NIGHTLY_FAILED_MAX,
  NIGHTLY_FLAKY_MAX,
  NIGHTLY_SOURCE,
  NightlyBaselineSchema,
  NightlyFireSchema,
  NightlyResultSchema,
  StoredNightlyHealthSchema,
  agentXError,
  canonicalJson,
  projectPk,
  type CoverageMapData,
  type NightlyBaseline,
  type NightlyResult,
  type NightlySkipReason,
  type OrgId,
  type StoredNightlyHealth,
} from "@agentx/contracts";
import { readApprovedTestEnvironment, type TestEnvDeps } from "../org/test-environment.js";
import type { ScheduleSettings, SchedulerPort } from "../triggers/schedules.js";
import { classifyNightlyHealth } from "./nightly-health.js";

const HOUR_MS = 3_600_000;
/** A fire older than this is not run: the scheduler retries for an hour at most. */
export const NIGHTLY_FIRE_MAX_AGE_MS = HOUR_MS;
/** A claimed run that has not reported in this long is over (a nightly of an hour and a half, with room). */
export const NIGHTLY_RUN_MAX_MS = 6 * HOUR_MS;
const BASELINE_TTL_MS = 90 * 24 * HOUR_MS;
const FRESH_MAP_FLOOR = 0;

type Item = Record<string, unknown>;
const keyOf = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** How far ahead of the broker's clock a result may be dated: the worker's clock may be a little off. */
export const NIGHTLY_CLOCK_SKEW_MS = 5 * 60_000;
const TRANSIENT_NAMES: ReadonlySet<string> = new Set(["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "ServiceUnavailable", "InternalServerError", "TimeoutError", "TransactionConflictException", "RequestTimeout"]);
/** A fault that a repeat may cure: a write that met another write (`CHANGE_STALE`), or an unavailable or throttled table. Everything else (a damaged item, a refused input) would only fail again. */
const mayPass = (error: unknown): boolean => (error as { code?: unknown } | undefined)?.code === "CHANGE_STALE" || TRANSIENT_NAMES.has(errorName(error));

/** The slot a fire is: the same project and the same scheduled time are one slot. */
export const nightlySlotId = (orgId: string, project: string, scheduledAt: string): string => sha([orgId, project, new Date(scheduledAt).toISOString()]);

/** The schedule's name: stable per project, and a legal scheduler name (letters, digits, `-` and `_`, at most 64). */
export function nightlyScheduleName(orgId: string, project: string): string {
  return `tenightly-${sha([orgId, project]).slice(0, 40)}`;
}

// ---- the schedule

const FIELD = /^[0-9*/,-]+$/u;
function expandNumbers(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const step = /^(\*|\d+(?:-\d+)?)\/(\d+)$/u.exec(part);
    const range = /^(\d+)-(\d+)$/u.exec(part);
    const [from, to, by] = step !== null
      ? (step[1] === "*" ? [min, max, Number(step[2])] : [Number(step[1]!.split("-")[0]), step[1]!.includes("-") ? Number(step[1]!.split("-")[1]) : max, Number(step[2])])
      : range !== null ? [Number(range[1]), Number(range[2]), 1] : /^\d+$/u.test(part) ? [Number(part), Number(part), 1] : [Number.NaN, Number.NaN, 1];
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(by) || by < 1 || from < min || to > max || from > to) throw agentXError("CONFIG_INVALID", "the nightly time is not a cron the scheduler can run");
    for (let value = from; value <= to; value += by) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

/** The scheduler's expression for the environment's five-field cron (UTC). Throws CONFIG_INVALID for one it cannot run. */
export function nightlyExpression(cronUtc: string): string {
  const fields = cronUtc.trim().split(/\s+/u);
  if (fields.length !== 5 || !fields.every((field) => FIELD.test(field))) throw agentXError("CONFIG_INVALID", "the nightly time is not a five-field cron");
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== "*" && dow !== "*") throw agentXError("CONFIG_INVALID", "set the day of the month or the day of the week, not both");
  expandNumbers(minute, 0, 59);
  expandNumbers(hour, 0, 23);
  if (month !== "*") expandNumbers(month, 1, 12);
  if (dom !== "*") expandNumbers(dom, 1, 31);
  const weekdays = dow === "*" ? undefined : [...new Set(expandNumbers(dow, 0, 7).map((day) => (day % 7) + 1))].sort((a, b) => a - b);
  return `cron(${minute} ${hour} ${dow === "*" ? dom : "?"} ${month} ${weekdays === undefined ? "?" : weekdays.join(",")} *)`;
}

export interface NightlyScheduleDependencies { client: SchedulerPort; settings: ScheduleSettings }

function scheduleDefinition(deps: NightlyScheduleDependencies, orgId: OrgId, project: string, cronUtc: string, enabled: boolean) {
  return {
    Name: nightlyScheduleName(orgId, project), GroupName: deps.settings.groupName, Description: "Rovara nightly test baseline",
    ScheduleExpression: nightlyExpression(cronUtc), ScheduleExpressionTimezone: "UTC", FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
    State: enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
    Target: {
      Arn: deps.settings.functionArn, RoleArn: deps.settings.roleArn,
      Input: JSON.stringify({ source: NIGHTLY_SOURCE, orgId, project, scheduledAt: "<aws.scheduler.scheduled-time>" }),
      RetryPolicy: { MaximumEventAgeInSeconds: HOUR_MS / 1000, MaximumRetryAttempts: 3 }, DeadLetterConfig: { Arn: deps.settings.queueArn },
    },
  };
}

/** Creates or replaces the project's nightly schedule. Idempotent. `enabled: false` leaves it in place, off. */
export async function putNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string; cronUtc: string; enabled: boolean }): Promise<void> {
  const definition = scheduleDefinition(deps, input.orgId, input.project, input.cronUtc, input.enabled);
  try {
    await deps.client.send(new CreateScheduleCommand(definition));
  } catch (error) {
    if (errorName(error) !== "ConflictException") throw error;
    await deps.client.send(new UpdateScheduleCommand(definition));
  }
}

export async function deleteNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string }): Promise<void> {
  try {
    await deps.client.send(new DeleteScheduleCommand({ Name: nightlyScheduleName(input.orgId, input.project), GroupName: deps.settings.groupName }));
  } catch (error) {
    if (errorName(error) !== "ResourceNotFoundException") throw error;
  }
}

/** Makes the schedule match an approved environment: on and at its time when `nightly.enabled`, off otherwise. Call after every approval. */
export async function syncNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string; nightly: { enabled: boolean; cronUtc: string } }): Promise<void> {
  await putNightlySchedule(deps, { orgId: input.orgId, project: input.project, cronUtc: input.nightly.cronUtc, enabled: input.nightly.enabled });
}

// ---- one fire

/** The spend refusals a nightly can meet (the ledger's own codes for a full budget): the night is skipped, not retried. */
const BUDGET_CODES: ReadonlySet<string> = new Set(["ORG_BUDGET_EXCEEDED", "BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED", "TEST_ALLOWANCE_USED", "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED"]);
/** At most one nightly run per project in this long, whatever the cron says: a cron of `* * * * *` or a busy repo cannot make more. */
export const NIGHTLY_MIN_GAP_MS = 20 * HOUR_MS;

export interface NightlyRunPort {
  /**
   * Charges the night to the PROJECT's budget (owner Q10), shown as "nightly baseline": the broker binds this to `admitWork` with the project as payer. Throws the scope's own error when a budget has no room.
   * The run's key must then be minted with payer project and source `nightly_baseline` (see `startRun`).
   */
  admit(input: { orgId: OrgId; project: string; purpose: "nightly_baseline" }): Promise<void>;
  /** The branch's head commit now, or undefined when it cannot be read. */
  headOf(input: { orgId: OrgId; project: string; branch: string }): Promise<string | undefined>;
  /** Starts the full run (CHECKS mode on the default branch). Throws when it cannot be started. */
  startRun(input: { orgId: OrgId; project: string; branch: string; headSha: string; envRevision: number; slotId: string; payer: { kind: "project"; project: string }; source: "nightly_baseline" }): Promise<void>;
}

export interface NightlyDeps extends TestEnvDeps { runs: NightlyRunPort }

export type NightlyFireOutcome = { outcome: "started"; slotId: string } | { outcome: "skipped"; reason: NightlySkipReason };

const skip = (reason: NightlySkipReason): NightlyFireOutcome => ({ outcome: "skipped", reason });
const dbError = (error: unknown, name: string): boolean => errorName(error) === name;

/** The last recorded baseline, or undefined. A stored item that does not read back is an error: a damaged baseline is never "no baseline". */
export async function readNightlyBaseline(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<NightlyBaseline | undefined> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, "TESTENV#BASELINE#LATEST"), ConsistentRead: true })) as { Item?: Item }).Item;
  if (item === undefined) return undefined;
  const parsed = NightlyBaselineSchema.safeParse(item.baseline);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the nightly baseline could not be read");
  return parsed.data;
}

/**
 * Handles one scheduler fire. Throws only for a fault that may pass (so the scheduler retries and then dead-letters): the claim write, or starting the run. Everything decided is returned as an outcome.
 */
export async function handleNightlyFire(deps: NightlyDeps, input: unknown): Promise<NightlyFireOutcome> {
  const fire = NightlyFireSchema.safeParse(input);
  if (!fire.success) throw agentXError("CONFIG_INVALID", "not a nightly fire");
  const { orgId, project, scheduledAt } = fire.data;
  const now = deps.now();
  const at = Date.parse(scheduledAt);
  if (now - at > NIGHTLY_FIRE_MAX_AGE_MS || at - now > 5 * 60_000) return skip("stale_fire");
  const env = await readApprovedTestEnvironment(deps, orgId, project);
  if (env === undefined) return skip("environment_missing");
  if (!env.environment.nightly.enabled) return skip("nightly_off");
  const branch = env.environment.nightly.branch;
  const head = await deps.runs.headOf({ orgId: orgId, project, branch }).catch(() => undefined);
  if (head === undefined || !/^[a-f0-9]{40}$/u.test(head)) return skip("head_unreadable");
  const last = await readNightlyBaseline(deps, orgId, project);
  if (last !== undefined && last.headSha === head && last.branch === branch && last.envRevision === env.revision) return skip("no_merges");

  // At most one run a day: the last recorded run, or a run claimed and not yet reported, that is under the gap old means this fire is skipped, whatever the cron is.
  if (last !== undefined && now - Date.parse(last.finishedAt) < NIGHTLY_MIN_GAP_MS) return skip("ran_recently");

  // Charged to the project before anything is claimed: a project with no room is skipped (and the Home failure card says why), a fault that may pass is thrown for the scheduler to retry.
  try {
    await deps.runs.admit({ orgId: orgId, project, purpose: "nightly_baseline" });
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && BUDGET_CODES.has(code)) return skip("budget");
    throw error;
  }

  const slotId = nightlySlotId(orgId, project, scheduledAt);
  const dayClaim = keyOf(orgId, project, `TESTENV#NIGHTLY#DAY#${new Date(now).toISOString().slice(0, 10)}`);
  const lock = keyOf(orgId, project, "TESTENV#NIGHTLY#ACTIVE");
  const claim = keyOf(orgId, project, `TESTENV#NIGHTLY#SLOT#${slotId}`);
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...claim, entityType: "TEST_ENV_NIGHTLY_SLOT", orgId, project, slotId, claimedAt: new Date(now).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + 7 * 24 * HOUR_MS) / 1000) },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (dbError(error, "ConditionalCheckFailedException")) return skip("already_handled");
    throw error;
  }
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...lock, entityType: "TEST_ENV_NIGHTLY_ACTIVE", orgId, project, slotId, startedAtMs: now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + NIGHTLY_RUN_MAX_MS) / 1000) + 3_600 },
      ConditionExpression: "attribute_not_exists(pk) OR startedAtMs < :stale",
      ExpressionAttributeValues: { ":stale": now - NIGHTLY_RUN_MAX_MS },
    }));
  } catch (error) {
    if (dbError(error, "ConditionalCheckFailedException")) {
      await releaseNightly(deps, orgId, project, slotId, true);
      return skip("still_running");
    }
    throw error;
  }
  // One run per project per UTC day, claimed in the database, so two fires that raced past the checks above still start one.
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...dayClaim, entityType: "TEST_ENV_NIGHTLY_DAY", orgId, project, slotId, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + 3 * 24 * HOUR_MS) / 1000) },
      ConditionExpression: "attribute_not_exists(pk) OR slotId = :slot",
      ExpressionAttributeValues: { ":slot": slotId },
    }));
  } catch (error) {
    if (dbError(error, "ConditionalCheckFailedException")) {
      await releaseNightly(deps, orgId, project, slotId, true);
      return skip("ran_recently");
    }
    throw error;
  }
  try {
    await deps.runs.startRun({ orgId, project, branch, headSha: head, envRevision: env.revision, slotId, payer: { kind: "project", project }, source: "nightly_baseline" });
  } catch (error) {
    // The run did not start: let the scheduler's retry try again (the slot claim stays, so a retry would be "already handled"; release both).
    await releaseNightly(deps, orgId, project, slotId, true);
    throw error;
  }
  return { outcome: "started", slotId };
}

async function releaseNightly(deps: TestEnvDeps, orgId: OrgId, project: string, slotId: string, alsoSlot: boolean): Promise<void> {
  const send = (command: unknown) => deps.documentClient.send(command).catch(() => undefined);
  await send(new DeleteCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, "TESTENV#NIGHTLY#ACTIVE"), ConditionExpression: "slotId = :slot", ExpressionAttributeValues: { ":slot": slotId } }));
  if (alsoSlot) {
    await send(new DeleteCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, `TESTENV#NIGHTLY#SLOT#${slotId}`) }));
    await send(new DeleteCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, `TESTENV#NIGHTLY#DAY#${new Date(deps.now()).toISOString().slice(0, 10)}`), ConditionExpression: "slotId = :slot", ExpressionAttributeValues: { ":slot": slotId } }));
  }
}

// ---- recording a result

export interface MapStore {
  /** Stores the map and returns its digest (the digest of its canonical JSON). */
  put(orgId: OrgId, project: string, map: CoverageMapData): Promise<string>;
  get(orgId: OrgId, project: string, digest: string): Promise<unknown>;
}

export const coverageMapDigest = (map: CoverageMapData): string => sha(CoverageMapSchema.parse(map));

/** What `recordNightlyResult` tells its optional listener once the baseline is stored (SH28 binds it to the project's health, only while the `nh` switch is on). */
export interface NightlyRecorded { orgId: OrgId; project: string; slotId: string; baseline: NightlyBaseline; health: StoredNightlyHealth | undefined }

/**
 * What the night's step words say (SH27), classified by the broker's own rules (SH6): nothing the worker says in words is read. Undefined for a result that carries no step words (an older worker), which then
 * stores nothing new. A report whose counts are not the result's own counts disagrees with itself and reads as unclear, never as passed.
 */
export function nightlyHealthOf(result: NightlyResult): StoredNightlyHealth | undefined {
  if (result.health === undefined) return undefined;
  const { ranFrom, ...report } = result.health;
  const agrees = report.tests.total === result.tests.total && report.tests.passed === result.tests.passed && report.tests.skipped === result.tests.skipped && report.tests.failures + report.tests.errors === result.tests.failed;
  const verdict = agrees ? classifyNightlyHealth(report) : ({ class: "unclear", cause: "steps_disagree" } as const);
  return { class: verdict.class, ...("cause" in verdict ? { cause: verdict.cause } : {}), ...(verdict.class === "tests" ? { setupProved: verdict.setupProved } : {}), ranFrom: ranFrom ?? "fresh" };
}

/**
 * Records a finished run. Accepted only for the slot the project's active run holds (so a stale or invented result changes nothing), for the environment's revision and branch, and only once. The failing set is capped;
 * when it does not fit it is kept empty-and-truncated, which excuses nothing. A coverage map is accepted only if the digest the result names is the map's own.
 */
export async function recordNightlyResult(
  deps: TestEnvDeps,
  maps: MapStore,
  input: { orgId: OrgId; project: string; result: unknown; coverageMap?: unknown },
  onRecorded?: (recorded: NightlyRecorded) => Promise<void>,
): Promise<{ recorded: true; flakyCount: number; failingCount: number }> {
  const parsed = NightlyResultSchema.safeParse(input.result);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the nightly result could not be read");
  const result = parsed.data;
  // The worker's clock is not trusted: a result dated in the future would freeze the "ran recently" gap (and the health's order) for as long as it says. Nothing is read or claimed for it.
  const horizon = deps.now() + NIGHTLY_CLOCK_SKEW_MS;
  if (Date.parse(result.finishedAt) > horizon || Date.parse(result.startedAt) > horizon) throw agentXError("CONFIG_INVALID", "the nightly result is dated in the future");
  const lock = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(input.orgId, input.project, "TESTENV#NIGHTLY#ACTIVE"), ConsistentRead: true })) as { Item?: Item }).Item;
  if (lock === undefined || lock.slotId !== result.slotId) throw agentXError("CHANGE_STALE", "no nightly run is waiting for this result");
  let coverageMapBuiltAt: string | undefined;
  if (input.coverageMap !== undefined) {
    const map = CoverageMapSchema.safeParse(input.coverageMap);
    if (!map.success || result.coverageMapRef === undefined || coverageMapDigest(map.data) !== result.coverageMapRef) throw agentXError("CONFIG_INVALID", "the coverage map does not match the result");
    // A map older than its own run was not built by it.
    if (Date.parse(map.data.builtAt) > Date.parse(result.finishedAt) + 60_000) throw agentXError("CONFIG_INVALID", "the coverage map does not match the result");
    const stored = await maps.put(input.orgId, input.project, map.data);
    if (stored !== result.coverageMapRef) throw agentXError("RUNTIME_UNAVAILABLE", "the coverage map could not be stored");
    coverageMapBuiltAt = map.data.builtAt;
  } else if (result.coverageMapRef !== undefined) {
    throw agentXError("CONFIG_INVALID", "the result names a coverage map it did not send");
  }
  const env = await readApprovedTestEnvironment(deps, input.orgId, input.project);
  if (env === undefined || env.revision !== result.envRevision || env.environment.nightly.branch !== result.branch) throw agentXError("CHANGE_STALE", "the environment changed since this nightly started");
  const previous = await readNightlyBaseline(deps, input.orgId, input.project);
  const now = deps.now();
  const baseline = NightlyBaselineSchema.parse({
    recordedAt: new Date(now).toISOString(), envRevision: result.envRevision, branch: result.branch, headSha: result.headSha, finishedAt: result.finishedAt, tests: result.tests,
    failed: result.failed.slice(0, NIGHTLY_FAILED_MAX), flaky: result.flaky.slice(0, NIGHTLY_FLAKY_MAX),
    // Keep the last good map when this run recorded none: selection reads its own age, so an old map falls back to the full suite by itself.
    ...(result.coverageMapRef !== undefined && coverageMapBuiltAt !== undefined ? { coverageMapRef: result.coverageMapRef, coverageMapBuiltAt } : previous?.coverageMapRef === undefined || previous.coverageMapBuiltAt === undefined ? {} : { coverageMapRef: previous.coverageMapRef, coverageMapBuiltAt: previous.coverageMapBuiltAt }),
  });
  // The health sits BESIDE the baseline, not inside it: an older broker still reads the baseline. A result without step words stores exactly what it always did.
  const health = nightlyHealthOf(result);
  const healthField = health === undefined ? {} : { health };
  const history = { ...keyOf(input.orgId, input.project, `TESTENV#BASELINE#${result.finishedAt}`), entityType: "TEST_ENV_BASELINE", orgId: input.orgId, project: input.project, baseline, ...healthField, slowest: result.slowest, durationMs: result.durationMs, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((now + BASELINE_TTL_MS) / 1000) };
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: history }));
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...keyOf(input.orgId, input.project, "TESTENV#BASELINE#LATEST"), entityType: "TEST_ENV_BASELINE_LATEST", orgId: input.orgId, project: input.project, baseline, ...healthField } }));
  // Before the run is released: a listener that fails leaves the run claimed, so the worker's retry records the same result again (every write above and in the listener is repeatable).
  if (onRecorded !== undefined) {
    try {
      await onRecorded({ orgId: input.orgId, project: input.project, slotId: result.slotId, baseline, health });
    } catch (error) {
      // The health is advisory: a listener never fails the record. Only a fault that may pass (a stale write, a throttled or unavailable table) is thrown, so the worker's retry records the result again.
      console.log(JSON.stringify({ component: "broker", level: "warn", event: "test_env.nightly_health_failed", orgId: input.orgId, error: errorName(error) }));
      if (mayPass(error)) throw error;
    }
  }
  await releaseNightly(deps, input.orgId, input.project, result.slotId, false);
  return { recorded: true, flakyCount: result.flaky.length, failingCount: result.tests.failed };
}

// ---- what the baseline feeds

/** The last night's classification (SH27) with the baseline it belongs to. `health` is undefined when that night carried no step words; a stored classification that does not read back is "unclear", never absent and never passed. */
export async function readLatestNightlyHealth(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<{ baseline: NightlyBaseline; health: StoredNightlyHealth | undefined } | undefined> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyOf(orgId, project, "TESTENV#BASELINE#LATEST"), ConsistentRead: true })) as { Item?: Item }).Item;
  if (item === undefined) return undefined;
  const baseline = NightlyBaselineSchema.safeParse(item.baseline);
  if (!baseline.success) throw agentXError("RUNTIME_UNAVAILABLE", "the nightly baseline could not be read");
  if (item.health === undefined) return { baseline: baseline.data, health: undefined };
  const health = StoredNightlyHealthSchema.safeParse(item.health);
  return { baseline: baseline.data, health: health.success ? health.data : { class: "unclear", cause: "unreadable", ranFrom: "fresh" } };
}

/**
 * The tests that already fail on the default branch, for the check classifier ("not a regression of this task"). Fail closed: an unreadable baseline, or one whose failing set did not fit (more failures than
 * the cap), excuses nothing.
 */
export async function alreadyFailingTests(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[]> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline === undefined || baseline.tests.failed > NIGHTLY_FAILED_MAX || baseline.failed.length !== baseline.tests.failed) return [];
  return [...baseline.failed];
}

/** The last nightly's failures, which a selection always runs again. Not the cap-excused set: when the set is truncated, what is listed still runs. */
export async function lastNightlyFailures(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[]> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  return baseline === undefined ? [] : [...baseline.failed];
}

/** The stored coverage map the baseline points at, checked against its digest; undefined when there is none, it cannot be read, or it does not hash to what the baseline recorded. */
export async function readCoverageMap(deps: TestEnvDeps, maps: MapStore, orgId: OrgId, project: string): Promise<CoverageMapData | undefined> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline?.coverageMapRef === undefined) return undefined;
  try {
    const parsed = CoverageMapSchema.safeParse(await maps.get(orgId, project, baseline.coverageMapRef));
    return parsed.success && coverageMapDigest(parsed.data) === baseline.coverageMapRef ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Counts the days since the map was built, for the Home failure card ("nothing ran for 7 days"). Undefined when there is no map. */
export function mapAgeDays(baseline: NightlyBaseline | undefined, nowMs: number): number | undefined {
  if (baseline?.coverageMapBuiltAt === undefined) return undefined;
  const built = Date.parse(baseline.coverageMapBuiltAt);
  return Number.isFinite(built) ? Math.max(FRESH_MAP_FLOOR, Math.floor((nowMs - built) / (24 * HOUR_MS))) : undefined;
}

/** Flaky bookkeeping for a result: a test is flaky when it failed once and passed on the rerun. Tests are given as the first run's failures and the rerun's failures. */
export function splitFailures(firstRunFailures: readonly string[], rerunFailures: readonly string[]): { failed: string[]; flaky: string[] } {
  const again = new Set(rerunFailures);
  const first = [...new Set(firstRunFailures)];
  return { failed: first.filter((id) => again.has(id)).sort(), flaky: first.filter((id) => !again.has(id)).sort() };
}

