// The calls of the company's "recent sign-in window" screen (lane exp/approval-window): how recently a person must have signed in to Rovara before they can approve medium-risk work from chat or comments.
// The server decides who may, what a lengthening needs and what a refusal says; this file only sends and reads. Every write is sent once from the browser session (`retry: "never"`).
// A 202 (a lengthening waits for a second admin) is an answer of its own, read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

// ---- LOCAL SCHEMAS (replace with `@agentx/cloud-contracts/web` once `packages/cloud-contracts/src/app-approval-window.ts` is on this base) ----
// They match docs section 2 of briefs/approval-place-api.md exactly (ApprovalWindowStateSchema, ApprovalWindowBodySchema, ApprovalWindowAnswerSchema). Readers ignore unknown fields (forward-compatible); the body is strict.
export const RECENT_SIGN_IN_DEFAULT_SECONDS = 86400;
export const RECENT_SIGN_IN_MIN_SECONDS = 3600;
export const RECENT_SIGN_IN_MAX_SECONDS = 604800;
const ApprovalWindowPendingSchema = z.object({ changeId: z.string().min(1).max(200), seconds: z.number().int(), proposedByYou: z.boolean(), expiresAt: z.string().min(1).max(40) });
export const ApprovalWindowStateReaderSchema = z.object({
 revision: z.number().int().nonnegative(), seconds: z.number().int(), isDefault: z.boolean(), defaultSeconds: z.number().int(), minSeconds: z.number().int(), maxSeconds: z.number().int(),
 canChange: z.boolean(), unreadable: z.boolean(), pending: ApprovalWindowPendingSchema.nullish(),
 // Added by the controller after the doc: who last set the window and when. Optional until the server sends them; absent shows today's wording.
 changedBy: z.string().min(1).max(200).nullish(), changedAt: z.string().min(1).max(40).nullish(),
});
export const ApprovalWindowAnswerReaderSchema = z.discriminatedUnion("status", [
 ApprovalWindowStateReaderSchema.extend({ status: z.literal("applied") }),
 ApprovalWindowStateReaderSchema.extend({ status: z.literal("needs_approval"), changeId: z.string().min(1).max(200) }),
]);
export const ApprovalWindowBodySchema = z.discriminatedUnion("action", [
 z.object({ action: z.literal("set"), expectedRevision: z.number().int().nonnegative(), seconds: z.number().int().min(RECENT_SIGN_IN_MIN_SECONDS).max(RECENT_SIGN_IN_MAX_SECONDS) }).strict(),
 z.object({ action: z.literal("approve"), changeId: z.string().min(1).max(200) }).strict(),
 z.object({ action: z.literal("cancel"), changeId: z.string().min(1).max(200) }).strict(),
]);
export type ApprovalWindowState = z.infer<typeof ApprovalWindowStateReaderSchema>;
export type ApprovalWindowAnswer = z.infer<typeof ApprovalWindowAnswerReaderSchema>;
export type ApprovalWindowBody = z.infer<typeof ApprovalWindowBodySchema>;
// ---- END LOCAL SCHEMAS ----

/** The browser reaches the route as `/v1/web/org/approval-window`; the host maps `/v1/app/...` to it, as for the other company settings. */
export const APPROVAL_WINDOW_PATH = "/v1/app/org/approval-window";
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
