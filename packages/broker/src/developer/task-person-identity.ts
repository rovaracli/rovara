import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SLACK_OIDC_ISSUER,
  SlackChannelIdSchema,
  SlackUserIdSchema,
  TaskPersonProofRequestSchema,
  TaskPersonProofResponseSchema,
  agentXError,
  cleanDisplayName,
  emailSafeName,
  redactAndCap,
  DeveloperSignInMethodSchema,
  type DeveloperSignInMethod,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import { developerIdForSlackUser } from "../aws/admin-actions.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { isRemovedFromOrg } from "../org/member-removal/guards.js";
import { UNNAMED_MEMBER, type DeveloperTaskRecord } from "./task-records.js";
import type { DeveloperRecord } from "./store.js";

/**
 * A task person is a Rovara member, whichever way they sign in (owner decision 86, neutral identity A-13): the web, GitHub, an identity provider or Slack. They are keyed by the
 * member's `developerId`. `slackUserId` is there only when the member's account is linked to a Slack person; a member with none has no Slack to ask about, and is qualified on
 * their Rovara membership and project access alone (`qualifyNeutral`), never on a Slack proof.
 */
export interface TaskPersonIdentity {
  developerId: string;
  slackUserId?: string;
  name: string;
  method: DeveloperSignInMethod;
  issuer: string;
  subject: string;
}

/** The name a person with no Slack account is shown under when no name is stored: the same words as an owner with no name. */
const NO_SLACK_FALLBACK_NAME = UNNAMED_MEMBER;

export type ProjectAccessSubject = Pick<DeveloperCaller, "developerId" | "slackUserId">;

export interface TaskPersonIdentityDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  slackTeamId: string;
  now(): number;
  uuid(): string;
  /** Required fresh proof capability. An absent old Identity Lambda is a refusal, with no cached fallback. */
  taskPersonProof(request: TaskPersonProofRequest): Promise<TaskPersonProofResponse>;
  /** A strongly consistent, server-owned DeveloperRecord lookup from the sign-in table. */
  developerRecord(developerId: string): Promise<DeveloperRecord | undefined>;
  /** Current channels bound to the target project. */
  projectChannelIds(project: string): Promise<readonly string[]>;
  /** Existing project policy and grants, evaluated against only the supplied fresh membership. */
  targetProjectAccess(subject: ProjectAccessSubject, project: string, freshMemberOf: readonly string[]): Promise<void | "viewer">;
  /** Exact caller already authenticated by the enclosing route. Never supplied by system-created callers. */
  trustedCaller?: Pick<DeveloperCaller, "developerId" | "amr" | "name" | "slackUserId">;
}

interface TaskPersonRecord extends TaskPersonIdentity {
  pk: string;
  sk: string;
  schemaVersion: 1;
  personId: string;
  createdAt: string;
}

interface TaskPersonSubjectRecord {
  pk: string;
  sk: string;
  schemaVersion: 1;
  personId: string;
  developerId: string;
  createdAt: string;
}

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHANNELS = 50;

const refuse = (): never => { throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified"); };
const unavailable = (): never => { throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable"); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const taskPk = (taskId: string) => `DEVTASK#${taskId}`;
const personSk = (personId: string) => `PERSON#${personId}`;
const subjectSk = (developerId: string) => `PERSON_SUBJECT#${developerId}`;

/** The name a new row is written with, and the name as it is shown: never an email address (release 0.4.16). */
const safeName = (name: string, fallback: string): string => emailSafeName(redactAndCap(name, 80).text) ?? fallback;
/** Whether a stored name is well formed by the rule rows were written under before 0.4.16: a row stored under an email is still the person's row (shown through `safeName`). */
const wellFormedName = (name: string, fallback: string): boolean => (cleanDisplayName(redactAndCap(name, 80).text) ?? fallback) === name;

async function getItem(deps: TaskPersonIdentityDependencies, pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk, sk }, ConsistentRead: true })) as { Item?: unknown };
  return isRecord(result.Item) ? result.Item : undefined;
}

