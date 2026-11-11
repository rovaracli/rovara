import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AgentAccessLevelSchema, AgentIdSchema, AgentOwnerSchema, ProjectOverviewProjectSchema, forwardReader } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";

/**
 * Agent publish requests, favourite agents and suggested agents (experience lane exp/agent-publish).
 *
 * LOCAL SCHEMAS, TO BE REPLACED. Everything between the two LOCAL SCHEMAS markers matches `briefs/agent-publish-api.md` (v1 of the shape, 2026-11-11) EXACTLY and nothing more.
 * The server lane will publish the same schemas in `packages/contracts/src/app-agent-publish.ts` (exported from `@agentx/contracts/web`): `AgentPublishRequestReaderSchema`, `AgentPublishRequestListReaderSchema`,
 * `AgentPublishRequestBodySchema`, `AgentPublishAnswerReaderSchema`, `AgentPublicationReaderSchema`, `MyAgentsReaderSchema`, `FavouriteAgentsBodySchema`. When that file lands, delete this block and import those
 * names here under the names exported below; nothing outside this file changes.
 */
// ---- LOCAL SCHEMAS (start): replace with the import from @agentx/contracts/web ----
const Person = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string() }).strict();
export const PublishTargetSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("project"), project: z.string().min(1) }).strict(), z.object({ kind: z.literal("company") }).strict()]);
const AgentSummary = z.object({
 steps: z.number().int().nonnegative(),
 tools: z.array(z.object({ connector: z.string(), access: z.enum(["read", "read_write"]) }).strict()),
 autonomy: z.enum(["suggest", "prepare", "run"]),
 triggers: z.array(z.enum(["manual", "schedule", "event"])),
 skills: z.number().int().nonnegative(),
 monthlyBudgetUsd: z.number().finite().nonnegative().optional(),
 maxPerRunUsd: z.number().finite().nonnegative().optional(),
 extends: z.object({ agentId: AgentIdSchema, version: z.number().int().positive() }).strict().optional(),
 lessSafe: z.array(z.string()),
}).strict();
const PublishRequest = z.object({
 requestId: z.string().uuid(),
 approvalId: z.string().regex(/^apr_[0-9a-z]{20}$/u),
 agent: z.object({ agentId: AgentIdSchema, name: z.string(), description: z.string() }).strict(),
 target: PublishTargetSchema,
 version: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
 state: z.enum(["pending", "approved", "declined", "withdrawn", "expired", "stale", "failed"]),
 requestedBy: Person, requestedAt: z.string(), expiresAt: z.string(),
 note: z.string().nullable(),
 decidedBy: Person.nullable(), decidedAt: z.string().nullable(),
 summary: AgentSummary,
 effect: z.string(),
 approval: z.object({
  canDecide: z.boolean(),
  reason: z.enum(["you_requested", "not_a_maintainer", "not_an_admin", "stale", "expired"]).nullable(),
  freshSignInNeeded: z.boolean(),
  confirmUrl: z.string().nullish(),
 }).strict(),
 // Added by section 4 of the doc (a decline reason) and section 3 (APPROVED_FAILED): both optional.
 declineReason: z.string().nullish(),
 failureText: z.string().nullish(),
}).strict();
const Publication = z.object({
 level: z.enum(["personal", "project", "company"]),
 projects: z.array(z.string()),
 pending: z.object({ requestId: z.string().uuid(), target: PublishTargetSchema, requestedAt: z.string() }).strict().nullable(),
}).strict();
const REASONS = ["favourite", "project_roster", "used_by_you", "popular_in_company", "starter"] as const;
const AgentCard = z.object({
 agentId: AgentIdSchema, name: z.string(), description: z.string(), builtin: z.boolean(), status: z.enum(["active", "archived"]), access: AgentAccessLevelSchema,
 currentVersion: z.number().int().positive().optional(), owner: AgentOwnerSchema.optional(), publication: Publication,
 reason: z.enum(REASONS),
}).strict();
const AgentPublishAnswer = z.discriminatedUnion("status", [
 z.object({ status: z.literal("NEEDS_CONFIRMATION"), confirmUrl: z.string().optional(), changes: z.array(z.string()), request: PublishRequest }).strict(),
 // The doc names the agent an `AgentView`; the web entry does not export that schema yet, so only what this page reads is typed.
 z.object({ status: z.literal("published"), agent: z.object({ agentId: AgentIdSchema, name: z.string() }).strict(), request: z.null() }).strict(),
]);
const MyAgents = z.object({ favourites: z.array(AgentCard), suggested: z.array(AgentCard), limits: z.object({ maxFavourites: z.number().int().positive(), maxSuggested: z.number().int().positive() }).strict(), revision: z.number().int().nonnegative() }).strict();
export const AgentPublishRequestBodySchema = z.object({ requestId: z.string().uuid(), target: PublishTargetSchema, version: z.number().int().positive(), note: z.string().refine(value => [...value].length <= 300, "up to 300 characters").optional() }).strict();
export const FavouriteAgentsBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), agentIds: z.array(AgentIdSchema).max(12) }).strict();
const AgentPublishRequestList = z.object({ requests: z.array(PublishRequest), next: z.string().optional() }).strict();
const Favourited = z.object({ favourites: z.array(AgentCard), revision: z.number().int().nonnegative() }).strict();
const Withdrawn = z.object({ request: PublishRequest }).strict();
// The decide route's body today is `{ requestId, decision }` plus the NEW optional `reason` (plain text, up to 300 characters). Its answer is not described in the doc: any object is read as "decided", and the lists are read again.
export const ApprovalDecideBodySchema = z.object({ requestId: z.string().uuid(), decision: z.enum(["APPROVE", "DECLINE"]), reason: z.string().refine(value => [...value].length <= 300, "up to 300 characters").optional() }).strict();
const DecideAnswer = z.looseObject({});
export const AgentPublishRequestReaderSchema = forwardReader(PublishRequest);
export const AgentPublishRequestListReaderSchema = forwardReader(AgentPublishRequestList);
export const AgentPublishAnswerReaderSchema = forwardReader(AgentPublishAnswer);
export const AgentPublicationReaderSchema = forwardReader(Publication);
export const MyAgentsReaderSchema = forwardReader(MyAgents);
export const FavouritesReaderSchema = forwardReader(Favourited);
export const WithdrawnReaderSchema = forwardReader(Withdrawn);
export const ApprovalDecideReaderSchema = DecideAnswer;
export const MAX_FAVOURITES = 12, MAX_NOTE_CHARACTERS = 300;
// ---- LOCAL SCHEMAS (end) ----

