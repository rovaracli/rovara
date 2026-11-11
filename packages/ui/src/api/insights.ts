// The Insights screens' reads and the viewer grant (lane exp/insights). Routes are from the agreed API doc (briefs/insights-api.md). Nothing here is a broker or contract change.
//   GET  /v1/app/insights                    overview: who the reader is, their scope, which panels exist and whether the data is ready
//   GET  /v1/app/insights/stuck              stuck work, longest wait first
//   GET  /v1/app/insights/shipped            shipped outcomes per week and project
//   GET  /v1/app/insights/spend              spend vs outcomes per project (and per person ONLY when the server sends `byPerson`)
//   GET  /v1/app/insights/flow               flow health
//   GET  /v1/app/org/insights-access         [owner or admin] who holds the Insights viewer grant
//   POST /v1/app/org/insights-access         [owner or admin, browser session only] grant or revoke
// LOCAL SCHEMAS, TO BE REPLACED: the server lane will export `InsightsOverviewReaderSchema`, `InsightsStuckReaderSchema`, `InsightsShippedReaderSchema`, `InsightsSpendReaderSchema`, `InsightsFlowReaderSchema`,
// `InsightsAccessReaderSchema` and `InsightsAccessBodySchema` from `@agentx/contracts/web` (packages/contracts/src/app-insights.ts). Until then every shape lives in this ONE block, written to match the doc.
// When the contract lands, delete the block and import the readers; the hooks and screens only use the types exported below. The doc's readers are built with `forwardReader`: a value a newer server adds reads
// as "unknown" instead of failing the page, which `soft` does here.
import { useMemo } from "react";
import { useInfiniteQuery, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";

// ---- LOCAL SCHEMAS (replace with `@agentx/contracts/web` readers when app-insights.ts exists) ----
/** An enum that reads any value it does not know as "unknown" (the doc's `forwardReader` behaviour). */
function soft<const T extends readonly string[]>(values: T) {
 return z.string().max(80).transform((value): T[number] | "unknown" => (values as readonly string[]).includes(value) ? value as T[number] : "unknown");
}
const iso = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)));
const label = z.string().min(1).max(200);
const usd = z.number().finite().nonnegative().max(1e9);
const hours = z.number().finite().nonnegative().max(1e7);
const count = z.number().int().nonnegative().max(1e9);
const developerId = z.string().regex(/^[a-f0-9]{64}$/u);
const PersonSchema = z.object({ id: developerId, name: label });
const PANEL_STATUS = ["ready", "collecting", "unavailable"] as const;
const CoverageSchema = z.object({ sources: z.array(label).max(50), notCovered: z.array(label).max(50), partial: z.boolean(), truncated: z.boolean() });
const NEXT_ACTOR_KINDS = ["person", "group", "role", "rovara"] as const;
const NextActorSchema = z.object({ kind: soft(NEXT_ACTOR_KINDS), name: label.optional(), role: soft(["approver", "reviewer", "owner", "maintainer", "admin", "collaborator"]).optional() });
const ScopeSchema = z.object({ kind: soft(["company", "projects"]), projects: z.array(label).max(1000).optional() });
export const InsightsOverviewReaderSchema = z.object({
 enabled: z.boolean(),
 viewer: z.object({ role: soft(["owner", "admin", "member"]), via: z.array(soft(["owner", "admin", "viewer_grant", "maintainer"])).max(10), scope: ScopeSchema, contentLevel: soft(["full_where_readable", "metadata_only_elsewhere"]), canSeePerPerson: z.boolean() }),
 panels: z.object({
  stuck: z.object({ status: soft(["ready", "unavailable"]), coverage: CoverageSchema }),
  shipped: z.object({ status: soft(PANEL_STATUS), collectingSince: iso.nullable() }),
  spend: z.object({ status: soft(["ready"]), outcomesStatus: soft(PANEL_STATUS) }),
  flow: z.object({ status: soft(PANEL_STATUS), collectingSince: iso.nullable() }),
 }),
 capture: z.object({ workEvents: soft(["on", "off"]), since: iso.nullable(), retentionMonths: count }),
 asOf: iso,
});
export const InsightsStuckReaderSchema = z.object({
 status: soft(["ready", "unavailable"]), asOf: iso, coverage: CoverageSchema,
 summary: z.object({ total: count, over24h: count, over72h: count, byNextActorKind: z.record(z.string().max(40), count), byBlocker: z.record(z.string().max(40), count) }),
 items: z.array(z.object({
  itemId: label, project: label,
  blocker: soft(["decision", "approval", "spend", "review", "merge", "budget", "failure", "setup"]),
  state: z.string().max(80), stateWords: z.string().max(200), nextActor: NextActorSchema, since: iso, sinceKind: soft(["state", "last_update"]), ageHours: hours,
  visibility: soft(["full", "metadata"]),
  // present only when visibility is "full":
  title: z.string().max(500).optional(), reason: z.string().max(2000).optional(), link: z.string().max(2048).optional(),
  // NOT IN THE DOC YET (needs server): who owns the work. Decision 91 (2026-11-11) says stuck rows show the owner's name; the doc's item shape has no field for it. Optional here so the screen shows it when the server adds it.
  owner: PersonSchema.optional(),
 })).max(1000),
 next: z.string().max(2000).optional(),
});
export const InsightsShippedReaderSchema = z.object({
 status: soft(PANEL_STATUS), collectingSince: iso.nullable().optional(),
 weeks: z.array(z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), shipped: count,
  byProject: z.array(z.object({
   project: label, shipped: count,
   items: z.array(z.object({
    itemId: label, mergedAt: iso, visibility: soft(["full", "metadata"]), title: z.string().max(500).optional(),
    prs: z.array(z.object({ repository: label, number: z.number().int().positive(), url: z.string().max(2048) })).max(50).optional(),
    // NOT IN THE DOC YET (needs server): linked tickets. The brief asks for "linked PRs and tickets"; the doc's item shape carries PRs only.
    tickets: z.array(z.object({ key: label, url: z.string().max(2048).optional() })).max(50).optional(),
   })).max(20),
  })).max(1000),
 })).max(26),
});
export const InsightsSpendReaderSchema = z.object({
 month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u), status: soft(["ready"]), scope: soft(["company", "projects"]),
 totals: z.object({ spentUsd: usd, committedUsd: usd, limitUsd: usd.optional() }).optional(),
 byProject: z.array(z.object({ project: label, spentUsd: usd, committedUsd: usd, limitUsd: usd.optional(), people: count.nullable(), shipped: count.nullable(), costPerShippedUsd: usd.nullable() })).max(1000),
 // Owner or admin only. ABSENT (not empty) for everyone else: the screen draws a person column only when this key is present and never infers it.
 byPerson: z.array(z.object({ developerId, name: label, spentUsd: usd, limitUsd: usd.optional() })).max(1000).optional(),
 outcomes: z.object({ status: soft(PANEL_STATUS) }),
});
const FlowFiguresShape = {
 items: count, enough: z.boolean(),
 cycleTimeHours: z.object({ median: hours, p90: hours }).optional(), reviewWaitHours: z.object({ median: hours, p90: hours }).optional(),
 waitByNextActor: z.array(z.object({ kind: soft(NEXT_ACTOR_KINDS), medianHours: hours })).max(20).optional(),
 failureRate: z.object({ failed: count, of: count }).optional(), retryRate: z.object({ retried: count, of: count }).optional(), sendBackRate: z.object({ sentBack: count, of: count }).optional(),
};
const FlowFiguresSchema = z.object(FlowFiguresShape);
export const InsightsFlowReaderSchema = z.object({
 days: count, status: soft(PANEL_STATUS), collectingSince: iso.nullable().optional(), minSamples: count,
 company: FlowFiguresSchema, byProject: z.array(z.object({ project: label, ...FlowFiguresShape })).max(1000),
});
const AccessViewersShape = { viewers: z.array(z.object({ person: PersonSchema, grantedBy: PersonSchema, grantedAt: iso })).max(10000), eligibleCount: count };
export const InsightsAccessReaderSchema = z.object(AccessViewersShape);
/** The grant's POST body (doc section 4): strict JSON from a live browser session. */
export interface InsightsAccessBody { action: "grant" | "revoke"; requestId: string; developerId: string }
// ---- END LOCAL SCHEMAS ----

export type InsightsOverview = z.infer<typeof InsightsOverviewReaderSchema>;
export type InsightsStuck = z.infer<typeof InsightsStuckReaderSchema>;
export type StuckItem = InsightsStuck["items"][number];
export type InsightsShipped = z.infer<typeof InsightsShippedReaderSchema>;
export type InsightsSpend = z.infer<typeof InsightsSpendReaderSchema>;
export type InsightsFlow = z.infer<typeof InsightsFlowReaderSchema>;
export type FlowFigures = z.infer<typeof FlowFiguresSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type NextActor = z.infer<typeof NextActorSchema>;
export type InsightsAccess = z.infer<typeof InsightsAccessReaderSchema>;
export type PanelStatus = (typeof PANEL_STATUS)[number] | "unknown";

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
