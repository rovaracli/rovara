import { approvalGrantChange } from "./approval-membership.js";
import { budgetDocumentFence } from "./budget-snapshot.js";
// packages/broker/src/org/merge-members.ts
// Plan 2, Task 3: one person who signed in two ways before identity links became two members. Merging moves the duplicate's project
// grants, budget override and role to the survivor (the member the person's verified email names), then retires the duplicate: its
// membership goes, its sign-in identity links to the survivor, and its sessions end, all in one transaction.
//
// Only ever within one company (IDENTITY-HEALING-CROSS-ORG, 0.5.15): both members belong to `orgId`, grants, override and role move over,
// and no company is closed. A duplicate in another company is refused: one person may hold two companies on purpose (programme T), so
// the old race-org shape (a second, "disposable" org closed by the merge) is gone.
//
// Every step can be repeated: a run that stopped before the transaction is finished by the next one, and a run after a complete one only
// reads. Left in place on purpose: tasks and workspaces owned by the duplicate's id stay as history and no task record is changed, so a
// task still running for the duplicate fails closed at its next dispatch (the grant it is checked against has moved). There are no
// customers yet, and only staging holds such records.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { MEMBER_GRANT_SK_PREFIX, agentXError, ownRoleEntry, memberGrantsPk, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, memberMergeQueueKey, orgMemberKey, orgSettingsKey, type OrgRole } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditTransact, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { SYSTEM_ACTOR, memberLimitChangedEvent } from "../audit/plan3-hooks.js";
import type { DeveloperRecord, DeveloperSignInStore } from "../developer/store.js";

export interface MergeDuplicateMemberDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table, which holds orgs, membership, grants and settings. The sign-in table is reached through `signInStore`; one transaction writes both. */
  tableName: string;
  signInStore: DeveloperSignInStore;
  now: () => number;
  /** The Audit Ledger's outbox: moving the duplicate's monthly limit records `budget.changed` (by the system) in the write that moves it. Absent: nothing is recorded. */
  audit?: AuditRuntime;
}

export interface MergeDuplicateMemberInput {
  /** The one company both members belong to. Nothing outside it is read or written. */
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
type Deps = MergeDuplicateMemberDependencies;
const ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1, auditor: 0 };
/**
 * The role the survivor keeps after a merge in the same company: the duplicate's when it ranks higher, else the survivor's. P3-OPEN-ROLES-CLOUD-ADOPTION: the table is read by its own keys only (`ownRoleEntry`), so a name it
 * does not list (or `constructor`) ranks below every listed role and never wins.
 */
export function mergedRole<R extends string>(sameOrg: boolean, duplicateRole: R, survivorRole: R): R {
  return sameOrg && (ownRoleEntry(ROLE_RANK, duplicateRole) ?? -1) > (ownRoleEntry(ROLE_RANK, survivorRole) ?? -1) ? duplicateRole : survivorRole;
}
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The closure a sign-in needs, bound to the dependencies. */
export function duplicateMerger(deps: Deps): {
  mergeDuplicate: (input: MergeDuplicateMemberInput) => Promise<MergeDuplicateMemberResult>;
} {
  return { mergeDuplicate: (input) => mergeDuplicateMember(deps, input) };
}

