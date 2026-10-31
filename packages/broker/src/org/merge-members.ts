import { approvalGrantChange } from "./approval-membership.js";
import { budgetDocumentFence } from "./budget-snapshot.js";
// packages/broker/src/org/merge-members.ts
// Plan 2, Task 3: one person who signed in two ways before identity links became two members. Merging moves the duplicate's project
// grants, budget override and role to the survivor (the member the person's verified email names), then retires the duplicate: its
// membership goes, its sign-in identity links to the survivor, and its sessions end, all in one transaction.
//
// Two shapes, by where the duplicate is:
// - The same org as the survivor (the staging shape): grants, override and role move over.
// - A race org of its own (the Task 2 first-sign-in race: two sign-ins of one person at once made two orgs): only when that org is
//   disposable (see `raceOrgBlocker`). Nothing in it moves, because nothing is there; the transaction closes it (a tombstone, not a delete).
//
// Every step can be repeated: a run that stopped before the transaction is finished by the next one, and a run after a complete one only
// reads. Left in place on purpose: tasks and workspaces owned by the duplicate's id stay as history and no task record is changed, so a
// task still running for the duplicate fails closed at its next dispatch (the grant it is checked against has moved). There are no
// customers yet, and only staging holds such records.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  MEMBER_GRANT_SK_PREFIX, agentXError, developerOrgKey, memberGrantsPk, memberMergeQueueKey, orgMemberKey, orgMetaKey, orgPk, orgProjectCatalogPk, orgSettingsKey,
  projectMemberKey, trialGithubKey, type OrgId, type OrgRole,
} from "@agentx/contracts";
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
  /**
   * What the model proxy says an org has spent, in US dollars. Only a race org's disposability reads it; an install with no proxy has
   * nothing spent. A failure to answer counts as "spend unknown", so the org is not disposable.
   */
  orgSpentUsd?: (orgId: OrgId) => Promise<number>;
  /** The Audit Ledger's outbox: moving the duplicate's monthly limit records `budget.changed` (by the system) in the write that moves it. Absent: nothing is recorded. */
  audit?: AuditRuntime;
}

export interface MergeDuplicateMemberInput {
  /** The survivor's org. */
  orgId: OrgId;
  /** The duplicate's org when it is a race org of its own; absent, the duplicate is a member of `orgId` too. */
  duplicateOrgId?: OrgId;
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
  /** The duplicate's race org was closed by this run. */
  closedOrg?: OrgId;
}

type Item = Record<string, unknown>;
type Deps = MergeDuplicateMemberDependencies;
const ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1, auditor: 0 };
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The two closures a sign-in needs, bound to the same dependencies. */
export function duplicateMerger(deps: Deps): {
  mergeDuplicate: (input: MergeDuplicateMemberInput) => Promise<MergeDuplicateMemberResult>;
  raceOrgBlocker: (orgId: OrgId, duplicateId: string) => Promise<string | undefined>;
} {
  return {
    mergeDuplicate: (input) => mergeDuplicateMember(deps, input),
    raceOrgBlocker: (orgId, duplicateId) => raceOrgBlocker(deps, orgId, duplicateId),
  };
}

export async function mergeDuplicateMember(deps: Deps, input: MergeDuplicateMemberInput): Promise<MergeDuplicateMemberResult> {
  const { orgId, survivorId, duplicateId } = input;
  const duplicateOrgId = input.duplicateOrgId ?? orgId;
  if (survivorId === duplicateId) throw invalid("a member cannot be merged into itself");
  const [survivor, duplicate, survivorRecord, record] = await Promise.all([
    memberOf(deps, orgId, survivorId), memberOf(deps, duplicateOrgId, duplicateId), deps.signInStore.getDeveloper(survivorId), deps.signInStore.getDeveloper(duplicateId),
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

  let race: RaceOrg | undefined;
  if (duplicateOrgId !== orgId) {
    const blocker = await raceOrgBlocker(deps, duplicateOrgId, duplicateId);
    if (blocker !== undefined) throw invalid(`the duplicate's organization is not empty: ${blocker}`);
    race = await readRaceOrg(deps, duplicateOrgId, orgId);
  }

  const sameOrg = race === undefined;
  const grantsMoved = sameOrg ? await moveGrants(deps, orgId, survivorId, duplicateId) : 0;
  const overrideMoved = sameOrg ? await moveBudgetOverride(deps, orgId, survivorId, duplicateId) : false;
  const role = sameOrg && ROLE_RANK[duplicate.role] > ROLE_RANK[survivor.role] ? duplicate.role : survivor.role;
  const at = new Date(deps.now()).toISOString();
  try {
    await retire(deps, input, { duplicateOrgId, duplicateRole: duplicate.role, survivorRole: survivor.role, role, at, record, ...(link === undefined ? {} : { link }), ...(race === undefined ? {} : { race }) });
  } catch (error) {
    // A concurrent sign-in of the same duplicate merged it first: its result stands.
    if (errorName(error) !== "TransactionCanceledException") throw error;
    const [settled, now] = await Promise.all([memberOf(deps, duplicateOrgId, duplicateId), deps.signInStore.getDeveloper(duplicateId)]);
    if (settled !== undefined || now?.mergedInto !== survivorId) throw error;
    return { grantsMoved, overrideMoved, role, ...(race === undefined ? {} : { closedOrg: duplicateOrgId }) };
  }
  return { grantsMoved, overrideMoved, role, ...(race === undefined ? {} : { closedOrg: duplicateOrgId }) };
}

async function memberOf(deps: Deps, orgId: OrgId, developerId: string): Promise<{ role: OrgRole } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Item };
  return response.Item === undefined ? undefined : { role: response.Item.role as OrgRole };
}

