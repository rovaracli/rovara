// S3 item 7 (rest): the core's answers to Cloud's task routes (decide, close) for a task the core runs. The stamp of the task decides, with the switch on or off (`CoreTaskRoutes.owns`).
//
//   decide  The web, the API and the AI tools decide through `inbound.clientGate` (never the raw gate: it refuses a chat-slack credential), with the credential the caller presented: the browser
//           session (`caller.sessionId`, which is the review session id the caller was authenticated with) or the developer token the request carried. A caller with neither (a Slack button event,
//           a script token) has no credential to present, so the decision is refused, never made on their behalf. The gate's refusal becomes the AgentX error Cloud's route throws, in the same
//           code (so the same status) and, where Cloud has words for the case, in them (`coreDecisionRefusal`).
//   close   `flow.close`, answered as `DeveloperCloseResponse`. The core's close has no worker preflight for unpublished work (vendor core/task-flow/close.ts says so), so this rule stands in for it and
//           fails closed: a task whose coding step ran and whose candidate is not on an open pull request (the vendor's `candidateIsOnPullRequest`), is not merged and has no succeeded publication is not closed without `discard_unpublished` (Slack's close button sends it: the owner confirmed
//           there). DEFERRED S3-CLOSE-PREFLIGHT.
import { AgentXError, DeveloperTaskCloseRequestSchema, WorkflowDecisionRequestSchema, agentXError, type Principal } from "@rovara-code/contracts";
import type { DeveloperCloseResponse, DeveloperTaskView, WorkflowSnapshot } from "@agentx/cloud-contracts";
import { candidateIsOnPullRequest } from "@rovara-code/broker/core/build-step";
import { RUN_LIMIT_OWNER_DECIDES_WORDS } from "../../approval-place/words.js";
import { parse } from "../../aws/developer-tasks/common.js";
import { CLOSE_REFUSED } from "../../aws/developer-tasks/close.js";
import type { DeveloperCaller } from "../../aws/developer-routes/types.js";
import { taskKey } from "../../developer/task-records.js";
import type { CoreTaskRoutes } from "../../rovara-code/task-routes.js";
import { API_TOKEN_METHOD, BROWSER_SESSION_METHOD, BROWSER_STEP_UP_METHOD } from "../adapters/people/methods.js";
import type { CloudApp } from "./app.js";
import { engineOfStoredTask } from "./engine-stamp.js";
import { SEAT_LIMIT_WORDS } from "./seat-limits.js";

/** The decision subject's kind for a task's plan, requirements or design document (vendor core/decisions/workflow-subject.ts `WORKFLOW_DOCUMENT_KIND`; a test holds this to the vendored source). */
export const WORKFLOW_DOCUMENT_KIND = "workflow-document";

export const NO_CREDENTIAL_WORDS = "This plan is decided from the Rovara app or the task's own Slack card, signed in as the person deciding.";
export const ENGINE_UNAVAILABLE_WORDS = "Rovara could not reach this task's engine just now; try again in a minute.";
export const NOT_YOURS_WORDS = "no task here that you can see";
/** `workflow policy does not allow skipping this stage`: Cloud's words for a skip (`decideWorkflow`'s `WorkflowTransitionError`), which no stage here allows. */
export const SKIP_REFUSED_WORDS = "workflow policy does not allow skipping this stage";

