// Plan 4 Task 26: schedule triggers on EventBridge Scheduler. A schedule starts paid work with nobody watching, so the scheduler only says WHEN; everything else is decided here at the
// moment of each fire, from what is stored now: the trigger is read live and must still be a schedule that is on, its requirements are checked again (the owner, the budget, the
// version), the previous run must be over, the slot is on time or is handled by the trigger's `missed` policy, the trigger's and the org's allowances are counted, and the start is
// the same autonomous start an event makes (Task 20). A slot is a start at most once: its identity is `sha256(triggerId, scheduledAt)`, and a late slot after an outage starts only
// when no later run covers it. A fault that may pass is THROWN, not answered, because only a thrown error makes the scheduler try again and then leave the slot in the dead-letter queue.
//
// What the scheduler is asked is in `putSchedule`: the schedule is named by the trigger's id, in the environment's group, and its input names the org and the trigger and the slot's time
// (`<aws.scheduler.scheduled-time>`, which the scheduler fills in). Clock changes are the scheduler's: a time zone is passed as it is, a time that does not exist (spring forward)
// is skipped and one that happens twice (fall back) runs once (AWS: "Daylight savings time on EventBridge Scheduler"), so there is no slot here to be missed on such a day.
// Nothing in a log line is text a person or a vendor wrote: only ids, an outcome and a code.
import { CreateScheduleCommand, DeleteScheduleCommand, FlexibleTimeWindowMode, GetScheduleCommand, ScheduleState, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { CHAIN_RUN_MAX_HOURS, ChainRunIdSchema, ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, OrgIdSchema, SCHEDULE_MISSED_GRACE_MINUTES, ScheduleTriggerSpecSchema, TRIGGER_MAX_RUNS_PER_HOUR, TriggerIdSchema, agentXError, chainScheduleGroupName, orgAutonomousKey, triggerRateKey, type OrgId, type ScheduleSpec, type TriggerOutcome } from "@rovara-code/contracts";
import { readRunRequest } from "../agents/runs.js";
import { taskEndKey } from "../agents/task-end.js";
import { taskKey } from "../developer/task-records.js";
import { awsPartitionOf } from "../aws/broker-environment.js";
import { isTerminalStatus, readChainRun } from "../chains/runner.js";
import { countOne, eventIdentity, refusalOf, runIdFor, requestIdFor, startAgentFor, startChainFor, type AutonomousSource, type TriggerDispatchDependencies } from "./dispatch.js";
import { disableTrigger } from "./lifecycle.js";
import type { ScheduleDescription, TriggerScheduler } from "./ports.js";
import { triggerProblems } from "./requirements.js";
import { isTriggerConflict, type TriggerRecord } from "./store.js";

/** The `source` of the event the scheduler invokes the broker with. */
export const CHAIN_SCHEDULE_SOURCE = "agentx.chain-schedule";

const MINUTE = 60_000;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
/** The plan's longest run (a chain run's `CHAIN_RUN_MAX_HOURS`): an agent task that has been open this long with no end record is taken as over (Task 26 review M-2). */
const OPEN_TASK_MAX_MS = CHAIN_RUN_MAX_HOURS * 3_600_000;
/** How long one slot's start claim keeps another slot from starting (Task 26 review M-1): a start takes seconds, so one this old was cut short. */
const START_CLAIM_HOLD_MS = 10 * MINUTE;
/** How long a claim counts as a start that is under way, whoever reads it first: a start takes seconds, so one younger than this is another fire's, and one older is a leftover of a start that was cut short. */
const LIVE_CLAIM_MS = 30_000;
/** A dead letter is handled this many times, then parked (Task 26 review M-4) for this long, still on the queue, where its age is alarmed. */
export const SCHEDULE_DEAD_LETTER_MAX_RECEIVES = 5;
const DEAD_LETTER_PARK_SECONDS = 12 * HOUR_SECONDS;
/** How far ahead of the clock a slot may be dated: the clocks of two machines differ by seconds, and a slot an hour ahead is not the scheduler's. */
const FUTURE_SLACK_MS = 5 * MINUTE;
const CLAIM_TRIES = 5;
const NOTE_TRIES = 5;
/** What a dead letter, or a failed fire's retry, may be asked of the queue at once, and for how long a message that is being handled is hidden from the next sweep. */
export const SCHEDULE_DEAD_LETTERS_PER_SWEEP = 10;
const DEAD_LETTER_HIDE_SECONDS = 120;
/** How many schedules still pending one sweep repairs. */
export const SCHEDULE_REPAIRS_PER_SWEEP = 25;
const DESCRIPTION = "Rovara schedule trigger";
const AGENT_TEXT = "Do your scheduled job.";

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

// ---- the expression

const pad = (value: number): string => String(value);

/**
 * The scheduler's expression for a schedule: an interval is a rate (`rate(1 day)` for 1440 minutes, whole hours as hours, the rest as minutes; one takes the singular), a daily or
 * weekly time is a cron in the schedule's own time zone (`cron(<minute> <hour> <day-of-month> <month> <day-of-week> <year>)`, the day of the month and the day of the week never both set).
 */
export function scheduleExpression(spec: ScheduleSpec): string {
  if (spec.kind === "interval") {
    const { minutes } = spec;
    if (minutes % 1440 === 0) return `rate(${pad(minutes / 1440)} ${minutes === 1440 ? "day" : "days"})`;
    if (minutes % 60 === 0) return `rate(${pad(minutes / 60)} ${minutes === 60 ? "hour" : "hours"})`;
    return `rate(${pad(minutes)} minutes)`;
  }
  const [hour, minute] = spec.at.split(":").map(Number) as [number, number];
  if (spec.kind === "weekly") return `cron(${pad(minute)} ${pad(hour)} ? * ${spec.day} *)`;
  return spec.days === undefined ? `cron(${pad(minute)} ${pad(hour)} * * ? *)` : `cron(${pad(minute)} ${pad(hour)} ? * ${spec.days.join(",")} *)`;
}

// ---- the scheduler

/** What the scheduler client is asked: the SDK's own commands, sent as they are (a test's stand-in speaks the same). */
export interface SchedulerPort {
  send(command: unknown): Promise<unknown>;
}

/** Where schedules are made and what they call: the environment's group, the role the scheduler assumes, the broker function and the dead-letter queue. */
export interface ScheduleSettings {
  groupName: string;
  roleArn: string;
  functionArn: string;
  queueArn: string;
}

export interface ScheduleDependencies {
  client: SchedulerPort;
  settings: ScheduleSettings;
}

const ACCOUNT = /^[0-9]{12}$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}(\.fifo)?$/;

