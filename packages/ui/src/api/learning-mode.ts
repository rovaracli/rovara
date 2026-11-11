// UX-4b: the project's learning mode (Off, Collect, Suggest, On), read and set on the project page. The record route answers refusals with a flat `{code, message}` body, so this reads its own
// replies (as record-sources.ts does) and keeps only the fixed code. A write is sent once and never retried.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LearningModeViewSchema, ProjectOverviewProjectSchema, type LearningModeView, type LearningModeWriteBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { ApiError } from "./errors.js";
import { lessonsKey } from "./lessons.js";
import { codeOf } from "./record-sources.js";

export const learningModePath = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/record/learning-mode";
export const learningModeKey = (project: string) => [...lessonsKey(project), "learning-mode"] as const;

async function call(host: AppHost, project: string, method: "GET" | "POST", body?: LearningModeWriteBody): Promise<LearningModeView> {
 let response;
 try { response = await host.transport.request({ method, path: learningModePath(project), ...(body === undefined ? {} : { body }), retry: "never" }); }
 catch (error) {
  if (error instanceof ApiError) { if (error.code === "AUTH_REQUIRED") host.signIn(host.currentPath(), { automatic: true }); throw error; }
  throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again.");
 }
 if (response.status === 401) { host.signIn(host.currentPath(), { automatic: true }); throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue."); }
 if (response.status < 200 || response.status >= 300) throw new ApiError(response.status, codeOf(response.body), "Rovara couldn't complete this request.");
 const own = typeof response.body === "object" && response.body !== null ? { ...(response.body as Record<string, unknown>) } : response.body;
 if (typeof own === "object" && own !== null) delete (own as Record<string, unknown>)["requestId"];
 try { return LearningModeViewSchema.parse(own); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); }
}

/** The project's learning mode. A 404 with no code of its own means the team record isn't set up in this installation. */
export function useLearningMode(project: string, enabled = true) {
 const host = useAppHost();
 return useQuery({ queryKey: learningModeKey(project), enabled, retry: false, queryFn: () => call(host, project, "GET") });
}
export function useLearningModeWrite(project: string) {
 const host = useAppHost();
 return useMemo(() => ({ send: (body: LearningModeWriteBody) => call(host, project, "POST", body) }), [host, project]);
}
