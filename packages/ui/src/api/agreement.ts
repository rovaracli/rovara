// The one read the Working agreement panel needs that no other screen makes yet: how many company rules (standing instructions) apply. It is the company rules read of the `si` switch (`GET /v1/app/org/company-rules`).
// Read loosely and for counts only: the panel never shows a rule's text. An install without the route answers 404, which the panel says as "Not available yet". When Settings > Company rules lands in this build,
// swap this reader for its contract reader; nothing else changes.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type Reader } from "./client.js";

export const COMPANY_RULES_READ_PATH = "/v1/app/org/company-rules";
export interface CompanyRulesSummary { required: number; preferred: number; version?: number; pending: boolean }
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const CompanyRulesSummaryReader: Reader<CompanyRulesSummary> = { parse(value: unknown): CompanyRulesSummary {
 const body = record(value);
 if (body === undefined || !("current" in body)) throw new Error("Unreadable company rules");
 const pending = body.pending !== undefined && body.pending !== null;
 if (body.current === null) return { required: 0, preferred: 0, pending };
 const current = record(body.current);
 if (current === undefined || !Array.isArray(current.rules)) throw new Error("Unreadable company rules");
 let required = 0, preferred = 0;
 for (const entry of current.rules) {
  const priority = record(entry)?.priority;
  if (priority === "required") required += 1; else if (priority === "preferred") preferred += 1; else throw new Error("Unreadable company rules");
 }
 const version = current.version;
 return { required, preferred, pending, ...(typeof version === "number" && Number.isInteger(version) && version >= 1 ? { version } : {}) };
} };
export function createAgreementApi(host: AppHost) {
 const api = createApiClient(host);
 return { companyRules: () => api.get(COMPANY_RULES_READ_PATH, CompanyRulesSummaryReader) };
}
export const agreementKey = ["agreement"] as const;
export function useCompanyRulesSummary() {
 const host = useAppHost(), api = useMemo(() => createAgreementApi(host), [host]);
 return useQuery({ queryKey: [...agreementKey, "company-rules"], queryFn: () => api.companyRules(), retry: false, refetchOnWindowFocus: false });
}