export type ReadPublishRequest = ReturnType<typeof AgentPublishRequestReaderSchema.parse>;
export type ReadAgentSummary = ReadPublishRequest["summary"];
export type ReadPublication = ReturnType<typeof AgentPublicationReaderSchema.parse>;
export type ReadAgentCard = ReturnType<typeof MyAgentsReaderSchema.parse>["favourites"][number];
export type ReadMyAgents = ReturnType<typeof MyAgentsReaderSchema.parse>;
export type PublishTarget = z.infer<typeof PublishTargetSchema>;
export type PublishAnswer = ReturnType<typeof AgentPublishAnswerReaderSchema.parse>;
export type RequestStateFilter = "pending" | "all";
export interface RequestQuery { state?: RequestStateFilter; mine?: boolean; project?: string }

/** The additive `publication` field of an agent view: read from the loose reader's extra fields, `undefined` when the server does not send it (an older server) or sends something unreadable. */
export function publicationOf(agent: object): ReadPublication | undefined {
 const parsed = AgentPublicationReaderSchema.safeParse((agent as { publication?: unknown }).publication);
 return parsed.success ? parsed.data : undefined;
}

const queryString = (query: RequestQuery, extra: Record<string, string>): string => {
 const params = new URLSearchParams({ state: query.state ?? "pending", ...extra });
 if (query.mine === true) params.set("mine", "1");
 if (query.project !== undefined) params.set("project", ProjectOverviewProjectSchema.shape.name.parse(query.project));
 return params.toString();
};