/**
 * The settings from the broker's environment (`AGENTX_NAMES` after hydration, and what Lambda sets): none when anything is missing or does not look like what it should, and then no
 * schedule is made (a trigger stays pending) and no invocation is believed. The queue's ARN is built from its URL, which must be an SQS address of this region and account.
 */
export function scheduleSettingsFromEnvironment(env: Record<string, string | undefined>): (ScheduleSettings & { queueUrl: string }) | undefined {
  const { AGENTX_ENV: name, AWS_REGION: region, AGENTX_ACCOUNT_ID: account, AWS_LAMBDA_FUNCTION_NAME: functionName, CHAIN_SCHEDULE_ROLE_ARN: roleArn, CHAIN_SCHEDULE_QUEUE_URL: queueUrl } = env;
  if (!name || !region || account === undefined || !ACCOUNT.test(account) || functionName === undefined || !FUNCTION_NAME.test(functionName) || !roleArn || !queueUrl) return undefined;
  const partition = awsPartitionOf(region);
  if (!roleArn.startsWith(`arn:${partition}:iam::${account}:role/`)) return undefined;
  const queueName = new RegExp(`^https://sqs\\.${region.replace(/[.-]/g, "\\$&")}\\.amazonaws\\.com${partition === "aws-cn" ? "\\.cn" : ""}/${account}/([^/]+)$`).exec(queueUrl)?.[1];
  if (queueName === undefined || !QUEUE_NAME.test(queueName)) return undefined;
  return {
    groupName: chainScheduleGroupName(name), roleArn, functionArn: `arn:${partition}:lambda:${region}:${account}:function:${functionName}`,
    queueArn: `arn:${partition}:sqs:${region}:${account}:${queueName}`, queueUrl,
  };
}

/** What a schedule trigger is, to the scheduler. `enabled` is the schedule's state (it defaults to running). */
export interface ScheduleTriggerInput {
  orgId: string;
  triggerId: string;
  spec: unknown;
  enabled?: boolean;
}

function definitionOf(deps: ScheduleDependencies, trigger: ScheduleTriggerInput) {
  const orgId = OrgIdSchema.parse(trigger.orgId);
  const triggerId = TriggerIdSchema.parse(trigger.triggerId);
  const spec = ScheduleTriggerSpecSchema.parse(trigger.spec);
  const { settings } = deps;
  return {
    Name: triggerId, GroupName: settings.groupName, Description: DESCRIPTION,
    ScheduleExpression: scheduleExpression(spec.schedule), ScheduleExpressionTimezone: spec.timezone,
    FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF }, State: trigger.enabled === false ? ScheduleState.DISABLED : ScheduleState.ENABLED,
    Target: {
      Arn: settings.functionArn, RoleArn: settings.roleArn,
      // The scheduler fills `<aws.scheduler.scheduled-time>` with the slot's time when it invokes the target.
      Input: JSON.stringify({ source: CHAIN_SCHEDULE_SOURCE, orgId, triggerId, scheduledAt: "<aws.scheduler.scheduled-time>" }),
      RetryPolicy: { MaximumEventAgeInSeconds: HOUR_SECONDS, MaximumRetryAttempts: 5 }, DeadLetterConfig: { Arn: settings.queueArn },
    },
  };
}