async function currentTask(deps: TaskPersonIdentityDependencies, taskId: string): Promise<DeveloperTaskRecord> {
  if (!UUID.test(taskId)) return refuse();
  const item = await getItem(deps, taskPk(taskId), "META");
  if (item?.pk !== taskPk(taskId) || item.sk !== "META" || item.entityType !== "DEVELOPER_TASK" || item.taskId !== taskId
    || typeof item.project !== "string" || !HEX64.test(String(item.developerId)) || (item.provider !== "slack" && item.provider !== "oidc" && item.provider !== "cloud" && item.provider !== "github" && item.provider !== "saml")) return refuse();
  return item as unknown as DeveloperTaskRecord;
}

function parsedIdentity(item: Record<string, unknown>): TaskPersonIdentity | undefined {
  // A row written before neutral identity always has a Slack id; a member with no Slack link has no such key at all (never a null or an empty one).
  const hasSlack = Object.hasOwn(item, "slackUserId");
  if (hasSlack && !SlackUserIdSchema.safeParse(item.slackUserId).success) return undefined;
  const slackUserId = hasSlack ? (item.slackUserId as string) : undefined;
  const fallback = slackUserId ?? NO_SLACK_FALLBACK_NAME;
  const method = DeveloperSignInMethodSchema.safeParse(item.method);
  if (!HEX64.test(String(item.developerId)) || typeof item.name !== "string"
    || !wellFormedName(item.name, fallback) || !method.success || (method.data === "slack" && slackUserId === undefined)
    || typeof item.issuer !== "string" || item.issuer.length === 0 || item.issuer.length > 2048
    || typeof item.subject !== "string" || item.subject.length === 0 || item.subject.length > 512) return undefined;
  return {
    developerId: String(item.developerId),
    ...(slackUserId === undefined ? {} : { slackUserId }),
    name: safeName(item.name, fallback),
    method: method.data,
    issuer: item.issuer,
    subject: item.subject,
  };
}

async function registryByPerson(deps: TaskPersonIdentityDependencies, taskId: string, personId: string): Promise<TaskPersonIdentity> {
  if (!UUID.test(personId)) return refuse();
  const person = await getItem(deps, taskPk(taskId), personSk(personId));
  if (person?.pk !== taskPk(taskId) || person.sk !== personSk(personId) || person.schemaVersion !== 1 || person.personId !== personId
    || typeof person.createdAt !== "string" || !Number.isFinite(Date.parse(person.createdAt))) return refuse();
  const identity = parsedIdentity(person);
  if (identity === undefined) return refuse();
  const reverse = await getItem(deps, taskPk(taskId), subjectSk(identity.developerId));
  if (reverse?.pk !== taskPk(taskId) || reverse.sk !== subjectSk(identity.developerId) || reverse.schemaVersion !== 1
    || reverse.personId !== personId || reverse.developerId !== identity.developerId || reverse.createdAt !== person.createdAt) return refuse();
  return identity;
}

async function registryBySubject(deps: TaskPersonIdentityDependencies, taskId: string, developerId: string): Promise<TaskPersonIdentity | undefined> {
  const reverse = await getItem(deps, taskPk(taskId), subjectSk(developerId));
  if (reverse === undefined) return undefined;
  if (reverse.schemaVersion !== 1 || reverse.developerId !== developerId || typeof reverse.personId !== "string") return refuse();
  const identity = await registryByPerson(deps, taskId, reverse.personId);
  return identity.developerId === developerId ? identity : refuse();
}

function samePrincipal(left: TaskPersonIdentity, right: TaskPersonIdentity): boolean {
  return left.developerId === right.developerId && left.slackUserId === right.slackUserId && left.method === right.method
    && left.issuer === right.issuer && left.subject === right.subject;
}

