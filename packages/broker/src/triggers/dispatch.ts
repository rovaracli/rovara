// Plan 4 Task 20: an event starts paid work with no person watching, so everything is decided here, at the moment of the event, from what is stored now and not from what was true
// when the trigger was saved. In order, for each enabled trigger of the receiving org, project, source and hook whose type and filter the event meets:
//   1. the loop guard (what Rovara itself did never starts work); 2. the requirements, read live (any problem turns the trigger off); 3. the event's identity (one run per event, however
//   often it arrives); 4. the trigger's allowance for the hour; 5. the org's allowance for the day; 6. the start, as the owner the run needs. A refusal is recorded by its code, never by
//   its words; a fault that may pass is thrown after the other triggers have been tried, so the vendor sends the event again and the identity makes the repeat harmless.
// Nothing in a log line is text the sender wrote: only ids, an outcome and a code.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, CHAIN_MAX_CONCURRENT_RUNS, INDEX_EXPIRY_ATTRIBUTE, ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, TRIGGER_SUBJECT_GUARD_MINUTES, TRIGGER_MAX_RUNS_PER_HOUR, TriggerEventSchema, agentXError, isBuiltinAgentId, orgAutonomousKey, triggerRateKey, triggerSubjectKey, triggerSummary as eventSummary, type AgentId, type ChainRunStartedBy, type EventSource, type OrgId, type TriggerEvent, type TriggerOutcome } from "@rovara-code/contracts";
import { readRunRequest } from "../agents/runs.js";
import { resolveAgentForAutonomousRun } from "../agents/roster.js";
import { resolveSurvivor } from "../agents/access.js";
import { buildHandoff, type HandoffTrigger } from "../chains/handoff.js";
import { readChainRun, startChainRun, type ChainRunnerDependencies } from "../chains/runner.js";
import { connectionServiceActorIds } from "../connections/store.js";
import { resolvePayer } from "../spend/payer.js";
import { disableTrigger } from "./lifecycle.js";
import { isIntakeTrigger, startIntakeFor, type IntakeDispatch } from "./intake-dispatch.js";
import { runOwnerFor, triggerProblems } from "./requirements.js";
import type { TriggerRecord } from "./store.js";

export type TriggerDispatchDependencies = ChainRunnerDependencies & {
  /** The GitHub App's slug, to tell its own bot from a person (`<slug>[bot]`); without it GitHub's own events are told by the provider's `actor.kind` alone. */
  githubAppSlug?: () => Promise<string | undefined>;
  /** Meta repo lane F: the intake engine, which starts Rovara Code from an issue that a label or an assignment asked for. Absent, such an event is recorded as failed and starts nothing. */
  intake?: IntakeDispatch;
};

/** What GitHub's API says of a pull request's or issue's author, asked now: a member of the repository's org, an outside collaborator with write access, nobody of those, or an error (which counts as nobody). */
export type AuthorVerdict = "member" | "collaborator" | "none" | "error";

/**
 * What the source of one event can add to dispatch. GitHub's `authorAssociation` in a webhook shows a private org member as CONTRIBUTOR or NONE, so a trigger limited to members would skip
 * their pull requests. `verifyAuthor` asks GitHub's API (not the payload) about the author; it is called only when that could change a trigger's match, at most once per event, and never throws.
 */
export interface TriggerDispatchContext {
  verifyAuthor?: () => Promise<AuthorVerdict>;
}

export interface DispatchOutcome {
  triggerId: string;
  outcome: TriggerOutcome;
  runId?: string;
  taskId?: string;
  reason?: string;
}

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
const EVENT_TEXT = "Do your job for this event.";
const BUSY_CODES: ReadonlySet<string> = new Set(["WORKSPACE_BUSY", "TOO_MANY_REQUESTS"]);
const BOOKKEEPING_TRIES = 5;
const REQUEST_NAMESPACE = Buffer.from("a1d6f7c2e0b34e5c8f4a2b9d7c6e5f31", "hex");

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

