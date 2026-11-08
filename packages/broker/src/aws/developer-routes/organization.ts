import { logDeveloperEvent } from "../../developer/log.js";
import { deleteChosenNameOfRemoved } from "../../developer/chosen-name.js";
import { changeReviewedMemberRole } from "../../org/role-changes.js";
import { type RemovalHelpers } from "../../org/member-removal/routes.js";
import { requireAuditorEdition } from "../../org/auditor.js";
import { OrgMemberRoleChangeBodySchema } from "@agentx/contracts";
import { navigationReadCache } from "../../app-nav/read-cache.js";
import { trialAvailable } from "../../org/trial-availability.js";
import { APP_NAV_CACHE_MS, appNav, orgTrial, type AppNavDependencies } from "../../app-nav/nav.js";
import { navigationLive } from "../../agent-sessions/live.js";
import { homeCards } from "../../agent-sessions/home.js";
import { listSessions } from "../../agent-sessions/read.js";
import { listRoster } from "../../agents/roster.js";
import { listVisibleAgents } from "../../agents/access.js";
import { clearOrgHooks } from "../../triggers/hooks.js";
import { deleteOrgTriggers } from "../../triggers/lifecycle.js";
import { z } from "zod";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CreateOrganizationInviteBodySchema,
  agentXError,
  LAST_OWNER_MESSAGE,
  orgMemberKey,
  type AppMeResponse,
  SetMyNameBodySchema,
  type SetMyNameResponse,
  type StartIdentityLinkAppResponse,
  UnlinkableSignInMethodSchema,
  type LinkedIdentity,
  type OrgId,
  type OrgRole,
} from "@agentx/contracts";
import { clearOrgEgress } from "../../org/egress-domains.js";
import { releaseOrgModelSources } from "../../model-sources/release.js";
import { archiveOrgProjects } from "../../org/project-archive.js";
import { cloudJoinBase, inviteUrl } from "../../org/invite-url.js";
import { methodAllowedByEdition } from "../../developer/edition-methods.js";
import { parseCreateProjectBody } from "../../org/cloud-projects.js";
import { createProjectFromMetaRoute } from "../../org/create-from-meta.js";
import { isCreateFromMetaBody } from "@agentx/contracts";
import { changeBudgets, ensureSynced, memberLimitOf, type BudgetDependencies, type OrgBudgetSettings } from "../../org/budget.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { StatusReply } from "../status-reply.js";
import { decidingOf, type SessionRouteDependencies } from "../../agent-sessions/routes.js";
import { closeOrgSessions, stopOrgSessions } from "../../agent-sessions/lifecycle.js";
import { stopSession } from "../../agent-sessions/stop.js";
import { clearOrgConnections } from "../../connections/store.js";
import { clearOrgMcpServers } from "../../context-sources/mcp-servers.js";
import { CLOSE_STOP_BUDGET_MS, type DeveloperCaller, type DeveloperRouteDependencies } from "./types.js";
import { bodyError, signInStoreOf } from "./common.js";
import { errorName } from "./identity-lambda.js";
import { REVISION_READS_AT_ONCE, mapLimit, projectMembersOf } from "./project-list.js";
import { archiveDepsOf, egressDepsOf } from "./project-archive-setup.js";
import { sessionReadDependencies } from "./dependencies.js";
import { clearOrgLearning } from "../../learning/cleanup.js";

/**
 * `POST /v1/app/projects` (and its alias `POST /v1/dev/projects`): an owner or admin of a cloud org creates a project from a repository its
 * own GitHub connection reaches. Order: the install, the role, the body; then (the broker, in this order) a replay of the request, whether the
 * connection reaches the repository, GitHub's description of it, the registration as a new name, and the record of the request. Any other
 * install registers projects through an administrator.
 */
