// Loaded with the owner enforcement step; stale scope responses never drive a write or sign-in.
import { OrgIdSchema, TaskStopEnrollmentBodySchema, TaskStopEnrollmentReadSchema, TaskStopEnrollmentResultSchema, TaskStopReviewBodySchema, TaskStopReviewSchema } from "@agentx/cloud-contracts/web";
import type { AppHost, ApiMethod, ApiResponse } from "../host.js";
import { exactAnswer } from "./without-request-id.js";
import { ApiError } from "./errors.js";
const path = "/v1/app/org/task-stop-policy";
export function createTaskStopEnrollmentApi(host: AppHost, orgId: string) {
 let active = true, epoch = 0;
 async function request(method: ApiMethod, suffix: string, body?: unknown) {
  const generation = epoch, live = () => active && epoch === generation;
  if (!live() || !OrgIdSchema.safeParse(orgId).success) throw new ApiError(0, "SCOPE_ENDED", "Reload Spending.");
  let response: ApiResponse, timer: ReturnType<typeof setTimeout> | undefined;
  try { response = await Promise.race([host.transport.request({ method, path: path + suffix, ...(body === undefined ? {} : { body }), retry: "never" }), new Promise<ApiResponse>((_, reject) => { timer = setTimeout(() => { reject(new Error("timeout")); }, 30_000); })]); }
  catch { throw new ApiError(0, "RUNTIME_UNAVAILABLE", "Could not confirm enforcement. Reload and review before trying again."); }
  finally { clearTimeout(timer); }
  if (!live()) throw new ApiError(0, "SCOPE_ENDED", "Reload Spending.");
  if (response.status !== 200) {
   const wire = response.body as { error?: { code?: unknown; resource?: unknown }; code?: unknown; resource?: unknown } | null, code = wire?.error?.code ?? wire?.code;
   const resource = wire?.error?.resource ?? wire?.resource;
   const checked = resource !== null && typeof resource === "object" && "kind" in resource && "name" in resource && (resource.kind === "project" || resource.kind === "agent") && typeof resource.name === "string" && resource.name.length > 0 && resource.name.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(resource.name) ? ` ${resource.kind}: ${resource.name}.` : "";
   const texts: Record<string, string> = {
    REAUTH_REQUIRED: "Sign in again before reviewing or changing enforcement.",
    TASK_STOP_REVIEW_TOO_LARGE: "This review supports up to 100 active tasks and 80 project/agent source actions. Reduce the inventory before trying again.",
    TASK_STOP_CONFIG_MISSING: "Prepare the missing Spending setting before reviewing enforcement." + checked,
    TASK_STOP_CONFIG_INVALID: "Repair the invalid Spending setting before reviewing enforcement." + checked,
    CHANGE_STALE: typeof body === "object" && body !== null && "state" in body && body.state === "enabled" ? "Spending sources changed. Cancel setup and review again." : "Spending settings changed. Resolve pending changes and capture a fresh review.",
    AUDIT_UNAVAILABLE: "The audit ledger is unavailable. Enforcement was not changed. Try again when the ledger is restored.",
   };
   if (response.status === 401) host.signIn(host.currentPath(), { automatic: true });
   throw new ApiError(response.status, typeof code === "string" ? code : "ENFORCEMENT_UNAVAILABLE", typeof code === "string" && texts[code] !== undefined ? texts[code] : "Could not confirm enforcement. Reload and review before trying again.");
  }
  return response.body;
 }
 function scoped<T extends { orgId: string }>(value: T): T { if (value.orgId !== orgId) throw new ApiError(502, "INVALID_RESPONSE", "Reload Spending.");return value; }
 return {
  setScopeActive(value: boolean) { if (!value) epoch += 1;active = value; },
  async get() { return scoped(exactAnswer(TaskStopEnrollmentReadSchema).parse(await request("GET", "/enrollment?fresh=1"))); },
  async review(revision: number) { return scoped(exactAnswer(TaskStopReviewSchema).parse(await request("POST", "/cutover-review", TaskStopReviewBodySchema.parse({ requestId: crypto.randomUUID(), expectedRevision: revision })))); },
  async transition(body: unknown) { return scoped(exactAnswer(TaskStopEnrollmentResultSchema).parse(await request("PUT", "/enrollment", TaskStopEnrollmentBodySchema.parse(body)))); },
 };
}