async function getItem(deps: Deps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function queryPartition(deps: Deps, pk: string, prefix: string | undefined, limit?: number): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ...(prefix === undefined ? {} : { ":prefix": prefix }) },
      ConsistentRead: true,
      ...(limit === undefined ? {} : { Limit: limit }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = limit === undefined ? page.LastEvaluatedKey : undefined;
  } while (start !== undefined);
  return items;
}

/**
 * Why an org is not a disposable race org of `duplicateId`, or undefined when it is. Disposable means the org is the leftover of the Task 2
 * first-sign-in race, which made it for the duplicate alone a moment ago: the duplicate is its only member and it has no project (no
 * catalog row, no grant), no invite, no GitHub owner connected, no budget or workspace limits set, and nothing spent at the model proxy.
 * A trial that GitHub sign-in unlocked does not count against it (it is carried over, see `retire`). There are no per-org connectors yet.
 */
export async function raceOrgBlocker(deps: Deps, orgId: OrgId, duplicateId: string): Promise<string | undefined> {
  const meta = await getItem(deps, orgMetaKey(orgId));
  if (meta === undefined || meta.closedAt !== undefined) return "no open organization record";
  if (meta.createdBy !== duplicateId || meta.plan !== "trial") return "not a trial organization the duplicate created";
  // `githubOwner` is the attribute the operator-set GitHub owner left on an org item (removed in Plan 2, Task 16; nothing writes it now).
  // An org that still carries it was connected that way and is not disposable. A connection made since is a row of the org's partition, below.
  if (meta.githubOwner !== undefined) return "a GitHub organization is connected";
  // The org's own partition holds exactly its record and its one member: a second member or an invite request would be another row.
  const rows = (await queryPartition(deps, orgPk(orgId), undefined)).map((row) => String(row.sk)).sort();
  if (JSON.stringify(rows) !== JSON.stringify([orgMetaKey(orgId).sk, orgMemberKey(orgId, duplicateId).sk].sort())) return "it has other members or invites";
  if ((await queryPartition(deps, orgProjectCatalogPk(orgId), undefined, 1)).length > 0) return "it has projects";
  if ((await queryPartition(deps, memberGrantsPk(orgId, duplicateId), MEMBER_GRANT_SK_PREFIX, 1)).length > 0) return "it has project grants";
  if (await getItem(deps, orgSettingsKey(orgId, "BUDGET")) !== undefined || await getItem(deps, orgSettingsKey(orgId, "WORKSPACE_LIMITS")) !== undefined) return "it has budgets or limits set";
  if (deps.orgSpentUsd !== undefined) {
    try {
      if (await deps.orgSpentUsd(orgId) > 0) return "it has spent on models";
    } catch {
      return "its model spend is unknown";
    }
  }
  return undefined;
}

interface RaceOrg {
  orgId: OrgId;
  /** The GitHub account whose connection unlocked the race org's trial, and when. */
  trial?: { githubUserId: string; unlockedAt: number };
  /** The survivor's trial is still locked, so the unlock can be carried over to it. */
  carryTrial: boolean;
}