function logOf(deps: Pick<TriggerDispatchDependencies, "log">): (event: string, fields: Record<string, unknown>) => void {
  return deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
}

/** The identity of one trigger's start for one event: the same event at the same trigger is the same start. */
export const eventIdentity = (triggerId: string, eventKey: string): string => createHash("sha256").update(`${triggerId}\0${eventKey}`).digest("hex");

/** A chain run's id from an identity: `crn_` and 20 base-36 characters. */
export const runIdFor = (identity: string): string => `crn_${BigInt(`0x${identity}`).toString(36).slice(-20).padStart(20, "0")}`;

/** Plan 3's request id for a start (a UUID v5 of the identity), so a repeat of the start is the first one's answer. */
export function requestIdFor(identity: string): string {
  const hash = createHash("sha1").update(REQUEST_NAMESPACE).update(identity).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The accounts of Rovara's own that an event's actor is told from, per source: GitHub's `<appSlug>[bot]`, and for Linear and Jira the account of each connection marked as a
 * service identity. A connection made with a person's own key is not Rovara's account, so that person's tickets are not skipped (the subject guard and the caps bound a loop).
 * Other sources have no account of Rovara's, so none.
 */
export async function rovaraActorIds(deps: Pick<TriggerDispatchDependencies, "documentClient" | "tableName" | "githubAppSlug">, orgId: OrgId, source: EventSource): Promise<Set<string>> {
  if (source === "github") {
    const slug = await deps.githubAppSlug?.();
    return slug === undefined || slug === "" ? new Set() : new Set([`${slug}[bot]`]);
  }
  if (source === "linear" || source === "jira") return connectionServiceActorIds(deps, orgId, source);
  return new Set();
}

export { runOwnerFor };

/** Whether every key of the trigger's filter has one of its values among the event's, without regard to case. A key the event does not have, or a filter with no values, does not match. */
function meetsFilter(filter: Record<string, string[]> | undefined, fields: TriggerEvent["fields"]): boolean {
  for (const [key, wanted] of Object.entries(filter ?? {})) {
    const have = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!Array.isArray(have) || !Array.isArray(wanted)) return false;
    const lower = new Set(wanted.map((value) => value.toLowerCase()));
    if (!have.some((value) => lower.has(value.toLowerCase()))) return false;
  }
  return true;
}

/** Whether a stored trigger is one this event is for, apart from its filter: the record itself says so, whatever the index it was found under. */
function isForExceptFilter(trigger: TriggerRecord, orgId: OrgId, event: TriggerEvent): boolean {
  const { spec } = trigger;
  return trigger.orgId === orgId && trigger.enabled === true && trigger.project === event.project && spec.kind === "event" && spec.source === event.source && spec.type === event.type
    && trigger.hookId === event.hookId;
}

const AUTHOR_KEY = "authorAssociation";
/** The associations an author who is verified through the API is counted as, in GitHub's own words. */
const VERIFIED_AS: Record<"member" | "collaborator", string> = { member: "MEMBER", collaborator: "COLLABORATOR" };
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["MEMBER", "COLLABORATOR"]);

/** The filter keys the event's fields do not meet, for the log of an event nothing matched. */
function missedKeys(filter: Record<string, string[]> | undefined, fields: TriggerEvent["fields"]): string[] {
  return Object.keys(filter ?? {}).filter((key) => !meetsFilter({ [key]: filter![key]! }, fields));
}

/** Asks (at most once per event) what the API says of the author. Never throws: a failure is the verdict `error`. */
function verdictOf(work: Work): Promise<AuthorVerdict> {
  work.verdict ??= (async (): Promise<AuthorVerdict> => {
    try {
      const verdict = await work.context.verifyAuthor!();
      return verdict === "member" || verdict === "collaborator" || verdict === "none" ? verdict : "error";
    } catch {
      return "error";
    }
  })();
  return work.verdict;
}

