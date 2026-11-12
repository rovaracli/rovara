// A project's product decisions and the collaborator-approvals switch (lane exp/project-people): `GET|POST /v1/app/projects/{p}/product-decisions[/{id}]` and `GET|PUT .../collaborator-approvals`.
// The server decides who may answer or approve (`you`) and why not (`approveRefusal`); the page only shows that. Writes are browser-only, sent once, under the revision the page read.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { CollaboratorApprovalsSettingSchema, ProductDecisionViewSchema, ProjectOverviewProjectSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

const NEVER = { retry: "never" } as const;
const base = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project));
export const decisionsPath = (project: string): string => base(project) + "/product-decisions";
export const approvalsPath = (project: string): string => base(project) + "/collaborator-approvals";
export const decisionsKey = (project: string) => ["project", project, "product-decisions"] as const;
export const approvalsKey = (project: string) => ["project", project, "collaborator-approvals"] as const;

// Loose readers: the gateway's `requestId` beside the fields is kept, never refused.
const decisionsReader = z.looseObject({ decisions: z.array(ProductDecisionViewSchema) });
const decideReader = z.looseObject({ decision: ProductDecisionViewSchema });
const approvalsReader = z.looseObject({ collaboratorApprovals: CollaboratorApprovalsSettingSchema });
export type DecisionView = z.output<typeof ProductDecisionViewSchema>;
export type ApprovalsSetting = z.output<typeof CollaboratorApprovalsSettingSchema>;

/** The server's 409 `CHANGE_STALE`: someone moved it since the page read it. */
export const isStaleDecision = (error: unknown): boolean => error instanceof ApiError && (error.status === 409 || error.code === "CHANGE_STALE");

export function useProductDecisionsApi() {
  const host = useAppHost();
  return useMemo(() => {
    const api = createApiClient(host);
    const done = async <T,>(sent: ReturnType<typeof api.send<T>>): Promise<T> => { const result = await sent;if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Reload this page to check the change.");return result.value; };
    return {
      list: async (project: string) => (await api.get(decisionsPath(project), decisionsReader)).decisions,
      answer: async (project: string, id: string, input: { requestId: string; expectedRevision: number; text: string }) => (await done(api.send("POST", decisionsPath(project) + "/" + encodeURIComponent(id), { action: "answer", ...input }, decideReader, NEVER))).decision,
      approve: async (project: string, id: string, input: { requestId: string; expectedRevision: number; optionId: string }) => (await done(api.send("POST", decisionsPath(project) + "/" + encodeURIComponent(id), { action: "approve", ...input }, decideReader, NEVER))).decision,
      approvals: async (project: string) => (await api.get(approvalsPath(project), approvalsReader)).collaboratorApprovals,
      setApprovals: async (project: string, input: { requestId: string; enabled: boolean; expectedRevision: number }) => (await done(api.send("PUT", approvalsPath(project), input, approvalsReader, NEVER))).collaboratorApprovals,
    };
  }, [host]);
}
export function useProductDecisions(project: string) { const api = useProductDecisionsApi();return useQuery({ queryKey: decisionsKey(project), queryFn: () => api.list(project), retry: false }); }
export function useCollaboratorApprovals(project: string) { const api = useProductDecisionsApi();return useQuery({ queryKey: approvalsKey(project), queryFn: () => api.approvals(project), retry: false }); }
