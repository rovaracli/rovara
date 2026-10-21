// Spec 025 FR-009, FR-013, FR-014 and FR-016: GET projects, and the project access check the task
// routes use. /v1/dev/* has no API Gateway authorizer (D17): the broker verifies the developer
// access token itself, then checks the environment, the method and the sign-in session on every
// request (R12, R13), so a revoked session stops at once.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXNameSchema,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  DEFAULT_AGENT_ALLOW_DOMAINS,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
  DEVELOPER_TOKEN_AUDIENCE,
  DEVELOPER_WORKSPACES_PER_PROJECT,
  StoredProjectDefinitionSchema,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  TaskPersonProofResponseSchema,
  TaskChannelPeopleResponseSchema,
  TaskPeopleDisplayReadResponseSchema,
  agentXError,
  MEMBER_GRANT_SK_PREFIX,
  PROJECT_REVISION_SK_PREFIX,
  SLACK_BINDING_SK_PREFIX,
  developerTaskPolicy,
  formatCommandLine,
  memberGrantsPk,
  orgProjectCatalogPk,
  workspaceProjectIndexValue,
  projectPk,
  slackBindingPk,
  workspaceRecordFields,
  type AppMeResponse,
  type AppProjectDetail,
  type AppProjectSummary,
  type AppProjectsResponse,
  type ProjectRole,
  type ProjectSetupStatus,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type DeveloperTaskPolicy,
  type DeveloperWorkspace,
  type DeveloperWorkspacesResponse,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  type UnlinkIdentityRequest,
  type UnlinkIdentityResponse,
  type StartIdentityLinkRequest,
  type StartIdentityLinkResponse,
  StartIdentityLinkAppResponseSchema,
  type StartIdentityLinkAppResponse,
  UnlinkableSignInMethodSchema,
  type LinkedIdentity,
  type OrgId,
  type OrgRecord,
  type OrgRole,
  OrgIdSchema,
  OrgRoleSchema,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackChannelBinding,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
} from "@agentx/contracts";
import { accessDeniedMessage, resolveDeveloperAccess } from "../developer/access.js";
import { clearOrgEgress, readEgressDomains, type EgressDomainsDependencies } from "../org/egress-domains.js";
import { updateProjectSettings, type ProjectSettingsDependencies } from "../org/project-settings.js";
import { effectiveProjectRole, readProjectMeta, requireNewWorkAllowed, type ProjectMetaItem } from "../developer/project-roles.js";
import { evaluateProjectAuthority } from "../developer/task-project-access.js";
import { DEFAULT_ROVARA_WEB_ORIGIN, inviteUrl } from "../org/invite-url.js";
import { parseCreateProjectBody, requireAllowedGithubOwner, type CreateProjectInput } from "../org/cloud-projects.js";
import { changeBudgets, ensureSynced, memberLimitOf, type BudgetDependencies, type OrgBudgetSettings } from "../org/budget.js";
import type { ModelAccess } from "../model-proxy/access.js";
import type { OrgStore } from "../org/store.js";
import { checkTaskPersonIdentity, registerTaskChannelPeople, resolveTaskPickerPersonWithId, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../developer/task-person-identity.js";
import { taskPeopleDisplayAdmission, type TaskPeopleDisplayAdmission } from "../developer/task-people-display-budget.js";
import { DeveloperSignInStore, META, endedByAdmin, endedByUnlink, methodSince, startedBeforeMethodOn, type DeveloperMarks, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import {
  createPageComment, decideOnPage, deletePageComment, editPageComment, getTaskDocumentView, getTaskFreshness, getTaskPageState, listPageComments, setPageSuggestion,
  confirmTaskPeopleProposal, getTaskPeople, getTaskPeopleCapabilities, getTaskPeopleProposal, getTaskPeopleProposalMetadata, getTaskPersonPresentationName,
  proposeTaskOwnershipForPage, proposeTaskPeopleRoleForPage,
  getWorkflowFeedbackReview, routeDeveloperTaskRequest, submitWorkflowFeedbackDecision, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { createFeedbackReviewWeb } from "./feedback-review-web.js";
import { TASK_PAGE, TASK_PEOPLE_CONFIRMATION, TASK_STATUS, createTaskWeb } from "./task-web.js";
import { TASK_PAGE_API_PREFIX, createTaskWebApi } from "./task-web-api.js";

export interface DeveloperApiConfiguration {
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean; cloud?: boolean; github?: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: { slack?: number; oidc?: number; cloud?: number; github?: number };
  signInTableName: string;
  /** The hosted Rovara web app's origin, which invite links point at (ROVARA_WEB_ORIGIN); https://rovara.dev when absent. */
  webOrigin?: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** C0: optional until the compatible identity function is deployed; callers must fail closed when absent. */
  taskPersonProof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>;
  taskChannelPeople?: (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse>;
  /** E: one request-scoped, metered proof/list transport. Absence makes the complete People view unavailable. */
  taskPeopleDisplayRead?: (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse>;
  /** D: exact opt-in for role changes; an existing PEOPLE sidecar remains enforced while false. */
  taskPeopleConfiguration?: { peopleChangesEnabled: boolean };
  /** Spec 059: absent is the safe default; production factories intentionally leave graph starts disabled. */
  workflowDependenciesEnabled?: boolean;
  /** C: optional distinct claim-bound invitation endpoint; production leaves it absent until separately configured. */
  inviteTaskPerson?: DeveloperTaskRouteDependencies["inviteTaskPerson"];
  /** R10: bound channels' names and privacy, read by DeveloperIdentity. Optional: without it channels are listed by ID. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** How long one request waits for channel names in all; the rest stay unnamed. Default 5 seconds. */
  channelInfoDeadlineMs?: number;
  /** Spec 025 A12: FR-012's email lookup, for an admin's Slack link. */
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  /** Spec 025 A13: the health route's Slack token check. */
  slackAuthCheck?: () => Promise<SlackAuthCheckResponse>;
  /** Spec 025 E9: an admin ends a developer's sign-in sessions, through DeveloperIdentity (the broker only reads the sign-in table). */
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  /** Plan 2, Task 8: a person unlinks one of their own sign-in methods, through DeveloperIdentity (the broker only reads the sign-in table). */
  unlinkIdentity?: (request: UnlinkIdentityRequest) => Promise<UnlinkIdentityResponse>;
  /** Plan 2, Task 8b: a person starts adding a sign-in method they removed earlier back, through DeveloperIdentity (it owns the sign-in table's writes). */
  startIdentityLink?: (request: StartIdentityLinkRequest) => Promise<StartIdentityLinkResponse>;
  /** Spec 025 E12: a public channel by its name, through DeveloperIdentity. */
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined): Promise<Record<string, unknown>>;
  /** Spec 061 slice 2: the Slack service's request queue, set only with SLACK_REQUEST_QUEUE_URL; "Ask AgentX to reply to this comment" needs it. */
  slackRequestQueue?: SlackRequestQueue;
}
export interface DeveloperRouteDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  developer: DeveloperApiConfiguration;
  now: () => number;
  /** The developer task routes' broker actions; without them /v1/dev/tasks* answers NOT_FOUND. */
  tasks?: DeveloperTaskActions;
  /** Reconciles all already-linked PRs using GitHub's current API state before owner decisions. */
  refreshTaskFeedback?(taskId: string): Promise<void>;
  /** Builds E2E projections only from the task's current server-owned admission and evidence references. */
  workflowE2EPresentation?: DeveloperTaskRouteDependencies["workflowE2EPresentation"];
  workflowE2EPublicationChecks?: DeveloperTaskRouteDependencies["workflowE2EPublicationChecks"];
  registeredRepositoryIdentity?: DeveloperTaskRouteDependencies["registeredRepositoryIdentity"];
  /** Sign in with ChatGPT (#338): each developer's connection; without it /v1/dev/chatgpt/* answers NOT_FOUND. */
  chatgpt?: ChatGptConnections;
  /** Which org a developer belongs to: the membership a token's `org` claim is checked against on every request. */
  orgs?: Pick<OrgStore, "orgForDeveloper" | "getOrg" | "createInvite" | "listMembers" | "setRole" | "removeMember" | "closeOrg">;
  /**
   * What closing an org does besides releasing its GitHub and Slack bindings: archive its projects (Task 20) and clear its egress domains
   * (Task 18). Archiving defaults to nothing until Task 20 supplies it, and egress to `clearOrgEgress`; `POST /v1/app/org/leave` calls them when the last owner leaves.
   */
  closeOrgHooks?: { archiveProjects: (orgId: OrgId) => Promise<void>; clearEgress: (orgId: OrgId) => Promise<void> };
  /** The model proxy, for budgets (ruling R28). Absent without one: budgets are not set up, and task starts are not checked against them. */
  modelAccess?: ModelAccess;
  /** A cloud install (ruling R42): trial lock and machine-time allowance apply to its orgs. */
  cloud?: boolean;
  /**
   * Ruling R55: registers a project in the caller's org and grants the caller access, through the broker's registration. The route has
   * already checked the install, the caller's role and the repository's owner against the org's allowed GitHub owner.
   */
  createProject?: (caller: DeveloperCaller, input: CreateProjectInput, org: Pick<OrgRecord, "githubOwner">) => Promise<{ duplicate: boolean }>;
  /**
   * Plan 2, Task 17: what `PUT /v1/app/projects/{name}/settings` needs from the broker: registering a revision, and (for an added repository)
   * GitHub's view of it. Without it the route answers NOT_FOUND.
   */
  projectSettings?: Pick<ProjectSettingsDependencies<DeveloperCaller>, "registerRevision" | "githubCredentialRef" | "repositoryIdentity" | "requireRepositoryConnected">;
  /**
   * Plan 2, Task 18: pushes the approved domains to the cell's DNS firewall (Task 19's `syncCellAllowList`). Without it an approved change
   * waits for the scheduled sync, and the caller is told it will apply within 5 minutes.
   */
  egressSync?: EgressDomainsDependencies["sync"];
}

/** A route's answer with a status other than 200; the broker's handler writes the status and the body. */
export class StatusReply {
  constructor(readonly statusCode: number, readonly body: object) {}
}
/** Who is asking about a project, and in which org: grants and revisions are read in that org only. */
export type ProjectAccessCaller = ProjectAccessSubject & { orgId: OrgId; orgRole: OrgRole };
export { effectiveProjectRole, requireNewWorkAllowed };
export interface DeveloperCaller { developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string; orgId: OrgId; orgRole: OrgRole }

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
function logDeveloperEvent(entry: Record<string, string>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
async function identityInvoke<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | UnlinkIdentityRequest | StartIdentityLinkRequest | ChannelByNameRequest,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return failed({ reason: "invoke_error", error: errorName(error) });
  }
  if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
  if (response.Payload === undefined) return failed({ reason: "empty_reply" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  } catch {
    return failed({ reason: "unreadable_reply" });
  }
  const reply = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    logDeveloperEvent({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  // Only a code-shaped reply error (such as token_revoked) is logged; never free text.
  return failed({ reason: "reply_error", error: reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) ? reply.error : "malformed_reply" });
}

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members");
}

/** C0: one fresh proof through DeveloperIdentity. Any old or malformed reply fails closed. */
export function taskPersonProofThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskPersonProofResponse | undefined => {
    const parsed = TaskPersonProofResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "ineligible" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    const memberOf = parsed.data.memberOf;
    if (parsed.data.user.id !== request.slackUserId || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return undefined;
    return parsed.data;
  }, "developer.task_person_proof");
}

/** E: complete fresh channel identities through DeveloperIdentity. Partial or malformed replies fail closed. */
export function taskChannelPeopleThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskChannelPeopleResponse | undefined => {
    const parsed = TaskChannelPeopleResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "capacity_exceeded" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    if (new Set(parsed.data.users.map((user) => user.id)).size !== parsed.data.users.length
      || parsed.data.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((channelId) => !requested.has(channelId)))) return undefined;
    return parsed.data;
  }, "developer.task_channel_people");
}

