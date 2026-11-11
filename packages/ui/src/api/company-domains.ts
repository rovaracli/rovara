// The Company domains calls (owner decision 2026-11-02). Every write is sent once from the browser session: a refusal is thrown as an `ApiError` for the screen to show and is never repeated here.
import { CompanyDomainChangeAnswerReaderSchema, CompanyDomainRemovedAnswerReaderSchema, CompanyDomainsAnswerReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

export type CompanyDomainsView = ReturnType<typeof CompanyDomainsAnswerReaderSchema.parse>;
export type CompanyDomain = CompanyDomainsView["domains"][number];
export const COMPANY_DOMAINS_PATH = "/v1/app/org/domains";
const NEVER = { retry: "never" } as const;

export function createCompanyDomainsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  list: (): Promise<CompanyDomainsView> => api.get(COMPANY_DOMAINS_PATH, CompanyDomainsAnswerReaderSchema),
  add: async (domain: string) => { const sent = await api.send("POST", COMPANY_DOMAINS_PATH, { domain }, CompanyDomainChangeAnswerReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
  check: async (domain: string) => { const sent = await api.send("POST", COMPANY_DOMAINS_PATH + "/check", { domain }, CompanyDomainChangeAnswerReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
  remove: async (domain: string) => { const sent = await api.send("POST", COMPANY_DOMAINS_PATH + "/remove", { domain }, CompanyDomainRemovedAnswerReaderSchema, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); return sent.value; },
 };
}
