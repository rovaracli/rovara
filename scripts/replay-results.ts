// Setup and test health SH20 (owner decision 5): the replay check that must pass before the four test results are turned on. It re-runs the result classifier over exported snapshots of recent tasks and fails
// when a CODE failure would be labelled as an environment fault, or shown as passing. Usage:
//   npx tsx scripts/replay-results.ts --dir <folder of task snapshots>   (exit 0: clean, 1: a violation or an unreadable file, 2: bad usage)
// A snapshot is one JSON file per task: { "taskId", "workflow", "facts"?, "evidence"?, "alreadyFailing"?, "planned"? } (what the broker stores plus the facts the auto-fix runner reads); the exporter from staging is
// separate. The check is made against an INDEPENDENT oracle (the auto-fix code classes and the evidence pack's own regression class, not the result rules), so a mistake in the rules cannot hide itself:
//   - a task with a code signal that the result calls "Blocked by environment" is a violation (the one the owner asked for);
//   - a task with a code signal that the result calls Verified or Partially verified is a violation too (a code failure shown as passing);
//   - a snapshot that cannot be read is a violation (nothing is skipped silently).
// Output is counts and task ids only: no test name, command or path is printed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AUTO_FIX_CODE_CLASS, E2E_PROJECT_CHECK_ID, EvidencePackSchema, WorkflowSnapshotSchema, classifyBlockedWorkflow, wholeTaskSpendUsd,
  type AutoFixBudget, type AutoFixFacts, type TestingResult, type WorkflowSnapshot,
} from "@agentx/contracts";
import { testingViewOf } from "../packages/broker/src/rovara-code/testing-section.js";
import { hasUnconfirmedFailingTest, type KnownFailingEntry } from "../packages/broker/src/verification/result.js";

const KnownFailingEntrySchema = z.union([z.string().min(1).max(500), z.object({ name: z.string().min(1).max(500), checkId: z.string().min(1).max(64) }).strict()]);
export const ReplaySnapshotSchema = z.object({
  taskId: z.string().min(1).max(100),
  workflow: z.unknown(),
  facts: z.record(z.string(), z.unknown()).optional(),
  evidence: z.unknown().optional(),
  alreadyFailing: z.array(KnownFailingEntrySchema).max(2_000).optional(),
  planned: z.object({ fullSuite: z.enum(["not_needed", "pending", "not_run"]).optional(), claimsNeedingRealService: z.array(z.string()).max(100).optional() }).strict().optional(),
}).strict();

export type ReplayVerdict = TestingResult | "undecided" | "unreadable";
export interface ReplayRow { taskId: string; verdict: ReplayVerdict; codeSignal: boolean; /** A check that failed on the original code too has a failing test outside the already-failing list, or one the change added. */ suspect: boolean }
export interface ReplayReport {
  total: number;
  byVerdict: Record<ReplayVerdict, number>;
  /** Tasks with a SUSPECT check: it failed on the original code too, yet has a failing test the already-failing list does not show or one the change added. Reported whatever the verdict; under the owner's rule the verdict must be Code failed, so one that is not is also listed below. */
  suspect: string[];
  /** A code failure the result calls Blocked by environment. */
  codeLabelledEnvironment: string[];
  /** A code failure the result calls Verified or Partially verified. */
  codeShownAsPassing: string[];
  unreadable: string[];
  ok: boolean;
}

/** The replay uses a budget in which no automatic retry is coming: the question asked is what the result would be once Rovara has looked at the task. */
const BUDGET: AutoFixBudget = { enabled: false, dayBudgetHasRoom: false, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: 15 } };

/** Codes whose class is "code" and that are about the tests (a review's findings have their own section, not a test result). */
const isTestCodeFault = (code: keyof typeof AUTO_FIX_CODE_CLASS): boolean => AUTO_FIX_CODE_CLASS[code] === "code" && code !== "review-findings";

/** A check that failed on the original code (by the original-code facts) that the evidence pack of THIS code does not name, or there is no such pack: it has no per-test data, so nothing about its failures is confirmed (M2). */
function failedBeforeWithoutData(workflow: WorkflowSnapshot, facts: AutoFixFacts, current: z.infer<typeof EvidencePackSchema> | undefined): boolean {
  const results = workflow.verification?.candidateDigest === workflow.candidate?.digest ? workflow.verification?.results ?? [] : [];
  return results.some((result) => result.checkId !== E2E_PROJECT_CHECK_ID && result.status === "FAILED" && (facts.checkOriginal?.[result.checkId] === "failed" || facts.checkOriginal?.[result.checkId] === "cannot-run")
    && !(current?.checks ?? []).some((check) => check.checkId === result.checkId));
}

/** Whether the stored fields show a failure of the code, by the auto-fix code classes and the evidence pack's own regression class (not by the result rules). */
export function hasCodeSignal(workflow: WorkflowSnapshot, facts: AutoFixFacts, evidence: z.infer<typeof EvidencePackSchema> | undefined, alreadyFailing: readonly KnownFailingEntry[] = []): boolean {
  const blocked = workflow.state === "BLOCKED" && (workflow.stage === "VERIFY" || workflow.stage === "REVIEW");
  if (blocked && classifyBlockedWorkflow(workflow, facts).some((signal) => isTestCodeFault(signal.code))) return true;
  const current = evidence !== undefined && evidence.candidateDigest === workflow.candidate?.digest ? evidence : undefined;
  // Owner decision (M2): a check that failed before with a failing test outside the already-failing list (or one the change added) is the code's fault too.
  return current?.checks.some((check) => check.after === "failed" && (check.class === "regression" || (check.class === "already_failing" && hasUnconfirmedFailingTest(check, alreadyFailing)))) === true
    || failedBeforeWithoutData(workflow, facts, current);
}

