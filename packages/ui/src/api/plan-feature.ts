import { PlanFeatureChoicesResponseSchema, type PlanFeatureChoicesResponse } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";
import { createReportActions } from "./admin-report.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const taskPath = (taskId: string): string => { if (!TASK_ID.test(taskId)) throw new ApiError(400, "CONFIG_INVALID", "This task can't be changed from here."); return "/v1/app/tasks/" + taskId.toLowerCase(); };

/**
 * The plan card's feature controls (lead 4 PCF). Code decides who may on every call; the page only offers what the card's `planFeature` said. A press is one request with no retry of its own: a repeat
 * of "Change" to the same feature is a no-op on Code ("kept").
 */
export function createPlanFeatureApi(host: AppHost) {
 const api = createApiClient(host);
 const report = createReportActions(host);
 return {
  choices: (taskId: string): Promise<PlanFeatureChoicesResponse> => api.get(taskPath(taskId) + "/feature-choices", PlanFeatureChoicesResponseSchema),
  /** Uses Cost and time's existing action and its answer reader; `null` files under "No feature". */
  set: async (taskId: string, feature: string | null): Promise<void> => { await report.moveTask(taskId, feature); },
  /** Uses Cost and time's existing create action, which also reads Code's `feature.state` answer. */
  create: async (name: string): Promise<string> => (await report.create(name)).feature.id,
 };
}
