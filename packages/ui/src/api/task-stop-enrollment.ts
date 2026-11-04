// Loaded with the owner enforcement step; stale scope responses never drive a write or sign-in.
import { OrgIdSchema, TaskStopEnrollmentBodySchema, TaskStopEnrollmentReadSchema, TaskStopEnrollmentResultSchema, TaskStopReviewBodySchema, TaskStopReviewSchema } from "@agentx/contracts/web";
import type { AppHost, ApiMethod, ApiResponse } from "../host.js";
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
   const wire = response.body as { error?: { code?: unknown }; code?: unknown } | null, code = wire?.error?.code ?? wire?.code;
   if (response.status === 401) host.signIn(host.currentPath(), { automatic: true });
   throw new ApiError(response.status, code === "REAUTH_REQUIRED" ? code : "ENFORCEMENT_UNAVAILABLE", code === "REAUTH_REQUIRED" ? "Sign in again before reviewing or changing enforcement." : "Could not confirm enforcement. Resolve pending Spending changes, then reload the review.");
  }
  return response.body;
 }
 function scoped<T extends { orgId: string }>(value: T): T { if (value.orgId !== orgId) throw new ApiError(502, "INVALID_RESPONSE", "Reload Spending.");return value; }
 return {
  setScopeActive(value: boolean) { if (!value) epoch += 1;active = value; },
  async get() { return scoped(TaskStopEnrollmentReadSchema.parse(await request("GET", "/enrollment?fresh=1"))); },
  async review(revision: number) { return scoped(TaskStopReviewSchema.parse(await request("POST", "/cutover-review", TaskStopReviewBodySchema.parse({ requestId: crypto.randomUUID(), expectedRevision: revision })))); },
  async transition(body: unknown) { return scoped(TaskStopEnrollmentResultSchema.parse(await request("PUT", "/enrollment", TaskStopEnrollmentBodySchema.parse(body)))); },
 };
}
