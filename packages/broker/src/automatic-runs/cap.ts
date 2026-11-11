// The project's monthly cap on automatic runs (owner decision 2026-11-02): the project PAYS for the runs its system owner starts (nightly, saved-image rebuilds, scheduled checks), shown as its own "Automatic runs" line. A
// sensible default cap (`DEFAULT_AUTOMATIC_RUNS_PER_MONTH`) pauses the project's automatic runs when it is hit; a maintainer edits it (audited); the project page says so.
//
// What is counted is RUNS STARTED this UTC month: an automatic run mints no model key today (no job asks one, and the system owner is refused any), so a run count is what a cap can hold to now. Enterprise installs keep their
// dollar view in the spend ledger; a ledger-denominated cap is a follow-up (DEFERRED-CHECKS SO-1).
// Data (all under the project's partition, kept with a TTL):
//   AUTOMATIC_RUNS#SETTINGS            the cap a maintainer set, who and when, and the request ids already applied (a replay changes nothing)
//   AUTOMATIC_RUNS#MONTH#YYYY-MM       the month's count of runs started
//   AUTOMATIC_RUNS#RUN#<requestId>     one per run claimed, so a retried start counts once and a run that never started gives its place back
//   AUTOMATIC_RUNS#STARTED#<hash>      one per run that started (job, when, its task), for the project page
//   AUTOMATIC_RUNS#PAUSED#YYYY-MM      written once, with the pause's audit event, when the cap is first reached in the month
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_AUTOMATIC_RUNS_PER_MONTH, INDEX_EXPIRY_ATTRIBUTE, MAX_AUTOMATIC_RUNS_PER_MONTH, agentXError, projectAllows, projectPk, type AutomaticJob, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { auditAutomaticRunsPaused, auditOccurrence, auditProjectAutomaticRunsCapChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent } from "../audit/outbox.js";
import type { TestEnvDeps } from "../org/test-environment.js";

const DAY_MS = 86_400_000;
const SETTINGS_SK = "AUTOMATIC_RUNS#SETTINGS";
/** The prefix of the item kept for each run that started (its job, when, and its task), for the project page. */
export const AUTOMATIC_RUNS_STARTED_PREFIX = "AUTOMATIC_RUNS#STARTED#";
const SETTING_REQUESTS_KEPT = 20;
const WRITE_ATTEMPTS = 3;
const CLAIM_ATTEMPTS = 3;
const CLAIM_BACKOFF_MS = 20;
const monthSk = (month: string) => `AUTOMATIC_RUNS#MONTH#${month}`;
const key = (orgId: OrgId, project: string, sk: string) => ({ pk: projectPk(orgId, project), sk });
const iso = (ms: number) => new Date(ms).toISOString();
export const monthOf = (ms: number): string => iso(ms).slice(0, 7);
const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

