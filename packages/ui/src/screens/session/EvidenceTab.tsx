import { DataTable } from "../../design/DataTable.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";
const resultWords: Record<string, string> = { PASS: "Passed", FAILED: "Failed", UNKNOWN: "Not verified" };
type ProofTable = NonNullable<ReadTask["proofTable"]>;
const proofResultWords: Record<string, string> = { proven: "Proven", passed: "Passed", failed: "Failed", partly_tested: "Partly tested", not_tested: "Not tested" };
const proofEvidenceWords: Record<string, string> = { proven: "passed, fails on the original code", passed: "passed", failed: "failed", not_checked: "not checked" };
const notTestedNouns: Record<string, string> = { claim: "Requirement", scenario: "Scenario", check: "Check" };
// Playbook P3: the same rows, test-proof lines and "What wasn't tested" list as the pull request's Proof section. The list is never collapsed: it is what a reader must not miss.
function ProofSection({ proof, earlier }: { proof: ProofTable; earlier: boolean }) {
 const evidenceText = (row: ProofTable["rows"][number]) => row.evidence.length === 0 ? "None" : row.evidence.map(item => (item.kind === "scenario" ? "Scenario: " : "") + item.label + " (" + (proofEvidenceWords[item.state] ?? "status unavailable") + ")").join("; ");
 return <><DataTable caption={earlier ? "Proof from earlier check results" : "Proof"} rowKey={row => row.claimId} rows={proof.rows} columns={[
  { key: "requirement", title: "Requirement", render: row => <VisibleText text={row.claimId + ": " + row.requirement} /> },
  { key: "evidence", title: "Evidence", render: row => <VisibleText text={evidenceText(row)} /> },
  { key: "result", title: "Result", render: row => proofResultWords[row.result] ?? "Status unavailable" },
 ]} />
 {earlier && <p className="rv-muted">This proof uses check results that have not been matched to the current code.</p>}
 {proof.testProofLines.length > 0 && <ul className="rv-proof-lines">{proof.testProofLines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul>}
 {proof.notTested.length > 0 && <><h3>What wasn't tested</h3><ul className="rv-not-tested">{proof.notTested.map((item, index) => <li key={item.kind + ":" + item.id + ":" + String(index)}><VisibleText text={(notTestedNouns[item.kind] ?? "Item") + " " + (item.kind === "claim" ? item.id + ": " : "") + item.text + " (" + item.reason + ")"} /></li>)}</ul></>}</>;
}
export function TestsTab({ task }: { task: ReadTask }) {
 const shared = task.e2ePresentation?.shared, workflow = task.workflow, verification = workflow?.verification;
 const labels = new Map([...(workflow?.checkPolicy?.required ?? []), ...(workflow?.checkPolicy?.optional ?? []), ...(workflow?.checkPolicy?.proposed ?? [])].map(check => [check.id, check.label]));
 const current = verification !== undefined && workflow?.candidate?.digest === verification.candidateDigest;
 // Playbook P2: the reviewer model lines are the pull request's (Trust fix A2's), carried by the view; this page chooses and counts nothing.
 // RULING Q34: use the real aggregate and canonical workflow receipts; pageHtml and invented per-case notes never enter the UI.
 return <section aria-label="Test evidence">{shared && <><h2>End-to-end evidence</h2><p><VisibleText text={shared.e2e.label} /></p><p>{resultWords[shared.e2e.status] ?? "Status unavailable"}</p><dl className="rv-evidence-counts"><div><dt>Cases executed</dt><dd>{shared.e2e.executedCases}</dd></div><div><dt>Required criteria verified</dt><dd>{shared.e2e.qualifiedCriteria} of {shared.e2e.requiredCriteria}</dd></div><div><dt>Result groups received</dt><dd>{shared.e2e.receivedGroups} of {shared.e2e.expectedGroups}</dd></div></dl>{shared.e2e.unexercisedBehaviors.length > 0 && <><h3>Not exercised</h3><ul>{shared.e2e.unexercisedBehaviors.map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul></>}</>}
 {task.proofTable && <ProofSection proof={task.proofTable} earlier={verification !== undefined && !current} />}
 {verification && <><h2>{current ? "Recorded checks" : "Earlier check results"}</h2>{!current && <p className="rv-muted">These checks have not been matched to the current code.</p>}<ul className="rv-check-results">{verification.results.map((result, index) => <li key={result.checkId + ":" + String(index)}><VisibleText text={labels.get(result.checkId) ?? result.checkId} /><span>{result.broken || result.neverStarted || result.programNotFound ? "Couldn't run" : resultWords[result.status] ?? "Status unavailable"}</span></li>)}</ul></>}
 {task.reviewModelLines && <><h2>Reviews</h2><ul className="rv-review-models">{task.reviewModelLines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></>}
 {!shared && !verification && !task.proofTable && !task.reviewModelLines && <p>No test results are available yet.</p>}</section>;
}
