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
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentPrincipalSchema,
  OrgRoleSchema,
  SessionIdSchema,
  SessionLevelSchema,
  agentSessionKey,
  agentXError,
  atLeast,
  orgMemberKey,
  projectMemberKey,
  sessionLevelRequiredMessage,
  sessionViewerOnlyMessage,
  type AgentPrincipal,
  type AgentSessionRecord,
  type OrgId,
  type OrgRole,
  type ProjectRole,
  type SessionLevel,
} from "@agentx/contracts";
import type { ProjectMembers } from "../agents/access.js";
import { grantRoleOf } from "../developer/project-roles.js";
import { taskKey } from "../developer/task-records.js";
import { AgentSessionStore } from "./store.js";

export interface SessionAccessDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** Only `roleOf` is used, and only off the read-only path: it may ask Slack whether the project's channel gives the caller a role. */
  projectMembers: Pick<ProjectMembers, "roleOf">;
  /** Plan 4's readers of a chain run (the starter, the run's owner, `view` on the chain and the project, org owners and admins). Without it only the owner and shares see a chain session. */
  chainReadAccess?: (caller: { orgId: OrgId; developerId: string }, session: AgentSessionRecord) => Promise<boolean>;
}

/** Who is asking: `DeveloperCaller` fits. Their org role is read from the org's member record, never taken from here. */
export interface SessionCaller { orgId: OrgId; developerId: string }

export interface SessionAccess {
  session: AgentSessionRecord;
  level: "none" | SessionLevel;
  /** The effective owner. */
  owner: boolean;
  projectRole?: ProjectRole;
  /** An org owner or admin, on a task or chain session: they may stop it (`view` plus Stop). */
  orgAdmin: boolean;
}

export type SessionAction = "watch" | "comment" | "steer" | "stop" | "retry" | "take_over" | "share" | "handoff";