type ReadItem = (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;

export interface CoreTaskRoutesDeps {
  app: CloudApp;
  read: ReadItem;
  /** Lane A6: the person as the core knows them. */
  principalOf: (caller: DeveloperCaller) => Promise<Principal>;
  log: (entry: Record<string, unknown>) => void;
}

const NOT_AN_APPROVER = /^Not approved: (role_not_allowed|collaborator_approvals_off|only the task's owner decides|a project maintainer decides a coding plan only)/u;

function notAnApprover(refusal: { detail: string }, request: { acknowledgedRunLimitUsd?: number | undefined }): AgentXError {
  // A maintainer's seat limit: Cloud says the run limit is the owner's when one was acknowledged, and reads as no task for the rest.
  if (refusal.detail.includes(SEAT_LIMIT_WORDS) && request.acknowledgedRunLimitUsd !== undefined) return agentXError("FORBIDDEN", RUN_LIMIT_OWNER_DECIDES_WORDS);
  return agentXError("TASK_NOT_FOUND", NOT_YOURS_WORDS);
}

/** The AgentX error Cloud's decide route would throw for a gate refusal. `limited`: the decision carried an acknowledged run limit (a maintainer's seat never does, `decide.ts`). */
export function coreDecisionRefusal(refusal: { reason: string; detail: string }, request: { acknowledgedRunLimitUsd?: number | undefined }): AgentXError {
  switch (refusal.reason) {
    case "not_found":
    case "not_the_approver":
      return notAnApprover(refusal, request);
    case "not_approved":
      // The approvers adapter's verdict. A person who may not decide this task (their role, their seat, the requirements document) reads as no task, as in Cloud's route; the rest (the method, the sign-in,
      // the risk) keep the adapter's own words.
      return NOT_AN_APPROVER.test(refusal.detail) ? notAnApprover(refusal, request) : agentXError("FORBIDDEN", refusal.detail);
    case "invalid":
    case "invalid_outcome":
    case "unsupported":
      return agentXError("CONFIG_INVALID", refusal.detail);
    case "not_waiting":
    case "stale":
    case "expired":
    case "request_id_reused":
      return agentXError("IDEMPOTENCY_CONFLICT", refusal.detail);
    default:
      // The method, the sign-in, the approver count, a proof reused: the approvers adapter's own words (Cloud's approval-place sentences).
      return agentXError("FORBIDDEN", refusal.detail);
  }
}

const OUTCOME = { APPROVE: "approve", REJECT: "reject", REQUEST_CHANGES: "request_changes" } as const;

export function createCoreTaskRoutes(deps: CoreTaskRoutesDeps): CoreTaskRoutes {
  const runtimeOf = async (orgId: string) => {
    try {
      return await deps.app.runtimeFor(orgId);
    } catch (error) {
      deps.log({ event: "core_routes.runtime_unavailable", component: "cloud_core", error: error instanceof Error ? error.name : "unknown" });
      throw agentXError("RUNTIME_UNAVAILABLE", ENGINE_UNAVAILABLE_WORDS);
    }
  };
  const notYours = (error: unknown): never => {
    if (error instanceof AgentXError && error.code === "TASK_NOT_FOUND") throw agentXError("TASK_NOT_FOUND", NOT_YOURS_WORDS);
    throw error;
  };
  return {
    async owns(caller, taskId) {
      if (!deps.app.active && !deps.app.serveStamped) return false;
      let engine;
      try {
        engine = await engineOfStoredTask({ get: deps.read as never }, taskId, "flow");
      } catch {
        throw agentXError("RUNTIME_UNAVAILABLE", ENGINE_UNAVAILABLE_WORDS);
      }
      if (engine !== "core") return false;
      const row = await deps.read(taskKey(taskId));
      return row !== undefined && (row["orgId"] ?? row["companyId"]) === caller.orgId;
    },

    async decide({ caller, taskId, value, via, bearer, stepUpCookie, view }) {
      const request = parse(WorkflowDecisionRequestSchema, value, {}, "workflow-decision");
      if (request.decision === "SKIP") throw agentXError("CONFIG_INVALID", SKIP_REFUSED_WORDS);
      // The credential the caller presented. A browser session is the cookie's session id (`caller.sessionId`); a token is the request's own. Nothing else is a credential.
      const credential = caller.browserSession === true
        ? stepUpCookie === undefined ? { method: BROWSER_SESSION_METHOD, token: caller.sessionId } : { method: BROWSER_STEP_UP_METHOD, token: `${caller.sessionId}:${stepUpCookie}` }
        : caller.scriptToken === undefined && bearer !== undefined && bearer !== "" ? { method: API_TOKEN_METHOD, token: bearer } : undefined;
      if (credential === undefined) throw agentXError("FORBIDDEN", NO_CREDENTIAL_WORDS);
      const gate = (await runtimeOf(caller.orgId)).inbound.clientGate;
      if (gate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", ENGINE_UNAVAILABLE_WORDS);
      const details = {
        ...(request.answers === undefined ? {} : { answers: request.answers }),
        ...(request.includedCommentIds === undefined ? {} : { includedCommentIds: request.includedCommentIds }),
        ...(request.selectedOptionalCheckIds === undefined ? {} : { selectedOptionalCheckIds: request.selectedOptionalCheckIds }),
        ...(request.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: request.workBreakdownDigest }),
        ...(request.closeAsAnswered === undefined ? {} : { closeAsAnswered: request.closeAsAnswered }),
        ...(request.acknowledgedRunLimitUsd === undefined ? {} : { acknowledgedRunLimitUsd: request.acknowledgedRunLimitUsd }),
        ...(via === undefined ? {} : { via }),
      };
      const result = await gate.decide({
        companyId: caller.orgId, kind: WORKFLOW_DOCUMENT_KIND, subjectId: taskId, requestId: request.requestId, outcome: OUTCOME[request.decision],
        seen: { revision: request.expectedRevision, artifactDigest: request.artifactDigest! }, credentials: [credential], reason: request.reason, details,
      });
      if (result.status === "refused") throw coreDecisionRefusal(result, request);
      return { task: await view() };
    },

    async close({ caller, taskId, value, view }): Promise<DeveloperCloseResponse> {
      const request = parse(DeveloperTaskCloseRequestSchema, value, {}, "close");
      const runtime = await runtimeOf(caller.orgId);
      const taskCaller = { principal: await deps.principalOf(caller), client: "app" };
      const before = await runtime.flow.get(taskCaller, taskId).catch(notYours);
      if (before.closedAt === undefined && request.discard_unpublished !== true) {
        const workflow = (await deps.read(taskKey(taskId)))?.["workflow"] as WorkflowSnapshot | undefined;
        const coded = before.operations.some((operation) => operation.workflowMode === "IMPLEMENT");
        // Published: the candidate is the code the open pull requests hold now (the vendor's own test, so a commit made after the pull request opened is NOT published), or a pull request merged, or a publish
        // operation succeeded.
        const published = (workflow !== undefined && candidateIsOnPullRequest(workflow)) || (workflow?.pullRequests ?? []).some((pullRequest) => pullRequest.state === "MERGED")
          || before.operations.some((operation) => operation.kind === "publish" && operation.status === "SUCCEEDED");
        if (coded && !published) return { task: await view(), closed: false, message: CLOSE_REFUSED };
      }
      await runtime.flow.close(taskCaller, taskId).catch(notYours);
      const task: DeveloperTaskView = await view();
      return { task, closed: task.status === "CLOSED", ...(task.status === "CLOSED" ? {} : { message: CLOSE_REFUSED }) };
    },
  };
}
