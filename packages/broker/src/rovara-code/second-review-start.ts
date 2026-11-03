// Second review (SR-1, switch `cr`): the start. Called once from the REVIEW dispatch (task-operations.ts), it decides whether the review this operation runs carries a second reviewer, which models it may try, and what
// to record on the operation either way. The second reviewer runs INSIDE the same REVIEW operation as an extra code review with its own model, so there is no second operation, no hold, no new dispatch row: a
// stop, a lost run, a stale sweep and a close all see one ordinary REVIEW operation.
//
// With the switch off, or the configured mode `off`, it returns nothing, and the dispatch is exactly today's.
import { AgentXError, configuredSecondReviewMode, secondReviewModelKey, type InvocationModelRoute, type ModelIdentifier, type ModelSelection, type SecondOpinionUnavailableReason, type SecondReviewerPayload } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { queryAllItems } from "../aws/admin-reads.js";
import { ADMISSION_REFUSALS } from "../aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import { readGuardrails } from "../agents/guardrails.js";
import { readSecondReviewSettings } from "../org/second-review-settings.js";
import { routeOnWire, servableModels, servingRoutes, type RoutingDependencies } from "../model-sources/routing.js";
import { admitWork } from "../spend/admission.js";
import { againstModels, admitSecondReview, planSecondReview, type SecondReviewPlan } from "./second-review.js";
import { estimateSecondReviewUsd, SECOND_REVIEW_TYPICAL_REVIEW_TOKENS } from "./second-review-picker.js";
import { noteQualification, observationOf } from "./second-review-notice.js";
import { secondReviewEnabled } from "./second-review-switch.js";
import type { SecondReviewOperationPlan } from "./second-review-store.js";

export interface SecondReviewStartInput {
  dependencies: AwsBrokerDependencies;
  orgId: string;
  project: string;
  workspaceId: string;
  conversationId: string;
  task: DeveloperTaskRecord | undefined;
  workflowMode: string | undefined;
  /** An agent-step run never carries a second reviewer. */
  agentRun: unknown;
  /** The reviews this operation runs; absent: both. */
  workflowReviewers: readonly ("CRITIC" | "SECURITY")[] | undefined;
  /** The model the FIRST reviewer of this operation runs on (what the dispatch chose for it). */
  firstReviewerModel: ModelIdentifier | undefined;
  /** The project's approved models. */
  approved: readonly ModelIdentifier[] | undefined;
  routing: RoutingDependencies | undefined;
  /** The task's pin has no review-default marker (it started before the frontier tier): rank as it did then. */
  legacyRanking?: boolean | undefined;
  /** For tests: the plan inputs read from the stores. */
  now?: () => number;
}

export interface SecondReviewStart {
  /** The field for the worker payload (absent when nothing is to be run). */
  field?: SecondReviewerPayload;
  /** What to record on the operation (absent only when there is nothing to say: switch off, mode off, not a code review). */
  record?: SecondReviewOperationPlan;
}

/** The fixed reason an unplanned second review is flagged with. */
const REASON_OF: Record<Extract<SecondReviewPlan, { run: false }>["reason"], SecondOpinionUnavailableReason | undefined> = {
  "switch-off": undefined, "mode-off": undefined, "no-reference-model": "no-candidate", "no-candidate": "no-candidate", "choice-not-qualifying": "choice-not-qualifying",
};