async function persistIdentity(
  deps: TaskPersonIdentityDependencies,
  taskId: string,
  identity: TaskPersonIdentity,
  assertOpen?: () => void,
): Promise<TaskPersonIdentity> {
  assertOpen?.();
  const existing = await registryBySubject(deps, taskId, identity.developerId);
  assertOpen?.();
  if (existing !== undefined) return samePrincipal(existing, identity) ? existing : refuse();
  const personId = deps.uuid();
  if (!UUID.test(personId)) return refuse();
  const createdAt = new Date(deps.now()).toISOString();
  const person: TaskPersonRecord = { pk: taskPk(taskId), sk: personSk(personId), schemaVersion: 1, personId, ...identity, createdAt };
  const reverse: TaskPersonSubjectRecord = { pk: taskPk(taskId), sk: subjectSk(identity.developerId), schemaVersion: 1, personId, developerId: identity.developerId, createdAt };
  try {
    assertOpen?.();
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: person, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: reverse, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    assertOpen?.();
    return identity;
  } catch (error) {
    if (!conditional(error)) throw error;
    assertOpen?.();
    const winner = await registryBySubject(deps, taskId, identity.developerId);
    assertOpen?.();
    return winner !== undefined && samePrincipal(winner, identity) ? winner : refuse();
  }
}

type Qualification = { eligible: true; channelMember: boolean; name: string; projectViewer?: true } | { eligible: false; channelMember: boolean };

