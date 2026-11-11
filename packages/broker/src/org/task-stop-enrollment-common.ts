// Enrollment-only native reads, bounded transactions and owner/session authority.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, errorStatus, OrgIdSchema, agentXError, canonicalJson } from "@rovara-code/contracts";
import { TaskStopCompanyPolicySchema, TaskStopEnrollmentStateSchema, developerOrgKey, orgMemberKey, orgMetaKey, orgSettingsKey } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { budgetActorChecks } from "../agents/budget-authority.js";
import type { TransactItem } from "../agents/table-writes.js";
import { readAllowedDomainActorConditions } from "./second-person-evidence.js";
import { nativeSnapshotConditions } from "./native-snapshot-conditions.js";
import { isFreshSignIn } from "../developer/store.js";
export type Row = Record<string, unknown>;
export type Key = { pk: string; sk: string };
export type EnrollmentDeps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "developer" | "now" | "audit" | "agents">;
export const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const stale = () => agentXError("CHANGE_STALE", "Spending settings changed. Resolve any pending Spending change first, then capture a fresh review.");
export const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner may manage enforcement.");
export const invalid = () => agentXError("CONFIG_INVALID", "Review the exact enforcement change and try again.");
export function decodeBody(value: unknown): unknown {
 if (typeof value !== "string") return value;
 if (Buffer.byteLength(value) > 16_384) throw invalid();
 try { return JSON.parse(value) as unknown; } catch { throw invalid(); }
}
export const reauth = () => agentXError("REAUTH_REQUIRED", "Sign in again to confirm enforcement. A sign-in within the last 10 minutes is required.");
export class TaskStopReadinessError extends AgentXError {
 constructor(code: "TASK_STOP_CONFIG_MISSING" | "TASK_STOP_CONFIG_INVALID", readonly resource: { kind: "project" | "agent"; name: string }) {
  super(code, "Prepare this resource's Spending setting before enforcement.", errorStatus(code));
 }
}
export const missing = (resource?: { kind: "project" | "agent"; name: string }) => resource === undefined ? agentXError("TASK_STOP_CONFIG_MISSING", "Prepare every company Spending setting before reviewing enforcement.") : new TaskStopReadinessError("TASK_STOP_CONFIG_MISSING", resource);
export const badConfig = (resource?: { kind: "project" | "agent"; name: string }) => resource === undefined ? agentXError("TASK_STOP_CONFIG_INVALID", "A company Spending setting needs repair before enforcement.") : new TaskStopReadinessError("TASK_STOP_CONFIG_INVALID", resource);
export const tooLarge = () => agentXError("TASK_STOP_REVIEW_TOO_LARGE", "This review supports at most 100 active tasks and 80 project/agent source actions. Prepare a smaller inventory before trying again.");
export async function read(deps: EnrollmentDeps, Key: Key, TableName = deps.tableName): Promise<Row | undefined> {
 return (await deps.documentClient.send(new GetCommand({ TableName, Key, ConsistentRead: true })) as { Item?: Row }).Item;
}
export function checks(deps: EnrollmentDeps, key: Key, row: Row | undefined, fields: string[] = []): TransactItem[] {
 return nativeSnapshotConditions(deps.tableName, [key], [row], fields);
}
export async function ownerChecks(deps: EnrollmentDeps, caller: DeveloperCaller): Promise<TransactItem[]> {
 if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/u.test(caller.developerId)) throw forbidden();
 const [member, pointer, org] = await Promise.all([read(deps, orgMemberKey(caller.orgId, caller.developerId)), read(deps, developerOrgKey(caller.developerId)), read(deps, orgMetaKey(caller.orgId))]);
 if (member?.orgId !== caller.orgId || member.developerId !== caller.developerId || member.role !== "owner" || pointer?.orgId !== caller.orgId || pointer.role !== "owner" || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
 const identity = await readAllowedDomainActorConditions({ ...deps, signInTableName: deps.developer.signInTableName }, { orgId: caller.orgId, project: "", actorId: caller.developerId });
 return [...budgetActorChecks(deps.tableName, caller.orgId, { developerId: caller.developerId, role: "owner" }), ...identity];
}
export async function freshChecks(deps: EnrollmentDeps, caller: DeveloperCaller): Promise<TransactItem[]> {
 if (caller.sessionId === undefined || caller.sessionId.length < 1 || caller.sessionId.length > 200) throw reauth();
 const key = { pk: `SESSION#${caller.sessionId}`, sk: "META" }, table = deps.developer.signInTableName;
 const [row, identity] = await Promise.all([read(deps, key, table), read(deps, { pk: `DEVELOPER#${caller.developerId}`, sk: "META" }, table)]);
 const session = z.object({ sessionId: z.literal(caller.sessionId), developerId: z.literal(caller.developerId), authTime: z.string().datetime(), startedAt: z.string().datetime(), endsAt: z.number().int(), revokedAt: z.unknown().optional() }).passthrough().safeParse(row);
 if (!session.success || session.data.revokedAt !== undefined || session.data.endsAt <= Math.floor(deps.now() / 1000) || Date.parse(session.data.authTime) > deps.now() || !isFreshSignIn(session.data, deps.now())
  || (identity?.sessionsEndedAt !== undefined && (typeof identity.sessionsEndedAt !== "string" || !Number.isFinite(Date.parse(identity.sessionsEndedAt)) || Date.parse(session.data.startedAt) <= Date.parse(identity.sessionsEndedAt)))) throw reauth();
 return nativeSnapshotConditions(table, [key], [row], ["revokedAt", "authTime", "endsAt"]);
}
export async function companySource(deps: EnrollmentDeps, caller: DeveloperCaller, full = true) {
 const key = orgSettingsKey(caller.orgId, "TASK_STOP_POLICY"), row = await read(deps, key);
 if (row === undefined) throw missing();
 const parsed = z.object({ pk: z.literal(key.pk), sk: z.literal(key.sk), orgId: z.literal(caller.orgId), entityType: z.literal("ORG_TASK_STOP_POLICY"), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enrollment: z.object({ version: z.literal(1), state: TaskStopEnrollmentStateSchema }).strict() }).passthrough().safeParse(row);
 if (!parsed.success || full && (!TaskStopCompanyPolicySchema.safeParse(row.policy).success || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(row, field)))) throw badConfig();
 return { key, row, revision: parsed.data.revision, state: parsed.data.enrollment.state };
}
/** One action per native key. Rename aliases before merging to avoid cross-source collisions. */
export function mergeChecks(input: readonly TransactItem[]): TransactItem[] {
 const result = new Map<string, NonNullable<TransactItem["ConditionCheck"]>>(), seen = new Set<string>();
 input.forEach((item, index) => {
  const c = item.ConditionCheck;if (c === undefined || c.Key === undefined || c.ConditionExpression === undefined) throw invalid();
  const id = canonicalJson([c.TableName, c.Key]), signature = canonicalJson([id, c.ConditionExpression, c.ExpressionAttributeNames, c.ExpressionAttributeValues]);
  if (seen.has(signature)) return;seen.add(signature);
  const tokens: Record<string, string> = {}, names: Record<string, string> = {}, values: Row = {};
  for (const [token, field] of Object.entries(c.ExpressionAttributeNames ?? {})) { const name = `#ec${index}_${token.slice(1)}`;tokens[token] = name;names[name] = field; }
  for (const [token, value] of Object.entries(c.ExpressionAttributeValues ?? {})) { const name = `:ec${index}_${token.slice(1)}`;tokens[token] = name;values[name] = value; }
  const condition = c.ConditionExpression.replace(/[#:]\w+/gu, token => tokens[token] ?? token), previous = result.get(id);
  result.set(id, { ...c, ConditionExpression: previous === undefined ? condition : `(${previous.ConditionExpression}) AND (${condition})`,
   ...(Object.keys(names).length === 0 && previous?.ExpressionAttributeNames === undefined ? {} : { ExpressionAttributeNames: { ...previous?.ExpressionAttributeNames, ...names } }),
   ...(Object.keys(values).length === 0 && previous?.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: { ...previous?.ExpressionAttributeValues, ...values } }) });
 });
 return [...result.values()].map(ConditionCheck => ({ ConditionCheck }));
}
export function transactionBounds(items: readonly TransactItem[], receipt = true): void {
 if (items.length + (receipt ? 1 : 0) > 100 || Buffer.byteLength(JSON.stringify(items)) > 3_900_000 || items.some(item => item.Put !== undefined && Buffer.byteLength(JSON.stringify(item.Put.Item)) > 400_000)) throw tooLarge();
}
