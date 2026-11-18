// Lead 4 L4-LP3W: the Learned section's browse-by-area, "Where Rovara learns from" and the wiki page's "Team lessons for this area", on Code's answers through Cloud
// (contract v0 `lessons.areas`, `lessons.learningSources.*`, and the wiki route `.../wiki/pages/{id}/lessons`). Code decides who may read and pause; this file asks, reads what came back
// (an answer that is not the shape is "unreadable", never half drawn) and words it. A lesson's text is the team's notes written from tasks and repository text: it is shown as text, never markup.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LearningSourcesAnswerSchema, TeamLessonsAnswerSchema, WIKI_PAGE_ID_PATTERN, type LearningSourcesAnswer, type TeamLessonsAnswer } from "@agentx/contracts/web";
import type { LessonAreaFile, LessonAreaNode, LessonAreaRepo, LessonAreasResponse, LearningSourceKey, PutLearningSourceResponse } from "@agentx/contracts/code-contract-v0";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { learnedKey, readLessons } from "./learned.js";

export type { LearningSourcesAnswer, LessonAreaNode, LessonAreaRepo, LessonAreasResponse, TeamLessonsAnswer };
/** One node of the tree: the whole project (lessons with no area), or a repository (null: lessons naming paths but no repository) and a folder ("" is the repository). */
export type AreaPick = { kind: "whole" } | { kind: "folder"; repo: string | null; folder: string };
const NEVER = { retry: "never" } as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const cnt = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const AREA_DEPTH = 7;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.@-]{1,100}$/u;

function readFiles(raw: unknown): LessonAreaFile[] { return Array.isArray(raw) ? raw.slice(0, 20).flatMap(one => (isRecord(one) && str(one["name"], 100) && SEGMENT.test(one["name"]) ? [{ name: one["name"], lessons: cnt(one["lessons"]) }] : [])) : []; }
function readNode(raw: unknown, depth: number): LessonAreaNode | undefined {
 if (!isRecord(raw) || depth > AREA_DEPTH || !str(raw["name"], 100) || !SEGMENT.test(raw["name"]) || !str(raw["path"], 400) || !raw["path"].endsWith("/")) return undefined;
 const more = cnt(raw["moreChildren"]), moreFiles = cnt(raw["moreFiles"]);
 return { name: raw["name"], path: raw["path"], lessons: cnt(raw["lessons"]), children: readNodes(raw["children"], depth + 1), ...(more > 0 ? { moreChildren: more } : {}), files: readFiles(raw["files"]), ...(moreFiles > 0 ? { moreFiles } : {}) };
}
const readNodes = (raw: unknown, depth: number): LessonAreaNode[] => (Array.isArray(raw) ? raw.slice(0, 40).flatMap(one => { const node = readNode(one, depth); return node === undefined ? [] : [node]; }) : []);

export const AreasReader = { parse(body: unknown): LessonAreasResponse {
 if (!isRecord(body) || !str(body["project"], 100) || !Array.isArray(body["repos"])) throw new Error("not an area tree");
 const repos = body["repos"].slice(0, 30).flatMap((one): LessonAreaRepo[] => {
  if (!isRecord(one) || !(one["repo"] === null || str(one["repo"], 200))) return [];
  const more = cnt(one["moreChildren"]), moreFiles = cnt(one["moreFiles"]);
  return [{ repo: one["repo"], lessons: cnt(one["lessons"]), children: readNodes(one["children"], 1), ...(more > 0 ? { moreChildren: more } : {}), files: readFiles(one["files"]), ...(moreFiles > 0 ? { moreFiles } : {}) }];
 });
 const selection = isRecord(body["selection"]) ? body["selection"] : undefined;
 return {
  project: body["project"], total: cnt(body["total"]), wholeProject: cnt(body["wholeProject"]), repos, ...(body["partial"] === true ? { partial: true as const } : {}),
  ...(selection === undefined ? {} : { selection: { ...(selection["whole"] === true ? { whole: true as const } : { repo: selection["repo"] === null ? null : str(selection["repo"], 200) ? selection["repo"] : null, folder: str(selection["folder"], 400) ? selection["folder"] : "" }), lessons: readLessons(selection["lessons"]), ...(cnt(selection["moreLessons"]) > 0 ? { moreLessons: cnt(selection["moreLessons"]) } : {}) } }),
 };
} };
const PauseReader = { parse(body: unknown): PutLearningSourceResponse {
 if (!isRecord(body) || typeof body["paused"] !== "boolean" || !str(body["project"], 100) || !str(body["key"], 40)) throw new Error("not an answer");
 return { project: body["project"], key: body["key"] as LearningSourceKey, paused: body["paused"] };
} };

