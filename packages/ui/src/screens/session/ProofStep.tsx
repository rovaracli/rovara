import type { ProofRowModel, ProofState, ReadProofItem } from "../../api/work.js";
import { provenCount } from "../../api/work.js";
import { EvalResult } from "../../design/EvalResult.js";
import { StatusPill, type StatusTone } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";

const STATE: Record<ProofState, { tone: StatusTone; label: string }> = {
 not_run: { tone: "idle", label: "Not run" }, running: { tone: "run", label: "Running" }, partly: { tone: "run", label: "Some checks" }, pass: { tone: "ok", label: "Pass" }, fail: { tone: "bad", label: "Fail" }, stale: { tone: "wait", label: "Out of date" },
};
const isEval = (item: ReadProofItem): item is ReadProofItem & { passed: number; total: number } => item.kind === "eval" && item.passed !== undefined && item.total !== undefined;

/** One acceptance criterion's proof: how it was checked, the result and, for an eval, its box. */
export function ProofRow({ row }: { row: ProofRowModel }) {
 const { tone, label } = STATE[row.state], evals = row.items.filter(isEval);
 return <tr data-criterion={row.criterion.id} data-state={row.state}>
  <td><span className="mono">{row.criterion.id}</span> <VisibleText text={row.criterion.then} /></td>
  <td className="rv-muted">{row.items.length === 0 ? "Not checked yet" : row.items.map(item => item.title).join(" · ")}{evals.map(item => <EvalResult key={item.sha256} passed={item.passed} total={item.total} bar={item.bar} failed={item.verdict === "fail"} />)}</td>
  <td><StatusPill tone={tone} label={label} /></td>
 </tr>;
}

/** The proof table: one row per criterion, then what else was checked. A check that ran on older code says so, because a new push makes proof out of date. */
export function ProofStep({ rows, items, heading = "Proof" }: { rows: readonly ProofRowModel[]; items: readonly ReadProofItem[]; heading?: string }) {
 const [proven, total] = provenCount(rows), commit = items.find(item => item.commit !== undefined)?.commit, stale = rows.some(row => row.state === "stale");
 const also = items.filter(item => item.criterionIds.length === 0);
 return <section aria-label={heading} className="rv-proof">
  <div className="rv-section-head"><h3>{heading}</h3><span>{total === 0 ? "No criteria yet" : <StatusPill tone={proven === total ? "ok" : "idle"} label={`${proven} of ${total} criteria proven`} />}</span></div>
  {commit !== undefined && <p className="rv-muted rv-proof-note">Checked on commit <span className="mono">{commit.slice(0, 7)}</span>. {stale ? "Some of it ran on older code and is out of date." : "A new push makes this proof out of date until the checks run again."}</p>}
  {rows.length > 0 && <div className="rv-table-wrap"><table className="rv-proof-table"><caption className="rv-visually-hidden">Proof for each acceptance criterion</caption><thead><tr><th scope="col">Criterion</th><th scope="col">How it was checked</th><th scope="col">Result</th></tr></thead><tbody>{rows.map(row => <ProofRow key={row.criterion.id} row={row} />)}</tbody></table></div>}
  {also.length > 0 && <p className="rv-muted rv-proof-also"><b>Also checked.</b> {also.map((item, index) => <span key={item.sha256}>{index > 0 ? " · " : ""}<VisibleText text={item.title} />{item.verdict === "fail" ? " (failed)" : ""}</span>)}</p>}
 </section>;
}
