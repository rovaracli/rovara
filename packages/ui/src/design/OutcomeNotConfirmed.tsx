import { useId, useState } from "react";
import { Button } from "./Button.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/outcome-delivery-held.css";

export interface OutcomeNotConfirmedProps {
 title: string;
 happened: string;
 safe: string;
 next: string;
 check: { label: string; onCheck: () => void };
 refCode: string;
 /** A fact verified by the caller's read; never inferred from pressing Check. */
 afterCheck?: string;
 busy?: boolean;
}

/** Explains a lost answer. The only domain action checks; it never repeats a write. */
export function OutcomeNotConfirmed({ title, happened, safe, next, check, refCode, afterCheck, busy = false }: OutcomeNotConfirmedProps) {
 const titleId = useId();
 const [copyResult, setCopyResult] = useState<{ refCode: string; message: string }>();
 async function copyReference() {
  try {
   await navigator.clipboard.writeText(refCode);
   setCopyResult({ refCode, message: "Copied" });
  } catch {
   setCopyResult({ refCode, message: "Couldn't copy the reference." });
  }
 }
 return <section className="rv-outcome" aria-labelledby={titleId}>
  <header className="rv-outcome-header"><svg className="rv-outcome-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M6.4 6a1.7 1.7 0 1 1 2.8 1.3C8.4 7.8 8 8.1 8 9M8 10.5v1" /></svg><h3 id={titleId}><VisibleText text={title} /></h3></header>
  <div className="rv-outcome-body">
   <div><h4>What happened</h4><p><VisibleText text={happened} /></p></div>
   <div><h4>What is safe</h4><p><VisibleText text={safe} /></p></div>
   <div><h4>What to do</h4><p><VisibleText text={next} /></p><Button variant="primary" busy={busy} onClick={() => { if (!busy) check.onCheck(); }}><VisibleText text={check.label} /></Button></div>
   <div className="rv-outcome-reference"><code>Ref <VisibleText text={refCode} /></code><Button variant="quiet" className="rv-outcome-copy" onClick={() => { void copyReference(); }}>Copy</Button>{copyResult?.refCode === refCode && <span role="status"><VisibleText text={copyResult.message} /></span>}</div>
  </div>
  {afterCheck !== undefined && <p className="rv-outcome-after"><span aria-hidden="true">✓</span><VisibleText text={afterCheck} /></p>}
 </section>;
}
