// The trial allowance as a calm card: what is used and left for models and for machine time, a plain bar, and when it ends (or that it renews).
import type { Allowance, TrialView } from "../../api/trial-billing.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Usd } from "./format.js";
import { allowanceName, heldPercent, hoursText, refreshWords, stateWords, usedPercent } from "./trial-logic.js";

function Amount({ allowance, value }: { allowance: Allowance; value: number }) { return allowance.unit === "usd" ? <Usd usd={value} /> : <>{hoursText(value)}</>; }

function AllowanceRow({ allowance }: { allowance: Allowance }) {
 const used = usedPercent(allowance), held = heldPercent(allowance), name = allowanceName(allowance.kind);
 return <li className="rv-tb-allowance" data-state={allowance.state}>
  <div className="rv-tb-allowance-head"><h3>{name}</h3><span className="rv-tb-state">{stateWords(allowance.state)}</span></div>
  <div className="rv-tb-bar" aria-hidden="true"><span className="rv-tb-bar-used" style={{ width: `${String(used)}%` }} /><span className="rv-tb-bar-held" style={{ width: `${String(held)}%` }} /></div>
  <dl className="rv-tb-figures">
   <div><dt>Used</dt><dd><Amount allowance={allowance} value={allowance.used} /> <span className="rv-muted">of <Amount allowance={allowance} value={allowance.granted} />, {String(Math.round(used))}% used</span></dd></div>
   <div><dt>Left</dt><dd><Amount allowance={allowance} value={allowance.left} /></dd></div>
   {allowance.held !== undefined && allowance.held > 0 && <div><dt>Set aside for work in progress</dt><dd><Amount allowance={allowance} value={allowance.held} /></dd></div>}
  </dl>
  <p className="rv-muted">{refreshWords(allowance)}</p>
 </li>;
}

export function TrialCard({ trial }: { trial: TrialView }) {
 return <section className="rv-tb-card" aria-labelledby="tb-allowance">
  <h2 id="tb-allowance">Allowance</h2>
  {trial.allowances.length === 0 ? <p>No allowance is set for this company.</p> : <ul className="rv-tb-allowances" aria-label="Allowances">{trial.allowances.map((allowance, index) => <AllowanceRow key={`${allowance.kind}-${String(index)}`} allowance={allowance} />)}</ul>}
  <p><strong>When it ends.</strong> <VisibleText text={trial.ends.text} /></p>
  {trial.you.member !== null && <p className="rv-muted">Your own share: <Usd usd={trial.you.member.spentUsd} /> used of <Usd usd={trial.you.member.limitUsd} /> each month.</p>}
 </section>;
}
