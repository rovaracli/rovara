import { useRef, type KeyboardEvent } from "react";
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

/**
 * The dense work list, grouped by who owns the next move. `j` and `k` (or the arrow keys) move the selection and `o` opens the task on its own page, while focus is in the list, so the shortcuts never
 * take a key from a text field or from the rest of the page (the list holds only buttons).
 */
export function WorkList({ rows, selectedId, onSelect, onOpen, decisionsFailed = false }: { rows: readonly WorkRow[]; selectedId: string | undefined; onSelect: (id: string) => void; /** `o` opens the selected task on its own page. */ onOpen?: ((id: string) => void) | undefined; /** The decision cards could not be read: "Needs you" cannot claim that nothing needs the person. */ decisionsFailed?: boolean }) {
 const buttons = useRef(new Map<string, HTMLButtonElement>());
 const order = GROUPS.flatMap(entry => rows.filter(row => row.group === entry.group)).map(row => row.id);
 function onKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase(), down = key === "j" || key === "arrowdown", up = key === "k" || key === "arrowup";
  if (key === "o" && onOpen !== undefined && selectedId !== undefined) { event.preventDefault();onOpen(selectedId);return; }
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
   const group = rows.filter(row => row.group === entry.group);
   if (group.length === 0 && entry.group !== "you") return null;
   return <section key={entry.group} aria-label={entry.label} data-group={entry.group}>
    <h2 className="rv-inbox-group">{entry.label} <span>{group.length}</span></h2>
    {group.length === 0 && decisionsFailed ? <div className="rv-empty rv-empty-inline" data-testid="work-decisions-failed"><b>Decisions couldn't be loaded</b>Some of this work may need you. Try again in a moment.</div>
     : group.length === 0 ? <div className="rv-empty rv-empty-inline" data-testid="work-nothing-needs-you"><b>Nothing needs you</b>{rows.filter(row => row.group === "run").length} {rows.filter(row => row.group === "run").length === 1 ? "task is" : "tasks are"} being built. A card appears here when one needs a decision.</div>
     : <ul className="rv-inbox-list" aria-label={entry.label}>{group.map(row => <InboxRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} buttonRef={element => { if (element === null) buttons.current.delete(row.id);else buttons.current.set(row.id, element); }} />)}</ul>}
   </section>;
  })}
 </div>;
}
