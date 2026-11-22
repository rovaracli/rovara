import { useMemo } from "react";
import { ProjectOverviewProjectSchema, ProjectSetupChecklistSchema } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createReadClient } from "./read-client.js";
export const setupChecklistKey = (project: string) => ["setup-checklist", project] as const;
export function useSetupChecklistReads() {
 const host = useAppHost();
 return useMemo(() => { const api = createReadClient(host);return { status: (name: string) => api.get("/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/setup-status", ProjectSetupChecklistSchema) }; }, [host]);
}
