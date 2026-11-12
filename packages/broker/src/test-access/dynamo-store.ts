// Customer test AWS account, lane TA2: the DynamoDB adapter of `TestAccessStore`, in the State table. Items:
//   connection   pk `ORG#<org>`            sk `TACONN#<connectionId>`   { kind, version, record }
//   token        pk `TATOKEN#<hash>`        sk `TOKEN`                   { orgId, projectId, connectionId, region, expiresAtMs, usedAtMs? }  (the HASH is the key; the token is nowhere)
//   stack        pk `TASTACK#<sha256 id>`   sk `STACK`                   { stackId, orgId, connectionId, accountId, recordedAtMs }
//   poll list    pk `TAPOLL`                sk `<org>#<connectionId>`    { orgId, connectionId }  (present while a connection is `polling`)
// Every multi-item change is ONE transaction with its audit pending item (a transaction holds at most 100 items; these hold at most 6). Token items and poll items expire with the State table's TTL attribute.
// A row that does not parse strictly, or whose key and body name different organizations, is treated as absent (and logged by name only): nothing is trusted from a row that is not exactly what this adapter writes.
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, orgPk } from "@rovara-code/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEventInput } from "@agentx/cloud-contracts";
import { auditPending, type AuditDeps } from "../audit/outbox.js";
import { CONNECTION_CHECK_IDS, CONNECTION_STATUSES, type ConnectTokenItem, type ConnectionRecord, type ConsumeResult, type StackItem, type TestAccessStore } from "./store.js";

const POLL_PK = "TAPOLL";
const DAY_SECONDS = 86_400;
const iso = z.string().min(1).max(40);
const ConnectionRecordSchema = z.object({
  orgId: z.string(), connectionId: z.string().regex(/^conn_[0-9a-z]{20}$/u), projectId: z.string(), region: z.string(), status: z.enum(CONNECTION_STATUSES), version: z.number().int().positive(), externalId: z.string(), createdBy: z.string(), createdAt: iso, tokenExpiresAt: iso,
  stackId: z.string().optional(), accountId: z.string().optional(), roleArn: z.string().optional(), cleanupRoleArn: z.string().optional(), templateVersion: z.string().optional(), reportedAt: iso.optional(), reportedVia: z.enum(["callback", "account_id"]).optional(),
  pollAccountId: z.string().optional(), pollUntil: iso.optional(), pollSubmittedBy: z.string().optional(), lastPolledAt: iso.optional(), confirmedBy: z.string().optional(), confirmedAt: iso.optional(), alias: z.string().optional(), notProductionAck: z.boolean().optional(),
  lastTest: z.object({ at: iso, passed: z.boolean(), checks: z.array(z.object({ id: z.enum(CONNECTION_CHECK_IDS), status: z.enum(["pass", "fail", "warn", "skipped"]), code: z.string().optional(), services: z.array(z.string()).optional() }).strict()), leftover: z.string().optional() }).strict().optional(),
  endedAt: iso.optional(), endCause: z.string().optional(),
}).strict();
const TokenItemSchema = z.object({ orgId: z.string(), projectId: z.string(), connectionId: z.string(), region: z.string(), expiresAtMs: z.number(), usedAtMs: z.number().optional() });
const StackItemSchema = z.object({ stackId: z.string(), orgId: z.string(), connectionId: z.string(), accountId: z.string(), tokenHash: z.string().regex(/^[0-9a-f]{64}$/u), recordedAtMs: z.number() });

type Client = { send(command: unknown): Promise<unknown> };
type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const connectionKey = (orgId: string, connectionId: string) => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `TACONN#${connectionId}` });
const tokenKey = (tokenHash: string) => ({ pk: `TATOKEN#${tokenHash}`, sk: "TOKEN" });
const stackKey = (stackId: string) => ({ pk: `TASTACK#${sha256(stackId)}`, sk: "STACK" });
const pollKey = (orgId: string, connectionId: string) => ({ pk: POLL_PK, sk: `${orgId}#${connectionId}` });
const seconds = (ms: number): number => Math.floor(ms / 1_000);

