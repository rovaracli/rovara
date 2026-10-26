// Rovara Code (Plan 6 Task 16): a task's complete feedback review waiting for a decision, with its report and its comments stored as the broker stores them (every digest and key right), for tests.
import { createHash, randomUUID } from "node:crypto";
import {
  WorkflowFeedbackBundleCommentsSchema, WorkflowFeedbackBundleSchema, WorkflowFeedbackReviewReportSchema, createCandidateManifest, createWorkflowSnapshot, requestWorkflowFeedbackReview,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import type { DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createDeveloperTaskBroker, MAYA } from "./developer-task-broker.js";
import { TEST_ORG } from "./orgs.js";

export const REVIEW_NOW = "2026-10-26T12:00:00.000Z";
const now = REVIEW_NOW;

export interface ReviewOptions { body?: string; finding?: Record<string, unknown>; findingRef?: Record<string, unknown>; tamper?: "report" | "bundle"; extra?: Record<string, unknown> }

/** Stores the review for an existing task of `harness` (its record is replaced by one waiting for the merge with the review pending) and answers the route dependencies a decision reads it with. */
export type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
export interface SeededReview { deps: DeveloperTaskRouteDependencies; stored: () => DeveloperTaskRecord; workflow: WorkflowSnapshot; taskId: string }

export function seedReview(harness: Harness, taskId: string, options: ReviewOptions = {}): SeededReview {
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { ownerKey: string; workspaceId: string };
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "e".repeat(40) }]);
  const body = options.body ?? "Handle empty input";
  const commentRef = { id: "review_comment:1", threadId: "thread-1", kind: "REVIEW_COMMENT" as const, url: "https://github.com/example/demo/pull/42#discussion_r1", author: "maya",
    bodyDigest: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body), updatedAt: now, path: "src/retry.ts", line: 10 };
  const validComment = WorkflowFeedbackBundleCommentsSchema.parse([{ ...commentRef, body }])[0]!;
  const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId: "demo", number: 42, headSha: "c".repeat(40), candidateDigest: candidate.digest, headTreeSha: "e".repeat(40),
    commentSetDigest: createHash("sha256").update(JSON.stringify([validComment])).digest("hex"), producer: "test", version: "1", recordedAt: now, comments: [validComment], sourceDeliveryIds: ["d1"] });
  const bundleBytes = JSON.stringify(bundle);
  const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
  const bundleKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${bundleDigest}.json`;
  harness.s3.objects.set(bundleKey, options.tamper === "bundle" ? `${bundleBytes} ` : bundleBytes);
  const { sourceDeliveryIds: deliveryIds, comments, ...bundleMetadata } = bundle;
  void deliveryIds; void comments;
  const finding = {
    id: "finding-1", bundleDigest, commentIds: ["review_comment:1"], priority: "SHOULD_FIX", assessment: "ACTIONABLE", recommended: true,
    evidence: [{ source: "code", reference: "src/retry.ts:10" }], rationale: "The input is not guarded.", confidence: { level: "HIGH", reason: "The source shows it." }, proposedDisposition: "IMPLEMENT",
    fixProposal: { summary: "Guard the input.", fileChanges: [{ repositoryId: "demo", path: "src/retry.ts", operation: "MODIFY", change: "Return early." }], tests: [] }, ...options.finding,
  };
  const findingRef = { id: "finding-1", bundleDigest, commentIds: ["review_comment:1"], priority: "SHOULD_FIX", assessment: finding.assessment, recommended: finding.recommended, ...options.findingRef };
  const report = WorkflowFeedbackReviewReportSchema.parse({ schemaVersion: 1, taskId, workflowRevision: 2, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY",
    proposalDigest: "b".repeat(64), taskRequirementsDigest: "d".repeat(64),
    candidateBindings: [{ repositoryId: "demo", number: 42, headSha: "c".repeat(40), candidateDigest: candidate.digest, commentSetDigest: bundle.commentSetDigest, bundleDigest }],
    operationId: randomUUID(), provider: "test", version: "1", status: "COMPLETE", bundleDigests: [bundleDigest], findingRefs: [findingRef], findings: [finding], recordedAt: now });
  const reportBytes = JSON.stringify(report);
  const reviewDigest = createHash("sha256").update(reportBytes).digest("hex");
  const reportKey = `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/${reviewDigest}.json`;
  harness.s3.objects.set(reportKey, options.tamper === "report" ? `${reportBytes} ` : reportBytes);
  const { findings, ...reportMetadata } = report;
  void findings;
  const base = createWorkflowSnapshot({ taskId, ownerId: task.ownerKey, now });
  const waiting = { ...base, stage: "WAIT_FOR_MERGE" as const, state: "WAITING" as const, candidate,
    verification: { candidateDigest: candidate.digest, producer: "test", environmentId: "fixture", recordedAt: now, results: [{ checkId: "test", status: "PASS" as const }] },
    reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: now })),
    pullRequests: [{ repositoryId: "demo", number: 42, headSha: "c".repeat(40), url: "https://github.com/example/demo/pull/42", candidateDigest: candidate.digest, required: true, state: "OPEN" as const }],
    ...options.extra };
  const workflow: WorkflowSnapshot = requestWorkflowFeedbackReview(waiting, { bundleRefs: [{ ...bundleMetadata, sha256: bundleDigest, objectKey: bundleKey, comments: [commentRef] }], reviewRef: { ...reportMetadata, sha256: reviewDigest, objectKey: reportKey } }, now);
  harness.db.set({ ...task, workflow });
  const deps = { documentClient: harness.db, tableName: "state", actions: harness.actions, orgId: TEST_ORG,
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [],
    refreshTaskFeedback: async () => undefined, now: () => Date.parse(now) };
  const stored = () => harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord;
  return { deps, stored, workflow, taskId };
}

export async function plannedReview(options: ReviewOptions = {}): Promise<SeededReview & { harness: Harness }> {
  const harness = await createDeveloperTaskBroker({});
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Handle retries", client: "test", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  return { harness, ...seedReview(harness, taskId, options) };
}
