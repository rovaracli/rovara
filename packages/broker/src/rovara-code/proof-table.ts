// Playbook P1: the requirement-to-evidence table of a Rovara Code (version 2) pull request. One row per claim of the approved plan; its evidence is the plan's checks whose `proves` names the claim
// (a check that proves a child also covers its ancestors, as the plan self-check counts it) and the browser/API scenarios `scenarioProves` names. A pure function: it reads nothing, writes
// nothing and calls no model. Every string it returns is redacted and inert (`inertLine`), because the claims, check labels and scenario titles are a model's words and the description is public to
// the repository's readers.
//
// A claim is NOT static-only when the plan self-check says so: `planQualityFindings` gives a `claim-static-only` finding for a claim proved only by checks that read files (`grep`, `cat`, `test`) and
// by no check or scenario that runs the code. That finding is the plan's own notion; this module asks it and does not guess. (The finding names at most 32 claims and only leaf claims; a parent is
// static-only when all its leaves are.)
import { TestProofSchema, type PlanClaim, type PlanDocument, type TestProof } from "@agentx/contracts";
import { planQualityFindings } from "../developer/plan-quality.js";
import { testProofPullRequestLines } from "../developer/test-proof-lines.js";
import { inertLine } from "./inert-text.js";

const CLAIM_TEXT_MAX = 300;
const LABEL_MAX = 120;
const TEST_PROOF_LINE_MAX = 300;

/** One check's recorded result for the current code, as the workflow holds it. `couldNotRun`: the command was broken, its program missing, or it never started: the code is not at fault. */
export interface ProofCheckResult {
  checkId: string;
  label?: string | undefined;
  status: "PASS" | "FAILED" | "UNKNOWN";
  couldNotRun?: boolean | undefined;
}

/** A browser or API scenario's row (`E2EDisplayScenario`), cut to what the table reads. */
export interface ProofScenarioRow {
  scenarioId: string;
  title: string;
  kind?: "web" | "api" | undefined;
  status: "PASSED" | "FAILED" | "UNKNOWN";
}

export type ProofResult = "proven" | "passed" | "failed" | "not_tested";
/** `proven`: a check that also fails on the original code (a test proof). `not_checked`: no result, or it could not run. */
export type ProofEvidenceState = "proven" | "passed" | "failed" | "not_checked";

export interface ProofEvidence {
  kind: "check" | "scenario";
  /** Inert and cut; a scenario's label is its title. */
  label: string;
  state: ProofEvidenceState;
}

export interface ProofRow {
  claimId: string;
  /** The claim's text, inert and cut to 300 characters. */
  requirement: string;
  evidence: ProofEvidence[];
  result: ProofResult;
}

/** What was not tested, in fixed words: `reason` is one of a short list, never model text. */
export interface NotTestedItem {
  kind: "claim" | "scenario" | "check";
  id: string;
  /** The claim's text, the scenario's title or the check's label, inert and cut. */
  text: string;
  reason: string;
}

export interface ProofTable {
  rows: ProofRow[];
  notTested: NotTestedItem[];
  testProofLines: string[];
}

export interface ProofTableInput {
  plan: PlanDocument;
  checkResults: readonly ProofCheckResult[];
  scenarioRows: readonly ProofScenarioRow[];
  /** Used only when its `candidateDigest` equals `candidateDigest`; otherwise ignored, as if absent. */
  testProof: TestProof | undefined;
  candidateDigest: string | undefined;
}

export const NOT_TESTED_REASONS = {
  claimNothingLinked: "no check or scenario names it",
  claimStaticOnly: "only checks that read files prove it",
  claimDidNotRun: "its checks or scenarios did not run",
  scenarioNotExercised: "it was not exercised",
  checkCouldNotRun: "it could not run",
} as const;

function flatClaims(claims: readonly PlanClaim[]): PlanClaim[] {
  return claims.flatMap((claim) => [claim, ...flatClaims(claim.children ?? [])]);
}

function leafIds(claim: PlanClaim): string[] {
  const children = claim.children ?? [];
  return children.length === 0 ? [claim.id] : children.flatMap(leafIds);
}

/** The claims the plan self-check says are proved only by checks that read files. A parent counts when all its leaves do. Anything the rules cannot read gives none. */
function staticOnlyClaimIds(plan: PlanDocument): Set<string> {
  let named: Set<string>;
  try {
    named = new Set(planQualityFindings(plan, { kind: "plan" }).filter((finding) => finding.code === "claim-static-only").flatMap((finding) => finding.claimIds ?? []));
  } catch {
    return new Set();
  }
  return new Set(flatClaims(plan.claims).filter((claim) => leafIds(claim).every((id) => named.has(id))).map((claim) => claim.id));
}

/** The test proof when it parses and is bound to the current candidate digest; otherwise nothing. */
function boundTestProof(testProof: unknown, candidateDigest: string | undefined): TestProof | undefined {
  if (candidateDigest === undefined || testProof === undefined) return undefined;
  const parsed = TestProofSchema.safeParse(testProof);
  return parsed.success && parsed.data.candidateDigest === candidateDigest ? parsed.data : undefined;
}

const oneLine = (text: string, max: number) => inertLine(text, max);

type CheckState = "passed" | "failed" | "not_checked";

