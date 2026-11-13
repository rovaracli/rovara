// Moves that are written elsewhere and held. Each stands in the registry so the run list is complete and an apply is refused with the reason.
//
// A5 S2 (DEFERRED A5-S2-HELD-OUT-OF-0515): limits and session sets to marker rows (`tasks` / `waitingOutboxIds` string sets to TASK# and SESSION_WAITING#
// rows, the modelKeyIds exact-list fence). Its live-path rewrite and its migration + reverse are on branch adapters/a5-s2-live-rewrite (aacb91f4b,
// scripts/migrate-s2-marker-rows.ts) and ship only with the S0 release and the migration run. The plug-in point: when that branch merges, its migration is
// re-expressed as a `DataMove` (source: the DEVELOPER_LIMIT / ORG_LIMIT / session rows holding a set; plan: one transaction that writes the marker rows
// and removes the set, fenced on the set's current members; reverse: rebuild the set from the markers) and this entry is replaced. Until then it is held.
import type { DataMove } from "../framework.js";

export const s2MarkerRowsHeld: DataMove = {
  id: "s2-limits-session-markers",
  title: "Limits and session sets to marker rows (A5 S2)",
  status: "held",
  heldBecause: "the S2 live-path rewrite is held on adapters/a5-s2-live-rewrite (aacb91f4b); it ships only with the S0 release and its migration run (DEFERRED A5-S2-HELD-OUT-OF-0515)",
  source: {},
  plan: () => Promise.resolve({ kind: "skip", reason: "held" }),
};