/** Creates the trigger's schedule, or (when it exists) replaces it whole. The schedule is named by the trigger's id, in the group. */
export async function putSchedule(deps: ScheduleDependencies, trigger: ScheduleTriggerInput): Promise<void> {
  const definition = definitionOf(deps, trigger);
  try {
    await deps.client.send(new CreateScheduleCommand(definition));
  } catch (error) {
    if (errorName(error) !== "ConflictException") throw error;
    await deps.client.send(new UpdateScheduleCommand(definition));
  }
}

const notFound = (error: unknown): boolean => errorName(error) === "ResourceNotFoundException";

/** Deletes the trigger's schedule; one that is not there is as good as deleted. */
export async function deleteSchedule(deps: ScheduleDependencies, triggerId: string): Promise<void> {
  try {
    await deps.client.send(new DeleteScheduleCommand({ Name: TriggerIdSchema.parse(triggerId), GroupName: deps.settings.groupName }));
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

async function readSchedule(deps: ScheduleDependencies, triggerId: string): Promise<Awaited<ReturnType<typeof getSchedule>>> {
  return getSchedule(deps, TriggerIdSchema.parse(triggerId));
}

async function getSchedule(deps: ScheduleDependencies, triggerId: string) {
  try {
    return await deps.client.send(new GetScheduleCommand({ Name: triggerId, GroupName: deps.settings.groupName })) as {
      State?: string; Description?: string; ScheduleExpression?: string; ScheduleExpressionTimezone?: string; FlexibleTimeWindow?: unknown; Target?: { Input?: string } & Record<string, unknown>;
      StartDate?: Date; EndDate?: Date; ActionAfterCompletion?: string; KmsKeyArn?: string;
    };
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

/** The org and trigger a schedule's own input names (strings only), or nothing for an input that is not JSON of ours. */
function namedByInput(input: string | undefined): { orgId?: string; triggerId?: string } {
  try {
    const parsed = JSON.parse(input ?? "") as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const { orgId, triggerId } = parsed as { orgId?: unknown; triggerId?: unknown };
    return { ...(typeof orgId === "string" ? { orgId } : {}), ...(typeof triggerId === "string" ? { triggerId } : {}) };
  } catch {
    return {};
  }
}

/** The scheduler as the trigger code uses it (`TriggerScheduler`), over the SDK's client. */
export function createChainScheduler(deps: ScheduleDependencies): TriggerScheduler {
  return {
    put: (trigger) => putSchedule(deps, trigger),
    async disable(trigger) {
      const held = await readSchedule(deps, trigger.triggerId);
      if (held === undefined || held.State === ScheduleState.DISABLED) return;
      // An update replaces the whole schedule, so what it holds goes back as it is, with the one change.
      await deps.client.send(new UpdateScheduleCommand({
        Name: trigger.triggerId, GroupName: deps.settings.groupName, ScheduleExpression: held.ScheduleExpression, FlexibleTimeWindow: held.FlexibleTimeWindow, Target: held.Target,
        State: ScheduleState.DISABLED,
        ...(held.Description === undefined ? {} : { Description: held.Description }), ...(held.ScheduleExpressionTimezone === undefined ? {} : { ScheduleExpressionTimezone: held.ScheduleExpressionTimezone }),
        ...(held.StartDate === undefined ? {} : { StartDate: held.StartDate }), ...(held.EndDate === undefined ? {} : { EndDate: held.EndDate }),
        ...(held.ActionAfterCompletion === undefined ? {} : { ActionAfterCompletion: held.ActionAfterCompletion }), ...(held.KmsKeyArn === undefined ? {} : { KmsKeyArn: held.KmsKeyArn }),
      } as never));
    },
    remove: (trigger) => deleteSchedule(deps, trigger.triggerId),
    async describe(triggerId): Promise<ScheduleDescription | undefined> {
      const held = await readSchedule(deps, triggerId);
      if (held === undefined) return undefined;
      return { state: held.State === ScheduleState.DISABLED ? "DISABLED" : "ENABLED", ...namedByInput(held.Target?.Input) };
    },
  };
}

// ---- one fire

const FireSchema = z.object({ orgId: OrgIdSchema, triggerId: TriggerIdSchema, scheduledAt: z.string().datetime({ offset: true }) });

export interface ScheduleAnswer {
  outcome: TriggerOutcome | "stale" | "dead_lettered";
  runId?: string;
  taskId?: string;
  reason?: string;
}

function logOf(deps: Pick<TriggerDispatchDependencies, "log">): (event: string, fields: Record<string, unknown>) => void {
  return deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
}

/** The answer, and the trigger's activity item for it. */
async function settle(deps: TriggerDispatchDependencies, orgId: OrgId, triggerId: string, scheduledAt: string, result: ScheduleAnswer): Promise<ScheduleAnswer> {
  await deps.triggers!.recordActivity(orgId, triggerId, {
    eventKey: `schedule#${scheduledAt}`, outcome: result.outcome as TriggerOutcome,
    ...(result.runId === undefined ? {} : { runId: result.runId }), ...(result.taskId === undefined ? {} : { taskId: result.taskId }), ...(result.reason === undefined ? {} : { reason: result.reason }),
  });
  logOf(deps)("schedule.outcome", { orgId, triggerId, outcome: result.outcome, ...(result.reason === undefined ? {} : { reason: result.reason }) });
  return result;
}

/**
 * A fire for a trigger that is gone, off or not a schedule: nothing starts. The schedule named by the trigger's id is deleted only after the scheduler shows that ITS OWN input
 * names the same org and trigger; any other invocation (a forged one, naming org B with org A's trigger id) is only logged, so it can't delete another org's schedule.
 */
async function forgetSchedule(deps: TriggerDispatchDependencies, orgId: OrgId, triggerId: string): Promise<void> {
  const log = logOf(deps);
  log("schedule.stale", { orgId, triggerId });
  const scheduler = deps.triggerSchedules;
  if (scheduler === undefined) return;
  try {
    const held = await scheduler.describe(triggerId);
    if (held === undefined) return;
    if (held.orgId !== orgId || held.triggerId !== triggerId) {
      log("schedule.stale_not_ours", { orgId, triggerId });
      return;
    }
    await scheduler.remove({ orgId, triggerId });
  } catch (error) {
    log("schedule.stale_cleanup_failed", { orgId, triggerId, error: errorName(error) });
  }
}

/**
 * Whether the work of the trigger is still open: another slot's start is under way (a fresh claim), its last chain run is not over, or its last agent task has no recorded end (a task
 * that is not there is over; one open for longer than the plan's longest run is taken as over and logged, so a lost end record cannot hold the trigger for ever).
 */
async function stillRunning(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, slot: string, now: number): Promise<boolean> {
  const claim = trigger.startClaim;
  if (claim !== undefined && claim.slot !== slot && Date.parse(claim.at) + START_CLAIM_HOLD_MS > now) return true;
  const run = trigger.lastRunId === undefined ? undefined : ChainRunIdSchema.safeParse(trigger.lastRunId);
  if (run?.success === true) {
    const open = await readChainRun(deps, orgId, run.data);
    if (open !== undefined && !isTerminalStatus(open.status)) return true;
  }
  if (trigger.lastTaskId !== undefined) {
    const read = async (key: { pk: string; sk: string }) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: { orgId?: unknown; outcome?: unknown; createdAt?: unknown } }).Item;
    const task = await read(taskKey(trigger.lastTaskId));
    if (task !== undefined && task.orgId === orgId) {
      const end = await read(taskEndKey(trigger.lastTaskId));
      if (end === undefined || end.orgId !== orgId || end.outcome === undefined) {
        const started = typeof task.createdAt === "string" ? Date.parse(task.createdAt) : Number.NaN;
        if (!(started + OPEN_TASK_MAX_MS <= now)) return true;
        logOf(deps)("schedule.open_task_expired", { orgId, triggerId: trigger.triggerId, taskId: trigger.lastTaskId });
      }
    }
  }
  return false;
}

/** Notes that the trigger started work, for the no-overlap check. Best effort: the work is started and its activity written, so a lost race here only leaves the note a moment late. */
async function noteStarted(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, started: { runId?: string; taskId?: string }, now: number, slot: string): Promise<void> {
  const store = deps.triggers!;
  let current: TriggerRecord | undefined = trigger;
  for (let attempt = 0; attempt < NOTE_TRIES && current !== undefined; attempt += 1) {
    try {
      await store.update({
        trigger: current,
        patch: { lastFiredAt: new Date(now).toISOString(), ...(started.runId === undefined ? {} : { lastRunId: started.runId }), ...(started.taskId === undefined ? {} : { lastTaskId: started.taskId }) },
        // The work is noted, so this slot's hold ends with it (a hold another slot made is not ours to end).
        ...(current.startClaim?.slot === slot ? { clear: ["startClaim" as const] } : {}),
      });
      return;
    } catch (error) {
      current = await store.get(orgId, trigger.triggerId).catch(() => undefined);
      if (current === undefined || attempt === NOTE_TRIES - 1) logOf(deps)("schedule.bookkeeping_failed", { orgId, triggerId: trigger.triggerId, error: errorName(error) });
    }
  }
}

/** What a fire holds once it has the slot: the trigger as it stands after the claim, and what to put back if the start does not happen. */
interface SlotClaim {
  held: TriggerRecord;
  slot: string;
  /** The instant of the start claim (its identity, so a release touches only its own). */
  at: string;
  /** A late slot also moved `lastFiredAt`: what it was before, and what it was moved to. */
  late?: { previous: string | undefined; at: string };
}

/**
 * Takes the slot: the overlap check and the claim in one revision-conditional update (Task 26 review M-1). A fire that finds work open is answered `skipped`; a late slot is `missed`
 * under `skip`, or when a later run already covers it (`lastFiredAt` at or after the slot); otherwise the update writes the start claim (and, for a late slot, moves `lastFiredAt` to now).
 * The update is conditional on the revision that was read, so of any number of fires that saw the same trigger exactly one wins, and the rest read it again and find the claim (or the
 * run it noted), which is what stops two slots from both starting however they interleave.
 */
async function takeSlot(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, scheduledAt: string, now: number, late: boolean): Promise<{ taken: SlotClaim } | { answer: ScheduleAnswer } | { gone: true }> {
  const store = deps.triggers!;
  let current: TriggerRecord | undefined = trigger;
  // The claim this fire saw when it last read the trigger: a claim of THIS slot that is new since (a lost race) is another fire's start under way, not a leftover of a start that was cut short.
  let seenClaimAt = trigger.startClaim?.at;
  for (let attempt = 0; attempt < CLAIM_TRIES; attempt += 1) {
    if (current === undefined || !current.enabled || current.spec.kind !== "schedule") return { gone: true };
    const rival = current.startClaim;
    const sameSlot = rival !== undefined && rival.slot === scheduledAt;
    // Another fire's claim of this very slot is live when it is new since this fire last read the trigger (a lost race), or young enough to be a start still under way even on this fire's
    // first read: an agent's task has no identity to be covered by before its cap counts are spent, so a fire that took such a claim over would spend them a second time.
    const live = sameSlot && ((attempt > 0 && rival.at !== seenClaimAt && Date.parse(rival.at) + START_CLAIM_HOLD_MS > now) || Date.parse(rival.at) + LIVE_CLAIM_MS > now);
    if (live) {
      // Another fire of this very slot won the claim and is starting the work: this one spends no cap count and starts nothing (a chain's run identity is the slot's, so it is that run).
      return { answer: { outcome: "duplicate", reason: "start_in_progress", ...(current.target.kind === "chain" ? { runId: runIdFor(eventIdentity(trigger.triggerId, scheduledAt)) } : {}) } };
    }
    seenClaimAt = rival?.at;
    if (await stillRunning(deps, orgId, current, scheduledAt, now)) return { answer: { outcome: "skipped", reason: "previous_run_still_running" } };
    if (late) {
      if (current.spec.missed === "skip") return { answer: { outcome: "missed" } };
      if (current.lastFiredAt !== undefined && current.lastFiredAt >= scheduledAt) return { answer: { outcome: "missed", reason: "covered_by_a_later_run" } };
    }
    const at = new Date(now).toISOString();
    try {
      const held = await store.update({ trigger: current, patch: { startClaim: { slot: scheduledAt, at }, ...(late ? { lastFiredAt: at } : {}) } });
      return { taken: { held, slot: scheduledAt, at, ...(late ? { late: { previous: current.lastFiredAt, at } } : {}) } };
    } catch (error) {
      if (!isTriggerConflict(error)) throw error;
      current = await store.get(orgId, trigger.triggerId);
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "try again");
}

/**
 * Gives a claim back when the slot did not start: the start failed in a way that may pass, or a cap held it back (so the retry, or the slot once the cap allows, is not told that a run
 * covers it), and with `keepLate` (a refusal is a recorded answer for the slot) only the start claim goes. Each part is put back only while it is still this fire's own. Best effort.
 */
async function releaseClaim(deps: TriggerDispatchDependencies, orgId: OrgId, triggerId: string, claim: SlotClaim, options: { keepLate?: boolean } = {}): Promise<void> {
  const store = deps.triggers!;
  try {
    const current = await store.get(orgId, triggerId);
    if (current === undefined) return;
    const ours = current.startClaim?.slot === claim.slot && current.startClaim.at === claim.at;
    const restore = claim.late !== undefined && options.keepLate !== true && current.lastFiredAt === claim.late.at;
    if (!ours && !restore) return;
    await store.update({
      trigger: current,
      patch: restore && claim.late?.previous !== undefined ? { lastFiredAt: claim.late.previous } : {},
      clear: [...(ours ? ["startClaim" as const] : []), ...(restore && claim.late?.previous === undefined ? ["lastFiredAt" as const] : [])],
    });
  } catch (error) {
    logOf(deps)("schedule.claim_release_failed", { orgId, triggerId, error: errorName(error) });
  }
}

const sourceOf = (trigger: TriggerRecord, scheduledAt: string): AutonomousSource => ({
  origin: "schedule", project: trigger.project, agentText: AGENT_TEXT, startedBy: { kind: "schedule", triggerId: trigger.triggerId, scheduledAt },
});

/**
 * One invocation of the scheduler: starts the trigger's work for the slot `scheduledAt` when everything holds now, and answers what it did. `forceLate` is for a dead letter, which is
 * a late slot whatever its time. Throws what may pass (a service that is away, a start that failed in a way that may pass), so the scheduler tries again; everything else is an answer.
 */
export async function handleChainSchedule(deps: TriggerDispatchDependencies, input: unknown, now: number, options: { forceLate?: boolean } = {}): Promise<ScheduleAnswer> {
  const log = logOf(deps);
  const parsed = FireSchema.safeParse(input === null || typeof input !== "object" ? undefined : { orgId: (input as Record<string, unknown>)["orgId"], triggerId: (input as Record<string, unknown>)["triggerId"], scheduledAt: (input as Record<string, unknown>)["scheduledAt"] });
  if (!parsed.success || Date.parse(parsed.data.scheduledAt) > now + FUTURE_SLACK_MS) {
    log("schedule.invalid_input", {});
    return { outcome: "stale", reason: "invalid" };
  }
  const { orgId, triggerId } = parsed.data;
  // The slot as an instant, in one spelling, so the same slot is the same identity however the scheduler wrote it.
  const scheduledAt = new Date(Date.parse(parsed.data.scheduledAt)).toISOString();
  if (deps.triggers === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "triggers are not set up in this deployment");
  // 1. The trigger, under this org's own key: another org's id reads nothing of the org whose trigger it names.
  const trigger = await deps.triggers.get(orgId, triggerId);
  if (trigger === undefined || trigger.orgId !== orgId || !trigger.enabled || trigger.spec.kind !== "schedule") {
    await forgetSchedule(deps, orgId, triggerId);
    return { outcome: "stale" };
  }
  // 2. What the trigger needs, read now. A service of ours that is away is thrown (the scheduler retries); any other problem turns the trigger and its schedule off and starts nothing.
  const problems = await triggerProblems(deps, trigger);
  if (problems.some((problem) => problem.code === "RUNTIME_UNAVAILABLE")) {
    log("schedule.runtime_unavailable", { orgId, triggerId });
    throw agentXError("RUNTIME_UNAVAILABLE", "try again");
  }
  if (problems.length > 0) {
    await disableTrigger(deps, trigger, problems);
    return settle(deps, orgId, triggerId, scheduledAt, { outcome: "failed", reason: "trigger_invalid" });
  }
  // 3. The slot's identity: a start that is already there is the answer, and uses no allowance.
  const identity = eventIdentity(triggerId, scheduledAt);
  if (trigger.target.kind === "chain") {
    const existing = await readChainRun(deps, orgId, runIdFor(identity));
    if (existing !== undefined) return settle(deps, orgId, triggerId, scheduledAt, { outcome: "duplicate", runId: existing.runId });
  } else {
    const existing = await readRunRequest(deps, orgId, requestIdFor(identity));
    if (existing !== undefined) return settle(deps, orgId, triggerId, scheduledAt, { outcome: "duplicate", taskId: existing.taskId });
  }
  // 4. No overlap, then the slot: on time, or late (a late slot is skipped under `skip`, or starts only when no later run covers it). One conditional update takes the slot and holds it
  // against every other fire until the work is noted, so open work, a late claim and a concurrent fire are decided in the same place (review M-1).
  const late = options.forceLate === true || now - Date.parse(scheduledAt) > SCHEDULE_MISSED_GRACE_MINUTES * MINUTE;
  const took = await takeSlot(deps, orgId, trigger, scheduledAt, now, late);
  if ("gone" in took) {
    await forgetSchedule(deps, orgId, triggerId);
    return { outcome: "stale" };
  }
  if ("answer" in took) return settle(deps, orgId, triggerId, scheduledAt, took.answer);
  const { taken } = took;
  // 5. The trigger's allowance for the hour (never above the platform's), then the org's for the day. A slot a cap holds back gives its claim back (review M-3).
  const clock = new Date(now).toISOString();
  const allowed = Number.isInteger(trigger.maxRunsPerHour) ? Math.min(trigger.maxRunsPerHour, TRIGGER_MAX_RUNS_PER_HOUR) : 0;
  try {
    if (!await countOne(deps, triggerRateKey(orgId, triggerId, clock.slice(0, 13)), allowed, 2 * HOUR_SECONDS)) {
      await releaseClaim(deps, orgId, triggerId, taken);
      return await settle(deps, orgId, triggerId, scheduledAt, { outcome: "skipped", reason: "rate_limited" });
    }
    if (!await countOne(deps, orgAutonomousKey(orgId, clock.slice(0, 10)), ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, 2 * DAY_SECONDS)) {
      await releaseClaim(deps, orgId, triggerId, taken);
      return await settle(deps, orgId, triggerId, scheduledAt, { outcome: "skipped", reason: "org_daily_limit" });
    }
  } catch (error) {
    // A counter that could not be read or written: the start does not happen, and the slot is not left claimed for the retry.
    await releaseClaim(deps, orgId, triggerId, taken);
    throw error;
  }
  // 6. The start, as an event's is. A refusal is a recorded outcome; a fault that may pass is thrown.
  let started: { runId?: string; taskId?: string };
  try {
    const source = sourceOf(trigger, scheduledAt);
    started = trigger.target.kind === "chain" ? await startChainFor(deps, orgId, trigger, identity, source) : await startAgentFor(deps, orgId, trigger, identity, source);
  } catch (error) {
    const refusal = await refusalOf(deps, orgId, trigger, error);
    if ("transient" in refusal) {
      log("schedule.start_failed", { orgId, triggerId, error: errorName(refusal.transient) });
      await releaseClaim(deps, orgId, triggerId, taken);
      throw refusal.transient;
    }
    await releaseClaim(deps, orgId, triggerId, taken, { keepLate: true });
    return settle(deps, orgId, triggerId, scheduledAt, { outcome: refusal.outcome, reason: refusal.reason });
  }
  try {
    return await settle(deps, orgId, triggerId, scheduledAt, { outcome: "started", ...started });
  } finally {
    await noteStarted(deps, orgId, taken.held, started, now, scheduledAt);
  }
}

/**
 * The scheduler's invocation as the broker answers it. EventBridge Scheduler calls the broker ASYNCHRONOUSLY, so an error thrown here never reaches the scheduler's retry policy or its
 * dead-letter queue: Lambda retries on its own and the last failure lands in the Slack hand-off queue, raising an alarm about the wrong thing (review I-1). So a fire that fails records
 * itself in the chain queue (ids, the slot and a code, nothing a person or a vendor wrote), and the chain sweep's drain handles it as a late slot; the invocation then succeeds. Where
 * the record cannot be written, or there is no queue, or the event does not name a slot, the original error is thrown: Lambda's own retries are then the last resort.
 */
export async function fireChainSchedule(deps: TriggerDispatchDependencies, input: unknown, now: number, deadLetters: Pick<ScheduleDeadLetters, "put"> | undefined): Promise<ScheduleAnswer> {
  try {
    return await handleChainSchedule(deps, input, now);
  } catch (error) {
    const fields = input === null || typeof input !== "object" ? undefined : { orgId: (input as Record<string, unknown>)["orgId"], triggerId: (input as Record<string, unknown>)["triggerId"], scheduledAt: (input as Record<string, unknown>)["scheduledAt"] };
    const fire = FireSchema.safeParse(fields);
    const failure = failureCodeOf(error);
    const log = logOf(deps);
    if (!fire.success || deadLetters === undefined) {
      log("schedule.fire_failed_unrecorded", { error: failure });
      throw error;
    }
    const { orgId, triggerId } = fire.data;
    log("schedule.fire_failed", { orgId, triggerId, error: failure });
    try {
      await deadLetters.put(JSON.stringify({ source: CHAIN_SCHEDULE_SOURCE, orgId, triggerId, scheduledAt: new Date(Date.parse(fire.data.scheduledAt)).toISOString(), failure }));
    } catch (putError) {
      log("schedule.fire_failed_unrecorded", { orgId, triggerId, error: errorName(putError) });
      throw error;
    }
    return { outcome: "dead_lettered", reason: failure };
  }
}

/** A code for a failure that is safe to write down: a refusal's code, else the error's name, else `unknown`. Never its message. */
function failureCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  const name = errorName(error);
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
}

// ---- dead letters and repair

/** What the scheduler leaves in the dead-letter queue, as the sweep reads it. */
export interface ScheduleDeadLetters {
  receive(max: number): Promise<Array<{ body: string; handle: string; receives: number }>>;
  remove(handle: string): Promise<void>;
  /** Puts a record in the queue (a fire that failed records itself). */
  put(body: string): Promise<void>;
  /** Hides a message for a long time but keeps it on the queue (its age is alarmed). */
  park(handle: string): Promise<void>;
}

export function createDeadLetters(input: { sqs: SchedulerPort; queueUrl: string }): ScheduleDeadLetters {
  return {
    async receive(max) {
      const answer = await input.sqs.send(new ReceiveMessageCommand({
        QueueUrl: input.queueUrl, MaxNumberOfMessages: Math.min(Math.max(1, max), SCHEDULE_DEAD_LETTERS_PER_SWEEP), WaitTimeSeconds: 0, VisibilityTimeout: DEAD_LETTER_HIDE_SECONDS,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      })) as { Messages?: Array<{ Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }> };
      return (answer.Messages ?? []).flatMap((message) => {
        if (message.Body === undefined || message.ReceiptHandle === undefined) return [];
        const receives = Number(message.Attributes?.["ApproximateReceiveCount"]);
        // A count that is missing or not a number is taken as the first receive, so a reading fault can only delay the parking, never lose a letter.
        return [{ body: message.Body, handle: message.ReceiptHandle, receives: Number.isInteger(receives) && receives >= 1 ? receives : 1 }];
      });
    },
    async put(body) {
      await input.sqs.send(new SendMessageCommand({ QueueUrl: input.queueUrl, MessageBody: body }));
    },
    async park(handle) {
      await input.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: input.queueUrl, ReceiptHandle: handle, VisibilityTimeout: DEAD_LETTER_PARK_SECONDS }));
    },
    async remove(handle) {
      await input.sqs.send(new DeleteMessageCommand({ QueueUrl: input.queueUrl, ReceiptHandle: handle }));
    },
  };
}

