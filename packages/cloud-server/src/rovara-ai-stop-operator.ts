// Operator tooling only: deliberately not exported by the server index or mounted on any route.
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildAuditRecord, INSTALL_AI_AUDIT_SCOPE } from "./audit-log.js";
import { auditAppendItems } from "./dynamo-stores.js";

const SETTING = Object.freeze({ pk: "INSTALL#ROVARA_AI", sk: "SETTING" });

/** DEC 328: no caller-selected record in the reserved partition. The operator supplies its STS identity. */
export async function writeInstallRovaraAi(
  db: Pick<DynamoDBDocumentClient, "send">, tables: { companies: string; audit: string },
  input: { key: { pk: string; sk: string }; enabled: boolean; operatorArn: string }, now: () => Date = () => new Date(),
): Promise<void> {
  if (input.key.pk !== SETTING.pk || input.key.sk !== SETTING.sk || typeof input.enabled !== "boolean" || !/^arn:aws(?:-us-gov|-cn)?:[a-z]+::\d{12}:(?:user|assumed-role|role)\/[^\s]{1,150}$/u.test(input.operatorArn)) throw new Error("operator setting refused");
  const record = buildAuditRecord({ companyId: INSTALL_AI_AUDIT_SCOPE, actor: { developerId: "operator", name: input.operatorArn, type: "operator" }, action: "install.rovara_ai.changed", via: "operator", subject: "install:rovara_ai", detail: input.enabled ? "enabled" : "paused" }, now());
  const row = (await db.send(new GetCommand({ TableName: tables.companies, Key: SETTING, ConsistentRead: true }))).Item;
  if (row !== undefined && (row.pk !== SETTING.pk || row.sk !== SETTING.sk || typeof row.enabled !== "boolean" || !Number.isSafeInteger(row.version) || (row.version as number) < 1)) throw new Error("install setting unreadable");
  const version = row === undefined ? 0 : row.version as number;
  // A toggle and its audit either both apply, or neither. Concurrent operators must read again.
  await db.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: tables.companies, Item: { ...SETTING, enabled: input.enabled, version: version + 1, updatedAt: record.at, updatedBy: input.operatorArn },
      ...(version === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": version } }) } },
    ...auditAppendItems(tables.audit, record),
  ] }));
}