async function qualifyCurrent(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  subject: ProjectAccessSubject,
): Promise<Qualification> {
  if (typeof deps.taskPersonProof !== "function") return unavailable();
  let channels: readonly string[];
  try {
    channels = await deps.projectChannelIds(task.project);
  } catch {
    return unavailable();
  }
  const channelIds = [...new Set([...channels, ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
  if (channelIds.length > MAX_CHANNELS || channelIds.some((channelId) => !SlackChannelIdSchema.safeParse(channelId).success)) return unavailable();
  const request = TaskPersonProofRequestSchema.safeParse({ kind: "task-person-proof", slackUserId: subject.slackUserId, channelIds });
  if (!request.success) return unavailable();
  let raw: TaskPersonProofResponse;
  try {
    raw = await deps.taskPersonProof(request.data);
  } catch {
    return unavailable();
  }
  const parsed = TaskPersonProofResponseSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  if (!parsed.data.ok) return parsed.data.error === "ineligible" ? { eligible: false, channelMember: false } : unavailable();
  const memberOf = parsed.data.memberOf;
  const requested = new Set(channelIds);
  if (parsed.data.user.id !== subject.slackUserId || parsed.data.user.teamId !== deps.slackTeamId
    || (task.share !== undefined && task.share.teamId !== deps.slackTeamId)
    || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return unavailable();
  const channelMember = task.share === undefined || memberOf.includes(task.share.channelId);
  // A person removed from the company is no longer eligible, whatever Slack and the project grants still say (member removal). Read at every qualification, so a stored proof
  // is checked again at each use. A task from before orgs names none, and a person who never joined has no tombstone.
  if (task.orgId !== undefined && await isRemovedFromOrg(deps, task.orgId, subject.developerId)) return { eligible: false, channelMember };
  let access: void | "viewer";
  try {
    access = await deps.targetProjectAccess(subject, task.project, memberOf);
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") {
      return { eligible: false, channelMember };
    }
    return unavailable();
  }
  // A project viewer is eligible to see the task but takes no part in it (Plan 2, Task 21): the proof says so, and the role is capped.
  return { eligible: true, channelMember, name: safeName(parsed.data.user.name, parsed.data.user.id), ...(access === "viewer" ? { projectViewer: true as const } : {}) };
}

async function qualify(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  subject: ProjectAccessSubject & { name?: string },
): Promise<{ name: string }> {
  let result: Qualification;
  try {
    // A person with no Slack account has nothing to ask Slack: their membership and project access are the whole question (owner decision 86).
    result = subject.slackUserId === undefined
      ? await qualifyNeutral(deps, task, subject, subject.name ?? NO_SLACK_FALLBACK_NAME)
      : await qualifyCurrent(deps, task, subject);
  } catch {
    return refuse();
  }
  return result.eligible ? { name: result.name } : refuse();
}

/** A sign-in row's method when it is one a task person may have signed in with without Slack (any but Slack itself); undefined for a Slack row or one with an unknown method. */
function signInMethodOf(record: DeveloperRecord): Exclude<DeveloperSignInMethod, "slack"> | undefined {
  const method = DeveloperSignInMethodSchema.safeParse(record.provider);
  return method.success && method.data !== "slack" ? method.data : undefined;
}

/**
 * The task identity of a member who did not sign in with Slack, read from their own sign-in row (a consistent read). The row must be theirs (keyed by them, naming the identity the
 * key is made of). The Slack id is taken only when the row has a well-formed one, so a person whose account is linked to Slack stays on the Slack path (a Slack proof, a channel),
 * and one whose is not is neutral. Throws a refusal for a row that is missing or not theirs, `unavailable` when the table cannot be read.
 */
async function identityFromMemberRecord(deps: TaskPersonIdentityDependencies, developerId: string): Promise<TaskPersonIdentity> {
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(developerId);
  } catch {
    return unavailable();
  }
  const method = record === undefined ? undefined : signInMethodOf(record);
  if (record === undefined || method === undefined || record.developerId !== developerId || typeof record.issuer !== "string" || typeof record.subject !== "string"
    || ownerKeyForSubject(record.issuer, record.subject) !== developerId) return refuse();
  const slackUserId = SlackUserIdSchema.safeParse(record.slackUserId).success ? record.slackUserId : undefined;
  const fallback = slackUserId ?? NO_SLACK_FALLBACK_NAME;
  return {
    developerId, ...(slackUserId === undefined ? {} : { slackUserId }), name: safeName(typeof record.displayName === "string" ? record.displayName : fallback, fallback),
    method, issuer: record.issuer, subject: record.subject,
  };
}

/**
 * Qualification of a task person with no Slack account (owner decision 86): there is nothing to ask Slack, so they are eligible when they are a current member with project access,
 * and only then. Not removed from the company (the tombstone check every qualification makes), and the project's own rule says they may use it: an explicit grant or an org owner
 * or admin role. The project's Slack channels give such a person nothing (no Slack id, no channel path), so this never admits someone who is not a member. They are not in the
 * task's Slack channel and need not be: `channelMember` is true, as it is for a task with no Slack share, because the task's channel is no part of how they take part.
 */
async function qualifyNeutral(deps: TaskPersonIdentityDependencies, task: DeveloperTaskRecord, subject: ProjectAccessSubject, name: string): Promise<Qualification> {
  if (task.orgId !== undefined && await isRemovedFromOrg(deps, task.orgId, subject.developerId)) return { eligible: false, channelMember: false };
  let access: void | "viewer";
  try {
    access = await deps.targetProjectAccess({ developerId: subject.developerId }, task.project, []);
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") return { eligible: false, channelMember: false };
    return unavailable();
  }
  return { eligible: true, channelMember: true, name, ...(access === "viewer" ? { projectViewer: true as const } : {}) };
}

function nativeIdentity(slackUserId: string, name: string): TaskPersonIdentity {
  return {
    developerId: developerIdForSlackUser(slackUserId),
    slackUserId,
    name,
    method: "slack",
    issuer: SLACK_OIDC_ISSUER,
    subject: slackUserId,
  };
}

export async function resolveTaskPickerPerson(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  slackUserId: string,
): Promise<TaskPersonIdentity> {
  if (!SlackUserIdSchema.safeParse(slackUserId).success) return refuse();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const subject = { developerId: developerIdForSlackUser(slackUserId), slackUserId };
  const proof = await qualify(deps, stored, subject);
  return persistIdentity(deps, stored.taskId, nativeIdentity(slackUserId, proof.name));
}

/** E: resolves a signed Slack picker selection to its immutable opaque task person. */
export async function resolveTaskPickerPersonWithId(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  slackUserId: string,
): Promise<{ personId: string; identity: TaskPersonIdentity }> {
  const identity = await resolveTaskPickerPerson(deps, task, slackUserId);
  const reverse = await getItem(deps, taskPk(task.taskId), subjectSk(identity.developerId));
  if (reverse === undefined || reverse.pk !== taskPk(task.taskId) || reverse.sk !== subjectSk(identity.developerId)
    || reverse.schemaVersion !== 1 || reverse.developerId !== identity.developerId || typeof reverse.personId !== "string" || !UUID.test(reverse.personId)) return refuse();
  return { personId: reverse.personId, identity };
}

/** Registers a complete fresh Slack directory result without re-reading Slack or creating sessions. */
export async function registerTaskChannelPeople(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  users: readonly { id: string; teamId: string; name: string; memberOf: readonly string[] }[],
  assertOpen?: () => void,
): Promise<readonly TaskPersonIdentity[]> {
  assertOpen?.();
  const stored = await currentTask(deps, task.taskId);
  assertOpen?.();
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const identities: TaskPersonIdentity[] = [];
  for (const user of users) {
    assertOpen?.();
    if (user.teamId !== deps.slackTeamId || !SlackUserIdSchema.safeParse(user.id).success) return unavailable();
    const identity = nativeIdentity(user.id, safeName(user.name, user.id));
    let accessError: unknown;
    try {
      await deps.targetProjectAccess({ developerId: identity.developerId, slackUserId: user.id }, stored.project, user.memberOf);
    } catch (error) {
      accessError = error;
    }
    assertOpen?.();
    if (accessError !== undefined) {
      if (accessError instanceof Error && (accessError as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") continue;
      return unavailable();
    }
    identities.push(await persistIdentity(deps, stored.taskId, identity, assertOpen));
    assertOpen?.();
  }
  return identities;
}

async function storedIdentityStatus(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<"current" | "ineligible"> {
  if (identity.method === "slack") {
    if (identity.slackUserId === undefined || identity.issuer !== SLACK_OIDC_ISSUER || identity.subject !== identity.slackUserId
      || identity.developerId !== developerIdForSlackUser(identity.slackUserId)) return refuse();
    return "current";
  }
  if (identity.issuer === SLACK_OIDC_ISSUER || identity.developerId !== ownerKeyForSubject(identity.issuer, identity.subject)) return refuse();
  let record: DeveloperRecord | undefined;
  try {
    record = await deps.developerRecord(identity.developerId);
  } catch {
    return unavailable();
  }
  // A person stored with a Slack id must still have that one. A person stored without one stays without one: linking Slack later does not change who they are on this task.
  if (record === undefined || typeof record.revoked !== "boolean" || !signInMethodOf(record) || record.developerId !== identity.developerId
    || record.issuer !== identity.issuer || record.subject !== identity.subject || (identity.slackUserId !== undefined && record.slackUserId !== identity.slackUserId)
    || ownerKeyForSubject(record.issuer, record.subject) !== record.developerId) return refuse();
  // A merged-away identity (its sign-in now belongs to the survivor) is no longer this task person, as a revoked one is not.
  return record.revoked || record.mergedInto !== undefined ? "ineligible" : "current";
}

async function verifyStoredIdentity(deps: TaskPersonIdentityDependencies, identity: TaskPersonIdentity): Promise<void> {
  let status: "current" | "ineligible";
  try {
    status = await storedIdentityStatus(deps, identity);
  } catch {
    return refuse();
  }
  if (status !== "current") return refuse();
}

/**
 * D2: side-effect-free current qualification for an exact task developer identity. A proven loss
 * returns eligible=false; unavailable or malformed proof throws so callers cannot reconcile it as
 * a departure. No registry, sign-in or session row is created here.
 */
export async function checkTaskPersonIdentity(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  developerId: string,
): Promise<{ subject: ProjectAccessSubject; identity: TaskPersonIdentity; eligible: boolean; channelMember: boolean; projectViewer?: true }> {
  if (!HEX64.test(developerId)) return refuse();
  const stored = await currentTask(deps, task.taskId);
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  let identity = await registryBySubject(deps, stored.taskId, developerId);
  if (identity === undefined) {
    const caller = deps.trustedCaller;
    if (caller?.developerId === developerId && caller.amr === "slack" && SlackUserIdSchema.safeParse(caller.slackUserId).success
      && developerIdForSlackUser(caller.slackUserId!) === developerId) {
      identity = nativeIdentity(caller.slackUserId!, safeName(caller.name, caller.slackUserId!));
    } else if (caller?.developerId === developerId && caller.amr !== "slack") {
      // The route's own caller, a member who did not sign in with Slack: who they are is their own sign-in row, never anything the request says.
      identity = await identityFromMemberRecord(deps, developerId);
    } else if (developerId !== stored.developerId) {
      return refuse();
    } else if (stored.provider === "slack") {
      if (!SlackUserIdSchema.safeParse(stored.slackUserId).success || developerId !== developerIdForSlackUser(stored.slackUserId!)) return refuse();
      identity = nativeIdentity(stored.slackUserId!, safeName(stored.developerName, stored.slackUserId!));
    } else {
      // The task's creator signed in another way: their sign-in row says who they are, with or without a linked Slack account.
      identity = await identityFromMemberRecord(deps, developerId);
    }
  }
  const status = await storedIdentityStatus(deps, identity);
  const subject = { developerId, ...(identity.slackUserId === undefined ? {} : { slackUserId: identity.slackUserId }) };
  if (status === "ineligible") return { subject, identity, eligible: false, channelMember: false };
  const proof = identity.slackUserId === undefined
    ? await qualifyNeutral(deps, stored, subject, identity.name)
    : await qualifyCurrent(deps, stored, subject);
  return proof.eligible
    ? { subject, identity: { ...identity, name: proof.name }, eligible: true, channelMember: proof.channelMember, ...(proof.projectViewer === true ? { projectViewer: true as const } : {}) }
    : { subject, identity, eligible: false, channelMember: proof.channelMember };
}

/**
 * Registers the members of a project who have no Slack account as task people, the way `registerTaskChannelPeople` registers the people of a Slack channel (owner decision 86): so the
 * task's People list can offer every member of the project, not only the ones in its Slack channel. Each is read from their own sign-in row and must qualify now
 * (`qualifyNeutral`); one who does not, or whose row is not usable, is left out, and an unreadable table is `unavailable`. A member with a linked Slack account is not registered
 * here (they come through Slack, with a proof, or not at all), and neither is a revoked or merged-away one.
 */
export async function registerTaskMembers(
  deps: TaskPersonIdentityDependencies,
  task: DeveloperTaskRecord,
  developerIds: readonly string[],
  assertOpen?: () => void,
): Promise<readonly TaskPersonIdentity[]> {
  assertOpen?.();
  const stored = await currentTask(deps, task.taskId);
  assertOpen?.();
  if (stored.project !== task.project || stored.developerId !== task.developerId || stored.provider !== task.provider || stored.slackUserId !== task.slackUserId) return refuse();
  const identities: TaskPersonIdentity[] = [];
  for (const developerId of new Set(developerIds)) {
    assertOpen?.();
    if (!HEX64.test(developerId)) continue;
    let identity: TaskPersonIdentity;
    try {
      identity = await identityFromMemberRecord(deps, developerId);
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "PROJECT_ACCESS_DENIED") continue;
      throw error;
    }
    if (identity.slackUserId !== undefined) continue;
    // Revoked or merged away: not a person to offer.
    if (await storedIdentityStatus(deps, identity) !== "current") continue;
    const qualified = await qualifyNeutral(deps, stored, { developerId }, identity.name);
    assertOpen?.();
    if (!qualified.eligible) continue;
    identities.push(await persistIdentity(deps, stored.taskId, { ...identity, name: qualified.name }, assertOpen));
    assertOpen?.();
  }
  return identities;
}

export async function resolveTaskPersonId(
  deps: TaskPersonIdentityDependencies,
  taskId: string,
  personId: string,
): Promise<TaskPersonIdentity> {
  const task = await currentTask(deps, taskId);
  const identity = await registryByPerson(deps, taskId, personId);
  await verifyStoredIdentity(deps, identity);
  await qualify(deps, task, identity);
  return identity;
}