export async function mergeDuplicateMember(deps: Deps, input: MergeDuplicateMemberInput): Promise<MergeDuplicateMemberResult> {
  const { orgId, survivorId, duplicateId } = input;
  if (survivorId === duplicateId) throw invalid("a member cannot be merged into itself");
  // Both are read in `orgId` only: a duplicate whose membership is in another company is "not a member" here and is refused below.
  const [survivor, duplicate, survivorRecord, record] = await Promise.all([
    memberOf(deps, orgId, survivorId), memberOf(deps, orgId, duplicateId), deps.signInStore.getDeveloper(survivorId), deps.signInStore.getDeveloper(duplicateId),
  ]);
  if (survivor === undefined) throw invalid("the member to keep does not belong to that organization");
  if (survivorRecord === undefined || survivorRecord.revoked || survivorRecord.mergedInto !== undefined) {
    throw invalid("the member to keep was turned off or merged into another member");
  }
  if (duplicate === undefined) {
    // Already merged: nothing is outstanding, because the transaction did every step.
    if (record?.mergedInto !== survivorId) throw invalid("the member to merge does not belong to that organization");
    return { grantsMoved: 0, overrideMoved: false, role: survivor.role };
  }
  if (record === undefined || record.mergedInto !== undefined || ownerKeyForSubject(record.issuer, record.subject) !== input.duplicateIdentityKey) {
    throw invalid("the member to merge has no sign-in record of that identity, or was merged already");
  }
  const link = await deps.signInStore.getIdentityLink(input.duplicateIdentityKey);
  // An identity linked to anyone but itself, or one the person unlinked, is never merged: the person decided where it belongs.
  if (link !== undefined && (link.developerId !== input.duplicateIdentityKey || link.unlinkedFrom !== undefined)) throw invalid("the sign-in identity of the member to merge is linked elsewhere");

  const grantsMoved = await moveGrants(deps, orgId, survivorId, duplicateId);
  const overrideMoved = await moveBudgetOverride(deps, orgId, survivorId, duplicateId);
  const role = mergedRole(true, duplicate.role, survivor.role);
  const at = new Date(deps.now()).toISOString();
  try {
    await retire(deps, input, { duplicateRole: duplicate.role, survivorRole: survivor.role, role, at, record, ...(link === undefined ? {} : { link }) });
  } catch (error) {
    // A concurrent sign-in of the same duplicate merged it first: its result stands.
    if (errorName(error) !== "TransactionCanceledException") throw error;
    const [settled, now] = await Promise.all([memberOf(deps, orgId, duplicateId), deps.signInStore.getDeveloper(duplicateId)]);
    if (settled !== undefined || now?.mergedInto !== survivorId) throw error;
    return { grantsMoved, overrideMoved, role };
  }
  return { grantsMoved, overrideMoved, role };
}

async function memberOf(deps: Deps, orgId: OrgId, developerId: string): Promise<{ role: OrgRole } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item };
  return response.Item === undefined ? undefined : { role: response.Item.role as OrgRole };
}

async function getItem(deps: Deps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function queryPartition(deps: Deps, pk: string, prefix: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/**
 * Each of the duplicate's grants becomes the survivor's, then goes. The copy is written first and only if the survivor has no grant on
 * that project (the survivor's own stays), so a run that stopped between the two steps loses nothing. The copy's `ownerKey` is the
 * survivor's (the direct-membership proof checks it, C7); its `grantId` and other fields are kept.
 */
async function moveGrants(deps: Deps, orgId: OrgId, survivorId: string, duplicateId: string): Promise<number> {
  let moved = 0;
  for (const grant of await queryPartition(deps, memberGrantsPk(orgId, duplicateId), MEMBER_GRANT_SK_PREFIX)) {
    const project = String(grant.sk).slice(MEMBER_GRANT_SK_PREFIX.length);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: {
        TableName: deps.tableName,
        Item: { ...grant, ...projectMemberKey(orgId, survivorId, project), ownerKey: survivorId },
        ConditionExpression: "attribute_not_exists(pk)",
      } }, { ConditionCheck: {
        TableName: deps.tableName, Key: { pk: grant.pk, sk: grant.sk },
        ConditionExpression: "attribute_exists(pk) AND #role = :sourceRole AND " + (grant.grantId === undefined ? "attribute_not_exists(grantId)" : "grantId = :sourceGrantId") + " AND " + (grant.projectRole === undefined ? "attribute_not_exists(projectRole)" : "projectRole = :sourceProjectRole"),
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":sourceRole": grant.role, ...(grant.grantId === undefined ? {} : { ":sourceGrantId": grant.grantId }), ...(grant.projectRole === undefined ? {} : { ":sourceProjectRole": grant.projectRole }) },
      } }, ...await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, project, false)] }));
      moved += 1;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException" && !(errorName(error) === "TransactionCanceledException" && (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.[0]?.Code === "ConditionalCheckFailed")) throw error;
    }
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: {
      TableName: deps.tableName, Key: { pk: grant.pk, sk: grant.sk },
      ConditionExpression: "attribute_exists(pk) AND " + (grant.grantId === undefined ? "attribute_not_exists(grantId)" : "grantId = :grantId") + " AND " + (grant.projectRole === undefined ? "attribute_not_exists(projectRole)" : "projectRole = :projectRole"),
      ...((grant.grantId === undefined && grant.projectRole === undefined) ? {} : { ExpressionAttributeValues: { ...(grant.grantId === undefined ? {} : { ":grantId": grant.grantId }), ...(grant.projectRole === undefined ? {} : { ":projectRole": grant.projectRole }) } }),
    } }, ...await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, project, grant.projectRole === "maintainer")] }));
  }
  return moved;
}

/**
 * The duplicate's own monthly limit becomes the survivor's when the survivor has none, and the duplicate's entry is removed either way.
 * The duplicate's month-to-date spend at the model proxy does not move with it, so the survivor's member cap starts over once. That is
 * accepted while there are no customers.
 */