const projectPath = (project: string) => "/v1/app/projects/" + encodeURIComponent(project);
export function areasQuery(pick: AreaPick | undefined): string {
 if (pick === undefined) return "";
 if (pick.kind === "whole") return "?whole=1";
 return "?" + new URLSearchParams({ repo: pick.repo ?? "*", ...(pick.folder === "" ? {} : { folder: pick.folder }) }).toString();
}

export function createLearnedAreasApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  areas: (project: string, pick?: AreaPick) => api.get(projectPath(project) + "/lessons/areas" + areasQuery(pick), AreasReader),
  sources: (project: string) => api.get(projectPath(project) + "/lessons/learning-sources", LearningSourcesAnswerSchema),
  async setPaused(project: string, key: LearningSourceKey, paused: boolean) {
   const result = await api.send("PUT", projectPath(project) + "/lessons/learning-sources/" + encodeURIComponent(key), { paused }, PauseReader, NEVER);
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
   return result.value;
  },
  teamLessons: (project: string, pageId: string) => {
   if (!WIKI_PAGE_ID_PATTERN.test(pageId)) throw new ApiError(400, "CONFIG_INVALID", "the request is not valid");
   return api.get(projectPath(project) + "/wiki/pages/" + encodeURIComponent(pageId) + "/lessons", TeamLessonsAnswerSchema);
  },
 };
}
export function useLearnedAreasApi() { const host = useAppHost(); return useMemo(() => createLearnedAreasApi(host), [host]); }

export const areasKey = (project: string) => [...learnedKey(project), "areas"] as const;
/** The tree and, when one node is picked, its lessons. Read once per pick; the section drops it when a lesson is retired or decided. */
export function useLessonAreas(project: string, pick: AreaPick | undefined, enabled = true) {
 const api = useLearnedAreasApi();
 return useQuery({ queryKey: [...areasKey(project), pick === undefined ? "tree" : pick.kind === "whole" ? "whole" : `${pick.repo ?? "*"}:${pick.folder}`], enabled, queryFn: () => api.areas(project, pick), retry: false });
}
export function useLearningSources(project: string, enabled = true) {
 const api = useLearnedAreasApi();
 return useQuery({ queryKey: [...learnedKey(project), "learning-sources"], enabled, queryFn: () => api.sources(project), retry: false });
}
export function useTeamLessons(project: string, pageId: string) {
 const api = useLearnedAreasApi();
 return useQuery({ queryKey: ["wiki", project, "team-lessons", pageId], queryFn: () => api.teamLessons(project, pageId), staleTime: 60_000, retry: false });
}

/** Cloud or Code does not serve a read yet (an older Code, or lessons off for the company): the part is left out, never shown as a failure to retry. */
export const areasAbsent = (error: unknown) => error instanceof ApiError && (error.status === 501 || error.code === "NOT_ON_CODE_YET" || error.code === "LESSONS_SWITCHED_OFF" || (error.status === 404 && error.code !== "INVALID_RESPONSE"));
export const SOURCE_FAILED = "Couldn't change that. Nothing was changed.";
