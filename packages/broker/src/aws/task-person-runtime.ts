import { isDeepStrictEqual } from "node:util";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { TASK_PERSON_DEVELOPER_RECORD_PROJECTION, orgMemberKey, orgRemovedKey } from "@agentx/cloud-contracts";
import { SlackTeamIdSchema, agentXError, type OrgId, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@rovara-code/contracts";
import {
  checkTaskPersonIdentity,
  type ProjectAccessSubject,
  type TaskPersonIdentityDependencies,
} from "../developer/task-person-identity.js";
import type { ProjectAuthorityReader, ProjectAuthorityWitness } from "../developer/task-project-access.js";
import { isRemovedFromOrg } from "../org/member-removal/guards.js";
import { explicitMemberRole, signInReaderFromRecords } from "../org/explicit-member.js";
import { orgOf } from "../org/resolve.js";
import { readProjectAuthority } from "../developer/task-project-access.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { effectiveTaskOwner, isTaskTakenOver, ownerActorIdOf, taskOwnerKey } from "../developer/task-records.js";
import { META, type DeveloperRecord } from "../developer/store.js";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";

export const TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES = TASK_PERSON_DEVELOPER_RECORD_PROJECTION;

export type TaskPersonDeveloperRecordProjection = { pk: string; sk: string } & Pick<DeveloperRecord,
  "developerId" | "provider" | "issuer" | "subject" | "slackUserId" | "revoked" | "mergedInto" | "displayName">;

export interface TaskPersonRuntimePorts {
  /** Reads only a task-partition META, PERSON_SUBJECT#<developerId>, or PERSON#<UUID> row. */
  readTaskRecord(input: { taskId: string; sortKey: string; abortSignal: AbortSignal }): Promise<Record<string, unknown> | undefined>;
  /** Strong DEVELOPER#<developerId>/META read with the exact projected fields named here. */
  readDeveloperRecord(input: {
    developerId: string;
    consistentRead: true;
    projection: typeof TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES;
    abortSignal: AbortSignal;
  }): Promise<TaskPersonDeveloperRecordProjection | undefined>;
  /** Exact PROJECT#revision, MEMBER#developerId, and SLACK_BINDING#teamId query adapter. */
  projectAuthorityReader: ProjectAuthorityReader;
  /**
   * Strong read, projected to `pk` and `sk`, of only the task person's org member row or removal tombstone (`orgMemberKey`, `orgRemovedKey`): the member-removal check a
   * qualification makes (org/member-removal/guards.ts).
   */
  readOrgRecord(input: { key: { pk: string; sk: string }; abortSignal: AbortSignal }): Promise<Record<string, unknown> | undefined>;
  /** Dedicated fresh proof capability with measured usage; no mixed Identity fallback is accepted. */
  taskPersonProof(
    request: TaskPersonProofRequest,
    admission: TaskAuthorityAdmission,
  ): Promise<{ result: TaskPersonProofResponse; slackCallsUsed: number }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The org a task belongs to: its own `orgId` when it has one, else the install's single org. */
const taskOrg = (fallback: OrgId, task: DeveloperTaskRecord): OrgId => orgOf(fallback, task as unknown as Record<string, unknown>);
const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
const refused = () => agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");

function projectedDeveloperRecord(record: TaskPersonDeveloperRecordProjection | undefined, developerId: string): DeveloperRecord | undefined {
  if (record === undefined) return undefined;
  // The row is keyed by the person: a sign-in writes no `developerId` attribute (store.ts getDeveloper), so the id comes from the key and only a row naming someone else is refused.
  if (record.pk !== `DEVELOPER#${developerId}` || record.sk !== META || (record.developerId !== undefined && record.developerId !== developerId)) return undefined;
  // Keep the runtime value limited even when an injected adapter returns a structurally wider row.
  return {
    pk: record.pk, sk: record.sk, developerId,
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    ...(record.issuer === undefined ? {} : { issuer: record.issuer }),
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }),
    ...(record.revoked === undefined ? {} : { revoked: record.revoked }),
    ...(record.mergedInto === undefined ? {} : { mergedInto: record.mergedInto }),
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
  } as unknown as DeveloperRecord;
}

/**
 * A sign-in row read, bounded: the person's own, and the row of anyone an earlier row said they were merged into (so the membership check can follow a merge to the survivor, and no other
 * row is read). Records the merge target it finds so the next read is allowed.
 */
