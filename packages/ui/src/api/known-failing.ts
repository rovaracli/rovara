// The calls of the known-failing screens: project marks with exact-version Undo. Every write is sent once from the browser session.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KnownFailingMarksAnswerReaderSchema, KnownFailingUndoAnswerReaderSchema, KnownFailingUndoBodySchema, ProjectOverviewProjectSchema, type KnownFailingUndoBody } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;
const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/known-failing";
/** The mark a press names: everything the server stored with it. */
export type MarkRef = Pick<KnownFailingUndoBody, "name" | "checkId" | "markedBy" | "markedAt" | "epoch">;

export function createKnownFailingApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  marks: (project: string) => api.get(base(project), KnownFailingMarksAnswerReaderSchema),
  /** Removes one mark. A fresh request id per press; the server answers the list afterwards. */
  undo: (project: string, ref: MarkRef) => api.sendAnswer("POST", base(project), KnownFailingUndoBodySchema.parse({ action: "undo", requestId: crypto.randomUUID(), ...ref }), KnownFailingUndoAnswerReaderSchema, NEVER),
 };
}
export function useKnownFailingApi() { const host = useAppHost();return useMemo(() => createKnownFailingApi(host), [host]); }
export const knownFailingKey = (project: string) => ["known-failing", project] as const;
export function useKnownFailingMarks(project: string) { const api = useKnownFailingApi();return useQuery({ queryKey: knownFailingKey(project), queryFn: () => api.marks(project), refetchOnWindowFocus: false }); }
