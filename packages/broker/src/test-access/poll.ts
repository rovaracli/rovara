// Customer test AWS account, lane TA2: the polling fallback (customer-test-account.md section 1, way B). When no callback arrives, Screen 3 offers "type the account id". The admin's typed id opens a poll (connect.ts#submitAccountId); this
// is the poll: every 10 seconds, for 30 minutes, try to assume the role the template names for the connection (`rovara-test-<connection id>` in that account) with the stored external id, and nothing else.
//
// WHAT A SUCCESS PROVES. The role exists in the typed account, trusts Rovara's role, and its trust policy holds this connection's external id. The external id is Rovara-made and per connection, so a role that answers is the one the
// template made for this connection. The session carries no run tag, so the role's boundary leaves it nothing to do but `sts:GetCallerIdentity`: it is a probe, and it is dropped. The typed id is the admin's own word that the account
// is theirs, so success is `confirmed` (the callback path needs an admin to confirm because the stack's word is a stranger's); the connection test runs at once.
//
// WHAT IT REFUSES. A role that answers with another account or role name than the one asked for; Rovara's own accounts and the production list (read again now); a connection that is no longer polling; a poll past its window
// (the connection ends as `failed`). The attempt rate is held by `lastPolledAt` (a conditional write before each attempt, which is also what keeps two drivers from both trying), so a driver that calls too often cannot hammer the
// customer's CloudTrail. The driver itself (an EventBridge Scheduler tick, or a loop inside the broker's scheduled sweep) is deployment wiring and is not part of this lane.
import { connectionAudit } from "./audit.js";
import { POLL_INTERVAL_MS, conventionalRoles, runAndRecordTest, type ConnectDeps } from "./connect.js";
import type { ConnectionRecord } from "./store.js";

export const POLL_BATCH_MAX = 100;
export const POLL_SESSION_NAME = "rovara-connect-poll";

export interface PollSummary { polled: number; found: number; expired: number; skipped: number }

const iso = (ms: number): string => new Date(ms).toISOString();

/** The `AssumedRoleUser.Arn` STS returns for the role asked for: `arn:aws:sts::<account>:assumed-role/<role name>/<session name>`. */
function answersForRole(assumedRoleArn: string | undefined, accountId: string, roleArn: string): boolean {
  if (assumedRoleArn === undefined) return false;
  const roleName = roleArn.split("/").pop() as string;
  return assumedRoleArn === `arn:aws:sts::${accountId}:assumed-role/${roleName}/${POLL_SESSION_NAME}`;
}

async function attempt(deps: ConnectDeps, record: ConnectionRecord, nowMs: number): Promise<"found" | "waiting" | "skipped"> {
  const accountId = record.pollAccountId;
  if (accountId === undefined || !/^\d{12}$/u.test(accountId) || deps.config.rovaraAccountIds.includes(accountId)) return "skipped";
  // A production list that cannot be read is no list: this attempt is skipped (fail closed), and the next tick asks again. One project's trouble does not stop the others.
  const deny = await deps.prodDeny(record.orgId, record.projectId).catch(() => undefined);
  if (deny === undefined || deny.accountIds.includes(accountId)) return "skipped";
  const { roleArn, cleanupRoleArn } = conventionalRoles(accountId, record.connectionId);
  let assumed;
  try {
    // The stored external id, no run tag and no policy: this is a probe for the role, and it can do nothing.
    assumed = await deps.aws.assumeRole({ RoleArn: roleArn, RoleSessionName: POLL_SESSION_NAME, ExternalId: record.externalId, DurationSeconds: 900 });
  } catch {
    // `refused` is the normal answer while the stack is not there yet; any other fault is the same for the poll: try again at the next tick.
    return "waiting";
  }
  if (!answersForRole(assumed.assumedRoleArn, accountId, roleArn)) return "waiting";
  const next: ConnectionRecord = {
    ...record,
    status: "confirmed",
    version: record.version + 1,
    accountId,
    roleArn,
    cleanupRoleArn,
    reportedAt: iso(nowMs),
    reportedVia: "account_id",
    confirmedBy: record.pollSubmittedBy ?? record.createdBy,
    confirmedAt: iso(nowMs),
  };
  delete next.pollAccountId; delete next.pollSubmittedBy; delete next.pollUntil;
  // Confirmed by the admin's typed id; the audit event says how (`account_id`), not by whom the stack was made.
  const audit = connectionAudit({ record: next, action: "test_access.connection_confirmed", actor: { kind: "system" }, occurredAt: iso(nowMs), facts: { via: "account_id" } });
  // One conditional write: a callback that won the race between the read and here changed the version, and this attempt is dropped (the callback's result stands).
  if (!(await deps.store.commitConnection(next, record.version, audit))) return "skipped";
  return "found";
}

/** One tick of the poll: every open poll gets at most one attempt. Never throws for one connection's trouble; a store outage for the list or a write throws (the driver retries at the next tick). */
export async function pollDue(deps: ConnectDeps): Promise<PollSummary> {
  const summary: PollSummary = { polled: 0, found: 0, expired: 0, skipped: 0 };
  if (!deps.enabled()) return summary;
  // Without Rovara's own accounts known, nothing is tried (an empty list would let Rovara's own account through).
  if (deps.config.rovaraAccountIds.length === 0) return summary;
  for (const { orgId, connectionId } of await deps.store.listPolling(POLL_BATCH_MAX)) {
    const record = await deps.store.getConnection(orgId, connectionId);
    const nowMs = deps.now().getTime();
    if (record === undefined || record.status !== "polling" || record.orgId !== orgId) { summary.skipped += 1; continue; }
    if (record.pollUntil === undefined || Date.parse(record.pollUntil) <= nowMs) {
      const next: ConnectionRecord = { ...record, status: "failed", version: record.version + 1, endedAt: iso(nowMs), endCause: "poll_timeout" };
      delete next.pollAccountId; delete next.pollSubmittedBy; delete next.pollUntil;
      if (await deps.store.commitConnection(next, record.version, connectionAudit({ record: next, action: "test_access.connection_ended", actor: { kind: "system" }, occurredAt: iso(nowMs), facts: { cause: "poll_timeout" } }))) summary.expired += 1;
      continue;
    }
    if (record.lastPolledAt !== undefined && nowMs - Date.parse(record.lastPolledAt) < POLL_INTERVAL_MS) { summary.skipped += 1; continue; }
    // The attempt is claimed first: a conditional write of the time, so two drivers never both try and the rate holds.
    const claimed: ConnectionRecord = { ...record, version: record.version + 1, lastPolledAt: iso(nowMs) };
    if (!(await deps.store.commitConnection(claimed, record.version, undefined))) { summary.skipped += 1; continue; }
    summary.polled += 1;
    const outcome = await attempt(deps, claimed, nowMs);
    if (outcome === "skipped") summary.skipped += 1;
    if (outcome === "found") {
      summary.found += 1;
      await runAndRecordTest(deps, orgId, connectionId, "system");
    }
  }
  return summary;
}