/**
 * Whether the event meets the trigger's filter. When the only thing it misses is `authorAssociation` and the trigger would take a member or a collaborator, the author is looked up through
 * the API (`context.verifyAuthor`): a verified author is counted as MEMBER or COLLABORATOR for this match, besides what the payload said. The payload alone never upgrades anyone,
 * and a lookup that fails, times out or finds nobody leaves the filter as it was (the trigger does not match).
 */
async function meetsTriggerFilter(work: Work, trigger: TriggerRecord): Promise<boolean> {
  const { spec } = trigger;
  const filter = spec.kind === "event" ? spec.filter : undefined;
  const { event } = work;
  if (meetsFilter(filter, event.fields)) return true;
  const missed = missedKeys(filter, event.fields);
  const wanted = filter !== undefined && Object.hasOwn(filter, AUTHOR_KEY) ? filter[AUTHOR_KEY] : undefined;
  let membership: AuthorVerdict | "not_checked" = "not_checked";
  if (work.context.verifyAuthor !== undefined && Array.isArray(wanted) && missed.length === 1 && missed[0] === AUTHOR_KEY
    && wanted.some((value) => TRUSTED_ASSOCIATIONS.has(value.toUpperCase()))) {
    membership = await verdictOf(work);
    if (membership === "member" || membership === "collaborator") {
      const have = Object.hasOwn(event.fields, AUTHOR_KEY) ? event.fields[AUTHOR_KEY] : undefined;
      if (meetsFilter(filter, { ...event.fields, [AUTHOR_KEY]: [...(Array.isArray(have) ? have : []), VERIFIED_AS[membership]] })) return true;
    }
  }
  work.misses.push({ triggerId: trigger.triggerId, filterKeys: missed, membership });
  return false;
}

/** Counts one start against a limit in one conditional update; false when the limit is used up. */
export async function countOne(deps: TriggerDispatchDependencies, key: { pk: string; sk: string }, max: number, lifetimeSeconds: number): Promise<boolean> {
  if (!(max >= 1)) return false;
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: key,
      UpdateExpression: "ADD #count :one SET #expires = :expires",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":one": 1, ":max": max, ":expires": Math.floor(deps.now() / 1000) + lifetimeSeconds },
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

const handoffOf = (event: TriggerEvent): HandoffTrigger => ({
  eventKey: event.eventKey, source: event.source, type: event.type,
  subject: { kind: event.subject.kind, title: event.subject.title, ...(event.subject.url === undefined ? {} : { url: event.subject.url }) },
});

/** What dispatch knows while it works through one event's triggers. */
interface Work {
  deps: TriggerDispatchDependencies;
  orgId: OrgId;
  event: TriggerEvent;
  log: (event: string, fields: Record<string, unknown>) => void;
  actors: Map<EventSource, Promise<Set<string>>>;
  context: TriggerDispatchContext;
  /** The API's word on the author, once asked. */
  verdict?: Promise<AuthorVerdict>;
  /** The triggers that are for this event but whose filter it does not meet, for the log of an event nothing matched. */
  misses: Array<{ triggerId: string; filterKeys: string[]; membership: AuthorVerdict | "not_checked" }>;
}

