// The Health and readiness page's reads (lane exp/health-readiness). Every one is a read the broker already answers and the app already makes somewhere else; nothing here writes, and no
// readiness rule lives here: the page turns what comes back into healthy / action needed / unknown (screens/admin/health/readiness.ts).
//   GET /v1/app/github/installations, /v1/app/github/requests   the code host connection
//   GET /v1/app/connections                                       saved tracker, monitoring and tool connections, each with its own last check
//   GET /v1/app/org/slack-workspace-evidence                      stored chat associations (owner or admin; anyone else is refused)
//   GET /v1/app/org/model-sources                                 the company's AI providers
//   GET /v1/app/projects                                          each project's environment check
//   GET /v1/app/org/service-status                                stored runtime qualification and the team record's delete check
//   GET /v1/app/projects/{p}/lessons/sources                      the team record's sources, per project (the first 20 projects)
//   GET /v1/app/org/approvals/pending-summary                     the company's open approvals: the total and the newest (owner or admin; the contract's reader)
//   GET /v1/app/spend-requests                                    spending requests that wait for a second admin
//   GET /v1/app/org/lessons/preset, /v1/app/org/design-review     company rules a different admin must confirm (owner or admin; anyone else is refused)
// A read that is refused, missing or failed is never turned into a figure: it is `refused`, `missing` or `failed`, and the page says "Unknown" for it.
import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { AppProjectsResponseSchema, GithubInstallationsResponseReaderSchema, ORG_PENDING_APPROVALS_PATH, OrgPendingApprovalsSummaryReaderSchema, OrgSlackWorkspaceEvidenceResponseReaderSchema, type OrgServiceStatus } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";
import { createDesignReviewCompanyApi } from "./design-review-company.js";
import { createLessonsApi, type LessonCompanyPreset, type LessonSources } from "./lessons.js";
import { useNav } from "./nav.js";
import { createServiceStatusApi } from "./service-status.js";
import { SpendRequestsReaderSchema } from "./spending.js";

/** What one read came to. `refused`: not signed in or not allowed (401, 403). `missing`: the install does not have it (404). `failed`: anything else. */
export type Read<T> = { state: "loading" } | { state: "ok"; data: T; at: number } | { state: "refused" } | { state: "missing" } | { state: "failed" };
export function toRead<T>(query: Pick<UseQueryResult<T>, "isPending" | "isError" | "error" | "data" | "dataUpdatedAt">): Read<T> {
 // A failed refresh keeps no data: stale answers are never shown as current.
 if (query.isError) { const status = query.error instanceof ApiError ? query.error.status : 0;return status === 401 || status === 403 ? { state: "refused" } : status === 404 ? { state: "missing" } : { state: "failed" }; }
 if (query.isPending || query.data === undefined) return { state: "loading" };
 return { state: "ok", data: query.data, at: query.dataUpdatedAt };
}

/** A read whose answer is one field of the reply. */
function toReadOf<T, U>(query: UseQueryResult<T>, pick: (value: T) => U): Read<U> {
 const base = toRead(query);
 return base.state === "ok" ? { state: "ok", data: pick(base.data), at: base.at } : base;
}

const text = (max: number) => z.string().max(max);
export const ReadinessGithubSchema = { parse(value: unknown) { return GithubInstallationsResponseReaderSchema.parse(value).installations.map(i => ({ installationId: i.installationId, accountLogin: i.accountLogin, status: i.status, connectedBy: i.connectedBy, connectedAt: i.connectedAt })); } };
const RequestsSchema = z.object({ requests: z.array(z.object({ accountLogin: text(100).optional(), status: text(64), requestedAt: text(40) })).max(1000) });
const ConnectionsSchema = z.object({ connections: z.array(z.object({ connectionId: text(100), type: text(64), label: text(200), hasCredential: z.boolean(), access: text(20).optional(), updatedAt: text(40), lastCheck: z.object({ ok: z.boolean(), at: text(40) }).optional(), ticketUpdates: text(40).optional() })).max(1000) });
const SourcesSchema = z.object({ sources: z.array(z.object({ sourceId: text(100), kind: text(40), label: text(200), hasCredential: z.boolean(), models: z.array(z.object({ catalog: z.object({ provider: text(100), modelId: text(256) }) })).max(20) })).max(10), order: z.array(text(100)).max(12).optional() });
const ProjectsSchema = { parse(value: unknown) { return AppProjectsResponseSchema.parse(value).projects.map(p => ({ name: p.name, status: p.status, setup: { status: p.setup.status, checkedAt: p.setup.checkedAt, failedStep: p.setup.failedStep } })); } };

