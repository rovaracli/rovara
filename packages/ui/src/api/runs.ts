import { AgentIdSchema, ProjectOverviewProjectSchema, ROVARA_CODE_AGENT_ID, TaskResponseReaderSchema } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { createCodeApi } from "./code.js";
import { ApiError } from "./errors.js";
export function createRunApi(host: AppHost) {
 const api = createApiClient(host), code = createCodeApi(host);
 return { startWork(agentId: string, input: { project: string; text: string; requestId?: string }) {
  const id = AgentIdSchema.parse(agentId), project = ProjectOverviewProjectSchema.shape.name.parse(input.project);
  // Rovara Code starts through its intent route (the project's own process runs it), never the generic runs route.
  if (id === ROVARA_CODE_AGENT_ID) return code.startCode(project, input.text, input.requestId);
  if (!input.text.trim() || input.text.length > 4000) throw new ApiError(400, "INVALID_INPUT", "Describe the work in 4000 characters or fewer.");
  return api.send("POST", "/v1/app/agents/" + encodeURIComponent(id) + "/runs", { requestId: input.requestId ?? crypto.randomUUID(), project, input: { text: input.text } }, TaskResponseReaderSchema);
 } };
}
