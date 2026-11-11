// E1: the DynamoDB store of a project's context sources. One document per project (with a revision) and one item per pending change; a decided change is
// kept for the audit trail until its expiry. Every key starts with the org, so another org's items cannot be read by building a key from the caller's org.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ContextSourceSchema, ContextSourcesDocumentSchema, INDEX_EXPIRY_ATTRIBUTE, orgScoped, type ContextSourcesDocument, type OrgId } from "@rovara-code/contracts";
import type { ContextSourceChange, ContextSourceStore } from "./settings.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

/** How long a change is kept after it was made (a pending one expires unconfirmed). */
export const CHANGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const partition = (orgId: OrgId, project: string): string => orgScoped(orgId, `CTXSRC#${project}`);
const documentKey = (orgId: OrgId, project: string) => ({ pk: partition(orgId, project), sk: "DOC" });
const changeKey = (orgId: OrgId, project: string, changeId: string) => ({ pk: partition(orgId, project), sk: `CHG#${changeId}` });

function changeFrom(item: Item | undefined): ContextSourceChange | undefined {
  if (item === undefined || typeof item.changeId !== "string" || typeof item.project !== "string" || typeof item.orgId !== "string") return undefined;
  const source = item.source === undefined ? undefined : ContextSourceSchema.safeParse(item.source);
  // A stored source that no longer parses is not served: the change reads as missing, never as a half-valid one.
  if (source !== undefined && !source.success) return undefined;
  const status = item.status === "applied" || item.status === "rejected" ? item.status : "pending";
  return {
    changeId: item.changeId, orgId: item.orgId, project: item.project, kind: item.kind === "remove" ? "remove" : "set", sourceId: String(item.sourceId),
    ...(source === undefined ? {} : { source: source.data }),
    proposedBy: String(item.proposedBy), proposedAt: String(item.proposedAt), baseRevision: Number(item.baseRevision),
    secondAdminReasons: Array.isArray(item.secondAdminReasons) ? item.secondAdminReasons.map(String) : [], status,
    ...(typeof item.decidedBy === "string" ? { decidedBy: item.decidedBy } : {}), ...(typeof item.decidedAt === "string" ? { decidedAt: item.decidedAt } : {}),
  };
}

export function dynamoContextSourceStore(deps: { documentClient: DocumentClient; tableName: string; now: () => number }): ContextSourceStore {
  const expiry = () => Math.floor(deps.now() / 1_000) + CHANGE_RETENTION_SECONDS;
  const changeItem = (change: ContextSourceChange): Item => ({ ...changeKey(change.orgId, change.project, change.changeId), ...change, [INDEX_EXPIRY_ATTRIBUTE]: expiry() });
  return {
    async readDocument(orgId, project): Promise<ContextSourcesDocument> {
      const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: documentKey(orgId, project), ConsistentRead: true }))) as { Item?: Item };
      if (found.Item === undefined) return { revision: 0, sources: [] };
      const parsed = ContextSourcesDocumentSchema.safeParse({ revision: found.Item.revision, sources: found.Item.sources });
      // A document that does not parse serves no sources at all: every source of the project is off until an admin saves it again.
      return parsed.success ? parsed.data : { revision: typeof found.Item.revision === "number" ? found.Item.revision : 0, sources: [] };
    },
    async putChange(change) {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: deps.tableName, Item: changeItem(change), ConditionExpression: "attribute_not_exists(pk)" } }] }));
    },
    async getChange(orgId, project, changeId) {
      const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: changeKey(orgId, project, changeId), ConsistentRead: true }))) as { Item?: Item };
      return changeFrom(found.Item);
    },
    async listPending(orgId, project) {
      const found = (await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": partition(orgId, project), ":prefix": "CHG#" }, Limit: 100,
      }))) as { Items?: Item[] };
      return (found.Items ?? []).map(changeFrom).filter((change): change is ContextSourceChange => change?.status === "pending");
    },
    async apply({ change, next, decidedBy, decidedAt }) {
      const key = documentKey(change.orgId, change.project);
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: deps.tableName, Item: { ...key, revision: next.revision, sources: next.sources }, ...(change.baseRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "revision = :base", ExpressionAttributeValues: { ":base": change.baseRevision } }) } },
          { Update: { TableName: deps.tableName, Key: changeKey(change.orgId, change.project, change.changeId), UpdateExpression: "SET #status = :applied, decidedBy = :by, decidedAt = :at", ConditionExpression: "#status = :pending", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":applied": "applied", ":pending": "pending", ":by": decidedBy, ":at": decidedAt } } },
        ] }));
        return "applied";
      } catch (error) {
        if (isCancelled(error)) return "stale";
        throw error;
      }
    },
    async reject({ change, decidedBy, decidedAt }) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: deps.tableName, Key: changeKey(change.orgId, change.project, change.changeId), UpdateExpression: "SET #status = :rejected, decidedBy = :by, decidedAt = :at", ConditionExpression: "#status = :pending", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":by": decidedBy, ":at": decidedAt } } },
        ] }));
        return "rejected";
      } catch (error) {
        if (isCancelled(error)) return "stale";
        throw error;
      }
    },
  };
}

function isCancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TransactionCanceledException" || name === "ConditionalCheckFailedException";
}
