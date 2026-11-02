// packages/broker/src/aws/admin-actions.ts
// Spec 025 E8, E9, E19: the admin actions 25e's change tools apply that no admin command had. Each
// is called only by a confirmed change (Task 7) or by the CLI's own change path (Tasks 14, 15).
import { approvalGrantChange } from "../org/approval-membership.js";
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_OIDC_ISSUER, SlackUserIdSchema, agentXError, projectMemberKey, type EndDeveloperSessionsRequest, type EndDeveloperSessionsResponse, type DeveloperSignInMethod, type OrgId } from "@agentx/contracts";
import { MAX_PER_ORGANIZATION, MAX_PER_PERSON, isWholeLimit, workspaceLimitsKey } from "../developer/limits.js";
import { emailIndexKey } from "../developer/store.js";
import { ownerKeyForSubject } from "./lambda.js";

export interface AdminActionDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The sign-in table; absent where developer sign-in is not set up. */
  signInTableName?: string;
  slackTeamId?: string;
  limitDefaults: { member: number; organization: number };
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  now(): number;
}
export interface ResolvedDeveloper {
  developerId: string;
  via: "id" | "slack" | "email";
  slackUserId?: string;
  profile?: { displayName: string; provider: DeveloperSignInMethod; slackUserId?: string; sessionsEndedAt?: string };
}

const HEX64 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
// Never the email itself: an error can reach a log, a tool result or a Slack post.
const EMAIL_NOT_SIGNED_IN = "nobody has signed in to AgentX with that email yet; name them by Slack user ID, or ask them to sign in first";
const conditional = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";
const normalEmail = (email: string) => email.trim().toLowerCase();

/** FR-008: a Slack sign-in's developer ID, so a grant can come before the first sign-in (E8). */
export function developerIdForSlackUser(userId: string): string {
  return ownerKeyForSubject(SLACK_OIDC_ISSUER, userId);
}

async function signInItem(deps: AdminActionDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  if (deps.signInTableName === undefined) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

function profileFrom(item: Record<string, unknown> | undefined): ResolvedDeveloper["profile"] {
  if (item === undefined || typeof item.displayName !== "string" || (item.provider !== "slack" && item.provider !== "oidc" && item.provider !== "cloud" && item.provider !== "github" && item.provider !== "saml")) return undefined;
  return {
    displayName: item.displayName, provider: item.provider,
    ...(typeof item.slackUserId === "string" ? { slackUserId: item.slackUserId } : {}),
    ...(typeof item.sessionsEndedAt === "string" ? { sessionsEndedAt: item.sessionsEndedAt } : {}),
  };
}

const developerItem = (deps: AdminActionDependencies, developerId: string) => signInItem(deps, { pk: `DEVELOPER#${developerId}`, sk: "META" });

export async function resolveDeveloper(deps: AdminActionDependencies, reference: string): Promise<ResolvedDeveloper> {
  const value = reference.trim();
  if (HEX64.test(value)) {
    const profile = profileFrom(await developerItem(deps, value));
    return { developerId: value, via: "id", ...(profile === undefined ? {} : { profile }) };
  }
  if (SlackUserIdSchema.safeParse(value).success) {
    const developerId = developerIdForSlackUser(value);
    const profile = profileFrom(await developerItem(deps, developerId));
    return { developerId, via: "slack", slackUserId: value, ...(profile === undefined ? {} : { profile }) };
  }
  if (EMAIL.test(value)) {
    const indexed = await signInItem(deps, emailIndexKey(value));
    // Q4: an email names only someone who signed in with it (from this release on).
    if (typeof indexed?.developerId !== "string" || !HEX64.test(indexed.developerId)) throw agentXError("NOT_FOUND", EMAIL_NOT_SIGNED_IN);
    const item = await developerItem(deps, indexed.developerId);
    // The index is never cleaned when a verified email changes, so an old entry still points at its
    // developer: it names them only while their record still holds that email.
    if (typeof item?.email !== "string" || normalEmail(item.email) !== normalEmail(value)) throw agentXError("NOT_FOUND", EMAIL_NOT_SIGNED_IN);
    const profile = profileFrom(item);
    return { developerId: indexed.developerId, via: "email", ...(profile === undefined ? {} : { profile }) };
  }
  throw agentXError("CONFIG_INVALID", "developer must be a developer ID, an email or a Slack user ID such as U0123456789");
}

/** The membership row's role, and when it was granted (null for a row without that, such as an administrator's). A `viewer` row is a person's own project role (Plan 2, Task 21). */
export async function projectGrant(deps: AdminActionDependencies, orgId: OrgId, project: string, developerId: string): Promise<{ role: "developer" | "viewer" | "administrator"; grantedAt: string | null } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMemberKey(orgId, developerId, project), ConsistentRead: true })) as { Item?: { role?: unknown; grantedAt?: unknown } };
  const role = response.Item?.role;
  if (role !== "developer" && role !== "viewer" && role !== "administrator") return undefined;
  return { role, grantedAt: typeof response.Item?.grantedAt === "string" ? response.Item.grantedAt : null };
}

const VIEWER_NOT_CHANGED = (project: string) => `that developer is a viewer of ${project}; change their role with agentx project add-member, so there is nothing to grant here`;

