// Part of the broker (split out of ../broker.ts): Slack refusal answers, workspace routing, connector and GitHub context.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, ConnectorCallRequestSchema, GitHubMcpRequestSchema, githubConnectorOf, SlackRequesterSchema, SlackThreadSchema, agentXError, slackThreadUrl, type SlackThread, type WorkspaceInstance, type OrgId, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { ZodError } from "zod";
import type { GitHubTokenScope } from "../../github-app.js";
import { CredentialUnavailable } from "@agentx/gateway";
import { executeGitHubTool, toGitHubCatalog, type GitHubMcpDependencies } from "../../github-mcp.js";
import { DynamoConnectorLedger, GITHUB_LEDGER } from "../connector-ledger.js";
import { attributionDroppedLog, callConnector, connectorCatalogKey, discoverConnector, discoverLegacyGitHubScope, stripCode, type ConnectorContextBase } from "../connector-routes.js";
import { resolveConnectors, BUILT_IN_CONNECTOR_TYPES, type ConnectorTypeContext, type ResolvedConnector } from "../connector-types.js";
import type { ConnectorCredentials } from "../credentials.js";
import { WORKFLOW_APPROVAL_OUT_OF_DATE, WORKFLOW_BUTTON_OUT_OF_DATE } from "../../developer/workflow-actions.js";
import { slackRefusalMessage } from "../slack-refusals.js";
import { requireOrgId } from "../../org/resolve.js";
import { inertName } from "../../developer/task-records.js";
import { AWS_TEMPORARY_MESSAGE, UNEXPECTED_REQUEST_MESSAGE, isTemporaryAwsError } from "../broker-shared.js";
import { orgCredentialRegistry } from "../../connections/registry.js";
import { personNameForText } from "../../developer/requester-text.js";
import { json } from "../json-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { acceptCancellation, acceptPullRequest, acceptPullRequestLifecycle, acceptTask } from "./acceptance.js";
import { parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "./definitions.js";
import { workspaceTaskOwner } from "./model-access.js";
import { getArtifact, getAuthorizedOperation, pageEvents, requireLatestProject, requireOwnedWorkspace, requireProjectAuthority } from "./records.js";
import { githubMcpFor, githubScope, orgOfRecord } from "./scope-helpers.js";
import { createConversation, resolveWorkspace } from "./task-operations.js";
import { channelOperation, slackRequesterOf } from "./thread-workspaces.js";
import { requireSlackRequesterMayWork } from "./workspace-preparation.js";

/**
 * Where an error was thrown: its stack's first frame, a location that carries no data. Read only
 * after the stack's header, so a message that spans lines can never be mistaken for a frame.
 */
function thrownAt(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  // Node writes the bare name when the message is empty.
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  if (!error.stack.startsWith(header)) return undefined;
  return error.stack.slice(header.length).split("\n").map((line) => line.trim()).find((line) => line.startsWith("at "));
}

/** Task 19: what a press on an approval (Approve, Request changes) hears when it is out of date. */
export const SLACK_APPROVAL_OUT_OF_DATE = WORKFLOW_APPROVAL_OUT_OF_DATE;
/** Task 19: what a press on any other button hears when it is out of date (the same words Slack's own handler uses). */
export const SLACK_BUTTON_OUT_OF_DATE = WORKFLOW_BUTTON_OUT_OF_DATE;
const SLACK_REFUSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the presser hears when their press could not be saved for a reason AgentX did not expect. */
const SLACK_PRESS_NOT_SAVED = "I couldn't save that. Try again.";

/**
 * Task 19: the presser's private note in the thread they pressed in, for the notifier to deliver (chat.postEphemeral).
 * One item per invoke (`attemptId`, Lambda's request ID, which a retried or duplicated delivery of the same invoke
 * keeps), so the same invoke tells once while a second press that meets the same refusal is told again. Best effort: a
 * note that cannot be written is logged, and the press's own answer stands.
 */
export async function recordSlackWorkflowRefusal(dependencies: AwsBrokerDependencies, event: { taskId: string; userId: string; thread: SlackThread; requestId: string }, message: string, attemptId: string): Promise<void> {
  const thread = SlackThreadSchema.safeParse(event.thread);
  const user = SlackRequesterSchema.shape.userId.safeParse(event.userId);
  if (!SLACK_REFUSAL_ID.test(event.taskId) || !SLACK_REFUSAL_ID.test(event.requestId) || !thread.success || !user.success) return;
  const at = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: { pk: `DEVTASK#${event.taskId}`, sk: `REFUSAL#${event.requestId}#${attemptId}`, entityType: "WORKFLOW_ACTION_REFUSAL", taskId: event.taskId,
        slackUserId: user.data, channelId: thread.data.channelId, threadTs: thread.data.threadTs, message, at, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at) },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "slack.workflow_refusal_unrecorded", taskId: event.taskId, requestId: event.requestId, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Task 19: the answer to a Slack workflow press (handed over asynchronously by the interactivity). An expected refusal
 * (out of date, busy, not the owner) answers 200 `{ refused: true }` and is told to the presser privately: never an
 * error that Slack would show as a failed save. A failure AgentX did not expect is told the same way and still fails.
 */
export async function answerSlackWorkflowEvent(
  dependencies: AwsBrokerDependencies,
  event: { taskId: string; userId: string; thread: SlackThread; requestId: string },
  name: string,
  run: () => Promise<unknown>,
  options: { outOfDate: string; awsRequestId?: string | undefined },
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  // Without an invoke's own request ID (a direct call), each answer is its own attempt.
  const attemptId = options.awsRequestId !== undefined && SLACK_REFUSAL_ID.test(options.awsRequestId) ? options.awsRequestId : randomUUID();
  try {
    const result = await run();
    console.log(JSON.stringify({ component: "broker", event: `slack.workflow_${name}_saved`, taskId: event.taskId, requestId: event.requestId }));
    // A press whose effect is not otherwise said (a retried review whose start post was already said once) is told privately.
    const note = result !== null && typeof result === "object" ? (result as { note?: unknown }).note : undefined;
    if (typeof note === "string") await recordSlackWorkflowRefusal(dependencies, event, note, attemptId);
    return json(result, "slack-ingress");
  } catch (error) {
    const refusal = error instanceof AgentXError ? slackRefusalMessage(error.code, options.outOfDate, stripCode(error.message, error.code), (error as { decidedBy?: unknown }).decidedBy) : undefined;
    if (error instanceof AgentXError && refusal !== undefined) {
      // A lost race's sentence names a person: the log keeps a fixed label instead.
      const reason = error.code === "IDEMPOTENCY_CONFLICT" ? "already_decided" : stripCode(error.message, error.code);
      console.log(JSON.stringify({ component: "broker", event: `slack.workflow_${name}_refused`, taskId: event.taskId, requestId: event.requestId, errorCode: error.code, reason }));
      await recordSlackWorkflowRefusal(dependencies, event, refusal, attemptId);
      return json({ refused: true, message: refusal }, "slack-ingress");
    }
    console.log(JSON.stringify({ component: "broker", event: `slack.workflow_${name}_failed`, taskId: event.taskId, requestId: event.requestId,
      ...(error instanceof AgentXError ? { errorCode: error.code } : { errorName: error instanceof Error ? error.name : "unknown" }) }));
    await recordSlackWorkflowRefusal(dependencies, event, SLACK_PRESS_NOT_SAVED, attemptId);
    if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode >= 500 ? error.statusCode : 500);
    const answer = unexpectedErrorAnswer(error, "slack-ingress");
    return answer.statusCode >= 500 ? answer : { ...answer, statusCode: 500 };
  }
}

