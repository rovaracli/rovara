// 0.5.15: when each health check last ran for a company. Four small items in the state table, under the company's own settings partition (`orgSettingsKey`),
// each overwritten in place: the last model source check, the last Slack probe, the last GitHub App check, and the last time the main model and a fallback ran.
// A check writes its item when it completes, best effort: a write that fails never fails the check it describes (it is logged by error name only). Nothing here holds a
// person, a model name, a token or a host; a time, a result word and a fixed fallback reason code.
// The read is for a company owner or admin on a browser session, for the company in that session only. A feature with no item reads "never checked".
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ModelFallbackReasonCodeSchema, OrgIdSchema, agentXError, type ModelFallback, type OrgId, type SlackAuthCheckResponse } from "@rovara-code/contracts";
import { HEALTH_CHECK_RESULTS, HEALTH_MODEL_USE_WINDOW_HOURS, HEALTH_REFRESH_AFTER_SECONDS, OrgHealthObservationsResponseSchema, orgSettingsKey, type HealthCheckObservation, type HealthCheckResult, type HealthModelUseObservation, type OrgHealthObservationsResponse, type OrgSettingName } from "@agentx/cloud-contracts";
import { requireLiveCompanyAdmin, type CompanyAuthorityDependencies, type CompanyViewer } from "./company-authority.js";

/** The three features that have one check each. */
export type HealthCheckFeature = "model_source" | "slack" | "github";
const CHECK_ITEM: Record<HealthCheckFeature, OrgSettingName> = { model_source: "HEALTH_MODEL_SOURCE_CHECK", slack: "HEALTH_SLACK_PROBE", github: "HEALTH_GITHUB_CHECK" };
/** How often a main-model run may rewrite its item: every model-governed step would otherwise write one. */
const MAIN_WRITE_EVERY_MS = 60_000;
/** The longest a health write may hold up the task start, the terminal result or the check it describes. */
export const HEALTH_WRITE_TIMEOUT_MS = 1_500;

export interface HealthObservationWriter { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now?: () => number; /** For tests: the write's time limit. Default `HEALTH_WRITE_TIMEOUT_MS`. */ timeoutMs?: number }
export type HealthModelUse = { kind: "main" } | { kind: "fallback"; reason: ModelFallback["reasonCode"] };
/** What a committed step says about the model that ran it: the company and which model. */
export interface ModelUseObservation { orgId: OrgId; use: HealthModelUse }

function logFailure(what: string, error: unknown): void {
  // The error's name only: its words could hold an id or a host.
  console.log(JSON.stringify({ component: "broker", event: "health_observation.write_failed", what, errorName: error instanceof Error ? error.name : "unknown" }));
}