export async function createProject(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<StatusReply> {
  if (deps.cloud !== true) throw agentXError("FORBIDDEN", "projects on this install are created by an administrator; ask an administrator to run agentx project add");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can create a project; ask your organization's owner");
  // Meta repo lane A: a body with a `metaRepository` starts a project from a meta repo.
  if (isCreateFromMetaBody(body)) {
    const made = await createProjectFromMetaRoute({ cloud: true, ...(deps.createFromMeta === undefined ? {} : { createFromMeta: deps.createFromMeta }) }, caller, body);
    return new StatusReply(made.status, made.body);
  }
  if (deps.createProject === undefined) throw agentXError("NOT_FOUND", "project creation is not set up in this deployment");
  const created = await deps.createProject(caller, parseCreateProjectBody(body));
  return new StatusReply(created.duplicate ? 200 : 201, created);
}

/** Per-cell, per-person immutable source adapters keep the five-second appNav cache warm across route dependency objects. Authentication still precedes every call. */
const navigationAdapters = new WeakMap<object, Map<string, { at: number; deps: AppNavDependencies; release: () => void }>>();
export async function getAppNavigation(deps: DeveloperRouteDependencies, caller: DeveloperCaller) {
 if (deps.agents === undefined || deps.orgs === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Navigation is temporarily unavailable. Try again shortly.");
 const agents = deps.agents, orgs = deps.orgs;
 const features = process.env.WEB_FEATURES ?? "";
 const key = [deps.tableName, deps.developer.issuer, caller.orgId, caller.developerId, caller.orgRole, features].join("#");
 let adapters = navigationAdapters.get(deps.documentClient);
 if (adapters === undefined) { adapters = new Map();navigationAdapters.set(deps.documentClient, adapters); }
 let cached = adapters.get(key);
 if (cached === undefined || cached.at + APP_NAV_CACHE_MS <= deps.now()) {
  // RULING Q38: reuse canonical sources and their partitioned access reads; coalesce identical reads, never replace visibility policy.
  const cache = navigationReadCache(deps.documentClient);
  const cachedDeps = { ...deps, documentClient: cache.documentClient };
  const members = projectMembersOf(cachedDeps);
  const cachedAgents = { ...agents, documentClient: cache.documentClient, store: cache.store(agents.store), projectMembers: members };
  const sessionReads = { ...sessionReadDependencies(cachedDeps, caller), documentClient: cache.documentClient, projectMembers: members };
  const reads = { ...sessionReads, approvals: cachedAgents, deciding: sessionReads.deciding ?? decidingOf(cachedAgents) };
  let wall: ReturnType<typeof navigationLive> | undefined;
  const live = () => wall ??= navigationLive(reads, caller);
  const sources: NonNullable<AppNavDependencies["sources"]> = {
   projects: async () => (await members.projectsOf(caller.orgId, caller)).map(project => ({ name: project.project })),
   rosters: async (_who, names) => (await mapLimit(names, REVISION_READS_AT_ONCE, async project => (await listRoster(cachedAgents, caller, project)).filter(agent => !agent.disabled && agent.status === "active").map(agent => ({ project, agentId: agent.agentId, name: agent.name })))).flat(),
   live: async () => (await live()).map(tile => ({ sessionId: tile.sessionId, ...(tile.project === undefined ? {} : { project: tile.project }), ...(tile.agent === undefined ? {} : { agentId: tile.agent.agentId }), running: true, needsYou: tile.needsYou })),
   home: async () => homeCards(reads, caller),
   sharedAgents: async () => (await listVisibleAgents(cachedAgents, caller, "shared")).map(agent => ({ agentId: agent.agentId, name: agent.name })),
   sharedSessions: async () => (await listSessions(reads, caller, { shared: "me", status: "open", limit: 10 })).sessions.map(session => ({ sessionId: session.sessionId, title: session.title, ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }) })),
   org: async () => { const org = await orgs.getOrg(caller.orgId);if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");return org; },
  };
  // PLAN8: local-agent product capabilities are not part of this web launch.
  cached = { at: deps.now(), deps: { sources, now: deps.now, webFeatures: features, localAgents: false, ...(process.env.AGENTX_RELEASE_VERSION === undefined ? {} : { release: process.env.AGENTX_RELEASE_VERSION }), ...(trialAvailable(deps.editionPolicy) ? {} : { hideTrial: true as const }) }, release: cache.release };
  adapters.delete(key);adapters.set(key, cached);
  if (adapters.size > 256) { const first = adapters.keys().next().value;if (first !== undefined) adapters.delete(first); }
 }
 try { return await appNav(cached.deps, caller); }
 catch (error) { if (adapters.get(key) === cached) adapters.delete(key);throw error; }
 finally { cached.release(); }
}

/** `GET /v1/app/me`: the caller, their org, and every sign-in method linked to them. Never the providers' issuers or subjects. */
export async function getAppMe(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<AppMeResponse> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, now: deps.now });
  return {
    developer: { id: caller.developerId, name: caller.name, ...(caller.email === undefined ? {} : { email: caller.email }), orgRole: caller.orgRole, nameChosen: caller.nameChosen === true },
    org: { orgId: org.orgId, name: org.name, plan: org.plan, nameIsDefault: org.nameIsDefault ?? org.createdBy !== "system", ...(!trialAvailable(deps.editionPolicy) || orgTrial(org) === undefined ? {} : { trial: orgTrial(org) }) },
    identities: await store.identitiesOf(caller.developerId),
    // UX1: what the account menu and the GitHub step may offer to link: the method is on here (the server checks again when a link starts).
    // UX1 review M4: the same edition gate the link start applies (methodAllowedByEdition), so an edition without a method never offers it.
    linkable: { slack: deps.developer.methods.slack === true && methodAllowedByEdition(deps.editionPolicy, "slack"), github: deps.developer.methods.github === true && methodAllowedByEdition(deps.editionPolicy, "github") },
  };
}

