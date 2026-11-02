// Setup and test health SH18/SH19: the Testing view of a task, read for the pull request's `## Testing` section, its rewrite after a pushed fix, and the task page. It exists only while `vx` is on: with it off this
// returns undefined without a read, and every caller leaves its text as it was. Everything it reads is a stored field: the workflow, the broker's evidence pack, the project's already-failing set (the nightly
// baseline and a maintainer's marks, `alreadyFailingForResults`), the follow-up full run and the stored ask. The view is a classifier answer (SH5) plus rows (`rovara-code/testing-section.ts`); anything that is
// not decided, or does not fit the contract, is `undefined`, and an undecided result is never guessed.
import { AUTO_FIX_DEFAULT_CAP_USD, autoFixAskCard, wholeTaskSpendUsd, type AutoFixBudget, type EvidencePack, type TestingView, type WorkflowSnapshot } from "@agentx/contracts";
import { AutoFixAskSchema } from "../../developer/autofix-messages.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { needsFullSuiteFollowup, readFollowup } from "../../rovara-code/full-suite-followup.js";
import { testingViewOf } from "../../rovara-code/testing-section.js";
import { alreadyFailingForResults } from "../../test-env/known-failing.js";
import { verifyResultsEnabled } from "../../verification/switch.js";
import type { FullSuiteState } from "../../verification/result.js";

export interface TestingViewDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The evidence port (only while the proof switch is on); absent, the view says "the test details are missing" and cannot be Verified. */
  evidence?: { pack: (task: { taskId: string; ownerKey: string; workspaceId: string }, candidateDigest: string | undefined) => Promise<EvidencePack | undefined> } | undefined;
}

/** Whether Rovara's own automatic fixing is on, read the way the runner reads it (on unless exactly `false`). */
const autofixOn = (env: NodeJS.ProcessEnv): boolean => env.AUTOFIX_ENABLED?.trim().toLowerCase() !== "false";

/**
 * The follow-up full run as the classifier takes it. Undefined for a follow-up that FAILED: a failed full run is neither "code failed" nor "partially verified" in the classifier, so no result is shown
 * (the merge card already treats it as high risk).
 */
async function fullSuiteOf(deps: TestingViewDeps, task: DeveloperTaskRecord, pack: EvidencePack | undefined, digest: string): Promise<FullSuiteState | "failed"> {
  if (pack === undefined || task.orgId === undefined) return "not_needed";
  const needed = needsFullSuiteFollowup({ selection: pack.selection, testChecks: pack.checks.filter((check) => check.kind === "test") });
  if (!needed) return "not_needed";
  const followup = await readFollowup({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, admit: () => Promise.reject(new Error("read only")) }, { orgId: task.orgId, project: task.project, taskId: task.taskId, candidateDigest: digest }).catch(() => undefined);
  if (followup === undefined) return "not_run";
  if (followup.state === "queued" || followup.state === "running") return "pending";
  if (followup.state === "passed") return "not_needed";
  return followup.state === "failed" ? "failed" : "not_run";
}

/** The Testing view of the task's current code, or undefined (switch off, version 1 task, not decided yet, a failed full run, or a view the contract refuses). Never throws. */
export async function loadTestingView(deps: TestingViewDeps, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, env: NodeJS.ProcessEnv = process.env): Promise<TestingView | undefined> {
  if (!verifyResultsEnabled(env) || workflow.definitionVersion !== "1.1.0") return undefined;
  const digest = workflow.candidate?.digest;
  if (digest === undefined) return undefined;
  try {
    const blocked = workflow.state === "BLOCKED" && (workflow.stage === "VERIFY" || workflow.stage === "REVIEW");
    // A blocked task's retry is "still coming" until Rovara has looked at it and stored its ask for THIS blocked revision. Before that, Rovara may still retry, so no environment result is claimed; after it, no retry is coming.
    const ask = blocked ? AutoFixAskSchema.safeParse(task.autofixAsk) : undefined;
    const asked = ask?.success === true && ask.data.workflowRevision === workflow.revision ? ask.data : undefined;
    if (blocked && asked === undefined && autofixOn(env)) return undefined;
    const evidence = await deps.evidence?.pack(task, digest).catch(() => undefined);
    const fullSuite = await fullSuiteOf(deps, task, evidence, digest);
    if (fullSuite === "failed") return undefined;
    const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    const alreadyFailing = task.orgId === undefined ? [] : await alreadyFailingForResults(store, task.orgId, task.project).catch(() => [] as string[]);
    // The stored ask says the decision was made; no automatic retry is coming (the policy would only look again at a task it can still act on).
    const budget: AutoFixBudget = { enabled: false, dayBudgetHasRoom: false, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 0, capUsd: AUTO_FIX_DEFAULT_CAP_USD } };
    const outcome = testingViewOf({ workflow, facts: {}, budget, evidence, alreadyFailing, planned: { fullSuite } });
    const view = outcome.view;
    // An environment result for a blocked task is shown only when the stored ask is the Fix setup case (a limit, an owner's stop or an unclear fault keep today's ask and are not renamed).
    if (view !== undefined && view.result === "blocked_by_environment" && blocked && (asked === undefined || autoFixAskCard(asked, workflow.stage as "VERIFY" | "REVIEW") !== "fix_setup")) return undefined;
    return view;
  } catch {
    return undefined;
  }
}
