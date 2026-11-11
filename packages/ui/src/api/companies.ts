// The company switcher's reads and its one write (lane exp/company-switcher). Server side: tenancy programme T, briefs/company-memberships-api.md.
//   GET  /v1/app/companies   the caller's own memberships (any signed-in person)
//   POST /v1/app/companies   { action: "switch", companyId, requestId } (a browser session only; a machine credential is refused with 403 FORBIDDEN)
// The contracts package has no reader for these yet, so the schemas are in the one marked block below. When `@agentx/contracts/web` exports `CompaniesReaderSchema` and `CompaniesAnswerReaderSchema` (contracts/src/app-companies.ts), delete the block and import them.
import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { COMPANIES_PATH } from "./company-context.js";
// BEGIN LOCAL COMPANY SCHEMAS (match briefs/company-memberships-api.md sections 4 and 5; replace with the contracts' readers)
export const CompanyRoleSchema = z.enum(["owner", "admin", "member", "auditor"]);
export const CompanySchema = z.object({
 companyId: z.string().regex(/^org_[0-9a-z]{20}$/u),
 name: z.string().min(1),
 role: CompanyRoleSchema,
 joinedAt: z.string(),
 active: z.boolean(),
 status: z.enum(["open", "closing"]),
});
export const CompaniesReaderSchema = z.object({
 activeCompanyId: z.string().regex(/^org_[0-9a-z]{20}$/u),
 companies: z.array(CompanySchema).max(20),
 limits: z.object({ maxCompanies: z.number().int() }),
 canCreate: z.boolean(),
 canJoinByInvite: z.boolean(),
});
/** The answer of every POST. `me` is the existing /v1/app/me answer for the new company; the page reloads instead of reading it, so it is not parsed here (the contracts' AppMeResponseReaderSchema takes its place). */
export const CompaniesAnswerReaderSchema = z.object({
 status: z.literal("done"),
 activeCompanyId: z.string().regex(/^org_[0-9a-z]{20}$/u),
 companies: z.array(CompanySchema).max(20),
 me: z.unknown(),
});
// END LOCAL COMPANY SCHEMAS
export type Company = z.infer<typeof CompanySchema>;
export type CompaniesAnswer = z.infer<typeof CompaniesReaderSchema>;
export const COMPANIES_KEY = ["companies"] as const;
/** The plain words for a role, the same as the People page. */
export const COMPANY_ROLE_WORDS: Record<Company["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", auditor: "Auditor" };
/** The companies read. Only ever mounted while the switch is on (company-flags.ts); the header and the gate that call it are lazy. */
export function useCompanies() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery<CompaniesAnswer>({ queryKey: COMPANIES_KEY, queryFn: () => api.get(COMPANIES_PATH, CompaniesReaderSchema), retry: false });
}
/** The company to open from a link: `?company=org_...` on any app address (the link's own company; the server names it on every link it mints). Anything that is not a company id is ignored. */
export function linkCompany(search: string): string | undefined {
 const value = new URLSearchParams(search).get("company");
 return value !== null && /^org_[0-9a-z]{20}$/u.test(value) ? value : undefined;
}
export function withoutLinkCompany(pathname: string, search: string, hash: string): string {
 const params = new URLSearchParams(search);params.delete("company");
 const rest = params.toString();return pathname + (rest === "" ? "" : "?" + rest) + hash;
}
/** Prefixes of drafts the app keeps per company in this browser (each key also holds the company id). A switch removes them, so nothing of the company left behind is kept on this device. */
const COMPANY_STORAGE_PREFIXES = ["project-slack:v1:", "allowed-websites:v1:", "working-branch-save:"] as const;
/**
 * Everything the page knows about the company it is leaving, gone: the whole query cache, and the per-company drafts in this device's storage (a host that cannot list its keys has none to clear).
 * The caller reloads straight after, so no component state survives either.
 */
export function clearCompanyState(host: AppHost, query: QueryClient): void {
 query.clear();
 try { for (const key of host.storage.keys?.() ?? []) if (COMPANY_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) host.storage.remove?.(key); } catch { /* A blocked store has nothing to clear. */ }
}
/** POST the switch. A refusal (404, 403 REMOVED_FROM_ORG, 403 FORBIDDEN for a machine credential, 429, 5xx) throws an ApiError whose message is the server's own sentence. */
export async function switchCompany(host: AppHost, companyId: string): Promise<z.infer<typeof CompaniesAnswerReaderSchema>> {
 return createApiClient(host).sendAnswer("POST", COMPANIES_PATH, { action: "switch", companyId, requestId: crypto.randomUUID() }, CompaniesAnswerReaderSchema, { retry: "never" });
}
/** Switch, forget the old company, and open the new one's Home (a full reload: no memory of the old company survives). */
export function useSwitchCompany() {
 const host = useAppHost(), query = useQueryClient();
 return async (companyId: string, destination = "/app") => {
  await switchCompany(host, companyId);
  clearCompanyState(host, query);
  host.navigate(destination);
 };
}
