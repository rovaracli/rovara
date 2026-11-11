import { createHash } from "node:crypto";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, SlackTeamIdSchema, SlackChannelIdSchema, agentXError, canonicalJson, orgPk, projectMetaKey, projectPk, slackBindingKey, slackBindingPk, type OrgId } from "@rovara-code/contracts";
import { orgMemberKey, orgMetaKey, orgSlackTeamKey, slackTeamOrgKey } from "@agentx/cloud-contracts";
import { decideSecondPersonApproval } from "./second-person-approval.js";
import { readSecondPersonApprovalEvidence, readAllowedDomainActorConditions, type SecondPersonEvidenceDependencies } from "./second-person-evidence.js";
import type { AuditRuntime, TransactItem } from "../audit/outbox.js";
import { unbindProjectChannel, type ProjectSlackChannelDependencies } from "./slack-binding.js";
import { readRequestRecord, requireSameRequest } from "./request-records.js";
type Row = Record<string, unknown>;
type Scope = { orgId: OrgId; project: string; by: string };
const forbidden = () => agentXError("FORBIDDEN", "Live company owner or admin access is required.");
const missing = () => agentXError("NOT_FOUND", "Slack binding information was not found.");
const disconnected = () => agentXError("SLACK_TEAM_NOT_BOUND", "This Slack workspace is not connected to your company.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Slack binding information could not be verified.");
async function read(deps: SecondPersonEvidenceDependencies, key: { pk: string; sk: string }): Promise<Row | undefined> {
 const row = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Row }).Item;
 if (row !== undefined) { try { const raw = JSON.stringify(row);if (Buffer.byteLength(raw, "utf8") > 524288) throw unavailable(); } catch { throw unavailable(); } }
 return row;
}
/** Company role precedes project/workspace existence; the shared reader pins
 * live identity, membership, pointer and open company for a later transaction. */
export async function requireProjectSlackAuthority(deps: SecondPersonEvidenceDependencies, input: Scope) {
 const member = await read(deps, orgMemberKey(input.orgId, input.by));
 if (member?.orgId !== input.orgId || member.developerId !== input.by || (member.role !== "owner" && member.role !== "admin")) throw forbidden();
 const org = await read(deps, orgMetaKey(input.orgId));if (org === undefined || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
 const conditions = await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 if (!AgentXNameSchema.safeParse(input.project).success) throw missing();
 const project = await read(deps, projectMetaKey(input.orgId, input.project));
 if (project === undefined || project.name !== input.project || (project.status !== "active" && project.status !== "archived")) throw missing();
 return { conditions, project };
}
/** Exact database-only target review. It does not enumerate Slack or verify bot membership. */
export async function readProjectSlackTarget(deps: SecondPersonEvidenceDependencies, input: Scope & { teamId: string; channelId: string }) {
 const context = await requireProjectSlackAuthority(deps, input);
 if (!SlackTeamIdSchema.safeParse(input.teamId).success || !SlackChannelIdSchema.safeParse(input.channelId).success) throw agentXError("CONFIG_INVALID", "Enter valid Slack workspace and channel IDs.");
 const [team, reverse] = await Promise.all([read(deps, slackTeamOrgKey(input.teamId)), read(deps, orgSlackTeamKey(input.orgId, input.teamId))]);
 if (team?.orgId !== input.orgId || reverse === undefined) throw disconnected();
 const key = slackBindingKey(input.orgId, input.teamId, input.channelId), binding = await read(deps, key);
 if (binding !== undefined && binding.projectName !== input.project) throw agentXError("CONFIG_INVALID", "This Slack channel is unavailable for this project.");
 if (binding !== undefined && (binding.teamId !== input.teamId || binding.channelId !== input.channelId || typeof binding.updatedAt !== "string" || !Number.isFinite(Date.parse(binding.updatedAt)))) throw unavailable();
 // A review is an observation, not a promise of a complete/atomic inventory.
 await requireProjectSlackAuthority(deps, input);
 return { orgId: input.orgId, project: input.project, teamId: input.teamId, channelId: input.channelId, projectStatus: context.project.status as "active" | "archived",
  state: binding === undefined ? "unlinked" as const : "linked" as const, ...(binding === undefined ? {} : { updatedAt: String(binding.updatedAt) }), botMembership: "not_verified" as const,
  contextDigest: createHash("sha256").update(canonicalJson({ orgId: input.orgId, project: input.project, teamId: input.teamId, channelId: input.channelId, projectIdentity: context.project, binding: binding ?? null })).digest("hex") };
}
const unbound = z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, removed: z.boolean() }).strict();
const bound = z.object({ binding: z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, projectName: AgentXNameSchema, updatedAt: z.string().datetime() }).strict(), changed: z.boolean() }).strict();
/** Uses the existing SLACK_BINDING_REQUEST record and its 24-hour expiry. Never
 * replays a write or reads another actor's stored response. */