/**
 * FR-013.1: a `developer` ProjectMembership row, a contributor made by the operator console (`grantedBy: { system: "admin" }`; the operator is
 * kept as `grantedByAdmin`). An administrator row for the same key is kept as it is, and so is a person's own viewer role.
 */
export async function grantProjectAccess(deps: AdminActionDependencies, orgId: OrgId, admin: { issuer: string; subject: string }, project: string, developerId: string): Promise<{ granted: true; already: boolean }> {
  const current = await projectGrant(deps, orgId, project, developerId);
  if (current?.role === "administrator") throw agentXError("CONFIG_INVALID", `that developer already administers ${project}, so there is nothing to grant`);
  if (current?.role === "viewer") throw agentXError("CONFIG_INVALID", VIEWER_NOT_CHANGED(project));
  if (current?.role === "developer") return { granted: true, already: true };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: {
      TableName: deps.tableName,
      Item: { ...projectMemberKey(orgId, developerId, project), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, role: "developer", projectRole: "contributor",
        grantId: randomUUID(), grantedBy: { system: "admin" }, grantedByAdmin: admin, grantedAt: new Date(deps.now()).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    } }, ...await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, project, false)] }));
  } catch (error) {
    if (!grantConditionFailed(error)) throw error;
    // A row appeared between the read and the write: say what it is rather than assume.
    const raced = await projectGrant(deps, orgId, project, developerId);
    if (raced?.role === "administrator") throw agentXError("CONFIG_INVALID", `that developer already administers ${project}, so there is nothing to grant`);
    if (raced?.role === "viewer") throw agentXError("CONFIG_INVALID", VIEWER_NOT_CHANGED(project));
    return { granted: true, already: true };
  }
  return { granted: true, already: false };
}

/** Only a failed grant condition is an idempotent race; authority failures are not. */
function grantConditionFailed(error: unknown): boolean {
  return conditional(error) || (error instanceof Error && error.name === "TransactionCanceledException"
    && (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.[0]?.Code === "ConditionalCheckFailed");
}

export async function revokeProjectAccess(deps: AdminActionDependencies, orgId: OrgId, project: string, developerId: string): Promise<{ revoked: boolean }> {
  const key = projectMemberKey(orgId, developerId, project);
  const observed = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (observed === undefined || (observed.role !== "developer" && observed.role !== "viewer")) return { revoked: false };
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: {
      TableName: deps.tableName, Key: key,
      ConditionExpression: "#role = :role AND " + (observed.projectRole === undefined ? "attribute_not_exists(projectRole)" : "projectRole = :projectRole") + " AND " + (observed.grantId === undefined ? "attribute_not_exists(grantId)" : "grantId = :grantId"),
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":role": observed.role, ...(observed.projectRole === undefined ? {} : { ":projectRole": observed.projectRole }), ...(observed.grantId === undefined ? {} : { ":grantId": observed.grantId }) },
    } }, ...await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, project, observed.projectRole === "maintainer")] }));
    return { revoked: true };
  } catch (error) {
    if (grantConditionFailed(error)) return { revoked: false };
    throw error;
  }
}

/** E19, FR-053: the setting the broker reads at each workspace creation. */
/** `via` (#216): how the change was confirmed, kept so a change planned before it can say how the limits changed. */
export async function setWorkspaceLimits(deps: AdminActionDependencies, orgId: OrgId, admin: { issuer: string; subject: string }, limits: { perPerson: number; perOrganization: number }, via?: string): Promise<{ perPerson: number; perOrganization: number; updatedAt: string }> {
  // The bounds readWorkspaceLimits accepts, so a written setting is never one the broker ignores.
  if (!isWholeLimit(limits.perPerson, MAX_PER_PERSON)) throw agentXError("CONFIG_INVALID", `the per-person limit must be a whole number from 1 to ${MAX_PER_PERSON}`);
  if (!isWholeLimit(limits.perOrganization, MAX_PER_ORGANIZATION)) throw agentXError("CONFIG_INVALID", `the organization limit must be a whole number from 1 to ${MAX_PER_ORGANIZATION}`);
  if (limits.perPerson > limits.perOrganization) throw agentXError("CONFIG_INVALID", `the per-person limit (${limits.perPerson}) cannot be more than the organization limit (${limits.perOrganization})`);
  const updatedAt = new Date(deps.now()).toISOString();
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...workspaceLimitsKey(orgId), entityType: "SETTING", perPerson: limits.perPerson, perOrganization: limits.perOrganization, updatedBy: admin, ...(via === undefined ? {} : { via }), updatedAt },
  }));
  return { perPerson: limits.perPerson, perOrganization: limits.perOrganization, updatedAt };
}

export async function endSessions(deps: AdminActionDependencies, developerId: string): Promise<{ endedAt: string }> {
  if (deps.endDeveloperSessions === undefined) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment, so there is no sign-in to end");
  const endedAt = new Date(deps.now()).toISOString();
  const answer = await deps.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at: endedAt });
  if (answer.ok) return { endedAt };
  if (answer.error === "not_found") throw agentXError("NOT_FOUND", "that developer has never signed in, so there is no sign-in to end");
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
}