/** A Slack thread reply that could not be saved: logged by task, event and error name only (never the text), answered 503 so Slack retries it. */
export function replyNotSavedAnswer(error: unknown, event: { taskId: string; eventId: string }): { statusCode: number; headers: Record<string, string>; body: string } {
  const at = thrownAt(error);
  console.log(JSON.stringify({ component: "broker", event: "slack.thread_reply_not_saved", taskId: event.taskId, eventId: event.eventId,
    name: error instanceof Error ? error.name : "unknown", ...(at === undefined ? {} : { at }) }));
  return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "the reply could not be saved; Slack will retry it" } }, "slack-ingress", 503);
}

/**
 * Issue #48: the answer to an error that is not an AgentXError. A temporary AWS error answers 503
 * RUNTIME_UNAVAILABLE, so the caller tries again; any other keeps CONFIG_INVALID. Apart from a
 * schema refusal or a CredentialUnavailable, no answer carries the error's own words, and the log
 * carries only its name and, for an unexpected one, where it was thrown.
 */
export function unexpectedErrorAnswer(error: unknown, requestId: string): { statusCode: number; headers: Record<string, string>; body: string } {
  // A schema refusal is AgentX's own words: zod 4 never quotes the raw input, though a refinement
  // may name the admin's own values, such as a repository name. A CredentialUnavailable is too: it
  // names only credential references and secret names, never a secret.
  if (error instanceof ZodError || error instanceof CredentialUnavailable) {
    return json({ error: { code: "CONFIG_INVALID", message: error.message } }, requestId, 400);
  }
  const name = error instanceof Error ? error.name : "unknown";
  if (isTemporaryAwsError(error)) {
    console.log(JSON.stringify({ component: "broker", event: "aws.temporary_error", requestId, name }));
    return json({ error: { code: "RUNTIME_UNAVAILABLE", message: AWS_TEMPORARY_MESSAGE } }, requestId, 503);
  }
  const at = thrownAt(error);
  console.log(JSON.stringify({ component: "broker", event: "request.unexpected_error", requestId, name, ...(at === undefined ? {} : { at }) }));
  return json({ error: { code: "CONFIG_INVALID", message: UNEXPECTED_REQUEST_MESSAGE } }, requestId, 400);
}

