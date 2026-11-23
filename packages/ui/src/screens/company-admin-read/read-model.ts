import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { z } from "zod";
import { createApiClient, type Reader } from "../../api/client.js";
import { readCompanySettings } from "../../api/admin-company.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";

// The company audit reader (Cloud's GET /v1/app/company/audit); this page owns it since the old audit screen was retired.
const text = (max: number) => z.string().max(max);
export const auditReader = z.object({
 records: z.array(z.object({ id: text(300), source: z.enum(["cloud", "engine"]), at: text(64),
  actor: z.object({ developerId: text(256), name: text(200), type: text(32).optional() }),
  via: text(64).optional(), action: text(130), subject: text(600), project: text(63).optional(), outcome: text(32), detail: text(200).optional(),
 })).max(200), next: text(1024).optional(),
 engine: z.object({ state: z.enum(["connected", "not_connected", "unavailable", "incomplete"]), message: text(300).optional() }),
});
const ruleReader = z.array(z.object({ text: z.string(), priority: z.enum(["required", "preferred"]) }));
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const settingsReader = (companyId: string) => ({ parse(body: unknown) {
 if (!object(body) || body["companyId"] !== companyId) throw new ApiError(502, "INVALID_RESPONSE", "Company identity did not match this read.");
 const read = readCompanySettings(body);
 const raw = object(body) ? body : {};
 const pending = raw["pending"];
 return { ...read, instructionsKnown: ruleReader.safeParse(read.raw["instructions"]).success,
  pendingKnown: pending === undefined || pending === null || (read.pending !== undefined && object(pending) && object(pending["settings"]) && ruleReader.safeParse(pending["settings"]["instructions"]).success),
 };
} });
export const membersReader = AppOrgMembersResponseReaderSchema;
export interface ReadScope { orgId: string; personId: string; company: string; role: "owner" | "admin"; /** The admin area is re-checking who this is: the page stays, actions do not send. */ checking: boolean }
export const readPolicy = { retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
/**
 * G1 SHIP: the reads live in the admin area's cache (["admin", "lane-c", area, ...]), like the pages they replace: AdminLayout purges them when access is lost,
 * and a save elsewhere that invalidates ["admin", "lane-c"] (the AI and spending limit editor) or ["admin", "lane-c", "company-settings"] re-reads them here too.
 */
const AREA: Record<string, string> = { settings: "company-settings", members: "overview-members", audit: "audit" };
export const companyReadKey = (scope: ReadScope, kind: string, path: string) => ["admin", "lane-c", AREA[kind] ?? kind, scope.orgId, scope.personId, scope.role, path] as const;
export function useCompanyRead<T>(scope: ReadScope, kind: string, path: string, reader: Reader<T>) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ ...readPolicy, queryKey: companyReadKey(scope, kind, path), queryFn: () => api.get(path, reader, undefined, { retry: "never" }) });
}
