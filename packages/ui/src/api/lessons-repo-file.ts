// Lessons in the repo, lane R2: the Lessons tab's "lessons file" rows (GET and POST /v1/app/projects/{p}/lessons/repo). The server decides who may switch a repository on or off and what each row says; this file only sends and
// reads. A write is sent once from the browser session (`retry: "never"`).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LessonsRepoFileBodySchema, LessonsRepoFileRowReaderSchema, LessonsRepoFileStatusReaderSchema, ProjectOverviewProjectSchema, type LessonsRepoFileBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export type LessonsRepoFileStatus = ReturnType<typeof LessonsRepoFileStatusReaderSchema.parse>;
const NEVER = { retry: "never" } as const;
const path = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/lessons/repo";
export const lessonsRepoFileKey = (project: string) => ["lessons", project, "repo-file"] as const;

export function createLessonsRepoFileApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  status: (project: string) => api.get(path(project), LessonsRepoFileStatusReaderSchema),
  act: (project: string, body: LessonsRepoFileBody) => api.sendAnswer("POST", path(project), LessonsRepoFileBodySchema.parse(body), LessonsRepoFileRowReaderSchema, NEVER),
 };
}
export function useLessonsRepoFileApi() { const host = useAppHost();return useMemo(() => createLessonsRepoFileApi(host), [host]); }
export function useLessonsRepoFile(project: string) {
 const api = useLessonsRepoFileApi();
 return useQuery({ queryKey: lessonsRepoFileKey(project), queryFn: () => api.status(project), retry: false });
}
