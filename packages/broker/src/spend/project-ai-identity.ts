// Own-grant project AI writes bind the native caller profile in their existing atomic commit.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeveloperSignInMethodSchema } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import { methodSessionsEndedAttribute } from "../developer/store.js";
import { Aliases, type TransactItem } from "../agents/table-writes.js";

type Deps = { documentClient: { send(command: unknown): Promise<unknown> }; projectAiSignInTableName?: string };
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The caller's current sign-in identity could not be checked. Reload or ask an installation administrator to check it.");

/** No survivor routing or State-table fallback. Native unlink changes method-ending marks. */
export async function projectAiCallerCheck(deps: Deps, by: string): Promise<TransactItem> {
  const table = deps.projectAiSignInTableName;
  if (typeof table !== "string" || table.trim() === "" || typeof deps.documentClient?.send !== "function") throw unavailable();
  const key = { pk: `DEVELOPER#${by}`, sk: "META" };
  let row: Record<string, unknown> | undefined;
  try {
    const response = await deps.documentClient.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    row = response.Item;
  } catch { throw unavailable(); }
  if (row === undefined || row === null || typeof row !== "object" || Array.isArray(row) || row.pk !== key.pk || row.sk !== key.sk || (row.developerId !== undefined && row.developerId !== by) || Object.hasOwn(row, "mergedInto") || (Object.hasOwn(row, "revoked") && row.revoked !== false)) throw unavailable();
  const marks = ["sessionsEndedAt", ...DeveloperSignInMethodSchema.options.map(methodSessionsEndedAttribute)];
  for (const field of marks) {
    if (Object.hasOwn(row, field) && (typeof row[field] !== "string" || !Number.isFinite(Date.parse(row[field])))) throw unavailable();
  }
  // The row is keyed by the person: a sign-in writes no `developerId` attribute (store.ts getDeveloper), so only a row naming someone else is refused.
  const aliases = new Aliases(), developerId = aliases.name("developerId");
  const condition = ["attribute_exists(pk)", `(attribute_not_exists(${developerId}) OR ${developerId} = ${aliases.value(by)})`, `attribute_not_exists(${aliases.name("mergedInto")})`, ...["revoked", ...marks].map(field => Object.hasOwn(row, field) ? `${aliases.name(field)} = ${aliases.value(row[field])}` : `attribute_not_exists(${aliases.name(field)})`)].join(" AND ");
  return { ConditionCheck: { TableName: table, Key: key, ConditionExpression: condition, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values } };
}
