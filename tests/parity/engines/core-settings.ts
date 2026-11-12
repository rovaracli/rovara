// The settings the Cloud journey install runs under, mapped onto the core by the composition root's own mapping (packages/broker/src/cloud/app/settings-mapping.ts,
// S0-Q2). The Cloud engine (tests/support/workflow-e2e.ts) has no Rovara Code recipe wired (so no plan check step and no Understand), no `rv`, no lessons, and
// automatic fixing off unless a scenario turns it on (`feature: autofix-on`, or a scenario with a failing check or review findings, which the Cloud engine
// sets the same way). The core engine is given exactly what the mapping makes of those settings, instead of each driver setting flow options by hand.
import { cloudSettingsFromEnvironment, mapCloudSettings, type CloudCompanySettings, type CoreSettings } from "../../../packages/broker/src/cloud/app/settings-mapping.js";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { canonicalModelName, type ModelIdentifier } from "@rovara-code/contracts";
import { defaultWorkerModel } from "../../../packages/broker/src/agents/dispatch.js";
import { createCloudStepModels, type CloudModelFacts } from "../../../packages/broker/src/cloud/app/model-mapping.js";
import type { Scenario } from "../harness/types.js";

/** Whether the scenario runs Cloud's automatic fix switch on (as the Cloud engine sets it: a failing check, review findings, or `autofix-on`). */
export const autofixOnFor = (scenario: Scenario): boolean => scenario.steps.some((step) => (step.do === "checks" && step.outcome === "fail") || (step.do === "reviews" && step.outcome === "findings") || (step.do === "feature" && step.name === "autofix-on"));

/** Cloud's settings for a scenario's journey install. */
export function journeySettings(scenario: Scenario, extra: Partial<Pick<CloudCompanySettings, "workspaceLimits">> = {}): CloudCompanySettings {
  const settings = cloudSettingsFromEnvironment(
    { AUTOFIX_ENABLED: autofixOnFor(scenario) ? "true" : "false", AUTOFIX_CAP_USD: "5" },
    { recipeStepKinds: undefined, connectorWritesBehindApproval: true, ...extra },
  );
  // The Cloud engine gives its autofix a round estimate of $1 (cloud-drivers/task-flow.ts, merge.ts), not the deployed $3.
  return { ...settings, autofix: { ...settings.autofix, roundEstimateUsd: 1 } };
}

/** What the root's mapping makes of the journey's settings. */
export const mappedJourney = (scenario: Scenario, extra: Partial<Pick<CloudCompanySettings, "workspaceLimits">> = {}): CoreSettings => mapCloudSettings(journeySettings(scenario, extra));

/**
 * Applies the mapping to a running core's flow. `liveSteer` is left alone: the journey harness has no `ls` setting (Cloud's workflow tasks take messages through
 * the session path), so the scenario that sends a message mid-run compares the session, not the switch.
 */
export function applyJourneySettings(deps: { understandFirst?: boolean; planCheck?: boolean; planSelfCheck?: boolean; autofix?: unknown; limits?: unknown; stepModels?: unknown }, scenario: Scenario, extra: Partial<Pick<CloudCompanySettings, "workspaceLimits">> = {}, companyId?: string): void {
  const { flowOptions } = mappedJourney(scenario, extra);
  deps.understandFirst = flowOptions.understandFirst;
  deps.planCheck = flowOptions.planCheck;
  deps.planSelfCheck = flowOptions.planSelfCheck;
  deps.autofix = flowOptions.autofix;
  if (flowOptions.limits !== undefined) deps.limits = flowOptions.limits;
  // The model each step runs on (area 24): Cloud's choice over the journey's model facts, as the root's `cloudFlowOptions` passes it.
  if (companyId !== undefined) deps.stepModels = createCloudStepModels(journeyModelFacts(companyId));
}

/**
 * The model facts of the Cloud journey install: Rovara's own Bedrock catalog in the `us` geography serves every model (the journey has no company source),
 * a step runs on Cloud's install model (`defaultWorkerModel`) unless the hosted review rule picks another, and the company has set nothing.
 */
export function journeyModelFacts(companyId: string): CloudModelFacts {
  const servable = bedrockClaudeModelIds("us").map((modelId): { model: ModelIdentifier; sourceId: string } => ({ model: { provider: "amazon-bedrock", modelId }, sourceId: "rovara" }));
  return {
    companyId, sourcesRevision: async () => 0, servable: async () => servable, installModel: async () => defaultWorkerModel("us"),
    route: async (model) => ({ alias: model.modelId, api: "anthropic-messages", catalog: canonicalModelName(model) }),
    stepOverrides: async () => ({}), unusable: async () => new Set<string>(), forbidden: async () => [],
  };
}

/** The project rules the core's chains and agents run under on the journey install (Cloud serves a connector write behind a person's approval). */
export const journeyProjectRules = () => mapCloudSettings(cloudSettingsFromEnvironment({}, { recipeStepKinds: undefined, connectorWritesBehindApproval: true })).projectRules;
