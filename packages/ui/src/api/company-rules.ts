// The calls of Settings > Company rules (lane exp/company-rules): the current rules, the one waiting proposal, history, versions and the optional repository file. The server decides who may and what each means; this file only
// sends and reads, with the contract's schemas. Every write is sent once from the browser session (`retry: "never"`); a proposal answers 202 `needs_approval`, which is an answer of its own, read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { COMPANY_RULES_PATH, CompanyRulesAnswerReaderSchema, CompanyRulesBodySchema, CompanyRulesHistoryReaderSchema, CompanyRulesStateReaderSchema, CompanyRulesSyncReaderSchema, CompanyRulesVersionReaderSchema, type CompanyRulesBody, type CompanyRuleView } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export { COMPANY_RULES_PATH };
const NEVER = { retry: "never" } as const;

export function createCompanyRulesApi(host: AppHost) {
 const api = createApiClient(host);
 const send = (body: CompanyRulesBody) => api.sendAnswer("POST", COMPANY_RULES_PATH, CompanyRulesBodySchema.parse(body), CompanyRulesAnswerReaderSchema, NEVER);
 return {
  state: () => api.get(COMPANY_RULES_PATH, CompanyRulesStateReaderSchema),
  /** Newest first; `before` is the `nextBefore` of the page before. Owners and admins only. */
  history: (before?: number) => api.get(COMPANY_RULES_PATH + "/history?limit=20" + (before === undefined ? "" : "&before=" + String(before)), CompanyRulesHistoryReaderSchema),
  version: (version: number) => api.get(COMPANY_RULES_PATH + "/versions/" + String(Math.trunc(version)), CompanyRulesVersionReaderSchema),
  sync: () => api.get(COMPANY_RULES_PATH + "/sync", CompanyRulesSyncReaderSchema),
  /** The whole list, written against the version the person loaded (0 when there is none). A repeat with the same `requestId` and body returns the stored outcome. */
  propose: (input: { requestId: string; baseVersion: number; rules: readonly CompanyRuleView[]; note?: string }) => send({ action: "propose", requestId: input.requestId, baseVersion: input.baseVersion, rules: input.rules.map(rule => ({ text: rule.text, priority: rule.priority })), ...(input.note === undefined || input.note === "" ? {} : { note: input.note }) }),
  approve: (proposalId: string, expectedDigest: string, soleOwnerAcknowledged?: true) => send({ action: "approve", proposalId, expectedDigest, ...(soleOwnerAcknowledged === true ? { soleOwnerAcknowledged } : {}) }),
  reject: (proposalId: string, expectedDigest: string) => send({ action: "reject", proposalId, expectedDigest }),
  cancel: (proposalId: string) => send({ action: "cancel", proposalId }),
  syncConnect: (input: { repository: string; path?: string; branch?: string }) => send({ action: "sync-connect", repository: input.repository, ...(input.path === undefined || input.path === "" ? {} : { path: input.path }), ...(input.branch === undefined || input.branch === "" ? {} : { branch: input.branch }) }),
  syncDisconnect: () => send({ action: "sync-disconnect" }),
  syncNow: () => send({ action: "sync-now" }),
 };
}
export function useCompanyRulesApi() { const host = useAppHost();return useMemo(() => createCompanyRulesApi(host), [host]); }
export const companyRulesKey = ["admin", "company-rules"] as const;
export const companyRulesHistoryKey = ["admin", "company-rules", "history"] as const;
export const companyRulesSyncKey = ["admin", "company-rules", "sync"] as const;
export const companyRulesVersionKey = (version: number) => ["admin", "company-rules", "version", version] as const;
export function useCompanyRules() { const api = useCompanyRulesApi();return useQuery({ queryKey: companyRulesKey, queryFn: () => api.state(), refetchOnWindowFocus: false, retry: false }); }
export function useCompanyRulesHistory(enabled: boolean) { const api = useCompanyRulesApi();return useQuery({ queryKey: companyRulesHistoryKey, queryFn: () => api.history(), enabled, refetchOnWindowFocus: false, retry: false }); }
export function useCompanyRulesVersion(version: number | undefined) { const api = useCompanyRulesApi();return useQuery({ queryKey: companyRulesVersionKey(version ?? 0), queryFn: () => api.version(version!), enabled: version !== undefined, refetchOnWindowFocus: false, retry: false }); }
export function useCompanyRulesSync(enabled: boolean) { const api = useCompanyRulesApi();return useQuery({ queryKey: companyRulesSyncKey, queryFn: () => api.sync(), enabled, refetchOnWindowFocus: false, retry: false }); }
