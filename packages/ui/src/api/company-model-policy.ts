// The company How we work calls (C53 company routes). Temporary until lane C's export. The 202 body of the policy PUT has no `changes` list, so the shared client's pending reader cannot carry it; this file reads it itself.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost, type AppHost } from "../host.js";
import { isConfirmUrl } from "../text/links.js";
import { createApiClient } from "./client.js";
import { ApiError, apiError } from "./errors.js";
import { CompanyAppliedSchema, CompanyNeedsConfirmationSchema, CompanyPolicySchema, CompanyPreviewSchema, type CompanyNeedsConfirmation, type CompanyOverrides, type CompanyPolicy, type CompanyPreview } from "./stage-models.js";

export const COMPANY_POLICY_PATH = "/v1/app/org/model-selection-policy";
export const getCompanyPolicy = (host: AppHost): Promise<CompanyPolicy> => createApiClient(host).get(COMPANY_POLICY_PATH, CompanyPolicySchema);
export function useCompanyPolicy(key: readonly unknown[]) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: key, queryFn: () => api.get(COMPANY_POLICY_PATH, CompanyPolicySchema), gcTime: 0 });
}
async function post(host: AppHost, method: "POST" | "PUT", path: string, body: unknown) {
 let response;
 try { response = await host.transport.request({ method, path, body, retry: "never" }); }
 catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again."); }
 if (response.status < 200 || response.status >= 300) {
  const error = apiError(response.status, response.body, host.origin);
  if (error.code === "AUTH_REQUIRED" || response.status === 401) host.signIn(host.currentPath(), { automatic: true });
  throw error;
 }
 return response;
}
const unreadable = () => new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
export async function previewCompanyPolicy(host: AppHost, input: { expectedRevision: number; stepOverrides: CompanyOverrides; cursor?: string }): Promise<CompanyPreview> {
 const response = await post(host, "POST", COMPANY_POLICY_PATH + "/preview", { version: 1, ...input }), parsed = CompanyPreviewSchema.safeParse(response.body);
 if (!parsed.success) throw unreadable();
 return parsed.data;
}
export type CompanySaveResult = { kind: "applied"; revision: number } | { kind: "needs_confirmation"; confirmUrl: string | undefined; soleOwnerAvailableAt: string | undefined; reasonCodes: string[] };
export async function saveCompanyPolicy(host: AppHost, input: { requestId: string; expectedRevision: number; stepOverrides: CompanyOverrides }): Promise<CompanySaveResult> {
 const response = await post(host, "PUT", COMPANY_POLICY_PATH, { version: 1, ...input });
 if (response.status === 202) {
  const parsed = CompanyNeedsConfirmationSchema.safeParse(response.body);
  if (!parsed.success) throw unreadable();
  const pending: CompanyNeedsConfirmation = parsed.data;
  return { kind: "needs_confirmation", confirmUrl: pending.confirmUrl !== undefined && isConfirmUrl(pending.confirmUrl, host.origin) ? pending.confirmUrl : undefined, soleOwnerAvailableAt: pending.soleOwner?.availableAt, reasonCodes: pending.reasonCodes };
 }
 const parsed = CompanyAppliedSchema.safeParse(response.body);
 if (!parsed.success || parsed.data.requestId !== input.requestId) throw unreadable();
 return { kind: "applied", revision: parsed.data.revision };
}
