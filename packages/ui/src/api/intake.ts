// Slice 5 "Outside tools": the project's waiting tickets, its watched tracker sources and its ticket updates settings (`/v1/app/projects/{project}/intake...`). Loaded only with the project's
// tickets section (a lazy chunk) and by Home's Start / Not this one buttons.
import { z } from "zod";
import { IntakeWaitingListSchema, TicketUpdatesViewSchema, type IntakeChannelRef, type TicketUpdatesSettings } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const IntakeStartAnswerSchema = z.object({ started: z.boolean(), taskId: z.string().optional(), sessionId: z.string().optional(), reason: z.string().optional(), state: z.string().optional() }).passthrough();
export type IntakeStartAnswer = z.infer<typeof IntakeStartAnswerSchema>;
const DismissAnswerSchema = z.object({ dismissed: z.literal(true) }).passthrough();
const SourcesAnswerSchema = z.object({ sources: IntakeWaitingListSchema.shape.sources }).passthrough();

const base = (project: string): string => `/v1/app/projects/${encodeURIComponent(project)}/intake`;
/** The path of a ticket's Start or Not this one, only for a well-formed project and item id. */
export const INTAKE_ITEM_PATH = /^\/v1\/app\/projects\/[^/?#]+\/intake\/[a-f0-9]{32}\/(start|dismiss)$/u;

export function createIntakeApi(host: AppHost) {
  const api = createApiClient(host);
  return {
    list: (project: string) => api.get(base(project), IntakeWaitingListSchema),
    updates: (project: string) => api.get(`${base(project)}/updates`, TicketUpdatesViewSchema),
    saveUpdates: (project: string, settings: TicketUpdatesSettings) => api.sendAnswer("PUT", `${base(project)}/updates`, { requestId: crypto.randomUUID(), settings }, TicketUpdatesViewSchema),
    saveSources: (project: string, sources: readonly IntakeChannelRef[]) => api.sendAnswer("PUT", `${base(project)}/sources`, { sources }, SourcesAnswerSchema),
    /** Start or Not this one, at a path the server gave (Home) or built here; any other path is refused before anything is sent. */
    act: async (path: string, action: "start" | "dismiss"): Promise<IntakeStartAnswer | { dismissed: true }> => {
      if (!INTAKE_ITEM_PATH.test(path) || !path.endsWith(`/${action}`)) throw new Error("This action is unavailable.");
      return action === "start" ? api.sendAnswer("POST", path, { requestId: crypto.randomUUID() }, IntakeStartAnswerSchema) : api.sendAnswer("POST", path, { requestId: crypto.randomUUID() }, DismissAnswerSchema);
    },
    itemPath: (project: string, itemId: string, action: "start" | "dismiss") => `${base(project)}/${itemId}/${action}`,
  };
}