async function get(deps: TestEnvDeps, k: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: k, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

const wholeCap = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_AUTOMATIC_RUNS_PER_MONTH;

/** The project's monthly cap: what a maintainer set, else the default. A stored cap that is not a whole number in range reads as the default (a damaged row never lifts the cap or stops every run). */
export async function readAutomaticRunsCap(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<{ cap: number; isDefault: boolean }> {
  const stored = await get(deps, key(orgId, project, SETTINGS_SK));
  return wholeCap(stored?.monthlyCap) ? { cap: stored.monthlyCap, isDefault: false } : { cap: DEFAULT_AUTOMATIC_RUNS_PER_MONTH, isDefault: true };
}

export interface AutomaticRunsUse { month: string; cap: number; capIsDefault: boolean; used: number; paused: boolean }

/** What the project page says: this month's runs against the cap, and whether the cap has paused them. */
export async function readAutomaticRunsUse(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<AutomaticRunsUse> {
  const month = monthOf(deps.now());
  const [{ cap, isDefault }, counter] = await Promise.all([readAutomaticRunsCap(deps, orgId, project), get(deps, key(orgId, project, monthSk(month)))]);
  const used = typeof counter?.count === "number" && Number.isInteger(counter.count) && counter.count > 0 ? counter.count : 0;
  return { month, cap, capIsDefault: isDefault, used, paused: used >= cap };
}

export type AutomaticRunClaim = { claimed: true; used: number; cap: number; replay: boolean } | { claimed: false; used: number; cap: number };

/**
 * Takes one place of the month for a run, once per `requestId`: the run's claim and the month's count commit together, and only while the count is under the cap. A claim already made (a retried start) answers as
 * claimed and counts nothing more. When the cap is what refuses, the pause is recorded once for the month with its audit event.
 */
export async function claimAutomaticRun(deps: TestEnvDeps, input: { orgId: OrgId; project: string; requestId: string; job: AutomaticJob }): Promise<AutomaticRunClaim> {
  const now = deps.now();
  const month = monthOf(now);
  const { cap } = await readAutomaticRunsCap(deps, input.orgId, input.project);
  const expires = Math.floor((now + 62 * DAY_MS) / 1000);
  const counter = key(input.orgId, input.project, monthSk(month));
  const claim = key(input.orgId, input.project, `AUTOMATIC_RUNS#RUN#${input.requestId}`);
  // A retried start whose claim is already there is counted once and answered as claimed, whatever the cap is now (a maintainer may have lowered it since: the run exists). This comes BEFORE the cap-0 refusal.
  if (await get(deps, claim) !== undefined) return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: true };
  // A cap of 0 pauses them all. The counter's own test ("no count yet, or under the cap") would let the month's FIRST run through, because a month with no count has no row to compare, so 0 is refused here.
  if (cap < 1) {
    await recordPause(deps, input.orgId, input.project, month, cap);
    return { claimed: false, used: await countOf(deps, input.orgId, input.project, month), cap };
  }
  const items = [
    { Put: { TableName: deps.tableName, Item: { ...claim, entityType: "AUTOMATIC_RUN_CLAIM", orgId: input.orgId, project: input.project, requestId: input.requestId, job: input.job, month, claimedAt: iso(now), [INDEX_EXPIRY_ATTRIBUTE]: expires }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: { TableName: deps.tableName, Key: counter, UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), orgId = :org, #project = :project, #month = :month, #expiry = :expires ADD #count :one",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
      ExpressionAttributeNames: { "#count": "count", "#project": "project", "#month": "month", "#expiry": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":entity": "AUTOMATIC_RUNS_MONTH", ":org": input.orgId, ":project": input.project, ":month": month, ":expires": expires, ":one": 1, ":cap": cap } } },
  ];
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: false };
    } catch (error) {
      if (errorName(error) !== "TransactionCanceledException") throw error;
      // What cancelled it, item by item (the order of `items`): only the COUNTER's own failed condition is the cap. Another reason (a conflict with a concurrent write, a throttle) is not the cap, so it
      // never pauses anything and never writes the pause: it is tried again, and then told as a fault that may pass.
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
      const claimFailed = reasons?.[0]?.Code === "ConditionalCheckFailed";
      const counterFailed = reasons?.[1]?.Code === "ConditionalCheckFailed";
      // This request's claim is already there (a retried start): counted once, whatever the count is now.
      if (claimFailed && await get(deps, claim) !== undefined) return { claimed: true, used: await countOf(deps, input.orgId, input.project, month), cap, replay: true };
      if (counterFailed && !claimFailed) {
        await recordPause(deps, input.orgId, input.project, month, cap);
        return { claimed: false, used: await countOf(deps, input.orgId, input.project, month), cap };
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_BACKOFF_MS * 2 ** attempt));
    }
  }
  throw agentXError("WORKSPACE_BUSY", "the project's automatic-run count was busy; the run was not started, try again with the same request_id");
}

async function countOf(deps: TestEnvDeps, orgId: OrgId, project: string, month: string): Promise<number> {
  const counter = await get(deps, key(orgId, project, monthSk(month)));
  return typeof counter?.count === "number" ? counter.count : 0;
}

/** The pause, once per month, with its audit event in the same write. Best effort: the refusal stands whether or not this note could be written. */
async function recordPause(deps: TestEnvDeps, orgId: OrgId, project: string, month: string, cap: number): Promise<void> {
  const at = iso(deps.now());
  try {
    const event = await tryAuditEvent(deps, () => auditAutomaticRunsPaused({ orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: auditOccurrence(project, month), projectName: project, month, cap }));
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...key(orgId, project, `AUTOMATIC_RUNS#PAUSED#${month}`), entityType: "AUTOMATIC_RUNS_PAUSED", orgId, project, month, cap, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * DAY_MS) / 1000) }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...(event === undefined ? [] : auditPending(deps, event)),
    ] }));
    if (event !== undefined) await flushAuditEvents(deps, [event]);
  } catch { /* already noted this month (the marker exists), or the note could not be written: the refusal does not depend on it */ }
}

