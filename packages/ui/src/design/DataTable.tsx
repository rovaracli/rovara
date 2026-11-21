import { useState, type ReactNode, type KeyboardEvent } from "react";
import "./parts/table-toast-dialog.css";
export interface Column<Row> { key: string; title: string; render: (row: Row) => ReactNode }
export interface DataTableSelection { selectedKey?: string; onSelect: (key: string) => void; onOpen: (key: string) => void }
export interface DataTableProps<Row> { caption: string; columns: readonly Column<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string; selection?: DataTableSelection }

// Embedded controls keep their own clicks/keys, including descendants of editors.
function isControl(target: EventTarget | null) {
 return target instanceof Element && target.closest("form,input,textarea,select,button,a,[contenteditable],[role='button'],[role='textbox'],[role='combobox']") !== null;
}
export function DataTable<Row>({ caption, columns, rows, rowKey, selection }: DataTableProps<Row>) {
 const keys = rows.map(rowKey);
 const [focusedKey, setFocusedKey] = useState(selection?.selectedKey);
 const tabKey = focusedKey !== undefined && keys.includes(focusedKey) ? focusedKey : selection?.selectedKey !== undefined && keys.includes(selection.selectedKey) ? selection.selectedKey : keys[0];
 function select(key: string, row?: HTMLTableRowElement | null) { setFocusedKey(key); row?.focus(); selection?.onSelect(key); }
 function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>, key: string) {
  if (!selection || event.defaultPrevented || isControl(event.target) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
  if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) selection.onOpen(key); return; }
  const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  const index = keys.indexOf(key), next = Math.max(0, Math.min(keys.length - 1, index + direction));
  const nextKey = keys[next];
  if (nextKey !== undefined && next !== index) select(nextKey, event.currentTarget.parentElement?.querySelectorAll("tr")[next]);
 }
 return <div className="rv-table-wrap rv-table-v2-wrap"><table className="rv-table rv-table-v2"><caption>{caption}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.title}</th>)}</tr></thead><tbody>{rows.map(row => {
  const key = rowKey(row), selected = selection?.selectedKey === key;
  return <tr key={key} {...(selection ? { tabIndex: tabKey === key ? 0 : -1, "aria-current": selected ? true as const : undefined, onFocus: (event) => { if (event.target === event.currentTarget) setFocusedKey(key); }, onKeyDown: (event) => onKeyDown(event, key), onClick: (event) => { if (!event.defaultPrevented && !isControl(event.target)) select(key, event.currentTarget); } } : {})}>{columns.map(column => <td key={column.key}>{column.render(row)}</td>)}</tr>;
 })}</tbody></table></div>;
}