export async function prepareSecondReview(input: SecondReviewStartInput): Promise<SecondReviewStart> {
  if (!secondReviewEnabled()) return {};
  const candidate = input.task?.workflow?.candidate;
  if (input.workflowMode !== "REVIEW" || input.agentRun !== undefined || candidate === undefined) return {};
  if (input.workflowReviewers !== undefined && !input.workflowReviewers.includes("CRITIC")) return {};
  const { dependencies } = input;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  let settings: Awaited<ReturnType<typeof readSecondReviewSettings>>;
  try { settings = await readSecondReviewSettings(table, input.orgId, input.project); } catch (error) {
    // Settings that cannot be read run nothing (never a looser setting); the first review goes on as today.
    console.log(JSON.stringify({ component: "broker", event: "second_review.settings_unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
    return {};
  }
  const mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
  if (mode === "off") return {};
  const candidateDigest = candidate.digest;
  const notRun = (reason: SecondOpinionUnavailableReason): SecondReviewStart => ({ record: { candidateDigest, notRun: { mode: mode === "on" ? "on" : "shadow", reason } } });
  // Everything below only ADDS an opinion to the review: an error while planning (a source that cannot be read, a model-source lookup, an admission read) must never fail the first review's dispatch. It is logged
  // (the error's name only), and `on` flags that the second review did not run while shadow stays silent.
  try {
    // (An agent-step run is a planning session with at most read-only file tools, so it cannot write candidate code and is not a builder.)
    // Every build the task ran in every round, and the first reviewer's model: the second reviewer must differ in company from all of them. One that recorded nothing can never be shown to differ.
    const operations = (await queryAllItems(dependencies, `WORKSPACE#${input.workspaceId}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.conversationId === input.conversationId);
    const builds = operations.filter((item) => item.workflowMode === "IMPLEMENT" && item.status === "SUCCEEDED").map((item) => item.model as ModelIdentifier | undefined);
    const against = againstModels({ buildRanModels: builds.map((model) => (model === undefined || typeof model !== "object" ? undefined : model)), firstReviewerRan: input.firstReviewerModel });
    if (against === undefined) return notRun("no-candidate");
    const forbidden = (await readGuardrails(dependencies, input.orgId)).forbiddenModels ?? [];
    const sources = input.routing === undefined ? [] : await servableModels(input.routing, input.orgId, input.project);
    const previous = settings.companyModels === undefined && settings.projectModels === undefined ? input.task?.secondOpinion : undefined;
    // Only an opinion that ANSWERED names the model that ran (a failed one keeps a report too, of whatever model failed).
    const previousModel = previous?.opinion.choice === "default" && previous.opinion.unavailable === false && previous.opinion.report !== undefined ? { provider: previous.opinion.report.provider, modelId: previous.opinion.report.version } : undefined;
    const plan = planSecondReview({
      switchOn: true, mode, against, project: { approved: input.approved }, forbidden, sources, verdicts: settings.verdicts, replayRuns: settings.replayRuns,
      companyModels: settings.companyModels, projectModels: settings.projectModels, previousDefault: previousModel, legacyRanking: input.legacyRanking,
      price: (model) => { const price = listPricesPerMillion(model); return price === undefined ? undefined : { inputUsdPerMTok: price.input, outputUsdPerMTok: price.output }; },
    });
    // The admins are told once when the reviewer stops qualifying (and again if it comes back and breaks later); best effort, never in the way of the review.
    await noteQualification(table, input.orgId, observationOf(plan), (input.now ?? Date.now)());
    if (!plan.run) {
      const reason = REASON_OF[plan.reason];
      return reason === undefined ? {} : notRun(reason);
    }
    // Admission, the same as the first review's: the payer's budget floor and, in Enterprise, the spend ledger (both are read by `admitWork`). A refusal, or a room smaller than the estimate, is "budget".
    if (dependencies.modelAccess !== undefined && input.task !== undefined) {
      try {
        const admitted = await admitWork(
          { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: dependencies.modelAccess.access, cloud: dependencies.cloud === true, ...(input.now === undefined ? {} : { now: input.now }) },
          { orgId: input.orgId, project: input.project, payer: input.task.payer ?? { kind: "member", developerId: input.task.developerId }, agentId: input.task.agent?.agentId ?? "rovara-code", agentName: input.task.agent?.name ?? "Rovara Code", path: "TASK",
            ...(input.task.origin === "test_run" ? { testRunBy: input.task.startedBy?.developerId ?? input.task.developerId } : {}) },
        );
        const price = listPricesPerMillion(plan.model);
        const estimate = price === undefined ? 0 : estimateSecondReviewUsd({ inputUsdPerMTok: price.input, outputUsdPerMTok: price.output }, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output });
        const admission = admitSecondReview({ mode: plan.mode, estimateUsd: estimate, roomUsd: admitted.maxBudgetUsd, alreadyRan: false });
        if (!admission.admit) return notRun(admission.reason);
      } catch (error) {
        if (!(error instanceof AgentXError) || !ADMISSION_REFUSALS.has(error.code)) throw error;
        return notRun("budget");
      }
    }
    // Each model is reached the way the broker checks it: through its own proxy route. A model no usable route serves (or only a person's plan) is left out; with none left the review could not start.
    const candidates: Array<{ model: ModelSelection; modelRoute?: InvocationModelRoute }> = [];
    const aliases: string[] = [];
    const routeAliases: Record<string, string> = {};
    for (const model of plan.candidates) {
      if (input.routing === undefined) { candidates.push({ model }); continue; }
      const [route] = (await servingRoutes(input.routing, { orgId: input.orgId, project: input.project, model })).filter((entry) => entry.sourceId !== "personal-chatgpt");
      if (route === undefined) continue;
      const wire = routeOnWire(route, model);
      candidates.push({ model, ...(wire === undefined ? {} : { modelRoute: wire }) });
      if (route.alias !== undefined) aliases.push(route.alias);
      if (wire !== undefined) routeAliases[secondReviewModelKey(model)] = wire.alias;
    }
    if (candidates.length === 0) return notRun("no-candidate");
    const kept = plan.candidates.filter((model) => candidates.some((entry) => secondReviewModelKey(entry.model) === secondReviewModelKey(model)));
    // What the second reviewer sees besides the change: nothing from connected sources unless the company chose `same_as_first` (absent on the wire means `change_only`).
    const field: SecondReviewerPayload = { candidates, ...(settings.context === "same_as_first" ? { context: settings.context } : {}) };
    return {
      field,
      record: { candidateDigest, plan: { mode: plan.mode, company: plan.company, model: kept[0]!, candidates: kept, against: plan.against, choice: plan.choice,
        ...(plan.downgraded === undefined ? {} : { downgraded: plan.downgraded }), ...(plan.defaultChanged === true ? { defaultChanged: true as const } : {}) },
        ...(aliases.length === 0 ? {} : { aliases }), ...(Object.keys(routeAliases).length === 0 ? {} : { routeAliases }) },
    };
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "second_review.start_failed", errorName: error instanceof Error ? error.name : "unknown" }));
    return mode === "on" ? notRun("no-candidate") : {};
  }
}