export interface DynamoTestAccessStoreConfig extends AuditDeps {
  documentClient: Client;
  tableName: string;
  log?: (entry: Record<string, string>) => void;
}

/** The index of the transaction item whose condition failed, in the order the items were given; undefined when the failure was not a condition. */
function failedConditions(error: unknown): boolean[] | undefined {
  if (nameOf(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return Array.isArray(reasons) ? reasons.map((reason) => reason?.Code === "ConditionalCheckFailed") : undefined;
}

export function dynamoTestAccessStore(config: DynamoTestAccessStoreConfig): TestAccessStore {
  const { documentClient, tableName } = config;
  const auditItems = (event: AuditEventInput | undefined): TransactItem[] => (event === undefined ? [] : auditPending(config, event));
  const connectionItem = (record: ConnectionRecord, condition: { exists: true; expectedVersion: number } | { exists: false }): TransactItem => ({
    Put: {
      TableName: tableName,
      Item: { ...connectionKey(record.orgId, record.connectionId), kind: "test_access_connection", version: record.version, record },
      ...(condition.exists
        ? { ConditionExpression: "attribute_exists(pk) AND #version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": condition.expectedVersion } }
        : { ConditionExpression: "attribute_not_exists(pk)" }),
    },
  });
  /** The poll list follows the status: an item while `polling`, none otherwise. */
  const pollItem = (record: ConnectionRecord): TransactItem => record.status === "polling"
    ? { Put: { TableName: tableName, Item: { ...pollKey(record.orgId, record.connectionId), orgId: record.orgId, connectionId: record.connectionId, [INDEX_EXPIRY_ATTRIBUTE]: seconds(Date.parse(record.pollUntil ?? record.tokenExpiresAt)) + 3_600 } } }
    : { Delete: { TableName: tableName, Key: pollKey(record.orgId, record.connectionId) } };
  const parseConnection = (item: Record<string, unknown> | undefined, expectOrg: string, expectId: string): ConnectionRecord | undefined => {
    if (item === undefined) return undefined;
    const parsed = ConnectionRecordSchema.safeParse(item["record"]);
    if (!parsed.success || parsed.data.orgId !== expectOrg || parsed.data.connectionId !== expectId || item["pk"] !== orgPk(OrgIdSchema.parse(expectOrg)) || item["sk"] !== `TACONN#${expectId}` || item["version"] !== parsed.data.version) {
      config.log?.({ event: "test_access.row_unreadable", kind: "connection" });
      return undefined;
    }
    return parsed.data as ConnectionRecord;
  };

  return {
    async createConnection(record, token, audit) {
      try {
        await documentClient.send(new TransactWriteCommand({
          TransactItems: [
            connectionItem(record, { exists: false }),
            { Put: { TableName: tableName, Item: { ...tokenKey(token.tokenHash), orgId: token.orgId, projectId: token.projectId, connectionId: token.connectionId, region: token.region, expiresAtMs: token.expiresAtMs, [INDEX_EXPIRY_ATTRIBUTE]: seconds(token.expiresAtMs) + DAY_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" } },
            ...auditItems(audit),
          ],
        }));
        return true;
      } catch (error) {
        if (failedConditions(error)?.slice(0, 2).some(Boolean) === true) return false;
        throw error;
      }
    },

    async getConnection(orgId, connectionId) {
      const out = (await documentClient.send(new GetCommand({ TableName: tableName, Key: connectionKey(orgId, connectionId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      return parseConnection(out.Item, orgId, connectionId);
    },

    async listConnections(orgId, limit) {
      const found: ConnectionRecord[] = [];
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < 10 && found.length < limit; page += 1) {
        const out = (await documentClient.send(new QueryCommand({
          TableName: tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)", ExpressionAttributeValues: { ":pk": orgPk(OrgIdSchema.parse(orgId)), ":sk": "TACONN#" }, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of out.Items ?? []) {
          const id = typeof item["sk"] === "string" ? item["sk"].slice("TACONN#".length) : "";
          const record = parseConnection(item, orgId, id);
          if (record !== undefined && found.length < limit) found.push(record);
        }
        if (out.LastEvaluatedKey === undefined) break;
        startKey = out.LastEvaluatedKey;
      }
      return found;
    },

    async commitConnection(next, expectedVersion, audit) {
      try {
        await documentClient.send(new TransactWriteCommand({
          TransactItems: [
            connectionItem(next, { exists: true, expectedVersion }),
            pollItem(next),
            // A disconnected connection forgets its stack: a later message for it changes nothing.
            ...(next.status === "disconnected" && next.stackId !== undefined ? [{ Delete: { TableName: tableName, Key: stackKey(next.stackId) } }] : []),
            ...auditItems(audit),
          ],
        }));
        return true;
      } catch (error) {
        if (failedConditions(error)?.[0] === true) return false;
        throw error;
      }
    },

    async getToken(tokenHash) {
      const out = (await documentClient.send(new GetCommand({ TableName: tableName, Key: tokenKey(tokenHash), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      if (out.Item === undefined) return undefined;
      const parsed = TokenItemSchema.safeParse(out.Item);
      if (!parsed.success || out.Item["pk"] !== tokenKey(tokenHash).pk) {
        config.log?.({ event: "test_access.row_unreadable", kind: "token" });
        return undefined;
      }
      const { usedAtMs, ...rest } = parsed.data;
      return { tokenHash, ...rest, ...(usedAtMs === undefined ? {} : { usedAtMs }) } satisfies ConnectTokenItem;
    },

    async consumeToken(input): Promise<ConsumeResult> {
      const { next } = input;
      try {
        await documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              // The token: exists, unused, unexpired, and made for exactly this organization, project and connection.
              Update: {
                TableName: tableName, Key: tokenKey(input.tokenHash), UpdateExpression: "SET usedAtMs = :now",
                ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAtMs) AND expiresAtMs > :now AND orgId = :org AND projectId = :project AND connectionId = :connection",
                ExpressionAttributeValues: { ":now": input.nowMs, ":org": next.orgId, ":project": next.projectId, ":connection": next.connectionId },
              },
            },
            { Put: { TableName: tableName, Item: { ...stackKey(input.stack.stackId), ...input.stack }, ConditionExpression: "attribute_not_exists(pk)" } },
            connectionItem(next, { exists: true, expectedVersion: input.expectedVersion }),
            pollItem(next),
            ...auditItems(input.audit),
          ],
        }));
        return "ok";
      } catch (error) {
        const failed = failedConditions(error);
        if (failed?.[0] === true) return "token_refused";
        if (failed?.[1] === true) return "stack_taken";
        if (failed?.[2] === true) return "connection_changed";
        throw error;
      }
    },

    async retireToken(tokenHash, nowMs) {
      try {
        await documentClient.send(new UpdateCommand({ TableName: tableName, Key: tokenKey(tokenHash), UpdateExpression: "SET usedAtMs = :now", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAtMs)", ExpressionAttributeValues: { ":now": nowMs } }));
      } catch (error) {
        if (nameOf(error) !== "ConditionalCheckFailedException") throw error;
      }
    },

    async getStack(stackId) {
      const out = (await documentClient.send(new GetCommand({ TableName: tableName, Key: stackKey(stackId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      if (out.Item === undefined) return undefined;
      const parsed = StackItemSchema.safeParse(out.Item);
      // The key is a hash: the row must name the very stack asked for.
      if (!parsed.success || parsed.data.stackId !== stackId) {
        config.log?.({ event: "test_access.row_unreadable", kind: "stack" });
        return undefined;
      }
      return parsed.data satisfies StackItem;
    },

    async listPolling(limit) {
      const out = (await documentClient.send(new QueryCommand({ TableName: tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": POLL_PK }, Limit: limit }))) as { Items?: Array<Record<string, unknown>> };
      const found: Array<{ orgId: string; connectionId: string }> = [];
      for (const item of out.Items ?? []) {
        if (OrgIdSchema.safeParse(item["orgId"]).success && typeof item["connectionId"] === "string" && /^conn_[0-9a-z]{20}$/u.test(item["connectionId"]) && item["sk"] === `${String(item["orgId"])}#${item["connectionId"]}`) found.push({ orgId: item["orgId"] as string, connectionId: item["connectionId"] });
      }
      return found;
    },
  };
}
