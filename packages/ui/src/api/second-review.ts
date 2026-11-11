// The calls of the second opinion's settings screen (lane cr-settings): the company's mode, the reviewer model and what it sees, the track record, and a lowering that waits for a different admin. The server decides who may and
// what each means; this file only sends and reads. Every write is sent once from the browser session (`retry: "never"`); a 202 (a lowering waits for a different admin) is an answer of its own, read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SecondReviewAnswerReaderSchema, SecondReviewBodySchema, SecondReviewStateReaderSchema, type SecondReviewBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const SECOND_REVIEW_PATH = "/v1/app/org/second-review";
const NEVER = { retry: "never" } as const;

export function createSecondReviewApi(host: AppHost) {
 const api = createApiClient(host);
 const send = (body: SecondReviewBody) => api.sendAnswer("POST", SECOND_REVIEW_PATH, SecondReviewBodySchema.parse(body), SecondReviewAnswerReaderSchema, NEVER);
 return {
  state: () => api.get(SECOND_REVIEW_PATH, SecondReviewStateReaderSchema),
  /** A primary model and an optional backup, in order. */
  choose: (primary: { provider: string; modelId: string }, backup?: { provider: string; modelId: string }) => send({ action: "choose", primary, ...(backup === undefined ? {} : { backup }) }),
  clear: () => send({ action: "clear" }),
  setContext: (context: "change_only" | "same_as_first") => send({ action: "context", context }),
  /** Raising applies at once; lowering is a proposal (`needs_approval`) a different admin approves. */
  setMode: (mode: "off" | "shadow" | "on") => send({ action: "mode", scope: "company", mode }),
  approveMode: (changeId: string) => send({ action: "approve-mode", changeId }),
  cancelMode: (changeId: string) => send({ action: "cancel-mode", changeId }),
  withdraw: (model: { provider: string; modelId: string }) => send({ action: "withdraw", model }),
  /** "I've seen it" for the notice that the reviewer model stopped qualifying. */
  noticeSeen: (key: string) => send({ action: "notice-seen", key }),
  /** The task owner's "I've seen it" for "Second review did not run" (the merge gate). */
  acknowledge: (taskId: string, candidateDigest: string) => api.sendAnswer("POST", "/v1/app/tasks/" + encodeURIComponent(taskId) + "/second-review-acknowledge", { candidateDigest }, { parse: (value: unknown) => value }, NEVER),
 };
}
export function useSecondReviewApi() { const host = useAppHost();return useMemo(() => createSecondReviewApi(host), [host]); }
export const secondReviewKey = ["admin", "second-review"] as const;
export function useSecondReview() { const api = useSecondReviewApi();return useQuery({ queryKey: secondReviewKey, queryFn: () => api.state(), refetchOnWindowFocus: false }); }
