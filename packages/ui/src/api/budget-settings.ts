import { AdminBudgetSettingsSchema, OrgIdSchema, type AdminBudgetSettings } from "@agentx/contracts/web";
import type { AppHost, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";
import { withoutRequestId } from "./without-request-id.js";
const unavailable = "Monthly base budgets could not be checked. Try again.";
export function createBudgetSettingsApi(host: AppHost, orgId: string) {
 let active = true, epoch = 0, redirected = false;
 const valid = (version: number) => active && version === epoch;
 return {
  setScopeActive(value: boolean) { if (!value) epoch += 1;active = value; },
  async get(): Promise<AdminBudgetSettings> {
   const version = epoch;if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", unavailable);
   if (!OrgIdSchema.safeParse(orgId).success) throw new ApiError(400, "CONFIG_INVALID", unavailable);
   let response: ApiResponse, timer: ReturnType<typeof setTimeout> | undefined;
   try { response = await Promise.race([host.transport.request({ method: "GET", path: "/v1/app/org/budget-settings" }), new Promise<ApiResponse>((_, reject) => { timer = setTimeout(() => { reject(new Error(unavailable)); }, 30_000); })]); }
   catch { throw new ApiError(0, "RUNTIME_UNAVAILABLE", unavailable); }
   finally { clearTimeout(timer); }
   if (!valid(version)) throw new ApiError(0, "SCOPE_ENDED", unavailable);
   if (response.status !== 200) {
    if (response.status === 401 && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
    throw new ApiError(response.status, response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "TOO_MANY_REQUESTS" : "RUNTIME_UNAVAILABLE", unavailable);
   }
   const parsed = AdminBudgetSettingsSchema.safeParse(withoutRequestId(response.body));
   if (!parsed.success || parsed.data.orgId !== orgId) throw new ApiError(502, "INVALID_RESPONSE", unavailable);
   return parsed.data;
  },
 };
}