export type ReadinessGithub = ReturnType<typeof ReadinessGithubSchema.parse>;
export type ReadinessRequests = z.infer<typeof RequestsSchema>["requests"];
export type ReadinessConnection = z.infer<typeof ConnectionsSchema>["connections"][number];
export type ReadinessSources = z.infer<typeof SourcesSchema>;
export type ReadinessProject = ReturnType<typeof ProjectsSchema.parse>[number];
/** The company's open approvals as the server summarises them: `total`, the newest `approvals`, and `truncated` when the open index was longer than one answer reads. */
export type ReadinessApprovals = z.output<typeof OrgPendingApprovalsSummaryReaderSchema>;
export type ReadinessApproval = ReadinessApprovals["approvals"][number];
export type ReadinessSpendRequest = z.infer<typeof SpendRequestsReaderSchema>["spendRequests"][number];
export type ReadinessSlack = { checkedAt: string; associationCount: number; unavailableCount: number };
export type ReadinessDesignReview = { allowed: boolean; unreadable: boolean; pending?: { kind: "allowed" | "lock"; proposedByYou: boolean; expiresAt: string } };
export type ReadinessFeatures = { localAgents: boolean; usage: boolean; chains: boolean; notices: boolean; describe: boolean; scriptTokens: boolean; decisionCards: boolean };
export type LessonsRead = { project: string; read: Read<LessonSources> };

/** The most projects whose team record sources are read at once. A company with more says so on the page. */
export const LESSONS_PROJECT_CAP = 20;
export const READINESS_PATHS = {
 github: "/v1/app/github/installations", githubRequests: "/v1/app/github/requests", connections: "/v1/app/connections", slack: "/v1/app/org/slack-workspace-evidence", sources: "/v1/app/org/model-sources",
 projects: "/v1/app/projects", approvals: ORG_PENDING_APPROVALS_PATH, spend: "/v1/app/spend-requests",
} as const;

export interface ReadinessScope { orgId: string; developerId: string; role: string; enabled: boolean }
export interface ReadinessReads {
 github: Read<ReadinessGithub>; githubRequests: Read<ReadinessRequests>; connections: Read<ReadinessConnection[]>; slack: Read<ReadinessSlack>; sources: Read<ReadinessSources>; projects: Read<ReadinessProject[]>;
 serviceStatus: Read<OrgServiceStatus>; features: Read<ReadinessFeatures>; lessons: LessonsRead[]; lessonsSkipped: number;
 approvals: Read<ReadinessApprovals>; spend: Read<ReadinessSpendRequest[]>; preset: Read<LessonCompanyPreset>; designReview: Read<ReadinessDesignReview>;
 /** The clock (milliseconds), kept in state so render stays pure: set when the page opens, on every "Check again" and once a minute, so a tab left open ages its observations. */ now: number; /** True while any read is still going. */ busy: boolean; refetch(): void;
}

/**
 * All the reads, kept in the admin cache area under the company, person and role, so losing access (or switching company) drops them like every other admin read.
 * `retry: false`: the api client already retries a read, and a failed read is shown as Unknown, not retried until it looks fine.
 */
