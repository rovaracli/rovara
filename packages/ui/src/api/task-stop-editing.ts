import { OrgIdSchema, TaskStopEditingContextSchema, TaskStopEditResultSchema, TaskStopEditBodySchema, TaskStopDecisionBodySchema } from "@agentx/cloud-contracts/web";
import type { AppHost, ApiMethod, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";
import { withoutRequestId } from "./without-request-id.js";
// Legacy write echoes are also overwritten by json-reply; the UI needs only the outcome.
const TaskStopEditAnswerSchema = TaskStopEditResultSchema.omit({ requestId: true });
export function createTaskStopEditingApi(host: AppHost, orgId: string, project?: string) {
 let active = true, epoch = 0;
 const path = "/v1/app/org/task-stop-policy" + (project === undefined ? "" : `/projects/${encodeURIComponent(project)}`);
 async function request(method: ApiMethod, suffix: string, body?: unknown) {
  const version = epoch, valid = () => active && epoch === version;
  if (!valid() || !OrgIdSchema.safeParse(orgId).success) throw new ApiError(0, "SCOPE_ENDED", "Reload Spending.");
  let response: ApiResponse, timer: ReturnType<typeof setTimeout> | undefined;
  try { response = await Promise.race([host.transport.request({ method, path: path + suffix, ...(body === undefined ? {} : { body }), retry: "never" }), new Promise<ApiResponse>((_, reject) => { timer = setTimeout(() => { reject(new Error("timeout")); }, 30_000); })]); }
  catch { throw new ApiError(0, "RUNTIME_UNAVAILABLE", "Couldn't check this task stop. Reload and review before trying again."); }
  finally { clearTimeout(timer); }
  if (!valid()) throw new ApiError(0, "SCOPE_ENDED", "Reload Spending.");
  if (response.status !== 200) {
   if (response.status === 401) host.signIn(host.currentPath(), { automatic: true });
   throw new ApiError(response.status, "SPENDING_UNAVAILABLE", "Couldn't complete this change. Reload the task stop and review current access and original terms.");
  }
  return response.body;
 }
 return {
  setScopeActive(value: boolean) { if (!value) epoch += 1;active = value; },
  async get() {
   const result = TaskStopEditingContextSchema.safeParse(withoutRequestId(await request("GET", "/editing")));
   if (!result.success || result.data.orgId !== orgId || result.data.project !== project || result.data.scopeKind !== (project === undefined ? "company" : "project")
    || (project === undefined ? result.data.policy.kind === "inherit" : result.data.policy.kind === "rovara_estimate")) throw new ApiError(502, "INVALID_RESPONSE", "This task stop could not be checked. Reload Spending.");
   return result.data;
  },
  async edit(body: unknown) { return TaskStopEditAnswerSchema.parse(withoutRequestId(await request("PUT", "", TaskStopEditBodySchema.parse(body)))); },
  async decide(body: unknown) { return TaskStopEditAnswerSchema.parse(withoutRequestId(await request("POST", "/decisions", TaskStopDecisionBodySchema.parse(body)))); },
 };
}
