// Design review (DR-FU4): the calls of the company's How we work card for design review. The server decides who may and what a change is; this file only sends and reads. Every write is sent once from the browser
// session (`retry: "never"`); the 202 (allowing design review waits for a different admin) is an answer of its own, so it is read with `sendAnswer`.
import { useMemo } from "react";
import { DESIGN_REVIEW_COMPANY_PATH, DesignReviewCompanyAnswerReaderSchema, DesignReviewCompanyBodySchema, DesignReviewCompanyStateReaderSchema, type DesignReviewCompanyBody } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;

export function createDesignReviewCompanyApi(host: AppHost) {
 const api = createApiClient(host);
 const send = (body: DesignReviewCompanyBody) => api.sendAnswer("POST", DESIGN_REVIEW_COMPANY_PATH, DesignReviewCompanyBodySchema.parse(body), DesignReviewCompanyAnswerReaderSchema, NEVER);
 return {
  state: () => api.get(DESIGN_REVIEW_COMPANY_PATH, DesignReviewCompanyStateReaderSchema),
  /** The default mode and/or the lock: applied at once. */
  save: (expectedRevision: number, change: Pick<Extract<DesignReviewCompanyBody, { action: "save" }>, "defaultMode" | "lock">) => send({ action: "save", expectedRevision, ...change }),
  /** Not allowing applies at once; allowing waits for a different admin when there is one (`needs_approval`). */
  allow: (expectedRevision: number, allowed: boolean) => send({ action: "allow", expectedRevision, allowed }),
  /** A different admin approves allowing it. The server asks for a sign-in within the last 10 minutes (`REAUTH_REQUIRED` otherwise). */
  approve: (changeId: string) => send({ action: "approve", changeId }),
  /** Withdraws the waiting request (its proposer, or any admin). */
  cancel: (changeId: string) => send({ action: "cancel", changeId }),
 };
}
export function useDesignReviewCompanyApi() { const host = useAppHost();return useMemo(() => createDesignReviewCompanyApi(host), [host]); }
export const designReviewCompanyKey = ["design-review-company"] as const;
