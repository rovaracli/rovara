import {
  AskAnsweredRequestSchema,
  DiagnosisAnsweredRequestSchema,
  DiagnosisRefSchema,
  DiagnosisTurnResultSchema,
  AskTurnRequestSchema,
  AskTurnResultSchema,
  EvalBatchSlackStartRequestSchema,
  EvalBatchSlackStartResultSchema,
  EvalBatchThreadResultSchema,
  EvalBatchWatchDropRequestSchema,
  EvalBatchWatchDropResultSchema,
  EvalBatchWatchListSchema,
  EvalBatchWatchUpdateRequestSchema,
  EvalBatchWatchUpdateResultSchema,
  type SlackThread,
  SlackCommentAnsweredRequestSchema,
  SlackThreadNoteAnsweredRequestSchema,
  SlackThreadNoteAnsweredResultSchema,
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  ProjectModelOptionsSchema,
  ProjectModelSelectionRequestSchema,
  SwebenchRunSchema,
  SwebenchStartRequestSchema,
  SwebenchStartResultSchema,
  taskResultChecks,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { pollOperation } from "@agentx/orchestrator/event-client";
import type { ThreadServiceApi } from "./processor.js";
import type { EvalBatchWatchApi } from "./eval-batch-watcher.js";
import { threadWorkspaceRequest } from "./thread-workspace-request.js";
import type { AskServiceApi } from "./ask-question.js";
import type { DiagnosisServiceApi } from "./diagnosis-question.js";

/** The Slack service's thread-level control-plane client, moved out of main.ts so tests can drive it. */
/** One request to a /v1/service route; an error answer throws with its code and message. */
async function serviceRequestWith(signedFetch: typeof fetch, url: string, method: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
  const response = await signedFetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = parsed.error as { code?: string; message?: string } | undefined;
    throw new Error(`${failure}: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
  }
  delete parsed.requestId;
  return parsed;
}

/** The broker's Ask routes (`/v1/service/asks/turn` and `…/answered`), signed as the orchestrator role with no Slack thread or member: the Ask names itself. */
export function createAskApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch }): AskServiceApi {
  const post = (path: string, body: unknown, failure: string) => serviceRequestWith(options.signedFetch, `${options.controlPlaneUrl}${path}`, "POST", body, failure);
  return {
    async turn(ref) {
      return AskTurnResultSchema.parse(await post("/v1/asks/turn", AskTurnRequestSchema.parse(ref), "ask context request failed"));
    },
    async answered(request) {
      await post("/v1/asks/answered", AskAnsweredRequestSchema.parse(request), "writing the ask answer failed");
    },
  };
}

/** The broker's diagnosis routes (`/v1/service/diagnoses/turn` and `…/answered`), signed as the orchestrator role with no Slack thread or member: the diagnosis names itself. */
export function createDiagnosisApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch }): DiagnosisServiceApi {
  const post = (path: string, body: unknown, failure: string) => serviceRequestWith(options.signedFetch, `${options.controlPlaneUrl}${path}`, "POST", body, failure);
  return {
    async turn(ref) {
      return DiagnosisTurnResultSchema.parse(await post("/v1/diagnoses/turn", DiagnosisRefSchema.parse(ref), "diagnosis context request failed"));
    },
    async answered(request) {
      await post("/v1/diagnoses/answered", DiagnosisAnsweredRequestSchema.parse(request), "writing the diagnosis answer failed");
    },
  };
}

export function createThreadApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch; pollIntervalMilliseconds?: number }): ThreadServiceApi {
  const { controlPlaneUrl, signedFetch } = options;
  const client = (workspaceId: string) => new ControlPlaneApi(controlPlaneUrl, "slack-service", workspaceId, signedFetch);

  async function servicePost(path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    return serviceRequest("POST", path, body, failure);
  }

  async function serviceRequest(method: string, path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    return serviceRequestWith(signedFetch, `${controlPlaneUrl}${path}`, method, body, failure);
  }

  return {
    async ensureWorkspace(requestId) {
      return SlackThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", threadWorkspaceRequest(requestId), "thread workspace request failed"));
    },
    async taskAnswerWorkspace(requestId, taskId, commentId, noteTs) {
      const taskAnswer = { taskId, ...(commentId === undefined ? {} : { commentId }), ...(noteTs === undefined ? {} : { noteTs }) };
      return SlackThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", { ...threadWorkspaceRequest(requestId), taskAnswer }, "task answer workspace request failed"));
    },
    async markCommentAnswered(input) {
      const body = SlackCommentAnsweredRequestSchema.parse(input);
      await servicePost("/v1/tasks/comments/answered", body, "writing the comment answer failed");
    },
    async markThreadNoteAnswered(input) {
      const body = SlackThreadNoteAnsweredRequestSchema.parse(input);
      try {
        SlackThreadNoteAnsweredResultSchema.parse(await servicePost("/v1/tasks/thread-notes/answered", body, "marking the thread note answered failed"));
      } catch (error) {
        // A broker built before Ask refuses the `ask` field (its body schema is strict): the note must still be marked answered, so the call is made again without it (the Ask is simply not recorded there).
        if (body.ask === undefined || !(error instanceof Error) || !error.message.includes("CONFIG_INVALID")) throw error;
        const { ask: _ask, ...plain } = body;
        void _ask;
        SlackThreadNoteAnsweredResultSchema.parse(await servicePost("/v1/tasks/thread-notes/answered", plain, "marking the thread note answered failed"));
      }
    },
    async prepareWorkspace(requestId) {
      return SlackThreadPrepareResultSchema.parse(await servicePost("/v1/threads/workspace/prepare", { requestId, includeOpenTaskCount: true, includeSharedTask: true }, "thread workspace preparation failed"));
    },
    async startClose(requestId, discardUnpublished = false) {
      return SlackWorkspaceCloseStartResultSchema.parse(await servicePost("/v1/threads/workspace/close", { requestId, includeSharedTask: true, ...(discardUnpublished ? { discard_unpublished: true } : {}) }, "workspace close request failed"));
    },
    async completeClose(requestId, operationId) {
      return SlackWorkspaceCloseCompleteResultSchema.parse(
        await servicePost("/v1/threads/workspace/close/complete", { requestId, operationId }, "workspace close completion failed"),
      );
    },
    async waitForOperation(workspaceId, operationId, signal) {
      const { operation } = await pollOperation(operationId, client(workspaceId), {
        intervalMilliseconds: options.pollIntervalMilliseconds ?? 5_000,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        status: operation.status,
        ...(operation.error === undefined ? {} : { error: operation.error }),
        ...(operation.result === undefined ? {} : { result: operation.result }),
      };
    },
    async taskResult(workspaceId, operationId, signal) {
      // The same wait and final response agentx_task_result gives the model (issue 157).
      const result = await client(workspaceId).taskResult({ workspaceId, operationId }, signal === undefined ? {} : { signal }) as {
        status: string; response?: string; error?: string; checks?: unknown;
      };
      const checks = taskResultChecks(result);
      return {
        status: result.status,
        ...(checks === undefined ? {} : { checks }),
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    async cancelOperation(workspaceId, operationId) {
      const answer = await client(workspaceId).cancelOperation({ workspaceId, operationId });
      // A duplicate names the target, which had already finished; otherwise a cancel was queued.
      return answer.duplicate ? { outcome: "finished", status: answer.status } : { outcome: "requested" };
    },
    async createConversation(workspaceId) {
      return (await client(workspaceId).createConversation()).id;
    },
    async listProjectModels() {
      return ProjectModelOptionsSchema.parse(await serviceRequest("GET", "/v1/project/models", undefined, "project model list failed"));
    },
    async selectProjectModel(model) {
      const body = ProjectModelSelectionRequestSchema.parse(model);
      return ProjectModelOptionsSchema.parse(await serviceRequest("PUT", "/v1/project/model", body, "project model selection failed"));
    },
    async startSwebenchRun(request) {
      const body = SwebenchStartRequestSchema.parse(request);
      return SwebenchStartResultSchema.parse(await servicePost("/v1/evals/swebench", body, "SWE-bench run request failed"));
    },
    async getSwebenchRun(runId) {
      const response = await serviceRequest("GET", `/v1/evals/swebench/${encodeURIComponent(runId)}`, undefined, "SWE-bench run lookup failed");
      return SwebenchRunSchema.parse(response.run);
    },
    async startEvalBatch(request) {
      const body = EvalBatchSlackStartRequestSchema.parse(request);
      return EvalBatchSlackStartResultSchema.parse(await servicePost("/v1/evals/batches", body, "eval batch request failed"));
    },
    async updateEvalBatchWatch(batchId, revision, change) {
      const body = EvalBatchWatchUpdateRequestSchema.parse({ revision, change });
      return EvalBatchWatchUpdateResultSchema.parse(await servicePost(`/v1/evals/batches/${encodeURIComponent(batchId)}/watch`, body, "eval batch watch record failed"));
    },
  };
}

/**
 * Spec 052 Task 6: the batch watcher's client. The list is the Slack service's own; a batch's thread
 * and posts are recorded acting for the batch's thread (a CLI batch's placeholder until its thread
 * is opened) and its requester, so the broker can check the batch is that thread's.
 */
export function createEvalBatchWatchApi(options: {
  controlPlaneUrl: string;
  signedFetchFor: (scope?: { thread: SlackThread; userId: string }) => typeof fetch;
}): EvalBatchWatchApi {
  const { controlPlaneUrl, signedFetchFor } = options;
  const path = (batchId: string, action: string) => `${controlPlaneUrl}/v1/evals/batches/${encodeURIComponent(batchId)}/${action}`;
  return {
    async listBatches() {
      return EvalBatchWatchListSchema.parse(await serviceRequestWith(signedFetchFor(), `${controlPlaneUrl}/v1/evals/batches/active`, "GET", undefined, "eval batch list failed"));
    },
    async dropWatch(batch, reason) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      const body = EvalBatchWatchDropRequestSchema.parse({ reason });
      return EvalBatchWatchDropResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "drop"), "POST", body, "eval batch watch drop failed"));
    },
    async recordThread(batch, threadTs) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      return EvalBatchThreadResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "thread"), "POST", { threadTs }, "eval batch thread record failed"));
    },
    async updateWatch(batch, revision, change) {
      const signed = signedFetchFor({ thread: batch.thread, userId: batch.createdBy.userId });
      const body = EvalBatchWatchUpdateRequestSchema.parse({ revision, change });
      return EvalBatchWatchUpdateResultSchema.parse(await serviceRequestWith(signed, path(batch.batchId, "watch"), "POST", body, "eval batch watch record failed"));
    },
  };
}