/** E: strict metered display transport. Any missing or malformed usage seals the caller's admission. */
export function taskPeopleDisplayReadThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return async (request) => {
    const failed = (reason: string): never => {
      logDeveloperEvent({ event: "developer.task_people_display_read_failed", reason });
      throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
    };
    let response: ChannelMembersInvokeResult;
    try { response = await invoke(Buffer.from(JSON.stringify(request))); }
    catch (error) { return failed(`invoke_${errorName(error)}`); }
    if (response.FunctionError !== undefined) return failed("function_error");
    if (response.Payload === undefined) return failed("empty_reply");
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8")); }
    catch { return failed("unreadable_reply"); }
    const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.operation !== request.operation
      || parsed.data.admission.slackCallsUsed > request.admission.slackCallsLimit) return failed("malformed_reply");
    if (parsed.data.operation === "proof") {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "proof" ? request.request.channelIds : []);
        if (request.operation !== "proof" || result.user.id !== request.request.slackUserId
          || new Set(result.memberOf).size !== result.memberOf.length || result.memberOf.some((id) => !requested.has(id))) return failed("malformed_reply");
      }
    } else {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "directory" ? request.request.channelIds : []);
        if (request.operation !== "directory" || new Set(result.users.map((user) => user.id)).size !== result.users.length
          || result.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((id) => !requested.has(id)))) return failed("malformed_reply");
      }
    }
    return parsed.data;
  };
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.channelId === "string" && typeof candidate.name === "string" && typeof candidate.isPrivate === "boolean";
};

/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info");
}