export async function routeWorkspaceRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const body = parseBody(request.body);
  const githubMcp = /^\/v1\/workspaces\/([0-9a-f-]+)\/github\/(tools|call)$/.exec(url.pathname);
  if (githubMcp?.[1] && ((request.method === "GET" && githubMcp[2] === "tools") || (request.method === "POST" && githubMcp[2] === "call"))) {
    // Feature 007 shapes, kept for Slack services from before feature 013.
    const { workspace, project, github } = await authorizeGitHubConnector(dependencies, identity, githubMcp[1]);
    if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
    const parsed = request.method === "POST" ? GitHubMcpRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid GitHub MCP request");
    const repositoryName = parsed?.success ? parsed.data.repository : url.searchParams.get("repository");
    const repository = github.repositories.find((entry) => entry.name === repositoryName);
    if (!repository) throw agentXError("NOT_FOUND", "registered repository not found");
    const revision = project.definition.revision;
    if (!parsed?.success) {
      const types = dependencies.connectorTypes ?? BUILT_IN_CONNECTOR_TYPES;
      const discovery = await discoverLegacyGitHubScope({
        connectors: resolveConnectors(project.definition, connectorTypeContext(dependencies, await orgOfRecord(dependencies, workspace), identityGithubScope(dependencies, identity)), types),
        githubTypeKnown: Object.hasOwn(types, "github"),
        connectorName: github.name, repository: repository.name, projectName: workspace.projectName,
        context: connectorContext(identity, workspace, project), catalogs: dependencies.catalogs,
      });
      return json({ catalog: toGitHubCatalog(discovery) }, request.requestId);
    }
    const attribution = attributionText(identity, github);
    const result = await executeGitHubTool(parsed.data, gitHubContext(identity, workspace, project, github, repository), {
      ...withoutDeploymentAttribution(githubMcpFor(dependencies.githubMcp, identityGithubScope(dependencies, identity))),
      ...(attribution === undefined ? {} : { attribution }),
      onAttributionDropped: attributionDroppedLog(workspace.projectName, revision, github.name, repository.name, parsed.data.requestId),
      store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, github.name),
      onDefinitionChanged: () => dependencies.catalogs.delete(connectorCatalogKey(requireOrgId(identity.orgId), workspace.projectName, revision, github.name, repository.name)),
    });
    return json({ result }, request.requestId);
  }

  const connectorRoute = /^\/v1\/workspaces\/([0-9a-f-]+)\/connectors\/([a-z][a-z0-9-]{0,19})\/(tools|call)$/.exec(url.pathname);
  if (connectorRoute?.[1] && connectorRoute[2] && ((request.method === "GET" && connectorRoute[3] === "tools") || (request.method === "POST" && connectorRoute[3] === "call"))) {
    const { workspace, project } = await authorizeWorkspaceConnectors(dependencies, identity, connectorRoute[1]);
    const connector = resolveConnectors(project.definition, connectorTypeContext(dependencies, await orgOfRecord(dependencies, workspace), identityGithubScope(dependencies, identity)), dependencies.connectorTypes)
      .find((entry) => entry.name === connectorRoute[2]);
    if (!connector) throw agentXError("NOT_FOUND", "connector not found");
    const parsed = request.method === "POST" ? ConnectorCallRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid connector request");
    const context = connectorContext(identity, workspace, project);
    if (!parsed?.success) {
      // Only a caller that sends x-agentx-include: gate gets the action gate's fields (feature 014); they are not secret.
      const includeGateFields = request.headers["x-agentx-include"]?.split(",").map((entry) => entry.trim()).includes("gate") === true;
      return json({ catalog: await discoverConnector({
        connector, workspace, context, catalogs: dependencies.catalogs, refresh: url.searchParams.get("refresh") === "1", includeGateFields,
      }) }, request.requestId);
    }
    const attribution = attributionText(identity, connector);
    const result = await callConnector({
      connector, request: parsed.data, workspace, context, catalogs: dependencies.catalogs,
      ...(attribution === undefined ? {} : { attribution }),
      ledger: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, connector.ledger, connector.name),
    });
    return json({ result }, request.requestId);
  }

  const resolve = /^\/v1\/projects\/([^/]+)\/workspace$/.exec(url.pathname);
  if (request.method === "GET" && resolve?.[1]) {
    const revision = Number.parseInt(url.searchParams.get("revision") ?? "", 10);
    return json(
      { workspace: await resolveWorkspace(dependencies, identity, decodeURIComponent(resolve[1]), revision) },
      request.requestId,
    );
  }

  const conversations = /^\/v1\/workspaces\/([0-9a-f-]+)\/conversations$/.exec(url.pathname);
  if (request.method === "POST" && conversations?.[1]) {
    return json(
      { conversation: await createConversation(dependencies, identity, conversations[1]) },
      request.requestId,
      201,
    );
  }

  const tasks = /^\/v1\/workspaces\/([0-9a-f-]+)\/tasks$/.exec(url.pathname);
  if (request.method === "POST" && tasks?.[1]) {
    return json(await acceptTask(dependencies, identity, tasks[1], body, channelOperation(dependencies, identity)), request.requestId, 202);
  }

  const pullRequests = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-requests$/.exec(url.pathname);
  if (request.method === "POST" && pullRequests?.[1]) {
    return json(await acceptPullRequest(dependencies, identity, pullRequests[1], body, channelOperation(dependencies, identity)), request.requestId, 202);
  }
  const pullRequestActions = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-request-actions$/.exec(url.pathname);
  if (request.method === "POST" && pullRequestActions?.[1]) {
    return json(
      await acceptPullRequestLifecycle(dependencies, identity, pullRequestActions[1], body, channelOperation(dependencies, identity)),
      request.requestId,
      202,
    );
  }

  const operation = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && operation?.[1] && operation[2]) {
    return json(
      { operation: await getAuthorizedOperation(dependencies, identity, operation[1], operation[2]) },
      request.requestId,
    );
  }

  const events = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/events$/.exec(url.pathname);
  if (request.method === "GET" && events?.[1] && events[2]) {
    return json(
      await pageEvents(dependencies, identity, events[1], events[2], {
        limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
        ...(url.searchParams.get("cursor") === null
          ? {}
          : { cursor: url.searchParams.get("cursor")! }),
      }),
      request.requestId,
    );
  }

  const artifact = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifact?.[1] && artifact[2]) {
    return json(
      { artifact: await getArtifact(dependencies, identity, artifact[1], artifact[2]) },
      request.requestId,
    );
  }

  const cancel = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel?.[1] && cancel[2]) {
    return json(await acceptCancellation(dependencies, identity, cancel[1], cancel[2]), request.requestId, 202);
  }

  throw agentXError("NOT_FOUND", "route not found");
}

