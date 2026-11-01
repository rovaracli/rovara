import { isWordedRecord, stageOfLessSafeReason, trackRecordLines, type HowWeWorkTrackRecord } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import type { StageRead } from "./how-we-work-rows.js";

/** The records of a stage this build can word (a claim a newer server added reads as "unknown" and is left out). A stage with none read shows no record: never a zero. */
export const wordedRecords = (stage: Pick<StageRead, "trackRecord">): HowWeWorkTrackRecord[] => (stage.trackRecord ?? []).filter(isWordedRecord);

/** What a stage has earned in the last 30 days: for each claim its title, line 1 (the rate) and line 2 (the limits). Plain text, read-only. */
export function StageRecord({ records, className = "rv-hww-record" }: { records: readonly HowWeWorkTrackRecord[]; className?: string }) {
 if (records.length === 0) return null;
 return <div className={className} role="group" aria-label="Track record">{records.map(record => { const lines = trackRecordLines(record);
  return <div key={record.claim} className="rv-hww-record-item"><p className="rv-hww-record-title"><VisibleText text={lines.title} /></p><p className="rv-hww-record-rate"><VisibleText text={lines.rate} /></p>{lines.limits !== undefined && <p className="rv-muted rv-hww-record-limits"><VisibleText text={lines.limits} /></p>}</div>; })}</div>;
}

/** The record beside one less-safe change: the lines of the stage the change is about, or nothing when it is about no stage with a record. */
export function ReasonRecord({ reason, stages }: { reason: string; stages: ReadonlyArray<StageRead> | undefined }) {
 if (stages === undefined) return null;
 const id = stageOfLessSafeReason(reason, stages), stage = id === undefined ? undefined : stages.find(entry => entry.id === id);
 return stage === undefined ? null : <StageRecord records={wordedRecords(stage)} className="rv-hww-record rv-hww-record-inline" />;
}
