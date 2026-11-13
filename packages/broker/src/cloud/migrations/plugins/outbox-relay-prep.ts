// Convergence D2 (plan 3.3 row D2): the switch of Cloud's outbox onto Code's relay. Nothing is copied: outbox rows are short-lived, and while engines
// coexist both relays run (Cloud's stream publisher drains its own `OUTBOX#<id>` rows; Code's relay drains the staged rows on the `outbox-pending` index).
//
// This is a CHECK (it writes nothing). It lists Cloud's own outbox rows that are still there, so the old publisher can be retired only when it has drained:
//   - a row younger than `stuckAfterMinutes` is draining (skipped);
//   - an older one is stuck: a conflict to look at (a row the publisher gave up on, or a DLQ'd hand-over).
// Its source is a table scan over `OUTBOX#` keys (they have no shared partition), injected by the caller (the CLI scans DynamoDB; tests give a list).
//
// Other prerequisites of the relay switch, outside this check: the `outbox-pending` GSI (G-AWS), and DEFERRED OUTBOX-DEAD-ON-TRANSIENT (Code's relay sets a
// row DEAD after 10 failed hand-overs even when SQS said retryable; fix in Code before Cloud's outbox moves).
import type { DataMove, MoveContext, MovePage, MovePlan } from "../framework.js";

export interface OutboxCheckOptions {
  /** Pages over Cloud's own outbox rows (`pk` beginning `OUTBOX#`). */
  scanOldOutbox: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  stuckAfterMinutes?: number;
}

export function outboxRelayPrep(options: OutboxCheckOptions): DataMove {
  const stuckMs = (options.stuckAfterMinutes ?? 30) * 60_000;
  return {
    id: "d2-outbox-relay-prep",
    title: "Cloud's own outbox drained before its publisher is retired (D2, a check)",
    status: "check-only",
    source: { forward: options.scanOldOutbox },
    async plan(item, _direction, context): Promise<MovePlan> {
      if (!item.pk.startsWith("OUTBOX#")) return { kind: "skip", reason: "not an outbox row" };
      const created = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
      if (Number.isNaN(created)) return { kind: "conflict", reason: "an outbox row with no readable time" };
      if (context.now().getTime() - created < stuckMs) return { kind: "skip", reason: "draining" };
      return { kind: "conflict", reason: `stuck for more than ${String(options.stuckAfterMinutes ?? 30)} minutes (status ${typeof item.status === "string" ? item.status : "unknown"})` };
    },
  };
}
