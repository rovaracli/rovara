import { AgentIdSchema, ProjectOverviewProjectSchema, ROVARA_CODE_AGENT_ID, TaskResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
export function createRunApi(host: AppHost) {
 const api = createApiClient(host);
 return { startWork(agentId: string, input: { project: string; text: string; requestId?: string }) {
  const id = AgentIdSchema.parse(agentId), project = ProjectOverviewProjectSchema.shape.name.parse(input.project);
  // PLAN6: Rovara Code starts through its intent route in the excluded implementation, never the generic runs route.
  if (id === ROVARA_CODE_AGENT_ID) throw new ApiError(403, "UNAVAILABLE", "Starting a code session isn't available here yet.");
  if (!input.text.trim() || input.text.length > 4000) throw new ApiError(400, "INVALID_INPUT", "Describe the work in 4000 characters or fewer.");
  return api.send("POST", "/v1/app/agents/" + encodeURIComponent(id) + "/runs", { requestId: input.requestId ?? crypto.randomUUID(), project, input: { text: input.text } }, TaskResponseReaderSchema);
 } };
}
