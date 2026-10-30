// Member removal (v1.1), task 1: the shape of S0, the one transaction that cuts a person off and records the removal. Pure: no reads, no clock. The caller (`start.ts`)
// reads first and hands the plan what it saw; the plan decides which actions there are and what each one is conditional on, and says which refused action means what.
// It never names one key twice (DynamoDB refuses that, and `FakeDynamoDb` too): the caller's, the successor's and the other owner's checks of one person are one action.
import {
  MEMBER_REMOVAL_EMAIL_CAP, developerOrgKey, githubMemberKey, memberGithubKey, memberRemovalQueueKey, memberRemovalRecordKey, orgBanKey, orgMemberKey, orgRemovedKey,
  type OrgId, type OrgRole,
} from "@agentx/contracts";
import type { TransactItem } from "../../audit/outbox.js";

type Item = Record<string, unknown>;

export interface RemovalPlanInput {
  tableName: string;
  orgId: OrgId;
  removalId: string;
  /** The commit time of S0, as an ISO instant: the tombstone's `removedAt` and the marker's sort time. */
  removedAt: string;
  /** The person removed, with the role the caller saw. */
  leaver: { developerId: string; role: OrgRole };
  /** Who removes them (the leaver themselves on a leave, and absent for the system). Checked only when someone else. */
  caller?: { developerId: string; role: OrgRole } | undefined;
  /** Who takes over; absent when the org has nobody to hand anything to. */
  successor?: { developerId: string } | undefined;
  /** Another owner who must still hold the role (only when the leaver is an owner). */
  otherOwner?: { developerId: string } | undefined;
  /** The `ORG_EMAIL#` partition keys that name the leaver. The first `MEMBER_REMOVAL_EMAIL_CAP` are deleted here; the rest are handed back. */
  emailPointers: string[];
  ban: boolean;
  /** The GitHub account the leaver linked, when the read found one. With none, the plan checks that none appeared since. */
  github?: { githubUserId: string } | undefined;
  /** The removal record's fields (the plan adds the key and the entity type). */
  record: Item;
  /** The marker's fields besides its key; absent on an install with no movers. */
  marker?: Item | undefined;
  /** The org's membership-version update (`approvalCompanyChange`), already built. */
  company: TransactItem[];
  /** The pending audit items. */
  audit: TransactItem[];
}

export interface RemovalLayout {
  member: number;
  pointer: number;
  emails: number[];
  tombstone: number;
  ban?: number;
  record: number;
  marker?: number;
  /** The three checks of the people around the removal; two or three of them are one index when it is the same person. */
  successorCheck?: number;
  callerCheck?: number;
  ownerCheck?: number;
  company: number[];
  github: number[];
  githubAbsent?: number;
  audit: number[];
}

export interface RemovalPlan {
  items: TransactItem[];
  layout: RemovalLayout;
  /** The pointers beyond the cap: the always-run access step deletes them. */
  leftoverEmailPointers: string[];
}

export type RemovalRefusal = "CHANGE_STALE" | "MEMBER_ALREADY_REMOVED" | "SUCCESSOR_INVALID" | "FORBIDDEN" | "LAST_OWNER" | "REPLAY";

