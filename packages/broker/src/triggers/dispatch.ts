// Plan 4 Task 20: an event starts paid work with no person watching, so everything is decided here, at the moment of the event, from what is stored now and not from what was true
// when the trigger was saved. In order, for each enabled trigger of the receiving org, project, source and hook whose type and filter the event meets:
//   1. the loop guard (what Rovara itself did never starts work); 2. the requirements, read live (any problem turns the trigger off); 3. the event's identity (one run per event, however
//   often it arrives); 4. the trigger's allowance for the hour; 5. the org's allowance for the day; 6. the start, as the owner the run needs. A refusal is recorded by its code, never by
//   its words; a fault that may pass is thrown after the other triggers have been tried, so the vendor sends the event again and the identity makes the repeat harmless.
// Nothing in a log line is text the sender wrote: only ids, an outcome and a code.
import { createHash } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  CHAIN_MAX_CONCURRENT_RUNS,
  INDEX_EXPIRY_ATTRIBUTE,
  ORG_MAX_AUTONOMOUS_RUNS_PER_DAY,
  TRIGGER_MAX_RUNS_PER_HOUR,
  TriggerEventSchema,
  agentXError,
  isBuiltinAgentId,
  orgAutonomousKey,
  triggerRateKey,
  triggerSummary as eventSummary,
  type AgentId,
  type EventSource,
  type OrgId,
  type TriggerEvent,
  type TriggerOutcome,
} from "@agentx/contracts";
import { readRunRequest } from "../agents/runs.js";
import { resolveAgentForAutonomousRun } from "../agents/roster.js";
import type { AgentRecord } from "../agents/store.js";
import { buildHandoff, type HandoffTrigger } from "../chains/handoff.js";
import { readChainRun, startChainRun, type ChainRunnerDependencies } from "../chains/runner.js";
import { connectionActorIds } from "../connections/store.js";
import { resolvePayer } from "../spend/payer.js";
import { disableTrigger } from "./lifecycle.js";
import { triggerProblems } from "./requirements.js";
import type { TriggerRecord } from "./store.js";

export type TriggerDispatchDependencies = ChainRunnerDependencies & {
  /** The GitHub App's slug, to tell its own bot from a person (`<slug>[bot]`); without it GitHub's own events are told by the provider's `actor.kind` alone. */
  githubAppSlug?: () => Promise<string | undefined>;
};

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
 * The accounts of Rovara's own that an event's actor is told from, per source: GitHub's `<appSlug>[bot]`, and for Linear and Jira the account each connection's check recorded.
 * Other sources have no account of Rovara's, so none.
 */
export async function rovaraActorIds(deps: Pick<TriggerDispatchDependencies, "documentClient" | "tableName" | "githubAppSlug">, orgId: OrgId, source: EventSource): Promise<Set<string>> {
  if (source === "github") {
    const slug = await deps.githubAppSlug?.();
    return slug === undefined || slug === "" ? new Set() : new Set([`${slug}[bot]`]);
  }
  if (source === "linear" || source === "jira") return connectionActorIds(deps, orgId, source);
  return new Set();
}

/** Who a custom agent's runs are owned by: its member owner, or the accountable maintainer of a project's agent. A project's agent with none has no one to run as, so nothing runs. */
export function runOwnerFor(agent: Pick<AgentRecord, "owner" | "accountable">): { developerId: string } {
  if (agent.owner.kind === "member") return { developerId: agent.owner.developerId };
  if (agent.accountable === undefined) throw agentXError("AGENT_UNAVAILABLE", "This agent has no accountable maintainer, so it can't run work that no person started.");
  return { developerId: agent.accountable.developerId };
}

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

/** Whether a stored trigger is one this event is for: the record itself says so, whatever the index it was found under. */
function isFor(trigger: TriggerRecord, orgId: OrgId, event: TriggerEvent): boolean {
  const { spec } = trigger;
  return trigger.orgId === orgId && trigger.enabled === true && trigger.project === event.project && spec.kind === "event" && spec.source === event.source && spec.type === event.type
    && trigger.hookId === event.hookId && meetsFilter(spec.filter, event.fields);
}