async function readRaceOrg(deps: Deps, orgId: OrgId, survivorOrgId: OrgId): Promise<RaceOrg> {
  const [meta, survivorMeta] = await Promise.all([getItem(deps, orgMetaKey(orgId)), getItem(deps, orgMetaKey(survivorOrgId))]);
  const trial = typeof meta?.trialGithubUserId === "string" && typeof meta.trialUnlockedAt === "number"
    ? { githubUserId: meta.trialGithubUserId, unlockedAt: meta.trialUnlockedAt } : undefined;
  const carryTrial = trial !== undefined && survivorMeta?.plan === "trial" && survivorMeta.trialUnlockedAt === undefined;
  return { orgId, ...(trial === undefined ? {} : { trial }), carryTrial };
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
 * merged. A race org is closed (marked, not deleted) in the same transaction and its trial unlock, if any, moves to the survivor's org.
 * Each condition pins what was read, so a concurrent change fails the whole merge to be tried again.
 */
async function retire(
  deps: Deps,
  input: MergeDuplicateMemberInput,
  state: { duplicateOrgId: OrgId; duplicateRole: OrgRole; survivorRole: OrgRole; role: OrgRole; at: string; record: DeveloperRecord; link?: Awaited<ReturnType<DeveloperSignInStore["getIdentityLink"]>>; race?: RaceOrg },
): Promise<void> {
  const { orgId, survivorId, duplicateId } = input;
  const TableName = deps.tableName;
  const roleName = { "#role": "role" };
  const { race } = state;
  const trial = race?.trial;
  await deps.documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName, Key: orgMemberKey(state.duplicateOrgId, duplicateId), ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":seen": state.duplicateRole } } },
      { Delete: { TableName, Key: developerOrgKey(duplicateId), ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeValues: { ":orgId": state.duplicateOrgId } } },
      { Update: { TableName, Key: orgMemberKey(orgId, survivorId), UpdateExpression: "SET #role = :role, roleUpdatedAt = :at", ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":seen": state.survivorRole, ":at": state.at } } },
      { Update: { TableName, Key: developerOrgKey(survivorId), UpdateExpression: "SET #role = :role", ConditionExpression: "attribute_exists(pk) AND orgId = :orgId", ExpressionAttributeNames: roleName, ExpressionAttributeValues: { ":role": state.role, ":orgId": orgId } } },
      ...((race?.trial !== undefined && race.carryTrial) ? [] : await approvalGrantChange({ ...deps, now: () => new Date(deps.now()) }, orgId, "", false)),
      ...(race === undefined ? [] : [
        // Closed, not deleted: still disposable at this moment (its creator, a trial, no GitHub owner, and the trial claim as read).
        { Update: {
          TableName, Key: orgMetaKey(race.orgId), UpdateExpression: "SET closedAt = :at, mergedIntoOrg = :survivorOrg, approvalMembershipVersion = if_not_exists(approvalMembershipVersion, :zero) + :one",
          ConditionExpression: `attribute_exists(pk) AND createdBy = :duplicate AND #plan = :trial AND attribute_not_exists(githubOwner) AND attribute_not_exists(closedAt) AND ${trial === undefined ? "attribute_not_exists(trialGithubUserId)" : "trialGithubUserId = :github"}`,
          ExpressionAttributeNames: { "#plan": "plan" },
          ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":at": state.at, ":survivorOrg": orgId, ":duplicate": duplicateId, ":trial": "trial", ...(trial === undefined ? {} : { ":github": trial.githubUserId }) },
        } },
        ...(trial === undefined || !race.carryTrial ? [] : [
          // The GitHub account keeps its one trial: its claim and the unlock move to the survivor's org.
          { Put: {
            TableName, Item: { ...trialGithubKey(trial.githubUserId), entityType: "TRIAL_GITHUB", orgId, claimedAt: trial.unlockedAt },
            ConditionExpression: "attribute_not_exists(pk) OR orgId = :raceOrg", ExpressionAttributeValues: { ":raceOrg": race.orgId },
          } },
          { Update: {
            TableName, Key: orgMetaKey(orgId), UpdateExpression: "SET trialUnlockedAt = :unlockedAt, trialGithubUserId = :github, approvalMembershipVersion = if_not_exists(approvalMembershipVersion, :zero) + :one, approvalTrackingSince = if_not_exists(approvalTrackingSince, :at)",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(trialUnlockedAt)", ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":at": state.at, ":unlockedAt": trial.unlockedAt, ":github": trial.githubUserId },
          } },
        ]),
      ]),
      // Plan 3, Task 11: the broker finishes what the duplicate owned (agents, skills, shares) from this marker; this function only leaves it,
      // in the transaction that retires the duplicate, so a merge that happened always has one and one that did not never does. The marker's org is
      // the survivor's. In the race-org case the duplicate's own org differs and is closed in this same transaction, so anything the duplicate owned
      // there stays with it in a closed org on purpose: this is not a cross-org move, and the broker never makes one.
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