/** Runs one health write for at most its time limit, and never throws: a slow, hung or failing table costs the caller at most the limit and a log line. */
async function bounded(deps: HealthObservationWriter, what: string, write: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([write(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("health write timed out"), { name: "HealthWriteTimeout" })), deps.timeoutMs ?? HEALTH_WRITE_TIMEOUT_MS); })]);
  } catch (error) {
    logFailure(what, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fallback count of a window: the window opens at the first fallback and ends 24 hours later; the next fallback after it starts a new one at 1. An increment is
 * conditional on the window being open and a reset on it being over, so two writers never both reset, and one that loses retries as an increment.
 */
async function countFallback(deps: HealthObservationWriter, orgId: OrgId, now: number): Promise<void> {
  const base = { TableName: deps.tableName, Key: orgSettingsKey(orgId, "HEALTH_MODEL_USE") };
  const at = new Date(now).toISOString(), cutoff = new Date(now - HEALTH_MODEL_USE_WINDOW_HOURS * 3600_000).toISOString();
  const values = { ":type": "HEALTH_OBSERVATION", ":org": orgId, ":cutoff": cutoff };
  const increment = () => deps.documentClient.send(new UpdateCommand({ ...base, UpdateExpression: "SET entityType = :type, orgId = :org ADD fallbackCount :one", ConditionExpression: "fallbackWindowStartedAt > :cutoff", ExpressionAttributeValues: { ...values, ":one": 1 } }));
  const reset = () => deps.documentClient.send(new UpdateCommand({ ...base, UpdateExpression: "SET entityType = :type, orgId = :org, fallbackWindowStartedAt = :at, fallbackCount = :one", ConditionExpression: "attribute_not_exists(fallbackWindowStartedAt) OR fallbackWindowStartedAt <= :cutoff", ExpressionAttributeValues: { ...values, ":at": at, ":one": 1 } }));
  try { await increment(); return; } catch (error) { if (!isConditionFailure(error)) throw error; }
  try { await reset(); return; } catch (error) { if (!isConditionFailure(error)) throw error; }
  try { await increment(); } catch (error) { if (!isConditionFailure(error)) throw error; }
}

/** When this process last tried a main-model write for a company, by client: a hot path writes nothing at all inside the minute. */
const lastMainWrite = new WeakMap<object, Map<string, number>>();
const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

/** Records that a check of `feature` for `orgId` completed now with `result`. Best effort, bounded: never throws. */
export async function recordHealthCheck(deps: HealthObservationWriter, orgId: OrgId, feature: HealthCheckFeature, result: HealthCheckResult): Promise<void> {
  await bounded(deps, feature, async () => {
    const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
    // An update, not a put: the item may hold a refresh claim (below) that must outlive this write, or a burst could claim again the moment a probe is recorded.
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: orgSettingsKey(orgId, CHECK_ITEM[feature]), UpdateExpression: "SET entityType = :type, orgId = :org, feature = :feature, checkedAt = :at, #result = :result", ExpressionAttributeNames: { "#result": "result" }, ExpressionAttributeValues: { ":type": "HEALTH_OBSERVATION", ":org": orgId, ":feature": feature, ":at": checkedAt, ":result": result } }));
  });
}

/**
 * Records that a step of `orgId` ran on its main model, or on a fallback, now. Best effort, bounded: never throws. A main-model run writes at most once a minute per
 * process (the guard skips the call) and per company (the condition); a fallback only ever moves its time forward.
 */
export async function recordModelUse(deps: HealthObservationWriter, orgId: OrgId, use: HealthModelUse): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const at = new Date(now).toISOString();
  const base = { TableName: deps.tableName, Key: orgSettingsKey(orgId, "HEALTH_MODEL_USE") };
  if (use.kind === "main") {
    const seen = lastMainWrite.get(deps.documentClient) ?? new Map<string, number>();
    lastMainWrite.set(deps.documentClient, seen);
    const before = seen.get(orgId);
    if (before !== undefined && now >= before && now - before < MAIN_WRITE_EVERY_MS) return;
    seen.set(orgId, now);
  }
  await bounded(deps, "model_use", async () => {
    if (use.kind === "fallback") await countFallback(deps, orgId, now);
    try {
      await deps.documentClient.send(new UpdateCommand(use.kind === "fallback"
        ? { ...base, UpdateExpression: "SET entityType = :type, orgId = :org, lastFallbackAt = :at, lastFallbackReason = :reason", ConditionExpression: "attribute_not_exists(lastFallbackAt) OR lastFallbackAt < :at", ExpressionAttributeValues: { ":type": "HEALTH_OBSERVATION", ":org": orgId, ":at": at, ":reason": use.reason } }
        : { ...base, UpdateExpression: "SET entityType = :type, orgId = :org, lastMainAt = :at", ConditionExpression: "attribute_not_exists(lastMainAt) OR lastMainAt < :before", ExpressionAttributeValues: { ":type": "HEALTH_OBSERVATION", ":org": orgId, ":at": at, ":before": new Date(now - MAIN_WRITE_EVERY_MS).toISOString() } }));
    } catch (error) {
      // A newer time is already there (or, for main, one written less than a minute ago): the item already says so.
      if (!isConditionFailure(error)) throw error;
    }
  });
}

