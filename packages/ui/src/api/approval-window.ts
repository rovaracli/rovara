// The calls of the company's "recent sign-in window" screen (lane exp/approval-window): how recently a person must have signed in to Rovara before they can approve medium-risk work from chat or comments.
// The server decides who may, what a lengthening needs and what a refusal says; this file only sends and reads. Every write is sent once from the browser session (`retry: "never"`).
// A 202 (a lengthening waits for a second admin) is an answer of its own, read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { APPROVAL_WINDOW_PATH, ApprovalWindowAnswerReaderSchema, ApprovalWindowBodySchema, ApprovalWindowStateReaderSchema, type ApprovalWindowBody } from "@agentx/cloud-contracts/web";
import { createApiClient } from "./client.js";

// The shapes come from the server's contract (`packages/cloud-contracts/src/app-approval-window.ts`); they are re-exported here so the screen and the tests keep one import path. Readers ignore unknown fields (forward-compatible); the body is strict.
export { APPROVAL_WINDOW_PATH, ApprovalWindowAnswerReaderSchema, ApprovalWindowBodySchema, ApprovalWindowStateReaderSchema, RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS } from "@agentx/cloud-contracts/web";
export type { ApprovalWindowBody, ApprovalWindowState } from "@agentx/cloud-contracts/web";
/** What the READER returns: the server's `applied` / `needs_approval`, or `unknown` for a status a newer server adds (the screen then says "Saved" and re-reads). */
export type ApprovalWindowAnswer = z.output<typeof ApprovalWindowAnswerReaderSchema>;

const NEVER = { retry: "never" } as const;

export function createApprovalWindowApi(host: AppHost) {
 const api = createApiClient(host);
 const send = (body: ApprovalWindowBody) => api.sendAnswer("POST", APPROVAL_WINDOW_PATH, ApprovalWindowBodySchema.parse(body), ApprovalWindowAnswerReaderSchema, NEVER);
 return {
  state: () => api.get(APPROVAL_WINDOW_PATH, ApprovalWindowStateReaderSchema),
  /** Shorter or equal: applied at once. Longer: a fresh sign-in, then it waits for a second admin (`needs_approval`). */
  set: (expectedRevision: number, seconds: number) => send({ action: "set", expectedRevision, seconds }),
  /** A DIFFERENT admin approves the waiting lengthening; the server asks for a sign-in within the last 10 minutes (`REAUTH_REQUIRED` otherwise) and refuses the proposer. */
  approve: (changeId: string) => send({ action: "approve", changeId }),
  cancel: (changeId: string) => send({ action: "cancel", changeId }),
 };
}
export function useApprovalWindowApi() { const host = useAppHost();return useMemo(() => createApprovalWindowApi(host), [host]); }
export const approvalWindowKey = (orgId: string, developerId: string) => ["admin", "approval-window", orgId, developerId] as const;
export function useApprovalWindow(orgId: string, developerId: string) { const api = useApprovalWindowApi();return useQuery({ queryKey: approvalWindowKey(orgId, developerId), queryFn: () => api.state(), refetchOnWindowFocus: false, retry: false }); }
