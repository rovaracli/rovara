import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentIdSchema, HowWeWorkViewReaderSchema, ProjectOverviewProjectSchema, ProjectPlaybookResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

/** What `POST …/playbook/process` answers: the project's process layer (an agent), its draft revision and, once published, its current version. */
export interface ProcessLayer { agentId: string; draftRevision: number; currentVersion?: number }
const ProcessLayerReader = { parse(value: unknown): ProcessLayer {
 const body = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}, agentId = AgentIdSchema.parse(body.agentId), draftRevision = body.draftRevision, currentVersion = body.currentVersion;
 if (typeof draftRevision !== "number" || !Number.isInteger(draftRevision) || draftRevision < 0) throw new Error("Unreadable process layer");
 if (currentVersion !== undefined && (typeof currentVersion !== "number" || !Number.isInteger(currentVersion) || currentVersion < 1)) throw new Error("Unreadable process layer");
 return { agentId, draftRevision, ...(currentVersion === undefined ? {} : { currentVersion }) };
} };

const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project));

/** The "How we work" calls of the project page. Reading and editing the process layer's draft, publishing, versions and rollback use the agent routes (`createBuilderApi`, `createAgentApi`). */
export function createHowWeWorkApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  view: (project: string) => api.get(base(project) + "/how-we-work", HowWeWorkViewReaderSchema),
  /** Makes sure the project has its process layer (idempotent) and answers it. */
  async ensureProcess(project: string): Promise<ProcessLayer> {
   const result = await api.send("POST", base(project) + "/playbook/process", {}, ProcessLayerReader);
   if (result.kind !== "done") throw new Error("Making the process layer needs confirmation");
   return result.value;
  },
  /** Makes the project's saved process layer its default (`PUT …/playbook`), under the playbook revision the page read. */
  async useLayer(project: string, expectedRevision: number, agentId: string): Promise<void> {
   const result = await api.send("PUT", base(project) + "/playbook", { expectedRevision, defaultProcess: { kind: "project_process", agentId } }, ProjectPlaybookResponseReaderSchema);
   if (result.kind !== "done") throw new Error("Choosing the saved version needs confirmation");
  },
 };
}
export function useHowWeWorkApi() { const host = useAppHost();return useMemo(() => createHowWeWorkApi(host), [host]); }
export const howWeWorkKey = (project: string) => ["how-we-work", project] as const;
export function useHowWeWork(project: string) { const api = useHowWeWorkApi();return useQuery({ queryKey: [...howWeWorkKey(project), "view"], queryFn: () => api.view(project) }); }
