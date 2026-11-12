// The one read the Working agreement panel needs that no other screen makes: how many company rules (standing instructions) apply. It is the company rules read of the `si` switch, through the contract's own readers
// (`CompanyRulesStateReaderSchema`, `CompanyRulesCurrentReaderSchema`), the same ones Settings > Company rules uses.
// Asked only where the nav answer says `features.companyRules` is true. A member reads `GET /v1/app/org/company-rules/current` (the version in force only); an owner or admin reads `GET /v1/app/org/company-rules`
// (which also says whether a proposal waits). The panel keeps counts only and never shows a rule's text. A refusal (404, 403) is said as "Not available yet".
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { COMPANY_RULES_CURRENT_PATH, COMPANY_RULES_PATH, CodeSettingsResponseReaderSchema, CompanyRulesCurrentReaderSchema, CompanyRulesStateReaderSchema, ProjectOverviewProjectSchema, type CodeSettingsResponseRead } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export interface CompanyRulesSummary { required: number; preferred: number; version?: number; pending: boolean }
/** What both answers have that the panel counts: the version in force, and (the admin state only) whether a proposal waits. The contract's readers keep a priority word this version does not know as "unknown". */
interface CompanyRulesAnswer { current: { version: number; rules: ReadonlyArray<{ priority: string }> } | null; pending?: unknown }
/** The counts of either answer: the admin read (`state`, which may carry a waiting proposal) or the member read (`current`, which never does). A rule whose priority this version cannot read refuses the whole read, as before: no count is shown that might leave a rule out. */
export function companyRulesSummaryOf(answer: CompanyRulesAnswer): CompanyRulesSummary {
 const pending = answer.pending !== undefined && answer.pending !== null;
 if (answer.current === null) return { required: 0, preferred: 0, pending };
 let required = 0, preferred = 0;
 for (const rule of answer.current.rules) {
  if (rule.priority === "required") required += 1; else if (rule.priority === "preferred") preferred += 1; else throw new Error("Unreadable company rules");
 }
 return { required, preferred, pending, version: answer.current.version };
}
/** Reads through the same contract readers and paths as Settings > Company rules (`api/company-rules.ts`), without importing that module: the panel loads on its own and must not pull the settings screens' code in. */
export function createAgreementApi(host: AppHost) {
 const api = createApiClient(host);
 return { companyRules: async (admin: boolean): Promise<CompanyRulesSummary> => companyRulesSummaryOf(admin ? await api.get(COMPANY_RULES_PATH, CompanyRulesStateReaderSchema) : await api.get(COMPANY_RULES_CURRENT_PATH, CompanyRulesCurrentReaderSchema)) };
}
export const agreementKey = ["agreement"] as const;
/** `enabled`: the nav answer says company rules are on (`features.companyRules`). Off, nothing is requested. */
export function useCompanyRulesSummary(enabled: boolean, admin: boolean) {
 const host = useAppHost(), api = useMemo(() => createAgreementApi(host), [host]);
 return useQuery({ queryKey: [...agreementKey, "company-rules", admin ? "admin" : "member"], enabled, queryFn: () => api.companyRules(admin), retry: false, refetchOnWindowFocus: false });
}

/** A project's merge rules: `GET /v1/app/projects/{p}/code-settings`, for anyone who can see the project (the contract's reader). A 404 (no role in the project, or no such project) is said as "Not available yet". */
export const mergeRulesPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/code-settings";
export type MergeRules = CodeSettingsResponseRead["settings"];
export function useMergeRules(project: string) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: [...agreementKey, "merge-rules", project], queryFn: async (): Promise<MergeRules> => (await api.get(mergeRulesPath(project), CodeSettingsResponseReaderSchema)).settings, retry: false, refetchOnWindowFocus: false });
}