function developerRecordReader(input: { admission: TaskAuthorityAdmission; ports: TaskPersonRuntimePorts; reachableIds: Set<string> }) {
  return async (targetDeveloperId: string): Promise<DeveloperRecord | undefined> => {
    if (!input.reachableIds.has(targetDeveloperId)) throw unavailable();
    const record = await input.ports.readDeveloperRecord({
      developerId: targetDeveloperId,
      consistentRead: true,
      projection: TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES,
      abortSignal: input.admission.admitStateRead(),
    });
    input.admission.assertOpen();
    const projected = projectedDeveloperRecord(record, targetDeveloperId);
    if (typeof projected?.mergedInto === "string" && /^[a-f0-9]{64}$/.test(projected.mergedInto)) input.reachableIds.add(projected.mergedInto);
    return projected;
  };
}

function identityDocumentClient(input: {
  orgId: OrgId;
  taskId: string;
  developerId: string;
  stateTableName: string;
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
  /** The person's id and the people their sign-in rows say they were merged into so far: the ids whose member rows the membership check may read. */
  reachableIds: ReadonlySet<string>;
}): TaskPersonIdentityDependencies["documentClient"] {
  const linkedPersonIds = new Set<string>();
  return {
    async send(command: unknown): Promise<unknown> {
      if (!(command instanceof GetCommand)) throw unavailable();
      const query = command.input;
      if (query.ConsistentRead !== true || query.TableName !== input.stateTableName) throw unavailable();
      const key = query.Key as { pk?: unknown; sk?: unknown } | undefined;
      // The membership and removal checks read the member rows of the person and of the people they were merged into, and the person's own tombstone, and nothing else outside the task.
      const orgRecord = [...[...input.reachableIds].map((id) => orgMemberKey(input.orgId, id)), orgRemovedKey(input.orgId, input.developerId)]
        .find((allowed) => key?.pk === allowed.pk && key.sk === allowed.sk);
      if (orgRecord !== undefined) {
        const abortSignal = input.admission.admitStateRead();
        const item = await input.ports.readOrgRecord({ key: orgRecord, abortSignal });
        input.admission.assertOpen();
        if (item !== undefined && (item.pk !== orgRecord.pk || item.sk !== orgRecord.sk)) throw unavailable();
        return item === undefined ? {} : { Item: item };
      }
      if (key?.pk !== `DEVTASK#${input.taskId}` || typeof key.sk !== "string") throw unavailable();
      const isSubject = key.sk === `PERSON_SUBJECT#${input.developerId}`;
      const personId = key.sk.startsWith("PERSON#") ? key.sk.slice("PERSON#".length) : undefined;
      const allowed = key.sk === "META" || isSubject
        || (personId !== undefined && linkedPersonIds.has(personId));
      if (!allowed) throw unavailable();
      const abortSignal = input.admission.admitStateRead();
      const item = await input.ports.readTaskRecord({ taskId: input.taskId, sortKey: key.sk, abortSignal });
      input.admission.assertOpen();
      if (isSubject && item !== undefined && item.pk === key.pk && item.sk === key.sk
        && item.developerId === input.developerId && typeof item.personId === "string" && UUID.test(item.personId)) {
        linkedPersonIds.add(item.personId);
      }
      return item === undefined ? {} : { Item: item };
    },
  };
}

