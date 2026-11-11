// Member removal (v1.1), task 1: S0. Reads what the removal needs, builds the one transaction (`plan.ts`), runs it and maps a refusal to its reason. Nothing is deleted before
// the transaction (the old order deleted the grants first, so a refused removal left a member with none). The removal record is the receipt of the request: the same request id
// and body answer the same removal again, another body is refused. On an install with no movers wired the access step runs here, in place.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { LAST_OWNER_MESSAGE, agentXError, githubMemberKey, memberGithubKey, memberGrantsPk, MEMBER_GRANT_SK_PREFIX, orgPk, type OrgId } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { MEMBER_ALREADY_REMOVED_MESSAGE, MEMBER_REMOVAL_EMAIL_CAP, MEMBER_REMOVAL_GRANTS_MAX, MEMBER_REMOVAL_LEFTOVER_EMAILS_MAX, REMOVAL_CHANGE_STALE_MESSAGE, REMOVAL_FORBIDDEN_MESSAGE, REMOVAL_CLEANUP_UNFINISHED_MESSAGE, REMOVAL_REQUEST_REUSED_MESSAGE, REMOVAL_TOO_MANY_GRANTS_MESSAGE, SUCCESSOR_INVALID_MESSAGE, memberRemovalRecordKey, orgEmailKey, orgMemberKey, orgSettingsKey, type MemberRemovalRecord, type MemberRemovalState, type OrgRole, type RemovedGrant } from "@agentx/cloud-contracts";
import { auditMemberLeft, auditMemberRemoved, auditOccurrence } from "../../audit/events.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditDeps, type AuditRuntime } from "../../audit/outbox.js";
import { sha256Hex } from "../../developer/tokens.js";
import { approvalCompanyChange } from "../approval-membership.js";
import { runAccessStep } from "./access.js";
import { finishRemoval } from "./finish.js";
import { planMemberRemoval, removalRefusal, type RemovalPlan } from "./plan.js";

const auditOf = (deps: { audit?: AuditRuntime | undefined }): AuditDeps => (deps.audit === undefined ? {} : { audit: deps.audit });

type Item = Record<string, unknown>;

export interface StartRemovalDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime | undefined;
  /** Whether movers are wired: a marker is written for them. Without, the access step runs here and the removal is finished here. */
  hasMovers: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface StartRemovalInput {
  orgId: OrgId;
  developerId: string;
  emails: string[];
  ban: boolean;
  expectedRole?: OrgRole | undefined;
  /** Who made the change. The person themselves: `member.left`; anyone else: `member.removed`. */
  by?: AuditActor | undefined;
  /** The role the caller's authorization saw; the transaction checks the caller still has it. Read now when absent. */
  callerRole?: OrgRole | undefined;
  successorId?: string | undefined;
  /** The request id; it becomes the removal id. A new one is made when absent. */
  requestId?: string | undefined;
}

export interface StartedRemoval {
  removalId: string;
  state: MemberRemovalState;
  removedAt: string;
  /** The role the person had. */
  role: OrgRole;
  successorId?: string;
  /** True when this answers an earlier request with the same id and body. */
  replay: boolean;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const coded = agentXError;

function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => { if (reason?.Code === "ConditionalCheckFailed") failed.add(index); });
  return failed;
}

async function get(deps: StartRemovalDeps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function queryAll(deps: StartRemovalDeps, pk: string, prefix: string, max?: number): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
    if (max !== undefined && items.length > max) return items;
  } while (start !== undefined);
  return items;
}

/** The `ORG_EMAIL#` pointers among `emails` that name this developer (another person's pointer, or none, is left alone). */
async function emailPointersOf(deps: StartRemovalDeps, emails: string[], developerId: string): Promise<string[]> {
  const keys = [...new Set(emails.map((email) => orgEmailKey(email).pk))];
  const found = await Promise.all(keys.map(async (pk) => ({ pk, item: await get(deps, { pk, sk: "DEVELOPER" }) })));
  return found.filter(({ item }) => item?.["developerId"] === developerId).map(({ pk }) => pk);
}

