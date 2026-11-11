// Who may do what with a session (Plan 5 Task 4). The level is the highest of the ways a person can hold one, read live each time:
//   - owning it: `edit`;
//   - a task session's project: the caller's own grant row (a maintainer grant `edit`, any other grant `view`), an org owner's or admin's role (`view`, and
//     they may stop it), or, off the read-only path, a role the project's Slack channel gives (`view`);
//   - a chain session: the readers Plan 4 names (`view`) and a maintainer grant (`edit`);
//   - a local session: none of the above. Only its owner and the people it was shared with see it (owner answer 2);
//   - the shares on the session: a person, a project the caller has a role on, or the whole company;
//   - the task's Task People list (`commenter` is `use`, `viewer` is `view`, `owner` is `edit` until the task has been taken over).
// A project viewer (not the owner) can only watch, whatever shares say; a Task People `denied` entry takes everything but an org admin's `view`.
// Another org's session, or no level at all, is `NOT_FOUND`, so a session's existence never leaks.
import { resolveStoredName } from "../developer/name-resolver.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentPrincipalSchema, ENDED_SESSION_STATUSES, SessionIdSchema, SessionLevelSchema, agentSessionKey, agentXError, atLeast, cleanSessionName, projectMemberKey, sessionLevelRequiredMessage, sessionViewerOnlyMessage, type AgentPrincipal, type AgentSessionRecord, type OrgId, type ProjectRole, type SessionAction, type SessionLevel, type SessionStatus, TaskStatusSchema } from "@rovara-code/contracts";
import { OrgRoleSchema, isWriterOrgRole, orgMemberKey, projectAllows as memberAllows, type OrgRole, type DeveloperTaskView, type ProjectRole as MemberRole } from "@agentx/cloud-contracts";
import type { ProjectMembers } from "../agents/access.js";
import { grantMemberRoleOf, grantRoleOf } from "../developer/project-roles.js";
import { UNNAMED_MEMBER, effectiveTaskOwner, isTaskTakenOver, takenOverSince, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { AgentSessionStore } from "./store.js";

/** Who asks Plan 4 for a chain's view: the internal session actor Plan 5 passes after its own level check (Plan 4, M2). No route, header or body can set it. */
export interface ChainSessionActor { kind: "session"; developerId: string }

/**
 * Plan 4's chain reads, injected where Plan 4 is merged: `chainRunView` and `chainStepTask` called with the session actor. `stepTask` keeps its own
 * project-role requirement; Plan 5 checks the same one first, so the answer is the same without Plan 4's. Until they are supplied a chain session's
 * body and step tasks answer `RUNTIME_UNAVAILABLE`.
 */
export interface ChainSessionReads {
  runView(actor: ChainSessionActor, runId: string): Promise<unknown>;
  stepTask(actor: ChainSessionActor, runId: string, seq: number): Promise<DeveloperTaskView>;
}

/**
 * `projectMembers` for a reader that only ever takes the read-only path (the realtime authorizer and sink): it asks nobody, and says so loudly if anything asks,
 * so a code path that reaches Slack from there fails closed instead of making a call.
 */
export const NO_SLACK_PROJECT_MEMBERS: Pick<ProjectMembers, "roleOf"> = {
  roleOf: async () => { throw new Error("the read-only path asks no one"); },
};

export interface SessionAccessDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** `roleOf` is used off the read-only path: it may ask Slack whether the project's channel gives the caller a role. The Finished list for Team and Company also asks `projectsOf` (which projects the caller reaches); the broker's own is the full one. */
  projectMembers: Pick<ProjectMembers, "roleOf"> & Partial<Pick<ProjectMembers, "projectsOf">>;
  /** Plan 4's readers of a chain run (the starter, the run's owner, `view` on the chain and the project, org owners and admins). Without it only the owner and shares see a chain session. */
  chainReadAccess?: (caller: { orgId: OrgId; developerId: string }, session: AgentSessionRecord) => Promise<boolean>;
  /** Plan 4's chain reads (see `ChainSessionReads`). */
  chain?: ChainSessionReads;
  /** The server secret that seals a session list's cursor (hex, derived by the broker from its signing key). Without it a list can't give a cursor, so it answers `RUNTIME_UNAVAILABLE`. */
  cursorKey?: string;
}

