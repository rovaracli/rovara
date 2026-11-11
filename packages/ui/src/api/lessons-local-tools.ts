// Lessons for local coding tools (decision 46b): the project's own switch (GET and POST /v1/app/projects/{p}/lessons/local-tools) and the company's "lessons stay in Rovara" switch (GET and POST /v1/app/org/lessons/local-tools).
// The server decides who may read and change each and what it comes to; this file only sends and reads. A write is sent once from the browser session (`retry: "never"`).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LocalToolsCompanyBodySchema, LocalToolsCompanyStateReaderSchema, LocalToolsProjectBodySchema, LocalToolsStateReaderSchema, ProjectOverviewProjectSchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export type LocalToolsView = ReturnType<typeof LocalToolsStateReaderSchema.parse>;
const NEVER = { retry: "never" } as const;
const projectPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/lessons/local-tools";
const COMPANY = "/v1/app/org/lessons/local-tools";
export const localToolsKey = (project: string) => ["lessons", project, "local-tools"] as const;
export const companyLocalToolsKey = ["lessons", "company-local-tools"] as const;

export function createLocalToolsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  project: (project: string) => api.get(projectPath(project), LocalToolsStateReaderSchema),
  setProject: (project: string, enabled: boolean) => api.sendAnswer("POST", projectPath(project), LocalToolsProjectBodySchema.parse({ enabled }), LocalToolsStateReaderSchema, NEVER),
  company: () => api.get(COMPANY, LocalToolsCompanyStateReaderSchema),
  setCompany: (stays: boolean) => api.sendAnswer("POST", COMPANY, LocalToolsCompanyBodySchema.parse({ stays }), LocalToolsCompanyStateReaderSchema, NEVER),
 };
}
export function useLocalToolsApi() { const host = useAppHost();return useMemo(() => createLocalToolsApi(host), [host]); }
export function useLocalTools(project: string) { const api = useLocalToolsApi();return useQuery({ queryKey: localToolsKey(project), retry: false, queryFn: () => api.project(project) }); }
export function useCompanyLocalTools(enabled: boolean) { const api = useLocalToolsApi();return useQuery({ queryKey: companyLocalToolsKey, enabled, retry: false, queryFn: () => api.company() }); }
