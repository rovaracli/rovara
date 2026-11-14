// S3-9 (review H1b): an in-memory `TierReviewCallLedger` with the production rule (`tierReviewCallBlocked`) as the claim's condition, for tests of the rules and the core runtime. The DynamoDB ledger's own
// condition is tested against the same rule in tests/contract/cloud-tier-review-ports.test.ts.
import { tierReviewCallBlocked, type TierReviewCallLedger, type TierReviewCallRow } from "../../packages/broker/src/cloud/app/tier-review.js";

export interface MemoryCallLedger extends TierReviewCallLedger {
  rows: Map<string, TierReviewCallRow>;
  /** Every write, in order: `claim:<task>:<purpose>`, `mark:<status>`. */
  writes: string[];
}

export function memoryCallLedger(): MemoryCallLedger {
  const rows = new Map<string, TierReviewCallRow>();
  const writes: string[] = [];
  const key = (taskId: string, purpose: string): string => `${taskId}|${purpose}`;
  return {
    rows, writes,
    async last({ taskId, purpose }) { const row = rows.get(key(taskId, purpose)); return row === undefined ? undefined : { ...row }; },
    async claim({ taskId, purpose, callId, at }) {
      if (tierReviewCallBlocked(rows.get(key(taskId, purpose)), at) !== undefined) return false;
      // As the DynamoDB claim: an update that keeps the row's failure count.
      const failures = rows.get(key(taskId, purpose))?.failures;
      rows.set(key(taskId, purpose), { callId, status: "started", startedAt: at, ...(failures === undefined ? {} : { failures }) });
      writes.push(`claim:${taskId}:${purpose}`);
      return true;
    },
    async mark({ taskId, purpose, callId, status, at }) {
      const row = rows.get(key(taskId, purpose));
      if (row === undefined || row.callId !== callId || (row.status !== "started" && row.status !== "sent")) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      const failures = status === "answered" ? 0 : status === "failed_sent" ? (row.failures ?? 0) + 1 : row.failures;
      rows.set(key(taskId, purpose), { ...row, status, ...(status === "sent" ? {} : { endedAt: at }), ...(failures === undefined ? {} : { failures }) });
      writes.push(`mark:${status}`);
    },
  };
}
