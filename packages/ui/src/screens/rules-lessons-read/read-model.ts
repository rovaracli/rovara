import { AppMeResponseReaderSchema, HowWeWorkViewReaderSchema, AgentVersionsResponseReaderSchema, StageModelsResponseReaderSchema, WeeklyLessonsReaderSchema, LessonRepeatsReaderSchema, ProjectOverviewProjectSchema, ProjectPlaybookResponseReaderSchema } from "@agentx/contracts/web";
import { createApiClient, type Reader } from "../../api/client.js";
import { SetupRecipesStateReader } from "../../api/setup-recipes.js";
import type { AppHost } from "../../host.js";

export const recipeReader = SetupRecipesStateReader;
const path = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project));
export function createRulesLessonsReads(host: AppHost) {
 const api = createApiClient(host);
 const projectRead = async <T,>(project: string, suffix: string, reader: Reader<T>): Promise<T> => {
  const data = await api.get(path(project) + suffix, reader);
  if (typeof data === "object" && data !== null && "project" in data && data.project !== project) throw new Error("Project changed during read");
  return data;
 };
 return {
  identity: () => api.get("/v1/app/me", AppMeResponseReaderSchema),
  how: (project: string) => projectRead(project, "/how-we-work", HowWeWorkViewReaderSchema),
  playbook: (project: string) => projectRead(project, "/playbook", ProjectPlaybookResponseReaderSchema),
  models: (project: string) => projectRead(project, "/stage-models", StageModelsResponseReaderSchema),
  history: (agentId: string) => api.get("/v1/app/agents/" + encodeURIComponent(agentId) + "/versions", AgentVersionsResponseReaderSchema),
  weekly: (project: string) => projectRead(project, "/lessons/weekly", WeeklyLessonsReaderSchema),
  repeats: (project: string) => projectRead(project, "/lessons/repeats", LessonRepeatsReaderSchema),
  recipes: () => api.get("/v1/app/org/setup-recipes", recipeReader),
 };
}