/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<SlackAuthCheckResponse> {
  return async () => {
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check" }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}

/**
 * E9: ends a developer's sessions through DeveloperIdentity. A not_found reply is an answer (the
 * developer never signed in), not a failure, so it is neither logged as one nor turned into
 * unavailable (C15). Every other failure is unavailable.
 */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** The words a refusal of the sign-in function carries to the person: short, and nothing the function did not write for them. */
const refusalMessageOf = (reply: Record<string, unknown>): string | undefined =>
  typeof reply.message === "string" && reply.message.length > 0 && reply.message.length <= 200 ? reply.message : undefined;

/**
 * Plan 2, Task 8 and 8b: unlinks a sign-in method through DeveloperIdentity. A refusal (the only way in, or the first sign-in), a sign-in
 * that is not fresh enough or is the method being removed (`reauth`), and a method that is not linked are answers, passed on in the
 * person's words; every other failure is unavailable.
 */
export function unlinkIdentityThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: UnlinkIdentityRequest) => Promise<UnlinkIdentityResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): UnlinkIdentityResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.unlink_identity");
    if (answer.ok || answer.error === "not_found" || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** Plan 2, Task 8b: starts adding a removed sign-in method back through DeveloperIdentity; its answer is the sign-in link, or why not. */
export function startIdentityLinkThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: StartIdentityLinkRequest) => Promise<StartIdentityLinkResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): StartIdentityLinkResponse | undefined => {
      if (reply.ok === true && typeof reply.authorizeUrl === "string" && StartIdentityLinkAppResponseSchema.safeParse({ authorizeUrl: reply.authorizeUrl }).success) return { ok: true, authorizeUrl: reply.authorizeUrl };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.start_identity_link");
    if (answer.ok || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name");
}

/** The broker's copy of each method's enabled-since cutoff (FR-045), from its environment. */
export function developerSinceFromEnvironment(env: NodeJS.ProcessEnv): { slack?: number; oidc?: number } {
  const slack = methodSince(env.DEVELOPER_SIGNIN_SLACK_SINCE);
  const oidc = methodSince(env.DEVELOPER_OIDC_SINCE);
  return { ...(slack === undefined ? {} : { slack }), ...(oidc === undefined ? {} : { oidc }) };
}

/**
 * The sign-in server's public keys, read by invoking the DeveloperIdentity function with its own
 * JWKS route (D17): the broker may not call kms:GetPublicKey, which the key policy keeps to
 * DeveloperIdentity. Any failure throws, and the verifier answers 503 for it.
 */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    logDeveloperEvent({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async () => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      throw failed("invoke_error", { error: errorName(error) });
    }
    if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
    if (response.Payload === undefined) throw failed("empty_reply");
    let keys: unknown;
    try {
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
      if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
      keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
    } catch {
      throw failed("unreadable_reply");
    }
    if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
    return keys as unknown[];
  };
}

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** What a verified developer token names: who, which sign-in, and the org and role the token was issued for. */
export interface DeveloperTokenClaims { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId: OrgId; orgRole: OrgRole }

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): DeveloperTokenClaims {
  if (claims === undefined || claims.iss !== config.issuer || claims.aud !== DEVELOPER_TOKEN_AUDIENCE || claims.env !== config.env) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc" && amr !== "cloud" && amr !== "github") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (config.methods[amr] !== true) {
    throw agentXError("AUTH_REQUIRED", `${amr === "slack" ? "Slack" : amr === "cloud" ? "Cloud" : amr === "github" ? "GitHub" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  // A token with no org (one issued before orgs, or forged) is refused like a token with no session: sign in again.
  const orgId = OrgIdSchema.safeParse(claims.org);
  const orgRole = OrgRoleSchema.safeParse(claims.org_role);
  if (!orgId.success || !orgRole.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return { developerId: claims.sub, sessionId: claims.sid, amr, orgId: orgId.data, orgRole: orgRole.data };
}

async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  return authenticateSession(deps, token);
}

/** A session's identity; `orgId` is present when a token named the org it was issued for, which must still be the developer's. */
async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId?: OrgId }): Promise<DeveloperCaller> {
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "endsAt" | "revokedAt" | "startedAt" | "slackUserId" | "identityKey">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : token.amr === "cloud" ? "cloud sign-in" : token.amr === "github" ? "GitHub sign-in" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt"> & DeveloperMarks>(deps, `DEVELOPER#${token.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
  // Plan 2, Task 8: the person removed this session's sign-in method from their account (the others' sessions go on).
  if (endedByUnlink(session, developer)) {
    throw agentXError("AUTH_REQUIRED", "this sign-in method was removed from your account; run agentx login <url> again");
  }
  // The org is the developer's membership now: a person removed from the org, or moved to another, is refused even
  // while their token is still valid. The role is the current one, so a demotion applies at once.
  const membership = await deps.orgs?.orgForDeveloper(token.developerId);
  if (membership === undefined || (token.orgId !== undefined && membership.orgId !== token.orgId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return {
    developerId: token.developerId,
    sessionId: token.sessionId,
    amr: token.amr,
    orgId: membership.orgId,
    orgRole: membership.role,
    name: developer.displayName,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

/** Rechecks an opaque browser-cookie session against DeveloperIdentity on every page/API request. */
export async function authenticateDeveloperSessionId(deps: DeveloperRouteDependencies, sessionId: string): Promise<DeveloperCaller> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "reviewExpiresAt">>(deps, `SESSION#${sessionId}`);
  if (session === undefined || (session.amr !== "slack" && session.amr !== "oidc" && session.amr !== "cloud" && session.amr !== "github")
    || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  return authenticateSession(deps, { developerId: session.developerId, sessionId, amr: session.amr });
}

/** Every item under `pk` with the sort key prefix, following LastEvaluatedKey through each page. */
async function queryAll<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string): Promise<T[]> {
  const items: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ConsistentRead: true,
    })) as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** Channel names are for display only: they never hold the projects list near a timeout. */
const CHANNEL_NAMES_DEADLINE_MS = 5_000;
const REVISION_READS_AT_ONCE = 8;

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The latest revision's number and task policy: the only fields read, so only they are fetched. */
async function latestDefinition(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ProjectionExpression: "#definition.#revision, #definition.#developerTasks",
    ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  return response.Items?.[0]?.definition;
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, orgId: OrgId, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const unique = [...new Set(names)].sort();
  const definitions = await mapLimit(unique, REVISION_READS_AT_ONCE, (name) => latestDefinition(deps, orgId, name));
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  unique.forEach((name, index) => {
    const definition = definitions[index];
    // developerTaskPolicy fails closed: a policy that no longer parses turns tasks and channel access off.
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  });
  return found;
}

/** The channel-members check, failing closed (and logged by error name) when it throws. */
function safeChannelMembers(deps: DeveloperRouteDependencies): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return async (request) => {
    try {
      return await deps.developer.channelMembers(request);
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
      return SLACK_UNAVAILABLE;
    }
  };
}

/**
 * Channel names and privacy, best effort: without them the channels are listed by ID (R10).
 * Privacy comes from DeveloperIdentity's 10-minute cache. The whole lookup has one deadline.
 */
async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[]): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  const channelInfo = deps.developer.channelInfo;
  if (channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deps.developer.channelInfoDeadlineMs ?? CHANNEL_NAMES_DEADLINE_MS);
  });
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      let answer: ChannelInfoResponse | "deadline";
      try {
        answer = await Promise.race([channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) }), expired]);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
        return names;
      }
      if (answer === "deadline") {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "deadline" });
        return names;
      }
      if (!answer.ok) return names;
      for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/** A private channel is flagged by ID only: its name never leaves the control plane (R10). */
const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

/**
 * FR-013: only `developer` rows are grants. A developer ID is built like an admin owner key, so an
 * admin's `administrator` rows can sit under the same key when both sign in through one IdP.
 */
async function grantsOf(deps: DeveloperRouteDependencies, caller: ProjectAccessCaller): Promise<string[]> {
  return (await queryAll<{ projectName: string; role?: string }>(deps, memberGrantsPk(caller.orgId, caller.developerId), MEMBER_GRANT_SK_PREFIX))
    .filter((membership) => membership.role === "developer")
    .map((membership) => membership.projectName);
}

/** The install's Slack team's channel bindings inside one org. */
async function bindingsOf(deps: DeveloperRouteDependencies, orgId: OrgId): Promise<SlackChannelBinding[]> {
  return deps.developer.slackTeamId === undefined ? [] : queryAll<SlackChannelBinding>(deps, slackBindingPk(orgId, deps.developer.slackTeamId), SLACK_BINDING_SK_PREFIX);
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grants = await grantsOf(deps, caller);
  const bindings = await bindingsOf(deps, caller.orgId);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const listed = [...access.projects].filter(([name]) => policies.has(name));
  // Like checkProjectAccess: a caller with no Slack link is never shown channel names.
  const names = caller.slackUserId === undefined ? new Map<string, { name: string; isPrivate: boolean }>() : await channelNames(deps, listed.flatMap(([, entry]) => entry.channels));
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of listed) {
    const known = policies.get(name)!;
    projects.push({ name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr, orgRole: caller.orgRole,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

type StoredProject = z.infer<typeof StoredProjectDefinitionSchema>;

/** A project's latest revision as stored, with who registered it and when; undefined when it has none or the revision no longer parses. */
async function latestProjectRecord(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ definition: StoredProject; registeredBy: string; registeredAt: string } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition?: unknown; registeredBy?: unknown; registeredAt?: unknown }> };
  const item = response.Items?.[0];
  if (item === undefined) return undefined;
  const definition = StoredProjectDefinitionSchema.safeParse(item.definition);
  if (!definition.success) {
    logDeveloperEvent({ event: "developer.project_unreadable", project, reason: definition.error.issues[0]?.message ?? "invalid" });
    return undefined;
  }
  return { definition: definition.data, registeredBy: typeof item.registeredBy === "string" ? item.registeredBy : "unknown", registeredAt: typeof item.registeredAt === "string" ? item.registeredAt : "" };
}

