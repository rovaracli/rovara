import type { ReactNode } from "react";
import { HOW_WE_WORK_UNUSED_STAGE_NOTE } from "@agentx/contracts/web";
import { Card } from "../../design/Card.js";
import { VisibleText } from "../../design/VisibleText.js";
import { cardTitle } from "../../api/stage-cards.js";
import { HowWeWorkMarker } from "./HowWeWorkMarker.js";
import { EDITABLE_KINDS, stageRows, visibleRows, type Filter, type RowId, type StageRead, type ViewRead } from "./how-we-work-rows.js";
export const stageDomId = (id: string) => "hww-stage-" + id.replace(/[^A-Za-z0-9_-]/g, "_");
/** Shown where the stage models would be when the resolver's read is not there: the page names no model it did not get from it. */
export const MODEL_NOTE = "The models of this stage can't be shown right now. Reload to try again.";
/** One stage: its six rows, each value marked. A row shows when it has a changed or locked value (or the reader asked for more); the editor and the reviewing note always show under "All". `action` sits under the title, whatever the filter. */
export function HowWeWorkCard({ stage, view, filter, showUnchanged, editor, action, models }: { stage: StageRead; view: ViewRead; filter: Filter; showUnchanged: boolean; editor?: ReactNode; action?: ReactNode; /** The model rows from the stage-models read; they replace the read-only model values of "Who does it". */ models?: ReactNode }) {
 const forced = new Set<RowId>(filter === "all" ? [...(stage.knows.note !== undefined || editor !== undefined ? ["knows" as const] : []), ...(models !== undefined || EDITABLE_KINDS.has(stage.kind) ? ["who" as const] : [])] : []), rows = visibleRows(stageRows(stage, view), filter, showUnchanged, forced), id = stageDomId(stage.id);
 return <Card className="rv-hww-card" aria-labelledby={id + "-title"} id={id}>
  <h3 id={id + "-title"} tabIndex={-1}><VisibleText text={cardTitle(stage.kind, stage.name)} /></h3>
  {stage.kind === "pull_request" && <p className="rv-hww-note">{HOW_WE_WORK_UNUSED_STAGE_NOTE}</p>}
  {action}
  {rows.length === 0 ? <p className="rv-muted">Nothing here is changed or locked. Show unchanged settings to see everything.</p> : <dl className="rv-hww-rows">{rows.map(row => <div className="rv-hww-row" key={row.id}>
   <dt>{row.title}</dt>
   <dd>
    {row.id === "who" && models !== undefined ? models : row.values.length === 0 ? (row.id === "who" ? null : <p className="rv-muted">None</p>) : <ul>{row.values.map((value, index) => <li key={index} className={value.block ? "rv-hww-block" : undefined}>{value.label !== undefined && <span className="rv-muted">{value.label}: </span>}<span className="rv-hww-text"><VisibleText text={value.text} /></span> <HowWeWorkMarker mark={value.mark} /></li>)}</ul>}
    {row.id === "who" && models === undefined && EDITABLE_KINDS.has(stage.kind) && <p className="rv-muted">{MODEL_NOTE}</p>}
    {row.id === "knows" && stage.knows.note !== undefined && <p className="rv-hww-note"><VisibleText text={stage.knows.note} /></p>}
    {row.id === "knows" && editor}
   </dd>
  </div>)}</dl>}
 </Card>;
}
