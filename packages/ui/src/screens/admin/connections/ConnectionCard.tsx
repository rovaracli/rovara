// UX3: one row of the Connections page. It always shows the same things in the same order: the name, its state in words (a tick, or "Needs attention" with why and the fix),
// who connected it, which projects use it, and one button that opens its setup in place. Nothing here changes who may connect or change a connection.
import { useId, type ReactNode } from "react";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { STATE_WORDS, type CardSummary } from "./connection-state.js";
export function ConnectionCard({ id, name, summary, by, usedBy, open, onToggle, actionWords, canChange, readOnlyReason, children }: {
  id: string; name: string; summary: CardSummary; by?: string | undefined; usedBy: string; open: boolean; onToggle: () => void; actionWords: string; canChange: boolean; readOnlyReason: string; children: ReactNode;
}) {
  const panel = useId();
  return <li className="rv-conn-card" data-state={summary.state} data-card={id}>
    <div className="rv-conn-head"><h2>{name}</h2><span className="rv-conn-state" data-state={summary.state}>{STATE_WORDS[summary.state]}</span></div>
    <p className="rv-conn-why"><VisibleText text={summary.why} />{summary.fix !== undefined && <> <strong><VisibleText text={summary.fix} /></strong></>}</p>
    <dl className="rv-conn-facts">{by !== undefined && <div><dt>Connected by</dt><dd><VisibleText text={by} /></dd></div>}<div><dt>Used by</dt><dd><VisibleText text={usedBy} /></dd></div></dl>
    <Button aria-expanded={open} aria-controls={panel} onClick={onToggle} variant={summary.state === "attention" || summary.state === "not_connected" ? "primary" : "secondary"}>{open ? "Close" : actionWords}<span className="rv-visually-hidden"> {name}</span></Button>
    {!canChange && <p className="rv-muted">{readOnlyReason}</p>}
    <div id={panel} hidden={!open} className="rv-conn-panel">{open && children}</div>
  </li>;
}