export async function readProjectSlackRequest(deps: SecondPersonEvidenceDependencies, input: Scope & { requestId: string }) {
 await requireProjectSlackAuthority(deps, input);if (!z.string().uuid().safeParse(input.requestId).success) throw missing();
 const row = await readRequestRecord(deps.documentClient, deps.tableName, { pk: projectPk(input.orgId, input.project), sk: `SLACK_BINDING_REQUEST#${input.requestId}` }, deps.now());
 if (row === undefined || row.by !== input.by) throw missing();
 if (typeof row.indexExpiresAt !== "number" || !Number.isSafeInteger(row.indexExpiresAt) || row.indexExpiresAt <= Math.floor(deps.now() / 1000)) throw missing();
 const outcome = row.action === "bind" ? bound.safeParse(row.response) : row.action === "unbind" ? unbound.safeParse(row.response) : undefined;
 if (outcome === undefined || !outcome.success || ("binding" in outcome.data && outcome.data.binding.projectName !== input.project)) throw unavailable();
 return { requestId: input.requestId, operation: row.action as "bind" | "unbind", outcome: outcome.data, receiptExpiresAt: new Date(row.indexExpiresAt * 1000).toISOString() };
}

const cursorSchema = z.object({ orgId: z.string(), project: AgentXNameSchema, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema.optional() }).strict();
/** Cursors are untrusted page annotations. Every page reloads connected teams
 * and live authority; no cursor can select a raw DynamoDB partition/key. */