/** Who is asking: `DeveloperCaller` fits. Their org role is read from the org's member record, never taken from here. */
export interface SessionCaller { orgId: OrgId; developerId: string }

export interface SessionAccess {
  session: AgentSessionRecord;
  level: "none" | SessionLevel;
  /** Whether the caller is the effective owner. */
  owner: boolean;
  /** Who the effective owner is, named for a header or a "ask <name>" message: the taker once the task was taken over (their name as the task records it), else the session's own owner. */
  effectiveOwner: { developerId: string; name: string };
  /** ERASED-REJOIN-NAME: when `effectiveOwner.name` was written (the session's start, or the take-over's time): a list of sessions reads the name of a person who was erased and came back by it. */
  effectiveOwnerWrittenAt: string;
  projectRole?: ProjectRole;
  /**
   * Decision 103 (collaborator role, W11): the caller's EXACT role on a task session's project when its floor is a viewer (`projectRole: viewer`): `viewer` or `collaborator`, from their own grant row. The
   * `comment` and `ask` permissions of Cloud's table are asked of it (`memberMay`), so a collaborator comments and uses the live Ask and a viewer does neither. Absent otherwise, and on the many-sessions
   * path (`prefetch`), which then treats them as the viewer they are there.
   */
  memberRole?: MemberRole;
  /** An org owner or admin, on a task or chain session: they may stop it (`view` plus Stop). */
  orgAdmin: boolean;
  /** The caller's role in the org, read from their member record with the rest of the access. */
  orgRole: OrgRole;
}

export type { SessionAction };

/** What one request already learned of the caller's roles, so a list of many sessions asks the project channel once per project, not once per row (review m-2). */
export interface SessionRoleMemo {
  roles: Map<string, Promise<{ grant: ProjectRole | undefined; effective: ProjectRole | undefined; exact?: MemberRole | undefined }>>;
  shareRoles: Map<string, Promise<ProjectRole | undefined>>;
}
export const newSessionRoleMemo = (): SessionRoleMemo => ({ roles: new Map(), shareRoles: new Map() });

/**
 * What a reader of many sessions already holds (the Live wall reads these once for the whole page), so judging one session asks the table nothing: the caller's grant on a
 * project, the task record, the task's People list and the shares that reach the caller. The rules are the same ones, run over the same facts.
 */
export interface SessionAccessPrefetch {
  /** The role the caller's own grant row gives on the project. */
  grant(project: string): ProjectRole | undefined;
  /** The task's record, or undefined when it is not there (its org is still checked). */
  task(taskId: string): Item | undefined;
  /** The task's People list as `readTaskPeople` reads it. */
  people(taskId: string): Map<string, PeopleRole> | "unreadable" | undefined;
  /** The shares of the session that reach the caller (their own, their projects' and the company's). */
  shares(session: AgentSessionRecord): ReadonlyArray<{ principal: AgentPrincipal; level: SessionLevel }>;
}

export interface SessionAccessOptions {
  /** Facts read ahead for many sessions; see `SessionAccessPrefetch`. */
  prefetch?: SessionAccessPrefetch;
  /** Also work out the caller's role on the session's project for a share (a grant, or the project's channel), which the Team filter asks. */
  wantShareRole?: true;
  /** The realtime authorizer's path: grant rows, shares and the Task People item are read directly, and no Slack call is made. */
  readOnlyPath?: true;
  /** One caller's role lookups, shared by the reads of one request. Never share it between callers (it holds only their roles, keyed by project). */
  memo?: SessionRoleMemo;
}

const NOT_FOUND = () => agentXError("NOT_FOUND", "session not found");
const RANK: Record<"none" | SessionLevel, number> = { none: 0, view: 1, use: 2, edit: 3 };
const best = (a: "none" | SessionLevel, b: "none" | SessionLevel) => (RANK[a] >= RANK[b] ? a : b);
const isAdminRole = (role: OrgRole) => role === "owner" || role === "admin";

