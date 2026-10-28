// One conditional snapshot/revision protocol for every physical writer of the existing BUDGET document.
import { agentXError } from "@agentx/contracts";
import { Aliases, NOT_EXISTS } from "../agents/table-writes.js";
export function budgetDocumentFence(raw: Record<string, unknown> | undefined, options: { repairMalformed?: boolean } = {}) {
  let revision = raw?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (revision as number) >= Number.MAX_SAFE_INTEGER || (raw !== undefined && Object.hasOwn(raw, "revision") && revision === 0)) {
    if (!options.repairMalformed || (Number.isSafeInteger(revision) && (revision as number) >= Number.MAX_SAFE_INTEGER)) throw agentXError("CONFIG_INVALID", "The company budget revision cannot be advanced. Ask an org owner or admin to repair it.");
    // Only an explicit authorized budget write repairs metadata; the condition below still compares the exact malformed raw value.
    revision = 0;
  }
  const aliases = new Aliases();
  const condition = raw === undefined ? NOT_EXISTS : ["attribute_exists(pk)", ...["revision", "orgMonthlyUsd", "memberDefaultMonthlyUsd", "memberOverrides", "updatedBy", "updatedAt"].map(field => raw[field] === undefined ? `attribute_not_exists(${aliases.name(field)})` : `${aliases.name(field)} = ${aliases.value(raw[field])}`)].join(" AND ");
  return { revision: revision as number, nextRevision: (revision as number) + 1, condition: {
    ConditionExpression: condition,
    ...(Object.keys(aliases.names).length === 0 ? {} : { ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values }),
  } };
}