export function buildProofTable(input: ProofTableInput): ProofTable {
  const { plan } = input;
  const proof = boundTestProof(input.testProof, input.candidateDigest);
  const proposed = plan.checks?.proposed ?? [];
  const proves = plan.checks?.proves ?? {};
  const labelOfCheck = new Map<string, string>();
  for (const result of input.checkResults) if (result.label !== undefined) labelOfCheck.set(result.checkId, result.label);
  for (const check of proposed) labelOfCheck.set(check.id, check.label);
  const resultOf = new Map(input.checkResults.map((result) => [result.checkId, result]));
  const stateOfCheck = (checkId: string): CheckState => {
    const result = resultOf.get(checkId);
    if (result === undefined || result.couldNotRun === true) return "not_checked";
    return result.status === "PASS" ? "passed" : result.status === "FAILED" ? "failed" : "not_checked";
  };
  const provesChange = new Set((proof?.items ?? []).filter((item) => item.verdict === "proves_change").map((item) => item.checkId));
  const checkOrder = [...new Set([...proposed.map((check) => check.id), ...Object.keys(proves)])];

  const rowOfScenario = new Map(input.scenarioRows.map((row) => [row.scenarioId, row]));
  const scenarioProves = plan.scenarioProves ?? {};
  const scenarioState = (scenarioId: string): CheckState => {
    const row = rowOfScenario.get(scenarioId);
    return row === undefined ? "not_checked" : row.status === "PASSED" ? "passed" : row.status === "FAILED" ? "failed" : "not_checked";
  };
  const titleOfScenario = (scenarioId: string) => rowOfScenario.get(scenarioId)?.title ?? scenarioId.replace(/[-_]+/gu, " ");

  const staticOnly = staticOnlyClaimIds(plan);
  const rows: ProofRow[] = [];
  const notTested: NotTestedItem[] = [];

  for (const claim of flatClaims(plan.claims)) {
    // The claim's own ID and its descendants': a proof of a child also covers its ancestors, never the reverse.
    const covered = new Set([claim.id, ...flatClaims(claim.children ?? []).map((child) => child.id)]);
    const evidence: ProofEvidence[] = [];
    for (const checkId of checkOrder) {
      if (!(proves[checkId] ?? []).some((id) => covered.has(id))) continue;
      const state = stateOfCheck(checkId);
      evidence.push({ kind: "check", label: oneLine(labelOfCheck.get(checkId) ?? checkId, LABEL_MAX), state: state === "passed" && provesChange.has(checkId) ? "proven" : state });
    }
    for (const [scenarioId, ids] of Object.entries(scenarioProves)) {
      if (!ids.some((id) => covered.has(id))) continue;
      evidence.push({ kind: "scenario", label: oneLine(titleOfScenario(scenarioId), LABEL_MAX), state: scenarioState(scenarioId) });
    }
    const has = (state: ProofEvidenceState) => evidence.some((item) => item.state === state);
    // A failure is never hidden by a proof beside it.
    const result: ProofResult = has("failed") ? "failed"
      : has("proven") ? "proven"
        : evidence.length > 0 && staticOnly.has(claim.id) ? "not_tested"
          : has("passed") ? "passed" : "not_tested";
    const requirement = oneLine(claim.text, CLAIM_TEXT_MAX);
    rows.push({ claimId: claim.id, requirement, evidence, result });
    if (result === "not_tested") {
      notTested.push({
        kind: "claim", id: claim.id, text: requirement,
        reason: evidence.length === 0 ? NOT_TESTED_REASONS.claimNothingLinked : staticOnly.has(claim.id) ? NOT_TESTED_REASONS.claimStaticOnly : NOT_TESTED_REASONS.claimDidNotRun,
      });
    }
  }

  // Scenarios the plan declares that were skipped or not exercised on this code: no row, or a row that could not tell.
  for (const scenario of plan.e2e?.scenarios ?? []) {
    if (scenarioState(scenario.scenarioId) === "not_checked") notTested.push({ kind: "scenario", id: oneLine(scenario.scenarioId, 60), text: oneLine(titleOfScenario(scenario.scenarioId), LABEL_MAX), reason: NOT_TESTED_REASONS.scenarioNotExercised });
  }
  for (const scenarioId of Object.keys(scenarioProves)) {
    if ((plan.e2e?.scenarios ?? []).some((scenario) => scenario.scenarioId === scenarioId)) continue;
    if (scenarioState(scenarioId) === "not_checked") notTested.push({ kind: "scenario", id: oneLine(scenarioId, 60), text: oneLine(titleOfScenario(scenarioId), LABEL_MAX), reason: NOT_TESTED_REASONS.scenarioNotExercised });
  }
  // Checks that could not run: the plan's proposed checks and every other result, none recorded or one that says it could not run.
  for (const checkId of [...new Set([...checkOrder, ...input.checkResults.map((result) => result.checkId)])]) {
    if (stateOfCheck(checkId) === "not_checked") notTested.push({ kind: "check", id: oneLine(checkId, 60), text: oneLine(labelOfCheck.get(checkId) ?? checkId, LABEL_MAX), reason: NOT_TESTED_REASONS.checkCouldNotRun });
  }

  const testProofLines = proof === undefined ? [] : testProofPullRequestLines(proof, input.candidateDigest, (line) => inertLine(line, TEST_PROOF_LINE_MAX));
  return { rows, notTested, testProofLines };
}
