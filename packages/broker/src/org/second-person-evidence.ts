import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, canonicalJson, developerOrgKey, orgMemberKey, orgMetaKey, orgPk, projectMemberKey, projectMetaKey, type OrgId } from "@agentx/contracts";
import type { TransactItem } from "../audit/outbox.js";
import { secondPersonMembershipCondition, type ApprovalDecisionInput } from "./second-person-approval.js";

type Row = Record<string, unknown>;
type Key = { pk: string; sk: string };
export interface SecondPersonEvidenceDependencies {
 documentClient: { send(command: unknown): Promise<unknown> };
 tableName: string;
 signInTableName: string;
 now(): number;
}
export interface SecondPersonEvidenceScope {
 orgId: OrgId;
 project?: string;
 proposerId: string;
 approverId: string;
}
const forbidden = () => agentXError("FORBIDDEN", "Live company approval authority is required.");
const stale = () => agentXError("CHANGE_STALE", "Approval membership evidence must be refreshed.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Complete approval eligibility evidence is unavailable.");
const personId = /^[a-f0-9]{64}$/;
const roleValid = (role: unknown): role is "owner" | "admin" | "member" => role === "owner" || role === "admin" || role === "member";
async function read(deps: SecondPersonEvidenceDependencies, key: Key, tableName = deps.tableName): Promise<Row | undefined> {
 return (await deps.documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Row }).Item;
}
function snapshot(tableName: string, key: Key, row: Row, fields: readonly string[]): TransactItem {
 const names: Record<string, string> = {}, values: Row = {}, clauses = ["attribute_exists(pk)"];
 for (const [index, field] of fields.entries()) {
  const name = `#e${String(index)}`, value = `:e${String(index)}`;names[name] = field;
  if (row[field] === undefined) clauses.push(`attribute_not_exists(${name})`);
  else { clauses.push(`${name} = ${value}`);values[value] = row[field]; }
 }
 return { ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }) } };
}
const identityLive = (row: Row | undefined, id: string): boolean => row !== undefined && row.developerId === id && row.revoked !== true && row.mergedInto === undefined && row.provider !== "operator" && row.entityType !== "ADMINISTRATOR";

async function livePerson(deps: SecondPersonEvidenceDependencies, scope: SecondPersonEvidenceScope, id: string) {
 const [member, pointer, identity] = await Promise.all([
  read(deps, orgMemberKey(scope.orgId, id)), read(deps, developerOrgKey(id)),
  read(deps, { pk: `DEVELOPER#${id}`, sk: "META" }, deps.signInTableName),
 ]);
 if (member === undefined || member.orgId !== scope.orgId || member.developerId !== id || !roleValid(member.role)
  || pointer?.orgId !== scope.orgId || pointer.role !== member.role || identity === undefined || !identityLive(identity, id)) throw forbidden();
 const conditions = [
  snapshot(deps.tableName, orgMemberKey(scope.orgId, id), member, ["orgId", "developerId", "role", "roleUpdatedAt", "joinedAt"]),
  snapshot(deps.tableName, developerOrgKey(id), pointer, ["orgId", "role"]),
  snapshot(deps.signInTableName, { pk: `DEVELOPER#${id}`, sk: "META" }, identity, ["developerId", "revoked", "mergedInto", "provider", "entityType", "sessionsEndedAt"]),
 ];
 if (member.role === "member") {
  if (scope.project === undefined) throw forbidden();
  const key = projectMemberKey(scope.orgId, id, scope.project), grant = await read(deps, key);
  if (grant?.role !== "developer" || grant.projectRole !== "maintainer" || grant.ownerKey !== id || grant.projectName !== scope.project || typeof grant.grantId !== "string") throw forbidden();
  conditions.push(snapshot(deps.tableName, key, grant, ["role", "projectRole", "ownerKey", "projectName", "grantId"]));
 }
 return { member, conditions };
}

/** Bounded consistent directory enumeration; it conveys no authority until the
 * same org generation is checked again and fenced by the eventual commit. */
async function members(deps: SecondPersonEvidenceDependencies, orgId: OrgId): Promise<Row[]> {
 const rows: Row[] = [], seen = new Set<string>();let cursor: Row | undefined;
 for (let page = 0; page < 100; page += 1) {
  const result = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName,
   KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "MEMBER#" },
   ConsistentRead: true, Limit: 100, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
  })) as { Items?: Row[]; LastEvaluatedKey?: Row };
  for (const row of result.Items ?? []) {
   if (row.pk !== orgPk(orgId) || typeof row.developerId !== "string" || !personId.test(row.developerId) || row.sk !== orgMemberKey(orgId, row.developerId).sk || row.orgId !== orgId || !roleValid(row.role) || rows.some(previous => previous.developerId === row.developerId)) throw unavailable();
   rows.push(row);if (rows.length > 500) throw unavailable();
  }
  cursor = result.LastEvaluatedKey;if (cursor === undefined) return rows;
  if (cursor.pk !== orgPk(orgId) || typeof cursor.sk !== "string" || !cursor.sk.startsWith("MEMBER#") || !personId.test(cursor.sk.slice("MEMBER#".length))) throw unavailable();
  const digest = canonicalJson(cursor);if (seen.has(digest)) throw unavailable();seen.add(digest);
 }
 throw unavailable();
}