export interface ScheduleSweepReport {
  /** Dead letters taken off the queue: handled, or not ours to handle. */
  deadLetters: number;
  /** Schedules that were pending and are now the scheduler's. */
  repaired: number;
  /** Dead letters left on the queue and schedules left pending, because handling them failed (they are looked at again next sweep). */
  failed: number;
}

/** Handles the queue's dead letters: each is recorded as a missed slot, then handled as a late fire under the trigger's `missed` policy. Takes at most `max`. */
async function drainDeadLetters(deps: TriggerDispatchDependencies, letters: ScheduleDeadLetters, now: number, max: number, report: ScheduleSweepReport): Promise<void> {
  const log = logOf(deps);
  for (const message of await letters.receive(max)) {
    let letter: z.infer<typeof FireSchema> | undefined;
    try {
      const body = JSON.parse(message.body) as { source?: unknown } & Record<string, unknown>;
      const fire = FireSchema.safeParse(body);
      if (body.source === CHAIN_SCHEDULE_SOURCE && fire.success) letter = fire.data;
    } catch {
      letter = undefined;
    }
    // A letter that has been handled the most times and still comes back is parked (review M-4): it stays on the queue, hidden for twelve hours, so its age raises the alarm and it
    // no longer takes one of the sweep's ten places or starts anything.
    if (message.receives > SCHEDULE_DEAD_LETTER_MAX_RECEIVES) {
      try {
        await letters.park(message.handle);
        log("schedule.dead_letter_parked", { ...(letter === undefined ? {} : { orgId: letter.orgId, triggerId: letter.triggerId }), receives: message.receives });
      } catch (error) {
        report.failed += 1;
        log("schedule.dead_letter_park_failed", { error: errorName(error) });
      }
      continue;
    }
    try {
      if (letter === undefined) {
        log("schedule.dead_letter_unreadable", {});
      } else {
        const scheduledAt = new Date(Date.parse(letter.scheduledAt)).toISOString();
        // Only a trigger that is there has a record to keep: a letter for another org's id, or for a trigger that is gone, is handled as the stale fire it is.
        if (await deps.triggers?.get(letter.orgId, letter.triggerId) !== undefined) {
          await deps.triggers!.recordActivity(letter.orgId, letter.triggerId, { eventKey: `dead_letter#${scheduledAt}`, outcome: "missed", reason: "dead_letter" });
        }
        await handleChainSchedule(deps, letter, now, { forceLate: true });
      }
      await letters.remove(message.handle);
      report.deadLetters += 1;
    } catch (error) {
      report.failed += 1;
      log("schedule.dead_letter_failed", { error: errorName(error) });
    }
  }
}