export async function listProjectSlackBindings(deps: SecondPersonEvidenceDependencies, input: Scope & { cursor?: string }) {
 const started = deps.now();let responseBytes = 0, queryCount = 0;
 const withinTime = () => { const elapsed = deps.now() - started;if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10000) throw unavailable(); };
 const beforeQuery = () => { withinTime();if (++queryCount > 100) throw unavailable(); };
 const consume = (value: unknown) => { withinTime();let bytes: number;try { const raw = JSON.stringify(value ?? null);if (typeof raw !== "string") throw unavailable();bytes = Buffer.byteLength(raw, "utf8"); } catch { throw unavailable(); }responseBytes += bytes;if (bytes > 524288 || responseBytes > 1048576) throw unavailable(); };
 await requireProjectSlackAuthority(deps, input);withinTime();
 const invalidCursor = () => agentXError("CONFIG_INVALID", "Refresh the Slack binding list before continuing.");
 let cursor: z.infer<typeof cursorSchema> | undefined;
 if (input.cursor !== undefined) {
  try { if (input.cursor.length > 1024) throw invalidCursor();cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
  catch { throw invalidCursor(); }
  if (cursor.orgId !== input.orgId || cursor.project !== input.project) throw invalidCursor();
 }
 const teams: string[] = [];let teamKey: Row | undefined, truncatedTeams = false;
 const seenTeamKeys = new Set<string>();
 for (let page = 0; page < 21; page++) {
  beforeQuery();
  const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, ConsistentRead: true, Limit: 21 - teams.length,
   KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(input.orgId), ":prefix": "SLACK_TEAM#" }, ...(teamKey === undefined ? {} : { ExclusiveStartKey: teamKey }) })) as { Items?: Row[]; LastEvaluatedKey?: Row };
  consume(response);
  if ((response.Items?.length ?? 0) > 21 - teams.length) throw unavailable();
  for (const row of response.Items ?? []) {
   const team = typeof row.sk === "string" ? row.sk.slice("SLACK_TEAM#".length) : undefined;
   if (row.pk !== orgPk(input.orgId) || typeof row.sk !== "string" || !row.sk.startsWith("SLACK_TEAM#") || !SlackTeamIdSchema.safeParse(team).success || teams.includes(String(team))) throw unavailable();
   teams.push(String(team));
  }
  teamKey = response.LastEvaluatedKey;
  if (teams.length > 20) { teams.length = 20;truncatedTeams = true;break; }
  if (teamKey === undefined) break;
  if (teamKey.pk !== orgPk(input.orgId) || typeof teamKey.sk !== "string" || !teamKey.sk.startsWith("SLACK_TEAM#") || seenTeamKeys.has(canonicalJson(teamKey))) throw unavailable();
  seenTeamKeys.add(canonicalJson(teamKey));if (page === 20) truncatedTeams = true;
 }
 let teamIndex = cursor === undefined ? 0 : teams.indexOf(cursor.teamId);if (teamIndex < 0) throw invalidCursor();
 const bindings: Array<{ teamId: string; channelId: string; updatedAt: string }> = [];
 let inspected = 0, continuation: string | null = null, limitReached = truncatedTeams;
 const encode = (teamId: string, channelId?: string) => Buffer.from(JSON.stringify({ orgId: input.orgId, project: input.project, teamId, ...(channelId === undefined ? {} : { channelId }) })).toString("base64url");
 for (; teamIndex < teams.length; teamIndex++) {
  withinTime();const teamId = teams[teamIndex]!, connected = await read(deps, slackTeamOrgKey(teamId));consume(connected);if (connected?.orgId !== input.orgId) throw disconnected();
  let after = cursor?.teamId === teamId ? cursor.channelId : undefined;
  const seen = new Set<string>();
  while (inspected < 1000) {
   beforeQuery();
   const limit = Math.min(100, 1000 - inspected), pk = slackBindingPk(input.orgId, teamId);
   const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, ConsistentRead: true, Limit: limit,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": "CHANNEL#" }, ...(after === undefined ? {} : { ExclusiveStartKey: slackBindingKey(input.orgId, teamId, after) }) })) as { Items?: Row[]; LastEvaluatedKey?: Row };
   consume(response);const rows = response.Items ?? [];if (rows.length > limit) throw unavailable();
   for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;inspected++;
    if (!SlackChannelIdSchema.safeParse(row.channelId).success || row.pk !== pk || row.sk !== `CHANNEL#${String(row.channelId)}` || row.teamId !== teamId || !AgentXNameSchema.safeParse(row.projectName).success || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) throw unavailable();
    if (row.projectName === input.project) bindings.push({ teamId, channelId: String(row.channelId), updatedAt: row.updatedAt });
    if (bindings.length === 100) {
     continuation = i + 1 < rows.length || response.LastEvaluatedKey !== undefined ? encode(teamId, String(row.channelId)) : teamIndex + 1 < teams.length ? encode(teams[teamIndex + 1]!) : null;
     break;
    }
   }
   if (bindings.length === 100) break;
   const key = response.LastEvaluatedKey;if (key === undefined) break;
   if (key.pk !== pk || typeof key.sk !== "string" || !key.sk.startsWith("CHANNEL#") || !SlackChannelIdSchema.safeParse(key.sk.slice(8)).success || seen.has(canonicalJson(key))) throw unavailable();
   seen.add(canonicalJson(key));after = key.sk.slice(8);
   if (inspected === 1000) { limitReached = true;continuation = encode(teamId, after); }
  }
  if (bindings.length === 100 || inspected === 1000) {
   if (inspected === 1000 && continuation === null && teamIndex + 1 < teams.length) { limitReached = true;continuation = encode(teams[teamIndex + 1]!); }
   break;
  }
 }
 await requireProjectSlackAuthority(deps, input);withinTime();
 return { orgId: input.orgId, project: input.project, workspaces: teams, bindings, continuation, limitReached, partial: continuation !== null || limitReached, inspected, botMembership: "not_verified" as const };
}

