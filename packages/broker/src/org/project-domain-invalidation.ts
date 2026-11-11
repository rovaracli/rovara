import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, projectPk, type OrgId } from "@rovara-code/contracts";
import type { TransactItem } from "../audit/outbox.js";
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Pending website state could not be checked.");
/** Narrowing changes the proposal's canonical base. Invalidate it in the SAME
 * change transaction; a company approval can never silently rebase onto it. */
export async function planPendingWebsiteInvalidation(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; requestId: string; nextRevision: number; at: string }): Promise<{ items: TransactItem[]; proposalId?: string }> {
 const pk = projectPk(input.orgId, input.project), pointerKey = { pk, sk: "EGRESS_PROPOSAL_LIVE" };
 const get = async (Key: { pk: string; sk: string }) => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
 const rawPointer = await get(pointerKey);if (rawPointer === undefined) return { items: [] };
 const checked = z.object({ orgId: z.literal(input.orgId), project: z.literal(input.project), entityType: z.literal("EGRESS_PROPOSAL_LIVE"), proposalId: z.string().uuid(), expiresAt: z.string().datetime() }).passthrough().safeParse(rawPointer);
 if (!checked.success || checked.data.proposalId === input.requestId) throw unavailable();
 const pointer = checked.data, proposalKey = { pk, sk: `EGRESS_PROPOSAL#${pointer.proposalId}` }, raw = await get(proposalKey), items: TransactItem[] = [];
 if (raw === undefined) { if (Date.parse(pointer.expiresAt) > Date.parse(input.at)) throw unavailable(); }
 else {
  const checkedProposal = z.object({ orgId: z.literal(input.orgId), project: z.literal(input.project), entityType: z.literal("EGRESS_PROPOSAL"), kind: z.literal("widening"),
   proposalId: z.literal(pointer.proposalId), by: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["pending", "applied", "rejected", "cancelled"]), baseRevision: z.number().int().positive(),
   bodyHash: z.string().regex(/^[a-f0-9]{64}$/), afterDigest: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().safeParse(raw);
  if (!checkedProposal.success) throw unavailable();
  if (checkedProposal.data.state === "pending") {
   const names: Record<string, string> = {}, values: Record<string, unknown> = {}, conditions = ["attribute_exists(pk)"];
   for (const [i, field] of Object.keys(raw).filter(field => field !== "pk" && field !== "sk").sort().entries()) {
    const name = `#i${i}`, value = `:i${i}`;names[name] = field;values[value] = raw[field];conditions.push(`${name} = ${value}`);
   }
   items.push({ Put: { TableName: deps.tableName, Item: { ...raw, state: "cancelled", decidedAt: input.at, decidedBy: input.by, decisionRequestId: input.requestId,
    supersededByRevision: input.nextRevision, reason: "Superseded by direct narrowing." }, ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
  }
 }
 items.push({ Delete: { TableName: deps.tableName, Key: pointerKey, ConditionExpression: "proposalId = :id AND expiresAt = :expires AND orgId = :org AND #project = :project AND entityType = :type",
  ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":id": pointer.proposalId, ":expires": pointer.expiresAt, ":org": input.orgId, ":project": input.project, ":type": "EGRESS_PROPOSAL_LIVE" } } });
 return { items, proposalId: pointer.proposalId };
}