/** Workspace ownership, channel binding and membership, then the project's latest revision, which configures at least one connector. */
async function authorizeWorkspaceConnectors(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  if (identity.slack && identity.slack.binding.projectName !== workspace.projectName) throw agentXError("FORBIDDEN", "Slack channel is no longer bound to this project");
  // Connector tools can write to the outside world: a project viewer in the thread does not use them.
  await requireSlackRequesterMayWork(dependencies, identity, workspace.projectName);
  await requireProjectAuthority(dependencies, requireOrgId(identity.orgId), identity.ownerKey, workspace.projectName, { taskCreator: () => workspaceTaskOwner(dependencies, workspace.id) });
  // The policy and the scopes it may address come from the project's latest registered revision,
  // so enabling, narrowing or revoking a tool reaches an existing thread at once.
  const project = await requireLatestProject(dependencies, requireOrgId(identity.orgId), workspace.projectName);
  const integrations = project.definition.integrations;
  if (!integrations?.githubMcp && !integrations?.connectors?.length) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
  return { workspace, project };
}

/** The workspace and latest revision, then that revision's GitHub connector. */
async function authorizeGitHubConnector(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const { workspace, project } = await authorizeWorkspaceConnectors(dependencies, identity, workspaceId);
  const github = githubConnectorOf(project.definition);
  if (!github) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
  return { workspace, project, github };
}