async function moveBudgetOverride(deps: Deps, orgId: OrgId, survivorId: string, duplicateId: string): Promise<boolean> {
  const key = orgSettingsKey(orgId, "BUDGET");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await getItem(deps, key);
    const seen = item?.memberOverrides;
    if (item === undefined || !isRecord(seen) || !Object.hasOwn(seen, duplicateId)) return false;
    const fence = budgetDocumentFence(item);
    const { [duplicateId]: limit, ...others } = seen;
    const survivorHasOne = Object.hasOwn(others, survivorId);
    // Recorded as Rovara's own change, in the write that makes it: the duplicate's limit falls back to the members' default, and the survivor's
    // takes the duplicate's figure when the survivor had none. The shared snapshot holds every budget field and advances the revision.
    const at = new Date(deps.now()).toISOString();
    const fallback = typeof item.memberDefaultMonthlyUsd === "number" ? item.memberDefaultMonthlyUsd : undefined;
    const events = await tryAuditEvents(deps, () => typeof limit !== "number" ? [] : [
      { developerId: duplicateId, from: limit, to: fallback },
      ...(survivorHasOne ? [] : [{ developerId: survivorId, from: fallback, to: limit }]),
    ].map((change) => memberLimitChangedEvent({
      orgId, actor: SYSTEM_ACTOR, occurredAt: at,
      occurrence: auditOccurrence("override_merged", duplicateId, survivorId, at, String(limit), change.developerId), ...change,
    })));
    try {
      // A changed company/default amount or revision must also refuse this old snapshot, not only a changed override map.
      await auditTransact(deps, {
        Put: {
          TableName: deps.tableName,
          Item: { ...item, memberOverrides: survivorHasOne ? others : { ...others, [survivorId]: limit }, revision: fence.nextRevision, updatedBy: "system", updatedAt: at },
          ...fence.condition,
        },
      }, events);
      await flushAuditEvents(deps, events);
      return !survivorHasOne;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw invalid("the organization's budget settings kept changing; try again");
}

/**
 * One transaction across the State and sign-in tables: the duplicate's member record and org pointer go, the survivor's role becomes the
 * higher one, the duplicate's sign-in identity links to the survivor, the duplicate's sessions end, and the duplicate's record says it was
 * merged. Every key it writes is in the survivor's company or the duplicate's own sign-in records; no company is closed.
 * Each condition pins what was read, so a concurrent change fails the whole merge to be tried again.
 */
async function retire(
  deps: Deps,
  input: MergeDuplicateMemberInput,
  state: { duplicateRole: OrgRole; survivorRole: OrgRole; role: OrgRole; at: string; record: DeveloperRecord; link?: Awaited<ReturnType<DeveloperSignInStore["getIdentityLink"]>> },
): Promise<void> {
  const { orgId, survivorId, duplicateId } = input;
  const TableName = deps.tableName;
  const roleName = { "#role": "role" };
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName, Key: orgMemberKey(orgId, duplicateId), ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":seen": state.duplicateRole } } },
      { Delete: { TableName, Key: developerOrgKey(duplicateId), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeValues: { ":orgId": orgId } } },
      { Update: { TableName, Key: orgMemberKey(orgId, survivorId), UpdateExpression: "SET #role = :role, roleUpdatedAt = :at", ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":seen": state.survivorRole, ":at": state.at } } },
      { Update: { TableName, Key: developerOrgKey(survivorId), UpdateExpression: "SET #role = :role", ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":orgId": orgId } } },
      ...await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, "", false),
      // Plan 3, Task 11: the broker finishes what the duplicate owned (agents, skills, shares) from this marker; this function only leaves it,
      // in the transaction that retires the duplicate, so a merge that happened always has one and one that did not never does. The marker's org is
      // the survivor's, which is also the duplicate's (one company only): the drain never moves anything across companies.
      { Put: { TableName, Item: { ...memberMergeQueueKey(state.at, orgId, duplicateId), entityType: "MEMBER_MERGE", orgId, survivorId, duplicateId } } },
      ...deps.signInStore.mergeItems({
        duplicate: state.record, duplicateIdentityKey: input.duplicateIdentityKey, survivorId, at: state.at,
        ...(state.link === undefined ? {} : { link: state.link }),
        ...(input.identity?.email === undefined ? {} : { email: input.identity.email }),
        ...(input.identity?.login === undefined ? {} : { login: input.identity.login }),
      }),
    ],
  }));
}
