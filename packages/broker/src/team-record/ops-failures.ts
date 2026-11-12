// Failure counters for the Health page (register SRL-6): an erase's delayed second pass that failed, and a source delete that no durable path accepted. Both used to be a log line only
// (`record.erase_sweep_failed`, `record.tombstone_failed`, `record.github_repo_check_refused`), so nothing showed an admin that a delete was stuck. One small item per company, kind and hour holds a count and the time of the last
// failure: no person, no source id, no text, no error message. One more kind is a LEVEL, not a count (`recordOpsLevel`, LP-13 C2): the lessons' hourly job writes how many lesson rollbacks are stuck right now;
// the latest value counts while it is fresh, so an intent seen every hour is not counted every hour and a mended one clears at the next run. Items expire after two days; a company close removes them (`erase.ts`, WORKSPACE_PREFIXES). Writing is best effort and never
// fails the work that reported the failure.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { Aliases, type Item } from "../agents/table-writes.js";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const OPS_FAILURE_SK_PREFIX = "OPSFAIL#";
/**
 * Levels (`recordOpsLevel`) have their own prefix: a level is usually 0 and is not a failure, and under `OPSFAIL#` a count-0 `lesson_rollback` row looked like one (0.5.15 staging find). Until 0.5.15 the level was
 * written as `OPSFAIL#lesson_rollback#<hour>`; `LEGACY_LEVEL_SK_PREFIX` is still READ, newest of the two winning, so a rollout never loses a level. Those rows expire two days after their last write (`indexExpiresAt`), so the
 * legacy read can be deleted once 0.5.15 has been live for two days; nothing is migrated.
 */
export const OPS_LEVEL_SK_PREFIX = "OPSLEVEL#";
const LEGACY_LEVEL_SK_PREFIX = `${OPS_FAILURE_SK_PREFIX}lesson_rollback#`;
export type OpsFailureKind = "erase_sweep" | "tombstone" | "repo_check";
const KINDS: readonly OpsFailureKind[] = ["erase_sweep", "tombstone", "repo_check"];
/** Kinds that hold a level (the latest hour's value), not a sum. */
export type OpsLevelKind = "lesson_rollback";
/** A level older than this is no longer reported: the job that writes it runs hourly, so two missed runs are tolerated. */
export const OPS_LEVEL_FRESH_MS = 3 * 3_600_000;

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
   * SRL-5a: times in the window the hourly repository check refused to remove anything for THIS company, because too many of its recorded repositories looked gone at once (a narrowed or revoked
   * GitHub App installation looks exactly like that). Present only when not zero. Counted under the company's own partition: nothing App-wide ever reaches a company's Health (that would show one
   * company's events, and Rovara's own faults, to the others).
   */
  repoCheck?: number;
  /**
   * LP-13 C2: lesson rollbacks (a staged rollback that died half way and has not been repaired for a while) that the lessons' hourly job found stuck in this company's projects at its last run. A count only: no
   * project, no lesson. Present only when not zero.
   */
  lessonRollbacks?: number;
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