type Row = Record<string, unknown> | undefined;
const instant = (value: unknown, now: number): { at: string; age: number } | undefined => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  // A time that does not read back as the same instant is a damaged item, not a check.
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return undefined;
  return { at: value, age: Math.max(0, Math.floor((now - time) / 1000)) };
};
/** An item counts only when it is the company's own (its stored org is the reader's): anything else reads as never checked. */
const ownRow = (row: Row, orgId: OrgId): Row => (row !== undefined && row.orgId === orgId ? row : undefined);

function checkObservation(row: Row, now: number): HealthCheckObservation {
  const when = instant(row?.checkedAt, now);
  const result = (HEALTH_CHECK_RESULTS as readonly unknown[]).includes(row?.result) ? row?.result as HealthCheckResult : undefined;
  return when === undefined || result === undefined ? { checked: false } : { checked: true, checkedAt: when.at, ageSeconds: when.age, result };
}

/** The fallbacks counted in the window that is still open; zero when it is over, never written or damaged. */
function fallbackCountOf(row: Row, now: number): number {
  const opened = instant(row?.fallbackWindowStartedAt, now), count = row?.fallbackCount;
  return opened !== undefined && opened.age < HEALTH_MODEL_USE_WINDOW_HOURS * 3600 && typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function modelUseObservation(row: Row, now: number): HealthModelUseObservation {
  const main = instant(row?.lastMainAt, now), fallback = instant(row?.lastFallbackAt, now);
  if (main === undefined && fallback === undefined) return { checked: false };
  const window = HEALTH_MODEL_USE_WINDOW_HOURS * 3600;
  const reason = ModelFallbackReasonCodeSchema.safeParse(row?.lastFallbackReason);
  return {
    checked: true, windowHours: HEALTH_MODEL_USE_WINDOW_HOURS, usedMain: main !== undefined && main.age < window, usedFallback: fallback !== undefined && fallback.age < window,
    fallbackCount: fallbackCountOf(row, now),
    ...(main === undefined ? {} : { lastMainAt: main.at, lastMainAgeSeconds: main.age }),
    ...(fallback === undefined ? {} : { lastFallbackAt: fallback.at, lastFallbackAgeSeconds: fallback.age, ...(reason.success ? { lastFallbackReason: reason.data } : {}) }),
  };
}

/** The probes a read may run to refresh a stale Slack or GitHub observation: the same two the health route runs. A probe left out is never run, and its observation stays as stored. */
export interface HealthRefreshProbes {
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
  /** The environment's Slack team: a token that works for another team is a failed check, as in the health route. */
  slackTeamId?: string | undefined;
  githubInstallations?: () => Promise<number>;
  /** The longest one probe may take. Default `HEALTH_PROBE_TIMEOUT_MS`. */
  probeTimeoutMs?: number;
  /** The longest a claim or a write may take (see `HealthObservationWriter.timeoutMs`). */
  writeTimeoutMs?: number;
}
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;
export interface HealthObservationReadDependencies extends CompanyAuthorityDependencies { now(): number; probes?: HealthRefreshProbes }

class ProbeTimeout extends Error {}
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), ms); })]); } finally { clearTimeout(timer); }
}

/**
 * Takes the right to probe `feature` for the company: one claim per company and feature per refresh period, by a conditional write on the claim's time. Taking it fails
 * closed: a claim that is refused, errors or is slow means no probe.
 */
async function claimRefresh(deps: HealthObservationReadDependencies, orgId: OrgId, feature: HealthCheckFeature, now: number): Promise<boolean> {
  const before = new Date(now - HEALTH_REFRESH_AFTER_SECONDS * 1000).toISOString();
  try {
    await within(deps.probes?.writeTimeoutMs ?? HEALTH_WRITE_TIMEOUT_MS, deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: orgSettingsKey(orgId, CHECK_ITEM[feature]),
      UpdateExpression: "SET entityType = :type, orgId = :org, feature = :feature, refreshClaimedAt = :now", ConditionExpression: "attribute_not_exists(refreshClaimedAt) OR refreshClaimedAt < :before",
      ExpressionAttributeValues: { ":type": "HEALTH_OBSERVATION", ":org": orgId, ":feature": feature, ":now": new Date(now).toISOString(), ":before": before },
    })));
    return true;
  } catch (error) {
    if (!isConditionFailure(error)) logFailure(`${feature}_claim`, error);
    return false;
  }
}