/** The suspect checks: failed on the original code too, with a failing test the already-failing list does not show, one the change added, failing tests the pack does not name (or names twice), a test check whose per-test data cannot be read (a compile or import break runs no test), or a check the pack does not cover. */
export function hasSuspectCheck(workflow: WorkflowSnapshot, evidence: z.infer<typeof EvidencePackSchema> | undefined, alreadyFailing: readonly KnownFailingEntry[], facts: AutoFixFacts = {}): boolean {
  const current = evidence !== undefined && evidence.candidateDigest === workflow.candidate?.digest ? evidence : undefined;
  return current?.checks.some((check) => check.after === "failed" && check.class === "already_failing" && hasUnconfirmedFailingTest(check, alreadyFailing)) === true || failedBeforeWithoutData(workflow, facts, current);
}

/** The classifier under test; the check passes the real one, and a test passes a broken one to prove the check can fail. */
export type ViewOf = typeof testingViewOf;

export function replayOne(raw: unknown, viewOf: ViewOf = testingViewOf): ReplayRow {
  const snapshot = ReplaySnapshotSchema.safeParse(raw);
  if (!snapshot.success) return { taskId: typeof (raw as { taskId?: unknown } | null)?.taskId === "string" ? (raw as { taskId: string }).taskId : "(unknown)", verdict: "unreadable", codeSignal: false, suspect: false };
  const { taskId } = snapshot.data;
  const workflow = WorkflowSnapshotSchema.safeParse(snapshot.data.workflow);
  const evidence = snapshot.data.evidence === undefined ? undefined : EvidencePackSchema.safeParse(snapshot.data.evidence);
  if (!workflow.success || (evidence !== undefined && !evidence.success)) return { taskId, verdict: "unreadable", codeSignal: false, suspect: false };
  const flow = workflow.data;
  const facts = (snapshot.data.facts ?? {}) as AutoFixFacts;
  const pack = evidence?.data;
  const known = snapshot.data.alreadyFailing ?? [];
  const codeSignal = hasCodeSignal(flow, facts, pack, known);
  const suspect = hasSuspectCheck(flow, pack, known, facts);
  const outcome = viewOf({ workflow: flow, facts, budget: BUDGET, evidence: pack, alreadyFailing: known, planned: snapshot.data.planned });
  return { taskId, verdict: outcome.view === undefined ? (outcome.waiting === "unreadable" ? "unreadable" : "undecided") : outcome.view.result, codeSignal, suspect };
}

export function replayResults(rawSnapshots: readonly unknown[], viewOf: ViewOf = testingViewOf): ReplayReport {
  const rows = rawSnapshots.map((raw) => replayOne(raw, viewOf));
  const byVerdict: Record<ReplayVerdict, number> = { verified: 0, code_failed: 0, partially_verified: 0, blocked_by_environment: 0, undecided: 0, unreadable: 0 };
  for (const row of rows) byVerdict[row.verdict] += 1;
  const ids = (keep: (row: ReplayRow) => boolean) => rows.filter(keep).map((row) => row.taskId);
  const suspect = ids((row) => row.suspect);
  const codeLabelledEnvironment = ids((row) => row.codeSignal && row.verdict === "blocked_by_environment");
  const codeShownAsPassing = ids((row) => row.codeSignal && (row.verdict === "verified" || row.verdict === "partially_verified"));
  const unreadable = ids((row) => row.verdict === "unreadable");
  return { total: rows.length, byVerdict, suspect, codeLabelledEnvironment, codeShownAsPassing, unreadable, ok: rows.length > 0 && codeLabelledEnvironment.length === 0 && codeShownAsPassing.length === 0 && unreadable.length === 0 };
}

/** The report as text: counts and task ids, never a test name, command or path. */
export function replayText(report: ReplayReport): string {
  const lines = [
    `Replayed ${String(report.total)} task${report.total === 1 ? "" : "s"}: ${Object.entries(report.byVerdict).map(([verdict, count]) => `${verdict} ${String(count)}`).join(", ")}.`,
    ...(report.suspect.length === 0 ? [] : [`SUSPECT a check that failed before has a failing test the already-failing list does not show, or one the change added (must be Code failed): ${report.suspect.join(", ")}`]),
    ...(report.codeLabelledEnvironment.length === 0 ? [] : [`FAIL code failure labelled as environment: ${report.codeLabelledEnvironment.join(", ")}`]),
    ...(report.codeShownAsPassing.length === 0 ? [] : [`FAIL code failure shown as passing: ${report.codeShownAsPassing.join(", ")}`]),
    ...(report.unreadable.length === 0 ? [] : [`FAIL snapshots that could not be read: ${report.unreadable.join(", ")}`]),
    ...(report.total === 0 ? ["FAIL no snapshots were given."] : []),
    report.ok ? "OK: no code failure is labelled as environment." : "NOT OK.",
  ];
  return lines.join("\n");
}

/** Reads every `*.json` of a folder (not below it), in name order. A file that is not JSON becomes an unreadable snapshot. */
export function readSnapshotFolder(directory: string): unknown[] {
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => {
    try { return JSON.parse(readFileSync(path.join(directory, name), "utf8")) as unknown; } catch { return { taskId: name.replace(/\.json$/u, "") }; }
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--dir");
  const directory = at === -1 ? undefined : process.argv[at + 1];
  if (directory === undefined) { console.error("Usage: replay-results.ts --dir <folder of task snapshots>"); process.exit(2); }
  const report = replayResults(readSnapshotFolder(directory));
  console.log(replayText(report));
  process.exit(report.ok ? 0 : 1);
}
