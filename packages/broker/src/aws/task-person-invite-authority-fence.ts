import { isDeepStrictEqual } from "node:util";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { orgOfProjectPk, projectMemberKey, projectRevisionKey, slackBindingPk, SLACK_BINDING_SK_PREFIX } from "@rovara-code/contracts";
import type { ProjectAuthorityWitness } from "../developer/task-project-access.js";

export type TaskPersonProjectAuthorityWitness = ProjectAuthorityWitness & {
  taskId: string;
  developerId: string;
  project: string;
};

export type TaskPersonInviteStateCondition =
  | {
    kind: "project-revision";
    pk: string;
    sk: string;
    revision: number;
    developerTasksPresent: boolean;
    developerTasks?: unknown;
  }
  | { kind: "developer-grant"; pk: string; sk: string; projectName: string; role: "developer" }
  /** The org member row of an owner or admin with no grant: the row must still be the person's and still hold the owner or admin role. */
  | { kind: "org-role"; pk: string; sk: string; developerId: string }
  | { kind: "channel-binding"; pk: string; sk: string; teamId: string; channelId: string; projectName: string; updatedAt: string };

function projectRevisionCondition(witness: TaskPersonProjectAuthorityWitness, project: string): TaskPersonInviteStateCondition | undefined {
  const revision = witness.projectRevision;
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 0) return undefined;
  // The witness's org is the one its revision key names; the grant key must name the same one.
  const orgId = orgOfProjectPk(revision.pk);
  if (orgId === undefined) return undefined;
  const expected = projectRevisionKey(orgId, project, revision.revision);
  if (revision.pk !== expected.pk || revision.sk !== expected.sk || typeof revision.developerTasksPresent !== "boolean") return undefined;
  const hasValue = Object.hasOwn(revision, "developerTasks");
  if (revision.developerTasksPresent !== hasValue) return undefined;
  return {
    kind: "project-revision", pk: revision.pk, sk: revision.sk, revision: revision.revision,
    developerTasksPresent: revision.developerTasksPresent,
    ...(revision.developerTasksPresent ? { developerTasks: structuredClone(revision.developerTasks) } : {}),
  };
}

function positiveRowCondition(
  witness: TaskPersonProjectAuthorityWitness,
  project: string,
  teamId: string,
): TaskPersonInviteStateCondition | undefined {
  if (witness.access === "granted") {
    const membership = witness.membership;
    const orgId = orgOfProjectPk(witness.projectRevision.pk);
    if (membership === undefined && witness.orgMember !== undefined) {
      const expectedOrgMember = orgId === undefined ? undefined : orgMemberKey(orgId, witness.developerId);
      if (witness.binding !== undefined || expectedOrgMember === undefined || witness.orgMember.pk !== expectedOrgMember.pk
        || witness.orgMember.sk !== expectedOrgMember.sk || (witness.orgMember.role !== "owner" && witness.orgMember.role !== "admin")) return undefined;
      return { kind: "org-role", pk: expectedOrgMember.pk, sk: expectedOrgMember.sk, developerId: witness.developerId };
    }
    if (witness.orgMember !== undefined) return undefined;
    const expected = orgId === undefined ? undefined : projectMemberKey(orgId, witness.developerId, project);
    if (membership === undefined || witness.binding !== undefined || expected === undefined
      || membership.pk !== expected.pk || membership.sk !== expected.sk
      || membership.projectName !== project || membership.role !== "developer") return undefined;
    return { kind: "developer-grant", pk: membership.pk, sk: membership.sk, projectName: membership.projectName, role: membership.role };
  }
  const binding = witness.binding;
  const bindingOrg = orgOfProjectPk(witness.projectRevision.pk);
  if (binding === undefined || witness.membership !== undefined || bindingOrg === undefined
    || binding.pk !== slackBindingPk(bindingOrg, teamId) || binding.sk !== `${SLACK_BINDING_SK_PREFIX}${binding.channelId}`
    || binding.teamId !== teamId || binding.projectName !== project || typeof binding.updatedAt !== "string"
    || binding.updatedAt.length === 0) return undefined;
  return {
    kind: "channel-binding", pk: binding.pk, sk: binding.sk, teamId: binding.teamId,
    channelId: binding.channelId, projectName: binding.projectName, updatedAt: binding.updatedAt,
  };
}

/** Derives the exact positive State predicates required alongside an invitation receipt CAS. */
export function taskPersonInviteStateConditions(input: {
  taskId: string;
  project: string;
  teamId: string;
  actor: TaskPersonProjectAuthorityWitness;
  target: TaskPersonProjectAuthorityWitness;
}): readonly TaskPersonInviteStateCondition[] | undefined {
  const { taskId, project, teamId, actor, target } = input;
  if (actor.taskId !== taskId || target.taskId !== taskId || actor.project !== project || target.project !== project
    || !/^[a-f0-9]{64}$/.test(actor.developerId) || !/^[a-f0-9]{64}$/.test(target.developerId)) return undefined;
  const actorRevision = projectRevisionCondition(actor, project);
  const targetRevision = projectRevisionCondition(target, project);
  const actorRow = positiveRowCondition(actor, project, teamId);
  const targetRow = positiveRowCondition(target, project, teamId);
  if (actorRevision === undefined || targetRevision === undefined || actorRow === undefined || targetRow === undefined
    || !isDeepStrictEqual(actorRevision, targetRevision)) return undefined;

  const conditions: TaskPersonInviteStateCondition[] = [];
  const keyed = new Map<string, TaskPersonInviteStateCondition>();
  for (const condition of [actorRevision, actorRow, targetRow]) {
    const key = `${condition.pk}\0${condition.sk}`;
    const previous = keyed.get(key);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous, condition)) return undefined;
      continue;
    }
    keyed.set(key, condition);
    conditions.push(condition);
  }
  return conditions;
}