export function createAgentPublishApi(host: AppHost) {
 const api = createApiClient(host);
 const agentPath = (id: string) => { const parsed = AgentIdSchema.safeParse(id);if (!parsed.success) throw new ApiError(404, "NOT_FOUND", "Not found.");return "/v1/app/agents/" + encodeURIComponent(parsed.data); };
 return {
  /** Ask to publish. A 202 carries the waiting request, a 200 says it was applied at once; this client reads both as the answer (it never reads the 202 as a bare confirmation). */
  ask: (agentId: string, input: { requestId: string; target: PublishTarget; version: number; note?: string }) => api.sendAnswer("POST", agentPath(agentId) + "/publish-requests", AgentPublishRequestBodySchema.parse(input), AgentPublishAnswerReaderSchema),
  /** Requests for one agent (needs `manage`). The doc names the route and not the answer: it is read as the same list as the general one. */
  forAgent: (agentId: string) => api.get(agentPath(agentId) + "/publish-requests", AgentPublishRequestListReaderSchema),
  list: (query: RequestQuery, cursor?: string) => api.get("/v1/app/agent-publish-requests?" + queryString(query, { limit: "20", ...(cursor === undefined ? {} : { cursor }) }), AgentPublishRequestListReaderSchema),
  withdraw: (requestId: string) => { const id = z.string().uuid().parse(requestId);return api.sendAnswer("POST", "/v1/app/agent-publish-requests/" + id + "/withdraw", { requestId: crypto.randomUUID() }, WithdrawnReaderSchema); },
  /** The existing decide route: browser only, with a recent sign-in. A token, or a browser without one, is refused with REAUTH_REQUIRED. */
  decide: (approvalId: string, decision: "APPROVE" | "DECLINE", reason?: string) => {
   if (!/^apr_[0-9a-z]{20}$/u.test(approvalId)) throw new ApiError(404, "NOT_FOUND", "Not found.");
   return api.sendAnswer("POST", "/v1/app/approvals/" + approvalId + "/decide", ApprovalDecideBodySchema.parse({ requestId: crypto.randomUUID(), decision, ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }) }), ApprovalDecideReaderSchema, { retry: "never" });
  },
  myAgents: (project?: string) => api.get("/v1/app/me/agents" + (project === undefined ? "" : "?" + new URLSearchParams({ project: ProjectOverviewProjectSchema.shape.name.parse(project) }).toString()), MyAgentsReaderSchema),
  setFavourites: (agentIds: readonly string[], expectedRevision: number) => api.sendAnswer("PUT", "/v1/app/me/agents/favourites", FavouriteAgentsBodySchema.parse({ requestId: crypto.randomUUID(), expectedRevision, agentIds }), FavouritesReaderSchema),
 };
}
export function useAgentPublishApi() { const host = useAppHost();return useMemo(() => createAgentPublishApi(host), [host]); }

/** Every query below shares this key prefix, so one invalidation after a decision, a withdrawal or an ask refreshes them all. */
export const PUBLISH_KEY = "agent-publish";
export function usePublishRequests(query: RequestQuery, enabled = true) {
 const api = useAgentPublishApi();
 return useInfiniteQuery({ queryKey: [PUBLISH_KEY, "requests", query.state ?? "pending", query.mine === true, query.project], enabled, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => api.list(query, pageParam), getNextPageParam: page => page.next });
}
export function useAgentPublishRequests(agentId: string, enabled: boolean) {
 const api = useAgentPublishApi();
 return useQuery({ queryKey: [PUBLISH_KEY, "agent", agentId], enabled, queryFn: () => api.forAgent(agentId) });
}
/** The favourites and the suggested agents (`GET /v1/app/me/agents`). Everyone's favourites are one list, whichever project is asked about; the project only changes which agents are suggested. */
export const MY_AGENTS_KEY = "me-agents";
export function useMyAgents(project?: string, enabled = true) {
 const api = useAgentPublishApi();
 return useQuery({ queryKey: [MY_AGENTS_KEY, project], enabled, queryFn: () => api.myAgents(project) });
}
