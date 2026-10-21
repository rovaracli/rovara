// packages/broker/src/org/merge-members.ts
// Plan 2, Task 3: one person who signed in two ways before identity links became two members of one org. Merging moves the
// duplicate's project grants, budget override and role to the survivor (the member the person's verified email names), then retires
// the duplicate: its membership goes, its sign-in identity links to the survivor, and its sessions end. Every step can be repeated: a
// run that stopped part way is finished by the next one, and a run after a complete one only reads.
//
// Left in place on purpose: tasks and workspaces owned by the duplicate's id stay as history, and no task record is changed. There are
// no customers yet, and only staging holds such records.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  MEMBER_GRANT_SK_PREFIX, agentXError, developerOrgKey, memberGrantsPk, orgMemberKey, orgSettingsKey, projectMemberKey,
  type OrgId, type OrgRole,
} from "@agentx/contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { DeveloperRecord, DeveloperSignInStore } from "../developer/store.js";

export interface MergeDuplicateMemberDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table, which holds orgs, membership, grants and settings. The sign-in table is reached through `signInStore`; one transaction writes both. */
  tableName: string;
  signInStore: DeveloperSignInStore;
  now: () => number;
}

export interface MergeDuplicateMemberInput {
  orgId: OrgId;
  /** The member that stays: the one the person's verified email names. */
  survivorId: string;
  /** The member that goes: the same person's other sign-in route. */
  duplicateId: string;
  /** The duplicate's own sign-in identity, `ownerKeyForSubject(issuer, subject)`: linked to the survivor from now on. */
  duplicateIdentityKey: string;
  /** What the sign-in that triggered the merge knows about the identity, kept on its link. */
  identity?: { email?: string; login?: string };
}

export interface MergeDuplicateMemberResult {
  /** Grants written for the survivor by this run (a project the survivor already had a grant on keeps its own). */
  grantsMoved: number;
  /** The duplicate's monthly override became the survivor's by this run (the survivor had none). */
  overrideMoved: boolean;
  /** The survivor's role after the merge: the higher of the two. */
  role: OrgRole;
}

type Item = Record<string, unknown>;
const ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function mergeDuplicateMember(deps: MergeDuplicateMemberDependencies, input: MergeDuplicateMemberInput): Promise<MergeDuplicateMemberResult> {
  const { orgId, survivorId, duplicateId } = input;
  if (survivorId === duplicateId) throw invalid("a member cannot be merged into itself");
  const [survivor, duplicate, record] = await Promise.all([
    memberOf(deps, orgId, survivorId), memberOf(deps, orgId, duplicateId), deps.signInStore.getDeveloper(duplicateId),
  ]);
  if (survivor === undefined) throw invalid("the member to keep does not belong to that organization");
  if (duplicate === undefined) {
    // Already merged: only the last step, ending the sessions, may be outstanding.
    if (record?.mergedInto !== survivorId) throw invalid("the member to merge does not belong to that organization");
    await endDuplicateSessions(deps, duplicateId, record);
    return { grantsMoved: 0, overrideMoved: false, role: survivor.role };
  }
  if (record === undefined || record.mergedInto !== undefined || ownerKeyForSubject(record.issuer, record.subject) !== input.duplicateIdentityKey) {
    throw invalid("the member to merge has no sign-in record of that identity, or was merged already");
  }

  const grantsMoved = await moveGrants(deps, orgId, survivorId, duplicateId);
  const overrideMoved = await moveBudgetOverride(deps, orgId, survivorId, duplicateId);
  const role = ROLE_RANK[duplicate.role] > ROLE_RANK[survivor.role] ? duplicate.role : survivor.role;
  const at = new Date(deps.now()).toISOString();
  try {
    await retire(deps, input, { duplicateRole: duplicate.role, survivorRole: survivor.role, role, at, record });
  } catch (error) {
    // A concurrent sign-in of the same duplicate merged it first: its result stands.
    if (errorName(error) !== "TransactionCanceledException") throw error;
    const [settled, now] = await Promise.all([memberOf(deps, orgId, duplicateId), deps.signInStore.getDeveloper(duplicateId)]);
    if (settled !== undefined || now?.mergedInto !== survivorId) throw error;
    await endDuplicateSessions(deps, duplicateId, now);
    return { grantsMoved, overrideMoved, role };
  }
  await endDuplicateSessions(deps, duplicateId, { ...record, mergedAt: at });
  return { grantsMoved, overrideMoved, role };
}

