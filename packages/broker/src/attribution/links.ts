// Enterprise foundations, I3 fix round 1: the only place a commit's reference leads to a person. A commit carries a random reference (`contracts/attribution.ts`); this row says who it
// stood for. Erasing a person deletes their rows, after which every reference they ever had leads nowhere, in git history that cannot be rewritten. Nothing else keeps the link.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgScoped, type OrgId } from "@agentx/contracts";

type DocumentClient = { send(command: unknown): Promise<unknown> };

export interface AttributionLink {
  /** The random reference written on the commit. */
  ref: string;
  developerId: string;
  role: "requester" | "approver";
  /** The task whose change request carries the person's name, so erasure can rewrite that description. */
  taskId: string;
  createdAt: string;
}

export interface AttributionLinkStore {
  put(orgId: OrgId, link: AttributionLink): Promise<void>;
  /** The person a reference stood for, or undefined when there is no such reference or it was erased. */
  resolve(orgId: OrgId, ref: string): Promise<AttributionLink | undefined>;
  /** Deletes every row of the person and returns what was deleted (the tasks whose descriptions to rewrite). */
  eraseFor(orgId: OrgId, developerId: string): Promise<AttributionLink[]>;
}

const REF = /^[a-f0-9]{16}$/u;
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const refKey = (orgId: OrgId, ref: string) => ({ pk: orgScoped(orgId, "ATTRIBUTION_REF"), sk: ref });
const personKey = (orgId: OrgId, developerId: string, ref: string) => ({ pk: orgScoped(orgId, "ATTRIBUTION_PERSON"), sk: `${developerId}#${ref}` });
/** A person's rows live under one prefix of one partition; at most this many pages of this size are read for one erasure, and an erasure that is not finished says so. */
const PAGE = 100;
const MAX_PAGES = 100;

export function dynamoAttributionLinkStore(input: { documentClient: DocumentClient; tableName: string }): AttributionLinkStore {
  const { documentClient, tableName } = input;
  return {
    async put(orgId, link) {
      if (!REF.test(link.ref) || !DEVELOPER_ID.test(link.developerId)) throw agentXError("CONFIG_INVALID", "the attribution reference is not valid");
      const item = { entityType: "ATTRIBUTION_LINK", orgId, ...link };
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...refKey(orgId, link.ref), ...item }, ConditionExpression: "attribute_not_exists(pk)" }));
      await documentClient.send(new PutCommand({ TableName: tableName, Item: { ...personKey(orgId, link.developerId, link.ref), ...item } }));
    },
    async resolve(orgId, ref) {
      if (!REF.test(ref)) return undefined;
      const found = await documentClient.send(new GetCommand({ TableName: tableName, Key: refKey(orgId, ref), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      return found.Item === undefined ? undefined : linkOf(found.Item);
    },
    async eraseFor(orgId, developerId) {
      if (!DEVELOPER_ID.test(developerId)) throw agentXError("CONFIG_INVALID", "the person id is not valid");
      const erased: AttributionLink[] = [];
      let start: Record<string, unknown> | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await documentClient.send(new QueryCommand({
          TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": orgScoped(orgId, "ATTRIBUTION_PERSON"), ":prefix": `${developerId}#` }, ConsistentRead: true, Limit: PAGE, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of response.Items ?? []) {
          const link = linkOf(item);
          // The reference row goes first: once it is gone the commit's reference leads nowhere, whatever happens to the person row after.
          await documentClient.send(new DeleteCommand({ TableName: tableName, Key: refKey(orgId, link.ref) }));
          await documentClient.send(new DeleteCommand({ TableName: tableName, Key: personKey(orgId, developerId, link.ref) }));
          erased.push(link);
        }
        start = response.LastEvaluatedKey;
        if (start === undefined) return erased;
      }
      throw agentXError("RUNTIME_UNAVAILABLE", "the person has more attribution rows than one erasure pass reads; run it again");
    },
  };
}

function linkOf(item: Record<string, unknown>): AttributionLink {
  const { ref, developerId, role, taskId, createdAt } = item;
  if (typeof ref !== "string" || typeof developerId !== "string" || (role !== "requester" && role !== "approver") || typeof taskId !== "string" || typeof createdAt !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "an attribution row is not readable");
  }
  return { ref, developerId, role, taskId, createdAt };
}
