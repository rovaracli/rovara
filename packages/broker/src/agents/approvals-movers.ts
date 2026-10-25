// Plan 3 Task 21 (Task 11's hand-off): the member movers of the approvals. A merge swaps the duplicate for the survivor in the approvers, the candidates, the
// APPROVER# items and the run owner of PENDING approvals; a removal re-routes them to the successor. Conditional, repeatable, audited as `approval.rerouted`.
// `approvals.ts` re-exports it.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApprovalIdSchema, INDEX_EXPIRY_ATTRIBUTE, approvalKey, approverIndexKey, canonicalJson, type ApprovalId, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditApprovalRerouted, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { checkTime, registerMemberMover, type LifecycleDeps } from "./lifecycle.js";
import { writeChanges } from "../realtime/changes.js";
import { expireApprovalWithReason } from "./approvals-decide.js";
import { type AnyApprovalRecord, type ApprovalDependencies, type ApprovalStoreDependencies, type ApproverSpec, type TransactItem, commitOrLost, getAnyApproval, indexExpiryOf, iso, listedFor } from "./approvals-store.js";

// ---- the movers (Task 11's hand-off)

interface MoveContext { deps: LifecycleDeps; orgId: OrgId; from: string; to: string; mode: "merged" | "removed" }

const swapped = (ids: readonly string[], from: string, to: string | undefined): string[] => [...new Set(ids.flatMap((id) => (id === from ? (to === undefined ? [] : [to]) : [id])))];

/** Moves one approval's mentions of `from`. Conditional on the record still being PENDING and unmoved since it was read, so a repeat or a race changes nothing twice. */
async function moveOne(context: MoveContext, approvalId: ApprovalId): Promise<void> {
  const { deps, orgId, from, to, mode } = context;
  for (let tried = 0; tried < 3; tried += 1) {
    const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const record = await getAnyApproval(deps, orgId, approvalId);
    const indexDrop: TransactItem = { Delete: { TableName: deps.tableName, Key: approverIndexKey(orgId, from, approvalId) } };
    if (record === undefined || record.status !== "PENDING") {
      // A decided or missing record keeps no place in anyone's list.
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [indexDrop] }));
      return;
    }
    const spec = record.approvers;
    const currentOwner = record.kind === "change" ? undefined : record.owner;
    const ownerIsFrom = currentOwner !== undefined && currentOwner.developerId === from;
    const approvers: ApproverSpec = spec.kind === "ids"
      ? { kind: "ids", ids: swapped(spec.ids, from, to) }
      : { kind: "rule", rule: spec.rule, candidates: mode === "merged" || ownerIsFrom ? swapped(spec.candidates, from, to) : swapped(spec.candidates, from, undefined) };
    let owner: { developerId: string; name: string } | undefined;
    if (currentOwner !== undefined && ownerIsFrom) {
      const successor = mode === "removed" ? await deps.signInStore.getDeveloper(to) : undefined;
      owner = { developerId: to, name: mode === "merged" ? currentOwner.name : (successor as { displayName?: string } | undefined)?.displayName ?? "the organization owner" };
    }
    // A pending take-over names the person who will own the session (Plan 5 Task 12b): when that person is merged into another member, the survivor is who it names.
    const takeOverTarget = mode === "merged" && record.kind === "change" && record.subject.kind === "session_owner" && record.subject.to === from;
    const changed = canonicalJson(approvers) !== canonicalJson(spec) || owner !== undefined || takeOverTarget;
    const moveRevision = stored.Item?.["moveRevision"];
    const names: Record<string, string> = { "#status": "status", "#rev": "moveRevision" };
    const values: Record<string, unknown> = { ":pending": "PENDING", ":zero": 0 };
    const sets = ["#rev = if_not_exists(#rev, :zero) + :one"];
    values[":one"] = changed ? 1 : 0;
    const movedAt = iso(deps.now());
    if (changed) {
      names["#approvers"] = "approvers";
      values[":approvers"] = approvers;
      sets.push("#approvers = :approvers", "#movedBy = :movedBy", "#movedAt = :movedAt");
      names["#movedBy"] = "movedBy";
      names["#movedAt"] = "movedAt";
      values[":movedBy"] = "system";
      values[":movedAt"] = movedAt;
      if (takeOverTarget) {
        names["#subject"] = "subject";
        values[":subject"] = { ...record.subject, to };
        sets.push("#subject = :subject");
      }
      if (owner !== undefined) {
        names["#owner"] = "owner";
        values[":owner"] = owner;
        sets.push("#owner = :owner");
      }
    }
    if (typeof moveRevision === "number") values[":seen"] = moveRevision;
    // Rovara changed who may decide this: the audit item is in the transaction that does it (nothing is audited when only an index item moves).
    const events: AuditEventInput[] = changed
      ? await tryAuditEvents(deps, () => [auditApprovalRerouted({
        orgId, actor: auditActorOf("system"), occurredAt: movedAt, occurrence: auditOccurrence(approvalId, String((typeof moveRevision === "number" ? moveRevision : 0) + 1)),
        approvalId, kind: record.kind, mode, from, to,
      })])
      : [];
    const items: TransactItem[] = [
      {
        Update: {
          TableName: deps.tableName, Key: approvalKey(orgId, approvalId), UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: typeof moveRevision === "number" ? "#status = :pending AND #rev = :seen" : "#status = :pending AND attribute_not_exists(#rev)",
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        },
      },
      indexDrop,
    ];
    // Only a person who is still listed after the move keeps a place in someone's list.
    if (listedFor({ kind: record.kind, approvers, owner: owner ?? currentOwner }).includes(to)) {
      items.push({ Put: { TableName: deps.tableName, Item: { ...approverIndexKey(orgId, to, approvalId), entityType: "APPROVER_INDEX", approvalId, expiresAt: record.expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiryOf(record.expiresAt) } } });
    }
    items.push(...events.flatMap((event) => auditPending(deps, event)));
    if (await commitOrLost(deps, items)) {
      await flushAuditEvents(deps, events);
      return;
    }
  }
  throw new Error("approval_move_conflict");
}

