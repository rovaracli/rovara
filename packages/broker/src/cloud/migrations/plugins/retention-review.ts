// Convergence D12 (decision 74): a core item of a kind Cloud keeps without an expiry must not carry one on Cloud's table (there it is a real delete).
// The composition root strips the expiry on write (cloud/app/retention.ts). This move is the review of what is already stored: an item of a "strip"
// kind that holds `indexExpiresAt` (written before the wrapper, or by a path that bypassed it) has the expiry removed, kept aside under
// `retentionReviewedExpiry` so the reverse can put it back exactly.
//
// The report is the per-kind review: `skipped` counts by kind what keeps its expiry (Cloud expires that kind today), and the writes are what Cloud keeps.
// Its source is a table scan (items of many kinds share no partition), injected by the caller.
import { INDEX_EXPIRY_ATTRIBUTE, change, when } from "@rovara-code/contracts";
import { retentionFor } from "../../app/retention.js";
import type { DataMove, MoveContext, MovePage, MovePlan } from "../framework.js";

export const REVIEWED_EXPIRY = "retentionReviewedExpiry";

export interface RetentionReviewOptions {
  /** Pages over items that hold `indexExpiresAt` (forward) or `retentionReviewedExpiry` (reverse). */
  scan: (context: MoveContext, cursor: string | undefined, direction: "forward" | "reverse") => Promise<MovePage>;
}

export function retentionReview(options: RetentionReviewOptions): DataMove {
  return {
    id: "d12-retention-review",
    title: "Core expiries removed where Cloud keeps the item (D12, decision 74)",
    status: "ready",
    source: {
      forward: (context, cursor) => options.scan(context, cursor, "forward"),
      reverse: (context, cursor) => options.scan(context, cursor, "reverse"),
    },
    async plan(item, direction): Promise<MovePlan> {
      const key = { pk: item.pk, sk: item.sk };
      if (direction === "reverse") {
        const saved = item[REVIEWED_EXPIRY];
        if (typeof saved !== "number") return { kind: "skip", reason: "not changed by this move" };
        return { kind: "write", steps: [{ kind: "update", key, ops: [change.set(INDEX_EXPIRY_ATTRIBUTE, saved), change.remove(REVIEWED_EXPIRY)], condition: when.eq(REVIEWED_EXPIRY, saved) }] };
      }
      const expiry = item[INDEX_EXPIRY_ATTRIBUTE];
      if (typeof expiry !== "number") return { kind: "skip", reason: "no expiry" };
      const kind = typeof item.entityType === "string" ? item.entityType : "(none)";
      if (retentionFor(item.entityType) === "keep") return { kind: "skip", reason: `keeps its expiry: ${kind}` };
      return { kind: "write", note: kind, steps: [{ kind: "update", key, ops: [change.remove(INDEX_EXPIRY_ATTRIBUTE), change.set(REVIEWED_EXPIRY, expiry)], condition: when.eq(INDEX_EXPIRY_ATTRIBUTE, expiry) }] };
    },
  };
}
