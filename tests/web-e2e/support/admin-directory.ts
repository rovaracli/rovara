// Real admin routes over a persistent, bounded transactional table; unsupported expressions fail closed.
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, orgMetaKey, developerOrgKey, modelSourcesKey, OrgRoleSchema, type OrgRole } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { ModelSourceStore } from "../../../packages/broker/src/model-sources/store.js";
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
 put({ ...orgMetaKey("org_bbbbbbbbbbbbbbbbbbbb"), orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Other company", plan: "team" });
 put({ ...orgMetaKey(FIXTURE_ORG), orgId: FIXTURE_ORG, name: "Acme", plan: "team", createdBy: FIXTURE_DEVELOPER });
 put({ ...modelSourcesKey(FIXTURE_ORG),entityType:"ORG_MODEL_SOURCES",revision:1,sources:[],order:["personal-chatgpt","rovara"],credentials:[],removing:[],updatedBy:FIXTURE_DEVELOPER,updatedAt:"2026-10-27T12:00:00Z" });
 function condition(expression: string | undefined, row: Row | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
  if (expression === undefined) return true;
  return expression.split(/\s+AND\s+/).every(part => {
   if (part === "attribute_not_exists(pk)") return row === undefined;
   if (part === "attribute_exists(pk)") return row !== undefined;
   if (part === "attribute_not_exists(closingAt)") return row?.closingAt === undefined;
   if (part === "attribute_not_exists(closedAt)") return row?.closedAt === undefined;
   const equal = /^(#[A-Za-z]+|[A-Za-z]+) = (:[A-Za-z]+)$/.exec(part);
   if (equal === null) throw new Error("Unsupported fixture condition.");
   return row?.[names[equal[1]!] ?? equal[1]!] === values[equal[2]!];
  });
 }
 const documentClient = { async send(command: unknown): Promise<unknown> {
  if (command instanceof GetCommand) return { Item: rows.get(keyOf(command.input.Key ?? {})) };
  if (command instanceof BatchGetCommand) return { Responses: Object.fromEntries(Object.entries(command.input.RequestItems ?? {}).map(([table, request]) => [table, (request.Keys ?? []).flatMap(key => { const row = rows.get(keyOf(key));return row === undefined ? [] : [row]; })])) };
  if (command instanceof QueryCommand) {
   const values = command.input.ExpressionAttributeValues ?? {}, after: unknown = command.input.ExclusiveStartKey?.sk, limit = command.input.Limit;
   if (after !== undefined && typeof after !== "string") throw new Error("Invalid fixture pagination key.");
   const matches = [...rows.values()].filter(row => row.pk === values[":pk"] && String(row.sk).startsWith(String(values[":prefix"] ?? "")) && (after === undefined || String(row.sk) > after)).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1);
   const page = limit === undefined ? matches : matches.slice(0, limit), last = page.at(-1);
   return { Items: page, ...(limit !== undefined && matches.length > limit && last !== undefined ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
  }
  if (command instanceof UpdateCommand) {
   const input = command.input, values = input.ExpressionAttributeValues ?? {}, key = input.Key ?? {}, row = rows.get(keyOf(key));
   if (input.UpdateExpression === "SET #count = #count + :one" && input.ConditionExpression === "windowStart = :window AND #count < :limit") {
    if (row === undefined || row.windowStart !== values[":window"] || typeof row.count !== "number" || typeof values[":limit"] !== "number" || row.count >= values[":limit"]) throw Object.assign(new Error("Fixture rate conflict"), { name: "ConditionalCheckFailedException" });put({ ...row, count: row.count + 1 });return {};
   }
   if (input.UpdateExpression === "SET entityType = :type, windowStart = :window, #count = :one" && input.ConditionExpression === "attribute_not_exists(windowStart) OR windowStart < :window") {
    if (row?.windowStart !== undefined && !(typeof row.windowStart === "number" && typeof values[":window"] === "number" && row.windowStart < values[":window"])) throw Object.assign(new Error("Fixture rate conflict"), { name: "ConditionalCheckFailedException" });put({ ...key, entityType: values[":type"], windowStart: values[":window"], count: values[":one"] });return {};
   }
   throw new Error("Unsupported fixture rate update.");
  }
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
  changeSourceOrder() { const key=modelSourcesKey(FIXTURE_ORG),row=rows.get(keyOf(key));if(!row||typeof row.revision!=="number")throw new Error("No source fixture.");put({...row,revision:row.revision+1,order:["rovara","personal-chatgpt"]}); },
  damageInvite() { const ref = [...rows.values()].filter(row => row.entityType === "ORG_INVITE_DIRECTORY" && row.orgId === FIXTURE_ORG).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1)[0];if (ref === undefined || typeof ref.tokenHash !== "string") throw new Error("No fixture invite.");const key = { pk: `ORG_INVITE#${ref.tokenHash}`, sk: "META" }, record = rows.get(keyOf(key));if (record === undefined) throw new Error("No fixture canonical record.");put({ ...record, role: "future-role" }); },
  async seedInvites() { const store = new OrgStore({ documentClient, tableName: "mock-state", now: Date.now });for (let i = 0; i < 26; i++) await store.createInvite({ orgId: FIXTURE_ORG, createdBy: FIXTURE_DEVELOPER, role: "member", email: `private.person${i}@example.test` });await store.createInvite({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", createdBy: "c".repeat(64), role: "admin", email: "foreign.person@foreign.test" }); },
  roleOf(id: string) { const row = rows.get(keyOf(developerOrgKey(id)));return OrgRoleSchema.parse(row?.role); },
  setName(name: string) { const key = { pk: `DEVELOPER#${"b".repeat(64)}`, sk: "META" };put({ ...rows.get(keyOf(key)), ...key, displayName: name }); },
  evidence() { return { members: [...rows.values()].filter(row => String(row.sk).startsWith("MEMBER#")), receipts: [...rows.values()].filter(row => String(row.pk).includes("ROLE_CHANGE")), sourceOrder:rows.get(keyOf(modelSourcesKey(FIXTURE_ORG))), sourceReceipts:[...rows.values()].filter(row=>String(row.pk).includes("SOURCE_ORDER_REVIEW")), audit }; },
  async request(base: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, path: string, body?: unknown) {
   const runtime: AuditRuntime = { documentClient: documentClient as unknown as AuditRuntime["documentClient"], tableName: "mock-state", queueUrl: "https://queue.test/audit.fifo", now: Date.now, log: () => undefined, sqs: { async send(command: unknown) { const input = (command as { input: { Entries: Array<{ Id: string; MessageBody: string }> } }).input;for (const entry of input.Entries) audit.push(JSON.parse(entry.MessageBody) as Row);return { Successful: input.Entries.map(entry => ({ Id: entry.Id })) }; } } as unknown as AuditRuntime["sqs"] };
   // Only source routes use this seam; unused agent collaborators stay absent and fail closed if reached.
   const sourceAgents = {documentClient,tableName:"mock-state",now:Date.now,modelSources:{store:new ModelSourceStore({documentClient,tableName:"mock-state",now:Date.now,chatgptSwitch:async()=>true,audit:runtime}),access:{async upsertSource(){throw new Error("No proxy writes in order fixture.");},async removeSource(){throw new Error("No proxy writes in order fixture.");},async checkSource(){throw new Error("No proxy checks in order fixture.");}},egress:{documentClient,tableName:"mock-state",now:()=>new Date()}}} as unknown as NonNullable<DeveloperRouteDependencies["agents"]>;
   const deps = { ...base, documentClient, audit: runtime, orgs: new OrgStore({ documentClient, tableName: "mock-state", now: Date.now }),...(path.startsWith("/v1/app/org/model-sources")?{agents:sourceAgents}:{}) };
   return routeDeveloperRequest(deps, { method, path, headers: {}, requestId: "admin-browser-request", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, base.developer.issuer), { caller, csrf: appCsrfTokenFor(caller.sessionId) });
  },
 };
}
