// Track record (v1.2, slice 1): the record of a stage as the How we work card and a confirmation read it. One record per claim of the stage (`HOW_WE_WORK_STAGE_CLAIMS`), each from the outcome store's
// rate of the last 30 days (`readOutcomeRate`). A read that fails is never a zero: that claim's record is left out, and a stage with no record read shows none. Read-only; the failure is
// logged with a fixed code, never the error's own text.
import { HOW_WE_WORK_STAGE_CLAIMS, hasTrackRecord, type HowWeWorkTrackRecord, type OrgId } from "@agentx/contracts";
import { errorName } from "../agents/table-writes.js";
import { readOutcomeRate } from "../rovara-code/outcomes.js";

export interface TrackRecordDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/** The records of a stage of this kind (none for a kind that has no record, and none when every read of it failed). */
export async function readStageTrackRecord(deps: TrackRecordDependencies, orgId: OrgId, project: string, kind: string): Promise<HowWeWorkTrackRecord[] | undefined> {
  if (!hasTrackRecord(kind)) return undefined;
  const { stage, claims } = HOW_WE_WORK_STAGE_CLAIMS[kind];
  const now = deps.now();
  const reads = await Promise.all(claims.map(async (claim): Promise<HowWeWorkTrackRecord | undefined> => {
    try {
      const rate = await readOutcomeRate({ ddb: deps.documentClient, tableName: deps.tableName }, { org: orgId, project, stage, claim, now });
      return { claim, held: rate.held, notHeld: rate.notHeld, closedUnmerged: rate.closedUnmerged, noOutcome: rate.noOutcome, unreviewedMerges: rate.unreviewedMerges, windowDays: 30, capped: rate.capped, enough: rate.enough };
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", level: "warn", event: "track_record.read_failed", claim, error: errorName(error) ?? "unknown" }));
      return undefined;
    }
  }));
  const found = reads.filter((record): record is HowWeWorkTrackRecord => record !== undefined);
  return found.length === 0 ? undefined : found;
}