/** The record of an outcome: an activity item, and a log line with ids and a code only. */
async function settle(work: Work, trigger: TriggerRecord, result: Omit<DispatchOutcome, "triggerId">): Promise<DispatchOutcome> {
  const outcome: DispatchOutcome = { triggerId: trigger.triggerId, ...result };
  await work.deps.triggers!.recordActivity(work.orgId, trigger.triggerId, {
    eventKey: work.event.eventKey, outcome: outcome.outcome,
    ...(outcome.runId === undefined ? {} : { runId: outcome.runId }), ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }), ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  work.log("trigger_dispatch.outcome", { orgId: work.orgId, triggerId: trigger.triggerId, outcome: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
  return outcome;
}

async function causedByRovara(work: Work): Promise<boolean> {
  const { event } = work;
  if (event.actor.kind === "rovara") return true;
  // The provider's word is not the only one: the actor is checked against Rovara's own accounts as they are now.
  if (event.actor.id === undefined) return false;
  let ids = work.actors.get(event.source);
  if (ids === undefined) {
    ids = rovaraActorIds(work.deps, work.orgId, event.source);
    work.actors.set(event.source, ids);
  }
  return (await ids).has(event.actor.id);
}

/** Notes that the trigger fired, for the no-overlap check. Best effort: the run is already started and its activity written, so a lost race here only leaves the note a moment late. */
async function noteFired(work: Work, trigger: TriggerRecord, started: { runId?: string; taskId?: string }): Promise<void> {
  const store = work.deps.triggers!;
  let current: TriggerRecord | undefined = trigger;
  for (let attempt = 0; attempt < BOOKKEEPING_TRIES && current !== undefined; attempt += 1) {
    try {
      await store.update({
        trigger: current,
        patch: { lastFiredAt: new Date(work.deps.now()).toISOString(), ...(started.runId === undefined ? {} : { lastRunId: started.runId }), ...(started.taskId === undefined ? {} : { lastTaskId: started.taskId }) },
      });
      return;
    } catch (error) {
      current = await store.get(work.orgId, trigger.triggerId).catch(() => undefined);
      if (current === undefined || attempt === BOOKKEEPING_TRIES - 1) work.log("trigger_dispatch.bookkeeping_failed", { orgId: work.orgId, triggerId: trigger.triggerId, error: errorName(error) });
    }
  }
}

/** What went wrong at the start, as the outcome: a code, `busy`, or (for a fault that may pass) the error itself to throw. */
export async function refusalOf(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, error: unknown): Promise<{ reason: string } | { transient: unknown }> {
  if (!(error instanceof AgentXError)) return { transient: error };
  // A service that is away (`RUNTIME_UNAVAILABLE` and its kind answer 503) may be back when the vendor sends the event again.
  if (error.statusCode >= 500) return { transient: error };
  if (BUSY_CODES.has(error.code)) return { reason: "busy" };
  if (error.code === "FORBIDDEN" && trigger.target.kind === "chain") {
    // The chain's concurrency refusal has no code of its own: it is the one that leaves the chain with its most runs open.
    const chain = await deps.chains.get(orgId, trigger.target.chainId);
    if (chain !== undefined && chain.openRuns >= CHAIN_MAX_CONCURRENT_RUNS) return { reason: "busy" };
  }
  return { reason: error.code };
}

/** What starts the work, apart from the trigger: an event's, or a schedule's slot. The same steps start either (the owner, the payer, the version, the run's identity). */
export interface AutonomousSource {
  origin: "event" | "schedule";
  project: string;
  startedBy: ChainRunStartedBy;
  /** The event that started it, for the hand-off and the run's input; a schedule has none. */
  event?: TriggerEvent;
  /** The chain run's input, and the agent's text. */
  chainInput?: string;
  agentText: string;
}

/** Starts a chain trigger's run: a member's chain runs as its member; a project's, as the maintainer who turned the trigger on (who answers for what it does). Either is read as whoever a merged developer became. */
export async function startChainFor(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, identity: string, source: AutonomousSource): Promise<{ runId: string }> {
  if (trigger.target.kind !== "chain") throw new Error("not a chain trigger");
  const chain = await deps.chains.get(orgId, trigger.target.chainId);
  if (chain === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
  const developerId = await resolveSurvivor(deps, orgId, chain.owner.kind === "member" ? chain.owner.developerId : trigger.createdBy);
  const run = await startChainRun(deps, { system: source.origin, owner: { developerId } }, {
    orgId, chainId: chain.chainId, project: source.project, origin: source.origin, startedBy: source.startedBy,
    ...(source.event === undefined ? {} : { trigger: handoffOf(source.event) }), ...(source.chainInput === undefined ? {} : { input: source.chainInput }), runId: runIdFor(identity), requestId: requestIdFor(identity),
  });
  return { runId: run.runId };
}

/** Starts an agent trigger's task, as the agent's owner (for a built-in, the maintainer who turned the trigger on), paid by the agent. */
export async function startAgentFor(deps: TriggerDispatchDependencies, orgId: OrgId, trigger: TriggerRecord, identity: string, source: AutonomousSource): Promise<{ taskId: string }> {
  if (trigger.target.kind !== "agent") throw new Error("not an agent trigger");
  if (deps.chainRuns === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "runs are not set up in this deployment");
  const agentId: AgentId = trigger.target.agentId;
  const record = isBuiltinAgentId(agentId) ? await deps.store.ensureBuiltinSettings(orgId, agentId) : await deps.store.get(orgId, agentId);
  if (record === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
  const { ref } = await resolveAgentForAutonomousRun(deps, { orgId, project: source.project, agentId });
  if (ref.version === "draft") throw agentXError("AGENT_UNAVAILABLE", "an autonomous run uses a published version");
  // A built-in has no owner of its own: the maintainer who turned the trigger on is who its runs act for.
  const owner = isBuiltinAgentId(agentId) ? { developerId: await resolveSurvivor(deps, orgId, trigger.createdBy) } : await runOwnerFor(deps, record as Parameters<typeof runOwnerFor>[1]);
  const context = source.event === undefined ? [] : buildHandoff({ runId: identity.slice(0, 20), trigger: handoffOf(source.event), earlier: [], mode: "previous" });
  // `resolvePayer` names the agent for an event or a schedule whatever the project's setting says, so `projectPays` is not read here.
  const payer = resolvePayer({ origin: source.origin, project: source.project, projectPays: false, agentId });
  const started = await deps.chainRuns.startAgentRun({
    requestId: requestIdFor(identity), orgId, project: source.project, agent: { agentId, version: ref.version },
    input: { text: source.agentText, ...(context.length === 0 ? {} : { context }) }, origin: source.origin, owner, payer,
    // Plan 5 (N6): nobody started this run, so it names the trigger that did (taken from the trigger's own record, never from the event), and its session says so.
    trigger: { kind: source.origin, triggerId: trigger.triggerId },
  });
  return { taskId: started.taskId };
}

const eventSourceOf = (event: TriggerEvent, triggerId: string): AutonomousSource => ({
  origin: "event", project: event.project, event, agentText: EVENT_TEXT, chainInput: eventSummary(event),
  startedBy: { kind: "event", triggerId, eventKey: event.eventKey, source: event.source, type: event.type, title: event.subject.title, ...(event.subject.url === undefined ? {} : { url: event.subject.url }) },
});

const subjectKeyOf = (work: Work, trigger: TriggerRecord) => triggerSubjectKey(work.orgId, trigger.triggerId, work.event.subject);

/** Whether this trigger started a run for the event's subject less than `TRIGGER_SUBJECT_GUARD_MINUTES` ago. */
async function recentlyStarted(work: Work, trigger: TriggerRecord): Promise<boolean> {
  const found = (await work.deps.documentClient.send(new GetCommand({ TableName: work.deps.tableName, Key: subjectKeyOf(work, trigger), ConsistentRead: true }))) as { Item?: { at?: unknown } };
  const at = typeof found.Item?.at === "string" ? Date.parse(found.Item.at) : Number.NaN;
  return Number.isFinite(at) && work.deps.now() - at < TRIGGER_SUBJECT_GUARD_MINUTES * 60_000;
}

/** Notes that this trigger started a run for the event's subject now. Best effort, like `noteFired`: the run exists, and a note that is lost only lets one more event through. */
async function noteSubject(work: Work, trigger: TriggerRecord): Promise<void> {
  try {
    await work.deps.documentClient.send(new PutCommand({
      TableName: work.deps.tableName,
      Item: { ...subjectKeyOf(work, trigger), entityType: "TRIGGER_SUBJECT", orgId: work.orgId, at: new Date(work.deps.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(work.deps.now() / 1000) + 2 * HOUR_SECONDS },
    }));
  } catch (error) {
    work.log("trigger_dispatch.bookkeeping_failed", { orgId: work.orgId, triggerId: trigger.triggerId, error: errorName(error) });
  }
}

/** One trigger, one event. Returns its outcome, or throws what may pass so that the event is sent again. */
async function dispatchOne(work: Work, trigger: TriggerRecord): Promise<{ outcome: DispatchOutcome } | { transient: unknown }> {
  const { deps, orgId, event } = work;
  // 1. The loop guard, before anything is read or counted: what Rovara did never starts what Rovara does.
  if (await causedByRovara(work)) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "caused_by_rovara" }) };
  // 2. What the trigger needs, read now. Any problem turns it off, tells its owners and starts nothing; no allowance is used.
  const problems = await triggerProblems(deps, trigger);
  // A service of ours that is away is not the trigger's fault: it stays on, the event is skipped and the fault is logged for us.
  if (problems.some((problem) => problem.code === "RUNTIME_UNAVAILABLE")) {
    work.log("trigger_dispatch.runtime_unavailable", { orgId, triggerId: trigger.triggerId });
    return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "runtime_unavailable" }) };
  }
  if (problems.length > 0) {
    await disableTrigger(deps, trigger, problems);
    return { outcome: await settle(work, trigger, { outcome: "failed", reason: "trigger_invalid" }) };
  }
  // 3. One start per event: a start that is already there is the answer, and uses no allowance.
  const identity = eventIdentity(trigger.triggerId, event.eventKey);
  if (trigger.target.kind === "chain") {
    const existing = await readChainRun(deps, orgId, runIdFor(identity));
    if (existing !== undefined) return { outcome: await settle(work, trigger, { outcome: "duplicate", runId: existing.runId }) };
  } else {
    const existing = await readRunRequest(deps, orgId, requestIdFor(identity));
    if (existing !== undefined) return { outcome: await settle(work, trigger, { outcome: "duplicate", taskId: existing.taskId }) };
  }
  // The subject this trigger just started a run for: what that run did to it may be what this event is, so it is not started again at once. No allowance is used.
  // (An intake trigger is not held by this guard: its tickets are one item each, and a label event counts once, so a new label right after a task ended is a new ask, not an echo of it.)
  if (!isIntakeTrigger(trigger) && await recentlyStarted(work, trigger)) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "recent_subject" }) };
  // 4 and 5. The trigger's allowance for the hour (never above the platform's), then the org's for the day. An intake trigger (Rovara Code asked for by a label) counts them only when a member's
  // start is about to start work (`admit`, below): an outsider's label that only waits, or a repeat, must not use the allowance other agents' triggers share, and the work is the member's own.
  const intakeTrigger = isIntakeTrigger(trigger);
  const allowance = async (): Promise<"rate_limited" | "org_daily_limit" | undefined> => {
    const now = new Date(deps.now()).toISOString();
    const allowed = Number.isInteger(trigger.maxRunsPerHour) ? Math.min(trigger.maxRunsPerHour, TRIGGER_MAX_RUNS_PER_HOUR) : 0;
    if (!await countOne(deps, triggerRateKey(orgId, trigger.triggerId, now.slice(0, 13)), allowed, 2 * HOUR_SECONDS)) return "rate_limited";
    if (!await countOne(deps, orgAutonomousKey(orgId, now.slice(0, 10)), ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, 2 * DAY_SECONDS)) return "org_daily_limit";
    return undefined;
  };
  if (!intakeTrigger) {
    const used = await allowance();
    if (used !== undefined) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: used }) };
  }
  // 6. The start. A refusal is a recorded outcome; a fault that may pass is the event's to be sent again.
  let started: { runId?: string; taskId?: string };
  try {
    if (isIntakeTrigger(trigger)) {
      // Rovara Code asked for by a label or an assignment: the intake engine decides from who did it (a member starts it, anyone else makes it wait).
      const result = await startIntakeFor(deps.intake, orgId, event, async () => await allowance() === undefined);
      if (result.outcome !== "started") return { outcome: await settle(work, trigger, result) };
      started = { taskId: result.taskId };
    } else {
      const source = eventSourceOf(event, trigger.triggerId);
      started = trigger.target.kind === "chain" ? await startChainFor(deps, orgId, trigger, identity, source) : await startAgentFor(deps, orgId, trigger, identity, source);
    }
  } catch (error) {
    const refusal = await refusalOf(deps, orgId, trigger, error);
    if ("transient" in refusal) {
      work.log("trigger_dispatch.start_failed", { orgId, triggerId: trigger.triggerId, error: errorName(refusal.transient) });
      return { transient: refusal.transient };
    }
    return { outcome: await settle(work, trigger, { outcome: "failed", reason: refusal.reason }) };
  }
  // The start happened: whatever goes wrong in writing it down, the run is noted on the trigger and its subject, and the fault is the event's to be sent again for.
  try {
    return { outcome: await settle(work, trigger, { outcome: "started", ...started }) };
  } finally {
    await noteSubject(work, trigger);
    await noteFired(work, trigger, started);
  }
}