async function memberOf(deps: MergeDuplicateMemberDependencies, orgId: OrgId, developerId: string): Promise<{ role: OrgRole } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item };
  return response.Item === undefined ? undefined : { role: response.Item.role as OrgRole };
}

/** Ends the duplicate's sessions as of the merge, unless that has been done (an admin's later end counts). */
async function endDuplicateSessions(deps: MergeDuplicateMemberDependencies, duplicateId: string, record: { mergedAt?: string; sessionsEndedAt?: string }): Promise<void> {
  if (record.mergedAt === undefined) return;
  if (record.sessionsEndedAt !== undefined && record.sessionsEndedAt >= record.mergedAt) return;
  await deps.signInStore.endSessions(duplicateId, record.mergedAt);
}

/**
 * Each of the duplicate's grants becomes the survivor's, then goes. The copy is written first and only if the survivor has no grant on
 * that project (the survivor's own stays), so a run that stopped between the two steps loses nothing. The copy's `ownerKey` is the
 * survivor's (the direct-membership proof checks it, C7); its `grantId` and other fields are kept.
 */
async function moveGrants(deps: MergeDuplicateMemberDependencies, orgId: OrgId, survivorId: string, duplicateId: string): Promise<number> {
  let moved = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": memberGrantsPk(orgId, duplicateId), ":prefix": MEMBER_GRANT_SK_PREFIX },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const grant of page.Items ?? []) {
      const project = String(grant.sk).slice(MEMBER_GRANT_SK_PREFIX.length);
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...grant, ...projectMemberKey(orgId, survivorId, project), ownerKey: survivorId },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        moved += 1;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: grant.pk, sk: grant.sk } }));
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return moved;
}

/**
 * The duplicate's own monthly limit becomes the survivor's when the survivor has none, and the duplicate's entry is removed either way.
 * The duplicate's month-to-date spend at the model proxy does not move with it, so the survivor's member cap starts over once. That is
 * accepted while there are no customers.
 */
async function moveBudgetOverride(deps: MergeDuplicateMemberDependencies, orgId: OrgId, survivorId: string, duplicateId: string): Promise<boolean> {
  const key = orgSettingsKey(orgId, "BUDGET");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    const seen = response.Item?.memberOverrides;
    if (response.Item === undefined || !isRecord(seen) || !Object.hasOwn(seen, duplicateId)) return false;
    const { [duplicateId]: limit, ...others } = seen;
    const survivorHasOne = Object.hasOwn(others, survivorId);
    try {
      // The whole item is written back, as the budget settings are; the condition keeps a concurrent edit of the overrides from being lost.
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...response.Item, memberOverrides: survivorHasOne ? others : { ...others, [survivorId]: limit } },
        ConditionExpression: "memberOverrides = :seen",
        ExpressionAttributeValues: { ":seen": seen },
      }));
      return !survivorHasOne;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw invalid("the organization's budget settings kept changing; try again");
}

/**
 * One transaction across the State and sign-in tables: the duplicate's member record and org pointer go, the survivor's role becomes the
 * higher one, the duplicate's sign-in identity links to the survivor, and the duplicate's record says it was merged. Each condition pins
 * what was read, so a concurrent change fails the whole merge to be tried again.
 */
async function retire(
  deps: MergeDuplicateMemberDependencies,
  input: MergeDuplicateMemberInput,
  state: { duplicateRole: OrgRole; survivorRole: OrgRole; role: OrgRole; at: string; record: DeveloperRecord },
): Promise<void> {
  const { orgId, survivorId, duplicateId } = input;
  const TableName = deps.tableName;
  const roleName = { "#role": "role" };
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName, Key: orgMemberKey(orgId, duplicateId), ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":seen": state.duplicateRole } } },
      { Delete: { TableName, Key: developerOrgKey(duplicateId), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeValues: { ":orgId": orgId } } },
      { Update: { TableName, Key: orgMemberKey(orgId, survivorId), UpdateExpression: "SET #role = :role", ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":seen": state.survivorRole } } },
      { Update: { TableName, Key: developerOrgKey(survivorId), UpdateExpression: "SET #role = :role", ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":orgId": orgId } } },
      ...deps.signInStore.mergeItems({
        duplicate: state.record, duplicateIdentityKey: input.duplicateIdentityKey, survivorId, at: state.at,
        ...(input.identity?.email === undefined ? {} : { email: input.identity.email }),
        ...(input.identity?.login === undefined ? {} : { login: input.identity.login }),
      }),
    ],
  }));
}
