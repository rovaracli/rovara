// The one-time "reviews now use a model from a different company" notice (owner decision 2026-11-02): read by any member, dismissed for the company by an owner or admin. The server decides who may; this file only sends and reads.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReviewDefaultNoticeAnswerReaderSchema, ReviewDefaultNoticeBodySchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const REVIEW_DEFAULT_NOTICE_PATH = "/v1/app/org/review-default-notice";
export const reviewDefaultNoticeKey = ["how-we-work", "review-default-notice"] as const;
export function createReviewDefaultNoticeApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: () => api.get(REVIEW_DEFAULT_NOTICE_PATH, ReviewDefaultNoticeAnswerReaderSchema),
  /** One press, sent once. */
  dismiss: () => api.sendAnswer("POST", REVIEW_DEFAULT_NOTICE_PATH, ReviewDefaultNoticeBodySchema.parse({ action: "dismiss" }), ReviewDefaultNoticeAnswerReaderSchema, { retry: "never" }),
 };
}
export function useReviewDefaultNoticeApi() { const host = useAppHost();return useMemo(() => createReviewDefaultNoticeApi(host), [host]); }
export function useReviewDefaultNotice() { const api = useReviewDefaultNoticeApi();return useQuery({ queryKey: reviewDefaultNoticeKey, queryFn: () => api.read(), refetchOnWindowFocus: false }); }
