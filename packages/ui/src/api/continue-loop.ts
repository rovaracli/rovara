import { PublishWorkingBranchResultSchema } from "@agentx/cloud-contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
/** What Recheck answers when it starts (`200 { status: "started" }`). Local to the page: the contracts have no reader for it, and this lane changes no contract. */
const RecheckStartedReader = { parse(value: unknown): { status: "started" } { if (typeof value === "object" && value !== null && (value as { status?: unknown }).status === "started") return { status: "started" }; throw new Error("unreadable"); } };
/**
 * The two actions of "Continue in your own tool" (feat/0515-continue-loop; browser session only, a token gets 403): publish the working branch, and Recheck. Both are owner or co-owner and the server checks again.
 * Recheck is sent once and never retried: where the install cannot start a re-check yet, it answers 503 and the page says so.
 */
export function createContinueLoopActions(host: AppHost) {
 const api = createApiClient(host), path = (taskId: string, action: "publish-branch" | "recheck") => "/v1/app/tasks/" + encodeURIComponent(taskId) + "/continue/" + action;
 return {
  publishBranch: (taskId: string, requestId: string, repository: string) => api.sendAnswer("POST", path(taskId, "publish-branch"), { requestId, repository }, PublishWorkingBranchResultSchema),
  recheck: (taskId: string, body: { requestId: string; repository: string; number: number; headSha: string }) => api.sendAnswer("POST", path(taskId, "recheck"), body, RecheckStartedReader, { retry: "never" }),
 };
}
