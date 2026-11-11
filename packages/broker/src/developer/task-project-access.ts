import { AgentXNameSchema, SlackChannelBindingSchema, developerTaskPolicy, projectMemberKey, projectRevisionKey, slackBindingKey, type DeveloperTaskPolicy, type OrgId, type SlackChannelBinding } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import type { TaskAuthorityAdmission } from "../aws/task-authority-admission.js";

export interface ProjectAuthorityRevision {
  pk?: string;
  sk?: string;
  revision: number;
  definition: { developerTasks?: unknown };
}

export interface ProjectDeveloperMembership { pk?: string; sk?: string; projectName: string; role?: string }
/** A developer's org member row, as the people path reads it (Plan 2 final review I1): only an owner or admin changes the answer. */
export interface ProjectOrgMember { pk?: string; sk?: string; role?: string }
export interface ProjectChannelBinding extends SlackChannelBinding { pk?: string; sk?: string }
export interface ProjectAuthorityWitness {
  projectRevision: { pk: string; sk: string; revision: number; developerTasksPresent: boolean; developerTasks?: unknown };
  access: "granted" | "channel";
  membership?: { pk: string; sk: string; projectName: string; role: "developer" };
  /** Present, with no membership, when the person is granted by an org owner or admin role and holds no grant. */
  orgMember?: { pk: string; sk: string; role: "owner" | "admin" };
  binding?: { pk: string; sk: string; teamId: string; channelId: string; projectName: string; updatedAt: string };
}

export type ProjectAuthorityResult =
  | { kind: "allowed"; revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; witness?: ProjectAuthorityWitness }
  | { kind: "needs-membership"; channelIds: string[] }
  | { kind: "denied"; reason: "project-access" | "tasks-disabled" | "project-viewer"; visibleChannelIds: string[] }
  | { kind: "not-found" }
  | { kind: "unavailable" };

export type BoundedProjectReadAdmission = Pick<TaskAuthorityAdmission, "assertOpen" | "admitStateRead" | "remainingStateReads">;

export interface ProjectAuthorityReader {
  /** Use the supplied signal for page one; count each later Query page before issue. */
  latestRevision(orgId: OrgId, project: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ revision?: ProjectAuthorityRevision; complete: boolean }>;
  memberships(orgId: OrgId, developerId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly ProjectDeveloperMembership[]; complete: boolean }>;
  bindings(orgId: OrgId, teamId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ items: readonly ProjectChannelBinding[]; complete: boolean }>;
  /**
   * The developer's member row in the org (a consistent read). An owner or admin is a maintainer of every project in the org with no
   * grant, as `effectiveProjectRole` says. A reader without this method leaves the org role out, which only ever narrows access.
   */
  orgMember?(orgId: OrgId, developerId: string, admission: BoundedProjectReadAdmission, abortSignal: AbortSignal): Promise<{ item?: ProjectOrgMember; complete: boolean }>;
}

