import { useRef, useState, type KeyboardEvent } from "react";
import type { LessonInboxBatch } from "@agentx/contracts/code-contract-v0";
import { batchTitle, soonCount } from "../../api/learned.js";
import { GROUPS, type WorkRow } from "../../api/work.js";
import { StepMini } from "../../design/StepRail.js";
import { ToneDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";

/** One task in the list: its tone, title, what is asked of the person (or what Rovara is doing), the project, its age and five small bars for its steps. */
export function InboxRow({ row, selected, onSelect, buttonRef }: { row: WorkRow; selected: boolean; onSelect: (id: string) => void; buttonRef?: (element: HTMLButtonElement | null) => void }) {
 return <li>
  <button type="button" ref={buttonRef} className="rv-inbox-row" data-task-id={row.id} aria-current={selected ? "true" : undefined} onClick={() => onSelect(row.id)}>
   <ToneDot tone={row.tone} words={row.need ?? row.line} />
   <span className="rv-inbox-main"><b><VisibleText text={row.title} /></b>
    <small>{row.need !== undefined && <><span className="rv-inbox-need" data-tone={row.tone}>{row.need}</span> · </>}<VisibleText text={row.line} /> · <VisibleText text={row.project} /></small></span>
   <span className="rv-inbox-meta"><span className="mono">{row.age}{row.stale ? " · waiting" : ""}</span><StepMini step={row.step} tone={row.tone} /></span>
  </button>
 </li>;
}

/** The list id of a project's lesson batch (`?task=lessons:<project>`). */
export const batchId = (project: string) => "lessons:" + project;

/** A project's proposed lessons as one row under "Needs you" (DEC 231b): how many, from whose corrections, and a warning when one lapses soon. */
export function LessonBatchRow({ batch, selected, onSelect, buttonRef, now }: { batch: LessonInboxBatch; selected: boolean; onSelect: (id: string) => void; buttonRef?: (element: HTMLButtonElement | null) => void; now: number }) {
 const soon = soonCount(batch, now), need = soon > 0 ? (soon === 1 ? "1 lapses soon" : `${String(soon)} lapse soon`) : "Review lessons";
 return <li>
  <button type="button" ref={buttonRef} className="rv-inbox-row rv-inbox-lessons" data-batch={batch.project} aria-current={selected ? "true" : undefined} onClick={() => onSelect(batchId(batch.project))}>
   <ToneDot tone={soon > 0 ? "bad" : "wait"} words={need} />
   <span className="rv-inbox-main"><b>{batchTitle(batch, now)}</b>
    <small><span className="rv-inbox-need" data-tone={soon > 0 ? "bad" : "wait"}>{need}</span> · {batch.fromYou > 0 ? (batch.fromYou === batch.lessons.length ? "from your corrections" : `${String(batch.fromYou)} from your corrections`) : "from your team's corrections"} · <VisibleText text={batch.project} /></small></span>
   <span className="rv-inbox-meta"><span className="mono">Keep · Edit · Drop</span></span>
  </button>
 </li>;
}

/**
 * The dense work list, grouped by who owns the next move. `j` and `k` (or the arrow keys) move the selection and `o` opens the task on its own page, while focus is in the list, so the shortcuts never
 * take a key from a text field or from the rest of the page (the list holds only buttons).
 */
export function WorkList({ rows, selectedId, onSelect, onOpen, decisionsFailed = false, lessonBatches = [] }: { rows: readonly WorkRow[]; selectedId: string | undefined; onSelect: (id: string) => void; /** `o` opens the selected task on its own page. */ onOpen?: ((id: string) => void) | undefined; /** The decision cards could not be read: "Needs you" cannot claim that nothing needs the person. */ decisionsFailed?: boolean; /** The projects' lesson batches, at the end of "Needs you". */ lessonBatches?: readonly LessonInboxBatch[] }) {
 const buttons = useRef(new Map<string, HTMLButtonElement>()), [now] = useState(() => Date.now());
 const keep = (id: string) => (element: HTMLButtonElement | null) => { if (element === null) buttons.current.delete(id);else buttons.current.set(id, element); };
 const order = GROUPS.flatMap(entry => [...rows.filter(row => row.group === entry.group).map(row => row.id), ...(entry.group === "you" ? lessonBatches.map(batch => batchId(batch.project)) : [])]);
 function onKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase(), down = key === "j" || key === "arrowdown", up = key === "k" || key === "arrowup";
  if (key === "o" && onOpen !== undefined && selectedId !== undefined && !selectedId.startsWith("lessons:")) { event.preventDefault();onOpen(selectedId);return; }
  if (!down && !up) return;
  event.preventDefault();
  const at = selectedId === undefined ? -1 : order.indexOf(selectedId), next = order[Math.max(0, Math.min(order.length - 1, at + (down ? 1 : -1)))];
  if (next === undefined) return;
  onSelect(next);
  const button = buttons.current.get(next);
  button?.focus();
  button?.scrollIntoView?.({ block: "nearest" });
 }
 return <div className="rv-work-groups" onKeyDown={onKeyDown}>
  {GROUPS.map(entry => {
   const group = rows.filter(row => row.group === entry.group), batches = entry.group === "you" ? lessonBatches : [];
   if (group.length === 0 && entry.group !== "you") return null;
   return <section key={entry.group} aria-label={entry.label} data-group={entry.group}>
    <h2 className="rv-inbox-group">{entry.label} <span>{group.length + batches.length}</span></h2>
    {batches.length > 0 ? <ul className="rv-inbox-list" aria-label={entry.label}>{group.map(row => <InboxRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} buttonRef={keep(row.id)} />)}{batches.map(batch => <LessonBatchRow key={batch.project} batch={batch} now={now} selected={batchId(batch.project) === selectedId} onSelect={onSelect} buttonRef={keep(batchId(batch.project))} />)}</ul>
     : group.length === 0 && decisionsFailed ? <div className="rv-empty rv-empty-inline" data-testid="work-decisions-failed"><b>Decisions couldn't be loaded</b>Some of this work may need you. Try again in a moment.</div>
     : group.length === 0 ? <div className="rv-empty rv-empty-inline" data-testid="work-nothing-needs-you"><b>Nothing needs you</b>{rows.filter(row => row.group === "run").length} {rows.filter(row => row.group === "run").length === 1 ? "task is" : "tasks are"} being built. A card appears here when one needs a decision.</div>
     : <ul className="rv-inbox-list" aria-label={entry.label}>{group.map(row => <InboxRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} buttonRef={keep(row.id)} />)}</ul>}
   </section>;
  })}
 </div>;
}
