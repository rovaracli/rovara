// Failure counters for the Health page (register SRL-6): an erase's delayed second pass that failed, and a source delete that no durable path accepted. Both used to be a log line only
// (`record.erase_sweep_failed`, `record.tombstone_failed`, `record.github_redelivery_*`), so nothing showed an admin that a delete was stuck. One small item per company, kind and hour holds a count and the time of the last
// failure: no person, no source id, no text, no error message. Items expire after two days; a company close removes them (`erase.ts`, WORKSPACE_PREFIXES). Writing is best effort and never
// fails the work that reported the failure.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TEAM_RECORD_ORG_DIRECTORY_PK, teamRecordPk, type OrgId } from "@agentx/contracts";
import { Aliases } from "../agents/table-writes.js";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const OPS_FAILURE_SK_PREFIX = "OPSFAIL#";
export type OpsFailureKind = "erase_sweep" | "tombstone";
const KINDS: readonly OpsFailureKind[] = ["erase_sweep", "tombstone"];

const HOUR_MS = 3_600_000;
/** What the Health page looks back over. */
export const OPS_FAILURE_WINDOW_MS = 24 * HOUR_MS;
const EXPIRY_SECONDS = 2 * 86_400;

export interface OpsFailures {
  /** Second passes of person erases that failed in the window. */
  eraseSweep: number;
  /** Source deletes (a deleted repository or comment) that no durable path accepted in the window. */
  tombstone: number;
  /**
   * SRL-5a: failures of the App-wide GitHub sweeps in the window (the hourly redelivery of failed delete webhooks, and the check that a recorded repository still exists): a list GitHub did not
   * answer, a delete given up on, a gap of deliveries that could not be read before GitHub forgot them, a repository removal no durable path took. These sweeps belong to no company, so every
   * company's Health shows the same count; it is present only when it is not zero.
   */
  githubSweep?: number;
  /** The time of the latest failure of any kind, when there is one. */
  lastAt?: string;
}

const hourOf = (nowMs: number): number => Math.floor(nowMs / HOUR_MS);
const keyOf = (orgId: OrgId, kind: OpsFailureKind, hour: number) => ({ pk: teamRecordPk(orgId), sk: `${OPS_FAILURE_SK_PREFIX}${kind}#${String(hour).padStart(9, "0")}` });

/** Counts one failure. Never throws: a counter that cannot be written costs the Health page one count, not the delete worker its run. */
export async function recordOpsFailure(table: TeamRecordTable, orgId: OrgId, kind: OpsFailureKind, nowMs: number): Promise<void> {
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: keyOf(orgId, kind, hourOf(nowMs)),
      UpdateExpression: `ADD ${aliases.name("count")} ${aliases.value(1)} SET ${aliases.name("entityType")} = ${aliases.value("TEAM_RECORD_OPS_FAILURE")}, ${aliases.name("lastAt")} = ${aliases.value(new Date(nowMs).toISOString())}, ${aliases.name("indexExpiresAt")} = ${aliases.value(Math.floor(nowMs / 1000) + EXPIRY_SECONDS)}`,
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    }));
  } catch {
    // best effort
  }
}

/** The company's failures in the last 24 hours. Throws when the table cannot be read (the Health page then says unknown). */
export async function readOpsFailures(table: TeamRecordTable, orgId: OrgId, nowMs: number): Promise<OpsFailures> {
  const since = nowMs - OPS_FAILURE_WINDOW_MS;
  const totals: Record<OpsFailureKind, number> = { erase_sweep: 0, tombstone: 0 };
  let lastAt: string | undefined;
  for (const kind of KINDS) {
    const { items } = await queryPrefix(table, orgId, undefined, `${OPS_FAILURE_SK_PREFIX}${kind}#`, 100);
    for (const item of items) {
      const at = typeof item.lastAt === "string" ? Date.parse(item.lastAt) : Number.NaN;
      if (!Number.isFinite(at) || at <= since || typeof item.count !== "number") continue;
      totals[kind] += item.count;
      const stamp = item.lastAt as string;
      if (lastAt === undefined || stamp > lastAt) lastAt = stamp;
    }
  }
  const app = await readGithubSweepFailures(table, nowMs);
  if (app.lastAt !== undefined && (lastAt === undefined || app.lastAt > lastAt)) lastAt = app.lastAt;
  return { eraseSweep: totals.erase_sweep, tombstone: totals.tombstone, ...(app.count === 0 ? {} : { githubSweep: app.count }), ...(lastAt === undefined ? {} : { lastAt }) };
}