function identityDependencies(input: {
  orgId: OrgId;
  task: DeveloperTaskRecord;
  developerId: string;
    stateTableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  trustedCaller?: TaskPersonIdentityDependencies["trustedCaller"];
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
  onProjectAuthority(witness: ProjectAuthorityWitness): void;
}): TaskPersonIdentityDependencies {
  const { task, developerId, slackTeamId, admission, ports } = input;
  const reachableIds = new Set<string>([developerId]);
  const readBindings = async (project: string): Promise<readonly string[]> => {
    admission.assertOpen();
    const result = await ports.projectAuthorityReader.bindings(input.orgId, slackTeamId, admission, admission.admitStateRead());
    admission.assertOpen();
    if (!result.complete) throw unavailable();
    return result.items.filter((binding) => binding.projectName === project).map((binding) => binding.channelId).sort();
  };
  return {
    documentClient: identityDocumentClient({ orgId: input.orgId, taskId: task.taskId, developerId, stateTableName: input.stateTableName, admission, ports, reachableIds }),
    tableName: input.stateTableName,
    installOrgId: input.orgId,
    slackTeamId,
    now: () => input.now(),
    uuid: () => input.uuid(),
    taskPersonProof: async (request) => {
      admission.assertOpen();
      if (admission.remainingSlackCalls() <= 0) throw unavailable();
      const measured = await ports.taskPersonProof(request, admission);
      admission.recordSlackUsage(measured.slackCallsUsed);
      admission.assertOpen();
      if (measured.slackCallsUsed === 0
        && (measured.result.ok || (!measured.result.ok && measured.result.error === "ineligible"))) throw unavailable();
      return measured.result;
    },
    developerRecord: developerRecordReader({ admission, ports, reachableIds }),
    projectChannelIds: readBindings,
    targetProjectAccess: async (subject: ProjectAccessSubject, project: string, freshMemberOf: readonly string[]) => {
      const result = await readProjectAuthority(ports.projectAuthorityReader, {
        orgId: input.orgId,
        project,
        developerId: subject.developerId,
        teamId: slackTeamId,
        freshMemberOf,
        ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        admission,
      });
      if (result.kind === "allowed") {
        if (result.witness === undefined) throw unavailable();
        input.onProjectAuthority(result.witness);
        return;
      }
      if (result.kind === "denied" && result.reason === "project-viewer") return "viewer";
      if (result.kind === "denied" && result.reason === "project-access") throw refused();
      if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", "task person project was not found");
      if (result.kind === "denied" && result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", "task person project tasks are disabled");
      throw unavailable();
    },
    ...(input.trustedCaller === undefined ? {} : { trustedCaller: input.trustedCaller }),
  };
}

export type CheckTaskPerson = (task: DeveloperTaskRecord, developerId: string) => ReturnType<typeof checkTaskPersonIdentity>;
export type TaskPersonStateAuthorityWitness = ProjectAuthorityWitness & { taskId: string; developerId: string; project: string };
export interface TaskPersonRuntime {
  checkTaskPerson: CheckTaskPerson;
  stateAuthorityWitnessForOwnerActor(task: DeveloperTaskRecord, ownerActorId: string): Promise<TaskPersonStateAuthorityWitness | undefined>;
  stateAuthorityWitnessForEligiblePerson(task: DeveloperTaskRecord, developerId: string): Promise<TaskPersonStateAuthorityWitness | undefined>;
}

/** The runtime the dispatch guard is given: the Slack-based checks, and the project authority witness a task's taker rests on when Slack has no proof for them. */
export interface TaskPersonDispatchRuntime extends TaskPersonRuntime {
  /**
   * The witness for a task's effective owner with no Slack proof (Plan 5 Task 12a, R3-1): the project's latest revision and the owner's own grant row or org role, read as
   * `creatorIsProjectViewer` reads them, with no Slack identity or channel check. A viewer-only or missing role gives none, so dispatch still fails closed.
   */
  projectAuthorityWitnessForOwner(task: DeveloperTaskRecord): Promise<TaskPersonStateAuthorityWitness | undefined>;
}

/**
 * The witness the dispatch fence rests on for a task's owner actor: the Slack identity witness as ever, and for a task taken over whose taker has no eligible, in-channel Slack
 * proof, the taker's project authority (Plan 5 Task 12a, R3-1). Only the dispatch guard uses this; the Slack invite path keeps the Slack-only witness.
 */
export async function stateAuthorityWitnessForDispatch(runtime: TaskPersonDispatchRuntime, task: DeveloperTaskRecord, ownerActorId: string): Promise<TaskPersonStateAuthorityWitness | undefined> {
  const slack = await runtime.stateAuthorityWitnessForOwnerActor(task, ownerActorId);
  if (slack !== undefined) return slack;
  return isTaskTakenOver(task) && ownerActorId === ownerActorIdOf(task) ? runtime.projectAuthorityWitnessForOwner(task) : undefined;
}

/** The install's Slack team id, or "" on an install with no Slack (a person with no Slack account needs none); anything else that is not a team id is refused. */
const teamIdUsable = (slackTeamId: string): boolean => slackTeamId === "" || SlackTeamIdSchema.safeParse(slackTeamId).success;

/** Creates a guard-local checker. Its injected ports expose only the bounded People read set. */
export function createTaskPersonRuntime(input: {
  /** The install's single org: the org of a task that names none of its own. */
  orgId: OrgId;
  admission: TaskAuthorityAdmission;
  ports: TaskPersonRuntimePorts;
  stateTableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  trustedCaller?: TaskPersonIdentityDependencies["trustedCaller"];
  checkIdentity?: typeof checkTaskPersonIdentity;
}): TaskPersonDispatchRuntime {
  const checkIdentity = input.checkIdentity ?? checkTaskPersonIdentity;
  const witnesses = new Map<string, TaskPersonStateAuthorityWitness & { eligible: true; channelMember: boolean }>();
  const witnessKey = (taskId: string, developerId: string) => `${taskId}\0${developerId}`;
  const currentWitness = async (task: DeveloperTaskRecord, developerId: string, witness: TaskPersonStateAuthorityWitness | undefined): Promise<TaskPersonStateAuthorityWitness | undefined> => {
    if (witness === undefined || witness.taskId !== task.taskId || witness.developerId !== developerId || witness.project !== task.project) return undefined;
    input.admission.assertOpen();
    const latest = await input.ports.projectAuthorityReader.latestRevision(taskOrg(input.orgId, task), task.project, input.admission, input.admission.admitStateRead());
    input.admission.assertOpen();
    const revision = latest.revision;
    const validRevision = revision !== undefined && Number.isSafeInteger(revision.revision) && revision.revision >= 0
      && typeof revision.definition === "object" && revision.definition !== null && !Array.isArray(revision.definition);
    const samePolicy = latest.complete && validRevision && revision !== undefined
      && revision.pk === witness.projectRevision.pk && revision.sk === witness.projectRevision.sk
      && revision.revision === witness.projectRevision.revision
      && Object.hasOwn(revision.definition, "developerTasks") === witness.projectRevision.developerTasksPresent
      && (!witness.projectRevision.developerTasksPresent || isDeepStrictEqual(revision.definition.developerTasks, witness.projectRevision.developerTasks));
    return samePolicy ? witness : undefined;
  };
  const projectAuthorityWitnessForOwner = async (task: DeveloperTaskRecord): Promise<TaskPersonStateAuthorityWitness | undefined> => {
    const { developerId } = effectiveTaskOwner(task);
    if (!teamIdUsable(input.slackTeamId)) throw refused();
    // A taker removed from the company has no project authority, though their grants live on until the removal's access step deletes them (member removal). Read first,
    // through the same two-key reads the Slack check makes, before any grant is looked at.
    const orgId = taskOrg(input.orgId, task);
    const reachableIds = new Set<string>([developerId]);
    const orgReads = { documentClient: identityDocumentClient({ orgId, taskId: task.taskId, developerId, stateTableName: input.stateTableName, admission: input.admission, ports: input.ports, reachableIds }), tableName: input.stateTableName };
    if (await isRemovedFromOrg(orgReads, orgId, developerId)) return undefined;
    // And a taker must still be a member who may write (not an Auditor, with a grant left behind): the same rule as every task person check (org/explicit-member.ts).
    try {
      if (await explicitMemberRole({ ...orgReads, readSignIn: signInReaderFromRecords(developerRecordReader({ admission: input.admission, ports: input.ports, reachableIds })) }, orgId, developerId) === undefined) return undefined;
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "FORBIDDEN") return undefined;
      throw unavailable();
    }
    const result = await readProjectAuthority(input.ports.projectAuthorityReader, {
      orgId, project: task.project, developerId, teamId: input.slackTeamId, admission: input.admission,
    });
    input.admission.assertOpen();
    if (result.kind === "unavailable") throw unavailable();
    if (result.kind !== "allowed" || result.access !== "granted" || result.witness === undefined) return undefined;
    return currentWitness(task, developerId, { ...result.witness, taskId: task.taskId, developerId, project: task.project });
  };
  return {
    async checkTaskPerson(task, developerId) {
      witnesses.delete(witnessKey(task.taskId, developerId));
      input.admission.admitIdentity(developerId);
      input.admission.assertOpen();
      if (!UUID.test(task.taskId) || !teamIdUsable(input.slackTeamId)) throw refused();
      let projectWitness: ProjectAuthorityWitness | undefined;
      const dependencies = identityDependencies({
        orgId: taskOrg(input.orgId, task), task, developerId, stateTableName: input.stateTableName, slackTeamId: input.slackTeamId,
        now: () => input.now(), uuid: () => input.uuid(),
        ...(input.trustedCaller === undefined ? {} : { trustedCaller: input.trustedCaller }),
        admission: input.admission,
        ports: input.ports,
        onProjectAuthority(witness) { projectWitness = witness; },
      });
      const result = await checkIdentity(dependencies, task, developerId);
      input.admission.assertOpen();
      if (result.eligible && result.identity.developerId === developerId && projectWitness !== undefined) witnesses.set(witnessKey(task.taskId, developerId), {
        ...projectWitness, taskId: task.taskId, developerId, project: task.project, eligible: true, channelMember: result.channelMember,
      });
      return result;
    },
    async stateAuthorityWitnessForOwnerActor(task, ownerActorId) {
      const witness = [...witnesses.values()].find((candidate) => candidate.taskId === task.taskId
        && candidate.project === task.project && candidate.channelMember
        && taskOwnerKey(candidate.developerId, task.taskId) === ownerActorId);
      return currentWitness(task, witness?.developerId ?? "", witness);
    },
    projectAuthorityWitnessForOwner,
    async stateAuthorityWitnessForEligiblePerson(task, developerId) {
      const witness = witnesses.get(witnessKey(task.taskId, developerId));
      if (witness?.eligible !== true) return undefined;
      return currentWitness(task, developerId, witness);
    },
  };
}
