// Real admin routes over a persistent, bounded transactional table; unsupported expressions fail closed.
import { GetCommand, QueryCommand, TransactWriteCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, orgMetaKey, developerOrgKey, OrgRoleSchema, type OrgRole } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { OrgStore } from "../../../packages/broker/src/org/store.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import type { AuditRuntime } from "../../../packages/broker/src/audit/outbox.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER } from "../../web/support/fixtures.js";
type Row = Record<string, unknown>;
const keyOf = (key: Row | { pk: string; sk: string } | undefined) => `${String(key?.pk)}|${String(key?.sk)}`;
export function createAdminDirectory() {
 const rows = new Map<string, Row>(), audit: Row[] = [];
 const put = (row: Row) => rows.set(keyOf(row), structuredClone(row));
 function setRole(id: string, role: OrgRole, org: string = FIXTURE_ORG) {
  put({ ...orgMemberKey(org, id), orgId: org, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });put({ ...developerOrgKey(id), orgId: org, role });
 }
 for (const [org, id, name, role] of [[FIXTURE_ORG, FIXTURE_DEVELOPER, "Priya", "owner"], [FIXTURE_ORG, "b".repeat(64), "Maya", "member"], ["org_bbbbbbbbbbbbbbbbbbbb", "c".repeat(64), "Other company person", "owner"]] as const) {
  setRole(id, role, org);put({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name, provider: "cloud" });
 }
 put({ ...orgMetaKey(FIXTURE_ORG), orgId: FIXTURE_ORG, name: "Acme", plan: "team", createdBy: FIXTURE_DEVELOPER });
 function condition(expression: string | undefined, row: Row | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
  if (expression === undefined) return true;
  return expression.split(/\s+AND\s+/).every(part => {
   if (part === "attribute_not_exists(pk)") return row === undefined;
   if (part === "attribute_exists(pk)") return row !== undefined;
   const equal = /^(#[A-Za-z]+|[A-Za-z]+) = (:[A-Za-z]+)$/.exec(part);
   if (equal === null) throw new Error("Unsupported fixture condition.");
   return row?.[names[equal[1]!] ?? equal[1]!] === values[equal[2]!];
  });
 }
 const documentClient = { async send(command: unknown): Promise<unknown> {
  if (command instanceof GetCommand) return { Item: rows.get(keyOf(command.input.Key ?? {})) };
  if (command instanceof QueryCommand) { const values = command.input.ExpressionAttributeValues ?? {};return { Items: [...rows.values()].filter(row => row.pk === values[":pk"] && String(row.sk).startsWith(String(values[":prefix"] ?? ""))) }; }
  if (command instanceof DeleteCommand) { rows.delete(keyOf(command.input.Key ?? {}));return {}; }
  if (!(command instanceof TransactWriteCommand)) throw new Error("Unsupported fixture command.");
  const actions = command.input.TransactItems ?? [];
  if (actions.length > 100) throw new Error("Fixture transaction limit.");
  const checks = actions.map(action => {
   const write = action.Update ?? action.ConditionCheck ?? action.Put;
   if (write === undefined) throw new Error("Unsupported fixture transaction item.");
   const expression = `${write.ConditionExpression ?? ""} ${"UpdateExpression" in write ? write.UpdateExpression ?? "" : ""}`;
   const tokens = new Set(expression.match(/[:#][A-Za-z0-9_]+/g) ?? []);
   for (const token of tokens) { if (!Object.hasOwn(token.startsWith("#") ? write.ExpressionAttributeNames ?? {} : write.ExpressionAttributeValues ?? {}, token)) throw new Error("Missing fixture expression attribute."); }
   for (const [token, value] of Object.entries({ ...write.ExpressionAttributeNames, ...write.ExpressionAttributeValues })) { if (!tokens.has(token) || value === undefined) throw new Error("Invalid fixture expression attribute."); }
   const key = "Key" in write ? write.Key : "Item" in write ? write.Item : undefined;
   return condition(write.ConditionExpression, rows.get(keyOf(key ?? {})), write.ExpressionAttributeNames, write.ExpressionAttributeValues);
  });
  if (checks.some(ok => !ok)) throw Object.assign(new Error("Fixture transaction cancelled."), { name: "TransactionCanceledException", CancellationReasons: checks.map(ok => ({ Code: ok ? "None" : "ConditionalCheckFailed" })) });
  for (const action of actions) {
   if (action.Put?.Item !== undefined) put(action.Put.Item);
   if (action.Update !== undefined) {
    if (action.Update.UpdateExpression !== "SET #role = :role" && action.Update.UpdateExpression !== "SET #role = :role, roleUpdatedAt = :at") throw new Error("Unsupported fixture update expression.");
    const update = action.Update, values = update.ExpressionAttributeValues ?? {}, row = rows.get(keyOf(update.Key));
    if (row === undefined || values[":role"] === undefined) throw new Error("Unsupported fixture update.");
    put({ ...row, role: values[":role"], ...(values[":at"] === undefined ? {} : { roleUpdatedAt: values[":at"] }) });
   }
  }
  return {};
 } };
 return {
  setRole,
  roleOf(id: string) { const row = rows.get(keyOf(developerOrgKey(id)));return OrgRoleSchema.parse(row?.role); },
  setName(name: string) { const key = { pk: `DEVELOPER#${"b".repeat(64)}`, sk: "META" };put({ ...rows.get(keyOf(key)), ...key, displayName: name }); },
  evidence() { return { members: [...rows.values()].filter(row => String(row.sk).startsWith("MEMBER#")), receipts: [...rows.values()].filter(row => String(row.pk).includes("ROLE_CHANGE")), audit }; },
  async request(base: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, path: string, body?: unknown) {
   const runtime: AuditRuntime = { documentClient: documentClient as unknown as AuditRuntime["documentClient"], tableName: "mock-state", queueUrl: "https://queue.test/audit.fifo", now: Date.now, log: () => undefined, sqs: { async send(command: unknown) { const input = (command as { input: { Entries: Array<{ Id: string; MessageBody: string }> } }).input;for (const entry of input.Entries) audit.push(JSON.parse(entry.MessageBody) as Row);return { Successful: input.Entries.map(entry => ({ Id: entry.Id })) }; } } as unknown as AuditRuntime["sqs"] };
   const deps = { ...base, documentClient, audit: runtime, orgs: new OrgStore({ documentClient, tableName: "mock-state", now: Date.now }) };
   return routeDeveloperRequest(deps, { method, path, headers: {}, requestId: "admin-browser-request", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, base.developer.issuer), { caller, csrf: appCsrfTokenFor(caller.sessionId) });
  },
 };
}
