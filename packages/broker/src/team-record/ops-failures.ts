// Failure counters for the Health page (register SRL-6): an erase's delayed second pass that failed, and a source delete that no durable path accepted. Both used to be a log line only
// (`record.erase_sweep_failed`, `record.tombstone_failed`, `record.github_repo_check_refused`), so nothing showed an admin that a delete was stuck. One small item per company, kind and hour holds a count and the time of the last
// failure: no person, no source id, no text, no error message. Items expire after two days; a company close removes them (`erase.ts`, WORKSPACE_PREFIXES). Writing is best effort and never
// fails the work that reported the failure.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { Aliases } from "../agents/table-writes.js";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const OPS_FAILURE_SK_PREFIX = "OPSFAIL#";
export type OpsFailureKind = "erase_sweep" | "tombstone" | "repo_check";
const KINDS: readonly OpsFailureKind[] = ["erase_sweep", "tombstone", "repo_check"];

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
  return { eraseSweep: totals.erase_sweep, tombstone: totals.tombstone, ...(totals.repo_check === 0 ? {} : { repoCheck: totals.repo_check }), ...(lastAt === undefined ? {} : { lastAt }) };
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
  if (problems.length === 0) return { status: "ok", detail: "no erase or source delete failures in the last 24 hours" };
  return { status: "warn", detail: `${problems.join(", ")} in the last 24 hours${failures.lastAt === undefined ? "" : `; latest ${failures.lastAt}`}` };
}

