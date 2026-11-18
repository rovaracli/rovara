// L4-U5: the "Setup needs repair" card's read and the "Re-check setup" button (Code's hosted setup-check, through Cloud's `setup-repair` routes). Code decides who may; this client only asks. A refusal is shown in
// fixed words (`fixedSetupRepairWords`), never other text. Every answer is read with a strict schema.
import { useMemo } from "react";
import { ProjectOverviewProjectSchema, SETUP_REPAIR_PATHS, SETUP_REPAIR_REFUSALS, SetupRecheckAnswerSchema, SetupRecheckBodySchema, SetupRepairViewSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { SetupRepairView } from "@agentx/contracts/web";

const base = (name: string, tail: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/" + tail;

export function createSetupRepairApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: (project: string) => api.get(base(project, SETUP_REPAIR_PATHS.read), SetupRepairViewSchema),
  recheck: (project: string, requestId: string) => api.sendAnswer("POST", base(project, SETUP_REPAIR_PATHS.recheck), SetupRecheckBodySchema.parse({ requestId }), SetupRecheckAnswerSchema, { retry: "never" }),
 };
}
export function useSetupRepairApi() { const host = useAppHost(); return useMemo(() => createSetupRepairApi(host), [host]); }
export const setupRepairKey = (project: string) => ["setup-repair", project] as const;
/** Cloud says setup repair is not on this Rovara's Code yet (or the project is gone): the page shows no card and no button. */
export const setupRepairAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 501 || error.status === 404);
/** A refusal's words when they are one of the fixed sentences, else the fallback. */
export function fixedSetupRepairWords(error: unknown, fallback: string): string { return error instanceof ApiError && SETUP_REPAIR_REFUSALS.has(error.message) ? error.message : fallback; }