export function useReadinessReads({ orgId, developerId, role, enabled }: ReadinessScope): ReadinessReads {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), cache = useQueryClient();
 const [now, setNow] = useState(() => Date.now());
 useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); }, 60_000);return () => { clearInterval(timer); }; }, []);
 useEffect(() => () => { void cache.cancelQueries({ queryKey: ["admin", "readiness", orgId, developerId, role] });cache.removeQueries({ queryKey: ["admin", "readiness", orgId, developerId, role] }); }, [cache, orgId, developerId, role]);
 const options = (area: string, queryFn: () => Promise<unknown>, on = true) => ({ queryKey: ["admin", "readiness", orgId, developerId, role, area], queryFn, enabled: enabled && on, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false } as const);
 const github = useQuery({ ...options("github", () => api.get(READINESS_PATHS.github, ReadinessGithubSchema)) }) as UseQueryResult<ReadinessGithub>;
 const githubRequests = useQuery({ ...options("github-requests", () => api.get(READINESS_PATHS.githubRequests, RequestsSchema)) }) as UseQueryResult<{ requests: ReadinessRequests }>;
 const connections = useQuery({ ...options("connections", () => api.get(READINESS_PATHS.connections, ConnectionsSchema)) }) as UseQueryResult<{ connections: ReadinessConnection[] }>;
 const slackReader = useMemo(() => OrgSlackWorkspaceEvidenceResponseReaderSchema.refine(value => value.orgId === orgId), [orgId]);
 const slack = useQuery({ ...options("slack", async () => { const value = await api.get(READINESS_PATHS.slack, slackReader);return { checkedAt: value.checkedAt, associationCount: value.associationCount, unavailableCount: value.unavailableCount }; }) }) as UseQueryResult<ReadinessSlack>;
 const sources = useQuery({ ...options("sources", () => api.get(READINESS_PATHS.sources, SourcesSchema)) }) as UseQueryResult<ReadinessSources>;
 const projects = useQuery({ ...options("projects", () => api.get(READINESS_PATHS.projects, ProjectsSchema)) }) as UseQueryResult<ReadinessProject[]>;
 const serviceApi = useMemo(() => createServiceStatusApi(host, orgId), [host, orgId]);
 useEffect(() => { serviceApi.setScopeActive(enabled);return () => { serviceApi.setScopeActive(false); }; }, [serviceApi, enabled]);
 const serviceStatus = useQuery({ ...options("service-status", () => serviceApi.read()) }) as UseQueryResult<OrgServiceStatus>;
 const nav = useNav();
 const approvals = useQuery({ ...options("approvals", () => api.get(READINESS_PATHS.approvals, OrgPendingApprovalsSummaryReaderSchema)) }) as UseQueryResult<ReadinessApprovals>;
 const spend = useQuery({ ...options("spend", () => api.get(READINESS_PATHS.spend, SpendRequestsReaderSchema)) }) as UseQueryResult<{ spendRequests: ReadinessSpendRequest[] }>;
 const lessonsApi = useMemo(() => createLessonsApi(host), [host]), designApi = useMemo(() => createDesignReviewCompanyApi(host), [host]);
 const preset = useQuery({ ...options("preset", () => lessonsApi.companyPreset()) }) as UseQueryResult<LessonCompanyPreset>;
 const designReview = useQuery({ ...options("design-review", async () => { const state = await designApi.state();return { allowed: state.allowed, unreadable: state.unreadable, ...(state.pending === undefined ? {} : { pending: { kind: state.pending.kind, proposedByYou: state.pending.proposedByYou, expiresAt: state.pending.expiresAt } }) }; }) }) as UseQueryResult<ReadinessDesignReview>;
 const names = useMemo(() => (projects.data ?? []).filter(project => project.status === "active").map(project => project.name), [projects.data]);
 const shown = names.slice(0, LESSONS_PROJECT_CAP);
 const lessonQueries = useQueries({ queries: shown.map(name => ({ ...options(`lessons:${name}`, () => lessonsApi.sources(name), projects.isSuccess)})) });
 const all = [github, githubRequests, connections, slack, sources, projects, serviceStatus, approvals, spend, preset, designReview, ...lessonQueries];
 return {
  github: toRead(github), githubRequests: toReadOf(githubRequests, value => value.requests), connections: toReadOf(connections, value => value.connections),
  slack: toRead(slack), sources: toRead(sources), projects: toRead(projects), serviceStatus: toRead(serviceStatus),
  features: toReadOf(nav, value => ({ localAgents: value.features.localAgents, usage: value.features.usage, chains: value.features.chains, notices: value.features.notices, describe: value.features.describe, scriptTokens: value.features.scriptTokens === true, decisionCards: value.features.decisionCards === true })),
  lessons: shown.map((project, index) => ({ project, read: toRead(lessonQueries[index]! as UseQueryResult<LessonSources>) })), lessonsSkipped: Math.max(0, names.length - shown.length),
  approvals: toRead(approvals), spend: toReadOf(spend, value => value.spendRequests),
  preset: toRead(preset), designReview: toRead(designReview),
  now, busy: all.some(query => query.isFetching), refetch() { setNow(Date.now());for (const query of all) void query.refetch({ cancelRefetch: false }); },
 };
}