/** Gives a claim back when the run was never started (the start failed, or the night could not run today). Best effort and idempotent: the claim is deleted only if it is there, and the count goes down only with it. */
export async function releaseAutomaticRun(deps: TestEnvDeps, input: { orgId: OrgId; project: string; requestId: string }): Promise<void> {
  const claim = key(input.orgId, input.project, `AUTOMATIC_RUNS#RUN#${input.requestId}`);
  const stored = await get(deps, claim).catch(() => undefined);
  if (typeof stored?.month !== "string") return;
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: deps.tableName, Key: claim, ConditionExpression: "attribute_exists(pk)" } },
    { Update: { TableName: deps.tableName, Key: key(input.orgId, input.project, monthSk(stored.month)), UpdateExpression: "ADD #count :minus", ConditionExpression: "#count > :zero", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":minus": -1, ":zero": 0 } } },
  ] })).catch(() => undefined);
}

/**
 * A maintainer sets the project's monthly cap on automatic runs (0 to 2000; 0 pauses them). Needs `edit_settings`. The change and its audit event commit together; the same `requestId` again changes nothing more.
 * Raising the cap lets paused runs go on at once (the next fire counts against the new cap).
 */
export async function setAutomaticRunsCap(deps: TestEnvDeps, input: { orgId: OrgId; project: string; role: ProjectRole | undefined; changedBy: string; cap: number; requestId: string }): Promise<AutomaticRunsUse> {
  if (input.role === undefined || !projectAllows(input.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change the monthly cap on automatic runs");
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(input.requestId)) throw agentXError("CONFIG_INVALID", "requestId: a request id of 8 to 64 letters, digits, - or _");
  if (!wholeCap(input.cap)) throw agentXError("CONFIG_INVALID", `cap: a whole number from 0 to ${String(MAX_AUTOMATIC_RUNS_PER_MONTH)}`);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const stored = await get(deps, key(input.orgId, input.project, SETTINGS_SK));
    const seen = Array.isArray(stored?.requestIds) ? stored.requestIds.filter((id): id is string => typeof id === "string") : [];
    if (seen.includes(input.requestId)) return readAutomaticRunsUse(deps, input.orgId, input.project);
    const before = wholeCap(stored?.monthlyCap) ? stored.monthlyCap : DEFAULT_AUTOMATIC_RUNS_PER_MONTH;
    const at = iso(deps.now());
    const event = await tryAuditEvent(deps, () => auditProjectAutomaticRunsCapChanged({
      orgId: input.orgId, actor: { kind: "member", id: input.changedBy }, occurredAt: at, occurrence: auditOccurrence(input.project, input.requestId), projectName: input.project, fromCap: before, toCap: input.cap,
    }));
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName,
          Item: { ...key(input.orgId, input.project, SETTINGS_SK), entityType: "AUTOMATIC_RUNS_SETTINGS", orgId: input.orgId, project: input.project, monthlyCap: input.cap, changedBy: input.changedBy, changedAt: at, lastRequestId: input.requestId, requestIds: [...seen, input.requestId].slice(-SETTING_REQUESTS_KEPT) },
          // Written only if no other change landed since it was read.
          ...(stored === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : typeof stored.lastRequestId === "string"
            ? { ConditionExpression: "lastRequestId = :last", ExpressionAttributeValues: { ":last": stored.lastRequestId } } : { ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(lastRequestId)" }) } },
        ...(event === undefined ? [] : auditPending(deps, event)),
      ] }));
    } catch (error) {
      if (errorName(error) === "TransactionCanceledException") continue;
      throw error;
    }
    if (event !== undefined) await flushAuditEvents(deps, [event]);
    return readAutomaticRunsUse(deps, input.orgId, input.project);
  }
  throw agentXError("CHANGE_STALE", "the cap changed while it was being updated; try again");
}