/**
 * Starts the work of every trigger the event is for: enabled triggers of this org, project, source and hook (and no other's: nothing outside the org's keys is read) whose type
 * is the event's and whose every filter key has one of its values among the event's. Answers what each did. Throws when a start failed in a way that may pass, after every
 * other trigger has been tried, so that the vendor's retry starts what was not started and (by the event's identity) nothing twice.
 */
export async function dispatchTriggerEvent(deps: TriggerDispatchDependencies, orgId: OrgId, input: TriggerEvent, context: TriggerDispatchContext = {}): Promise<DispatchOutcome[]> {
  const log = logOf(deps);
  const parsed = TriggerEventSchema.safeParse(input);
  if (!parsed.success) {
    log("trigger_dispatch.event_invalid", { orgId });
    return [];
  }
  const event = parsed.data;
  // GitHub's events come through the app and have no hook; every other source's come through one hook. An event that is neither would read the wrong index.
  if ((event.source === "github") !== (event.hookId === undefined)) {
    log("trigger_dispatch.hook_mismatch", { orgId, source: event.source });
    return [];
  }
  if (deps.triggers === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "triggers are not set up in this deployment");
  const work: Work = { deps, orgId, event, log, actors: new Map(), context, misses: [] };
  const outcomes: DispatchOutcome[] = [];
  let transient: { error: unknown } | undefined;
  let unreadable = 0;
  const found = await deps.triggers.listForMatch(orgId, event.source, event.project, event.hookId, (triggerId) => {
    unreadable += 1;
    log("trigger_dispatch.record_unreadable", { orgId, triggerId });
  });
  if (unreadable > 0) log("trigger_dispatch.records_skipped", { orgId, count: unreadable });
  for (const trigger of found) {
    try {
      if (!isForExceptFilter(trigger, orgId, event) || !await meetsTriggerFilter(work, trigger)) continue;
      const done = await dispatchOne(work, trigger);
      if ("outcome" in done) outcomes.push(done.outcome);
      else transient ??= { error: done.transient };
    } catch (error) {
      log("trigger_dispatch.failed", { orgId, triggerId: trigger.triggerId, error: errorName(error) });
      transient ??= { error };
    }
  }
  if (transient !== undefined) throw transient.error;
  // Nothing started and nothing was recorded: say which triggers were for the event but did not meet their filter, and with what (GitHub's association words and a code, never the sender's text).
  if (outcomes.length === 0) {
    const association = (event.fields[AUTHOR_KEY] ?? []).filter((value) => /^[A-Z_]{1,24}$/.test(value)).slice(0, 4);
    for (const miss of work.misses) {
      log("trigger_dispatch.filter_miss", { orgId, project: event.project, triggerId: miss.triggerId, type: event.type, filterKeys: miss.filterKeys, authorAssociation: association, membership: miss.membership });
    }
  }
  return outcomes;
}