/** The owner who joined first (then by id), other than `except`. */
function firstOwnerOf(members: Item[], except: string): string | undefined {
  return members
    .filter((member) => member["role"] === "owner" && typeof member["developerId"] === "string" && member["developerId"] !== except)
    .sort((a, b) => String(a["joinedAt"]).localeCompare(String(b["joinedAt"])) || String(a["developerId"]).localeCompare(String(b["developerId"])))[0]?.["developerId"] as string | undefined;
}

const digestOf = (input: StartRemovalInput): string => sha256Hex(JSON.stringify({
  leaver: input.developerId, successor: input.successorId ?? null, expectedRole: input.expectedRole ?? null, by: input.by?.id ?? null,
}));

function replayOf(record: Item): StartedRemoval {
  return {
    removalId: String(record["removalId"]), role: record["role"] as OrgRole, state: record["state"] as MemberRemovalState, removedAt: String(record["removedAt"]),
    ...(typeof record["successorId"] === "string" ? { successorId: record["successorId"] } : {}), replay: true,
  };
}

export async function startMemberRemoval(deps: StartRemovalDeps, input: StartRemovalInput): Promise<StartedRemoval> {
  const { orgId, developerId } = input;
  const removalId = input.requestId ?? randomUUID();
  const requestDigest = digestOf(input);
  const settledBefore = async (): Promise<StartedRemoval | undefined> => {
    if (input.requestId === undefined) return undefined;
    const previous = await get(deps, memberRemovalRecordKey(orgId, removalId));
    if (previous === undefined) return undefined;
    if (previous["requestDigest"] !== requestDigest) throw coded("CONFIG_INVALID", REMOVAL_REQUEST_REUSED_MESSAGE);
    // With no movers wired nothing else will finish a removal that stopped in its cleanup: the repeat does.
    if (!deps.hasMovers && previous["state"] === "STARTED") {
      const record = previous as unknown as MemberRemovalRecord;
      await finishInPlace(deps, {
        orgId, removalId, leaverId: record.leaverId, role: record.role as OrgRole, successorId: record.successorId, by: record.by, removedAt: record.removedAt,
        grants: record.grants, memberLimitUsd: record.memberLimitUsd, leftover: record.leftoverEmailPointers,
      });
      return { ...replayOf(previous), state: "DONE" };
    }
    return replayOf(previous);
  };
  const replayed = await settledBefore();
  if (replayed !== undefined) return replayed;

  for (let attempt = 0; ; attempt += 1) {
    const member = await get(deps, orgMemberKey(orgId, developerId));
    if (member === undefined) throw coded("NOT_FOUND", "that person is not a member of the organization");
    const role = member["role"] as OrgRole;
    if (input.expectedRole !== undefined && input.expectedRole !== role) throw coded("CHANGE_STALE", REMOVAL_CHANGE_STALE_MESSAGE);

    const callerId = input.by?.kind === "member" ? input.by.id : undefined;
    let caller: { developerId: string; role: OrgRole } | undefined;
    if (callerId !== undefined && callerId !== developerId) {
      const callerRole = input.callerRole ?? (await get(deps, orgMemberKey(orgId, callerId)))?.["role"] as OrgRole | undefined;
      if (callerRole === undefined) throw coded("FORBIDDEN", REMOVAL_FORBIDDEN_MESSAGE);
      caller = { developerId: callerId, role: callerRole };
    }

    const members = await queryAll(deps, orgPk(orgId), "MEMBER#");
    const memberById = (id: string) => members.find((entry) => entry["developerId"] === id);
    // Who takes over: the one chosen, else the person who removes, else (a leave, or the system) the first other owner. None when the org has nobody to hand anything to.
    let successorId = input.successorId;
    if (successorId !== undefined) {
      if (successorId === developerId || memberById(successorId) === undefined) throw coded("SUCCESSOR_INVALID", SUCCESSOR_INVALID_MESSAGE);
    } else {
      successorId = caller?.developerId ?? firstOwnerOf(members, developerId);
    }
    const successorKind = successorId === undefined || successorId === callerId || input.successorId === undefined ? "self" as const : "chosen" as const;

    let otherOwner: { developerId: string } | undefined;
    if (role === "owner") {
      const owner = caller?.role === "owner" ? caller.developerId : successorId !== undefined && memberById(successorId)?.["role"] === "owner" ? successorId : firstOwnerOf(members, developerId);
      if (owner === undefined) throw coded("LAST_OWNER", LAST_OWNER_MESSAGE);
      otherOwner = { developerId: owner };
    }

    const allPointers = await emailPointersOf(deps, input.emails, developerId);
    const githubItem = await get(deps, memberGithubKey(orgId, developerId));
    const githubUserId = typeof githubItem?.["githubUserId"] === "string" ? githubItem["githubUserId"] : undefined;
    const githubReverse = githubUserId === undefined ? undefined : await get(deps, githubMemberKey(orgId, githubUserId));
    const github = githubItem === undefined ? undefined : { githubUserId, reverse: githubReverse?.["developerId"] === developerId };
    const grantItems = await queryAll(deps, memberGrantsPk(orgId, developerId), MEMBER_GRANT_SK_PREFIX, MEMBER_REMOVAL_GRANTS_MAX);
    if (grantItems.length > MEMBER_REMOVAL_GRANTS_MAX) throw coded("RUNTIME_UNAVAILABLE", REMOVAL_TOO_MANY_GRANTS_MESSAGE);
    const grants: RemovedGrant[] = grantItems.map((grant) => ({
      project: String(grant["sk"]).slice(MEMBER_GRANT_SK_PREFIX.length),
      ...(typeof grant["grantId"] === "string" ? { grantId: grant["grantId"] } : {}),
      ...(typeof grant["role"] === "string" ? { role: grant["role"] } : {}),
      ...(typeof grant["projectRole"] === "string" ? { projectRole: grant["projectRole"] } : {}),
    }));
    const overrides = (await get(deps, orgSettingsKey(orgId, "BUDGET")))?.["memberOverrides"];
    const limit = typeof overrides === "object" && overrides !== null ? (overrides as Record<string, unknown>)[developerId] : undefined;

    const removedAt = new Date(deps.now()).toISOString();
    const actor: AuditActor = input.by ?? { kind: "system", id: "rovara" };
    const left = actor.kind === "member" && actor.id === developerId;
    const by = actor.kind === "member" ? actor.id : "system";
    const event = await tryAuditEvent(auditOf(deps), () => {
      // One occurrence per membership: the same person removed after joining again has another `joinedAt`.
      const facts = { orgId, actor, occurredAt: removedAt, occurrence: auditOccurrence(developerId, String(member["joinedAt"])), memberId: developerId, role };
      return left ? auditMemberLeft(facts) : auditMemberRemoved({ ...facts, removalId, successorKind, ...(successorId === undefined ? {} : { related: [successorId] }) });
    });
    const planned = planMemberRemoval({
      tableName: deps.tableName, orgId, removalId, removedAt, leaver: { developerId, role }, caller, ...(successorId === undefined ? {} : { successor: { developerId: successorId } }),
      otherOwner, emailPointers: allPointers, ban: input.ban, ...(github === undefined ? {} : { github }),
      record: {
        orgId, removalId, leaverId: developerId, role, ...(successorId === undefined ? {} : { successorId }), by, removedAt, state: "STARTED", requestDigest,
        grants, ...(typeof limit === "number" ? { memberLimitUsd: limit } : {}),
        leftoverEmailPointers: allPointers.slice(MEMBER_REMOVAL_EMAIL_CAP, MEMBER_REMOVAL_EMAIL_CAP + MEMBER_REMOVAL_LEFTOVER_EMAILS_MAX), githubUnlinked: github !== undefined,
      } satisfies MemberRemovalRecord,
      marker: deps.hasMovers ? { entityType: "MEMBER_REMOVAL", orgId, developerId, by, removalId, removedAt, ...(successorId === undefined ? {} : { successorId }) } : undefined,
      company: await approvalCompanyChange({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => new Date(removedAt) }, orgId, role === "owner" || role === "admin"),
      audit: event === undefined ? [] : auditPending(auditOf(deps), event),
    });
    const refusal = await run(deps, planned);
    if (refusal === undefined) {
      if (event !== undefined) await flushAuditEvents(auditOf(deps), [event]);
      const started: StartedRemoval = { removalId, state: "STARTED", removedAt, role, ...(successorId === undefined ? {} : { successorId }), replay: false };
      if (!deps.hasMovers) await finishInPlace(deps, { orgId, removalId, leaverId: developerId, role, successorId, by, removedAt, grants, memberLimitUsd: typeof limit === "number" ? limit : undefined, leftover: allPointers.slice(MEMBER_REMOVAL_EMAIL_CAP, MEMBER_REMOVAL_EMAIL_CAP + MEMBER_REMOVAL_LEFTOVER_EMAILS_MAX), });
      return started;
    }
    switch (refusal) {
      case "REPLAY": {
        const again = await settledBefore();
        if (again !== undefined) return again;
        throw coded("CHANGE_STALE", REMOVAL_CHANGE_STALE_MESSAGE);
      }
      case "LAST_OWNER":
        // One fresh try: the other owner may have been replaced by someone else since it was read.
        if (attempt < 1) continue;
        throw coded("LAST_OWNER", LAST_OWNER_MESSAGE);
      case "CONFLICT":
        if (attempt < 1) continue;
        throw coded("CHANGE_STALE", REMOVAL_CHANGE_STALE_MESSAGE);
      case "MEMBER_ALREADY_REMOVED": throw coded("MEMBER_ALREADY_REMOVED", MEMBER_ALREADY_REMOVED_MESSAGE);
      case "SUCCESSOR_INVALID": throw coded("SUCCESSOR_INVALID", SUCCESSOR_INVALID_MESSAGE);
      case "FORBIDDEN": throw coded("FORBIDDEN", REMOVAL_FORBIDDEN_MESSAGE);
      default: throw coded("CHANGE_STALE", REMOVAL_CHANGE_STALE_MESSAGE);
    }
  }
}