/**
 * What a connector type reads: the GitHub MCP dependencies and a credential registry. A private install uses its
 * install-wide registry. A cloud install uses the org registry of the org the workspace, task or caller belongs to
 * (`orgId`), and none when it has no org or no org connections are configured: it never falls back to credentials that
 * belong to the whole install.
 *
 * Plan 2, Task 15: `scope` says whose work a GitHub token the connectors mint is for; it is asked only when one is minted. It is required, so
 * every caller names the scope its token is for and none inherits one by default.
 */
export function connectorTypeContext(dependencies: Pick<AwsBrokerDependencies, "githubMcp" | "credentialRegistry" | "orgConnections" | "cloud" | "mcpEndpointGuard" | "nativeFetch" | "cloudwatchConnector"> & { githubPullRequests?: Partial<Pick<AwsBrokerDependencies["githubPullRequests"], "createAgentInstallationToken">> }, orgId: OrgId | undefined, scope: () => Promise<GitHubTokenScope>): ConnectorTypeContext {
  const github = dependencies.githubPullRequests;
  let credentialRegistry: ConnectorCredentials | undefined = dependencies.credentialRegistry;
  if (dependencies.cloud === true) {
    credentialRegistry = dependencies.orgConnections !== undefined && orgId !== undefined ? orgCredentialRegistry(dependencies.orgConnections, orgId) : undefined;
  }
  return {
    ...(dependencies.githubMcp ? { githubMcp: githubMcpFor(dependencies.githubMcp, scope) } : {}),
    ...(credentialRegistry ? { credentialRegistry } : {}),
    ...(dependencies.mcpEndpointGuard ? { endpointGuard: dependencies.mcpEndpointGuard } : {}),
    ...(dependencies.nativeFetch ? { nativeFetch: dependencies.nativeFetch } : {}),
    ...(orgId === undefined ? {} : { orgId }),
    ...(dependencies.cloudwatchConnector ? { cloudwatchAws: dependencies.cloudwatchConnector } : {}),
    // Plan 4 Task 17: the GitHub Actions connector mints Plan 3's agent token (read-only by type, for the org's own installation) for every call.
    ...(github?.createAgentInstallationToken === undefined ? {} : {
      githubAgentTokens: { createAgentInstallationToken: (repository, permissions, tokenScope, options) => github.createAgentInstallationToken!(repository, permissions, tokenScope, options) },
    }),
  };
}

function connectorContext(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, project: RegisteredProjectRecord): ConnectorContextBase {
  return { orgId: requireOrgId(identity.orgId), workspaceId: workspace.id, ownerKey: identity.ownerKey, settingsRevision: project.definition.revision, ...slackRequesterOf(identity) };
}

type GitHubConnector = NonNullable<ReturnType<typeof githubConnectorOf>>;
type GitHubRepository = GitHubConnector["repositories"][number];

/** The scope for an authenticated caller's own request: their org (on a cloud install). */
function identityGithubScope(dependencies: Pick<AwsBrokerDependencies, "cloud">, identity: Pick<AuthenticatedIdentity, "orgId">): () => Promise<GitHubTokenScope> {
  return async () => githubScope(dependencies, identity.orgId);
}

/** Only the connector decides attribution: a deployment-level value must not survive attribution: false. */
function withoutDeploymentAttribution(dependencies: GitHubMcpDependencies): Omit<GitHubMcpDependencies, "attribution"> {
  const rest = { ...dependencies };
  delete rest.attribution;
  return rest;
}

function attributionText(identity: AuthenticatedIdentity, connector: Pick<ResolvedConnector, "attribution">): string | undefined {
  if (!connector.attribution || !identity.slack) return undefined;
  // C55: a Slack display name that is an address is not written on GitHub.
  const name = identity.slack.requesterName === undefined ? undefined : personNameForText(identity.slack.requesterName);
  const who = inertName(name ?? `Slack member ${identity.slack.requester.userId}`);
  return `Requested by ${who} via AgentX · ${slackThreadUrl(identity.slack.thread)}`;
}

function gitHubContext(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, project: RegisteredProjectRecord, github: GitHubConnector, repository: GitHubRepository) {
  return {
    workspaceId: workspace.id,
    ownerKey: identity.ownerKey,
    repository,
    policy: github.policy,
    settingsRevision: project.definition.revision,
    ...slackRequesterOf(identity),
  };
}