/** Makes the scheduler hold what the trigger says for schedules whose update did not get through (`scheduleStatus: "pending"`), at most `max` a sweep. */
async function repairPending(deps: TriggerDispatchDependencies, max: number, report: ScheduleSweepReport): Promise<void> {
  const store = deps.triggers;
  const scheduler = deps.triggerSchedules;
  if (store === undefined || scheduler === undefined) return;
  const log = logOf(deps);
  for (const entry of await store.listPendingSchedules(max)) {
    const trigger = await store.get(entry.orgId, entry.triggerId);
    if (trigger === undefined || trigger.spec.kind !== "schedule") {
      await store.dropPending(entry.orgId, entry.triggerId);
      continue;
    }
    try {
      if (trigger.enabled) await scheduler.put({ orgId: trigger.orgId, triggerId: trigger.triggerId, spec: trigger.spec });
      else await scheduler.disable({ orgId: trigger.orgId, triggerId: trigger.triggerId });
      await store.update({ trigger, patch: { scheduleStatus: "ok" } });
      report.repaired += 1;
    } catch (error) {
      report.failed += 1;
      log("schedule.repair_failed", { orgId: entry.orgId, triggerId: entry.triggerId, error: errorName(error) });
    }
  }
}

/** The part of the 5-minute sweep that is the schedules': up to 10 dead letters, then up to `maxPending` schedules that are still pending. */
export async function sweepSchedules(deps: TriggerDispatchDependencies, options: { deadLetters?: ScheduleDeadLetters; now: number; maxPending?: number; maxDeadLetters?: number }): Promise<ScheduleSweepReport> {
  const report: ScheduleSweepReport = { deadLetters: 0, repaired: 0, failed: 0 };
  let fault: unknown;
  if (options.deadLetters !== undefined) {
    try {
      await drainDeadLetters(deps, options.deadLetters, options.now, Math.min(options.maxDeadLetters ?? SCHEDULE_DEAD_LETTERS_PER_SWEEP, SCHEDULE_DEAD_LETTERS_PER_SWEEP), report);
    } catch (error) {
      fault = error;
      logOf(deps)("schedule.sweep_failed", { part: "dead_letters", error: errorName(error) });
    }
  }
  try {
    await repairPending(deps, options.maxPending ?? SCHEDULE_REPAIRS_PER_SWEEP, report);
  } catch (error) {
    fault ??= error;
    logOf(deps)("schedule.sweep_failed", { part: "repair", error: errorName(error) });
  }
  if (fault !== undefined && report.deadLetters === 0 && report.repaired === 0) throw fault instanceof Error ? fault : new Error("the schedule sweep failed");
  return report;
}
