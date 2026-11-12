// A-32 and A-33 (srv/project-people): the web's People tab of a project. `GET /v1/app/projects/{p}/people` (the roster, its revision and the viewer's powers, for anyone who
// can see the project) and `PUT|DELETE /v1/app/projects/{p}/people/{developerId}` (browser-session only, under the revision the viewer read). The writes are the CLI's own
// store functions (`setProjectMember`, `removeProjectMember` in org/project-members.ts): the same who-may (`manage_members`: a maintainer of the project, or a company owner or
// admin), the same "only a company member" rule, the same request-id replay, audit and approval bookkeeping, and the one last-maintainer rule. Code settings keep their own
// route (`PUT .../code-settings`); this read only tells the web which of those the viewer may change.
import { agentXError, projectAllows, type ProjectRole } from "@rovara-code/contracts";
import { PROJECT_PEOPLE_BROWSER_MESSAGE, PutProjectPersonBodySchema, projectRoleFloor, RemoveProjectPersonBodySchema, type ProjectPeopleRole, type ProjectPeopleView, type ProjectPeopleViewer, type ProjectPersonChangeResponse, type ProjectPersonRemoveResponse } from "@agentx/cloud-contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { maintainsByGrant, projectOpenState, readPeopleRevision, removeProjectMember, setProjectMember, type ProjectMemberChangeDependencies } from "../../org/project-members.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { bodyError } from "./common.js";
import { projectMembersDepsOf } from "./project-list.js";
import { notifyProjectMemberChanged, projectMemberRoleForRoute, projectRoleForRoute, readProjectMembers } from "./project-members.js";

const PEOPLE_PATH = /^\/v1\/app\/projects\/([^/]+)\/people(?:\/([a-f0-9]{64}))?$/;
export const isProjectPeoplePath = (pathname: string): boolean => PEOPLE_PATH.test(pathname);

const ALL_ROLES: readonly ProjectRole[] = ["maintainer", "contributor", "viewer"];
/** Collaborator role (W11): whoever may manage people (a maintainer of the project, or a company owner or admin, who is one by company role) may give any of Cloud's four roles. Invites stay three. */
const ASSIGNABLE_ROLES: readonly ProjectPeopleRole[] = ["maintainer", "contributor", "collaborator", "viewer"];
const MAINTAINER_INVITE_ROLES: readonly ProjectRole[] = ["contributor", "viewer"];
const MANAGE_MESSAGE = "only a project maintainer can change who is in a project";

const isCompanyAdmin = (caller: Pick<DeveloperCaller, "orgRole">): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** What the viewer may do here, from their live project role (read on this request) and their company role. */
export function peopleViewerOf(caller: Pick<DeveloperCaller, "orgRole">, role: ProjectRole, open: boolean, exact?: ProjectPeopleRole, maintainerByGrant = false): ProjectPeopleViewer {
  const manage = projectAllows(role, "manage_members");
  const admin = isCompanyAdmin(caller);
  // Review L5: exactly the invite store's rule: an owner or admin, or a company member who maintains the project by their own grant (not through a Slack channel).
  const canInvite = open && (admin || (caller.orgRole === "member" && maintainerByGrant));
  // Display only: every power above and below is judged on the floor `role`, never on the exact role.
  const projectRole: ProjectPeopleRole = exact ?? role;
  return {
    role, projectRole, canManageMembers: manage, assignableRoles: manage ? [...ASSIGNABLE_ROLES] : [],
    canInvite, invitableRoles: !canInvite ? [] : admin ? [...ALL_ROLES] : [...MAINTAINER_INVITE_ROLES],
    canEditCodeSettings: projectAllows(role, "edit_settings"), canConfirmSelfApproval: admin,
  };
}

/** The store's dependencies for a change: the members' reads, the clock and the audit ledger (required here: the web's change is always recorded). */
function changeDepsOf(deps: DeveloperRouteDependencies): ProjectMemberChangeDependencies {
  if (deps.audit === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Changing a project's people isn't available right now.");
  return { ...projectMembersDepsOf(deps), now: () => new Date(deps.now()), audit: deps.audit };
}

/** `GET .../people`: the roster with the revision read FIRST, so a change in between makes the web's next write stale rather than silently based on an older roster. */
async function getProjectPeople(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<ProjectPeopleView> {
  // Review L1: one read of the caller's role (the exact role and its floor together), so the page never shows a floor and an exact role that disagree.
  const { name, role, memberRole } = await projectMemberRoleForRoute(deps, caller, rawName);
  const revision = await readPeopleRevision(deps, caller.orgId, name);
  const { members } = await readProjectMembers(deps, caller, name);
  const open = await projectOpenState(deps, caller.orgId, name) === "open";
  // Review (b): the caller's OWN id only, the id set the invite store (`createInvite`) and the invite route's authority read; a grant on a merged-away id counts on neither side.
  const byGrant = await maintainsByGrant(deps, caller.orgId, caller.developerId, name);
  return { project: name, members, revision, viewer: peopleViewerOf(caller, role, open, memberRole, byGrant) };
}

async function putProjectPerson(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectPersonChangeResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MESSAGE);
  const parsed = PutProjectPersonBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const changeDeps = changeDepsOf(deps);
  const member = await setProjectMember(changeDeps, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, role: parsed.data.role, actor: { developerId: caller.developerId }, expectedRevision: parsed.data.expectedRevision,
  });
  logDeveloperEvent({ event: "developer.project_member_set", orgId: caller.orgId, project: name, role: member.role, via: "web" });
  await notifyProjectMemberChanged(deps, caller.orgId, name, member.developerId);
  // A replay of a request the CLI's route stored before 0.5.14 has no revision: the current one is the answer's.
  // `role` is the floor (a collaborator's is viewer) for clients that read only it; `projectRole` the exact role.
  return { member: { developerId: member.developerId, role: projectRoleFloor(member.role), projectRole: member.role }, revision: member.revision ?? await readPeopleRevision(deps, caller.orgId, name) };
}

async function deleteProjectPerson(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectPersonRemoveResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MESSAGE);
  const parsed = RemoveProjectPersonBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const changeDeps = changeDepsOf(deps);
  const removed = await removeProjectMember(changeDeps, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, actor: { developerId: caller.developerId }, expectedRevision: parsed.data.expectedRevision,
  });
  logDeveloperEvent({ event: "developer.project_member_removed", orgId: caller.orgId, project: name, removed: String(removed.removed), via: "web" });
  await notifyProjectMemberChanged(deps, caller.orgId, name, removed.developerId);
  return { developerId: removed.developerId, removed: removed.removed, revision: removed.revision ?? await readPeopleRevision(deps, caller.orgId, name) };
}

/** The people routes, or undefined for any other path or method. The dispatcher refuses a non-browser caller before authentication; this checks again. */
export async function routeProjectPeople(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, pathname: string, body: () => unknown): Promise<unknown> {
  const match = PEOPLE_PATH.exec(pathname);
  if (match === null) return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", PROJECT_PEOPLE_BROWSER_MESSAGE);
  const [, project, developerId] = match;
  if (method === "GET" && developerId === undefined) return getProjectPeople(deps, caller, project!);
  if (method === "PUT" && developerId !== undefined) return putProjectPerson(deps, caller, project!, developerId, body());
  if (method === "DELETE" && developerId !== undefined) return deleteProjectPerson(deps, caller, project!, developerId, body());
  return undefined;
}