/** Runs the transaction; undefined when it committed, else the reason it was refused. A transaction conflict (no failed condition) is `CONFLICT`: read again once. */
async function run(deps: StartRemovalDeps, plan: RemovalPlan): Promise<ReturnType<typeof removalRefusal> | "CONFLICT" | undefined> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: plan.items }));
    return undefined;
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    return removalRefusal(plan, failed) ?? "CONFLICT";
  }
}

/**
 * An install with no movers: the access step and the finish run here. The person is cut off by S0 either way, but a failure here leaves their recorded grants in place and no
 * marker to retry from, so it fails the request (RUNTIME_UNAVAILABLE) and the record stays `STARTED`; a repeat of the same request id runs these steps again (`settledBefore`).
 */
async function finishInPlace(deps: StartRemovalDeps, input: { orgId: OrgId; removalId: string; leaverId: string; role: OrgRole; successorId: string | undefined; by: string; removedAt: string; grants: RemovedGrant[]; memberLimitUsd: number | undefined; leftover: string[] }): Promise<void> {
  try {
    const access = await runAccessStep(deps, { orgId: input.orgId, leaverId: input.leaverId, removedAt: input.removedAt, grants: input.grants, memberLimitUsd: input.memberLimitUsd, leftoverEmailPointers: input.leftover });
    await finishRemoval(deps, {
      orgId: input.orgId, removalId: input.removalId, leaverId: input.leaverId, role: input.role, successorId: input.successorId, by: input.by, outcome: "done",
      counts: { grantsRemoved: access.grantsRemoved, grantsKept: access.grantsKept, countsComplete: true },
    });
  } catch (error) {
    (deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("member_removal.in_place_failed", { orgId: input.orgId, error: errorName(error) ?? "unknown" });
    throw coded("RUNTIME_UNAVAILABLE", REMOVAL_CLEANUP_UNFINISHED_MESSAGE);
  }
}
