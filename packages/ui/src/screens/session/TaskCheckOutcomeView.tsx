import type { ReactNode } from "react";
import { TESTING_REASON_TEXT, TESTING_RESULT_LABELS } from "@agentx/contracts/web";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";

const RESULT_TONE = { verified: "ok", code_failed: "bad", partially_verified: "wait", blocked_by_environment: "idle" } as const;
const RESULT_SUMMARY = { verified: "Every required check passed.", code_failed: "At least one check failed on this change.", partially_verified: "Some planned proof is still missing.", blocked_by_environment: "A required check could not give a result because of the test environment." } as const;
const PROOF_RESULT = { proven: "Proven", passed: "Passed", failed: "Failed", partly_tested: "Partly tested", not_tested: "Not tested" } as const;

/** A read-only summary of the check outcome and proof facts already served for this task. */
export function TaskCheckOutcomeView({ task, showProof = true, testingDetails }: { task: ReadTask; showProof?: boolean; testingDetails?: ReactNode }) {
 const workflow = task.workflow, candidate = workflow?.candidate, verification = workflow?.verification;
 const testing = task.testing;
 const verificationCurrent = candidate !== undefined && verification !== undefined && verification.candidateDigest === candidate.digest;
 const earlier = testing === undefined && verification !== undefined && candidate !== undefined && verification.candidateDigest !== candidate.digest;
 const verificationFailed = verificationCurrent && verification.results.some(result => result.status === "FAILED" && result.broken !== true && result.programNotFound !== true && result.neverStarted !== true);
 const verificationUnavailable = verificationCurrent && verification.results.some(result => result.status === "UNKNOWN" || result.status === "FAILED" && (result.broken === true || result.programNotFound === true || result.neverStarted === true));
 const verificationResult = !verificationCurrent || verification.reviewOnly === true ? undefined : verificationFailed ? "code_failed" : verificationUnavailable ? "blocked_by_environment" : verification.results.length > 0 && verification.results.every(result => result.status === "PASS") ? "verified" : undefined;
 const result = testing === undefined ? verificationResult : testing.result === "unknown" ? undefined : testing.result;
 const noChecks = testing !== undefined ? testing.reasons.includes("no_checks_ran") : verificationCurrent && verification.reviewOnly === true;
 const title = earlier ? "Earlier check results" : noChecks ? "No checks ran" : result === undefined ? "Check results unavailable" : result === "blocked_by_environment" ? "Couldn't run" : TESTING_RESULT_LABELS[result];
 const tone = earlier || result === undefined ? "idle" : noChecks ? "wait" : RESULT_TONE[result];
 const currentHead = candidate?.repositories ?? [];

 return <article className="rv-card" aria-label="Check outcome" data-testid="task-check-outcome">
  <div className="rv-section-head">
   <h2>{title}</h2>
   <StatusPill tone={tone} label={earlier ? "Earlier code" : noChecks ? "Not checked" : result === undefined ? "Status unavailable" : result === "blocked_by_environment" ? "Could not run" : TESTING_RESULT_LABELS[result]} />
  </div>
  {earlier ? <p className="rv-muted">These check results are for an earlier candidate and are not matched to the current code.</p>
   : noChecks ? <p>No checks were selected for this candidate.</p>
   : result !== undefined ? <p>{RESULT_SUMMARY[result]}</p>
   : testing !== undefined ? <p>The check result is not available in a format this screen recognizes.</p>
   : <p>No check result is available for the current candidate.</p>}

  {!earlier && currentHead.length > 0 && <section aria-label="Current head">
   <h3>Current head</h3>
   <ul className="rv-check-results">{currentHead.map(repository => <li key={repository.repositoryId}><VisibleText text={repository.repositoryId} /><span className="mono">{repository.commitSha.slice(0, 12)}</span></li>)}</ul>
  </section>}

  {testingDetails ?? (!earlier && (testing !== undefined && testing.rows.length > 0 || testing === undefined && verificationCurrent && verification.results.length > 0) && <section aria-label="Check results">
   <h3>Checks</h3>
   <ul className="rv-check-results">{testing !== undefined ? testing.rows.map((row, index) => <li key={row.label + ":" + String(index)}><VisibleText text={row.label} /><span>{row.status === "blocked" ? "Couldn't run" : row.status === "failed" ? "Failed" : row.status === "passed" ? "Passed" : row.status === "known_failing" ? "Already failing" : row.status === "pending" ? "Pending" : row.status === "not_run" ? "Not run" : "Status unavailable"}</span></li>) : (verification?.results ?? []).map((row, index) => <li key={row.checkId + ":" + String(index)}><VisibleText text={row.checkId} /><span>{row.status === "PASS" ? "Passed" : row.status === "FAILED" && (row.broken === true || row.programNotFound === true || row.neverStarted === true) || row.status === "UNKNOWN" ? "Couldn't run" : row.status === "FAILED" ? "Failed" : "Status unavailable"}</span></li>)}</ul>
  </section>)}

  {!verificationCurrent && verification !== undefined && testing === undefined && <section aria-label="Earlier recorded checks">
   <h3>Recorded checks for earlier candidate</h3>
   <p>These checks have not been matched to the current code.</p>
   <ul className="rv-check-results">{verification.results.map((row, index) => <li key={row.checkId + ":" + index}><VisibleText text={row.checkId} /><span>{row.status === "PASS" ? "Passed" : row.status === "FAILED" && !row.broken && !row.programNotFound && !row.neverStarted ? "Failed" : "Couldn't run"}</span></li>)}</ul>
  </section>}

  {!earlier && testing?.reasons.map(reason => <p className="rv-muted" key={reason}><VisibleText text={reason === "unknown" ? "Reason unavailable" : TESTING_REASON_TEXT[reason]} /></p>)}

  {!earlier && task.verificationReport?.failed.map((item, index) => <p key={item.label + ":" + String(index)}><b><VisibleText text={item.label} />:</b> <VisibleText text={item.summary} /></p>)}

  {showProof && !earlier && task.proofTable !== undefined && <section aria-label="Proof details">
   {task.proofTable.rows.length > 0 && <><h3>Proof</h3><ul className="rv-check-results">{task.proofTable.rows.map(row => <li key={row.claimId}><VisibleText text={row.requirement} /><span>{row.result === "unknown" ? "Status unavailable" : PROOF_RESULT[row.result]}</span></li>)}</ul></>}
   {task.proofTable.testProofLines.length > 0 && <ul className="rv-proof-lines">{task.proofTable.testProofLines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul>}
   {task.proofTable.notTested.length > 0 && <><h3>What wasn't tested</h3><ul className="rv-not-tested">{task.proofTable.notTested.map((item, index) => <li key={item.kind + ":" + item.id + ":" + String(index)}><VisibleText text={item.text + " (" + item.reason + ")"} /></li>)}</ul></>}
  </section>}
 </article>;
}