/**
 * What the Health pages say about the counts (the admin API and the web admin page): any failure in the last 24 hours is a warning, because a delete is stuck or was lost (the record keeps the rows hidden
 * meanwhile) and an admin should look at the logs (`record.erase_sweep_failed`, `record.tombstone_failed`, `record.github_redelivery_*`). Counts and a time only; no person, source or error text.
 */
export function opsFailuresCheck(failures: OpsFailures): { status: "ok" | "warn"; detail: string } {
  const problems = [
    ...(failures.eraseSweep === 0 ? [] : [`${failures.eraseSweep} erase second pass${failures.eraseSweep === 1 ? "" : "es"} failed or stuck`]),
    ...(failures.tombstone === 0 ? [] : [`${failures.tombstone} source delete${failures.tombstone === 1 ? "" : "s"} not accepted`]),
    ...(failures.githubSweep === undefined || failures.githubSweep === 0 ? [] : [`${failures.githubSweep} GitHub delete sweep problem${failures.githubSweep === 1 ? "" : "s"} (a failed delete may not be asked for again)`]),
  ];
  if (problems.length === 0) return { status: "ok", detail: "no erase or source delete failures in the last 24 hours" };
  return { status: "warn", detail: `${problems.join(", ")} in the last 24 hours${failures.lastAt === undefined ? "" : `; latest ${failures.lastAt}`}` };
}

// ---- SRL-5a: the App-wide GitHub sweeps. Kept in the org directory partition (no company owns them, and no company's erase empties it), one item per hour like the per-company counters.
export const APP_OPS_FAILURE_SK_PREFIX = "OPSFAIL#app#github_sweep#";
const appKeyOf = (hour: number) => ({ pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk: `${APP_OPS_FAILURE_SK_PREFIX}${String(hour).padStart(9, "0")}` });

/** Counts one failure of the App-wide GitHub sweeps. Never throws. */
export async function recordGithubSweepFailure(table: TeamRecordTable, nowMs: number, count = 1): Promise<void> {
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: appKeyOf(hourOf(nowMs)),
      UpdateExpression: `ADD ${aliases.name("count")} ${aliases.value(Math.max(1, Math.trunc(count)))} SET ${aliases.name("entityType")} = ${aliases.value("TEAM_RECORD_APP_OPS_FAILURE")}, ${aliases.name("lastAt")} = ${aliases.value(new Date(nowMs).toISOString())}, ${aliases.name("indexExpiresAt")} = ${aliases.value(Math.floor(nowMs / 1000) + EXPIRY_SECONDS)}`,
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    }));
  } catch {
    // best effort
  }
}

/** The App-wide sweeps' failures in the last 24 hours. Throws when the table cannot be read. */
async function readGithubSweepFailures(table: TeamRecordTable, nowMs: number): Promise<{ count: number; lastAt?: string }> {
  const since = nowMs - OPS_FAILURE_WINDOW_MS;
  let count = 0;
  let lastAt: string | undefined;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK, ":prefix": APP_OPS_FAILURE_SK_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const at = typeof item.lastAt === "string" ? Date.parse(item.lastAt) : Number.NaN;
      if (!Number.isFinite(at) || at <= since || typeof item.count !== "number") continue;
      count += item.count;
      if (lastAt === undefined || (item.lastAt as string) > lastAt) lastAt = item.lastAt as string;
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return { count, ...(lastAt === undefined ? {} : { lastAt }) };
}
