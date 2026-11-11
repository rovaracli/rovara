// Member removal (v1.1), the always-run `access` step: what S0 recorded and left in place is deleted here, and it runs even when the person has rejoined since (a rejoin
// cancels only the hand-offs). The grants go by the exact `grantId` S0 recorded, so a grant given after a rejoin (a new id) survives; the leftover email pointers go
// only while they are older than the removal; the monthly limit override goes only while it is still the value S0 saw. Every step is conditional and repeatable.
import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { budgetSyncedKey, orgSettingsKey, type RemovedGrant } from "@agentx/cloud-contracts";
import { memberGrantsPk, MEMBER_GRANT_SK_PREFIX, type OrgId } from "@rovara-code/contracts";
import { auditOccurrence } from "../../audit/events.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditTransact, tryAuditEvents, type AuditDeps, type AuditRuntime } from "../../audit/outbox.js";
import { memberLimitChangedEvent } from "../../audit/plan3-hooks.js";
import { approvalGrantChange } from "../approval-membership.js";
import { budgetDocumentFence } from "../budget-snapshot.js";

const auditOf = (deps: { audit?: AuditRuntime | undefined }): AuditDeps => (deps.audit === undefined ? {} : { audit: deps.audit });

type Item = Record<string, unknown>;

export interface AccessStepDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime | undefined;
}

/** What the access step needs from the removal record. */
export interface AccessStepInput {
  orgId: OrgId;
  leaverId: string;
  removedAt: string;
  grants: readonly RemovedGrant[];
  memberLimitUsd?: number | undefined;
  leftoverEmailPointers: readonly string[];
}

export interface AccessStepResult { grantsRemoved: number; grantsKept: number }

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);
const SYSTEM_ACTOR = { kind: "system", id: "rovara" } as const;

async function get(deps: AccessStepDeps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Whether the grant now stored is the one S0 recorded (same id; a legacy grant with no id is the same while its roles are). */
function isRecorded(current: Item, recorded: RemovedGrant): boolean {
  if (recorded.grantId !== undefined) return current["grantId"] === recorded.grantId;
  return current["grantId"] === undefined && current["role"] === recorded.role && current["projectRole"] === recorded.projectRole;
}

async function deleteRecordedGrant(deps: AccessStepDeps, orgId: OrgId, leaverId: string, recorded: RemovedGrant): Promise<"removed" | "kept" | "gone"> {
  const key = { pk: memberGrantsPk(orgId, leaverId), sk: `${MEMBER_GRANT_SK_PREFIX}${recorded.project}` };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await get(deps, key);
    if (current === undefined) return "gone";
    if (!isRecorded(current, recorded)) return "kept";
    const names: Record<string, string> = { "#grantId": "grantId" };
    const values: Record<string, unknown> = {};
    const parts: string[] = [];
    if (recorded.grantId !== undefined) {
      values[":grantId"] = recorded.grantId;
      parts.push("#grantId = :grantId");
    } else {
      // A grant from before ids: the same one while it still has no id and the same roles.
      parts.push("attribute_not_exists(#grantId)");
      (["role", "projectRole"] as const).forEach((field, index) => {
        names[`#f${String(index)}`] = field;
        if (recorded[field] === undefined) parts.push(`attribute_not_exists(#f${String(index)})`);
        else {
          values[`:v${String(index)}`] = recorded[field];
          parts.push(`#f${String(index)} = :v${String(index)}`);
        }
      });
    }
    const condition = parts.join(" AND ");
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: deps.tableName, Key: key, ConditionExpression: condition, ExpressionAttributeNames: names, ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }) } },
        // The membership version moves with the loss, in the same transaction; the org may be closing, and the cut-off must still finish.
        ...await approvalGrantChange({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => new Date(deps.now()) }, orgId, recorded.project, recorded.projectRole === "maintainer", { allowClosing: true }),
      ] }));
      return "removed";
    } catch (error) {
      if (errorName(error) !== "TransactionCanceledException" && errorName(error) !== "ConditionalCheckFailedException") throw error;
      // Changed since it was read (a re-grant, a role change, a concurrent delete): read it again and decide again.
    }
  }
  throw new Error("member_removal_grant_conflict");
}

async function deleteLeftoverEmails(deps: AccessStepDeps, input: AccessStepInput): Promise<void> {
  for (const pk of input.leftoverEmailPointers) {
    try {
      await deps.documentClient.send(new DeleteCommand({
        TableName: deps.tableName, Key: { pk, sk: "DEVELOPER" }, ConditionExpression: "developerId = :leaver AND createdAt < :removedAt",
        ExpressionAttributeValues: { ":leaver": input.leaverId, ":removedAt": input.removedAt },
      }));
    } catch (error) {
      // Someone else's pointer, or one made after the removal (a rejoin): left alone.
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
}

/** Removes the leaver's monthly limit override while it is still the value S0 saw; a limit set after a rejoin is another value (or none was seen) and survives. */
async function removeLimitOverride(deps: AccessStepDeps, input: AccessStepInput): Promise<void> {
  if (input.memberLimitUsd === undefined) return;
  const key = orgSettingsKey(input.orgId, "BUDGET");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await get(deps, key);
    const seen = item?.["memberOverrides"];
    if (item === undefined || typeof seen !== "object" || seen === null || !Object.hasOwn(seen, input.leaverId)) return;
    const own = (seen as Record<string, unknown>)[input.leaverId];
    if (own !== input.memberLimitUsd) return;
    const fence = budgetDocumentFence(item);
    const others = Object.fromEntries(Object.entries(seen).filter(([id]) => id !== input.leaverId));
    const fallback = item["memberDefaultMonthlyUsd"];
    const at = new Date(deps.now()).toISOString();
    const events = await tryAuditEvents(auditOf(deps), () => [memberLimitChangedEvent({
      orgId: input.orgId, actor: SYSTEM_ACTOR, occurredAt: at, occurrence: auditOccurrence("override_removed", input.leaverId, at, String(own)),
      developerId: input.leaverId, from: input.memberLimitUsd, to: typeof fallback === "number" ? fallback : undefined,
    })]);
    try {
      await auditTransact(
        { ...auditOf(deps), documentClient: deps.documentClient },
        { Put: { TableName: deps.tableName, Item: { ...item, memberOverrides: others, revision: fence.nextRevision, updatedBy: "system", updatedAt: at }, ...fence.condition } },
        events,
      );
      await flushAuditEvents(auditOf(deps), events);
      return;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error("member_removal_budget_conflict");
}

/** The whole access step. Throws on a failure it cannot settle, so the marker stays and the sweep runs it again. */
export async function runAccessStep(deps: AccessStepDeps, input: AccessStepInput): Promise<AccessStepResult> {
  const result: AccessStepResult = { grantsRemoved: 0, grantsKept: 0 };
  for (const grant of input.grants) {
    const outcome = await deleteRecordedGrant(deps, input.orgId, input.leaverId, grant);
    if (outcome === "removed") result.grantsRemoved += 1;
    else if (outcome === "kept") result.grantsKept += 1;
  }
  await deleteLeftoverEmails(deps, input);
  await removeLimitOverride(deps, input);
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: budgetSyncedKey(input.orgId, input.leaverId) }));
  return result;
}
