import { InlineQuestions } from "./InlineQuestions.js";
import type { LessonInboxBatch } from "@agentx/contracts/code-contract-v0";
import { batchTitle, soonCount } from "../../api/learned-read.js";
import { OUTCOME_WORDS, type WorkRow } from "../../api/work-read.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { StatusChip } from "../../design/StatusChip.js";
import { VisibleText } from "../../design/VisibleText.js";
import { shortAge } from "./queue-preview.js";
import { WorkRowStatus } from "./WorkRowStatus.js";

/** The list id of a project's lesson batch (`?task=lessons:<project>`). */
export const batchId = (project: string) => "lessons:" + project;

type Entry = { key: string; row: WorkRow; batch?: undefined } | { key: string; batch: LessonInboxBatch; row?: undefined };

/** What the row says under its title: what is asked of the person (or what Rovara is doing), the project, and the outcome when the workflow ended. */
export function rowDetail(row: WorkRow, showProject = true): string {
 const line = row.group === "stopped" ? "Stopped" : row.line;
 const outcome = row.task.outcome === undefined ? undefined : OUTCOME_WORDS[row.task.outcome];
 const parts = [row.need, line, showProject ? row.project : undefined, outcome].filter((part): part is string => part !== undefined && part !== "");
 return [...new Set(parts)].join(" · ") + (row.stale ? " · waiting" : "");
}

/**
 * Every task as one row of the shared table (boards 2c and 2f): the title takes the free width, the status and the time sit together on the right. The first
 * column keeps the row's own button, so a click selects it and J, K and Enter work from the row (the shared table's keys). Lesson batches are rows of the same table.
 */
export function WorkPreviewList({ rows, selectedId, onSelect, onOpen, lessonBatches = [], now, current = false }: { current?: boolean; rows: readonly WorkRow[]; selectedId: string | undefined; onSelect: (id: string) => void; /** Enter opens the selected task on its own page. */ onOpen?: ((id: string) => void) | undefined; /** The projects' lesson batches, at the end of the table. */ lessonBatches?: readonly LessonInboxBatch[]; now: number }) {
 const manyProjects = new Set(rows.map(row => row.project)).size > 1;
 const entries: Entry[] = [...rows.map(row => ({ key: row.id, row })), ...lessonBatches.map(batch => ({ key: batchId(batch.project), batch }))];
 const columns: readonly Column<Entry>[] = [
  { key: "task", title: "Task", render: entry => entry.row !== undefined
   ? <><button type="button" className="rv-qp-row" data-task-id={entry.row.id} tabIndex={-1} aria-current={entry.key === selectedId ? "true" : undefined} onClick={event => { event.currentTarget.closest("tr")?.focus();onSelect(entry.key); }}><strong title={entry.row.title}><VisibleText text={entry.row.title} /></strong><small><span className="rv-qp-proj"><VisibleText text={entry.row.project} /></span><span className="rv-qp-detail"><VisibleText text={rowDetail(entry.row, manyProjects)} /></span><span className="rv-qp-time-inline"> · {shortAge(entry.row.updatedAt, now)}</span></small></button>{current && <InlineQuestions task={entry.row.task} />}</>
   : <button type="button" className="rv-qp-row" data-batch={entry.batch.project} tabIndex={-1} aria-current={entry.key === selectedId ? "true" : undefined} onClick={event => { event.currentTarget.closest("tr")?.focus();onSelect(entry.key); }}><strong>{batchTitle(entry.batch, now)}</strong><small><span className="rv-qp-proj"><VisibleText text={entry.batch.project} /></span><span className="rv-qp-detail">{soonCount(entry.batch, now) > 0 ? (soonCount(entry.batch, now) === 1 ? "1 lapses soon" : `${String(soonCount(entry.batch, now))} lapse soon`) : "Review lessons"} · {entry.batch.fromYou > 0 ? (entry.batch.fromYou === entry.batch.lessons.length ? "from your corrections" : `${String(entry.batch.fromYou)} from your corrections`) : "from your team's corrections"} · <VisibleText text={entry.batch.project} /></span></small></button> },
  { key: "status", title: "Status", render: entry => entry.row !== undefined ? <WorkRowStatus row={entry.row} /> : <StatusChip state="needs_you" /> },
  { key: "updated", title: "Updated", render: entry => entry.row !== undefined ? <time dateTime={entry.row.updatedAt}>{shortAge(entry.row.updatedAt, now)}</time> : null },
 ];
 return <div className="rv-qp-table" onKeyDown={event => { if (event.metaKey || event.ctrlKey || event.altKey) return;if (event.target instanceof HTMLElement && event.target.closest("form, input, textarea, select, [contenteditable]") !== null) return;if (event.key.toLowerCase() === "o" && selectedId !== undefined && !selectedId.startsWith("lessons:")) { event.preventDefault();onOpen?.(selectedId); } }}><DataTable caption="Work tasks" columns={columns} rows={entries} rowKey={entry => entry.key} selection={{ ...(selectedId === undefined ? {} : { selectedKey: selectedId }), onSelect, onOpen: id => { if (!id.startsWith("lessons:")) onOpen?.(id); } }} /></div>;
}
