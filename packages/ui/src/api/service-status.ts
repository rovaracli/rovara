import { OrgIdSchema, OrgServiceStatusReaderSchema } from "@agentx/contracts/web";
import type { AppHost, ApiResponse } from "../host.js";
import { ApiError } from "./errors.js";
export function createServiceStatusApi(host: AppHost, orgId: string) {
 let active = true, epoch = 0, redirected = false;
 return {
  setScopeActive(value: boolean) { active = value;epoch++; },
  async read() {
   const version = epoch;if (!active || !OrgIdSchema.safeParse(orgId).success) throw new ApiError(0, "SCOPE_ENDED", "Service status is unavailable.");
   let timer: ReturnType<typeof setTimeout> | undefined, response: ApiResponse;
   try { response = await Promise.race([host.transport.request({ method: "GET", path: `/v1/app/org/service-status?expectedOrgId=${encodeURIComponent(orgId)}`, retry: "never" }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Read deadline")), 8000); })]); }
   catch { throw new ApiError(0, "RUNTIME_UNAVAILABLE", "Stored service status could not be read."); } finally { clearTimeout(timer); }
   if (!active || epoch !== version) throw new ApiError(0, "SCOPE_ENDED", "Service status scope changed.");
   if (response.status < 200 || response.status >= 300) {
    if (response.status === 401 && !redirected) { redirected = true;host.signIn(host.currentPath(), { automatic: true }); }
    throw new ApiError(response.status, response.status === 403 ? "FORBIDDEN" : "RUNTIME_UNAVAILABLE", "Stored service status could not be read.");
   }
   const parsed = OrgServiceStatusReaderSchema.safeParse(response.body);if (!parsed.success || parsed.data.orgId !== orgId) throw new ApiError(502, "INVALID_RESPONSE", "Service status evidence could not be verified.");return parsed.data;
  },
 };
}
