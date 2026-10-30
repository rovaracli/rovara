import {ModelSelectionSchema,type ModelSelection} from "@agentx/contracts";
import {criticModelUnusable} from "../rovara-code/critic.js";
// Existing retry history rules, shared by dispatch and live fallback requests.
export function reviewFailures(operations: ReadonlyArray<Record<string, unknown>>, latestBuild: Record<string, unknown> | undefined): { models: ModelSelection[]; sinceLatestBuild: number } {
  const models: ModelSelection[] = [];
  let sinceLatestBuild = 0;
  const from = typeof latestBuild?.createdAt === "string" ? latestBuild.createdAt : "";
  for (const item of operations) {
    if (item.workflowMode !== "REVIEW") continue;
    let failed: ModelSelection | undefined;
    let unusable = false;
    if (item.status === "FAILED" && criticModelUnusable(typeof item.error === "string" ? item.error : undefined)) {
      unusable = true;
      const model = ModelSelectionSchema.safeParse(item.model);
      if (model.success) failed = model.data;
    } else if (item.status === "SUCCEEDED") {
      const reports = (item.result as { workflowReviews?: unknown } | undefined)?.workflowReviews;
      for (const report of Array.isArray(reports) ? reports : []) {
        const { provider, version, modelFailure } = (report ?? {}) as { provider?: unknown; version?: unknown; modelFailure?: unknown };
        if (typeof modelFailure !== "string" || !criticModelUnusable(modelFailure)) continue;
        unusable = true;
        const model = ModelSelectionSchema.safeParse({ provider, modelId: version });
        if (model.success) failed = model.data;
      }
    }
    if (!unusable) continue;
    if (failed !== undefined) models.push(failed);
    if (String(item.createdAt) >= from) sinceLatestBuild += 1;
  }
  return { models, sinceLatestBuild };
}

export function criticFailures(operations: ReadonlyArray<Record<string, unknown>>, latestPlanner: Record<string, unknown> | undefined): { models: ModelSelection[]; sinceLatestPlan: number } {
  const failed = operations.filter((item) => item.workflowMode === "PLAN_CRITIQUE" && item.status === "FAILED" && criticModelUnusable(typeof item.error === "string" ? item.error : undefined));
  const models: ModelSelection[] = [];
  for (const item of failed) {
    const model = ModelSelectionSchema.safeParse(item.model);
    if (model.success) models.push(model.data);
  }
  const from = typeof latestPlanner?.createdAt === "string" ? latestPlanner.createdAt : "";
  return { models, sinceLatestPlan: failed.filter((item) => String(item.createdAt) >= from).length };
}
