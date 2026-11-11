// The company How we work calls (lane C's company routes), through the shared API client: its pending-confirmation reader takes the 202 (changes and the optional sole-owner field), lane C's applied reader the 200.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SoleOwnerConfirmation } from "./client.js";
import { ApiError } from "./errors.js";
import { ModelSelectionPolicyAppliedReaderSchema } from "@agentx/cloud-contracts/web";
import { CompanyPolicyReader, readCompanyPreview, type CompanyOverrides, type CompanyPolicy, type CompanyPreview } from "./stage-models.js";

const unreadable = () => new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
export const COMPANY_POLICY_PATH = "/v1/app/org/model-selection-policy";
export const getCompanyPolicy = (host: AppHost): Promise<CompanyPolicy> => createApiClient(host).get(COMPANY_POLICY_PATH, CompanyPolicyReader);
export function useCompanyPolicy(key: readonly unknown[]) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: key, queryFn: () => api.get(COMPANY_POLICY_PATH, CompanyPolicyReader), gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export async function previewCompanyPolicy(host: AppHost, input: { expectedRevision: number; stepOverrides: CompanyOverrides; cursor?: string }): Promise<CompanyPreview> {
 const result = await createApiClient(host).send("POST", COMPANY_POLICY_PATH + "/preview", { version: 1, ...input }, readCompanyPreview, { retry: "never" });
 if (result.kind !== "done") throw unreadable();
 return result.value;
}
export type CompanySaveResult = { kind: "applied"; revision: number } | { kind: "needs_confirmation"; confirmUrl: string | undefined; changes: string[]; soleOwner: SoleOwnerConfirmation | undefined };
export async function saveCompanyPolicy(host: AppHost, input: { requestId: string; expectedRevision: number; stepOverrides: CompanyOverrides }): Promise<CompanySaveResult> {
 const result = await createApiClient(host).send("PUT", COMPANY_POLICY_PATH, { version: 1, ...input }, ModelSelectionPolicyAppliedReaderSchema, { retry: "never" });
 if (result.kind === "needs_confirmation") return { kind: "needs_confirmation", confirmUrl: result.confirmUrl, changes: result.changes, soleOwner: result.soleOwner };
 if (result.kind !== "done" || result.value.requestId !== input.requestId) throw unreadable();
 return { kind: "applied", revision: result.value.revision };
}