export function planMemberRemoval(input: RemovalPlanInput): RemovalPlan {
  const { tableName, orgId, leaver } = input;
  if (input.successor?.developerId === leaver.developerId) throw new Error("a member cannot take over from themselves");
  if (input.otherOwner?.developerId === leaver.developerId) throw new Error("the other owner cannot be the person removed");
  const items: TransactItem[] = [];
  const add = (item: TransactItem): number => items.push(item) - 1;
  const emails = input.emailPointers.slice(0, MEMBER_REMOVAL_EMAIL_CAP);

  const member = add({ Delete: { TableName: tableName, Key: orgMemberKey(orgId, leaver.developerId), ConditionExpression: "attribute_exists(pk) AND #role = :seenRole", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":seenRole": leaver.role } } });
  const pointer = add({ Delete: { TableName: tableName, Key: developerOrgKey(leaver.developerId), ConditionExpression: "attribute_exists(pk) AND orgId = :org", ExpressionAttributeValues: { ":org": orgId } } });
  const emailIndexes = emails.map((pk) => add({ Delete: { TableName: tableName, Key: { pk, sk: "DEVELOPER" }, ConditionExpression: "developerId = :leaver", ExpressionAttributeValues: { ":leaver": leaver.developerId } } }));
  // The tombstone ruling R60 reads. No expiry attribute, ever: a person who rejoins must not revive the tasks they started before this removal, and tasks have no hard lifetime.
  // A later removal moves `removedAt` forward; one that is not newer is refused (the member delete fails first in practice).
  const tombstone = add({ Put: {
    TableName: tableName, Item: { ...orgRemovedKey(orgId, leaver.developerId), entityType: "ORG_REMOVED", orgId, developerId: leaver.developerId, removedAt: input.removedAt },
    ConditionExpression: "attribute_not_exists(pk) OR removedAt < :removedAt", ExpressionAttributeValues: { ":removedAt": input.removedAt },
  } });
  const ban = input.ban ? add({ Put: { TableName: tableName, Item: { ...orgBanKey(orgId, leaver.developerId), entityType: "ORG_BAN", orgId, developerId: leaver.developerId, bannedAt: input.removedAt } } }) : undefined;
  // The receipt: written once, so a replay of the same request is refused here.
  const record = add({ Put: { TableName: tableName, Item: { ...memberRemovalRecordKey(orgId, input.removalId), entityType: "MEMBER_REMOVAL_RECORD", ...input.record }, ConditionExpression: "attribute_not_exists(pk)" } });
  const marker = input.marker === undefined ? undefined
    : add({ Put: { TableName: tableName, Item: { ...memberRemovalQueueKey(input.removedAt, orgId, leaver.developerId), ...input.marker } } });

  // The checks of the people around the removal, one action per person: the caller still holds the role that authorized this, the successor is still a member of the org, and
  // another owner still holds the role (so two owners removing each other cannot both succeed).
  const checks = new Map<string, { names: Record<string, string>; values: Record<string, unknown>; parts: string[]; kinds: Set<"successor" | "caller" | "owner"> }>();
  const checkOf = (developerId: string) => {
    const found = checks.get(developerId) ?? { names: {}, values: {}, parts: [], kinds: new Set() };
    checks.set(developerId, found);
    return found;
  };
  if (input.successor !== undefined) {
    const check = checkOf(input.successor.developerId);
    check.parts.push("orgId = :org", "developerId = :successorId");
    check.values[":org"] = orgId;
    check.values[":successorId"] = input.successor.developerId;
    check.kinds.add("successor");
  }
  if (input.caller !== undefined && input.caller.developerId !== leaver.developerId) {
    const check = checkOf(input.caller.developerId);
    check.parts.push("#role = :callerRole");
    check.names["#role"] = "role";
    check.values[":callerRole"] = input.caller.role;
    check.kinds.add("caller");
  }
  if (input.otherOwner !== undefined) {
    const check = checkOf(input.otherOwner.developerId);
    check.parts.push("#role = :otherOwnerRole");
    check.names["#role"] = "role";
    check.values[":otherOwnerRole"] = "owner";
    check.kinds.add("owner");
  }
  const layout: RemovalLayout = { member, pointer, emails: emailIndexes, tombstone, record, company: [], github: [], audit: [] };
  if (ban !== undefined) layout.ban = ban;
  if (marker !== undefined) layout.marker = marker;
  for (const [developerId, check] of checks) {
    const index = add({ ConditionCheck: {
      TableName: tableName, Key: orgMemberKey(orgId, developerId), ConditionExpression: [...new Set(check.parts)].join(" AND "),
      ...(Object.keys(check.names).length === 0 ? {} : { ExpressionAttributeNames: check.names }), ExpressionAttributeValues: check.values,
    } });
    if (check.kinds.has("successor")) layout.successorCheck = index;
    if (check.kinds.has("caller")) layout.callerCheck = index;
    if (check.kinds.has("owner")) layout.ownerCheck = index;
  }
  for (const item of input.company) layout.company.push(add(item));
  if (input.github === undefined) {
    layout.githubAbsent = add({ ConditionCheck: { TableName: tableName, Key: memberGithubKey(orgId, leaver.developerId), ConditionExpression: "attribute_not_exists(pk)" } });
  } else {
    const values = { ":leaver": leaver.developerId, ":org": orgId };
    layout.github.push(
      add({ Delete: { TableName: tableName, Key: memberGithubKey(orgId, leaver.developerId), ConditionExpression: "developerId = :leaver AND orgId = :org", ExpressionAttributeValues: values } }),
      add({ Delete: { TableName: tableName, Key: githubMemberKey(orgId, input.github.githubUserId), ConditionExpression: "developerId = :leaver AND orgId = :org", ExpressionAttributeValues: values } }),
    );
  }
  for (const item of input.audit) layout.audit.push(add(item));
  return { items, layout, leftoverEmailPointers: input.emailPointers.slice(MEMBER_REMOVAL_EMAIL_CAP) };
}

/** What a refused S0 means, from the actions whose condition failed; undefined when none of them is one this plan knows. */
export function removalRefusal(plan: RemovalPlan, failed: ReadonlySet<number>): RemovalRefusal | undefined {
  const { layout } = plan;
  if (failed.has(layout.record)) return "REPLAY";
  if (failed.has(layout.member) || failed.has(layout.pointer)) return "CHANGE_STALE";
  if (failed.has(layout.tombstone)) return "MEMBER_ALREADY_REMOVED";
  if (layout.callerCheck !== undefined && failed.has(layout.callerCheck)) return "FORBIDDEN";
  if (layout.ownerCheck !== undefined && failed.has(layout.ownerCheck)) return "LAST_OWNER";
  if (layout.successorCheck !== undefined && failed.has(layout.successorCheck)) return "SUCCESSOR_INVALID";
  const others = [...layout.emails, ...layout.company, ...layout.github, ...(layout.githubAbsent === undefined ? [] : [layout.githubAbsent])];
  return others.some((index) => failed.has(index)) ? "CHANGE_STALE" : undefined;
}
