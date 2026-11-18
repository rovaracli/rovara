// Guided onboarding PR 9: the project checklist's one read and its "Set up later" change (Code #841 through Cloud). Code decides every row from real state
// and who may set a row aside; this client only asks. Refusals are shown in the app's fixed words (fixedSetupWords), never other text.
import { useMemo } from "react";
import { ProjectOverviewProjectSchema, ProjectSetupChecklistSchema, ProjectSetupEvalNoneBodySchema, ProjectSetupEvalNoneResponseSchema, ProjectSetupSkipBodySchema, ProjectSetupSkipResponseSchema, SETUP_CHECKLIST_SENTENCES, type SetupSkippableRow } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export function createSetupChecklistApi(host: AppHost) {
 const api = createApiClient(host);
 const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/setup-status";
 return {
  status: (name: string) => api.get(base(name), ProjectSetupChecklistSchema),
  skip: (name: string, row: SetupSkippableRow, skipped: boolean) => api.sendAnswer("PUT", base(name) + "/skips", ProjectSetupSkipBodySchema.parse({ row, skipped }), ProjectSetupSkipResponseSchema, { retry: "never" }),
  // L2-5 c: "this project runs no evals" for the latest finished setup run (true), or take it back (false). Code decides who may (the same people as a skip).
  evalNone: (name: string, noEvals: boolean) => api.sendAnswer("PUT", base(name) + "/eval-none", ProjectSetupEvalNoneBodySchema.parse({ noEvals }), ProjectSetupEvalNoneResponseSchema, { retry: "never" }),
 };
}
export function useSetupChecklistApi() { const host = useAppHost(); return useMemo(() => createSetupChecklistApi(host), [host]); }
export const setupChecklistKey = (project: string) => ["setup-checklist", project] as const;

/** A refusal's words when they are one of Cloud's fixed checklist sentences, else the fallback (never the server's other text). */
export function fixedSetupWords(error: unknown, fallback: string): string {
 return error instanceof ApiError && SETUP_CHECKLIST_SENTENCES.has(error.message) ? error.message : fallback;
}
/** Cloud says the checklist is not on this Rovara's Code yet (or the project is gone): the page shows no checklist at all. */
export const checklistAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 404);
