import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentIdSchema, AgentScopeSchema, AgentMonthSchema, ProjectOverviewProjectSchema, AgentDirectoryResponseReaderSchema, AgentProfileResponseReaderSchema, AgentWriteResponseReaderSchema, AgentVersionsResponseReaderSchema, AgentSpendResponseReaderSchema, AgentSharesResponseReaderSchema, AgentSharesPutResponseReaderSchema, AgentOwnerPutBodySchema, AgentAccountablePutBodySchema, AgentAccountableResponseReaderSchema, AgentShareInputSchema, AgentAdoptResponseReaderSchema, AgentDraftResponseReaderSchema, AgentUpdateBaseResponseReaderSchema, AgentDiffResponseReaderSchema } from "@agentx/cloud-contracts/web";
import type { AppHost } from "../host.js";
import { useAppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { createApiClient } from "./client.js";
export type AgentScope = ReturnType<typeof AgentScopeSchema.parse>;
export type ReadAgentProfile = ReturnType<typeof AgentProfileResponseReaderSchema.parse>;
export type ReadAgent = ReadAgentProfile["agent"];
export function createAgentApi(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => { const parsed = AgentIdSchema.safeParse(id);if (!parsed.success) throw new ApiError(404, "NOT_FOUND", "Not found.");return "/v1/app/agents/" + encodeURIComponent(parsed.data); };
 return {
  list(scope: AgentScope, project?: string) { const params = project === undefined ? new URLSearchParams({ scope: AgentScopeSchema.parse(scope) }) : new URLSearchParams({ project: ProjectOverviewProjectSchema.shape.name.parse(project) });return api.get("/v1/app/agents?" + params.toString(), AgentDirectoryResponseReaderSchema); },
  read: (id: string) => api.get(path(id), AgentProfileResponseReaderSchema),
  versions: (id: string) => api.get(path(id) + "/versions", AgentVersionsResponseReaderSchema),
  spend: (id: string, month: string) => api.get(path(id) + "/spend?" + new URLSearchParams({ month: AgentMonthSchema.parse(month) }).toString(), AgentSpendResponseReaderSchema),
  shares: (id: string) => api.get(path(id) + "/shares", AgentSharesResponseReaderSchema),
  share: (id: string, shares: Array<ReturnType<typeof AgentShareInputSchema.parse>>) => api.send("PUT", path(id) + "/shares", { requestId: crypto.randomUUID(), shares: shares.map(item => AgentShareInputSchema.parse(item)) }, AgentSharesPutResponseReaderSchema),
  owner: (id: string, owner: ReturnType<typeof AgentOwnerPutBodySchema.parse>["owner"], accountable?: { developerId: string }) => api.send("PUT", path(id) + "/owner", AgentOwnerPutBodySchema.parse({ requestId: crypto.randomUUID(), owner, ...(accountable === undefined ? {} : { accountable }) }), AgentWriteResponseReaderSchema),
  accountable: (id: string, developerId: string) => api.send("PUT", path(id) + "/accountable", AgentAccountablePutBodySchema.parse({ requestId: crypto.randomUUID(), accountable: { developerId } }), AgentAccountableResponseReaderSchema),
  archive: (id: string) => api.send("POST", path(id) + "/archive", { requestId: crypto.randomUUID() }, AgentWriteResponseReaderSchema),
  adopt: (id: string, version: number) => api.send("POST", path(id) + "/adopt", { requestId: crypto.randomUUID(), version }, AgentAdoptResponseReaderSchema),
  draft: (id: string) => api.get(path(id) + "/draft", AgentDraftResponseReaderSchema),
  updateBase: (id: string, expectedRevision: number) => api.send("POST", path(id) + "/update-base", { requestId: crypto.randomUUID(), expectedRevision }, AgentUpdateBaseResponseReaderSchema),
  diff: (id: string, from: number | "base" | "draft", to: number | "draft") => api.get(path(id) + "/diff?" + new URLSearchParams({ from: String(from), to: String(to) }).toString(), AgentDiffResponseReaderSchema),
 };
}
export function useAgentApi() { const host = useAppHost();return useMemo(() => createAgentApi(host), [host]); }
export function useAgents(scope: AgentScope, project?: string) { const api = useAgentApi();return useQuery({ queryKey: ["agents", scope, project], queryFn: () => api.list(scope, project) }); }
export function useAgent(id?: string) { const api = useAgentApi();return useQuery({ queryKey: ["agent", id], enabled: id !== undefined, queryFn: () => api.read(id!) }); }
export function useAgentSpend(id: string, month: string, enabled = true) { const api = useAgentApi();return useQuery({ queryKey: ["agent", id, "spend", month], enabled, queryFn: () => api.spend(id, month) }); }
export function useAgentVersions(id: string, enabled = true) { const api = useAgentApi();return useQuery({ queryKey: ["agent", id, "versions"], enabled, queryFn: () => api.versions(id) }); }