/** Read-only server evidence. The returned conditions MUST commit with the
 * action, proposal decision and audit; reading this result alone authorizes no write. */
export async function readSecondPersonApprovalEvidence(deps: SecondPersonEvidenceDependencies, scope: SecondPersonEvidenceScope): Promise<{ decisionInput: ApprovalDecisionInput; conditions: TransactItem[] }> {
 if (!personId.test(scope.proposerId) || !personId.test(scope.approverId) || !deps.signInTableName) throw forbidden();
 // The actual caller's authority precedes project/company existence information.
 const approver = await livePerson(deps, scope, scope.approverId);
 const proposer = scope.proposerId === scope.approverId ? approver : await livePerson(deps, scope, scope.proposerId);
 const meta = await read(deps, orgMetaKey(scope.orgId));
 if (meta === undefined || meta.closedAt !== undefined || meta.closingAt !== undefined || !Number.isSafeInteger(meta.approvalMembershipVersion) || Number(meta.approvalMembershipVersion) < 0) throw stale();
 const version = Number(meta.approvalMembershipVersion), nowMs = deps.now();
 let project: Row | undefined;
 if (scope.project !== undefined) {
  project = await read(deps, projectMetaKey(scope.orgId, scope.project));
  if (project === undefined || project.status !== "active") throw stale();
 }
 const conditions: TransactItem[] = [{ ConditionCheck: { TableName: deps.tableName, Key: orgMetaKey(scope.orgId), ...secondPersonMembershipCondition(version) } }, ...approver.conditions, ...(proposer === approver ? [] : proposer.conditions)];
 if (project !== undefined && scope.project !== undefined) conditions.push(snapshot(deps.tableName, projectMetaKey(scope.orgId, scope.project), project, ["status", "archiveRevision", "createdAt", "createdBy", "approvalLastMaintainerLossAt"]));
 const ownerIds: string[] = [], eligibleIds: string[] = [];
 let complete = true, lastEligibleLossAtMs: number | null = null;
 const loss = (value: unknown) => {
  if (value === undefined) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) { complete = false;return; }
  lastEligibleLossAtMs = Math.max(lastEligibleLossAtMs ?? 0, Date.parse(value));
 };
 if (scope.proposerId !== scope.approverId) {
  eligibleIds.push(scope.proposerId, scope.approverId);
 } else {
  const tracked = typeof meta.approvalTrackingSince === "string" ? Date.parse(meta.approvalTrackingSince) : Number.NaN;
  complete = Number.isFinite(tracked) && tracked <= nowMs && (tracked <= nowMs - 86_400_000 || meta.approvalTrackingSince === meta.createdAt);
  loss(meta.approvalLastCompanyEligibleLossAt);loss(project?.approvalLastMaintainerLossAt);
  const roster = await members(deps, scope.orgId);
  // Eight database-only identity/grant reads at a time; no vendor or network probe.
  for (let offset = 0; offset < roster.length; offset += 8) {
   await Promise.all(roster.slice(offset, offset + 8).map(async row => {
    const id = String(row.developerId);if (row.role === "owner") ownerIds.push(id);
    if (row.role === "member") {
     if (scope.project === undefined) return;
     const grant = await read(deps, projectMemberKey(scope.orgId, id, scope.project));
     if (grant?.role !== "developer" || grant.projectRole !== "maintainer") return;
     if (grant.ownerKey !== id || grant.projectName !== scope.project || typeof grant.grantId !== "string") { complete = false;return; }
    }
    const [identity, pointer] = await Promise.all([read(deps, { pk: `DEVELOPER#${id}`, sk: "META" }, deps.signInTableName), read(deps, developerOrgKey(id))]);
    if (pointer?.orgId !== scope.orgId || pointer.role !== row.role) { complete = false;return; }
    if (!identityLive(identity, id)) {
     // A session ending is not evidence of when a later account revocation occurred.
     const ended = identity?.revoked === true ? identity.revokedAt : identity?.mergedInto !== undefined ? identity.sessionsEndedAt : undefined;
     if (ended === undefined) complete = false;else loss(ended);
     return;
    }
    eligibleIds.push(id);
   }));
  }
 }
 const after = await read(deps, orgMetaKey(scope.orgId));
 if (after?.approvalMembershipVersion !== version || after.closedAt !== undefined || after.closingAt !== undefined) throw stale();
 return { decisionInput: { proposerId: scope.proposerId, approverId: scope.approverId, nowMs, complete, membershipVersion: version, ownerIds: ownerIds.sort(), eligibleIds: eligibleIds.sort(), lastEligibleLossAtMs }, conditions };
}

/** A direct narrowing needs live actor authority, not a second-person decision. */
export async function readAllowedDomainActorConditions(deps: SecondPersonEvidenceDependencies, input: { orgId: OrgId; project: string; actorId: string }): Promise<TransactItem[]> {
 if (!personId.test(input.actorId) || !deps.signInTableName) throw forbidden();
 const actor = await livePerson(deps, { orgId: input.orgId, project: input.project, proposerId: input.actorId, approverId: input.actorId }, input.actorId);
 const meta = await read(deps, orgMetaKey(input.orgId));
 if (meta === undefined || meta.closedAt !== undefined || meta.closingAt !== undefined) throw stale();
 return [...actor.conditions, { ConditionCheck: { TableName: deps.tableName, Key: orgMetaKey(input.orgId), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt)" } }];
}
