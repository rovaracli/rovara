// Convergence data moves (decision 129): the framework and every move, in one list. A new move is a file in plugins/ and a line here.
import type { DataMove, MoveContext, MovePage } from "./framework.js";
import { channelTenantsBackfill } from "./plugins/channel-tenants.js";
import { dispatchPartitionMove } from "./plugins/dispatch-partition.js";
import { s2MarkerRowsHeld } from "./plugins/held.js";
import { outboxRelayPrep } from "./plugins/outbox-relay-prep.js";
import { retentionReview } from "./plugins/retention-review.js";

export * from "./framework.js";
export * from "./plugins/channel-tenants.js";
export * from "./plugins/dispatch-partition.js";
export * from "./plugins/held.js";
export * from "./plugins/outbox-relay-prep.js";
export * from "./plugins/retention-review.js";

export interface DataMoveSources {
  /** The companies this install serves (an install has one, ruling R3). */
  companies: () => Promise<readonly string[]> | readonly string[];
  /** A table scan for items whose `pk` begins with a prefix (DynamoDB Scan in the CLI; a list in tests). */
  scanPrefix: (prefix: string) => (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  /** A table scan for Slack binding rows (`ORG#<company>#SLACK_BINDING#<team>` / `CHANNEL#<channel>`). */
  scanBindings: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  /** A table scan for items that hold an attribute. */
  scanHolding: (attribute: string) => (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
}

/** Every convergence move, in the order a release runs them. */
export function cloudDataMoves(sources: DataMoveSources): DataMove[] {
  return [
    s2MarkerRowsHeld,
    dispatchPartitionMove({ companies: sources.companies }),
    channelTenantsBackfill({ scanBindings: sources.scanBindings, scanMarked: sources.scanHolding("backfilledBy") }),
    outboxRelayPrep({ scanOldOutbox: sources.scanPrefix("OUTBOX#") }),
    retentionReview({ scan: (context, cursor, direction) => sources.scanHolding(direction === "forward" ? "indexExpiresAt" : "retentionReviewedExpiry")(context, cursor) }),
  ];
}
