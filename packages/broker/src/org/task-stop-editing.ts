import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
 canonicalJson, agentXError, orgScoped, orgMemberKey, orgSettingsKey, projectAiKey, orgProjectCatalogKey, projectMetaKey,
 TaskStopCompanyPolicySchema, TaskStopProjectPolicySchema, TaskStopPendingChangeSchema, TaskStopEditingContextSchema,
 TaskStopEditBodySchema, TaskStopDecisionBodySchema, TaskStopEditResultSchema, taskStopEditKind, type TaskStopEditablePolicy,
} from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { readRequest, commit, type TransactItem } from "../agents/table-writes.js";
import { auditPending } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditTaskStopPolicyChange } from "../audit/events.js";
import { readAllowedDomainActorConditions, readSecondPersonApprovalEvidence } from "./second-person-evidence.js";
import { decideSecondPersonApproval } from "./second-person-approval.js";
import { nativeSnapshotConditions } from "./native-snapshot-conditions.js";
import { parseProjectAiWithRevision } from "../spend/settings.js";
type Row = Record<string, unknown>;
type Key = { pk: string; sk: string };
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "developer" | "audit">;
const stale = () => agentXError("CHANGE_STALE", "Spending settings changed. Reload and review your change again.");
const forbidden = () => agentXError("FORBIDDEN", "Only current company owners and admins may change Spending settings.");
const invalid = () => agentXError("CONFIG_INVALID", "Review the exact Spending policy and try again.");
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function read(deps: Deps, Key: Key): Promise<Row | undefined> {
 return (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Row }).Item;
}
function financialConditions(deps: Deps, caller: DeveloperCaller, conditions: TransactItem[], people: string[]): TransactItem[] {
 const found = new Set<string>();
 const result = conditions.map(item => {
  if (item.ConditionCheck === undefined) return item;
  const c = item.ConditionCheck;
  const id = people.find(person => { const key = orgMemberKey(caller.orgId, person); return c.TableName === deps.tableName && c.Key?.pk === key.pk && c.Key?.sk === key.sk; });
  if (id === undefined) return item;
  found.add(id);
  return { ConditionCheck: { ...c, ConditionExpression: `(${c.ConditionExpression}) AND (#spendingFinancialRole = :spendingOwner OR #spendingFinancialRole = :spendingAdmin)`,
   ExpressionAttributeNames: { ...c.ExpressionAttributeNames, "#spendingFinancialRole": "role" }, ExpressionAttributeValues: { ...c.ExpressionAttributeValues, ":spendingOwner": "owner", ":spendingAdmin": "admin" } } };
 });
 if (people.some(id => !found.has(id))) throw forbidden();return result;
}
async function authority(deps: Deps, caller: DeveloperCaller, project?: string): Promise<TransactItem[]> {
 const member = await read(deps, orgMemberKey(caller.orgId, caller.developerId));
 if (member?.orgId !== caller.orgId || member.developerId !== caller.developerId || (member.role !== "owner" && member.role !== "admin")) throw forbidden();
 // The shared actor reader reads no project grant for company administrators.
 const conditions = await readAllowedDomainActorConditions({ ...deps, signInTableName: deps.developer.signInTableName }, { orgId: caller.orgId, project: project ?? "", actorId: caller.developerId });
 return financialConditions(deps, caller, conditions, [caller.developerId]);
}
function companyPolicy(raw: unknown): TaskStopEditablePolicy {
 const p = TaskStopCompanyPolicySchema.safeParse(raw);if (!p.success) throw invalid();
 return p.data.schemaVersion === 1 ? { kind: "limited", stopMicrousd: p.data.defaultStopMicrousd } : p.data.defaultPolicy;
}
function projectPolicy(raw: unknown): TaskStopEditablePolicy {
 const p = TaskStopProjectPolicySchema.safeParse(raw);if (!p.success) throw invalid();
 return p.data.schemaVersion === 1 ? { kind: "limited", stopMicrousd: p.data.stopMicrousd } : { kind: "inherit" };
}
async function source(deps: Deps, caller: DeveloperCaller, project?: string) {
 const key = project === undefined ? orgSettingsKey(caller.orgId, "TASK_STOP_POLICY") : projectAiKey(caller.orgId, project);
 const original = await read(deps, key);
 const sourceMissing = original === undefined && project !== undefined;
 const row = original ?? (sourceMissing ? { ...key, entityType: "PROJECT_AI", orgId: caller.orgId, project, revision: 0, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } } : undefined);
 if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || row.orgId !== caller.orgId || !Number.isSafeInteger(row.revision) || Number(row.revision) < (sourceMissing ? 0 : 1)
  || row.entityType !== (project === undefined ? "ORG_TASK_STOP_POLICY" : "PROJECT_AI")) throw stale();
 const guards: TransactItem[] = [];let identity: unknown = null;
 if (project !== undefined) {
  if (row.project !== project) throw stale();if (!sourceMissing) parseProjectAiWithRevision(row, project);
  const keys = [orgProjectCatalogKey(caller.orgId, project), projectMetaKey(caller.orgId, project)];
  const rows = await Promise.all(keys.map(k => read(deps, k)));
  const [catalog, meta] = rows;
  if (catalog?.entityType !== "PROJECT_CATALOG" || catalog.name !== project || (catalog.orgId !== undefined && catalog.orgId !== caller.orgId)
   || !Number.isSafeInteger(catalog.latestRevision) || Number(catalog.latestRevision) < 1 || meta?.entityType !== "PROJECT_META" || meta.name !== project
   || (meta.orgId !== undefined && meta.orgId !== caller.orgId) || meta.status !== "active" || meta.archivedAt !== undefined) throw stale();
  identity = [catalog.latestRevision, meta.createdAt ?? null, meta.createdBy ?? null, meta.archiveRevision ?? null];
  guards.push(...nativeSnapshotConditions(deps.tableName, keys, rows, ["orgId", "status", "archivedAt", "createdAt", "createdBy", "archiveRevision"]));
 }
 const raw = project === undefined ? row.policy : row.taskStopPolicy;
 const policy = project === undefined ? companyPolicy(raw) : projectPolicy(raw);
 const revision = Number(row.revision), sourceDigest = digest([caller.orgId, project ?? null, revision, raw, identity]);
 const pending = row.pendingTaskStopChange === undefined ? undefined : TaskStopPendingChangeSchema.parse(row.pendingTaskStopChange);
 if (pending !== undefined && (pending.scopeKind !== (project === undefined ? "company" : "project") || pending.project !== project)) throw stale();
 return { key, row, original, sourceMissing, raw, policy, revision, sourceDigest, pending, guards };
}
export async function getTaskStopEditing(deps: Deps, caller: DeveloperCaller, project?: string) {
 await authority(deps, caller, project);
 // QA6-04: a company with no stored policy and no seed receipt has task stops Disabled (admission reads that as disabled). Say so, with nothing to edit: the policy is created by Rovara's spending setup, never by this editor,
 // so a write against it stays refused (`source` still throws CHANGE_STALE). An absent row is the only case: a row that is there but wrong is still an error.
 if (project === undefined && await read(deps, orgSettingsKey(caller.orgId, "TASK_STOP_POLICY")) === undefined) {
  // The same rule admission uses (`captureTaskStopSnapshot`): Disabled only when the seed receipts are missing too. A seeded company whose policy row has disappeared is refused as invalid there, so it is told so here.
  const receipts = await Promise.all(["V1#bootstrap", "V1#upgrade"].map(sk => read(deps, { pk: orgScoped(caller.orgId, "TASK_STOP_SEED"), sk })));
  if (receipts.some(receipt => receipt !== undefined)) throw invalid();
  await authority(deps, caller, project);
  return TaskStopEditingContextSchema.parse({ orgId: caller.orgId, scopeKind: "company", revision: 0, sourceState: "not_set_up", sourceDigest: digest([caller.orgId, null, 0, null, null]), policy: { kind: "rovara_estimate" } });
 }
 const s = await source(deps, caller, project);await authority(deps, caller, project);
 const provenance = project === undefined ? s.row.seedProvenance : undefined;
 if (provenance !== undefined && (typeof provenance !== "object" || provenance === null || Array.isArray(provenance))) throw invalid();
 const seed = provenance as Row | undefined;
 const seedReview = seed === undefined ? undefined : { source: seed.source, reviewRequired: seed.reviewRequired, seededAt: seed.seededAt };
 return TaskStopEditingContextSchema.parse({ orgId: caller.orgId, scopeKind: project === undefined ? "company" : "project", ...(project === undefined ? {} : { project }), revision: s.revision, sourceState: s.sourceMissing ? "missing" : "present", ...(s.row.lastTaskStopChange === undefined ? {} : { lastTaskStopChange: s.row.lastTaskStopChange }), sourceDigest: s.sourceDigest, policy: s.policy, ...(seedReview === undefined ? {} : { seedReview }), ...(s.pending === undefined ? {} : { pending: s.pending }) });
}
export async function writeTaskStopEditing(deps: Deps, caller: DeveloperCaller, project: string | undefined, value: unknown, decision = false) {
 let checks = await authority(deps, caller, project);
 const parsed = decision ? TaskStopDecisionBodySchema.safeParse(value) : TaskStopEditBodySchema.safeParse(value);
 if (!parsed.success) throw invalid();
 const body = parsed.data, fingerprint = digest({ operation: decision ? "task-stop-decision" : "task-stop-edit", orgId: caller.orgId, project: project ?? null, body });
 const recover = async () => {
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, body.requestId);
  if (earlier === undefined) return undefined;if (earlier.fingerprint !== fingerprint) throw agentXError("IDEMPOTENCY_CONFLICT", "Use a new request id for different Spending terms.");
  return TaskStopEditResultSchema.parse(earlier.result);
 };
 const replay = await recover();if (replay !== undefined) return replay;
 const s = await source(deps, caller, project), next: Row = { ...s.row };
 let after = s.policy, state: "applied" | "pending" | "unchanged" | "rejected" | "cancelled", proposalId: string | undefined;
 let expiredProposal: typeof s.pending;
 let action: "spending.policy_changed" | "spending.policy_change_requested" | "spending.policy_change_decided" | undefined;
 if ("policy" in body) {
  if (body.expectedRevision !== s.revision || body.expectedPolicyDigest !== s.sourceDigest) throw stale();
  if ((project === undefined && body.policy.kind === "inherit") || (project !== undefined && body.policy.kind === "rovara_estimate")) throw invalid();
  const kind = s.sourceMissing ? "tightening" : taskStopEditKind(s.policy, body.policy);
  if (kind === "unchanged") state = "unchanged";
  else {
   if (s.pending !== undefined && kind === "loosening") throw stale();after = body.policy;
   if (kind === "loosening") {
    proposalId = body.requestId;state = "pending";action = "spending.policy_change_requested";
    const terms = { version: 1 as const, proposalId, requestedBy: caller.developerId, createdAt: new Date(deps.now()).toISOString(), baseRevision: s.revision,
     beforePolicy: s.raw, proposedPolicy: after, sourceDigest: s.sourceDigest, scopeKind: project === undefined ? "company" as const : "project" as const, ...(project === undefined ? {} : { project }) };
    next.pendingTaskStopChange = TaskStopPendingChangeSchema.parse({ ...terms, proposalDigest: digest(terms) });
   } else {
    state = "applied";action = "spending.policy_changed";
    if (s.pending !== undefined) {
     expiredProposal = s.pending;delete next.pendingTaskStopChange;
     next.lastTaskStopChange = { proposalId: s.pending.proposalId, state: "expired", reason: "tightening_applied", endedAt: new Date(deps.now()).toISOString() };
    }
   }
  }
 } else {
  if (body.requestId === body.proposalId || s.pending?.proposalId !== body.proposalId) throw stale();
  proposalId = body.proposalId;after = s.pending.proposedPolicy;
  if (body.decision === "cancel" && s.pending.requestedBy !== caller.developerId) throw forbidden();
  if (body.decision === "approve") {
   if (s.pending.requestedBy === caller.developerId) throw agentXError("FORBIDDEN", "A different current company owner or admin must approve this loosening.");
   const { proposalDigest, ...originalTerms } = s.pending;
   if (body.expectedProposalDigest !== proposalDigest || digest(originalTerms) !== proposalDigest
    || (project === undefined && after.kind === "inherit") || (project !== undefined && after.kind === "rovara_estimate")) throw stale();
   if (s.pending.baseRevision !== s.revision || s.pending.sourceDigest !== s.sourceDigest || canonicalJson(s.pending.beforePolicy) !== canonicalJson(s.raw)) throw stale();
   const evidence = await readSecondPersonApprovalEvidence({ ...deps, signInTableName: deps.developer.signInTableName }, { orgId: caller.orgId, ...(project === undefined ? {} : { project }), proposerId: s.pending.requestedBy, approverId: caller.developerId });
   const approval = decideSecondPersonApproval(evidence.decisionInput);
   // Controller holds the sole-owner exception until the complete rollout is approved.
   if (approval.mode !== "second_person") throw forbidden();
   checks = financialConditions(deps, caller, evidence.conditions, [s.pending.requestedBy, caller.developerId]);state = "applied";
  } else state = body.decision === "reject" ? "rejected" : "cancelled";
  delete next.pendingTaskStopChange;action = "spending.policy_change_decided";
 }
 if (state === "applied") {
  next.revision = s.revision + 1;if (!Number.isSafeInteger(next.revision)) throw stale();
  if (project === undefined) next.policy = { schemaVersion: 2, defaultPolicy: after };
  else next.taskStopPolicy = after.kind === "limited" ? { schemaVersion: 1, stopMicrousd: after.stopMicrousd } : { schemaVersion: 2, kind: "inherit" };
 }
 const result = TaskStopEditResultSchema.parse({ requestId: body.requestId, state, revision: next.revision, ...(proposalId === undefined ? {} : { proposalId }) });
 const original = nativeSnapshotConditions(deps.tableName, [s.key], [s.original], ["pendingTaskStopChange", "lastTaskStopChange"])[0]!.ConditionCheck!;
 const items: TransactItem[] = state === "unchanged" ? [{ ConditionCheck: original }] : [{ Put: { TableName: deps.tableName, Item: { ...next, updatedBy: caller.developerId, updatedAt: new Date(deps.now()).toISOString() }, ConditionExpression: original.ConditionExpression, ExpressionAttributeNames: original.ExpressionAttributeNames, ExpressionAttributeValues: original.ExpressionAttributeValues } }];
 const events = action === undefined ? [] : [auditTaskStopPolicyChange({ orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(deps.now()).toISOString(), occurrence: body.requestId, action,
  scopeKind: project === undefined ? "company" : "project", ...(project === undefined ? {} : { project }), revision: Number(next.revision), requestId: body.requestId, ...(proposalId === undefined ? {} : { proposalId }), before: s.policy, after, ...("decision" in body ? { decision: body.decision } : {}) })];
 if (expiredProposal !== undefined) events.push(auditTaskStopPolicyChange({ orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(deps.now()).toISOString(), occurrence: `${body.requestId}:expire:${expiredProposal.proposalId}`, action: "spending.policy_change_decided", scopeKind: project === undefined ? "company" : "project", ...(project === undefined ? {} : { project }), revision: Number(next.revision), requestId: body.requestId, proposalId: expiredProposal.proposalId, before: project === undefined ? companyPolicy(expiredProposal.beforePolicy) : projectPolicy(expiredProposal.beforePolicy), after: expiredProposal.proposedPolicy, decision: "expired", reason: "tightening_applied" }));
 if (events.length > 0 && deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", "Spending changes require the audit ledger.");
 const native = [...checks];
 for (const guard of s.guards) {
  const key = guard.ConditionCheck!.Key;
  if (key === undefined) throw stale();
  const existing = native.find(item => item.ConditionCheck?.TableName === guard.ConditionCheck?.TableName && item.ConditionCheck?.Key?.pk === key.pk && item.ConditionCheck?.Key?.sk === key.sk)?.ConditionCheck;
  if (existing === undefined) native.push(guard);
  else {
   // Merge the full source identity fence into the shared evidence action; one action per native key.
   const additional = guard.ConditionCheck!;
   existing.ConditionExpression = `(${existing.ConditionExpression}) AND (${additional.ConditionExpression})`;
   existing.ExpressionAttributeNames = { ...existing.ExpressionAttributeNames, ...additional.ExpressionAttributeNames };
   existing.ExpressionAttributeValues = { ...existing.ExpressionAttributeValues, ...additional.ExpressionAttributeValues };
  }
 }
 try { await commit(deps, [...items, ...events.flatMap(event => auditPending(deps, event)), ...native], failed => failed.has(0) ? stale() : forbidden(),
  { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint }, result); }
 catch (error) { const committed = await recover();if (committed !== undefined) return committed;throw error; }
 await flushAuditEvents(deps, events);return result;
}
