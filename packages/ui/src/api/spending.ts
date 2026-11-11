// The Spending page's reads (lane exp/spending). Every one is a read the broker already answers; nothing here writes, and no money rule lives here.
//   GET /v1/app/budget            the caller's own month figures and the company's (every signed-in person)
//   GET /v1/app/org/spend         [owner or admin] the company's month by project, person and source (the broker answers 403 to anyone else)
//   GET /v1/app/spend-requests    the open spending requests the caller may decide now, and their own
//   GET /v1/app/org/budget-settings  [owner or admin] the monthly base amounts
//   GET /v1/app/org/members       the people, to turn a person's id into a name
//   GET /v1/app/projects/{p}/spend  [`view_spend` on the project: a maintainer] one project's month: spent, committed and the limit when it has one. Totals only, no person rows (the project page's Spending tab, same switch).
// The contracts package has no reader for the first three, so the readers are here. They keep only the fields the page shows; a figure that is not a finite, non-negative number
// fails the whole read ("unreadable") instead of showing a plausible number.
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { AdminBudgetSettingsSchema, AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { isConfirmUrl } from "../text/links.js";
import { useAppHost } from "../host.js";
import { createApiClient, type Reader } from "./client.js";
import { withoutRequestId } from "./without-request-id.js";
/** The gateway adds a `requestId` to every object answer; the settings schema is strict, so it is taken off before reading (as the budget settings api does). */
const SettingsReader: Reader<z.infer<typeof AdminBudgetSettingsSchema>> = { parse: value => AdminBudgetSettingsSchema.parse(withoutRequestId(value)) };
const usd = z.number().finite().nonnegative().max(1e9);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const label = z.string().min(1).max(200);
const figures = z.object({ spentUsd: usd, committedUsd: usd, limitUsd: usd.optional() });
export const SpendBudgetReaderSchema = z.object({ month, member: figures, org: figures });
export type SpendBudget = z.infer<typeof SpendBudgetReaderSchema>;
export const OrgSpendReaderSchema = z.object({
 month, totalUsd: usd, committedUsd: usd, limitUsd: usd.optional(),
 byProject: z.array(z.object({ project: label, spentUsd: usd, committedUsd: usd })).max(1000),
 byMember: z.array(z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/u), spentUsd: usd })).max(1000),
 bySource: z.array(z.object({ source: label, spentUsd: usd })).max(100),
});
export type OrgSpend = z.infer<typeof OrgSpendReaderSchema>;
/** A request row. The kind and the approver role are kept as read (any text) and turned into words by the page, which says "Other request" for a value it does not know. */
export const SpendRequestsReaderSchema = z.object({ spendRequests: z.array(z.object({
 spendRequestId: z.string().min(1).max(200), status: z.string().max(40), createdAt: z.string().max(40), expiresAt: z.string().max(40).optional(),
 kind: z.string().max(40).optional(), amountUsd: usd.optional(), newLimitUsd: usd.optional(), reason: z.string().max(2000).optional(), approverRole: z.string().max(40).optional(), confirmUrl: z.string().max(2048).optional(),
})).max(1000) });
export type SpendRequestRow = z.infer<typeof SpendRequestsReaderSchema>["spendRequests"][number];
export const SPENDING_PATHS = { budget: "/v1/app/budget", orgSpend: "/v1/app/org/spend", requests: "/v1/app/spend-requests", settings: "/v1/app/org/budget-settings", members: "/v1/app/org/members" } as const;
export interface SpendingScope { orgId: string; developerId: string; role: string; enabled: boolean }
/**
 * The page's five reads, kept in the admin cache area under the company, person and role, so losing access (or switching company) drops them like every other admin read.
 * A failed read keeps no amounts: `retry: false` here, because the api client already retries a read, and the page shows the failure.
 */
export function useSpendingReads({ orgId, developerId, role, enabled }: SpendingScope) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), cache = useQueryClient();
 useEffect(() => () => { void cache.cancelQueries({ queryKey: ["admin", "spending", orgId, developerId, role] });cache.removeQueries({ queryKey: ["admin", "spending", orgId, developerId, role] }); }, [cache, orgId, developerId, role]);
 const read = <T>(area: string, path: string, schema: Reader<T>) => ({ queryKey: ["admin", "spending", orgId, developerId, role, area], queryFn: () => api.get(path, schema), enabled, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false });
 const budget = useQuery(read("budget", SPENDING_PATHS.budget, SpendBudgetReaderSchema));
 const orgSpend = useQuery(read("org-spend", SPENDING_PATHS.orgSpend, OrgSpendReaderSchema));
 const requests = useQuery(read("requests", SPENDING_PATHS.requests, SpendRequestsReaderSchema));
 const settings = useQuery(read("settings", SPENDING_PATHS.settings, SettingsReader));
 const members = useQuery(read("members", SPENDING_PATHS.members, AppOrgMembersResponseReaderSchema));
 return { budget, orgSpend, requests, settings, members, all: [budget, orgSpend, requests, settings, members] as const };
}
/** A confirmation link the page may open: the app's own confirmation address, with no query. Anything else is not offered. */
export function safeConfirmUrl(value: string | undefined, origin: string): string | undefined {
 return value !== undefined && !value.includes("?") && isConfirmUrl(value, origin) ? value : undefined;
}

/** One project's month, as `GET /v1/app/projects/{p}/spend` answers it: the same figures as the page above (committed is spent plus holds), with no per-person rows. The contracts package has no reader for it, so it is here. */
export const ProjectSpendReaderSchema = z.object({ month, project: label, spentUsd: usd, committedUsd: usd, limitUsd: usd.optional() });
export type ProjectSpend = z.infer<typeof ProjectSpendReaderSchema>;
export const projectSpendPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(project) + "/spend";
/**
 * The Spending tab's one read. An answer about another project is refused (unreadable), never shown. `retry: false` because the api client already retries a read; `gcTime: 0` so no figure outlives the tab.
 * A 403 (not a maintainer any more) or a 404 (no such project, or hidden) is shown by the tab as one plain sentence.
 */
export function useProjectSpend(project: string, enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const reader: Reader<ProjectSpend> = useMemo(() => ({ parse: (value: unknown) => { const read = ProjectSpendReaderSchema.parse(value);if (read.project !== project) throw new Error("project-mismatch");return read; } }), [project]);
 return useQuery({ queryKey: ["project", project, "spend"], queryFn: () => api.get(projectSpendPath(project), reader), enabled, retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false });
}