/** GitHub's spelling of a repository, `owner/name`, from its URL; the repository's own name when the URL is no GitHub path. */
function repositoryFullName(repository: { name: string; url: string }): string {
  try {
    const parts = new URL(repository.url).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length === 2) return parts.join("/");
  } catch { /* fall through to the name */ }
  return repository.name;
}

/** The setup status, derived on every read from the project's META and the check's workspace (Plan 2, Task 22 writes `setupCheck`). */
async function setupStateOf(deps: DeveloperRouteDependencies, meta: ProjectMetaItem | undefined, latestRevision: number): Promise<AppProjectSummary["setup"]> {
  const check = meta?.setupCheck;
  if (check === undefined) return { status: "unchecked" };
  const checked = { checkedRevision: check.revision, checkedAt: check.startedAt };
  if (check.revision < latestRevision) return { status: "outdated", ...checked };
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `WORKSPACE#${check.workspaceId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { status?: string } };
  const workspace = response.Item?.status;
  if (workspace === undefined) return { status: "unchecked" };
  const status: ProjectSetupStatus = workspace === "PREPARING" ? "checking" : workspace === "PREPARATION_FAILED" ? "failed" : "ready";
  return { status, ...checked };
}

async function appProjectSummary(
  deps: DeveloperRouteDependencies,
  name: string,
  role: ProjectRole,
  record: NonNullable<Awaited<ReturnType<typeof latestProjectRecord>>>,
  meta: ProjectMetaItem | undefined,
): Promise<AppProjectSummary> {
  const { definition } = record;
  return {
    name,
    ...(meta?.description === undefined ? {} : { description: meta.description }),
    status: meta?.status ?? "active",
    latestRevision: definition.revision,
    repositories: definition.repositories.map((repository) => ({ fullName: repositoryFullName(repository), defaultBranch: repository.defaultBranch })),
    myRole: role,
    setup: await setupStateOf(deps, meta, definition.revision),
  };
}

/**
 * The projects the caller may see in the app and their role in each. Org owners and admins see every project in the org's own
 * catalog, as maintainers. Anyone else sees what a grant or channel access gives, as listProjects resolves it: contributors. Every
 * read is keyed by `caller.orgId`, so another org's project of the same name is never reached. With `only`, just that name.
 */
async function visibleProjectRoles(deps: DeveloperRouteDependencies, caller: DeveloperCaller, only?: string): Promise<Map<string, ProjectRole>> {
  const roles = new Map<string, ProjectRole>();
  if (caller.orgRole === "owner" || caller.orgRole === "admin") {
    const names = only !== undefined ? [only]
      : (await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#")).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : []));
    for (const name of names) roles.set(name, effectiveProjectRole(caller, undefined, false)!);
    return roles;
  }
  const grants = (await grantsOf(deps, caller)).filter((name) => only === undefined || name === only);
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => only === undefined || binding.projectName === only);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants, bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  for (const [name, entry] of access.projects) {
    const role = effectiveProjectRole(caller, entry.access === "granted" ? { role: "developer" } : undefined, entry.access === "channel");
    if (role !== undefined && policies.has(name)) roles.set(name, role);
  }
  return roles;
}

/** `GET /v1/app/projects`: the caller's projects, sorted by name. Archived ones only with `?include=archived`. */
async function listAppProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller, includeArchived: boolean): Promise<AppProjectsResponse> {
  const roles = await visibleProjectRoles(deps, caller);
  const names = [...roles.keys()].sort();
  const built = await mapLimit(names, REVISION_READS_AT_ONCE, async (name) => {
    const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
    // A catalog entry with no readable revision is not a project the app can show.
    if (record === undefined || (meta?.status === "archived" && !includeArchived)) return undefined;
    return appProjectSummary(deps, name, roles.get(name)!, record, meta);
  });
  return { projects: built.filter((project): project is AppProjectSummary => project !== undefined) };
}

const PROJECT_NOT_FOUND_IN_APP = "project not found";

/** Where egress items are kept and how a change reaches the firewall (Plan 2, Task 18). */
function egressDepsOf(deps: DeveloperRouteDependencies): EgressDomainsDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, cloud: deps.cloud === true, now: () => new Date(deps.now()), sync: deps.egressSync ?? (async () => ({ ok: false })) };
}

/** `GET /v1/app/projects/{name}`: no access, no such project and another org's project all answer the same 404 PROJECT_NOT_FOUND. */
async function getAppProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<AppProjectDetail> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw notFound();
  const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
  if (record === undefined) throw notFound();
  const { definition } = record;
  const createdBy = meta?.createdBy ?? "unknown";
  const creator = createdBy === "unknown" ? undefined : await signInStoreOf(deps).getDeveloper(createdBy);
  const egress = await readEgressDomains(deps, caller.orgId, { kind: "project", project: name });
  return {
    ...await appProjectSummary(deps, name, role, record, meta),
    settings: {
      setupCommands: definition.setup.map(formatCommandLine),
      testCommands: definition.readiness.map(formatCommandLine),
      devcontainer: definition.devcontainer === undefined ? null
        : { repository: definition.devcontainer.repository, configPath: definition.devcontainer.configPath ?? DEFAULT_DEVCONTAINER_CONFIG_PATH },
      // A domain every project has is approved. Any other is as its egress item says; one the item does not list was never asked for (a
      // project that stored it before approvals existed), so on cloud it serves nothing and reads as pending until the next save asks.
      allowedDomains: (definition.network?.allowedDomains ?? []).map((domain) => {
        if (DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)) return { domain, status: "approved" as const };
        const entry = egress?.domains.find((candidate) => candidate.domain === domain);
        if (entry === undefined) return { domain, status: deps.cloud === true ? "pending" as const : "approved" as const };
        return { domain, status: entry.status, ...(entry.status === "rejected" && entry.reason !== undefined ? { reason: entry.reason } : {}) };
      }),
    },
    createdAt: meta?.createdAt ?? record.registeredAt,
    createdBy: { developerId: createdBy, name: creator?.displayName ?? "Unknown" },
  };
}

/** `PUT /v1/app/projects/{name}/settings` (Plan 2, Task 17): a maintainer's change to the project's settings, as a new revision. */
async function putProjectSettings(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  if (deps.projectSettings === undefined) throw agentXError("NOT_FOUND", "project settings are not set up in this deployment");
  return updateProjectSettings({
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    cloud: deps.cloud === true,
    egress: egressDepsOf(deps),
    ...deps.projectSettings,
    effectiveRole: async (who, project) => (await visibleProjectRoles(deps, who, project)).get(project),
    readProject: (who, project) => getAppProject(deps, who, project),
  }, caller, name, body);
}

/**
 * FR-018's first three checks, in order, for one project; the start route calls it (Task 8), and
 * every route must call it before a DeveloperTaskActions member that trusts its caller.
 * PROJECT_NOT_FOUND, then PROJECT_ACCESS_DENIED (naming only public bound channels, R10), or
 * SLACK_UNAVAILABLE when only a channel could have given access and Slack is down, then
 * PROJECT_TASKS_DISABLED.
 */
export async function checkProjectAccess(
  deps: DeveloperRouteDependencies,
  caller: ProjectAccessCaller,
  project: string,
  membership?: { freshMemberOf: readonly string[] },
): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; role: ProjectRole }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const known = (await projectsWithPolicy(deps, caller.orgId, [project])).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  const grants = (await grantsOf(deps, caller)).filter((name) => name === project);
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => binding.projectName === project);
  // An org owner or admin counts as granted on every project in their org, with no grant (Plan 2, Task 11, I4). A project of another org
  // is never reached: `known` and every row read above are this org's.
  const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
  const projectMemberships = grants.length > 0 || orgMaintainer ? [{ projectName: project, role: "developer" }] : [];
  const evaluate = (freshMemberOf?: readonly string[]) => evaluateProjectAuthority({
    project,
    revision: { revision: known.revision, definition: { developerTasks: known.policy } },
    memberships: projectMemberships,
    bindings,
    ...(freshMemberOf === undefined ? {} : { freshMemberOf }),
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  });
  let result = evaluate(membership?.freshMemberOf);
  if (result.kind === "needs-membership") {
    const memberOf = new Set<string>();
    for (let start = 0; start < result.channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const response = await safeChannelMembers(deps)({
        kind: "channel-members", slackUserId: caller.slackUserId!, channelIds: result.channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS),
      });
      if (!response.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
      for (const channelId of response.memberOf) memberOf.add(channelId);
    }
    result = evaluate([...memberOf]);
  }
  if (result.kind === "unavailable") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  if (result.kind === "needs-membership") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "denied") {
    if (result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
    // Only a channel that would give access is worth naming, and only a public one (R10).
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, result.visibleChannelIds)).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  // This function never refuses an archived project or a viewer: those refusals are requireNewWorkAllowed's, at the places new work
  // starts, because the E2E rechecks of a running task's creator also come through here.
  const role = effectiveProjectRole(caller, grants.length > 0 ? { role: "developer" } : undefined, result.access === "channel");
  if (role === undefined) throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, []));
  return { revision: result.revision, policy: result.policy, access: result.access, channelIds: result.channelIds, role };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = items.length >= DEVELOPER_WORKSPACES_PER_PROJECT ? undefined : response.LastEvaluatedKey;
  } while (start !== undefined);

  const workspaces: DeveloperWorkspace[] = [];
  for (const item of items.slice(0, DEVELOPER_WORKSPACES_PER_PROJECT)) {
    const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
    // A record this release cannot read is left out rather than failing the whole listing.
    if (!parsed.success) {
      logDeveloperEvent({ event: "developer.workspace_unreadable", project, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    const workspace = parsed.data;
    workspaces.push({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      status: workspace.status,
      busy: workspace.activeOperationId !== null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
  return workspaces;
}

/**
 * FR-001: the projects the caller may use, with the workspaces in each of them. The projects come
 * from listProjects itself, so this route applies exactly the same access rules (grants, and channel
 * membership only where the project's developerTasks policy allows it, failing closed).
 */
async function listWorkspaces(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperWorkspacesResponse> {
  const listing = await listProjects(deps, caller);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, caller.orgId, project.name));
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
}

export function developerTaskRouteDependencies(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string },
  trustedCaller: DeveloperCaller | null = caller,
): DeveloperTaskRouteDependencies {
  const projectChannelIds = async (project: string) => (await bindingsOf(deps, caller.orgId))
    .filter((binding) => binding.projectName === project)
    .map((binding) => binding.channelId)
    .sort();
  const identityDependencies = (admission?: TaskPeopleDisplayAdmission): TaskPersonIdentityDependencies => {
    const slackTeamId = deps.developer.slackTeamId;
    const taskPersonProof = admission?.proof.bind(admission) ?? deps.developer.taskPersonProof;
    if (slackTeamId === undefined || taskPersonProof === undefined) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    return {
      documentClient: deps.documentClient, tableName: deps.tableName, slackTeamId, now: deps.now, uuid: randomUUID, taskPersonProof,
      developerRecord: async (targetDeveloperId) => {
        const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk: `DEVELOPER#${targetDeveloperId}`, sk: META }, ConsistentRead: true })) as { Item?: DeveloperRecord };
        return response.Item;
      },
      projectChannelIds,
      targetProjectAccess: async (subject, project, freshMemberOf) => {
        const revision = await latestDefinition(deps, caller.orgId, project);
        if (revision === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        const [memberships, allBindings] = await Promise.all([
          queryAll<{ projectName: string; role?: string }>(deps, memberGrantsPk(caller.orgId, subject.developerId), MEMBER_GRANT_SK_PREFIX),
          bindingsOf(deps, caller.orgId),
        ]);
        const result = evaluateProjectAuthority({
          project,
          revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } },
          memberships,
          bindings: allBindings,
          freshMemberOf,
          ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        });
        if (result.kind === "allowed") return;
        if (result.kind === "unavailable" || result.kind === "needs-membership") {
          throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
        }
        if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        if (result.kind === "denied" && result.reason === "tasks-disabled") {
          throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
        }
        // System qualification has no channel-name lookup or human-facing error decoration.
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      },
      ...(trustedCaller === null ? {} : { trustedCaller }),
    };
  };
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    orgId: caller.orgId,
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    issuer: deps.developer.issuer,
    actions: deps.tasks!,
    ...(deps.modelAccess === undefined ? {} : { modelAccess: deps.modelAccess }),
    ...(deps.cloud === true ? { cloud: true } : {}),
    ...(deps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: deps.workflowE2EPresentation }),
    ...(deps.workflowE2EPublicationChecks === undefined ? {} : { workflowE2EPublicationChecks: deps.workflowE2EPublicationChecks }),
    ...(deps.registeredRepositoryIdentity === undefined ? {} : { registeredRepositoryIdentity: deps.registeredRepositoryIdentity }),
    ...(deps.developer.taskPeopleConfiguration === undefined ? {} : { taskPeopleConfiguration: deps.developer.taskPeopleConfiguration }),
    ...(deps.developer.workflowDependenciesEnabled === undefined ? {} : { workflowDependenciesEnabled: deps.developer.workflowDependenciesEnabled }),
    checkTaskPerson: async (task, developerId, admission) => {
      return checkTaskPersonIdentity(identityDependencies(admission), task, developerId);
    },
    resolveTaskPickerPerson: async (taskId, slackUserId) => {
      const dependencies = identityDependencies();
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      if (response.Item === undefined) throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      const task = response.Item;
      const resolved = await resolveTaskPickerPersonWithId(dependencies, task, slackUserId);
      const proof = await checkTaskPersonIdentity(dependencies, task, resolved.identity.developerId);
      if (!proof.eligible || proof.identity.developerId !== resolved.identity.developerId || proof.identity.slackUserId !== resolved.identity.slackUserId) {
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      }
      return { personId: resolved.personId, developerId: resolved.identity.developerId, slackUserId: resolved.identity.slackUserId, channelMember: proof.channelMember };
    },
    taskPeopleChannel: async (taskId) => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      const share = response.Item?.share;
      if (share === undefined || typeof share.teamId !== "string" || typeof share.channelId !== "string" || typeof share.threadTs !== "string") {
        throw agentXError("PROJECT_ACCESS_DENIED", "task channel could not be verified");
      }
      return { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
    },
    ...(deps.developer.inviteTaskPerson === undefined ? {} : { inviteTaskPerson: deps.developer.inviteTaskPerson }),
    ...(deps.developer.taskPeopleDisplayRead === undefined ? {} : {
      createTaskPeopleDisplayAdmission: () => taskPeopleDisplayAdmission({ now: deps.now, read: deps.developer.taskPeopleDisplayRead! }),
      listTaskPeople: async (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => {
      const channels = [...new Set([...(await projectChannelIds(task.project)), ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
      admission.assertOpen();
      const answer = await admission.directory({ kind: "task-channel-people", channelIds: channels });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
      admission.assertOpen();
      const identities = await registerTaskChannelPeople(identityDependencies(admission), task, answer.users, () => admission.assertOpen());
      admission.assertOpen();
      const bySlack = new Map(answer.users.map((user) => [user.id, user]));
      return identities.map((identity) => {
        const user = bySlack.get(identity.slackUserId);
        if (user === undefined) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
        return { subject: { developerId: identity.developerId, slackUserId: identity.slackUserId }, identity, eligible: true,
          channelMember: task.share === undefined || user.memberOf.includes(task.share.channelId) };
      });
      },
    }),
    ...(deps.refreshTaskFeedback === undefined ? {} : { refreshTaskFeedback: deps.refreshTaskFeedback.bind(deps) }),
    ...(initialSlackThread === undefined ? {} : { initialSlackThread }),
    checkAccess: (project) => checkProjectAccess(deps, caller, project),
    channelMember: async (slackUserId, channelId) => {
      const answer = await safeChannelMembers(deps)({ kind: "channel-members", slackUserId, channelIds: [channelId] });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your membership of that channel; try again shortly");
      return answer.memberOf.includes(channelId);
    },
    projectChannelIds,
    ...(deps.developer.slackRequestQueue === undefined ? {} : { slackRequestQueue: deps.developer.slackRequestQueue }),
    ...(deps.developer.channelInfo === undefined ? {} : {
      boundChannels: async (channelIds: readonly string[]) => {
        const known = await channelNames(deps, channelIds);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
    }),
    now: deps.now,
  };
}

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname.startsWith("/review/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    const authenticateSession = async (sessionId: string) => {
      try { return await authenticateDeveloperSessionId(deps, sessionId); }
      catch { return undefined; }
    };
    // Task 18: the read-only task page and its "moved on" check; every other /review/ path is the PR-feedback review.
    // Spec 061 slice 2: the page's JSON API is matched here too, so the PR-feedback page never sees its paths.
    if (TASK_PAGE.test(url.pathname) || TASK_PEOPLE_CONFIRMATION.test(url.pathname) || TASK_STATUS.test(url.pathname) || TASK_PAGE_API_PREFIX.test(url.pathname)) {
      const routeDeps = (caller: DeveloperCaller) => developerTaskRouteDependencies(deps, caller);
      return createTaskWeb({
        authenticateSession,
        getTaskDocumentView: (caller, taskId) => getTaskDocumentView(routeDeps(caller), caller, taskId),
        getTaskFreshness: (caller, taskId) => getTaskFreshness(routeDeps(caller), caller, taskId),
        getTaskPeople: (caller, taskId) => getTaskPeople(routeDeps(caller), caller, taskId),
        getTaskPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        getTaskPeopleProposalMetadata: (caller, taskId, requestId) => getTaskPeopleProposalMetadata(routeDeps(caller), caller, taskId, requestId),
        getTaskPersonName: (caller, taskId, personId) => getTaskPersonPresentationName(routeDeps(caller), taskId, personId),
        getTaskPeopleCapabilities: (caller, taskId) => getTaskPeopleCapabilities(routeDeps(caller), caller, taskId),
        api: createTaskWebApi({
          origin: deps.developer.issuer,
          authenticateSession,
          taskState: (caller, taskId) => getTaskPageState(routeDeps(caller), caller, taskId),
          listComments: (caller, taskId) => listPageComments(routeDeps(caller), caller, taskId),
          createComment: (caller, taskId, input) => createPageComment(routeDeps(caller), caller, taskId, input),
          editComment: (caller, taskId, input) => editPageComment(routeDeps(caller), caller, taskId, input),
          deleteComment: (caller, taskId, input) => deletePageComment(routeDeps(caller), caller, taskId, input),
          setSuggestion: (caller, taskId, input) => setPageSuggestion(routeDeps(caller), caller, taskId, input),
          decide: (caller, taskId, input) => decideOnPage(routeDeps(caller), caller, taskId, input),
          getPeople: (caller, taskId) => getTaskPeople(routeDeps(caller), caller, taskId),
          proposePeopleRole: (caller, taskId, input) => proposeTaskPeopleRoleForPage(routeDeps(caller), caller, taskId, input),
          proposeOwnership: (caller, taskId, input) => proposeTaskOwnershipForPage(routeDeps(caller), caller, taskId, input),
          getPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
          confirmPeopleRequest: (caller, taskId, requestId) => confirmTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        }),
      })(request, url);
    }
    const web = createFeedbackReviewWeb({
      origin: new URL(deps.developer.issuer).origin,
      authenticateSession,
      getWorkflowFeedbackReview: (caller, taskId) => getWorkflowFeedbackReview(developerTaskRouteDependencies(deps, caller), caller, taskId),
      submitWorkflowFeedbackDecision: (caller, taskId, input) => submitWorkflowFeedbackDecision(developerTaskRouteDependencies(deps, caller), caller, taskId, input),
      now: deps.now,
    });
    return web(request, url);
  }
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(request.headers.authorization));
  if (request.method === "GET" && url.pathname === "/v1/app/me") return getAppMe(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/projects") return listAppProjects(deps, caller, url.searchParams.get("include") === "archived");
  const appProject = /^\/v1\/app\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && appProject !== null) return getAppProject(deps, caller, appProject[1]!);
  const projectSettingsRoute = /^\/v1\/app\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (request.method === "PUT" && projectSettingsRoute !== null) return putProjectSettings(deps, caller, projectSettingsRoute[1]!, jsonBody(request));
  if (request.method === "POST" && url.pathname === "/v1/dev/projects") return createProject(deps, caller, jsonBody(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (request.method === "GET" && (url.pathname === "/v1/dev/org" || url.pathname === "/v1/app/org")) return getOrganization(deps, caller);
  if (request.method === "POST" && (url.pathname === "/v1/dev/org/invites" || url.pathname === "/v1/app/org/invites")) return createOrganizationInvite(deps, caller, jsonBody(request));
  if (request.method === "GET" && url.pathname === "/v1/app/org/members") return listOrganizationMembers(deps, caller);
  if (request.method === "POST" && url.pathname === "/v1/app/org/leave") return leaveOrganization(deps, caller, jsonBody(request));
  const identityRoute = /^\/v1\/app\/me\/identities\/([a-z]{1,16})$/.exec(url.pathname);
  if (identityRoute !== null && request.method === "DELETE") return unlinkAppIdentity(deps, caller, identityRoute[1]!);
  if (identityRoute !== null && request.method === "POST") return startAppIdentityLink(deps, caller, identityRoute[1]!);
  const memberRoute = /^\/v1\/app\/org\/members\/([a-f0-9]{64})(\/role)?$/.exec(url.pathname);
  if (memberRoute !== null && request.method === "PUT" && memberRoute[2] !== undefined) return changeMemberRole(deps, caller, memberRoute[1]!, jsonBody(request));
  if (memberRoute !== null && request.method === "DELETE" && memberRoute[2] === undefined) return removeOrganizationMember(deps, caller, memberRoute[1]!);
  if (request.method === "GET" && url.pathname === "/v1/dev/budget") return getBudget(deps, caller);
  if (request.method === "PUT" && url.pathname === "/v1/dev/org/budget") return putOrganizationBudget(deps, caller, jsonBody(request));
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    return routeDeveloperTaskRequest(developerTaskRouteDependencies(deps, caller), caller, request, url);
  }
  if (url.pathname === CHATGPT_CONNECTION_PATH || url.pathname === `${CHATGPT_CONNECTION_PATH}/finish`) {
    return routeChatGptConnection(deps, caller, request, url);
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/**
 * Ruling R55: an owner or admin of a cloud org creates a project from a repository under the org's allowed GitHub owner, which only an
 * operator sets. Any other install registers projects through an administrator.
 */
async function createProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<StatusReply> {
  if (deps.cloud !== true) throw agentXError("FORBIDDEN", "projects on this install are created by an administrator; ask an administrator to run agentx project add");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can create a project; ask your organization's owner");
  if (deps.orgs === undefined || deps.createProject === undefined) throw agentXError("NOT_FOUND", "project creation is not set up in this deployment");
  const input = parseCreateProjectBody(body);
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  requireAllowedGithubOwner(org, input.owner);
  const created = await deps.createProject(caller, input, org);
  return new StatusReply(created.duplicate ? 200 : 201, created);
}

/** `GET /v1/app/me`: the caller, their org, and every sign-in method linked to them. Never the providers' issuers or subjects. */
async function getAppMe(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<AppMeResponse> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, now: deps.now });
  return {
    developer: { id: caller.developerId, name: caller.name, ...(caller.email === undefined ? {} : { email: caller.email }), orgRole: caller.orgRole },
    org: { orgId: org.orgId, name: org.name, plan: org.plan },
    identities: await store.identitiesOf(caller.developerId),
  };
}

/**
 * `DELETE /v1/app/me/identities/{provider}`: removes one of the caller's own sign-in methods. The developer is the verified token's
 * (`caller.developerId`), never anything the request carries. Its sessions end, the others' go on; the answer lists what is left.
 */
async function unlinkAppIdentity(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string): Promise<{ identities: LinkedIdentity[] }> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to remove: cloud or github");
  if (deps.developer.unlinkIdentity === undefined) throw agentXError("NOT_FOUND", "removing a sign-in method is not set up in this deployment");
  const answer = await deps.developer.unlinkIdentity({ kind: "unlink-identity", developerId: caller.developerId, sessionId: caller.sessionId, provider: method.data });
  if (!answer.ok) {
    // Removing a method needs a fresh sign-in with another method (Plan 2, Task 8b); the message says which is missing.
    if (answer.error === "reauth") throw agentXError("REAUTH_REQUIRED", answer.message);
    if (answer.error === "refused") throw agentXError("CONFIG_INVALID", answer.message);
    if (answer.error === "not_found") throw agentXError("NOT_FOUND", "that sign-in method is not linked to your account");
    throw agentXError("RUNTIME_UNAVAILABLE", "removing the sign-in method did not complete; try again");
  }
  logDeveloperEvent({ event: "developer.identity_unlinked", provider: method.data });
  return { identities: await signInStoreOf(deps).identitiesOf(caller.developerId) };
}

