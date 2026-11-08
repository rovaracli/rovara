// Learning v2 production wiring (lessons-in-production lane 1): the model the learning pipeline calls (`PipelineModel`: the reflector, the curator's judge), on the COMPANY's own AI provider.
//
// The company pays (owner decision 2026-11-03, the same rule as Fix with agent): the route is chosen among the sources billed to the company (`chooseDiagnosisRoute`: its own sources, or Rovara's metered
// built-in AI that is billed to the company), never a person's ChatGPT plan, never a model the company forbids (read now, with the reader schema). With no usable provider the call THROWS, the reflector
// answers `model_error` and nothing is charged. There is NO Rovara-paid route anywhere in this file: no support key, no fallback model, no default.
//
// The model call itself is made by the in-VPC ModelAccessFunction (`learningCompletion`): this Lambda is outside the VPC and cannot reach the proxy. The function mints a five-minute key for the company
// alone (no member), scoped to the one alias and capped at the call's budget; this file only asks, with the alias the company's route chose. The company's existing budgets (the org, project and trial
// limits) are checked here before the call is made (`admitWork`, like any chat turn), and the key is capped at what they have left.
import { OrgIdSchema, ROVARA_CODE_AGENT_ID, forbiddenModelMatcher } from "@agentx/contracts";
import { readGuardrails } from "../../agents/guardrails.js";
import type { PipelineModel } from "../../lessons/ports.js";
import { chooseDiagnosisRoute } from "../../model-sources/diagnosis-provider.js";
import type { RoutingDependencies } from "../../model-sources/routing.js";
import { admitWork } from "../../spend/admission.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { routingOf } from "./scope-helpers.js";

/** The most one learning call may cost (the key's cap); a reflection is a few thousand tokens in and out. */
export const LEARNING_CALL_BUDGET_USD = 0.25;
/** What the pipeline's callers are told: fixed words, never the provider's or the proxy's. */
export const LEARNING_NO_PROVIDER = "learning has no usable AI provider for this project";
const LEARNING_AGENT_NAME = "Learning";

export interface CustomerLearningModelOptions {
  /** Replaces the broker's routing (tests). */
  routing?: (dependencies: AwsBrokerDependencies) => RoutingDependencies | undefined;
  /** Replaces the key's cap. */
  budgetUsd?: number;
}

export function customerLearningModel(dependencies: AwsBrokerDependencies, options: CustomerLearningModelOptions = {}): PipelineModel {
  return {
    async complete(request) {
      const modelAccess = dependencies.modelAccess;
      const completion = modelAccess?.access.learningCompletion?.bind(modelAccess.access);
      if (modelAccess === undefined || completion === undefined) throw new Error("learning has no model path in this install");
      const org = OrgIdSchema.safeParse(request.workspaceId);
      if (!org.success || request.project === undefined || request.project === "") throw new Error("learning needs a company and a project");
      const orgId = org.data, project = request.project;
      // The company's forbidden models, read now: an unreadable document refuses (fail closed) rather than choosing among models without the list.
      const forbidden = forbiddenModelMatcher((await readGuardrails({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, orgId)).forbiddenModels);
      const routing = (options.routing ?? ((deps) => routingOf(deps, true)))(dependencies);
      const chosen = routing === undefined ? undefined : await chooseDiagnosisRoute(routing, orgId, project, forbidden, []);
      if (chosen === undefined || chosen.route.api === undefined) throw new Error(LEARNING_NO_PROVIDER);
      // The company's existing budgets, like any chat turn of the project: nothing left refuses, before any key exists.
      const admitted = await admitWork(
        { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, cloud: dependencies.cloud === true },
        { orgId, payer: { kind: "project", project }, project, agentId: ROVARA_CODE_AGENT_ID, agentName: LEARNING_AGENT_NAME, path: "CHAT" },
      );
      const maxBudgetUsd = Math.min(options.budgetUsd ?? LEARNING_CALL_BUDGET_USD, admitted.maxBudgetUsd);
      if (!(maxBudgetUsd >= 0.001)) throw new Error("learning has no budget left");
      const answer = await completion({
        orgId, project, purpose: request.purpose, system: request.system, user: request.user, maxOutputTokens: request.maxOutputTokens,
        model: chosen.route.alias, api: chosen.route.api, maxBudgetUsd,
      });
      return { text: answer.text, costUsd: answer.costUsd, model: answer.model };
    },
  };
}