/**
 * `PUT /v1/app/me/name` (release 0.4.16): the signed-in person chooses the name teammates see. The person is the verified session's (`caller.developerId`), never anything the
 * body carries, and the body is the name alone. A sign-in leaves a chosen name alone. Written with a `member.renamed` audit record (no name in it).
 */
export async function setMyName(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<SetMyNameResponse> {
  const parsed = SetMyNameBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) });
  const record = await store.setChosenDisplayName({ developerId: caller.developerId, orgId: caller.orgId, name: parsed.data.name });
  logDeveloperEvent({ event: "developer.name_chosen" });
  return { name: record.displayName, nameChosen: true };
}

/**
 * `DELETE /v1/app/me/identities/{provider}`: removes one of the caller's own sign-in methods. The developer is the verified token's
 * (`caller.developerId`), never anything the request carries. Its sessions end, the others' go on; the answer lists what is left.
 */
export async function unlinkAppIdentity(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string): Promise<{ identities: LinkedIdentity[] }> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to remove: cloud or github (a Slack link is removed in the web app)");
  // The Slack link is changed in the web app only (a live browser session), as it is made there.
  if (method.data === "slack" && caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to unlink your Slack account.");
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
export async function startAppIdentityLink(deps: DeveloperRouteDependencies, caller: DeveloperCaller, provider: string, body?: unknown): Promise<StartIdentityLinkAppResponse> {
  const method = UnlinkableSignInMethodSchema.safeParse(provider);
  if (!method.success) throw agentXError("CONFIG_INVALID", "name the sign-in method to add back: cloud or github (a Slack account is linked in the web app)");
  // Linking a Slack account is for a signed-in web user: the link is finished in the browser that holds the session (the CLI cannot).
  if (method.data === "slack" && caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to link your Slack account.");
  if (deps.developer.startIdentityLink === undefined) throw agentXError("NOT_FOUND", "adding a sign-in method back is not set up in this deployment");
  // UX1: from a live browser session, GitHub is linked to this account (any sign-in method), finished in this browser; from the CLI it stays "add a removed method back".
  const browserGithub = method.data === "github" && caller.browserSession === true;
  const asked = typeof body === "object" && body !== null ? (body as { returnTo?: unknown }).returnTo : undefined;
  const returnTo = asked === "/app/onboard" || asked === "/app/admin/connections" ? asked : "/app" as const;
  const answer = await deps.developer.startIdentityLink({ kind: "start-identity-link", developerId: caller.developerId, sessionId: caller.sessionId, provider: method.data,
    ...(method.data === "slack" || browserGithub ? { browser: true as const } : {}), ...(browserGithub ? { returnTo } : {}) });
  if (!answer.ok) {
    if (answer.error === "reauth") throw agentXError("REAUTH_REQUIRED", answer.message);
    if (answer.error === "refused") throw agentXError("CONFIG_INVALID", answer.message);
    throw agentXError("RUNTIME_UNAVAILABLE", "adding the sign-in method back did not start; try again");
  }
  logDeveloperEvent({ event: "developer.identity_link_started", provider: method.data });
  return { authorizeUrl: answer.authorizeUrl };
}

/** The caller's own org and their role in it. */
export async function getOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ org: { orgId: OrgId; name: string; plan: string }; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const org = await deps.orgs.getOrg(caller.orgId);
  if (org === undefined) throw agentXError("NOT_FOUND", "your organization was not found");
  return { org: { orgId: org.orgId, name: org.name, plan: org.plan }, role: caller.orgRole };
}

/**
 * An owner or admin invites someone to their org; only an owner may invite an admin. A replay of one requestId is
 * refused (IDEMPOTENCY_CONFLICT) because only the token's hash is stored, so the first link cannot be given again.
 */
export async function createOrganizationInvite(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ inviteUrl: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  let live: Record<string, unknown> | undefined;
  try { const answer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(caller.orgId, caller.developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };live = answer.Item; } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Invite access could not be checked. Try again."); }
  if (live?.orgId !== caller.orgId || live.developerId !== caller.developerId || (live.role !== "owner" && live.role !== "admin")) throw agentXError("FORBIDDEN", "only an owner or admin can invite people to the organization");
  const parsed = CreateOrganizationInviteBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, role, email } = parsed.data;
  if (role === "admin" && live.role !== "owner") throw agentXError("FORBIDDEN", "only an owner can invite an admin; an admin can invite members");
  const { token } = await deps.orgs.createInvite({ orgId: caller.orgId, createdBy: caller.developerId, role, requestId, ...(email === undefined ? {} : { email }) });
  logDeveloperEvent({ event: "developer.org_invite_created", orgId: caller.orgId, role, targeted: String(email !== undefined) });
  // A cloud install shares the web app's link, with the token in the fragment so a static host never receives it. A private install's
  // link points at its own cell, which reads the token server-side, so it keeps the query.
  return { inviteUrl: deps.cloud === true
    ? inviteUrl(cloudJoinBase(deps.developer.issuer), token, "fragment")
    : inviteUrl(`${deps.developer.issuer}/join`, token, "query") };
}