/**
 * `POST /v1/app/me/identities/{provider}`: starts adding a sign-in method the caller removed earlier back to their own account. The
 * developer and the session are the verified token's (`caller`), never anything the request carries; the session must be fresh. The answer
 * is the sign-in link to open, which links the identity back only to this developer.
 */
async function startAppIdentityLink(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string): Promise<StartIdentityLinkAppResponse> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to add back: cloud or github");
  if (deps.developer.startIdentityLink === undefined) throw agentXError("NOT_FOUND", "adding a sign-in method back is not set up in this deployment");
  const answer = await deps.developer.startIdentityLink({ kind: "start-identity-link", developerId: caller.developerId, sessionId: caller.sessionId, provider: method.data });
  if (!answer.ok) {
    if (answer.error === "reauth") throw agentXError("REAUTH_REQUIRED", answer.message);
    if (answer.error === "refused") throw agentXError("CONFIG_INVALID", answer.message);
    throw agentXError("RUNTIME_UNAVAILABLE", "adding the sign-in method back did not start; try again");
  }
  logDeveloperEvent({ event: "developer.identity_link_started", provider: method.data });
  return { authorizeUrl: answer.authorizeUrl };
}

/** The caller's own org and their role in it. */
async function getOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ org: { orgId: OrgId; name: string; plan: string }; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  return { org: { orgId: org.orgId, name: org.name, plan: org.plan }, role: caller.orgRole };
}

