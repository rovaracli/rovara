// The calls of the project's Environment panel (SH26): the saved environment's health (read only: there is no Reset, Cloud does not forward one). The route exists only while saved environments are on; where it does not, the read answers 404 and the panel shows nothing.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, SavedEnvPanelReaderSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/environment-image";

export function createSavedEnvApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  panel: (project: string) => api.get(base(project), SavedEnvPanelReaderSchema),
 };
}
export function useSavedEnvApi() { const host = useAppHost();return useMemo(() => createSavedEnvApi(host), [host]); }
export const savedEnvKey = (project: string) => ["saved-env", project] as const;
export function useSavedEnvPanel(project: string) { const api = useSavedEnvApi();return useQuery({ queryKey: savedEnvKey(project), queryFn: () => api.panel(project), refetchOnWindowFocus: false, retry: false }); }
