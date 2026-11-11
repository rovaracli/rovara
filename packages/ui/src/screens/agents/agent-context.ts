import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema, AppOrgMembersResponseReaderSchema, AppProjectsResponseSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createApiClient } from "../../api/client.js";
export function useAgentMembers(enabled: boolean) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const identity = useQuery({ queryKey: ["agent-directory", "identity"], enabled, staleTime: 0, gcTime: 0, refetchOnMount: "always", queryFn: async () => { const me = await api.get("/v1/app/me", AppMeResponseReaderSchema);return { orgId: me.org.orgId, developerId: me.developer.id }; } });
 const orgId = identity.data?.orgId, developerId = identity.data?.developerId;
 const allowed = enabled && identity.isSuccess && orgId !== undefined && developerId !== undefined;
 const key = useMemo(() => ["org", "members", orgId, developerId], [orgId, developerId]);
 useEffect(() => {
  if (identity.isError) { void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); }
  return () => { if ((query.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount() ?? 0) <= 1) { void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); } };
 }, [query, key, identity.isError]);
 const members = useQuery({ queryKey: key, enabled: allowed, gcTime: 0, queryFn: async () => { const result = await api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema);return { members: result.members.map(person => ({ developerId: person.developerId, name: person.name })) }; } });
 return { ...members, data: allowed && !members.isError ? members.data : undefined, isPending: identity.isPending || members.isPending, isError: identity.isError || members.isError, error: identity.error ?? members.error };
}
export function useAgentProjects(enabled: boolean) { const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);return useQuery({ queryKey: ["projects"], enabled, queryFn: () => api.get("/v1/app/projects", AppProjectsResponseSchema) }); }
export function failureText(error: unknown, fallback: string) { return error instanceof ApiError ? error.message : fallback; }