const CreateInviteBodySchema = z.object({
  requestId: z.string().uuid(),
  role: z.enum(["admin", "member"]),
  email: z.string().trim().email().max(254).optional(),
}).strict();

/**
 * An owner or admin invites someone to their org; only an owner may invite an admin. A replay of one requestId is
 * refused (IDEMPOTENCY_CONFLICT) because only the token's hash is stored, so the first link cannot be given again.
 */
async function createOrganizationInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ inviteUrl: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can invite people to the organization");
  const parsed = CreateInviteBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, role, email } = parsed.data;
  if (role === "admin" && caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can invite an admin; an admin can invite members");
  const { token } = await deps.orgs.createInvite({ orgId: caller.orgId, createdBy: caller.developerId, role, requestId, ...(email === undefined ? {} : { email }) });
  logDeveloperEvent({ event: "developer.org_invite_created", orgId: caller.orgId, role, targeted: String(email !== undefined) });
  // A cloud install shares the web app's link, with the token in the fragment so a static host never receives it. A private install's
  // link points at its own cell, which reads the token server-side, so it keeps the query.
  return { inviteUrl: deps.cloud === true
    ? inviteUrl(`${deps.developer.webOrigin ?? DEFAULT_ROVARA_WEB_ORIGIN}/join`, token, "fragment")
    : inviteUrl(`${deps.developer.issuer}/join`, token, "query") };
}

