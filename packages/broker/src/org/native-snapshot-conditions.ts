import { agentXError } from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
/** Conditions for an already validated native snapshot, including meaningful
 * absence. This supplies no authority and performs no reads or writes. */
export function nativeSnapshotConditions(tableName: string, keys: readonly { pk: string; sk: string }[], rows: readonly (Record<string, unknown> | undefined)[], presenceFields: readonly string[]): TransactItem[] {
  if (keys.length !== rows.length) throw agentXError("CONFIG_INVALID", "The spending snapshot is incomplete.");
  return keys.map((key, index) => {
    const source = rows[index];
    if (source === undefined) return { ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: "attribute_not_exists(pk)" } };
    if (source.pk !== key.pk || source.sk !== key.sk) throw agentXError("CONFIG_INVALID", "The spending snapshot identity changed.");
    const names: Record<string, string> = {}, values: Record<string, unknown> = {};
    const fields = [...new Set([...Object.keys(source), ...presenceFields])];
    const clauses = fields.map((field, fieldIndex) => {
      const name = `#cutoverSource${index}_${fieldIndex}`, value = `:cutoverSource${index}_${fieldIndex}`; names[name] = field;
      if (source[field] === undefined) return `attribute_not_exists(${name})`;
      values[value] = source[field]; return `${name} = ${value}`;
    });
    return { ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
  });
}
