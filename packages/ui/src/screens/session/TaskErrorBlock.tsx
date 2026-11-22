import { useId, useState, type ReactNode } from "react";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import "../../design/parts/outcome-delivery-held.css";
import "./task-page.css";

export interface TaskErrorBlockProps {
 title: string;
 happened: string;
 safe: string;
 next: string;
 /** The one primary action; it only reads again. */
 action: { label: string; onClick: () => void };
 /** A fixed reference code for support, never an identifier of a person or task. */
 refCode: string;
 /** Where a page heading is wanted the block carries it as the page's h1; inside a page it is a section heading. */
 page?: boolean;
 children?: ReactNode;
}

/**
 * The 4e error block (4f "first load failed"): a neutral card with a heading, what happened, what is safe and what to do in plain words, one primary button, and its own Ref with Copy.
 * Access lost and failed reads both use this one form. It draws only the words the owner passes in; it never repeats a write.
 */
export function TaskErrorBlock({ title, happened, safe, next, action, refCode, page = false, children }: TaskErrorBlockProps) {
 const titleId = useId(), [copied, setCopied] = useState<string>();
 const Heading = page ? "h1" : "h2";
 async function copy() {
  try { await navigator.clipboard.writeText(refCode);setCopied("Copied"); } catch { setCopied("Couldn't copy the reference."); }
 }
 return <section className="rv-outcome rv-task-error-block" aria-labelledby={titleId} data-testid="task-error-block">
  <div className="rv-outcome-body">
   <Heading id={titleId} tabIndex={-1}><VisibleText text={title} /></Heading>
   <p role="alert"><VisibleText text={happened} /></p>
   <p className="rv-muted"><VisibleText text={next === "" ? safe : safe + " " + next} /></p>
   <div><Button variant="primary" onClick={action.onClick}><VisibleText text={action.label} /></Button></div>
   <div className="rv-outcome-reference"><code>Ref <VisibleText text={refCode} /></code><Button variant="quiet" className="rv-outcome-copy" aria-label="Copy reference" onClick={() => { void copy(); }}>Copy</Button>{copied !== undefined && <span role="status">{copied}</span>}</div>
   {children}
  </div>
 </section>;
}