/** Released direct unbind only. Bind proposals remain held for the owner's ruling. */
export async function commitProjectSlackUnbind(deps: SecondPersonEvidenceDependencies & { audit?: AuditRuntime; orgs: ProjectSlackChannelDependencies["orgs"] }, input: Scope & { teamId: string; channelId: string; requestId: string; expectedContextDigest: string }) {
 const context = await requireProjectSlackAuthority(deps, input);
 if (!z.string().uuid().safeParse(input.requestId).success || !SlackTeamIdSchema.safeParse(input.teamId).success || !SlackChannelIdSchema.safeParse(input.channelId).success || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(input.expectedContextDigest).success) throw agentXError("CONFIG_INVALID", "Review a valid Slack unlink before sending.");
 const prior = await readRequestRecord(deps.documentClient, deps.tableName, { pk: projectPk(input.orgId, input.project), sk: `SLACK_BINDING_REQUEST#${input.requestId}` }, deps.now());
 if (prior !== undefined) {
  requireSameRequest(prior, { by: input.by, action: "unbind", bodyHash: createHash("sha256").update(`${input.teamId}\n${input.channelId}`, "utf8").digest("hex") });
  return unbound.parse(prior.response);
 }
 const review = await readProjectSlackTarget(deps, input);
 if (review.contextDigest !== input.expectedContextDigest) throw agentXError("CHANGE_STALE", "Review the current Slack link before sending.");
 const observed = await read(deps, slackBindingKey(input.orgId, input.teamId, input.channelId));
 if ((observed === undefined) !== (review.state === "unlinked") || (observed !== undefined && (observed.projectName !== input.project || observed.updatedAt !== review.updatedAt))) throw agentXError("CHANGE_STALE", "Review the current Slack link before sending.");
 const names: Record<string, string> = {}, values: Row = {}, clauses = ["attribute_exists(pk)"];
 for (const [i, field] of ["name", "status", "archiveRevision", "createdAt", "createdBy"].entries()) {
  const name = `#s${String(i)}`, value = `:s${String(i)}`;names[name] = field;
  if (context.project[field] === undefined) clauses.push(`attribute_not_exists(${name})`);else { clauses.push(`${name} = ${value}`);values[value] = context.project[field]; }
 }
 const conditions: TransactItem[] = [...context.conditions,
  { ConditionCheck: { TableName: deps.tableName, Key: projectMetaKey(input.orgId, input.project), ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
  { ConditionCheck: { TableName: deps.tableName, Key: slackTeamOrgKey(input.teamId), ConditionExpression: "orgId = :slackOrg", ExpressionAttributeValues: { ":slackOrg": input.orgId } } },
  { ConditionCheck: { TableName: deps.tableName, Key: orgSlackTeamKey(input.orgId, input.teamId), ConditionExpression: "attribute_exists(pk)" } },
 ];
 return unbindProjectChannel({ ...deps, now: () => new Date(deps.now()) }, input.orgId, input.project, { requestId: input.requestId, teamId: input.teamId, channelId: input.channelId, actor: { developerId: input.by } }, {
  teamId: input.teamId, ...(observed === undefined ? {} : { observed: { teamId: input.teamId, channelId: input.channelId, projectName: input.project, updatedAt: String(observed.updatedAt) } }), conditions,
  revalidate: async () => { await requireProjectSlackAuthority(deps, input);const team = await read(deps, slackTeamOrgKey(input.teamId));if (team?.orgId !== input.orgId) throw disconnected(); },
 });
}

/** Server-only approval evidence; callers must commit every returned condition
 * with the pending proposal, canonical binding, receipt and audit. This read
 * alone grants no write capability. Company-only scope excludes maintainers. */
export async function readProjectSlackBindApproval(deps: SecondPersonEvidenceDependencies,
 input: Scope & { proposerId: string; approverId: string; teamId: string; channelId: string }) {
 if (input.by !== input.approverId) throw forbidden();
 const context = await requireProjectSlackAuthority(deps, input);
 const evidence = await readSecondPersonApprovalEvidence(deps, { orgId: input.orgId, proposerId: input.proposerId, approverId: input.approverId });
 const decision = decideSecondPersonApproval(evidence.decisionInput);
 const target = await readProjectSlackTarget(deps, input);
 if (context.project.status !== "active" || target.projectStatus !== "active" || target.state !== "unlinked") throw agentXError("CHANGE_STALE", "Review the current Slack link before sending.");
 const names: Record<string, string> = {}, values: Row = {}, clauses = ["attribute_exists(pk)"];
 for (const [i, field] of ["name", "status", "archiveRevision", "createdAt", "createdBy"].entries()) {
  const name = `#b${String(i)}`, value = `:b${String(i)}`;names[name] = field;
  if (context.project[field] === undefined) clauses.push(`attribute_not_exists(${name})`);
  else { clauses.push(`${name} = ${value}`);values[value] = context.project[field]; }
 }
 const conditions: TransactItem[] = [...evidence.conditions,
  { ConditionCheck: { TableName: deps.tableName, Key: projectMetaKey(input.orgId, input.project), ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
  { ConditionCheck: { TableName: deps.tableName, Key: slackTeamOrgKey(input.teamId), ConditionExpression: "orgId = :slackOrg", ExpressionAttributeValues: { ":slackOrg": input.orgId } } },
  { ConditionCheck: { TableName: deps.tableName, Key: orgSlackTeamKey(input.orgId, input.teamId), ConditionExpression: "attribute_exists(pk)" } },
 ];
 return { decision, conditions, contextDigest: target.contextDigest };
}
