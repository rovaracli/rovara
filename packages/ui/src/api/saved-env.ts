// The calls of the project's Environment panel (SH26): the saved environment's health and Reset. The server decides who may Reset and what a rebuild means; this file only sends and reads. The write is sent once
// from the browser session (`retry: "never"`). The route exists only while saved environments are on; where it does not, the read answers 404 and the panel shows nothing.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema, SavedEnvPanelReaderSchema, SavedEnvResetAnswerReaderSchema, SavedEnvResetBodySchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;
const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/environment-image";

export function createSavedEnvApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  panel: (project: string) => api.get(base(project), SavedEnvPanelReaderSchema),
  /** Asks for a rebuild. A fresh request id per press; the server answers the panel afterwards. */
  reset: (project: string) => api.sendAnswer("POST", base(project), SavedEnvResetBodySchema.parse({ action: "reset", requestId: crypto.randomUUID() }), SavedEnvResetAnswerReaderSchema, NEVER),
 };
}
export function useSavedEnvApi() { const host = useAppHost();return useMemo(() => createSavedEnvApi(host), [host]); }
export const savedEnvKey = (project: string) => ["saved-env", project] as const;
export function useSavedEnvPanel(project: string) { const api = useSavedEnvApi();return useQuery({ queryKey: savedEnvKey(project), queryFn: () => api.panel(project), refetchOnWindowFocus: false, retry: false }); }