/** Pure policy evaluation. It performs no I/O, logging, name lookup, or human error decoration. */
export function evaluateProjectAuthority(input: {
  /** The org the project and grants are read in; a witnessed (developer and team) evaluation refuses rows keyed in any other. */
  orgId?: OrgId;
  project: string;
  developerId?: string;
  teamId?: string;
  revision?: ProjectAuthorityRevision;
  memberships: readonly ProjectDeveloperMembership[];
  bindings: readonly ProjectChannelBinding[];
  /** The developer's org member row. An owner or admin is granted with no project grant, and beats a viewer grant (final review I1). */
  orgMember?: ProjectOrgMember;
  freshMemberOf?: readonly string[];
  slackUserId?: string;
}): ProjectAuthorityResult {
  if (!AgentXNameSchema.safeParse(input.project).success || input.revision === undefined) return { kind: "not-found" };
  if (!Number.isSafeInteger(input.revision.revision) || input.revision.revision < 0) return { kind: "unavailable" };
  if (input.developerId !== undefined && input.teamId !== undefined) {
    if (input.orgId === undefined) return { kind: "unavailable" };
    const expected = projectRevisionKey(input.orgId, input.project, input.revision.revision);
    if (input.revision.pk !== expected.pk || input.revision.sk !== expected.sk) return { kind: "unavailable" };
  }
  if (input.developerId !== undefined && input.memberships.some((row) => {
    if (row.projectName !== input.project) return false;
    if (input.orgId === undefined) return true;
    const expected = projectMemberKey(input.orgId, input.developerId!, input.project);
    return row.pk !== expected.pk || row.sk !== expected.sk;
  })) return { kind: "unavailable" };
  if (input.teamId !== undefined && input.bindings.some((binding) => {
    if (binding.projectName !== input.project) return false;
    if (input.orgId === undefined) return true;
    const expected = slackBindingKey(input.orgId, input.teamId!, binding.channelId);
    return binding.pk !== expected.pk || binding.sk !== expected.sk || binding.teamId !== input.teamId;
  })) return { kind: "unavailable" };

  let orgMaintainer: { pk: string; sk: string; role: "owner" | "admin" } | undefined;
  if (input.orgMember !== undefined && (input.orgMember.role === "owner" || input.orgMember.role === "admin")) {
    if (input.orgId === undefined || input.developerId === undefined) return { kind: "unavailable" };
    const expected = orgMemberKey(input.orgId, input.developerId);
    if (input.orgMember.pk !== expected.pk || input.orgMember.sk !== expected.sk) return { kind: "unavailable" };
    orgMaintainer = { pk: expected.pk, sk: expected.sk, role: input.orgMember.role };
  }

  const policy = developerTaskPolicy(input.revision.definition);
  const matchingBindings = input.bindings.filter((binding) => binding.projectName === input.project);
  const channelIds = [...new Set(matchingBindings.map((binding) => binding.channelId))].sort();
  const membership = input.memberships.find((row) => row.projectName === input.project && row.role === "developer");
  const developerGrant = membership !== undefined;
  // A project viewer (an explicit grant of the viewer role) only views: the grant beats the channel, so the person gets neither the
  // authority to start or take part in work nor the channel's commenter role. The people path reads this refusal as "eligible, capped at viewer".
  if (!developerGrant && orgMaintainer === undefined && input.memberships.some((row) => row.projectName === input.project && row.role === "viewer")) {
    return { kind: "denied", reason: "project-viewer", visibleChannelIds: [] };
  }

  let access: "granted" | "channel" | undefined;
  let binding: ProjectChannelBinding | undefined;
  if (developerGrant || orgMaintainer !== undefined) access = "granted";
  else if (policy.channelMembersMayUse && input.slackUserId !== undefined && channelIds.length > 0) {
    if (input.freshMemberOf === undefined) return { kind: "needs-membership", channelIds };
    const memberOf = new Set(input.freshMemberOf);
    binding = matchingBindings.find((candidate) => memberOf.has(candidate.channelId));
    if (binding !== undefined) access = "channel";
  }

  if (access === undefined) return { kind: "denied", reason: "project-access", visibleChannelIds: channelIds };
  if (!policy.enabled) return { kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] };
  const revision = input.revision;
  const projectRevision = input.developerId !== undefined && input.teamId !== undefined
    && input.revision.pk !== undefined && input.revision.sk !== undefined ? {
    pk: revision.pk!, sk: revision.sk!, revision: revision.revision,
    developerTasksPresent: Object.hasOwn(revision.definition, "developerTasks"),
    ...(Object.hasOwn(revision.definition, "developerTasks") ? { developerTasks: structuredClone(revision.definition.developerTasks) } : {}),
  } : undefined;
  const witness: ProjectAuthorityWitness | undefined = projectRevision === undefined ? undefined : {
    projectRevision, access,
    ...(access === "granted" && membership?.pk !== undefined && membership.sk !== undefined ? { membership: { pk: membership.pk, sk: membership.sk, projectName: membership.projectName, role: "developer" as const } } : {}),
    ...(access === "granted" && !developerGrant && orgMaintainer !== undefined ? { orgMember: orgMaintainer } : {}),
    ...(access === "channel" && binding?.pk !== undefined && binding.sk !== undefined ? { binding: { pk: binding.pk, sk: binding.sk, teamId: binding.teamId, channelId: binding.channelId, projectName: binding.projectName, updatedAt: binding.updatedAt } } : {}),
  };
  if (witness !== undefined && ((access === "granted" && witness.membership === undefined && witness.orgMember === undefined) || (access === "channel" && witness.binding === undefined))) return { kind: "unavailable" };
  if (witness?.binding !== undefined && !SlackChannelBindingSchema.safeParse({
    teamId: witness.binding.teamId, channelId: witness.binding.channelId,
    projectName: witness.binding.projectName, updatedAt: witness.binding.updatedAt,
  }).success) return { kind: "unavailable" };
  return { kind: "allowed", revision: input.revision.revision, policy, access, channelIds, ...(witness === undefined ? {} : { witness }) };
}

/** Reads the bounded authority snapshot and refuses partial results as unavailable. */
export async function readProjectAuthority(
  reader: ProjectAuthorityReader,
  input: {
    orgId: OrgId;
    project: string;
    developerId: string;
    teamId: string;
    slackUserId?: string;
    freshMemberOf?: readonly string[];
    admission: BoundedProjectReadAdmission;
  },
): Promise<ProjectAuthorityResult> {
  if (!AgentXNameSchema.safeParse(input.project).success) return { kind: "not-found" };
  try {
    input.admission.assertOpen();
    const latest = await reader.latestRevision(input.orgId, input.project, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!latest.complete) return { kind: "unavailable" };
    if (latest.revision === undefined) return { kind: "not-found" };

    const memberships = await reader.memberships(input.orgId, input.developerId, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!memberships.complete) return { kind: "unavailable" };

    const bindings = await reader.bindings(input.orgId, input.teamId, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    if (!bindings.complete) return { kind: "unavailable" };

    // The org role needs a reader that can read it; one that cannot leaves the person to the grant and the channel alone.
    let orgMember: ProjectOrgMember | undefined;
    if (reader.orgMember !== undefined) {
      const found = await reader.orgMember(input.orgId, input.developerId, input.admission, input.admission.admitStateRead());
      input.admission.assertOpen();
      if (!found.complete) return { kind: "unavailable" };
      orgMember = found.item;
    }

    return evaluateProjectAuthority({
      orgId: input.orgId,
      project: input.project,
      developerId: input.developerId,
      teamId: input.teamId,
      revision: latest.revision,
      memberships: memberships.items,
      bindings: bindings.items,
      ...(orgMember === undefined ? {} : { orgMember }),
      ...(input.freshMemberOf === undefined ? {} : { freshMemberOf: input.freshMemberOf }),
      ...(input.slackUserId === undefined ? {} : { slackUserId: input.slackUserId }),
    });
  } catch {
    return { kind: "unavailable" };
  }
}
