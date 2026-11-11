import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AGENT_PUBLISH_NOTE_MAX, AgentIdSchema, AgentPublicationReaderSchema, AgentPublishAnswerReaderSchema, AgentPublishRequestBodySchema, AgentPublishRequestListReaderSchema, AgentPublishRequestReaderSchema, AgentPublishWithdrawnReaderSchema, FavouriteAgentsBodySchema, FavouriteAgentsReaderSchema, MAX_FAVOURITE_AGENTS, MyAgentsReaderSchema, ProjectOverviewProjectSchema, PublishTargetSchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";

/**
 * Agent publish requests, favourite agents and suggested agents (experience decisions 23 and 24). The shapes are the server's (`packages/cloud-contracts/src/app-agent-publish.ts`, exported from
 * `@agentx/cloud-contracts/web`). Decisions are never posted from here: every Approve and Decline is made on the request's confirmation page (`approval.confirmUrl`), with a fresh sign-in.
 */
export { PublishTargetSchema, AgentPublishRequestBodySchema, FavouriteAgentsBodySchema, AgentPublishRequestReaderSchema, AgentPublishRequestListReaderSchema, AgentPublishAnswerReaderSchema, AgentPublicationReaderSchema, MyAgentsReaderSchema };
export const FavouritesReaderSchema = FavouriteAgentsReaderSchema;
export const WithdrawnReaderSchema = AgentPublishWithdrawnReaderSchema;
export const MAX_FAVOURITES = MAX_FAVOURITE_AGENTS, MAX_NOTE_CHARACTERS = AGENT_PUBLISH_NOTE_MAX;

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
