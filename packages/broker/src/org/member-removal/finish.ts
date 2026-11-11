// Member removal (v1.1), S7: the removal's last step. One transaction ends the removal record (`DONE`, or `CANCELLED_REJOINED` when the person came back before the
// hand-offs ran), deletes the marker and writes the one `member.removal_completed` audit item. Conditional on the record still being `STARTED`, so it is written once per removal.
import { TransactWriteCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { memberRemovalRecordKey } from "@agentx/cloud-contracts";
import { type OrgId, type OrgKey } from "@rovara-code/contracts";
import { auditMemberRemovalCompleted } from "../../audit/events.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditDeps, type AuditRuntime } from "../../audit/outbox.js";

const auditOf = (deps: { audit?: AuditRuntime | undefined }): AuditDeps => (deps.audit === undefined ? {} : { audit: deps.audit });

export interface FinishDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime | undefined;
}

/** The counts the completion event may carry (its fact keys; anything else is dropped). */
const COUNT_KEYS = ["approvalsMoved", "spendRequestsMoved", "agentsMoved", "skillsMoved", "chainsMoved", "triggersMoved", "grantsRemoved", "grantsKept", "signInEnded", "countsComplete"] as const;

export interface FinishInput {
  orgId: OrgId;
  removalId: string;
  leaverId: string;
  role: string;
  successorId?: string | undefined;
  by: string;
  outcome: "done" | "cancelled_rejoined";
  counts: Record<string, number | boolean>;
  /** The marker to delete in the same transaction; absent when there was none. */
  marker?: OrgKey | undefined;
}

export async function finishRemoval(deps: FinishDeps, input: FinishInput): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  const counts = Object.fromEntries(COUNT_KEYS.flatMap((key) => (input.counts[key] === undefined ? [] : [[key, input.counts[key]] as const])));
  const event = await tryAuditEvent(auditOf(deps), () => auditMemberRemovalCompleted({
    orgId: input.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: input.removalId, memberId: input.leaverId,
    outcome: input.outcome, wasRole: input.role, counts,
    related: [...(input.successorId === undefined ? [] : [input.successorId]), ...(input.by === "system" ? [] : [input.by])],
  }));
  const recordKey = memberRemovalRecordKey(input.orgId, input.removalId);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: deps.tableName, Key: recordKey, UpdateExpression: "SET #state = :final, finishedAt = :at, #counts = :counts",
          ConditionExpression: "attribute_exists(pk) AND #state = :started", ExpressionAttributeNames: { "#state": "state", "#counts": "counts" },
          ExpressionAttributeValues: { ":final": input.outcome === "done" ? "DONE" : "CANCELLED_REJOINED", ":started": "STARTED", ":at": at, ":counts": counts },
        },
      },
      ...(input.marker === undefined ? [] : [{ Delete: { TableName: deps.tableName, Key: input.marker } }]),
      ...(event === undefined ? [] : auditPending(auditOf(deps), event)),
    ] }));
    if (event !== undefined) await flushAuditEvents(auditOf(deps), [event]);
  } catch (error) {
    if ((error instanceof Error ? error.name : undefined) !== "TransactionCanceledException") throw error;
    // Finished by an earlier run: only the marker is left to remove. Anything else about the record is not this call's to settle.
    const stored = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: recordKey, ConsistentRead: true }))) as { Item?: { state?: unknown } }).Item;
    if (stored === undefined || stored.state === "STARTED") throw error;
    if (input.marker !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: input.marker }));
  }
}