const signInStoreOf = (deps: DeveloperRouteDependencies) => new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, now: deps.now });

const bodyError = (error: z.ZodError) => {
  const issue = error.issues[0];
  // Field names only: the values are the caller's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

/** `GET /v1/app/org/members`: any member may list the org's people. Names, emails and sign-in methods come from the sign-in table. */
async function listOrganizationMembers(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ members: Array<{ developerId: string; name: string; email?: string; role: OrgRole; joinedAt: string; identities: DeveloperSignInMethod[] }> }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const store = signInStoreOf(deps);
  const members = await deps.orgs.listMembers(caller.orgId);
  const listed = await mapLimit(members, REVISION_READS_AT_ONCE, async (member) => {
    const [record, identities] = await Promise.all([store.getDeveloper(member.developerId), store.identitiesOf(member.developerId)]);
    const email = record?.email ?? identities.find((identity) => identity.email !== undefined)?.email;
    // A person from before sign-in methods were linked has no IDENTITY rows: their record's own provider is the method they signed in with.
    const methods = identities.length > 0 ? identities.map((identity) => identity.provider) : record === undefined ? [] : [record.provider];
    return {
      developerId: member.developerId, name: record?.displayName ?? "Unknown", ...(email === undefined ? {} : { email }), role: member.role, joinedAt: member.joinedAt,
      identities: [...new Set(methods)],
    };
  });
  return { members: listed.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt) || left.developerId.localeCompare(right.developerId)) };
}

const ChangeRoleBodySchema = z.object({ requestId: z.string().uuid(), role: OrgRoleSchema }).strict();