const ChangeRoleBodySchema = OrgMemberRoleChangeBodySchema;

/** `PUT /v1/app/org/members/{developerId}/role`: owners only. Demoting the last owner is LAST_OWNER (409). */
export async function changeMemberRole(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string, body: unknown): Promise<{ developerId: string; role: OrgRole }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const reviewed = typeof body === "object" && body !== null && Object.hasOwn(body, "expectedRole");
  // Preserve the released CLI's owner-first check and field-specific validation on legacy bodies.
  if (!reviewed && caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can change roles");
  const parsed = ChangeRoleBodySchema.safeParse(body);
  if (!parsed.success) throw reviewed ? agentXError("CONFIG_INVALID", "Review a valid company role change before submitting.") : bodyError(parsed.error);
  if (parsed.data.expectedRole !== undefined) return changeReviewedMemberRole(deps, caller, developerId, { ...parsed.data, expectedRole: parsed.data.expectedRole });
  if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can change roles");
  // I2: the Auditor is given only where the edition has it.
  if (parsed.data.role === "auditor") requireAuditorEdition(deps.editionPolicy);
  await deps.orgs.setRole({ orgId: caller.orgId, developerId, role: parsed.data.role, by: { kind: "member", id: caller.developerId }, requestId: parsed.data.requestId });
  logDeveloperEvent({ event: "developer.org_role_changed", orgId: caller.orgId, role: parsed.data.role });
  return { developerId, role: parsed.data.role };
}

/**
 * Ends a removed person's sign-in sessions through DeveloperIdentity, at the removal's own time. With movers wired the removal's sign-in step does this (retried by the marker),
 * so this is only for an install with none (it also deletes the name the person chose, ERASE-NAME-1). They are already refused (the membership is gone), so a failure here is logged and never fails the removal.
 */