type Item = Record<string, unknown>;
const getItem = async (deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

// ---- the shares on a session

const ShareRowSchema = z.object({
  principal: AgentPrincipalSchema,
  level: SessionLevelSchema,
  sharedBy: z.object({ developerId: z.string(), name: z.string() }).passthrough(),
  sharedAt: z.string(),
}).passthrough();
export interface SessionShareRow { principal: AgentPrincipal; level: SessionLevel; sharedBy: { developerId: string; name: string }; sharedAt: string }

/** Every share on a session (at most `SESSION_SHARES_MAX`, but a read doesn't count on that), skipping an item that doesn't parse. */
export async function readSessionShares(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, orgId: OrgId, sessionId: string): Promise<SessionShareRow[]> {
  const rows: SessionShareRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": agentSessionKey(orgId, sessionId, "META").pk, ":prefix": "SHARE#" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const row = ShareRowSchema.safeParse(item);
      if (row.success) rows.push({ principal: row.data.principal, level: row.data.level, sharedBy: { developerId: row.data.sharedBy.developerId, name: row.data.sharedBy.name }, sharedAt: row.data.sharedAt });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return rows;
}

// ---- Task People, read without Slack

const PEOPLE_ROLES = new Set(["owner", "commenter", "viewer", "denied"]);
export type PeopleRole = "owner" | "commenter" | "viewer" | "denied";

/**
 * Where a follower stands now, judged on the read-only path (no Slack call): their level on the session, `lost` when the check positively says they have no access (they left
 * the company, a Task People entry denies them, or nothing that could give access exists), or `unknown` when they have none that the read-only path can see but the project's
 * Slack channel, which it does not ask, could still give them. Only `lost` is a reason to delete a follow.
 */
export async function followerStanding(deps: SessionAccessDependencies, caller: SessionCaller, session: AgentSessionRecord): Promise<SessionLevel | "lost" | "unknown"> {
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return "lost";
  const computed = await compute(deps, caller, role.data, session, { readOnlyPath: true });
  if (computed.level !== "none") return computed.level;
  return computed.undecided ? "unknown" : "lost";
}

/**
 * The task's people list as roles by developer: `undefined` when the task has none, "unreadable" for a list that doesn't parse (which counts as a denial for
 * everyone). A person listed twice keeps their last entry.
 */
export async function readTaskPeople(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, taskId: string): Promise<Map<string, PeopleRole> | "unreadable" | undefined> {
  return peopleOfItem(await getItem(deps, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" }));
}

/** A People item as `readTaskPeople` reads it: `undefined` for none, "unreadable" for one that doesn't parse. */
export function peopleOfItem(item: Item | undefined): Map<string, PeopleRole> | "unreadable" | undefined {
  if (item === undefined) return undefined;
  const people = item["people"];
  if (item["schemaVersion"] !== 1 || !Array.isArray(people)) return "unreadable";
  const roles = new Map<string, PeopleRole>();
  for (const entry of people as unknown[]) {
    const person = entry as { developerId?: unknown; role?: unknown } | null;
    if (typeof person !== "object" || person === null || typeof person.developerId !== "string" || typeof person.role !== "string" || !PEOPLE_ROLES.has(person.role)) return "unreadable";
    roles.set(person.developerId, person.role as PeopleRole);
  }
  return roles;
}

// ---- the effective owner

/**
 * The person who owns the session now, as `effectiveTaskOwner` says (Plan 5 Task 12a): the task's current owner once someone took it over, else the task's creator. A
 * session of no task (a local one, a chain's) has its own owner. Throws `TASK_ACCESS_DENIED` when the task's owner can't be read: nobody owns it then, so no one gets an
 * owner's access (never the session's first owner, who may have handed the session over).
 */
function effectiveOwnerNamed(session: AgentSessionRecord, taskItem: Item | undefined): { developerId: string; name: string } {
  // A session's own owner is the task's creator until the task is taken over, and a take-over moves the session and the task together.
  if (taskItem === undefined || !isTaskTakenOver(taskItem as unknown as DeveloperTaskRecord)) return session.owner;
  const owner = effectiveTaskOwner(taskItem as unknown as DeveloperTaskRecord);
  if (owner.developerId === session.owner.developerId) return session.owner;
  return { developerId: owner.developerId, name: cleanSessionName(owner.name) ?? UNNAMED_MEMBER };
}

/**
 * ERASE-NAME-2: the effective owner with the name that may be shown. The name stored with the session or the task is the one they had then (and may be the one they chose); an erased person reads "A former member",
 * a removed one never the name they chose, and a lookup that fails reads "A member". This is the ONE place the stored name is resolved: everything that writes the owner's name into an approval, a stored fact or an
 * error message (`access.effectiveOwner.name`) gets the resolved one. The readers of MANY sessions (a list with a `memo`, the Live wall with a `prefetch`) put no owner name into a sentence and overlay the names of
 * the whole page in one read themselves (`ownerNameOverlay`), so for them the name stays as stored here, which keeps a list at one read for its names.
 */
async function shownEffectiveOwner(deps: SessionAccessDependencies, orgId: string, owner: { developerId: string; name: string }, options: SessionAccessOptions, writtenAt?: string): Promise<{ developerId: string; name: string }> {
  if (options.prefetch !== undefined || options.memo !== undefined) return owner;
  return { developerId: owner.developerId, name: await resolveStoredName({ documentClient: deps.documentClient, tableName: deps.tableName, orgId }, owner.developerId, owner.name, writtenAt) };
}

/** ERASED-REJOIN-NAME: when the name `effectiveOwnerNamed` returns was written: the session's start for the session's own owner, the take-over's time for a taker. */
function effectiveOwnerWrittenAt(session: AgentSessionRecord, taskItem: Item | undefined): string {
  if (taskItem === undefined || !isTaskTakenOver(taskItem as unknown as DeveloperTaskRecord)) return session.createdAt;
  const owner = effectiveTaskOwner(taskItem as unknown as DeveloperTaskRecord);
  return owner.developerId === session.owner.developerId ? session.createdAt : takenOverSince(taskItem as unknown as DeveloperTaskRecord) ?? session.createdAt;
}

/** The id of `effectiveOwnerNamed`: access and the share notice read it. */
export function effectiveOwnerId(session: AgentSessionRecord, taskItem: Item | undefined): string {
  return effectiveOwnerNamed(session, taskItem).developerId;
}

/** `effectiveOwnerId`, reading the task of a task session (a task of another org is no task). */
export async function effectiveOwnerOf(deps: Pick<SessionAccessDependencies, "documentClient" | "tableName">, session: AgentSessionRecord): Promise<string> {
  if (session.subject.kind !== "task") return session.owner.developerId;
  const found = await getItem(deps, taskKey(session.subject.taskId));
  return effectiveOwnerId(session, found?.["orgId"] === session.orgId ? found : undefined);
}

// ---- the level

interface Computed { /** The caller's role on the session's project for a share, when asked for (`wantShareRole`). */ shareRole: ProjectRole | undefined; level: "none" | SessionLevel; /** The read-only path left out a project's Slack channel that could have changed a `none` level. */ undecided: boolean; owner: boolean; effectiveOwner: { developerId: string; name: string }; effectiveOwnerWrittenAt: string; projectRole: ProjectRole | undefined; memberRole: MemberRole | undefined; orgAdmin: boolean; orgRole: OrgRole }

async function compute(deps: SessionAccessDependencies, caller: SessionCaller, orgRole: OrgRole, session: AgentSessionRecord, options: SessionAccessOptions): Promise<Computed> {
  const { orgId } = caller;
  const readOnly = options.readOnlyPath === true;
  const isAdmin = isAdminRole(orgRole);
  const roles = options.memo?.roles ?? new Map<string, Promise<{ grant: ProjectRole | undefined; effective: ProjectRole | undefined; exact?: MemberRole | undefined }>>();
  const shareRoles = options.memo?.shareRoles ?? new Map<string, Promise<ProjectRole | undefined>>();
  /** The caller's role on a project: their own grant row, an org owner's or admin's maintainership, or (off the read-only path) the project's channel. */
  const roleOn = (project: string) => {
    const known = roles.get(project);
    if (known !== undefined) return known;
    const read = (async () => {
      const row = options.prefetch !== undefined ? undefined : await getItem(deps, projectMemberKey(orgId, caller.developerId, project));
      const grant = options.prefetch !== undefined ? options.prefetch.grant(project) : grantRoleOf(row);
      // An org owner or admin is a maintainer of every project whatever grant they hold; the grant only decides between `edit` and `view` (m-1).
      if (isAdmin) return { grant, effective: "maintainer" as ProjectRole };
      // Decision 103: the exact role beside its floor, so the permission table (not the floor) decides comments and the live Ask.
      if (grant !== undefined) return { grant, effective: grant, exact: grantMemberRoleOf(row) };
      if (readOnly) return { grant, effective: undefined };
      return { grant, effective: await deps.projectMembers.roleOf(orgId, project, { developerId: caller.developerId, orgRole }) };
    })();
    roles.set(project, read);
    return read;
  };

  /**
   * The caller's role on a project for a share to it: their own grant row, or (off the read-only path) the project's Slack channel. An org owner's or
   * admin's maintainership does not count, so a project share never reaches an admin who isn't in the project (answer 2, I5, m7).
   */
  const shareRoleOn = (project: string): Promise<ProjectRole | undefined> => {
    const known = shareRoles.get(project);
    if (known !== undefined) return known;
    const read = (async () => {
      const { grant, effective } = await roleOn(project);
      const role = await (async () => {
        if (!isAdmin) return effective;
        if (grant !== undefined || readOnly) return grant;
        return deps.projectMembers.roleOf(orgId, project, { developerId: caller.developerId, orgRole: "member" });
      })();
      // On the read-only path no grant means the project's Slack channel was not asked, and it could have made them a member of the project.
      if (readOnly && role === undefined) slackNotAsked = true;
      return role;
    })();
    shareRoles.set(project, read);
    return read;
  };

  // The task, for a task session. A task of another org is not this session's task (m15), and counts as no task.
  let taskItem: Item | undefined;
  if (session.subject.kind === "task") {
    const found = options.prefetch !== undefined ? options.prefetch.task(session.subject.taskId) : await getItem(deps, taskKey(session.subject.taskId));
    if (found?.["orgId"] === session.orgId) taskItem = found;
  }
  let slackNotAsked = false;
  const effectiveOwner = await shownEffectiveOwner(deps, orgId, effectiveOwnerNamed(session, taskItem), options, effectiveOwnerWrittenAt(session, taskItem));
  const owner = caller.developerId === effectiveOwner.developerId;

  const projectRole = session.project === undefined ? undefined : (await roleOn(session.project)).effective;
  const memberRole = session.kind === "task" && session.project !== undefined && projectRole === "viewer" && isWriterOrgRole(orgRole) ? (await roleOn(session.project)).exact : undefined;
  const grantRole = session.project === undefined ? undefined : (await roleOn(session.project)).grant;
  const orgAdmin = isAdmin && session.kind !== "local";

  let level: "none" | SessionLevel = owner ? "edit" : "none";
  if (session.kind === "task" && session.project !== undefined) {
    if (grantRole === "maintainer") level = best(level, "edit");
    else if (projectRole !== undefined) level = best(level, "view");
    else if (readOnly) slackNotAsked = true;
  } else if (session.kind === "chain") {
    if (deps.chainReadAccess !== undefined && await deps.chainReadAccess({ orgId, developerId: caller.developerId }, session)) level = best(level, "view");
    if (grantRole === "maintainer") level = best(level, "edit");
  }

  for (const share of options.prefetch !== undefined ? options.prefetch.shares(session) : await readSessionShares(deps, orgId, session.sessionId)) {
    const principal = share.principal;
    const applies = principal.kind === "org"
      || (principal.kind === "member" && principal.developerId === caller.developerId)
      || (principal.kind === "project" && await shareRoleOn(principal.project) !== undefined);
    if (applies) level = best(level, share.level);
  }

  let denied = false;
  if (taskItem !== undefined && session.subject.kind === "task") {
    const people = options.prefetch !== undefined ? options.prefetch.people(session.subject.taskId) : await readTaskPeople(deps, session.subject.taskId);
    const entry = people === undefined || people === "unreadable" ? people : people.get(caller.developerId);
    if (entry === "denied" || entry === "unreadable") { level = orgAdmin ? "view" : "none"; denied = true; }
    else if (entry === "owner") level = best(level, taskItem !== undefined && isTaskTakenOver(taskItem as unknown as DeveloperTaskRecord) ? "none" : "edit");
    else if (entry === "commenter") level = best(level, "use");
    else if (entry === "viewer") level = best(level, "view");
  }

  // A project viewer who isn't the owner only watches, whatever a share or a people entry says.
  if (!owner && projectRole === "viewer" && RANK[level] > RANK.view) level = "view";
  // I2: the Auditor reads and works on nothing, whatever it owns or is shared (an org or member share, a People entry). The routes hold it to an allow-list first; this keeps the access
  // answer itself read-only for every other surface (Slack, MCP, agent tools) that asks it.
  if (!isWriterOrgRole(orgRole) && RANK[level] > RANK.view) level = "view";
  const shareRole = options.wantShareRole === true && session.project !== undefined ? await shareRoleOn(session.project) : undefined;
  return { shareRole, level, undecided: level === "none" && slackNotAsked && !denied, owner, effectiveOwner, effectiveOwnerWrittenAt: effectiveOwnerWrittenAt(session, taskItem), projectRole, memberRole, orgAdmin, orgRole };
}

/**
 * What the caller may do with the session. `NOT_FOUND` for an id that isn't a session of the caller's org, a caller who isn't a current member of
 * it, and a caller with no level at all. The caller's org role is read from the member record each time, never from the token.
 */
export async function resolveSessionAccess(deps: SessionAccessDependencies, caller: SessionCaller, sessionId: string, options: SessionAccessOptions = {}): Promise<SessionAccess> {
  const id = SessionIdSchema.safeParse(sessionId);
  if (!id.success) throw NOT_FOUND();
  const session = await new AgentSessionStore(deps).get(caller.orgId, id.data);
  if (session === undefined) throw NOT_FOUND();
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) throw NOT_FOUND();
  return finish(session, await compute(deps, caller, role.data, session, options));
}

/**
 * The access of a person already known to be a member of the org (their `orgRole` read from their member record) to a session already read, with the same rules as
 * `resolveSessionAccess`; `access` is undefined for no level at all. With `prefetch` it asks the table nothing for the session's task, shares and people. `shareRole` is the
 * caller's role on the session's project for a share, when `wantShareRole` asked for it.
 */
export async function sessionAccessFor(
  deps: SessionAccessDependencies, caller: SessionCaller, orgRole: OrgRole, session: AgentSessionRecord, options: SessionAccessOptions = {},
): Promise<{ access: SessionAccess | undefined; shareRole: ProjectRole | undefined }> {
  const computed = await compute(deps, caller, orgRole, session, options);
  return { access: computed.level === "none" ? undefined : finish(session, computed), shareRole: computed.shareRole };
}

/** The level of a person already known to be a member (a follower's re-check). The read-only path unless `options` say otherwise; a follower the Slack channel covers needs the full one. */
export async function sessionLevelOf(deps: SessionAccessDependencies, caller: SessionCaller, session: AgentSessionRecord, options: SessionAccessOptions = { readOnlyPath: true }): Promise<"none" | SessionLevel> {
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return "none";
  return (await compute(deps, caller, role.data, session, options)).level;
}

/**
 * The level the live Ask reads for a person (the service's turn re-checks it, `ask-context.ts`): the session level, except that a collaborator who holds `view` reads as `use` FOR THE ASK ONLY (decision 103).
 * Never used for anything else.
 */
export async function sessionAskLevelOf(deps: SessionAccessDependencies, caller: SessionCaller, session: AgentSessionRecord, options: SessionAccessOptions = {}): Promise<"none" | SessionLevel> {
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return "none";
  const computed = await compute(deps, caller, role.data, session, options);
  return !computed.owner && computed.level === "view" && memberMay({ memberRole: computed.memberRole }, "use", { ask: true }) ? "use" : computed.level;
}

function finish(session: AgentSessionRecord, computed: Computed): SessionAccess {
  if (computed.level === "none") throw NOT_FOUND();
  return { session, level: computed.level, owner: computed.owner, effectiveOwner: computed.effectiveOwner, effectiveOwnerWrittenAt: computed.effectiveOwnerWrittenAt, orgAdmin: computed.orgAdmin, orgRole: computed.orgRole, ...(computed.projectRole === undefined ? {} : { projectRole: computed.projectRole }), ...(computed.memberRole === undefined ? {} : { memberRole: computed.memberRole }) };
}

export interface RequireOptions extends SessionAccessOptions {
  /** The action is a comment: a project viewer is refused even though it needs only `view`. */
  comment?: true;
  /** An org owner or admin may do this (Stop) although their level is only `view`. */
  orgAdminMay?: true;
  /** The action is the live Ask (`ask.ts`): it needs `use`, except that a collaborator may ask at `view` (decision 103). Its rates and caps are the Ask's own and are unchanged. */
  ask?: true;
}

/**
 * Decision 103: what a project member whose floor is a viewer may still do, by Cloud's permission table on their exact role: comment (the `comment` permission) and the live Ask (`ask`). Nothing else (no
 * steering, stopping, sharing, retrying, taking over or anything that uses an agent or starts work). A viewer's row has neither, so a viewer gets neither; a collaborator's has both.
 */
export function memberMay(access: { memberRole?: MemberRole | undefined }, needed: SessionLevel, options: Pick<RequireOptions, "comment" | "ask">): boolean {
  const role = access.memberRole;
  if (role === undefined) return false;
  return (options.comment === true && needed === "view" && memberAllows(role, "comment")) || (options.ask === true && needed === "use" && memberAllows(role, "ask"));
}

/**
 * The access, if the caller holds `needed` on the session. `action` completes "to <action>" ("stop it"). A project viewer who isn't the owner is
 * refused comments and every `use` and `edit` action with the viewer message. Short of the level (but at least `view`) is `SESSION_LEVEL_REQUIRED`
 * with what is needed and whom to ask; no level is `NOT_FOUND`.
 */
export async function requireSessionLevel(deps: SessionAccessDependencies, caller: SessionCaller, sessionId: string, needed: SessionLevel, action: string, options: RequireOptions = {}): Promise<SessionAccess> {
  return requireLevelOf(await resolveSessionAccess(deps, caller, sessionId, options), needed, action, options);
}

/** `requireSessionLevel`'s judgement of an access already worked out (for a session that exists, or one judged before it is made). */
export function requireLevelOf(access: SessionAccess, needed: SessionLevel, action: string, options: RequireOptions = {}): SessionAccess {
  // Decision 103: comment and the live Ask are permissions of their own; a member whose role grants one may do it with what any viewer holds (`view`). Its level is never raised for anything else.
  if (memberMay(access, needed, options) && atLeast(access.level, "view")) return access;
  if (!access.owner && access.projectRole === "viewer" && (needed !== "view" || options.comment === true)) {
    throw agentXError("SESSION_LEVEL_REQUIRED", sessionViewerOnlyMessage(access.session.project ?? "this project"));
  }
  if (options.orgAdminMay === true && access.orgAdmin) return access;
  if (!atLeast(access.level, needed)) throw agentXError("SESSION_LEVEL_REQUIRED", sessionLevelRequiredMessage(needed, action, access.effectiveOwner.name));
  return access;
}

/** The statuses a session can be retried from: the run failed or was cancelled. (A blocked workflow shows as needing a person; its summary says `workflowBlocked`, which also offers retry.) */
const RETRYABLE: readonly SessionStatus[] = ["failed", "cancelled"];
/** A blocked workflow reads as needing a person, or as paused when the task's budget also paused it; a stale flag on any other status offers nothing. */
const BLOCKED_STATUSES: readonly SessionStatus[] = ["needs_person", "paused"];

/** The hidden switch for offering "handoff" in a session's actions. Off: nothing finished leads a person into the Mac move. */
export const OFFER_HANDOFF = false as boolean;

/**
 * What the person may do, for the session's header: `view` watches and comments, `use` also steers, `edit` also stops, takes over (not the owner: they already own it) and shares, and retries a session that failed or was
 * cancelled, or whose workflow is blocked (`state` is the session's summary now). Handing off is the owner's.
 */
export function sessionActionsFor(access: Pick<SessionAccess, "level" | "owner" | "orgAdmin"> & { projectRole?: ProjectRole | undefined; memberRole?: MemberRole | undefined }, state: { status: SessionStatus; workflowBlocked?: true | undefined; closable?: true | undefined; /** The task was closed by its owner: nothing can be steered, stopped, retried, taken over, handed off or closed again (it can still be watched, commented on and, at edit level, shared). */ closed?: true | undefined;
  /** UX2 slice 2 item 6: the summary's status in the one status model. Merged or Closed reads as closed here too: Stop, Retry and steering are not offered where they don't apply. */ display?: unknown }): SessionAction[] {
  if (access.level === "none") return [];
  const shown = TaskStatusSchema.safeParse(state.display);
  // A run that ended by itself (cancelled) reads Closed but can still be retried (`retryable`); a merge or a task its owner closed cannot.
  if (shown.success && (shown.data.state === "merged" || (shown.data.state === "closed" && shown.data.retryable !== true))) state = { ...state, closed: true };
  // Share stays for an edit-level person: a closed task is still a record worth showing someone, and sharing it starts no work (the share route has its own checks).
  // Decision 103: a viewer-floor member whose role has the `comment` permission (a collaborator) watches and comments; a viewer only watches.
  const viewerActions: SessionAction[] = memberMay(access, "view", { comment: true }) ? ["watch", "comment"] : ["watch"];
  if (state.closed === true) return !access.owner && access.projectRole === "viewer" ? viewerActions : ["watch", "comment", ...(atLeast(access.level, "edit") ? ["share" as const] : [])];
  if (!access.owner && access.projectRole === "viewer") return viewerActions;
  const actions: SessionAction[] = ["watch", "comment"];
  if (atLeast(access.level, "use")) actions.push("steer");
  if (atLeast(access.level, "edit")) {
    actions.push("stop");
    if (RETRYABLE.includes(state.status) || (state.workflowBlocked === true && BLOCKED_STATUSES.includes(state.status))) actions.push("retry");
    // QA6-11: taking over means becoming the owner, so the owner is never offered it.
    if (!access.owner) actions.push("take_over");
    actions.push("share");
  }
  if (access.orgAdmin && !actions.includes("stop")) actions.push("stop");
  // Moving a session between a Mac and the cloud is unfinished (the move answers RUNTIME_UNAVAILABLE and no client pairs a Mac), so it is not offered (owner decision 14, 2026-11-07). The route and the action name stay.
  if (access.owner && OFFER_HANDOFF) actions.push("handoff");
  // Close is the task owner's (the route checks that on the task), and only where it has a task to close.
  if (access.owner && state.closable === true) actions.push("close");
  return actions;
}

/** Whether a session has a cloud task still open to close: a task session that has not ended (a chain run, a session on a Mac and an ended session have none). */
export function closableSession(session: Pick<AgentSessionRecord, "subject" | "kind" | "where" | "endedAt" | "summary">): true | undefined {
  if (session.subject.kind !== "task" || session.kind === "local" || session.where.kind !== "cloud" || session.endedAt !== undefined) return undefined;
  return (ENDED_SESSION_STATUSES as readonly string[]).includes(session.summary.status) ? undefined : true;
}