/** `PUT /v1/app/org/members/{developerId}/role`: owners only. Demoting the last owner is LAST_OWNER (409). */
async function changeMemberRole(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string, body: unknown): Promise<{ developerId: string; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can change roles");
  const parsed = ChangeRoleBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  await deps.orgs.setRole({ orgId: caller.orgId, developerId, role: parsed.data.role });
  logDeveloperEvent({ event: "developer.org_role_changed", orgId: caller.orgId, role: parsed.data.role });
  return { developerId, role: parsed.data.role };
}

/**
 * Ends a removed person's sign-in sessions through DeveloperIdentity. They are already refused (the membership is gone), so a failure
 * here is logged and never fails the removal.
 */
async function endSessionsAfterRemoval(deps: DeveloperRouteDependencies, developerId: string): Promise<void> {
  if (deps.developer.endDeveloperSessions === undefined) return;
  try {
    const answer = await deps.developer.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at: new Date(deps.now()).toISOString() });
    if (!answer.ok && answer.error !== "not_found") logDeveloperEvent({ event: "developer.org_removal_sessions_not_ended", reason: answer.error });
  } catch (error) {
    logDeveloperEvent({ event: "developer.org_removal_sessions_not_ended", reason: errorName(error) });
  }
}

/** Every address that may hold a person's `ORG_EMAIL#` pointer: their developer record's and each linked identity's. */
async function emailsOf(store: DeveloperSignInStore, developerId: string): Promise<string[]> {
  const [record, identities] = await Promise.all([store.getDeveloper(developerId), store.identitiesOf(developerId)]);
  return [...new Set([record?.email, ...identities.map((identity) => identity.email)].filter((email): email is string => typeof email === "string"))];
}

const STOPS_AFTER_STEP = (name: string) => `${name}'s running tasks will stop after their current step. None of them will open a pull request.`;

/**
 * `DELETE /v1/app/org/members/{developerId}`. Owners may remove anyone but the last owner, admins members only; nobody removes themselves
 * (leaving has its own route). Their sessions end, and ruling R60 stops their running tasks at the next dispatch. A private install
 * bans the person from signing back in to its one org until an invite clears it; a cloud install lets them start a new org.
 */
async function removeOrganizationMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string): Promise<{ removed: { developerId: string; name: string }; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can remove people from the organization");
  if (developerId === caller.developerId) throw agentXError("FORBIDDEN", "use agentx org leave to leave");
  const target = (await deps.orgs.listMembers(caller.orgId)).find((member) => member.developerId === developerId);
  if (target === undefined) throw agentXError("NOT_FOUND", "that person is not a member of the organization");
  if (caller.orgRole === "admin" && target.role !== "member") throw agentXError("FORBIDDEN", "an admin can remove members only; ask an owner to remove an owner or admin");
  const store = signInStoreOf(deps);
  const [record, emails] = await Promise.all([store.getDeveloper(developerId), emailsOf(store, developerId)]);
  await deps.orgs.removeMember({ orgId: caller.orgId, developerId, emails, ban: deps.cloud !== true, expectedRole: target.role });
  await endSessionsAfterRemoval(deps, developerId);
  const name = record?.displayName ?? "That person";
  logDeveloperEvent({ event: "developer.org_member_removed", orgId: caller.orgId, role: target.role, banned: String(deps.cloud !== true) });
  return { removed: { developerId, name }, message: STOPS_AFTER_STEP(name) };
}

const LeaveBodySchema = z.object({ requestId: z.string().uuid() }).strict();

/**
 * `POST /v1/app/org/leave`. Members and admins leave. An owner leaves when another owner exists; an owner who is the only member
 * closes the org (its GitHub connection and Slack workspace are released, its projects archived). Otherwise LAST_OWNER (409).
 */
async function leaveOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ left: true; orgClosed: boolean; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const parsed = LeaveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const store = signInStoreOf(deps);
  const emails = await emailsOf(store, caller.developerId);
  const sole = caller.orgRole === "owner" && (await deps.orgs.listMembers(caller.orgId)).every((member) => member.developerId === caller.developerId);
  // Ruling (Task 4, Minor 6): closing is for cloud orgs. A private install's only org is never closed: a closed org would take every
  // later sign-in with no owner. Its sole owner promotes someone else first.
  if (sole && deps.cloud !== true) throw agentXError("LAST_OWNER", "You are the only owner. Make someone else an owner first.");
  if (sole) {
    await deps.orgs.closeOrg(caller.orgId, {
      archiveProjects: deps.closeOrgHooks?.archiveProjects ?? (async () => undefined), clearEgress: deps.closeOrgHooks?.clearEgress ?? ((orgId) => clearOrgEgress(egressDepsOf(deps), orgId)), emails,
    });
  } else {
    await deps.orgs.removeMember({ orgId: caller.orgId, developerId: caller.developerId, emails, ban: false });
  }
  await endSessionsAfterRemoval(deps, caller.developerId);
  logDeveloperEvent({ event: "developer.org_left", orgId: caller.orgId, role: caller.orgRole, closed: String(sole) });
  return { left: true, orgClosed: sole, message: sole ? "You left and the organization is closed." : STOPS_AFTER_STEP(caller.name) };
}

function budgetDependencies(deps: DeveloperRouteDependencies): BudgetDependencies {
  if (deps.modelAccess === undefined) throw agentXError("NOT_FOUND", "budgets are not set up in this deployment");
  return { documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, cloud: deps.cloud === true };
}

/** What the caller and their org have spent this month, and their limits: LiteLLM's figures (ruling R22), which a soft cap can leave over the limit (ruling R23). */
async function getBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ member: { spentUsd: number; limitUsd: number | null }; org: { spentUsd: number; limitUsd: number | null } }> {
  const budgets = budgetDependencies(deps);
  const settings = await ensureSynced(budgets, caller.orgId, caller.developerId);
  const { member, org } = await budgets.access.spend(caller.orgId, caller.developerId);
  // Ruling R47: a limit that is not set is shown as none, not as the proxy's stand-in figure.
  return {
    member: { spentUsd: member.spentUsd, limitUsd: memberLimitOf(settings, caller.developerId) === undefined ? null : member.limitUsd },
    org: { spentUsd: org.spentUsd, limitUsd: settings.orgMonthlyUsd === undefined ? null : org.limitUsd },
  };
}

/**
 * An owner or admin sets the org's monthly limit, the members' default, and per-member overrides (changeBudgets).
 * If the proxy cannot be reached the settings stand and the call answers 503.
 */
async function putOrganizationBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ budget: OrgBudgetSettings }> {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can change the organization's budgets");
  const budgets = budgetDependencies(deps);
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const budget = await changeBudgets({ ...budgets, orgs: deps.orgs }, { orgId: caller.orgId, body, updatedBy: caller.developerId, at: new Date(deps.now()).toISOString() });
  logDeveloperEvent({ event: "developer.org_budget_changed", orgId: caller.orgId, overrides: String(Object.keys(budget.memberOverrides).length) });
  return { budget };
}

/** Sign in with ChatGPT (#338): the caller's own connection, and only theirs. No route answers a token. */
export const CHATGPT_CONNECTION_PATH = "/v1/dev/chatgpt/connection";

async function routeChatGptConnection(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.chatgpt === undefined) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
  const finish = url.pathname.endsWith("/finish");
  if (finish && request.method === "POST") return deps.chatgpt.finish(caller.developerId, jsonBody(request));
  if (!finish && request.method === "GET") return deps.chatgpt.view(caller.developerId);
  if (!finish && request.method === "POST") return deps.chatgpt.start(caller.developerId);
  if (!finish && request.method === "DELETE") return deps.chatgpt.disconnect(caller.developerId);
  throw agentXError("NOT_FOUND", "route not found");
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}