async function endSessionsAfterRemoval(deps: DeveloperRouteDependencies, developerId: string, at: string): Promise<void> {
  // ERASE-NAME-1: the name the person chose goes with their membership (the movers' removal does this too; it is repeatable).
  try {
    await deleteChosenNameOfRemoved(deps.documentClient, deps.tableName, developerId, at);
  } catch (error) {
    logDeveloperEvent({ event: "developer.org_removal_name_not_deleted", reason: errorName(error) });
  }
  if (deps.developer.endDeveloperSessions === undefined) return;
  try {
    const answer = await deps.developer.endDeveloperSessions({ kind: "end-developer-sessions", developerId, at });
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

/** What the removal routes need from here: the person's addresses, the legacy session end, and the sentence about running tasks. */
export const removalHelpers = (deps: DeveloperRouteDependencies): RemovalHelpers => ({
  emailsOf: (developerId) => emailsOf(signInStoreOf(deps), developerId),
  afterRemoval: (developerId, removedAt) => endSessionsAfterRemoval(deps, developerId, removedAt),
  stops: (name) => STOPS_AFTER_STEP(name),
});

const STOPS_AFTER_STEP = (name: string) => `${name}'s running tasks will stop after their current step. None of them will open a pull request.`;

/**
 * `DELETE /v1/app/org/members/{developerId}`. Owners may remove anyone but the last owner, admins members only; nobody removes themselves
 * (leaving has its own route). Their sessions end, and ruling R60 stops their running tasks at the next dispatch. A private install
 * bans the person from signing back in to its one org until an invite clears it; a cloud install lets them start a new org.
 */
export async function removeOrganizationMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, developerId: string): Promise<{ removed: { developerId: string; name: string }; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can remove people from the organization");
  if (developerId === caller.developerId) throw agentXError("FORBIDDEN", "use agentx org leave to leave");
  const target = (await deps.orgs.listMembers(caller.orgId)).find((member) => member.developerId === developerId);
  if (target === undefined) throw agentXError("NOT_FOUND", "that person is not a member of the organization");
  if (caller.orgRole === "admin" && target.role !== "member") throw agentXError("FORBIDDEN", "an admin can remove members only; ask an owner to remove an owner or admin");
  const store = signInStoreOf(deps);
  const [record, emails] = await Promise.all([store.getDeveloper(developerId), emailsOf(store, developerId)]);
  const started = await deps.orgs.removeMember({ orgId: caller.orgId, developerId, emails, ban: deps.cloud !== true, expectedRole: target.role, by: { kind: "member", id: caller.developerId }, callerRole: caller.orgRole });
  if (deps.agents === undefined) await endSessionsAfterRemoval(deps, developerId, started.removedAt);
  const name = record?.displayName ?? "That person";
  logDeveloperEvent({ event: "developer.org_member_removed", orgId: caller.orgId, role: target.role, banned: String(deps.cloud !== true) });
  return { removed: { developerId, name }, message: STOPS_AFTER_STEP(name) };
}

/**
 * The plan's route text is `body { requestId }`. Leave needs no request record: a repeat finds the person out of the org and is refused at
 * sign-in, so an id could never be replayed. The id is accepted and ignored, so a client written to the plan works; other keys are refused.
 */
const LeaveBodySchema = z.object({ requestId: z.string().uuid().optional() }).strict();

/**
 * What closing a company clears besides its connections, triggers, hooks and sessions, in the close's learning step: its learning data, then its stored proof evidence (not behind the proof switch). The
 * evidence erase records its pending erase before any work, so a pass that does not finish is resumed by the scheduled job. The Team record is its own close step (`clearTeamRecord`).
 */
export function clearOrgData(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "evidenceErase">): (orgId: OrgId) => Promise<void> {
  return async (orgId) => {
    // The two steps are independent: the close swallows what this throws, so a learning walk that failed must not stop the evidence erase from recording its pending erase. The learning failure is reported after.
    let learningFailed = false;
    let learningError: unknown;
    try { await clearOrgLearning({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId); } catch (error) { learningFailed = true; learningError = error; }
    await deps.evidenceErase?.workspace(orgId);
    if (learningFailed) throw learningError;
  };
}

/**
 * `POST /v1/app/org/leave`. Members and admins leave. An owner leaves when another owner exists; an owner who is the only member
 * closes the org (its GitHub connection and Slack workspace are released, its projects archived). Otherwise LAST_OWNER (409).
 */
export async function leaveOrganization(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ left: true; orgClosed: boolean; message: string }> {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const parsed = LeaveBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const store = signInStoreOf(deps);
  const emails = await emailsOf(store, caller.developerId);
  const sole = caller.orgRole === "owner" && (await deps.orgs.listMembers(caller.orgId)).every((member) => member.developerId === caller.developerId);
  // Ruling (Task 4, Minor 6): closing is for cloud orgs. A private install's only org is never closed: a closed org would take every
  // later sign-in with no owner. Its sole owner promotes someone else first.
  if (sole && deps.cloud !== true) throw agentXError("LAST_OWNER", LAST_OWNER_MESSAGE);
  if (sole) {
    const connections = deps.orgConnections ?? deps.agents?.connections;
    const clearOwnConnections = deps.closeOrgHooks?.clearConnections ?? (connections === undefined ? undefined : (orgId: OrgId) => clearOrgConnections({ store: connections }, orgId));
    // ME-16: the org's MCP servers and their tokens go with it, in the same step as its connections (a no-op where the install has no registered servers).
    const mcpServers = deps.agents?.mcpServers;
    const clearConnections = mcpServers === undefined ? clearOwnConnections : async (orgId: OrgId) => { await clearOwnConnections?.(orgId); await clearOrgMcpServers(mcpServers, orgId); };
    const triggers = deps.agents?.triggers;
    const clearTriggers = deps.closeOrgHooks?.clearTriggers ?? (triggers === undefined ? undefined : (orgId: OrgId) => deleteOrgTriggers({ triggers, ...(deps.agents?.triggerSchedules === undefined ? {} : { triggerSchedules: deps.agents.triggerSchedules }) }, orgId));
    const eventHooks = deps.agents?.eventHooks;
    const clearHooks = deps.closeOrgHooks?.clearHooks ?? (eventHooks === undefined ? undefined : (orgId: OrgId) => clearOrgHooks({ store: eventHooks.store, secrets: eventHooks.secrets }, orgId));
    const modelSources = deps.agents?.modelSources;
    const releaseModelSources = deps.closeOrgHooks?.releaseModelSources ?? (modelSources === undefined ? undefined : (orgId: OrgId) => releaseOrgModelSources(modelSources, orgId));
    // Plan 5 Task 21: the org's sessions go with it (live index, work entries, devices, change feeds; the rest expires in 30 days).
    // Plan 5 Task 21 review M-6: running work is asked to stop through the session stop (the task's own cancel, idempotent by a request id derived from the session), as the person who is leaving.
    const stopWork = deps.closeOrgHooks?.stopWork ?? (async (orgId: OrgId) => {
      let sessionDeps: SessionRouteDependencies;
      try {
        sessionDeps = sessionReadDependencies(deps, caller);
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "agent_session.close_stop_unavailable", orgId, error: error instanceof Error ? error.name : "unknown" }));
        return;
      }
      await stopOrgSessions({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, deadline: deps.now() + CLOSE_STOP_BUDGET_MS }, orgId, async (sessionId, requestId) => { await stopSession(sessionDeps, caller, sessionId, { requestId }); });
    });
    const clearSessions = deps.closeOrgHooks?.clearSessions ?? ((orgId: OrgId) => closeOrgSessions({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId));
    // v1.2 learning loop: the company's learning data is deleted by a bounded walk over its projects; a walk that does not finish is resumed later (`resumeLearningWalks`).
    // v1.2 learning loop and stored proof evidence: `clearOrgData` (learning walk, then the evidence erase, which records its pending erase before any work so the scheduled job resumes it).
    const clearLearning = deps.closeOrgHooks?.clearLearning ?? clearOrgData(deps);
    // Team record (wire-team-record): the company's whole record (rows, vectors, facts, lessons, lake) is erased with it, where the record's switch is on. Unlike the learning walk this is NOT best
    // effort: the hook writes an erase-in-progress marker first (a failure stops the close and a fresh close resumes it) and does one bounded pass; the hourly job finishes the rest, the lake rows included.
    const clearTeamRecord = deps.closeOrgHooks?.clearTeamRecord ?? (deps.teamRecord === undefined ? undefined : (orgId: OrgId) => deps.teamRecord!.erase.workspace(orgId));
    await deps.orgs.closeOrg(caller.orgId, {
      archiveProjects: deps.closeOrgHooks?.archiveProjects ?? ((orgId) => archiveOrgProjects(archiveDepsOf(deps), orgId, { developerId: caller.developerId })), clearEgress: deps.closeOrgHooks?.clearEgress ?? ((orgId) => clearOrgEgress(egressDepsOf(deps), orgId)),
      // Plan 3 Task 12, PF11: the org's connection secrets are scheduled for deletion with the org.
      ...(clearConnections === undefined ? {} : { clearConnections }),
      // Plan 4 Task 18: the org's triggers, their activity and their notices go with it (and, Task 26, the schedules of its schedule triggers).
      ...(clearTriggers === undefined ? {} : { clearTriggers }),
      // Plan 4 Task 19: its event hooks stop receiving, and their secrets are scheduled for deletion.
      ...(clearHooks === undefined ? {} : { clearHooks }),
      // The org's company AI sources leave the model proxy with it, vendor keys included (Task 24b).
      ...(releaseModelSources === undefined ? {} : { releaseModelSources }),
      clearSessions,
      clearLearning,
      ...(clearTeamRecord === undefined ? {} : { clearTeamRecord }),
      stopWork,
      emails,
      by: { kind: "member", id: caller.developerId },
    });
  } else {
    const started = await deps.orgs.removeMember({ orgId: caller.orgId, developerId: caller.developerId, emails, ban: false, by: { kind: "member", id: caller.developerId } });
    if (deps.agents === undefined) await endSessionsAfterRemoval(deps, caller.developerId, started.removedAt);
  }
  // A sole owner who closed the org: closing is not a removal with movers, so the sessions end here.
  if (sole) await endSessionsAfterRemoval(deps, caller.developerId, new Date(deps.now()).toISOString());
  logDeveloperEvent({ event: "developer.org_left", orgId: caller.orgId, role: caller.orgRole, closed: String(sole) });
  return { left: true, orgClosed: sole, message: sole ? "You left and the organization is closed." : STOPS_AFTER_STEP(caller.name) };
}

