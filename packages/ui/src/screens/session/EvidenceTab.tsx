import { TESTING_REASON_TEXT, TESTING_RESULT_LABELS, TESTING_ROW_STATUS_LABELS, testingSummary } from "@agentx/contracts/web";
import { SecondReviewAck } from "./SecondReviewAck.js";
import { useAppHost } from "../../host.js";
import { DataTable } from "../../design/DataTable.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";
const resultWords: Record<string, string> = { PASS: "Passed", FAILED: "Failed", UNKNOWN: "Not verified" };
type ProofTable = NonNullable<ReadTask["proofTable"]>;
type Testing = NonNullable<ReadTask["testing"]>;
// Setup and test health SH19: the four test results with one row per check, in the contract's fixed words (the pull request's Testing section says the same). Every word is fixed; a check's label and command are the approved check's own.
function TestingSection({ testing }: { testing: Testing }) {
 // A reader that meets a word it does not know (a newer server) says "unavailable" instead of guessing.
 const words = (map: Readonly<Record<string, string>>, key: string, fallback: string) => map[key] ?? fallback;
 const resultOf = (row: Testing["rows"][number]) => words(TESTING_ROW_STATUS_LABELS, row.status, "status unavailable") + (row.status === "passed" && row.passedTests !== undefined ? " (" + row.passedTests + " tests)" : "") + (row.reason === undefined ? "" : ": " + words(TESTING_REASON_TEXT, row.reason, "reason unavailable"));
 const known = testing.result !== "unknown" && testing.rows.every(row => row.status !== "unknown");
 return <section aria-label="Test result"><h2>{"Testing: " + words(TESTING_RESULT_LABELS, testing.result, "Result unavailable")}</h2>{known && <p>{testingSummary(testing as Parameters<typeof testingSummary>[0])}</p>}
  {testing.rows.length > 0 && <DataTable caption="Checks and their results" rowKey={row => row.label + ":" + row.command} rows={testing.rows} columns={[
   { key: "check", title: "Check", render: row => <VisibleText text={row.label} /> },
   { key: "command", title: "Command", render: row => <VisibleText text={row.command} /> },
   { key: "result", title: "Result", render: row => resultOf(row) },
  ]} />}</section>;
}
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
type Evidence = NonNullable<ReadTask["evidence"]>;
type Check = Evidence["checks"][number];
type Link = Evidence["browser"][number]["strip"]["before"][number];
const kindWords: Record<string, string> = { test: "Tests", lint: "Lint", typecheck: "Type check", security: "Security scan", migration: "Migrations", build: "Build", smoke: "Smoke", other: "Other checks" };
const outcomeWords: Record<string, string> = { passed: "passed", failed: "failed", timed_out: "timed out", unknown: "not verified", not_run: "not run" };
const classWords: Record<string, string> = { passing: "passing", regression: "a regression", already_failing: "already failing before", fixed: "fixed", failing_no_before: "failing, no earlier run to compare", not_rerun: "not run again" };
const testStatusWords: Record<string, string> = { passed: "passed", failed: "failed", skipped: "skipped", errored: "errored" };
const proofVerdictWords: Record<string, string> = { proves_change: "fails on the original code", could_not_run_on_old: "could not run on the original code", does_not_prove: "passes on the original code too", not_checked: "not checked", not_applicable: "not a test" };
const tierWords: Record<string, string> = { sandbox: "Sandbox", preview: "Per-task preview environment", shared: "Shared test environment" };
const modeWords: Record<string, string> = { preprod: "pre-production", mocked: "mocked", "live-forbidden": "live access refused" };
const diffWords: Record<string, string> = { none: "no difference from before", changed: "fields changed", no_baseline: "nothing to compare with" };
const withheldWords: Record<string, string> = { account_not_run_scoped: "an account is not single-use", tier_not_allowed: "this test environment does not allow it", data_not_synthetic: "the data is not synthetic", company_setting_off: "the company setting is off", revocation_not_confirmed: "the test accounts could not be confirmed closed", size_over_cap: "too large", upload_failed: "the upload failed" };
const linkStateWords: Record<string, string> = { expired: "expired", withheld: "withheld" };
const isLink = (value: unknown): value is Link => typeof value === "object" && value !== null && "state" in value;