export interface SessionAccessOptions {
  /** The realtime authorizer's path: grant rows, shares and the Task People item are read directly, and no Slack call is made. */
  readOnlyPath?: true;
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
type PeopleRole = "owner" | "commenter" | "viewer" | "denied";

/** The caller's entry in the task's people list: undefined for none, "unreadable" for a list that doesn't parse (which counts as a denial). */
async function peopleRoleOf(deps: SessionAccessDependencies, taskId: string, developerId: string): Promise<PeopleRole | "unreadable" | undefined> {
  const item = await getItem(deps, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
  if (item === undefined) return undefined;
  const people = item["people"];
  if (item["schemaVersion"] !== 1 || !Array.isArray(people)) return "unreadable";
  let found: PeopleRole | undefined;
  for (const entry of people as unknown[]) {
    const person = entry as { developerId?: unknown; role?: unknown } | null;
    if (typeof person !== "object" || person === null || typeof person.developerId !== "string" || typeof person.role !== "string" || !PEOPLE_ROLES.has(person.role)) return "unreadable";
    if (person.developerId === developerId) found = person.role as PeopleRole;
  }
  return found;
}

// ---- the level

interface Computed { level: "none" | SessionLevel; owner: boolean; projectRole: ProjectRole | undefined; orgAdmin: boolean }

async function compute(deps: SessionAccessDependencies, caller: SessionCaller, orgRole: OrgRole, session: AgentSessionRecord, options: SessionAccessOptions): Promise<Computed> {
  const { orgId } = caller;
  const readOnly = options.readOnlyPath === true;
  const isAdmin = isAdminRole(orgRole);
  const roles = new Map<string, Promise<{ grant: ProjectRole | undefined; effective: ProjectRole | undefined }>>();
  /** The caller's role on a project: their own grant row, an org owner's or admin's maintainership, or (off the read-only path) the project's channel. */
  const roleOn = (project: string) => {
    const known = roles.get(project);
    if (known !== undefined) return known;
    const read = (async () => {
      const grant = grantRoleOf(await getItem(deps, projectMemberKey(orgId, caller.developerId, project)));
      if (grant !== undefined) return { grant, effective: grant };
      if (isAdmin) return { grant, effective: "maintainer" as ProjectRole };
      if (readOnly) return { grant, effective: undefined };
      return { grant, effective: await deps.projectMembers.roleOf(orgId, project, { developerId: caller.developerId, orgRole }) };
    })();
    roles.set(project, read);
    return read;
  };

  // The task, for a task session. A task of another org is not this session's task (m15), and counts as no task.
  let taskItem: Item | undefined;
  if (session.subject.kind === "task") {
    const found = await getItem(deps, taskKey(session.subject.taskId));
    if (found?.["orgId"] === session.orgId) taskItem = found;
  }
  const taken = (taskItem?.["currentOwner"] as { developerId?: unknown } | undefined)?.developerId;
  const effectiveOwner = typeof taken === "string" ? taken : session.owner.developerId;
  const owner = caller.developerId === effectiveOwner;

  const projectRole = session.project === undefined ? undefined : (await roleOn(session.project)).effective;
  const grantRole = session.project === undefined ? undefined : (await roleOn(session.project)).grant;
  const orgAdmin = isAdmin && session.kind !== "local";

  let level: "none" | SessionLevel = owner ? "edit" : "none";
  if (session.kind === "task" && session.project !== undefined) {
    if (grantRole === "maintainer") level = best(level, "edit");
    else if (projectRole !== undefined || orgAdmin) level = best(level, "view");
  } else if (session.kind === "chain") {
    if (deps.chainReadAccess !== undefined && await deps.chainReadAccess({ orgId, developerId: caller.developerId }, session)) level = best(level, "view");
    if (grantRole === "maintainer") level = best(level, "edit");
  }

  for (const share of await readSessionShares(deps, orgId, session.sessionId)) {
    const principal = share.principal;
    const applies = principal.kind === "org"
      || (principal.kind === "member" && principal.developerId === caller.developerId)
      || (principal.kind === "project" && (await roleOn(principal.project)).effective !== undefined);
    if (applies) level = best(level, share.level);
  }

  if (taskItem !== undefined && session.subject.kind === "task") {
    const entry = await peopleRoleOf(deps, session.subject.taskId, caller.developerId);
    if (entry === "denied" || entry === "unreadable") level = orgAdmin ? "view" : "none";
    else if (entry === "owner") level = best(level, taken === undefined ? "edit" : "none");
    else if (entry === "commenter") level = best(level, "use");
    else if (entry === "viewer") level = best(level, "view");
  }

  // A project viewer who isn't the owner only watches, whatever a share or a people entry says.
  if (!owner && projectRole === "viewer" && RANK[level] > RANK.view) level = "view";
  return { level, owner, projectRole, orgAdmin };
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

/** The level of a person already known to be a member (a follower's re-check), through the read-only path. */
export async function sessionLevelOf(deps: SessionAccessDependencies, caller: SessionCaller, session: AgentSessionRecord): Promise<"none" | SessionLevel> {
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return "none";
  return (await compute(deps, caller, role.data, session, { readOnlyPath: true })).level;
}

function finish(session: AgentSessionRecord, computed: Computed): SessionAccess {
  if (computed.level === "none") throw NOT_FOUND();
  return { session, level: computed.level, owner: computed.owner, orgAdmin: computed.orgAdmin, ...(computed.projectRole === undefined ? {} : { projectRole: computed.projectRole }) };
}

export interface RequireOptions extends SessionAccessOptions {
  /** The action is a comment: a project viewer is refused even though it needs only `view`. */
  comment?: true;
  /** An org owner or admin may do this (Stop) although their level is only `view`. */
  orgAdminMay?: true;
}

/**
 * The access, if the caller holds `needed` on the session. `action` completes "to <action>" ("stop it"). A project viewer who isn't the owner is
 * refused comments and every `use` and `edit` action with the viewer message. Short of the level (but at least `view`) is `SESSION_LEVEL_REQUIRED`
 * with what is needed and whom to ask; no level is `NOT_FOUND`.
 */
export async function requireSessionLevel(deps: SessionAccessDependencies, caller: SessionCaller, sessionId: string, needed: SessionLevel, action: string, options: RequireOptions = {}): Promise<SessionAccess> {
  const access = await resolveSessionAccess(deps, caller, sessionId, options);
  if (!access.owner && access.projectRole === "viewer" && (needed !== "view" || options.comment === true)) {
    throw agentXError("SESSION_LEVEL_REQUIRED", sessionViewerOnlyMessage(access.session.project ?? "this project"));
  }
  if (options.orgAdminMay === true && access.orgAdmin) return access;
  if (!atLeast(access.level, needed)) throw agentXError("SESSION_LEVEL_REQUIRED", sessionLevelRequiredMessage(needed, action, access.session.owner.name));
  return access;
}

/** What the person may do, for the session's header: `view` watches and comments, `use` also steers, `edit` also stops, retries, takes over and shares. Handing off is the owner's. */
export function sessionActionsFor(access: Pick<SessionAccess, "level" | "owner" | "orgAdmin"> & { projectRole?: ProjectRole | undefined }): SessionAction[] {
  if (access.level === "none") return [];
  if (!access.owner && access.projectRole === "viewer") return ["watch"];
  const actions: SessionAction[] = ["watch", "comment"];
  if (atLeast(access.level, "use")) actions.push("steer");
  if (atLeast(access.level, "edit")) actions.push("stop", "retry", "take_over", "share");
  if (access.orgAdmin && !actions.includes("stop")) actions.push("stop");
  if (access.owner) actions.push("handoff");
  return actions;
}