async function moveApprovals(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const pk = approverIndexKey(orgId, from, "apr_00000000000000000000").pk;
  const ids: ApprovalId[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = ApprovalIdSchema.safeParse(item.approvalId);
      if (parsed.success) ids.push(parsed.data);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  for (const approvalId of ids) {
    checkTime(deps);
    await moveOne({ deps, orgId, from, to, mode }, approvalId);
  }
}

// ---- a take-over (Plan 5 Task 12b)

/** The ids of the approvals `developerId` is listed for, every page. */
async function listedApprovalIds(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, developerId: string): Promise<ApprovalId[]> {
  const ids: ApprovalId[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": approverIndexKey(orgId, developerId, "apr_00000000000000000000").pk }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = ApprovalIdSchema.safeParse(item.approvalId);
      if (parsed.success) ids.push(parsed.data);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return ids;
}

/**
 * A take-over moved a task to its taker: the PENDING write and step approvals of that task that name the previous owner as the run's owner now name the taker, and the lists
 * follow (the taker's `APPROVER#` items are put, the previous owner's deleted unless they stay named as a candidate because they may still decide as a maintainer). Who may DECIDE
 * is read live from the task, so this is only what the lists show. Conditional on each record still being PENDING and unmoved since it was read; repeatable, so a take-over
 * whose answer was lost finishes it. Answers how many records it moved.
 */
export async function moveTaskApprovalsToOwner(
  deps: ApprovalStoreDependencies,
  input: { orgId: OrgId; taskId: string; from: string; to: { developerId: string; name: string }; fromStaysListed: boolean },
): Promise<number> {
  const { orgId, taskId, from, to } = input;
  let moved = 0;
  for (const approvalId of await listedApprovalIds(deps, orgId, from)) {
    for (let tried = 0; tried < 3; tried += 1) {
      const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const record = await getAnyApproval(deps, orgId, approvalId);
      if (record === undefined || record.status !== "PENDING" || record.kind === "change" || record.subject.kind !== "agent_run" || record.subject.taskId !== taskId || record.owner?.developerId !== from) break;
      const swap = (ids: readonly string[]) => (input.fromStaysListed ? [...new Set([...ids, to.developerId])] : swapped(ids, from, to.developerId));
      const approvers: ApproverSpec = record.approvers.kind === "ids" ? { kind: "ids", ids: swap(record.approvers.ids) } : { kind: "rule", rule: record.approvers.rule, candidates: swap(record.approvers.candidates) };
      const owner = { developerId: to.developerId, name: to.name };
      const before = listedFor(record);
      const after = listedFor({ kind: record.kind, approvers, owner });
      const moveRevision = stored.Item?.["moveRevision"];
      const movedAt = iso(deps.now());
      const items: TransactItem[] = [
        {
          Update: {
            TableName: deps.tableName, Key: approvalKey(orgId, approvalId),
            UpdateExpression: "SET #owner = :owner, #approvers = :approvers, #rev = if_not_exists(#rev, :zero) + :one, #movedBy = :movedBy, #movedAt = :movedAt",
            ConditionExpression: typeof moveRevision === "number" ? "#status = :pending AND #rev = :seen" : "#status = :pending AND attribute_not_exists(#rev)",
            ExpressionAttributeNames: { "#status": "status", "#owner": "owner", "#approvers": "approvers", "#rev": "moveRevision", "#movedBy": "movedBy", "#movedAt": "movedAt" },
            ExpressionAttributeValues: { ":pending": "PENDING", ":owner": owner, ":approvers": approvers, ":zero": 0, ":one": 1, ":movedBy": "system", ":movedAt": movedAt, ...(typeof moveRevision === "number" ? { ":seen": moveRevision } : {}) },
          },
        },
        ...after.filter((id) => !before.includes(id)).map((developerId): TransactItem => ({
          Put: { TableName: deps.tableName, Item: { ...approverIndexKey(orgId, developerId, approvalId), entityType: "APPROVER_INDEX", approvalId, expiresAt: record.expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiryOf(record.expiresAt) } },
        })),
        ...before.filter((id) => !after.includes(id)).map((developerId): TransactItem => ({ Delete: { TableName: deps.tableName, Key: approverIndexKey(orgId, developerId, approvalId) } })),
      ];
      if (await commitOrLost(deps, items)) {
        moved += 1;
        break;
      }
      if (tried === 2) throw new Error("approval_move_conflict");
    }
  }
  return moved;
}

// ---- the last owner left (Plan 5 Task 21, review M-5)

/** What the person who asked reads on an approval that was closed because nobody who could decide it is left. */
export const APPROVER_LEFT_REASON = "Everyone who could decide this has left your organization, so it was closed without a decision. Ask again if it is still needed.";

/** The person an approval is for, who is told when it is closed: the one who asked a change, or the owner of the run a write or step waits for. */
const requesterOf = (record: AnyApprovalRecord): string | undefined => (record.kind === "change" ? record.requestedBy : record.owner?.developerId);

/**
 * `from` left an org that has no owner to hand anything to. Every PENDING approval that lists them is re-routed to the approvers who are left (their name and `APPROVER#` item go,
 * nothing else changes), or, when no one else is named to decide it, ended as expired with `APPROVER_LEFT_REASON` and the person it was for is told (a `home.changed` change notice,
 * ids only). It is never approved or declined for anyone. Conditional on the record still being PENDING and unmoved since it was read; repeatable.
 */
async function orphanApprovals(deps: LifecycleDeps, orgId: OrgId, from: string): Promise<void> {
  for (const approvalId of await listedApprovalIds(deps, orgId, from)) {
    checkTime(deps);
    for (let tried = 0; tried < 3; tried += 1) {
      const record = await getAnyApproval(deps, orgId, approvalId);
      const indexDrop: TransactItem = { Delete: { TableName: deps.tableName, Key: approverIndexKey(orgId, from, approvalId) } };
      if (record === undefined || record.status !== "PENDING") {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [indexDrop] }));
        break;
      }
      const spec = record.approvers;
      const approvers: ApproverSpec = spec.kind === "ids" ? { kind: "ids", ids: swapped(spec.ids, from, undefined) } : { kind: "rule", rule: spec.rule, candidates: swapped(spec.candidates, from, undefined) };
      const named = approvers.kind === "ids" ? approvers.ids : approvers.candidates;
      if (named.length === 0) {
        if (await expireApprovalWithReason(deps as unknown as ApprovalDependencies, record, APPROVER_LEFT_REASON)) {
          const asker = requesterOf(record);
          if (asker !== undefined && asker !== from) await tellRequester(deps, orgId, asker);
          break;
        }
        continue;
      }
      if (canonicalJson(approvers) === canonicalJson(spec)) {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [indexDrop] }));
        break;
      }
      const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const moveRevision = stored.Item?.["moveRevision"];
      const movedAt = iso(deps.now());
      const events: AuditEventInput[] = await tryAuditEvents(deps, () => [auditApprovalRerouted({
        orgId, actor: auditActorOf("system"), occurredAt: movedAt, occurrence: auditOccurrence(approvalId, String((typeof moveRevision === "number" ? moveRevision : 0) + 1)),
        approvalId, kind: record.kind, mode: "removed", from, to: named[0]!,
      })]);
      const items: TransactItem[] = [
        {
          Update: {
            TableName: deps.tableName, Key: approvalKey(orgId, approvalId),
            UpdateExpression: "SET #approvers = :approvers, #rev = if_not_exists(#rev, :zero) + :one, #movedBy = :movedBy, #movedAt = :movedAt",
            ConditionExpression: typeof moveRevision === "number" ? "#status = :pending AND #rev = :seen" : "#status = :pending AND attribute_not_exists(#rev)",
            ExpressionAttributeNames: { "#status": "status", "#approvers": "approvers", "#rev": "moveRevision", "#movedBy": "movedBy", "#movedAt": "movedAt" },
            ExpressionAttributeValues: { ":pending": "PENDING", ":approvers": approvers, ":zero": 0, ":one": 1, ":movedBy": "system", ":movedAt": movedAt, ...(typeof moveRevision === "number" ? { ":seen": moveRevision } : {}) },
          },
        },
        indexDrop,
        ...events.flatMap((event) => auditPending(deps, event)),
      ];
      if (await commitOrLost(deps, items)) {
        await flushAuditEvents(deps, events);
        break;
      }
      if (tried === 2) throw new Error("approval_move_conflict");
    }
  }
}

/** Tells a person that something they asked for changed: a `home.changed` notice in their feed (ids and numbers only). Never throws: the record carries the reason. */
async function tellRequester(deps: LifecycleDeps, orgId: OrgId, developerId: string): Promise<void> {
  await writeChanges({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.log === undefined ? {} : { log: (entry: Record<string, unknown>) => { const { event, ...rest } = entry; deps.log!(typeof event === "string" ? event : "approval.requester_not_told", rest); } }) }, orgId, [
    { developerId, notice: { type: "home.changed", revision: 0 }, at: iso(deps.now()) },
  ]);
}

registerMemberMover({
  name: "approvals",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveApprovals(deps, orgId, duplicateId, survivorId, "merged"),
  removed: (deps, { orgId, developerId, successorId }) => moveApprovals(deps, orgId, developerId, successorId, "removed"),
  orphaned: (deps, { orgId, developerId }) => orphanApprovals(deps, orgId, developerId),
});