const slackResult = (answer: SlackAuthCheckResponse, team: string | undefined): HealthCheckResult => (answer.ok
  ? (team !== undefined && answer.teamId !== team ? "failed" : "ok")
  : (answer.error === "slack_unavailable" ? "unknown" : "failed"));

/**
 * Checks `feature` again when its observation is missing or older than the refresh period, for this company only: claim, probe within its time limit, record the answer
 * (bounded) and return it fresh. A probe that is not set up, a claim someone else holds, a probe that is slow or a company that has a fresh observation returns nothing,
 * and the stored value stands. A probe that fails outright is recorded as `unknown`.
 */
async function refreshOne(deps: HealthObservationReadDependencies, orgId: OrgId, feature: HealthCheckFeature, stored: HealthCheckObservation, now: number): Promise<HealthCheckObservation | undefined> {
  const probes = deps.probes;
  const probe = feature === "slack" && probes?.slackAuthCheck !== undefined ? async () => slackResult(await probes.slackAuthCheck!(), probes.slackTeamId)
    : feature === "github" && probes?.githubInstallations !== undefined ? async () => ((await probes.githubInstallations!()) === 0 ? "failed" as const : "ok" as const)
    : undefined;
  if (probe === undefined || (stored.checked && stored.ageSeconds < HEALTH_REFRESH_AFTER_SECONDS)) return undefined;
  if (!await claimRefresh(deps, orgId, feature, now)) return undefined;
  let result: HealthCheckResult;
  try { result = await within(probes?.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS, probe()); }
  catch (error) {
    if (error instanceof ProbeTimeout) return undefined;
    result = "unknown";
  }
  await recordHealthCheck({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => now, ...(probes?.writeTimeoutMs === undefined ? {} : { timeoutMs: probes.writeTimeoutMs }) }, orgId, feature, result);
  return { checked: true, checkedAt: new Date(now).toISOString(), ageSeconds: 0, result };
}


/** `GET /v1/app/org/health-observations`: the aged observations for the caller's own company; a live owner or admin on a browser session only. */
export async function readOrgHealthObservations(deps: HealthObservationReadDependencies, caller: CompanyViewer, request: { expectedOrgId: unknown }): Promise<OrgHealthObservationsResponse> {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session for health check times.");
  // The company is the session's. A page that names another company is out of date or wrong, and nothing of that company is read.
  if (!OrgIdSchema.safeParse(request.expectedOrgId).success || request.expectedOrgId !== caller.orgId) throw agentXError("CHANGE_STALE", "Refresh your company before reading health check times.");
  await requireLiveCompanyAdmin(deps, caller);
  const orgId = caller.orgId;
  const read = async (name: OrgSettingName): Promise<Row> => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgSettingsKey(orgId, name), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  let rows: Row[];
  try { rows = await Promise.all((["HEALTH_MODEL_SOURCE_CHECK", "HEALTH_MODEL_USE", "HEALTH_SLACK_PROBE", "HEALTH_GITHUB_CHECK"] as const).map(read)); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "Health check times could not be read. Try again later."); }
  const now = deps.now();
  const [source, use, slackRow, githubRow] = rows.map((row) => ownRow(row, orgId));
  // Stale or never-made Slack and GitHub observations are checked again now, side by side, and the answer carries what they found.
  const [slackStored, githubStored] = [checkObservation(slackRow, now), checkObservation(githubRow, now)];
  const [slack, github] = await Promise.all([refreshOne(deps, orgId, "slack", slackStored, now), refreshOne(deps, orgId, "github", githubStored, now)]);
  await requireLiveCompanyAdmin(deps, caller);
  return OrgHealthObservationsResponseSchema.parse({ orgId, readAt: new Date(now).toISOString(), modelSource: checkObservation(source, now), modelUse: modelUseObservation(use, now), slack: slack ?? slackStored, github: github ?? githubStored });
}
