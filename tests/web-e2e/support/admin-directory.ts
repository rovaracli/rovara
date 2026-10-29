import { generateKeyPairSync } from "node:crypto";
import { GitHubAppCredentialProvider } from "../../../packages/broker/src/github-app.js";
import { installationBindingCheck } from "../../../packages/broker/src/org/github-connection.js";
import { createWorkingBranchProvider, createWorkingBranchPageProvider } from "../../../packages/broker/src/org/project-working-branch-provider.js";
import { seedLaneB, readLaneBAgents } from "./admin-projects-agents.js";
// Real admin routes over a persistent, bounded transactional table; unsupported expressions fail closed.
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, orgMetaKey, developerOrgKey, OrgRoleSchema, type OrgRole } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { OrgStore } from "../../../packages/broker/src/org/store.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import type { AuditRuntime } from "../../../packages/broker/src/audit/outbox.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER } from "../../web/support/fixtures.js";
const syntheticKey = generateKeyPairSync("rsa", {modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
type Row = Record<string, unknown>;
const keyOf = (key: Row | { pk: string; sk: string } | undefined) => `${String(key?.pk)}|${String(key?.sk)}`;
export function createAdminDirectory() {
 const rows = new Map<string, Row>(), audit: Row[] = [];
 const archiveUpdate = "SET entityType = :type, #name = :name, #status = :archived, archivedAt = :at, archivedBy = :by, archiveRevision = :next, createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown)";
 const restoreUpdate = "SET #status = :active, archiveRevision = :next REMOVE archivedAt, archivedBy";
 const put = (row: Row) => rows.set(keyOf(row), structuredClone(row));
 function setRole(id: string, role: OrgRole, org: string = FIXTURE_ORG) {
  put({ ...orgMemberKey(org, id), orgId: org, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });put({ ...developerOrgKey(id), orgId: org, role });
 }
 for (const [org, id, name, role] of [[FIXTURE_ORG, FIXTURE_DEVELOPER, "Priya", "owner"], [FIXTURE_ORG, "b".repeat(64), "Maya", "member"], ["org_bbbbbbbbbbbbbbbbbbbb", "c".repeat(64), "Other company person", "owner"]] as const) {
  setRole(id, role, org);put({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name, provider: "cloud" });
 }
 put({ ...orgMetaKey("org_bbbbbbbbbbbbbbbbbbbb"), orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Other company", plan: "team" });
 put({ ...orgMetaKey(FIXTURE_ORG), orgId: FIXTURE_ORG, name: "Acme", plan: "team", createdBy: FIXTURE_DEVELOPER });
 function condition(expression: string | undefined, row: Row | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
  if (expression === undefined) return true;
  if (expression === "attribute_not_exists(pk) OR indexExpiresAt <= :now") return row === undefined || (typeof row.indexExpiresAt === "number" && typeof values[":now"] === "number" && row.indexExpiresAt <= values[":now"]);
  return expression.split(/\s+AND\s+/).every(part => {
   if (part === "attribute_not_exists(pk)") return row === undefined;
   if (part === "attribute_exists(pk)") return row !== undefined;
   if (part === "attribute_not_exists(closingAt)") return row?.closingAt === undefined;
   if (part === "attribute_not_exists(closedAt)") return row?.closedAt === undefined;
   const absent = /^attribute_not_exists\((archiveRevision|orgId|#status)\)$/.exec(part);
   if (absent) return row?.[names[absent[1]!] ?? absent[1]!] === undefined;
   const equal = /^([#A-Za-z.]+) = (:[A-Za-z]+)$/.exec(part);
   if (equal === null) throw new Error("Unsupported fixture condition.");
   let actual: unknown = row;for (const field of equal[1]!.split(".")) actual = typeof actual === "object" && actual !== null ? (actual as Row)[names[field] ?? field] : undefined;
   return actual === values[equal[2]!];
  });
 }
 const documentClient = { async send(command: unknown): Promise<unknown> {
  if (command instanceof GetCommand) return { Item: rows.get(keyOf(command.input.Key ?? {})) };
  if (command instanceof BatchGetCommand) {
   const entries = Object.entries(command.input.RequestItems ?? {});
   if (entries.length !== 1 || entries[0]![1].ConsistentRead !== true || (entries[0]![1].Keys?.length ?? 0) > 100) throw new Error("Unsupported fixture batch read.");
   const [table, input] = entries[0]!;
   return { Responses: { [table]: (input.Keys ?? []).flatMap(key => { if (typeof key.pk !== "string" || !key.pk.startsWith("DEVELOPER_NAME#") || key.sk !== "NAME") throw new Error("Unsupported fixture name key.");const row = rows.get(keyOf(key));return row === undefined ? [] : [structuredClone(row)]; }) } };
  }
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
    if (row === undefined || row.windowStart !== values[":window"] || typeof row.count !== "number" || typeof values[":limit"] !== "number" || row.count >= values[":limit"]) throw Object.assign(new Error("Fixture rate conflict"), { name: "ConditionalCheckFailedException" });if (typeof values[":one"] !== "number") throw new Error("Invalid fixture rate weight");put({ ...row, count: row.count + values[":one"] });return {};
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
   if ("UpdateExpression" in write && !["SET #role = :role", "SET #role = :role, roleUpdatedAt = :at", archiveUpdate, restoreUpdate].includes(write.UpdateExpression ?? "")) throw new Error("Unsupported fixture update expression.");
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
    const update = action.Update, values = update.ExpressionAttributeValues ?? {}, row = rows.get(keyOf(update.Key));
    if (update.UpdateExpression === archiveUpdate) { put({ ...update.Key, ...row, entityType: values[":type"], name: values[":name"], status: values[":archived"], archivedAt: values[":at"], archivedBy: values[":by"], archiveRevision: values[":next"], createdAt: row?.createdAt ?? values[":at"], createdBy: row?.createdBy ?? values[":unknown"] });continue; }
    if (update.UpdateExpression === restoreUpdate) { if (row === undefined) throw new Error("Missing restore fixture meta.");const next: Row = { ...row, status: values[":active"], archiveRevision: values[":next"] };delete next.archivedAt;delete next.archivedBy;put(next);continue; }
    if (row === undefined || values[":role"] === undefined) throw new Error("Unsupported fixture update.");
    put({ ...row, role: values[":role"], ...(values[":at"] === undefined ? {} : { roleUpdatedAt: values[":at"] }) });
   }
  }
  return {};
 } };
 const providerCalls: {method:string;path:string}[] = [];
 const github = new GitHubAppCredentialProvider({credentialRef:"github-app",appId:"123",getPrivateKey:async()=>syntheticKey,requireInstallationBound:installationBindingCheck({documentClient,tableName:"mock-state"}),fetchImplementation:(async(input,init)=>{
  const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);providerCalls.push({method:init?.method??"GET",path:url.pathname+url.search});
  if(url.hostname!=="api.github.com")throw new Error("Unexpected synthetic provider host");
  if(url.pathname.endsWith("/installation"))return Response.json({id:11,account:{login:"acme"}});
  if(url.pathname.includes("/access_tokens"))return Response.json({token:"synthetic-browser-branch-token"},{status:201});
  if(url.pathname==="/repos/acme/payments")return Response.json({id:22,full_name:"acme/payments"});
  if(url.pathname.endsWith("/branches")){const page=Number(url.searchParams.get("page"));const names=page===1?["main","release/current",...Array.from({length:98},(_,i)=>`topic-${i}`)]:["feature/final","release/current"];return Response.json(names.map(name=>({name,commit:{sha:"c".repeat(40)}})));}
  if(url.pathname.includes("/git/ref/heads/")){const branch=decodeURIComponent(url.pathname.split("/git/ref/heads/")[1]!);return Response.json({ref:`refs/heads/${branch}`,object:{type:"commit",sha:"c".repeat(40)}});}
  throw new Error("Unexpected synthetic provider path");
 })});
 return {
  setRole,
  seedLaneB() { seedLaneB(put); },
  damageInvite() { const ref = [...rows.values()].filter(row => row.entityType === "ORG_INVITE_DIRECTORY" && row.orgId === FIXTURE_ORG).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1)[0];if (ref === undefined || typeof ref.tokenHash !== "string") throw new Error("No fixture invite.");const key = { pk: `ORG_INVITE#${ref.tokenHash}`, sk: "META" }, record = rows.get(keyOf(key));if (record === undefined) throw new Error("No fixture canonical record.");put({ ...record, role: "future-role" }); },
  async seedInvites() { const store = new OrgStore({ documentClient, tableName: "mock-state", now: Date.now });for (let i = 0; i < 26; i++) await store.createInvite({ orgId: FIXTURE_ORG, createdBy: FIXTURE_DEVELOPER, role: "member", email: `private.person${i}@example.test` });await store.createInvite({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", createdBy: "c".repeat(64), role: "admin", email: "foreign.person@foreign.test" }); },
  roleOf(id: string) { const row = rows.get(keyOf(developerOrgKey(id)));return OrgRoleSchema.parse(row?.role); },
  setName(name: string) { const key = { pk: `DEVELOPER#${"b".repeat(64)}`, sk: "META" };put({ ...rows.get(keyOf(key)), ...key, displayName: name }); },
  evidence() { return { providerCalls, branchRates:[...rows.values()].filter(row=>String(row.pk).includes("WORKING_BRANCH")), members: [...rows.values()].filter(row => String(row.sk).startsWith("MEMBER#")), receipts: [...rows.values()].filter(row => String(row.pk).includes("ROLE_CHANGE")), projects: [...rows.values()].filter(row => row.entityType === "PROJECT_META"), projectReceipts: [...rows.values()].filter(row => row.entityType === "REVIEWED_PROJECT_ARCHIVE_REQUEST" || row.entityType === "REVIEWED_PROJECT_RESTORE_REQUEST"), audit }; },
  async request(base: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, path: string, body?: unknown, headers: Record<string,string|undefined> = {}) {
   const runtime: AuditRuntime = { documentClient: documentClient as unknown as AuditRuntime["documentClient"], tableName: "mock-state", queueUrl: "https://queue.test/audit.fifo", now: Date.now, log: () => undefined, sqs: { async send(command: unknown) { const input = (command as { input: { Entries: Array<{ Id: string; MessageBody: string }> } }).input;for (const entry of input.Entries) audit.push(JSON.parse(entry.MessageBody) as Row);return { Successful: input.Entries.map(entry => ({ Id: entry.Id })) }; } } as unknown as AuditRuntime["sqs"] };
   const deps = { ...base, documentClient, audit: runtime, projectWorkingBranches: () => {const session=github.createWorkingBranchPreviewSession();return{...createWorkingBranchPageProvider(session),finish:()=>session.finish("list")};},projectWorkingBranchPreview: () => {const session=github.createWorkingBranchPreviewSession();return{...createWorkingBranchProvider(session),finish:()=>session.finish("preview")};}, orgs: new OrgStore({ documentClient, tableName: "mock-state", now: Date.now }) };
   if (method === "GET" && (path.startsWith("/v1/app/agents") || path.startsWith("/v1/app/org/agent-guardrails"))) return readLaneBAgents(deps, caller, path);
   return routeDeveloperRequest(deps, { method, path, headers, requestId: "admin-browser-request", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, base.developer.issuer), { caller, csrf: appCsrfTokenFor(caller.sessionId) });
  },
 };
}
