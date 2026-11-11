// The Insights screens' reads and the viewer grant (lane exp/insights, switched to the contract by srv/insights-followup).
//   GET  /v1/app/insights                    overview: who the reader is, their scope, which panels exist and whether the data is ready
//   GET  /v1/app/insights/stuck              stuck work, longest wait first
//   GET  /v1/app/insights/shipped            shipped outcomes per week and project
//   GET  /v1/app/insights/spend              spend vs outcomes per project (and per person ONLY when the server sends `byPerson`)
//   GET  /v1/app/insights/flow               flow health
//   GET  /v1/app/org/insights-access         [owner or admin] who holds the Insights viewer grant
//   POST /v1/app/org/insights-access         [owner or admin, browser session only] grant or revoke
// The readers are the contract's (`packages/cloud-contracts/src/app-insights.ts`, from `@agentx/cloud-contracts/web`): built with `forwardReader`, so a value a newer server adds reads as "unknown" instead of failing the page.
// Shapes the screens rely on:
//   - the access list's `grantedBy` is OPTIONAL (the audit ledger may not know who gave a grant): show the date without a name;
//   - the flow answer's `company` is OPTIONAL (absent unless `status` is "ready"): check `status` first; shipped and flow answer `status: "unavailable"` until the work-event capture exists;
//   - a stuck row's `itemId` is the session id only on a row the reader can open; on a metadata row it is an OPAQUE id (`itm_...`), and `spr_...`-style ids never reach the browser. NEVER build a link from an
//     item id: a row's own `link` field is the only link, present only when `visibility` is "full";
//   - spend `totals` is absent for a maintainer, `byPerson` is absent (not empty) for a maintainer and a viewer.
// The tiny `{enabled}` reader for the navigation entry stays in `insights-nav.ts`, so the always-loaded shell does not carry these readers.
import { useMemo } from "react";
import { useInfiniteQuery, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import { InsightsAccessReaderSchema, InsightsFlowReaderSchema, InsightsOverviewReaderSchema, InsightsShippedReaderSchema, InsightsSpendReaderSchema, InsightsStuckReaderSchema, type InsightsAccessBody } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";

export type { InsightsAccessBody };
export type InsightsOverview = z.infer<typeof InsightsOverviewReaderSchema>;
export type InsightsStuck = z.infer<typeof InsightsStuckReaderSchema>;
export type StuckItem = InsightsStuck["items"][number];
export type InsightsShipped = z.infer<typeof InsightsShippedReaderSchema>;
export type InsightsSpend = z.infer<typeof InsightsSpendReaderSchema>;
export type InsightsFlow = z.infer<typeof InsightsFlowReaderSchema>;
export type FlowFigures = NonNullable<InsightsFlow["company"]>;
export type Coverage = InsightsOverview["panels"]["stuck"]["coverage"];
export type NextActor = StuckItem["nextActor"];
export type InsightsAccess = z.infer<typeof InsightsAccessReaderSchema>;
export type PanelStatus = InsightsOverview["panels"]["shipped"]["status"];

export const INSIGHTS_PATHS = { overview: "/v1/app/insights", stuck: "/v1/app/insights/stuck", shipped: "/v1/app/insights/shipped", spend: "/v1/app/insights/spend", flow: "/v1/app/insights/flow", access: "/v1/app/org/insights-access" } as const;
export const STUCK_PAGE_SIZE = 25;
const withQuery = (path: string, params: Record<string, string | number | undefined>): string => {
 const query = new URLSearchParams();
 for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
 const text = query.toString();
 return text === "" ? path : `${path}?${text}`;
};

/** The reads are shared by the nav entry and the screen: one overview read per person, kept in its own cache area. */
const READ = { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } as const;
export function useInsightsOverview(person: string | undefined, enabled = true): UseQueryResult<InsightsOverview> {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["insights", person, "overview"], queryFn: () => api.get(INSIGHTS_PATHS.overview, InsightsOverviewReaderSchema), enabled: enabled && person !== undefined, ...READ });
}
export interface PanelScope { person: string | undefined; project: string | undefined; enabled: boolean }
export function useInsightsStuck({ person, project, enabled }: PanelScope) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useInfiniteQuery({
  queryKey: ["insights", person, "stuck", project ?? ""], enabled: enabled && person !== undefined, ...READ,
  queryFn: ({ pageParam }) => api.get(withQuery(INSIGHTS_PATHS.stuck, { project, limit: STUCK_PAGE_SIZE, cursor: pageParam }), InsightsStuckReaderSchema),
  initialPageParam: undefined as string | undefined, getNextPageParam: last => last.next,
 });
}
export function useInsightsShipped({ person, project, enabled, weeks }: PanelScope & { weeks: number }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["insights", person, "shipped", project ?? "", weeks], queryFn: () => api.get(withQuery(INSIGHTS_PATHS.shipped, { project, weeks }), InsightsShippedReaderSchema), enabled: enabled && person !== undefined, ...READ });
}
export function useInsightsSpend({ person, project, enabled, month }: PanelScope & { month: string | undefined }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["insights", person, "spend", project ?? "", month ?? ""], queryFn: () => api.get(withQuery(INSIGHTS_PATHS.spend, { project, month }), InsightsSpendReaderSchema), enabled: enabled && person !== undefined, ...READ });
}
export function useInsightsFlow({ person, project, enabled, days }: PanelScope & { days: 7 | 30 | 90 }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["insights", person, "flow", project ?? "", days], queryFn: () => api.get(withQuery(INSIGHTS_PATHS.flow, { project, days }), InsightsFlowReaderSchema), enabled: enabled && person !== undefined, ...READ });
}

/** The viewer grant's calls. The write is sent once from the browser session (`retry: "never"`); its answer is the new list. */
export function createInsightsAccessApi(host: ReturnType<typeof useAppHost>) {
 const api = createApiClient(host);
 const send = (body: InsightsAccessBody) => api.sendAnswer("POST", INSIGHTS_PATHS.access, body, InsightsAccessReaderSchema, { retry: "never" });
 return {
  list: () => api.get(INSIGHTS_PATHS.access, InsightsAccessReaderSchema),
  grant: (member: string) => send({ action: "grant", requestId: globalThis.crypto.randomUUID(), developerId: member }),
  revoke: (member: string) => send({ action: "revoke", requestId: globalThis.crypto.randomUUID(), developerId: member }),
 };
}