function budgetDependencies(deps: DeveloperRouteDependencies): BudgetDependencies {
  if (deps.modelAccess === undefined) throw agentXError("NOT_FOUND", "budgets are not set up in this deployment");
  return { documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess, cloud: deps.cloud === true, ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
}

/** What the caller and their org have spent this month, and their limits: LiteLLM's figures (ruling R22), which a soft cap can leave over the limit (ruling R23). */
export async function getBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<{ member: { spentUsd: number; limitUsd: number | null }; org: { spentUsd: number; limitUsd: number | null } }> {
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
export async function putOrganizationBudget(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: unknown): Promise<{ budget: OrgBudgetSettings }> {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "only an owner or admin can change the organization's budgets");
  const budgets = budgetDependencies(deps);
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  const budget = await changeBudgets({ ...budgets, orgs: deps.orgs }, { authority: { developerId: caller.developerId, role: caller.orgRole }, orgId: caller.orgId, body, updatedBy: caller.developerId, at: new Date(deps.now()).toISOString() });
  logDeveloperEvent({ event: "developer.org_budget_changed", orgId: caller.orgId, overrides: String(Object.keys(budget.memberOverrides).length) });
  return { budget };
}

/** Sign in with ChatGPT (#338): the caller's own connection, and only theirs. No route answers a token. */
export const CHATGPT_CONNECTION_PATH = "/v1/dev/chatgpt/connection";

export async function routeChatGptConnection(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.chatgpt === undefined) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
  const finish = url.pathname.endsWith("/finish");
  if (finish && request.method === "POST") return deps.chatgpt.finish(caller.developerId, jsonBody(request));
  if (!finish && request.method === "GET") return deps.chatgpt.view(caller.developerId);
  if (!finish && request.method === "POST") return deps.chatgpt.start(caller.developerId);
  if (!finish && request.method === "DELETE") return deps.chatgpt.disconnect(caller.developerId);
  throw agentXError("NOT_FOUND", "route not found");
}

export function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}
