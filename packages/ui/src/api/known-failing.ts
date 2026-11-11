// The calls of the known-failing screens (KF-1): a project's marked tests with Undo, and the company setting "always two people". The server decides who may and what a mark means; this file only sends and reads.
// Every write is sent once from the browser session (`retry: "never"`); the policy's 202 (turning it off waits for a different admin) is an answer of its own, so it is read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KnownFailingMarksAnswerReaderSchema, KnownFailingPolicyAnswerReaderSchema, KnownFailingPolicyBodySchema, KnownFailingPolicyStateReaderSchema, KnownFailingUndoAnswerReaderSchema, KnownFailingUndoBodySchema, ProjectOverviewProjectSchema, type KnownFailingUndoBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const KNOWN_FAILING_POLICY_PATH = "/v1/app/org/known-failing-policy";
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
  policy: () => api.get(KNOWN_FAILING_POLICY_PATH, KnownFailingPolicyStateReaderSchema),
  /** Turning "always two people" on applies at once; turning it off waits for a different admin (`needs_approval`). */
  setPolicy: (alwaysTwoPeople: boolean) => api.sendAnswer("POST", KNOWN_FAILING_POLICY_PATH, KnownFailingPolicyBodySchema.parse({ action: "set", alwaysTwoPeople }), KnownFailingPolicyAnswerReaderSchema, NEVER),
  /** A different admin approves turning it off. The server asks for a sign-in within the last 10 minutes (`REAUTH_REQUIRED` otherwise). */
  approvePolicy: (changeId: string) => api.sendAnswer("POST", KNOWN_FAILING_POLICY_PATH, KnownFailingPolicyBodySchema.parse({ action: "approve", changeId }), KnownFailingPolicyAnswerReaderSchema, NEVER),
 };
}
export function useKnownFailingApi() { const host = useAppHost();return useMemo(() => createKnownFailingApi(host), [host]); }
export const knownFailingKey = (project: string) => ["known-failing", project] as const;
export function useKnownFailingMarks(project: string) { const api = useKnownFailingApi();return useQuery({ queryKey: knownFailingKey(project), queryFn: () => api.marks(project), refetchOnWindowFocus: false }); }
export const knownFailingPolicyKey = ["known-failing", "policy"] as const;
export function useKnownFailingPolicy() { const api = useKnownFailingApi();return useQuery({ queryKey: knownFailingPolicyKey, queryFn: () => api.policy(), refetchOnWindowFocus: false }); }
