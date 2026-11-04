import { readServiceStatusEvidence } from "../../../packages/broker/src/aws/service-status-runtime.js";
import { e2eRegisteredRuntimeKey } from "../../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { WEB_API_RUNTIME_PROFILE_ID } from "@agentx/contracts";
import { commitRegisteredProjectAllowedDomains } from "../../../packages/broker/src/org/project-allowed-domains.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { GitHubAppCredentialProvider } from "../../../packages/broker/src/github-app.js";
import { installationBindingCheck, requireRepositoriesConnected } from "../../../packages/broker/src/org/github-connection.js";
import { createWorkingBranchProvider, createWorkingBranchPageProvider } from "../../../packages/broker/src/org/project-working-branch-provider.js";
import { seedLaneB, readLaneBAgents } from "./admin-projects-agents.js";
// Real admin routes over a persistent, bounded transactional table; unsupported expressions fail closed.
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BUILTIN_AGENT_IDS, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, builtinSettingsKey, orgScoped, orgSettingsKey, projectAiKey, orgMemberKey, orgMetaKey, orgSlackTeamKey, slackTeamOrgKey, slackBindingKey, developerOrgKey, modelSourcesKey, OrgRoleSchema, type OrgRole } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../../packages/broker/src/developer/app-csrf.js";
import { ModelSourceStore } from "../../../packages/broker/src/model-sources/store.js";
import { OrgStore } from "../../../packages/broker/src/org/store.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../../packages/broker/src/aws/developer-routes.js";
import type { AuditRuntime } from "../../../packages/broker/src/audit/outbox.js";
import { FIXTURE_ORG, FIXTURE_DEVELOPER, FIXTURE_SESSION } from "../../web/support/fixtures.js";
const syntheticKey = generateKeyPairSync("rsa", {modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
type Row = Record<string, unknown>;
const keyOf = (key: Row | { pk: string; sk: string } | undefined) => `${String(key?.pk)}|${String(key?.sk)}`;
export function createAdminDirectory() {
 const rows = new Map<string, Row>(), audit: Row[] = [];
 const archiveUpdate = "SET entityType = :type, #name = :name, #status = :archived, archivedAt = :at, archivedBy = :by, archiveRevision = :next, createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown)";
 const restoreUpdate = "SET #status = :active, archiveRevision = :next REMOVE archivedAt, archivedBy";
 const membershipUpdate = "SET approvalMembershipVersion = if_not_exists(approvalMembershipVersion, :zero) + :one, approvalTrackingSince = if_not_exists(approvalTrackingSince, :at)";
 const companyLossUpdate = membershipUpdate + ", approvalLastCompanyEligibleLossAt = :lossAt";
 const removalFinishUpdate = "SET #state = :final, finishedAt = :at, #counts = :counts";
 const put = (row: Row) => rows.set(keyOf(row), structuredClone(row));
 function setRole(id: string, role: OrgRole, org: string = FIXTURE_ORG) {
  put({ ...orgMemberKey(org, id), orgId: org, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });put({ ...developerOrgKey(id), orgId: org, role });
 }
 for (const [org, id, name, role] of [[FIXTURE_ORG, FIXTURE_DEVELOPER, "Priya", "owner"], [FIXTURE_ORG, "b".repeat(64), "Maya", "member"], ["org_bbbbbbbbbbbbbbbbbbbb", "c".repeat(64), "Other company person", "owner"]] as const) {
  setRole(id, role, org);put({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name, provider: "cloud" });
 }
 put({ ...orgMetaKey("org_bbbbbbbbbbbbbbbbbbbb"), orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Other company", plan: "team" });
 put({ ...orgMetaKey(FIXTURE_ORG), orgId: FIXTURE_ORG, name: "Acme", plan: "team", createdBy: FIXTURE_DEVELOPER, approvalMembershipVersion: 1, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
 put({ ...modelSourcesKey(FIXTURE_ORG),entityType:"ORG_MODEL_SOURCES",revision:1,sources:[],order:["personal-chatgpt","rovara"],credentials:[],removing:[],updatedBy:FIXTURE_DEVELOPER,updatedAt:"2026-10-27T12:00:00Z" });
 function condition(expression: string | undefined, row: Row | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
  if (expression === undefined) return true;
  if (expression === "attribute_not_exists(pk) OR removedAt < :removedAt") return row === undefined || (typeof row.removedAt === "string" && typeof values[":removedAt"] === "string" && row.removedAt < values[":removedAt"]);
  // Respect nested native predicates without importing a different test project's runtime.
  expression = expression.trim();
  const split = (text: string, operator: string) => {
   const parts: string[] = [];let depth = 0, start = 0;
   for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;else if (text[index] === ")") depth -= 1;
    if (depth === 0 && text.startsWith(operator, index)) { parts.push(text.slice(start, index));start = index + operator.length;index = start - 1; }
   }
   parts.push(text.slice(start));return parts;
  };
  if (expression.startsWith("(")) {
   let depth = 0, end = -1;
   for (let index = 0; index < expression.length; index += 1) { if (expression[index] === "(") depth += 1;else if (expression[index] === ")") depth -= 1;if (depth === 0) { end = index;break; } }
   if (end === expression.length - 1) return condition(expression.slice(1, -1), row, names, values);
  }
  if (expression === "attribute_not_exists(pk) OR indexExpiresAt <= :now") return row === undefined || (typeof row.indexExpiresAt === "number" && typeof values[":now"] === "number" && row.indexExpiresAt <= values[":now"]);
  const alternatives = split(expression, " OR ");
  if (alternatives.length > 1) return alternatives.map(part => condition(part, row, names, values)).some(Boolean);
  const conjunction = split(expression, " AND ");
  if (conjunction.length > 1) return conjunction.map(part => condition(part, row, names, values)).every(Boolean);
  if (expression === "#expires <= :now") { const actual = row?.[names["#expires"]!], now = values[":now"];return typeof actual === "number" && typeof now === "number" && actual <= now; }
  return expression.split(/\s+AND\s+/).every(part => {
   if (part === "attribute_not_exists(pk)") return row === undefined;
   if (part === "attribute_exists(pk)") return row !== undefined;
   if (part === "attribute_not_exists(closingAt)") return row?.closingAt === undefined;
   if (part === "attribute_not_exists(closedAt)") return row?.closedAt === undefined;
   if (["attribute_not_exists(acceptedAt)", "attribute_not_exists(revokedAt)", "attribute_not_exists(revision)"].includes(part)) return row?.[part.slice("attribute_not_exists(".length, -1)] === undefined;
   if (part === "expiresAt > :now") return typeof row?.expiresAt === "string" && typeof values[":now"] === "string" && row.expiresAt > values[":now"];
   const absent = /^attribute_not_exists\((archiveRevision|orgId|approvalLastCompanyEligibleLossAt|approvalLastMaintainerLossAt|#[A-Za-z][A-Za-z0-9_]*)\)$/.exec(part);
   if (absent) return row?.[names[absent[1]!] ?? absent[1]!] === undefined;
   const equal = /^([#A-Za-z0-9_.]+) = (:[A-Za-z0-9_]+)$/.exec(part);
   if (equal === null) throw new Error(`Unsupported fixture condition: ${part}`);
   let actual: unknown = row;for (const field of equal[1]!.split(".")) actual = typeof actual === "object" && actual !== null ? (actual as Row)[names[field] ?? field] : undefined;
   return JSON.stringify(actual) === JSON.stringify(values[equal[2]!]);
  });
 }
 const documentClient = { async send(command: unknown): Promise<unknown> {
  if (command instanceof GetCommand) return { Item: rows.get(keyOf(command.input.Key ?? {})) };
  if (command instanceof BatchGetCommand) {
   // Strict like the earlier fixture: one table, at most 100 keys, always a consistent read, no projection. Callers read chosen names and agent sessions this way; anything else is a new access pattern that needs a deliberate fixture change.
   const entries = Object.entries(command.input.RequestItems ?? {});
   if (entries.length !== 1) throw new Error("Unsupported fixture batch read.");
   const [table, request] = entries[0]!, keys = request.Keys ?? [];
   if (keys.length > 100 || request.ConsistentRead !== true || request.ProjectionExpression !== undefined) throw new Error("Unsupported fixture batch read.");
   const Responses: Record<string, Row[]> = { [table]: keys.flatMap(key => { if (typeof key.pk !== "string" || typeof key.sk !== "string") throw new Error("Invalid fixture batch key.");const row = rows.get(keyOf(key));return row === undefined ? [] : [structuredClone(row)]; }) };
   return { Responses };
  }
  if (command instanceof QueryCommand) {
   const values = command.input.ExpressionAttributeValues ?? {}, after: unknown = command.input.ExclusiveStartKey?.sk, limit = command.input.Limit;
   if (after !== undefined && typeof after !== "string") throw new Error("Invalid fixture pagination key.");
   const matches = [...rows.values()].filter(row => row.pk === values[":pk"] && String(row.sk).startsWith(String(values[":prefix"] ?? "")) && (after === undefined || String(row.sk) > after)).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1);
   if(command.input.ScanIndexForward===false)matches.reverse();
   const page = limit === undefined ? matches : matches.slice(0, limit), last = page.at(-1);
   return { Items: page, ...(limit !== undefined && matches.length > limit && last !== undefined ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
  }
  if (command instanceof UpdateCommand) {
   const input = command.input, values = input.ExpressionAttributeValues ?? {}, key = input.Key ?? {}, row = rows.get(keyOf(key));
   if (input.UpdateExpression === "SET #count = #count + :one" && input.ConditionExpression === "windowStart = :window AND #count < :limit") {
    if (row === undefined || row.windowStart !== values[":window"] || typeof row.count !== "number" || typeof values[":limit"] !== "number" || row.count >= values[":limit"]) throw Object.assign(new Error("Fixture rate conflict"), { name: "ConditionalCheckFailedException" });if (typeof values[":one"] !== "number") throw new Error("Invalid fixture rate weight");put({ ...row, count: row.count + values[":one"] });return {};
   }
   if (input.UpdateExpression === "SET entityType = :type, windowStart = :window, #count = :one, #expires = :expires" && input.ConditionExpression === "attribute_not_exists(windowStart) OR windowStart < :window" && input.ExpressionAttributeNames?.["#expires"] === "indexExpiresAt") {
    if (typeof values[":expires"] !== "number") throw new Error("Invalid fixture rate expiry");if (row?.windowStart !== undefined && !(typeof row.windowStart === "number" && typeof values[":window"] === "number" && row.windowStart < values[":window"])) throw Object.assign(new Error("Fixture rate conflict"), { name: "ConditionalCheckFailedException" });put({ ...key, entityType: values[":type"], windowStart: values[":window"], count: values[":one"], indexExpiresAt: values[":expires"] });return {};
   }
   throw new Error("Unsupported fixture rate update.");
  }
  if (command instanceof DeleteCommand) { rows.delete(keyOf(command.input.Key ?? {}));return {}; }
  if (!(command instanceof TransactWriteCommand)) throw new Error("Unsupported fixture command.");
  const actions = command.input.TransactItems ?? [];
  if (actions.length > 100) throw new Error("Fixture transaction limit.");
  const checks = actions.map(action => {
   const write = action.Update ?? action.ConditionCheck ?? action.Put ?? action.Delete;
   if (write === undefined) throw new Error("Unsupported fixture transaction item.");
   if ("UpdateExpression" in write && !["SET #role = :role", "SET #role = :role, roleUpdatedAt = :at", "SET revokedAt = :at, revokedBy = :by, revision = :next", archiveUpdate, restoreUpdate, membershipUpdate, companyLossUpdate, "SET approvalLastMaintainerLossAt = :lossAt", "SET latestRevision = :next", removalFinishUpdate].includes(typeof write.UpdateExpression === "string" ? write.UpdateExpression : "")) throw new Error("Unsupported fixture update expression.");
   const expression = `${write.ConditionExpression ?? ""} ${"UpdateExpression" in write && typeof write.UpdateExpression === "string" ? write.UpdateExpression : ""}`;
   const tokens = new Set(expression.match(/[:#][A-Za-z0-9_]+/g) ?? []);
   for (const token of tokens) { if (!Object.hasOwn(token.startsWith("#") ? write.ExpressionAttributeNames ?? {} : write.ExpressionAttributeValues ?? {}, token)) throw new Error("Missing fixture expression attribute."); }
   for (const [token, value] of Object.entries({ ...write.ExpressionAttributeNames, ...write.ExpressionAttributeValues })) { if (!tokens.has(token) || value === undefined) throw new Error("Invalid fixture expression attribute."); }
   const key = "Key" in write ? write.Key : "Item" in write ? write.Item : undefined;
   const previous = rows.get(keyOf(key ?? {}));
   if ("UpdateExpression" in write && (write.UpdateExpression === membershipUpdate || write.UpdateExpression === companyLossUpdate)) {
    const values = write.ExpressionAttributeValues ?? {};
    if (previous === undefined || values[":zero"] !== 0 || values[":one"] !== 1 || typeof values[":at"] !== "string" || (previous.approvalMembershipVersion !== undefined && (!Number.isSafeInteger(previous.approvalMembershipVersion) || Number(previous.approvalMembershipVersion) < 0))) throw new Error("Invalid fixture approval generation.");
    if (write.UpdateExpression === companyLossUpdate && typeof values[":lossAt"] !== "string") throw new Error("Invalid fixture approval loss.");
   }
   if ("UpdateExpression" in write && write.UpdateExpression === "SET approvalLastMaintainerLossAt = :lossAt" && (previous === undefined || typeof write.ExpressionAttributeValues?.[":lossAt"] !== "string")) throw new Error("Invalid fixture maintainer loss.");
   return condition(write.ConditionExpression, previous, write.ExpressionAttributeNames, write.ExpressionAttributeValues);
  });
  if (checks.some(ok => !ok)) throw Object.assign(new Error("Fixture transaction cancelled."), { name: "TransactionCanceledException", CancellationReasons: checks.map(ok => ({ Code: ok ? "None" : "ConditionalCheckFailed" })) });
  for (const action of actions) {
   if (action.Delete !== undefined) rows.delete(keyOf(action.Delete.Key));
   if (action.Put?.Item !== undefined) put(action.Put.Item);
   if (action.Update !== undefined) {
    const update = action.Update, values = update.ExpressionAttributeValues ?? {}, row = rows.get(keyOf(update.Key));
    if (update.UpdateExpression === membershipUpdate || update.UpdateExpression === companyLossUpdate) {
     put({ ...row, approvalMembershipVersion: Number(row?.approvalMembershipVersion ?? 0) + 1, approvalTrackingSince: row?.approvalTrackingSince ?? values[":at"], ...(update.UpdateExpression === companyLossUpdate ? { approvalLastCompanyEligibleLossAt: values[":lossAt"] } : {}) });continue;
    }
    if (update.UpdateExpression === "SET approvalLastMaintainerLossAt = :lossAt") { put({ ...row, approvalLastMaintainerLossAt: values[":lossAt"] });continue; }
    if (update.UpdateExpression === removalFinishUpdate) { if (row === undefined || typeof values[":final"] !== "string") throw new Error("Invalid fixture removal finish.");put({ ...row, state: values[":final"], finishedAt: values[":at"], counts: values[":counts"] });continue; }
    if (update.UpdateExpression === "SET latestRevision = :next") { if(row===undefined||!Number.isSafeInteger(values[":next"]))throw new Error("Invalid fixture catalog update.");put({...row,latestRevision:values[":next"]});continue; }
    if (update.UpdateExpression === archiveUpdate) { put({ ...update.Key, ...row, entityType: values[":type"], name: values[":name"], status: values[":archived"], archivedAt: values[":at"], archivedBy: values[":by"], archiveRevision: values[":next"], createdAt: row?.createdAt ?? values[":at"], createdBy: row?.createdBy ?? values[":unknown"] });continue; }
    if (update.UpdateExpression === restoreUpdate) { if (row === undefined) throw new Error("Missing restore fixture meta.");const next: Row = { ...row, status: values[":active"], archiveRevision: values[":next"] };delete next.archivedAt;delete next.archivedBy;put(next);continue; }
    if (row === undefined) throw new Error("Unsupported fixture update.");
    if (update.UpdateExpression === "SET revokedAt = :at, revokedBy = :by, revision = :next") {
     if (typeof values[":at"] !== "string" || typeof values[":by"] !== "string" || typeof values[":next"] !== "number") throw new Error("Invalid fixture revoke.");
     put({ ...row, revokedAt: values[":at"], revokedBy: values[":by"], revision: values[":next"] });continue;
    }
    if (update.UpdateExpression !== "SET #role = :role" && update.UpdateExpression !== "SET #role = :role, roleUpdatedAt = :at") throw new Error("Unsupported fixture update expression.");
    if (values[":role"] === undefined) throw new Error("Unsupported fixture update.");
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
 const checkRepositories: NonNullable<DeveloperRouteDependencies["requireRepositoriesConnected"]> = (orgId, definition) => requireRepositoriesConnected({documentClient,tableName:"mock-state",cloud:true,app:github},orgId,definition);
 return {
  seedServiceStatus() {
   for (const kind of ["web", "api"] as const) put({ ...e2eRegisteredRuntimeKey("fixture-health", WEB_API_RUNTIME_PROFILE_ID, kind), state: kind === "web" ? "READY" : "PARKED", qualifiedAt: new Date(Date.now() - 86400000).toISOString(), expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(), endpoint: "https://not-disclosed.invalid" });
  },
  seedSlackLinks() {
   const teamId = "T0123456789", channelId = "C0123456789";
   put({ ...orgSlackTeamKey(FIXTURE_ORG, teamId), teamId });put({ ...slackTeamOrgKey(teamId), teamId, orgId: FIXTURE_ORG });
   put({ ...slackBindingKey(FIXTURE_ORG, teamId, channelId), entityType: "SLACK_BINDING", teamId, channelId, projectName: "payments", updatedAt: "2026-10-01T00:00:00Z" });
  },
  setRole,
  addMember(name: string, role: OrgRole) { const id = createHash("sha256").update(name).digest("hex");setRole(id, role);put({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name, provider: "cloud" }); },
  changeSourceOrder() { const key=modelSourcesKey(FIXTURE_ORG),row=rows.get(keyOf(key));if(!row||typeof row.revision!=="number")throw new Error("No source fixture.");put({...row,revision:row.revision+1,order:["rovara","personal-chatgpt"]}); },
  seedLaneB() { seedLaneB(put); },
  seedTaskStops(missingProject = false) {
   const at = new Date(Date.now() - 60_000).toISOString();
   put({ pk: `SESSION#${FIXTURE_SESSION}`, sk: "META", sessionId: FIXTURE_SESSION, developerId: FIXTURE_DEVELOPER, amr: "cloud", authTime: at, startedAt: at, endsAt: Math.floor(Date.now() / 1000) + 3600 });
   put({ ...agentGuardrailsKey(FIXTURE_ORG), orgId: FIXTURE_ORG, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: DEFAULT_AGENT_GUARDRAILS });
   put({ pk: orgScoped(FIXTURE_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap", entityType: "TASK_STOP_SEED", orgId: FIXTURE_ORG, version: 1, source: "bootstrap", outcome: "created", policyRevision: 1 });
   for (const id of BUILTIN_AGENT_IDS) put({ ...builtinSettingsKey(FIXTURE_ORG, id), orgId: FIXTURE_ORG, agentId: id, entityType: "BUILTIN_AGENT_SETTINGS", revision: 1, stopKind: "inherit" });
   for (const row of [...rows.values()].filter(row => row.pk === orgScoped(FIXTURE_ORG, "PROJECT_CATALOG"))) {
    put({ ...row, orgId: FIXTURE_ORG });const project = String(row.name);
    put({ ...projectAiKey(FIXTURE_ORG, project), orgId: FIXTURE_ORG, project, entityType: "PROJECT_AI", revision: 1, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
   }
   put({ ...orgSettingsKey(FIXTURE_ORG, "TASK_STOP_POLICY"), orgId: FIXTURE_ORG, entityType: "ORG_TASK_STOP_POLICY", revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2000000 } }, enrollment: { version: 1, state: "disabled" } });
   put({ ...projectAiKey(FIXTURE_ORG, "payments"), orgId: FIXTURE_ORG, project: "payments", entityType: "PROJECT_AI", revision: 1, projectPays: false, monthlyBudgetUsd: 50, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 2000000 } });
   if (missingProject) rows.delete(keyOf(projectAiKey(FIXTURE_ORG, "payments")));
  },
  damageInvite() { const ref = [...rows.values()].filter(row => row.entityType === "ORG_INVITE_DIRECTORY" && row.orgId === FIXTURE_ORG).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1)[0];if (ref === undefined || typeof ref.tokenHash !== "string") throw new Error("No fixture invite.");const key = { pk: `ORG_INVITE#${ref.tokenHash}`, sk: "META" }, record = rows.get(keyOf(key));if (record === undefined) throw new Error("No fixture canonical record.");put({ ...record, role: "future-role" }); },
  async seedInvites() { let seedNow = Date.now() - 60_000;const store = new OrgStore({ documentClient, tableName: "mock-state", now: () => seedNow });for (let i = 0; i < 26; i++) { if (i === 20) seedNow += 60_000;await store.createInvite({ orgId: FIXTURE_ORG, createdBy: FIXTURE_DEVELOPER, role: "member", email: `private.person${i}@example.test` }); }await store.createInvite({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", createdBy: "c".repeat(64), role: "admin", email: "foreign.person@foreign.test" }); },
  roleOf(id: string) { const row = rows.get(keyOf(developerOrgKey(id)));return OrgRoleSchema.parse(row?.role); },
  setName(name: string) { const key = { pk: `DEVELOPER#${"b".repeat(64)}`, sk: "META" };put({ ...rows.get(keyOf(key)), ...key, displayName: name }); },
  evidence() { return { providerCalls, branchRates:[...rows.values()].filter(row=>String(row.pk).includes("WORKING_BRANCH")), inviteReceipts: [...rows.values()].filter(row => row.entityType === "ORG_INVITE_REVOKE_REQUEST"), createReceipts: [...rows.values()].filter(row => row.entityType === "ORG_INVITE_CREATE_RECEIPT").map(row => ({ orgId: row.orgId, inviteId: row.inviteId, requestId: row.requestId, role: row.role })), members: [...rows.values()].filter(row => String(row.sk).startsWith("MEMBER#")), receipts: [...rows.values()].filter(row => String(row.pk).includes("ROLE_CHANGE")), projects: [...rows.values()].filter(row => row.entityType === "PROJECT_META"), projectReceipts: [...rows.values()].filter(row => row.entityType === "REVIEWED_PROJECT_ARCHIVE_REQUEST" || row.entityType === "REVIEWED_PROJECT_RESTORE_REQUEST"), sourceOrder:rows.get(keyOf(modelSourcesKey(FIXTURE_ORG))), sourceReceipts:[...rows.values()].filter(row=>String(row.pk).includes("SOURCE_ORDER_REVIEW")), audit }; },
  async request(base: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, path: string, body?: unknown, headers: Record<string,string|undefined> = {}) {
   const runtime: AuditRuntime = { documentClient: documentClient as unknown as AuditRuntime["documentClient"], tableName: "mock-state", queueUrl: "https://queue.test/audit.fifo", now: Date.now, log: () => undefined, sqs: { async send(command: unknown) { const input = (command as { input: { Entries: Array<{ Id: string; MessageBody: string }> } }).input;for (const entry of input.Entries) audit.push(JSON.parse(entry.MessageBody) as Row);return { Successful: input.Entries.map(entry => ({ Id: entry.Id })) }; } } as unknown as AuditRuntime["sqs"] };
   // Only source routes use this seam; unused agent collaborators stay absent and fail closed if reached.
   const sourceAgents = {documentClient,tableName:"mock-state",now:Date.now,modelSources:{store:new ModelSourceStore({documentClient,tableName:"mock-state",now:Date.now,chatgptSwitch:async()=>true,audit:runtime}),access:{async upsertSource(){throw new Error("No proxy writes in order fixture.");},async removeSource(){throw new Error("No proxy writes in order fixture.");},async checkSource(){throw new Error("No proxy checks in order fixture.");}},egress:{documentClient,tableName:"mock-state",now:()=>new Date()}}} as unknown as NonNullable<DeveloperRouteDependencies["agents"]>;
   const projectAllowedDomains: NonNullable<DeveloperRouteDependencies["projectAllowedDomains"]> = { registerApproved: async (actor, value, proof) => commitRegisteredProjectAllowedDomains({ documentClient, tableName: "mock-state", signInTableName: base.developer.signInTableName, now: Date.now, audit: runtime }, { orgId: actor.orgId, project: value.definition.name, by: actor.ownerKey, definition: value.definition, runtimeBinding: value.runtimeBinding, proof }) };
   const deps = { ...base, serviceStatus: { runtimeStatus: () => readServiceStatusEvidence({ runtimeCatalogId: "fixture-health", read: async key => (await documentClient.send(new GetCommand({ TableName: "mock-state", Key: key, ConsistentRead: true })) as { Item?: Row }).Item }) }, projectAllowedDomains, requireRepositoriesConnected: checkRepositories, cloud: true, developer: { ...base.developer, webOrigin: "https://join.example.test" }, documentClient, audit: runtime, projectWorkingBranches: () => {const session=github.createWorkingBranchPreviewSession();return{...createWorkingBranchPageProvider(session),finish:()=>session.finish("list")};},projectWorkingBranchPreview: () => {const session=github.createWorkingBranchPreviewSession();return{...createWorkingBranchProvider(session),finish:()=>session.finish("preview")};}, orgs: new OrgStore({ documentClient, tableName: "mock-state", now: Date.now, audit: runtime }),...(path.startsWith("/v1/app/org/model-sources")?{agents:sourceAgents}:{}) };
   if (method === "GET" && (path.startsWith("/v1/app/agents") || path.startsWith("/v1/app/org/agent-guardrails"))) return readLaneBAgents(deps, caller, path);
   return routeDeveloperRequest(deps, { method, path, headers, requestId: "admin-browser-request", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, base.developer.issuer), { caller, csrf: appCsrfTokenFor(caller.sessionId) });
  },
 };
}
