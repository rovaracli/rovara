import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema, AppProjectsResponseSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createApiClient } from "../../api/client.js";
export function useAgentMembers(enabled: boolean) { const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);return useQuery({ queryKey: ["org", "members"], enabled, queryFn: () => api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema) }); }
export function useAgentProjects(enabled: boolean) { const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);return useQuery({ queryKey: ["projects"], enabled, queryFn: () => api.get("/v1/app/projects", AppProjectsResponseSchema) }); }
export function failureText(error: unknown, fallback: string) { return error instanceof ApiError ? error.message : fallback; }