/** Records a level: how many of `kind` there are now. The current hour's item is set (not added to), so a repeat of the same run changes nothing. A zero clears the line. Never throws. */
export async function recordOpsLevel(table: TeamRecordTable, orgId: OrgId, kind: OpsLevelKind, count: number, nowMs: number): Promise<void> {
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName,
      Key: { pk: teamRecordPk(orgId), sk: `${OPS_LEVEL_SK_PREFIX}${kind}#${String(hourOf(nowMs)).padStart(9, "0")}` },
      UpdateExpression: `SET ${aliases.name("count")} = ${aliases.value(Math.max(0, Math.trunc(count)))}, ${aliases.name("entityType")} = ${aliases.value("TEAM_RECORD_OPS_LEVEL")}, ${aliases.name("lastAt")} = ${aliases.value(new Date(nowMs).toISOString())}, ${aliases.name("indexExpiresAt")} = ${aliases.value(Math.floor(nowMs / 1000) + EXPIRY_SECONDS)}`,
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
  const totals: Record<OpsFailureKind, number> = { erase_sweep: 0, tombstone: 0, repo_check: 0 };
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
  // LP-13 C2: the latest hour's level (the items sort by hour), only while it is fresh.
  // Newest first, one item: the hour numbers are padded, so the newest sorts last; reading from the oldest end would miss it once more than a hundred hourly items are stored (the table removes them after two days, late).
  // The new prefix and the legacy one (written until 0.5.15 was installed) are both read; the newer `lastAt` is the level.
  const newest = async (prefix: string): Promise<Item | undefined> => (await queryPrefix(table, orgId, undefined, prefix, 1, { newestFirst: true })).items[0];
  const stampOf = (item: Item | undefined): number => (typeof item?.lastAt === "string" ? Date.parse(item.lastAt) : Number.NaN);
  const [current, legacy] = [await newest(`${OPS_LEVEL_SK_PREFIX}lesson_rollback#`), await newest(LEGACY_LEVEL_SK_PREFIX)];
  const latest = !Number.isFinite(stampOf(legacy)) || stampOf(current) >= stampOf(legacy) ? current ?? legacy : legacy;
  const levelAt = typeof latest?.lastAt === "string" ? Date.parse(latest.lastAt) : Number.NaN;
  const lessonRollbacks = latest !== undefined && typeof latest.count === "number" && latest.count > 0 && Number.isFinite(levelAt) && levelAt > nowMs - OPS_LEVEL_FRESH_MS ? latest.count : 0;
  if (lessonRollbacks > 0 && (lastAt === undefined || (latest!.lastAt as string) > lastAt)) lastAt = latest!.lastAt as string;
  return { eraseSweep: totals.erase_sweep, tombstone: totals.tombstone, ...(totals.repo_check === 0 ? {} : { repoCheck: totals.repo_check }), ...(lessonRollbacks === 0 ? {} : { lessonRollbacks }), ...(lastAt === undefined ? {} : { lastAt }) };
}

/**
 * What the Health pages say about the counts (the admin API and the web admin page): any failure in the last 24 hours is a warning, because a delete is stuck or was lost (the record keeps the rows hidden
 * meanwhile) and an admin should look at the logs (`record.erase_sweep_failed`, `record.tombstone_failed`, `record.github_repo_check_refused`). Counts and a time only; no person, source or error text.
 */
export function opsFailuresCheck(failures: OpsFailures): { status: "ok" | "warn"; detail: string } {
  const problems = [
    ...(failures.eraseSweep === 0 ? [] : [`${failures.eraseSweep} erase second pass${failures.eraseSweep === 1 ? "" : "es"} failed or stuck`]),
    ...(failures.tombstone === 0 ? [] : [`${failures.tombstone} source delete${failures.tombstone === 1 ? "" : "s"} not accepted`]),
    ...(failures.repoCheck === undefined || failures.repoCheck === 0 ? [] : [`${failures.repoCheck} GitHub repository check${failures.repoCheck === 1 ? "" : "s"} found many repositories gone at once and removed none (check the GitHub App's repository access)`]),
  ];
  // A level, not an event of the last 24 hours: said as it stands now.
  const now = failures.lessonRollbacks === undefined || failures.lessonRollbacks === 0 ? [] : [`${failures.lessonRollbacks} lesson rollback${failures.lessonRollbacks === 1 ? "" : "s"} not finished (an administrator needs to look at the project's lessons)`];
  if (problems.length === 0 && now.length === 0) return { status: "ok", detail: "no erase or source delete failures in the last 24 hours" };
  const parts = [...(problems.length === 0 ? [] : [`${problems.join(", ")} in the last 24 hours`]), ...now];
  return { status: "warn", detail: `${parts.join("; ")}${failures.lastAt === undefined ? "" : `; latest ${failures.lastAt}`}` };
}
