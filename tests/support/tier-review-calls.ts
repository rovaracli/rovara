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
      rows.set(key(taskId, purpose), { callId, status: "started", startedAt: at });
      writes.push(`claim:${taskId}:${purpose}`);
      return true;
    },
    async mark({ taskId, purpose, callId, status, at }) {
      const row = rows.get(key(taskId, purpose));
      if (row === undefined || row.callId !== callId || (row.status !== "started" && row.status !== "sent")) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      rows.set(key(taskId, purpose), { ...row, status, ...(status === "sent" ? {} : { endedAt: at }) });
      writes.push(`mark:${status}`);
    },
  };
}
