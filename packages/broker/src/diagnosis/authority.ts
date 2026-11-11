// Live interaction F2: who may ask for a diagnosis of an error, and who may read one. Read live, every time (a person whose "can use" ended, or who was removed, gets nothing).
//   an error of a task or a session   "can use" on the task's session (owner, co-owners, commenters, maintainers; not a viewer, a view-only share or the Auditor);
//   an error of a project             a maintainer of the project (an organization owner or admin counts as one);
//   an error of a connector           not offered here: no row reports one yet, and an organization-level error is an admin's to read.
// A diagnosis is a read and a proposal, so it needs no fresh sign-in.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgMemberKey } from "@agentx/cloud-contracts";
import { projectAllows, type ErrorRef, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { sessionLevelOf, type SessionAccessDependencies } from "../agent-sessions/access.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";

export interface DiagnosisAuthorityDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Session levels and project roles, the same dependencies every session route reads them with. */
  access: SessionAccessDependencies;
}

export interface DiagnosisSubjectFacts {
  project: string;
  /** The task the error is about, when it is about one. */
  task?: DeveloperTaskRecord | undefined;
}

const getItem = async (deps: Pick<DiagnosisAuthorityDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;

/** The person's role in the project for settings: an organization owner or admin is a maintainer of every project; anyone else has their own role, read now. */
export async function maintainerOf(deps: DiagnosisAuthorityDependencies, caller: { orgId: OrgId; developerId: string }, project: string): Promise<ProjectRole | undefined> {
  const member = await getItem(deps, orgMemberKey(caller.orgId, caller.developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return undefined;
  if (role.data === "owner" || role.data === "admin") return "maintainer";
  const found = await deps.access.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: role.data });
  return found !== undefined && projectAllows(found, "edit_settings") ? found : undefined;
}

/**
 * What the person may diagnose: the project and (for a task error) the task, or undefined. Fails closed: an unreadable task, a task of another org, a session with no level, or a subject this
 * lane does not offer all answer undefined, and the route then says only that the person cannot ask.
 */
export async function diagnosisSubjectFor(deps: DiagnosisAuthorityDependencies, caller: { orgId: OrgId; developerId: string }, ref: ErrorRef): Promise<DiagnosisSubjectFacts | undefined> {
  const subject = ref.subject;
  try {
    if ("taskId" in subject || "sessionId" in subject) {
      let task: DeveloperTaskRecord | undefined;
      if ("taskId" in subject) task = (await getItem(deps, taskKey(subject.taskId))) as DeveloperTaskRecord | undefined;
      else {
        const session = await new AgentSessionStore(deps.access).get(caller.orgId, subject.sessionId);
        if (session?.subject.kind !== "task") return undefined;
        task = (await getItem(deps, taskKey(session.subject.taskId))) as DeveloperTaskRecord | undefined;
      }
      if (task === undefined || task.orgId !== caller.orgId || task.sessionId === undefined) return undefined;
      const session = await new AgentSessionStore(deps.access).get(caller.orgId, task.sessionId);
      if (session === undefined || session.subject.kind !== "task" || session.subject.taskId !== task.taskId) return undefined;
      const level = await sessionLevelOf(deps.access, caller, session, {});
      return level === "use" || level === "edit" ? { project: task.project, task } : undefined;
    }
    if ("project" in subject) return (await maintainerOf(deps, caller, subject.project)) === undefined ? undefined : { project: subject.project };
  } catch {
    return undefined;
  }
  return undefined;
}