/** An artifact's route as a link of this origin, or nothing: only a Rovara route that stays on this origin is ever followed. */
function useArtifactUrl() {
 const host = useAppHost();
 return (link: Link): string | undefined => {
  if (link.state !== "available" || typeof link.href !== "string") return undefined;
  try { const url = new URL(link.href, host.origin);return url.origin === new URL(host.origin).origin && url.pathname.startsWith("/v1/app/") ? url.href : undefined; } catch { return undefined; }
 };
}
const sizeWords = (bytes: number): string => bytes >= 1_048_576 ? (bytes / 1_048_576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";

function ChecksByKind({ checks }: { checks: readonly Check[] }) {
 const kinds = [...new Set(checks.map(check => check.kind))];
 return <><h3>Checks</h3>{kinds.map(kind => <section key={kind} aria-label={kindWords[kind] ?? "Checks"}><h4>{kindWords[kind] ?? "Other checks"}</h4><ul className="rv-evidence-checks">{checks.filter(check => check.kind === kind).map(check => <li key={check.checkId}><VisibleText text={check.label} /><span>{" before: " + (outcomeWords[check.before] ?? "unavailable") + ", after: " + (outcomeWords[check.after] ?? "unavailable") + ", " + (classWords[check.class] ?? "status unavailable") + ", " + Math.max(0, Math.round(check.durationMs / 1000)) + " s"}</span></li>)}</ul></section>)}</>;
}
function TestsSection({ evidence }: { evidence: Evidence }) {
 const withTests = evidence.checks.filter(check => check.tests !== undefined), sel = evidence.selection;
 const selection = sel.method === "full" ? "The whole test suite ran." : sel.selected + " of " + sel.total + " tests selected (" + (({ coverage_map: "coverage map", import_graph: "import graph", declared: "declared" } as Record<string, string>)[sel.method] ?? "selection") + (sel.mapAgeHours === undefined ? "" : ", " + sel.mapAgeHours + " h old") + "). " + (sel.total - sel.selected) + " not run.";
 return <><h3>Tests</h3><p>{selection}</p>
  {sel.lastFullRun && <p>{"Last full run: " + sel.lastFullRun.status + ", " + sel.lastFullRun.passed + " of " + sel.lastFullRun.total + " passed" + (sel.lastFullRun.flaky > 0 ? ", " + sel.lastFullRun.flaky + " flaky" : "") + "."}</p>}
  {withTests.map(check => { const tests = check.tests!;return <section key={check.checkId} aria-label={"Tests in " + check.label}><h4><VisibleText text={check.label} /></h4>
   <dl className="rv-evidence-counts"><div><dt>Passed</dt><dd>{tests.passed}</dd></div><div><dt>Failed</dt><dd>{tests.failed}</dd></div><div><dt>Skipped</dt><dd>{tests.skipped}</dd></div><div><dt>Errored</dt><dd>{tests.errored}</dd></div></dl>
   {tests.newTests.length > 0 && <><h5>New tests</h5><ul>{tests.newTests.map((name, index) => <li key={index}><VisibleText text={name} /></li>)}</ul></>}
   {tests.names.length > 0 && <details><summary>{"All " + tests.names.length + " test names"}</summary><ul className="rv-evidence-tests">{tests.names.map((test, index) => <li key={index}><VisibleText text={test.name} /> <span>{testStatusWords[test.status] ?? "status unavailable"}{test.proof ? " (" + (proofVerdictWords[test.proof] ?? "not verified") + ")" : ""}</span></li>)}</ul></details>}
  </section>; })}</>;
}
function CoverageSection({ checks }: { checks: readonly Check[] }) {
 const covered = checks.filter(check => check.coverage !== undefined);
 if (covered.length === 0) return <><h3>Changed-line coverage</h3><p>No coverage report.</p></>;
 return <><h3>Changed-line coverage</h3>{covered.map(check => { const coverage = check.coverage!;return <section key={check.checkId} aria-label={"Coverage of " + check.label}><p>{coverage.linesCovered + " of " + coverage.linesChanged + " changed lines covered" + (coverage.linesChanged > 0 ? " (" + Math.round(100 * coverage.linesCovered / coverage.linesChanged) + "%)" : "") + "."}</p>
  {(coverage.unlistedFiles ?? 0) > 0 && <p>{(coverage.unlistedFiles ?? 0) + " changed source file" + (coverage.unlistedFiles === 1 ? " is" : "s are") + " not in the coverage report."}</p>}
  {coverage.files.length > 0 && <ul>{coverage.files.map(file => <li key={file.path}><VisibleText text={file.path} />{file.uncovered.length > 0 && <span>{" uncovered lines: " + file.uncovered.join(", ")}</span>}</li>)}</ul>}</section>; })}</>;
}
function ApiSection({ evidence }: { evidence: Evidence }) {
 const url = useArtifactUrl();
 if (evidence.api.length === 0) return null;
 return <><h3>API checks</h3>{evidence.api.map(entry => <section key={entry.scenarioId} aria-label={"API check " + entry.scenarioId}><h4><VisibleText text={entry.scenarioId} /></h4><p>{diffWords[entry.diff] ?? "status unavailable"}</p>
  {entry.changedPaths.length > 0 && <ul>{entry.changedPaths.map((path, index) => <li key={index}><VisibleText text={path} /></li>)}</ul>}
  <ul>{entry.samples.filter(isLink).map((sample, index) => { const href = url(sample);return <li key={index}>{href ? <a href={href} download>{"Sample " + (index + 1) + " (" + sizeWords(sample.bytes) + ")"}</a> : "Sample " + (index + 1) + " " + (linkStateWords[sample.state] ?? "unavailable")}</li>; })}</ul></section>)}</>;
}
function Strip({ label, links }: { label: string; links: readonly Link[] }) {
 const url = useArtifactUrl();
 if (links.length === 0) return null;
 return <div className="rv-evidence-strip" role="group" aria-label={label}>{links.filter(isLink).map((link, index) => { const href = url(link);return href ? <a key={index} href={href} target="_blank" rel="noreferrer"><img src={href} alt={label + ", step " + (index + 1)} loading="lazy" width={160} /></a> : <span key={index}>{"Step " + (index + 1) + " " + (linkStateWords[link.state] ?? "unavailable")}</span>; })}</div>;
}
function BrowserSection({ evidence }: { evidence: Evidence }) {
 const url = useArtifactUrl();
 if (evidence.browser.length === 0) return null;
 return <><h3>Browser checks</h3>{evidence.browser.map(entry => { const video = isLink(entry.video) ? url(entry.video) : undefined, trace = isLink(entry.trace) ? url(entry.trace) : undefined;return <section key={entry.scenarioId} aria-label={"Browser check " + entry.scenarioId}><h4><VisibleText text={entry.scenarioId} /></h4>
  <Strip label={entry.scenarioId + ", before"} links={entry.strip.before} /><Strip label={entry.scenarioId + ", after"} links={entry.strip.after} />
  {video && <video controls preload="none" src={video} aria-label={"Recording of " + entry.scenarioId} width={320} />}
  {trace && <p><a href={trace} download>Download the trace</a> (open it with Playwright's trace viewer; Rovara doesn't open it)</p>}
  {entry.consoleErrors !== undefined && entry.consoleErrors > 0 && <p>{entry.consoleErrors + " console " + (entry.consoleErrors === 1 ? "error" : "errors")}</p>}
  {(entry.withheld ?? []).map((item, index) => <p key={index}>{(item.artifact === "video" ? "Video" : "Trace") + " not kept: " + (withheldWords[item.reason] ?? "not allowed") + "."}</p>)}</section>; })}</>;
}
function EnvironmentSection({ environment }: { environment: Evidence["environment"] }) {
 return <><h3>Environment</h3><p>{(tierWords[environment.tier] ?? "Test environment") + ", revision " + environment.envRevision + ". Test data: synthetic."}</p>
  {environment.services.length > 0 && <ul>{environment.services.map(service => <li key={service.name}><VisibleText text={service.name} /><span>{": " + (modeWords[service.mode] ?? "unavailable") + (service.recordedAt ? ", recorded " + service.recordedAt.slice(0, 10) : "") + (service.unrecordedAnswered ? ", " + service.unrecordedAnswered + " unrecorded requests answered" : "")}</span></li>)}</ul>}
  {environment.accounts.length > 0 && <p>{"Test accounts: " + environment.accounts.map(account => account.profileId + (account.kind === "run_scoped" ? " (single-use)" : " (registered)")).join(", ")}</p>}</>;
}
const extraKinds = new Set(["mocked_service", "not_selected", "environment"]);
function EvidenceSections({ evidence }: { evidence: Evidence }) {
 const extra = evidence.notTested.filter(item => extraKinds.has(item.kind));
 return <section aria-label="Evidence from the checks"><ChecksByKind checks={evidence.checks} /><TestsSection evidence={evidence} /><CoverageSection checks={evidence.checks} /><ApiSection evidence={evidence} /><BrowserSection evidence={evidence} /><EnvironmentSection environment={evidence.environment} />
  {extra.length > 0 && <><h3>Also not tested here</h3><ul className="rv-not-tested">{extra.map((item, index) => <li key={item.kind + ":" + item.id + ":" + index}><VisibleText text={item.text + " (" + item.reason + ")"} /></li>)}</ul></>}</section>;
}
export function EvidenceTab({ task, sessionId }: { task: ReadTask; sessionId?: string }) {
 const shared = task.e2ePresentation?.shared, workflow = task.workflow, verification = workflow?.verification;
 const labels = new Map([...(workflow?.checkPolicy?.required ?? []), ...(workflow?.checkPolicy?.optional ?? []), ...(workflow?.checkPolicy?.proposed ?? [])].map(check => [check.id, check.label]));
 const current = verification !== undefined && workflow?.candidate?.digest === verification.candidateDigest;
 // Playbook P2: the reviewer model lines are the pull request's (Trust fix A2's), carried by the view; this page chooses and counts nothing.
 // RULING Q34: use the real aggregate and canonical workflow receipts; pageHtml and invented per-case notes never enter the UI.
 return <section aria-label="Test evidence">{shared && <><h2>End-to-end evidence</h2><p><VisibleText text={shared.e2e.label} /></p><p>{resultWords[shared.e2e.status] ?? "Status unavailable"}</p><dl className="rv-evidence-counts"><div><dt>Cases executed</dt><dd>{shared.e2e.executedCases}</dd></div><div><dt>Required criteria verified</dt><dd>{shared.e2e.qualifiedCriteria} of {shared.e2e.requiredCriteria}</dd></div><div><dt>Result groups received</dt><dd>{shared.e2e.receivedGroups} of {shared.e2e.expectedGroups}</dd></div></dl>{shared.e2e.unexercisedBehaviors.length > 0 && <><h3>Not exercised</h3><ul>{shared.e2e.unexercisedBehaviors.map((text, index) => <li key={index}><VisibleText text={text} /></li>)}</ul></>}</>}
 {task.testing && <TestingSection testing={task.testing} />}
 {task.proofTable && <ProofSection proof={task.proofTable} earlier={verification !== undefined && !current} />}
 {task.evidence && <EvidenceSections evidence={task.evidence} />}
 {verification && <><h2>{current ? "Recorded checks" : "Earlier check results"}</h2>{!current && <p className="rv-muted">These checks have not been matched to the current code.</p>}<ul className="rv-check-results">{verification.results.map((result, index) => <li key={result.checkId + ":" + String(index)}><VisibleText text={labels.get(result.checkId) ?? result.checkId} /><span>{result.broken || result.neverStarted || result.programNotFound ? "Couldn't run" : resultWords[result.status] ?? "Status unavailable"}</span></li>)}</ul></>}
 {task.reviewModelLines && <><h2>Reviews</h2><ul className="rv-review-models">{task.reviewModelLines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></>}
 {task.secondReview && <><h2>Second review</h2><ul className="rv-second-review">{task.secondReview.lines.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul>{task.secondReview.needsAcknowledgement && !task.secondReview.acknowledged && (sessionId === undefined || task.workflow?.candidate?.digest === undefined ? <p className="rv-muted">The task owner is asked to acknowledge this before the pull request is merged.</p> : <SecondReviewAck taskId={task.taskId} candidateDigest={task.workflow.candidate.digest} sessionId={sessionId} canAcknowledge={task.secondReview.canAcknowledge === true} />)}</>}
 {!shared && !verification && !task.proofTable && !task.evidence && !task.testing && !task.reviewModelLines && !task.secondReview && <p>No test results are available yet.</p>}</section>;
}