/** Counts one start against a limit in one conditional update; false when the limit is used up. */
async function countOne(deps: TriggerDispatchDependencies, key: { pk: string; sk: string }, max: number, lifetimeSeconds: number): Promise<boolean> {
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
async function refusalOf(work: Work, trigger: TriggerRecord, error: unknown): Promise<{ reason: string } | { transient: unknown }> {
  if (!(error instanceof AgentXError)) return { transient: error };
  // A service that is away (`RUNTIME_UNAVAILABLE` and its kind answer 503) may be back when the vendor sends the event again.
  if (error.statusCode >= 500) return { transient: error };
  if (BUSY_CODES.has(error.code)) return { reason: "busy" };
  if (error.code === "FORBIDDEN" && trigger.target.kind === "chain") {
    // The chain's concurrency refusal has no code of its own: it is the one that leaves the chain with its most runs open.
    const chain = await work.deps.chains.get(work.orgId, trigger.target.chainId);
    if (chain !== undefined && chain.openRuns >= CHAIN_MAX_CONCURRENT_RUNS) return { reason: "busy" };
  }
  return { reason: error.code };
}

async function startChain(work: Work, trigger: TriggerRecord, identity: string): Promise<{ runId: string }> {
  const { deps, orgId, event } = work;
  if (trigger.target.kind !== "chain") throw new Error("not a chain trigger");
  const chain = await deps.chains.get(orgId, trigger.target.chainId);
  if (chain === undefined) throw agentXError("NOT_FOUND", "no chain has that ID");
  // A member's chain runs as its member; a project's, as the maintainer who turned the trigger on (who answers for what it does).
  const developerId = chain.owner.kind === "member" ? chain.owner.developerId : trigger.createdBy;
  const run = await startChainRun(deps, { system: "event", owner: { developerId } }, {
    orgId, chainId: chain.chainId, project: event.project, origin: "event",
    startedBy: { kind: "event", triggerId: trigger.triggerId, eventKey: event.eventKey, source: event.source, type: event.type, title: event.subject.title, ...(event.subject.url === undefined ? {} : { url: event.subject.url }) },
    trigger: handoffOf(event), input: eventSummary(event), runId: runIdFor(identity), requestId: requestIdFor(identity),
  });
  return { runId: run.runId };
}

async function startAgent(work: Work, trigger: TriggerRecord, identity: string): Promise<{ taskId: string }> {
  const { deps, orgId, event } = work;
  if (trigger.target.kind !== "agent") throw new Error("not an agent trigger");
  if (deps.chainRuns === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "runs are not set up in this deployment");
  const agentId: AgentId = trigger.target.agentId;
  const record = isBuiltinAgentId(agentId) ? await deps.store.ensureBuiltinSettings(orgId, agentId) : await deps.store.get(orgId, agentId);
  if (record === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
  const { ref } = await resolveAgentForAutonomousRun(deps, { orgId, project: event.project, agentId });
  if (ref.version === "draft") throw agentXError("AGENT_UNAVAILABLE", "an autonomous run uses a published version");
  // A built-in has no owner of its own: the maintainer who turned the trigger on is who its runs act for.
  const owner = isBuiltinAgentId(agentId) ? { developerId: trigger.createdBy } : runOwnerFor(record as AgentRecord);
  const context = buildHandoff({ runId: identity.slice(0, 20), trigger: handoffOf(event), earlier: [], mode: "previous" });
  // `resolvePayer` names the agent for an event whatever the project's setting says, so `projectPays` is not read here.
  const payer = resolvePayer({ origin: "event", project: event.project, projectPays: false, agentId });
  const started = await deps.chainRuns.startAgentRun({
    requestId: requestIdFor(identity), orgId, project: event.project, agent: { agentId, version: ref.version },
    input: { text: EVENT_TEXT, ...(context.length === 0 ? {} : { context }) }, origin: "event", owner, payer,
  });
  return { taskId: started.taskId };
}

/** One trigger, one event. Returns its outcome, or throws what may pass so that the event is sent again. */
async function dispatchOne(work: Work, trigger: TriggerRecord): Promise<{ outcome: DispatchOutcome } | { transient: unknown }> {
  const { deps, orgId, event } = work;
  // 1. The loop guard, before anything is read or counted: what Rovara did never starts what Rovara does.
  if (await causedByRovara(work)) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "caused_by_rovara" }) };
  // 2. What the trigger needs, read now. Any problem turns it off, tells its owners and starts nothing; no allowance is used.
  const problems = await triggerProblems(deps, trigger);
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
  // 4 and 5. The trigger's allowance for the hour (never above the platform's), then the org's for the day.
  const now = new Date(deps.now()).toISOString();
  const allowed = Number.isInteger(trigger.maxRunsPerHour) ? Math.min(trigger.maxRunsPerHour, TRIGGER_MAX_RUNS_PER_HOUR) : 0;
  if (!await countOne(deps, triggerRateKey(orgId, trigger.triggerId, now.slice(0, 13)), allowed, 2 * HOUR_SECONDS)) {
    return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "rate_limited" }) };
  }
  if (!await countOne(deps, orgAutonomousKey(orgId, now.slice(0, 10)), ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, 2 * DAY_SECONDS)) {
    return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "org_daily_limit" }) };
  }
  // 6. The start. A refusal is a recorded outcome; a fault that may pass is the event's to be sent again.
  let started: { runId?: string; taskId?: string };
  try {
    started = trigger.target.kind === "chain" ? await startChain(work, trigger, identity) : await startAgent(work, trigger, identity);
  } catch (error) {
    const refusal = await refusalOf(work, trigger, error);
    if ("transient" in refusal) {
      work.log("trigger_dispatch.start_failed", { orgId, triggerId: trigger.triggerId, error: errorName(refusal.transient) });
      return { transient: refusal.transient };
    }
    return { outcome: await settle(work, trigger, { outcome: "failed", reason: refusal.reason }) };
  }
  const outcome = await settle(work, trigger, { outcome: "started", ...started });
  await noteFired(work, trigger, started);
  return { outcome };
}

/**
 * Starts the work of every trigger the event is for: enabled triggers of this org, project, source and hook (and no other's: nothing outside the org's keys is read) whose type
 * is the event's and whose every filter key has one of its values among the event's. Answers what each did. Throws when a start failed in a way that may pass, after every
 * other trigger has been tried, so that the vendor's retry starts what was not started and (by the event's identity) nothing twice.
 */
export async function dispatchTriggerEvent(deps: TriggerDispatchDependencies, orgId: OrgId, input: TriggerEvent): Promise<DispatchOutcome[]> {
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
  const work: Work = { deps, orgId, event, log, actors: new Map() };
  const outcomes: DispatchOutcome[] = [];
  let transient: { error: unknown } | undefined;
  for (const trigger of await deps.triggers.listForMatch(orgId, event.source, event.project, event.hookId)) {
    if (!isFor(trigger, orgId, event)) continue;
    try {
      const done = await dispatchOne(work, trigger);
      if ("outcome" in done) outcomes.push(done.outcome);
      else transient ??= { error: done.transient };
    } catch (error) {
      log("trigger_dispatch.failed", { orgId, triggerId: trigger.triggerId, error: errorName(error) });
      transient ??= { error };
    }
  }
  if (transient !== undefined) throw transient.error;
  return outcomes;
}
