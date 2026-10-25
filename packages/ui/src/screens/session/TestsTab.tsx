import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";
const resultWords: Record<string, string> = { PASS: "Passed", FAILED: "Failed", UNKNOWN: "Not verified" };
export function TestsTab({ task }: { task: ReadTask }) {
 const shared = task.e2ePresentation?.shared, workflow = task.workflow, verification = workflow?.verification;
 const labels = new Map([...(workflow?.checkPolicy?.required ?? []), ...(workflow?.checkPolicy?.optional ?? []), ...(workflow?.checkPolicy?.proposed ?? [])].map(check => [check.id, check.label]));
 const current = verification !== undefined && workflow?.candidate?.digest === verification.candidateDigest;
 // RULING Q34: use the real aggregate and canonical workflow receipts; pageHtml and invented per-case notes never enter the UI.
 return <section aria-label="Test evidence">{shared && <><h2>End-to-end evidence</h2><p><VisibleText text={shared.e2e.label} /></p><p>{resultWords[shared.e2e.status] ?? "Status unavailable"}</p><dl className="rv-evidence-counts"><div><dt>Cases executed</dt><dd>{shared.e2e.executedCases}</dd></div><div><dt>Required criteria verified</dt><dd>{shared.e2e.qualifiedCriteria} of {shared.e2e.requiredCriteria}</dd></div><div><dt>Result groups received</dt><dd>{shared.e2e.receivedGroups} of {shared.e2e.expectedGroups}</dd></div></dl>{shared.e2e.unexercisedBehaviors.length > 0 && <><h3>Not exercised</h3><ul>{shared.e2e.unexercisedBehaviors.map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul></>}</>}
 {verification && <><h2>{current ? "Recorded checks" : "Earlier check results"}</h2>{!current && <p className="rv-muted">These checks have not been matched to the current code.</p>}<ul className="rv-check-results">{verification.results.map((result, index) => <li key={result.checkId + ":" + String(index)}><VisibleText text={labels.get(result.checkId) ?? result.checkId} /><span>{result.broken || result.neverStarted || result.programNotFound ? "Couldn't run" : resultWords[result.status] ?? "Status unavailable"}</span></li>)}</ul></>}
 {!shared && !verification && <p>No test results are available yet.</p>}</section>;
}
