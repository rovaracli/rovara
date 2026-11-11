import { planLegacyDomainNarrowing, domainRequestHash } from "./legacy-domain-narrowing.js";
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, WorkingBranchNameSchema, StoredProjectDefinitionSchema, AllowedDomainSchema, DEFAULT_AGENT_ALLOW_DOMAINS, EgressDomainsItemSchema, egressDomainsKey, INDEX_EXPIRY_ATTRIBUTE, ProjectDefinitionSchema, agentXError, canonicalJson, orgProjectCatalogKey, projectMetaKey, projectPk, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditOccurrence } from "../audit/events.js";
import { auditProjectAllowedDomains } from "../audit/allowed-domains.js";
import { decideSecondPersonApproval } from "./second-person-approval.js";
import { planProjectEgressChange } from "./project-egress-plan.js";
import { readSecondPersonApprovalEvidence, readAllowedDomainActorConditions } from "./second-person-evidence.js";
import { isAllowedDomainWidening, refuseAllowedDomainWidening } from "./allowed-domain-policy.js";
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; signInTableName: string; now(): number; audit?: AuditRuntime }
type Row = Record<string, unknown>;
const canonicalDomains = z.array(AllowedDomainSchema).max(50).transform(domains => [...new Set(domains)].sort());
const bodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive(), allowedDomains: canonicalDomains, expectedContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const proposalSchema = z.object({
 entityType: z.literal("EGRESS_PROPOSAL"), kind: z.literal("widening"), orgId: z.string(), project: z.string(), by: z.string(), proposalId: z.string().uuid(),
 bodyHash: z.string().regex(/^[0-9a-f]{64}$/), state: z.enum(["pending", "applied", "rejected", "cancelled"]), baseRevision: z.number().int().positive(),
 beforeDomains: canonicalDomains, afterDomains: canonicalDomains, baseDefinitionDigest: z.string().regex(/^[0-9a-f]{64}$/), afterDigest: z.string().regex(/^[0-9a-f]{64}$/),
 projectIdentity: z.object({ createdAt: z.string().datetime(), createdBy: z.string(), archiveRevision: z.number().int().nonnegative().nullable() }).strict(),
 createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).passthrough();
export type AllowedDomainProposal = z.infer<typeof proposalSchema>;
const pointerSchema = z.object({ entityType: z.literal("EGRESS_PROPOSAL_LIVE"), orgId: z.string(), project: z.string(), proposalId: z.string().uuid(), expiresAt: z.string().datetime() }).passthrough();
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const contextDigest = (orgId: OrgId, project: string, revision: number, definition: unknown, meta: Row) => digest({ orgId, project, revision, definitionDigest: digest(definition),
 projectIdentity: { createdAt: meta.createdAt, createdBy: meta.createdBy, archiveRevision: meta.archiveRevision ?? null } });
const stale = () => agentXError("CHANGE_STALE", "Project website context changed. Review again.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Project website proposal state could not be read.");
const keyOf = (orgId: OrgId, project: string, id: string) => ({ pk: projectPk(orgId, project), sk: `EGRESS_PROPOSAL#${id}` });
const liveKeyOf = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "EGRESS_PROPOSAL_LIVE" });
async function read(deps: Dependencies, key: { pk: string; sk: string }): Promise<Row | undefined> {
 return (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Row }).Item;
}
/** Internal browser-route core. Pending proposals never change desired websites,
 * staff decisions, DNS sync state or the immutable project definition. */
/** Extra audit details a caller may add to the event it causes (the setup host ask names its origin and who pressed): short plain fields, kept apart from the facts. */
export type AllowedDomainAuditDetails = Record<string, string>;
export async function proposeProjectAllowedDomains(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; body: unknown; auditDetails?: AllowedDomainAuditDetails }): Promise<AllowedDomainProposal> {
 const authority = await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const parsedBody = bodySchema.safeParse(input.body);
 if (!parsedBody.success) throw agentXError("CONFIG_INVALID", "Review a valid website list and request id.");
 const body = parsedBody.data, key = keyOf(input.orgId, input.project, body.requestId), bodyHash = digest({ orgId: input.orgId, project: input.project, by: input.by, body });
 const owned = async (): Promise<AllowedDomainProposal | undefined> => {
  const raw = await read(deps, key);if (raw === undefined) return undefined;
  if (raw.orgId !== input.orgId || raw.project !== input.project || raw.by !== input.by || raw.bodyHash !== bodyHash || raw.kind !== "widening") throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different website proposal.");
  const result = proposalSchema.safeParse(raw);
  if (!result.success || result.data.proposalId !== body.requestId || result.data.baseRevision !== body.expectedRevision
    || result.data.afterDigest !== digest(result.data.afterDomains) || canonicalJson(result.data.afterDomains) !== canonicalJson(body.allowedDomains)) throw unavailable();
  return result.data;
 };
 const replay = await owned();if (replay !== undefined) return replay;
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const catalogKey = orgProjectCatalogKey(input.orgId, input.project), metaKey = projectMetaKey(input.orgId, input.project);
 const [catalog, meta] = await Promise.all([read(deps, catalogKey), read(deps, metaKey)]);
 if (catalog?.latestRevision !== body.expectedRevision || meta?.status !== "active" || !z.string().datetime().safeParse(meta.createdAt).success || typeof meta.createdBy !== "string"
  || (meta.archiveRevision !== undefined && !z.number().int().nonnegative().safeParse(meta.archiveRevision).success)) throw stale();
 const revisionKey = projectRevisionKey(input.orgId, input.project, body.expectedRevision), revision = await read(deps, revisionKey);
 const definition = ProjectDefinitionSchema.safeParse(revision?.definition);
 if (!definition.success || definition.data.name !== input.project || definition.data.revision !== body.expectedRevision) throw stale();
 if (body.expectedContextDigest !== undefined && body.expectedContextDigest !== contextDigest(input.orgId, input.project, body.expectedRevision, revision!.definition, meta)) throw stale();
 const beforeDomains = [...new Set(definition.data.network?.allowedDomains ?? [])].sort(), afterDomains = body.allowedDomains;
 if (!isAllowedDomainWidening(beforeDomains, afterDomains)) throw agentXError("CONFIG_INVALID", "Use direct save for an unchanged or narrower website list.");
 const now = deps.now(), createdAt = new Date(now).toISOString(), expiresAt = new Date(now + 86400000).toISOString(), liveKey = liveKeyOf(input.orgId, input.project);
 const rawPointer = await read(deps, liveKey), checkedPointer = rawPointer === undefined ? undefined : pointerSchema.safeParse(rawPointer);
 if (checkedPointer !== undefined && (!checkedPointer.success || checkedPointer.data.orgId !== input.orgId || checkedPointer.data.project !== input.project)) throw unavailable();
 const pointer = checkedPointer?.success ? checkedPointer.data : undefined;
 if (pointer !== undefined && Date.parse(pointer.expiresAt) > now) throw stale();
 const proposal = proposalSchema.parse({ ...key, entityType: "EGRESS_PROPOSAL", kind: "widening", orgId: input.orgId, project: input.project, by: input.by, proposalId: body.requestId,
  bodyHash, state: "pending", baseRevision: body.expectedRevision, beforeDomains, afterDomains, baseDefinitionDigest: digest(revision!.definition), afterDigest: digest(afterDomains),
  projectIdentity: { createdAt: meta.createdAt, createdBy: meta.createdBy, archiveRevision: meta.archiveRevision ?? null }, createdAt, expiresAt,
  [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + 31 * 86400,
 });
 const event = auditProjectAllowedDomains({ orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: createdAt, occurrence: auditOccurrence(input.project, body.requestId, "proposed"),
  action: "proposed", projectName: input.project, requestId: body.requestId, proposalId: body.requestId, fromRevision: body.expectedRevision, toRevision: body.expectedRevision,
  added: afterDomains.filter(domain => !beforeDomains.includes(domain)).length, removed: beforeDomains.filter(domain => !afterDomains.includes(domain)).length,
  beforeDigest: digest(beforeDomains), afterDigest: proposal.afterDigest,
 });
 if (input.auditDetails !== undefined) event.details?.push({ subject: "org", fields: input.auditDetails });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const items: TransactItem[] = [...authority,
  { ConditionCheck: { TableName: deps.tableName, Key: catalogKey, ConditionExpression: "latestRevision = :revision", ExpressionAttributeValues: { ":revision": body.expectedRevision } } },
  { ConditionCheck: { TableName: deps.tableName, Key: revisionKey, ConditionExpression: "#definition = :definition", ExpressionAttributeNames: { "#definition": "definition" }, ExpressionAttributeValues: { ":definition": revision!.definition } } },
  { ConditionCheck: { TableName: deps.tableName, Key: metaKey, ConditionExpression: "#status = :active AND createdAt = :createdAt AND createdBy = :createdBy AND " + (meta.archiveRevision === undefined ? "attribute_not_exists(archiveRevision)" : "archiveRevision = :archiveRevision"),
   ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active", ":createdAt": meta.createdAt, ":createdBy": meta.createdBy, ...(meta.archiveRevision === undefined ? {} : { ":archiveRevision": meta.archiveRevision }) } } },
  { Put: { TableName: deps.tableName, Item: proposal, ConditionExpression: "attribute_not_exists(pk)" } },
  { Put: { TableName: deps.tableName, Item: { ...liveKey, entityType: "EGRESS_PROPOSAL_LIVE", orgId: input.orgId, project: input.project, proposalId: body.requestId, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + 31 * 86400 },
   ConditionExpression: pointer === undefined ? "attribute_not_exists(pk)" : "proposalId = :oldId AND expiresAt = :oldExpiry AND orgId = :org AND #project = :project AND entityType = :type",
   ...(pointer === undefined ? {} : { ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":oldId": pointer.proposalId, ":oldExpiry": pointer.expiresAt, ":org": input.orgId, ":project": input.project, ":type": "EGRESS_PROPOSAL_LIVE" } }) } }, ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This website proposal cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) {
  // Recovery reads only this UUID. It never resends or replans the proposal.
  await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
  const recovered = await owned();if (recovered !== undefined) return recovered;
  if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable();
 }
 await flushAuditEvents(deps, [event]);return proposal;
}

async function loadProposal(deps: Dependencies, input: { orgId: OrgId; project: string; proposalId: string }): Promise<AllowedDomainProposal> {
 if (!z.string().uuid().safeParse(input.proposalId).success) throw agentXError("CONFIG_INVALID", "Choose a valid website proposal.");
 const raw = await read(deps, keyOf(input.orgId, input.project, input.proposalId));
 if (raw === undefined || raw.orgId !== input.orgId || raw.project !== input.project || raw.kind !== "widening") throw agentXError("NOT_FOUND", "Website proposal not found.");
 const parsed = proposalSchema.safeParse(raw);
 if (!parsed.success || parsed.data.proposalId !== input.proposalId || parsed.data.afterDigest !== digest(parsed.data.afterDomains)) throw unavailable();
 return parsed.data;
}
/** Exact current context plus reusable commit fences. A status read never writes. */
async function proposalContext(deps: Dependencies, proposal: AllowedDomainProposal, orgId: OrgId): Promise<TransactItem[] | undefined> {
 const catalogKey = orgProjectCatalogKey(orgId, proposal.project), metaKey = projectMetaKey(orgId, proposal.project), revisionKey = projectRevisionKey(orgId, proposal.project, proposal.baseRevision);
 const [catalog, meta, revision] = await Promise.all([read(deps, catalogKey), read(deps, metaKey), read(deps, revisionKey)]);
 if (catalog?.latestRevision !== proposal.baseRevision || meta?.status !== "active" || meta.createdAt !== proposal.projectIdentity.createdAt || meta.createdBy !== proposal.projectIdentity.createdBy
  || (meta.archiveRevision ?? null) !== proposal.projectIdentity.archiveRevision || revision === undefined || digest(revision.definition) !== proposal.baseDefinitionDigest) return undefined;
 return [
  { ConditionCheck: { TableName: deps.tableName, Key: catalogKey, ConditionExpression: "latestRevision = :revision", ExpressionAttributeValues: { ":revision": proposal.baseRevision } } },
  { ConditionCheck: { TableName: deps.tableName, Key: revisionKey, ConditionExpression: "#definition = :definition", ExpressionAttributeNames: { "#definition": "definition" }, ExpressionAttributeValues: { ":definition": revision.definition } } },
  { ConditionCheck: { TableName: deps.tableName, Key: metaKey, ConditionExpression: "#status = :active AND createdAt = :createdAt AND createdBy = :createdBy AND " + (meta.archiveRevision === undefined ? "attribute_not_exists(archiveRevision)" : "archiveRevision = :archiveRevision"),
   ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active", ":createdAt": meta.createdAt, ":createdBy": meta.createdBy, ...(meta.archiveRevision === undefined ? {} : { ":archiveRevision": meta.archiveRevision }) } } },
 ];
}
/** Cancellation changes no configuration and may release an obsolete revision
 * proposal, but never one from a different lifecycle or recreated project. */
async function obsoleteCancellationContext(deps: Dependencies, proposal: AllowedDomainProposal, orgId: OrgId): Promise<TransactItem[] | undefined> {
 const metaKey = projectMetaKey(orgId, proposal.project), catalogKey = orgProjectCatalogKey(orgId, proposal.project);
 const [meta, catalog] = await Promise.all([read(deps, metaKey), read(deps, catalogKey)]);
 const revision = z.number().int().positive().safeParse(catalog?.latestRevision);
 if (!revision.success || revision.data <= proposal.baseRevision || meta?.status !== "active" || meta.createdAt !== proposal.projectIdentity.createdAt || meta.createdBy !== proposal.projectIdentity.createdBy
  || (meta.archiveRevision ?? null) !== proposal.projectIdentity.archiveRevision || catalog === undefined) return undefined;
 const key = projectRevisionKey(orgId, proposal.project, revision.data), row = await read(deps, key), definition = ProjectDefinitionSchema.safeParse(row?.definition);
 if (row === undefined || !definition.success || definition.data.name !== proposal.project || definition.data.revision !== revision.data) return undefined;
 return [immutableRecordFence(deps.tableName, metaKey, meta, []), immutableRecordFence(deps.tableName, catalogKey, catalog, []), immutableRecordFence(deps.tableName, key, row)];
}
export async function readProjectAllowedDomainProposal(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; proposalId: string }): Promise<{ proposal: AllowedDomainProposal; status: AllowedDomainProposal["state"] | "expired" | "stale" }> {
 await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const proposal = await loadProposal(deps, input);
 if (proposal.state !== "pending") return { proposal, status: proposal.state };
 if (Date.parse(proposal.expiresAt) <= deps.now()) return { proposal, status: "expired" };
 if (await proposalContext(deps, proposal, input.orgId) === undefined) return { proposal, status: "stale" };
 try { await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: proposal.by }); }
 catch (error) { if (error !== null && typeof error === "object" && "code" in error && (error.code === "FORBIDDEN" || error.code === "CHANGE_STALE")) return { proposal, status: "stale" };throw error; }
 return { proposal, status: "pending" };
}
const decisionSchema = z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), decision: z.enum(["cancel", "reject"]), reason: z.string().trim().max(280).optional() }).strict();
const decisionReceiptSchema = z.object({ entityType: z.literal("EGRESS_PROPOSAL"), kind: z.literal("decision_receipt"), orgId: z.string(), project: z.string(), by: z.string(),
 requestId: z.string().uuid(), proposalId: z.string().uuid(), bodyHash: z.string().regex(/^[0-9a-f]{64}$/), state: z.enum(["cancelled", "rejected"]), createdAt: z.string().datetime() }).passthrough();
/** Deduplicate identical actor/org checks only; never silently merge different fences. */
function uniqueChecks(items: TransactItem[]): TransactItem[] {
 const result: TransactItem[] = [], seen = new Map<string, string>();
 for (const item of items) {
  if (item.ConditionCheck === undefined) throw unavailable();
  const key = canonicalJson({ table: item.ConditionCheck.TableName, key: item.ConditionCheck.Key }), value = canonicalJson(item);
  const previous = seen.get(key);if (previous !== undefined && previous !== value) throw unavailable();
  if (previous === undefined) { seen.set(key, value);result.push(item); }
 }
 return result;
}
export async function decideProjectAllowedDomainProposal(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; body: unknown }): Promise<z.infer<typeof decisionReceiptSchema>> {
 const actorConditions = await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const parsed = decisionSchema.safeParse(input.body);if (!parsed.success || parsed.data.requestId === parsed.data.proposalId) throw agentXError("CONFIG_INVALID", "Review a valid proposal decision with a fresh request id.");
 const body = parsed.data, receiptKey = keyOf(input.orgId, input.project, body.requestId), bodyHash = digest({ orgId: input.orgId, project: input.project, by: input.by, body });
 const recover = async () => {
  const row = await read(deps, receiptKey);if (row === undefined) return undefined;
  if (row.orgId !== input.orgId || row.project !== input.project || row.by !== input.by || row.bodyHash !== bodyHash || row.kind !== "decision_receipt") throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different website decision.");
  const result = decisionReceiptSchema.safeParse(row);
  if (!result.success || result.data.requestId !== body.requestId || result.data.proposalId !== body.proposalId || result.data.state !== (body.decision === "cancel" ? "cancelled" : "rejected")) throw unavailable();return result.data;
 };
 const replay = await recover();if (replay !== undefined) return replay;
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const proposal = await loadProposal(deps, { ...input, proposalId: body.proposalId });
 if (body.decision === "cancel" ? input.by !== proposal.by : input.by === proposal.by) throw agentXError("FORBIDDEN", "This website proposal requires the appropriate person to decide it.");
 const context = await proposalContext(deps, proposal, input.orgId) ?? (body.decision === "cancel" ? await obsoleteCancellationContext(deps, proposal, input.orgId) : undefined), now = deps.now(), at = new Date(now).toISOString();
 if (proposal.state !== "pending" || Date.parse(proposal.expiresAt) <= now || context === undefined) throw stale();
 const proposerConditions = input.by === proposal.by ? [] : await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: proposal.by });
 const state = body.decision === "cancel" ? "cancelled" as const : "rejected" as const;
 const receipt = decisionReceiptSchema.parse({ ...receiptKey, entityType: "EGRESS_PROPOSAL", kind: "decision_receipt", orgId: input.orgId, project: input.project, by: input.by,
  requestId: body.requestId, proposalId: body.proposalId, bodyHash, state, createdAt: at, expiresAt: proposal.expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(proposal.expiresAt) / 1000) + 30 * 86400 });
 const event = auditProjectAllowedDomains({ orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: at, occurrence: auditOccurrence(input.project, body.requestId, state),
  action: state, projectName: input.project, requestId: body.requestId, proposalId: body.proposalId, fromRevision: proposal.baseRevision, toRevision: proposal.baseRevision,
  added: proposal.afterDomains.filter(domain => !proposal.beforeDomains.includes(domain)).length, removed: proposal.beforeDomains.filter(domain => !proposal.afterDomains.includes(domain)).length,
  beforeDigest: digest(proposal.beforeDomains), afterDigest: proposal.afterDigest });
 if (body.reason !== undefined && body.reason !== "") event.details?.push({ subject: "org", fields: { reason: body.reason } });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const items: TransactItem[] = [...uniqueChecks([...actorConditions, ...proposerConditions, ...context]),
  { Put: { TableName: deps.tableName, Item: { ...proposal, state, decidedAt: at, decidedBy: input.by, decisionRequestId: body.requestId, ...(body.reason === undefined ? {} : { reason: body.reason }) },
   ConditionExpression: "#state = :pending AND bodyHash = :hash AND afterDigest = :digest AND expiresAt = :expires AND expiresAt > :now AND #by = :by AND baseRevision = :base AND projectIdentity = :identity AND baseDefinitionDigest = :definition AND afterDomains = :after AND beforeDomains = :before",
   ExpressionAttributeNames: { "#state": "state", "#by": "by" }, ExpressionAttributeValues: { ":pending": "pending", ":hash": proposal.bodyHash, ":digest": proposal.afterDigest, ":expires": proposal.expiresAt, ":now": at,
    ":by": proposal.by, ":base": proposal.baseRevision, ":identity": proposal.projectIdentity, ":definition": proposal.baseDefinitionDigest, ":after": proposal.afterDomains, ":before": proposal.beforeDomains } } },
  { Delete: { TableName: deps.tableName, Key: liveKeyOf(input.orgId, input.project), ConditionExpression: "proposalId = :id AND expiresAt = :expires AND orgId = :org AND #project = :project",
   ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":id": body.proposalId, ":expires": proposal.expiresAt, ":org": input.orgId, ":project": input.project } } },
  { Put: { TableName: deps.tableName, Item: receipt, ConditionExpression: "attribute_not_exists(pk)" } }, ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This website decision cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) {
  await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });const recovered = await recover();if (recovered !== undefined) return recovered;
  if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable();
 }
 await flushAuditEvents(deps, [event]);return receipt;
}

const approvalBodySchema = z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), soleOwnerAcknowledged: z.boolean().default(false) }).strict();
const approvalReceiptSchema = z.object({ entityType: z.literal("EGRESS_PROPOSAL"), kind: z.literal("approval_receipt"), orgId: z.string(), project: z.string(), by: z.string(),
 requestId: z.string().uuid(), proposalId: z.string().uuid(), bodyHash: z.string().regex(/^[0-9a-f]{64}$/), state: z.literal("applied"), mode: z.enum(["second_person", "sole_owner_exception"]),
 resultRevision: z.number().int().positive(), createdAt: z.string().datetime() }).passthrough();
const selectionsSchema = z.record(AgentXNameSchema, z.object({ branch: WorkingBranchNameSchema, commit: z.string().regex(/^[a-f0-9]{40}$/), installationId: z.number().int().positive(), repositoryId: z.number().int().positive() }).strict()).refine(value => Object.keys(value).length <= 32);
function immutableRecordFence(tableName: string, key: { pk: string; sk: string }, row: Row, critical: string[] = ["workingBranchSelections", "runtimeBinding", "setupApproval"]): TransactItem {
 const fields = [...new Set([...Object.keys(row), ...critical])].filter(field => field !== "pk" && field !== "sk").sort();
 const names: Record<string, string> = {}, values: Row = {}, conditions = ["attribute_exists(pk)"];
 for (const [i, field] of fields.entries()) { const name = `#r${i}`, value = `:r${i}`;names[name] = field;
  if (row[field] === undefined) conditions.push(`attribute_not_exists(${name})`);else { conditions.push(`${name} = ${value}`);values[value] = row[field]; }
 }
 return { ConditionCheck: { TableName: tableName, Key: key, ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
}
/** Internal primitive only. No browser/CLI registration input grants this capability.
 * It copies the immutable registration and branch pins verbatim and changes only
 * the revision number and reviewed website list, with all effects in one commit. */
export async function commitReviewedProjectAllowedDomains(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; body: unknown; auditDetails?: AllowedDomainAuditDetails }): Promise<z.infer<typeof approvalReceiptSchema>> {
 await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const parsed = approvalBodySchema.safeParse(input.body);if (!parsed.success || parsed.data.requestId === parsed.data.proposalId) throw agentXError("CONFIG_INVALID", "Review a website approval with a fresh request id.");
 const body = parsed.data, receiptKey = keyOf(input.orgId, input.project, body.requestId), bodyHash = digest({ orgId: input.orgId, project: input.project, by: input.by, body });
 const recover = async () => {
  const row = await read(deps, receiptKey);if (row === undefined) return undefined;
  if (row.orgId !== input.orgId || row.project !== input.project || row.by !== input.by || row.bodyHash !== bodyHash || row.kind !== "approval_receipt") throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different website approval.");
  const result = approvalReceiptSchema.safeParse(row);if (!result.success || result.data.requestId !== body.requestId || result.data.proposalId !== body.proposalId) throw unavailable();return result.data;
 };
 const replay = await recover();if (replay !== undefined) return replay;
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const proposal = await loadProposal(deps, { ...input, proposalId: body.proposalId });
 if (proposal.state !== "pending" || Date.parse(proposal.expiresAt) <= deps.now()) throw stale();
 const evidence = await readSecondPersonApprovalEvidence(deps, { orgId: input.orgId, project: input.project, proposerId: proposal.by, approverId: input.by });
 const decision = decideSecondPersonApproval(evidence.decisionInput);
 if (decision.mode === "sole_owner_exception" && !body.soleOwnerAcknowledged) throw agentXError("FORBIDDEN", "Explicitly acknowledge the sole-owner website exception.");
 const context = await proposalContext(deps, proposal, input.orgId);if (context === undefined) throw stale();
 const baseKey = projectRevisionKey(input.orgId, input.project, proposal.baseRevision), registered = await read(deps, baseKey);
 if (registered === undefined || digest(registered.definition) !== proposal.baseDefinitionDigest || registered.runtimeBinding === null || typeof registered.runtimeBinding !== "object" || Array.isArray(registered.runtimeBinding)) throw stale();
 const definition = StoredProjectDefinitionSchema.safeParse(registered.definition);if (!definition.success) throw unavailable();
 const selections = selectionsSchema.safeParse(registered.workingBranchSelections ?? {});if (!selections.success) throw unavailable();
 for (const [name, pin] of Object.entries(selections.data)) {
  const repository = definition.data.repositories.find(repo => repo.name === name);
  if (repository === undefined || repository.installationId !== pin.installationId || repository.githubRepositoryId !== pin.repositoryId) throw unavailable();
 }
 const nextRevision = proposal.baseRevision + 1;if (!Number.isSafeInteger(nextRevision)) throw stale();
 const definitionRaw = registered.definition as Row;
 const nextDefinition = { ...definitionRaw, revision: nextRevision, network: { allowedDomains: proposal.afterDomains } };
 if (!StoredProjectDefinitionSchema.safeParse(nextDefinition).success || !isAllowedDomainWidening(proposal.beforeDomains, proposal.afterDomains)) throw unavailable();
 const now = deps.now(), at = new Date(now).toISOString();if (Date.parse(proposal.expiresAt) <= now) throw stale();
 const egress = await planProjectEgressChange({ ...deps, cloud: true, now: () => new Date(at) }, { orgId: input.orgId, project: input.project, actorId: input.by, domains: proposal.afterDomains });
 const receipt = approvalReceiptSchema.parse({ ...receiptKey, entityType: "EGRESS_PROPOSAL", kind: "approval_receipt", orgId: input.orgId, project: input.project, by: input.by,
  requestId: body.requestId, proposalId: body.proposalId, bodyHash, state: "applied", mode: decision.mode, resultRevision: nextRevision, createdAt: at, expiresAt: proposal.expiresAt,
  [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(proposal.expiresAt) / 1000) + 30 * 86400 });
 const event = auditProjectAllowedDomains({ orgId: input.orgId, actor: { kind: "member", id: input.by }, occurredAt: at, occurrence: auditOccurrence(input.project, body.requestId, "applied"),
  action: "changed", mode: decision.mode, projectName: input.project, requestId: body.requestId, proposalId: body.proposalId, fromRevision: proposal.baseRevision, toRevision: nextRevision,
  added: proposal.afterDomains.filter(domain => !proposal.beforeDomains.includes(domain)).length, removed: proposal.beforeDomains.filter(domain => !proposal.afterDomains.includes(domain)).length,
  beforeDigest: digest(proposal.beforeDomains), afterDigest: proposal.afterDigest });
 event.details?.push({ subject: "org", fields: {
  membershipVersion: String(decision.membershipVersion),
  ...(decision.mode === "sole_owner_exception" ? { ownerCount: String(evidence.decisionInput.ownerIds.length), exceptionReason: "sole_owner_no_other_eligible_24h_clear" } : {}),
 } });
 if (input.auditDetails !== undefined) event.details?.push({ subject: "org", fields: input.auditDetails });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Website changes require the audit ledger.");
 const catalogKey = orgProjectCatalogKey(input.orgId, input.project);
 // Evidence pins project META after live eligibility. Context was checked after
 // that read; the full base-row fence and catalog Update replace its other checks.
 const items: TransactItem[] = [...uniqueChecks(evidence.conditions), immutableRecordFence(deps.tableName, baseKey, registered),
  { Put: { TableName: deps.tableName, Item: { ...registered, ...projectRevisionKey(input.orgId, input.project, nextRevision), registeredBy: input.by, registeredAt: at, definition: nextDefinition }, ConditionExpression: "attribute_not_exists(pk)" } },
  { Update: { TableName: deps.tableName, Key: catalogKey, UpdateExpression: "SET latestRevision = :next", ConditionExpression: "latestRevision = :base", ExpressionAttributeValues: { ":next": nextRevision, ":base": proposal.baseRevision } } },
  ...egress.items,
  { Put: { TableName: deps.tableName, Item: { ...proposal, state: "applied", mode: decision.mode, decidedAt: at, decidedBy: input.by, decisionRequestId: body.requestId, resultRevision: nextRevision },
   ConditionExpression: "#state = :pending AND bodyHash = :hash AND afterDigest = :digest AND expiresAt = :expires AND expiresAt > :now AND #by = :by AND baseRevision = :base AND projectIdentity = :identity AND baseDefinitionDigest = :definition AND afterDomains = :after AND beforeDomains = :before",
   ExpressionAttributeNames: { "#state": "state", "#by": "by" }, ExpressionAttributeValues: { ":pending": "pending", ":hash": proposal.bodyHash, ":digest": proposal.afterDigest, ":expires": proposal.expiresAt, ":now": at,
    ":by": proposal.by, ":base": proposal.baseRevision, ":identity": proposal.projectIdentity, ":definition": proposal.baseDefinitionDigest, ":after": proposal.afterDomains, ":before": proposal.beforeDomains } } },
  { Delete: { TableName: deps.tableName, Key: liveKeyOf(input.orgId, input.project), ConditionExpression: "proposalId = :id AND expiresAt = :expires AND orgId = :org AND #project = :project",
   ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":id": body.proposalId, ":expires": proposal.expiresAt, ":org": input.orgId, ":project": input.project } } },
  { Put: { TableName: deps.tableName, Item: receipt, ConditionExpression: "attribute_not_exists(pk)" } }, ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This website approval cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) {
  await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });const recovered = await recover();if (recovered !== undefined) return recovered;
  if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable();
 }
 await flushAuditEvents(deps, [event]);return receipt;
}

const appliedProofSchema = z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), baseRevision: z.number().int().positive(), afterDigest: z.string().regex(/^[0-9a-f]{64}$/), soleOwnerAcknowledged: z.boolean().default(false) }).strict();
export type AppliedDomainProposalProof = z.input<typeof appliedProofSchema>;
/** Registrar-only seam: a proposal is not a generic registration capability.
 * Its persisted id, exact base and after-list digest authorize only that reviewed
 * website transition. Runtime, source, commands and all other fields stay pinned. */
export async function commitRegisteredProjectAllowedDomains(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; definition: unknown; runtimeBinding: unknown; proof: unknown }) {
 await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const parsed = appliedProofSchema.safeParse(input.proof);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid applied website proposal.");
 const proof = parsed.data, proposal = await loadProposal(deps, { ...input, proposalId: proof.proposalId });
 if (proposal.baseRevision !== proof.baseRevision || proposal.afterDigest !== proof.afterDigest) throw stale();
 const base = await read(deps, projectRevisionKey(input.orgId, input.project, proof.baseRevision));
 if (base === undefined || digest(base.definition) !== proposal.baseDefinitionDigest) throw stale();
 const expected = ProjectDefinitionSchema.safeParse({ ...(base.definition as Row), revision: proof.baseRevision + 1, network: { allowedDomains: proposal.afterDomains } });
 const supplied = ProjectDefinitionSchema.safeParse(input.definition);
 if (!expected.success || !supplied.success || canonicalJson(expected.data) !== canonicalJson(supplied.data) || canonicalJson(base.runtimeBinding) !== canonicalJson(input.runtimeBinding)) throw stale();
 const previous = await read(deps, keyOf(input.orgId, input.project, proof.requestId));
 const receipt = await commitReviewedProjectAllowedDomains(deps, { orgId: input.orgId, project: input.project, by: input.by,
  body: { requestId: proof.requestId, proposalId: proof.proposalId, soleOwnerAcknowledged: proof.soleOwnerAcknowledged } });
 return { receipt, duplicate: previous !== undefined };
}

/** A checked read snapshot, never an authorization token or an enforcement probe.
 * The subsequent proposal transaction rechecks all immutable identity fields. */
export async function readProjectAllowedDomainsReview(deps: Dependencies, input: { orgId: OrgId; project: string; by: string }) {
 await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const catalogKey = orgProjectCatalogKey(input.orgId, input.project), metaKey = projectMetaKey(input.orgId, input.project);
 const [catalog, meta] = await Promise.all([read(deps, catalogKey), read(deps, metaKey)]);
 if (catalog === undefined || meta === undefined) throw agentXError("NOT_FOUND", "Project website settings not found.");
 const revisionNumber = z.number().int().positive().safeParse(catalog.latestRevision);
 if (!revisionNumber.success || meta.status !== "active" || !z.string().datetime().safeParse(meta.createdAt).success || typeof meta.createdBy !== "string"
  || (meta.archiveRevision !== undefined && !z.number().int().nonnegative().safeParse(meta.archiveRevision).success)) throw stale();
 const revision = await read(deps, projectRevisionKey(input.orgId, input.project, revisionNumber.data)), definition = ProjectDefinitionSchema.safeParse(revision?.definition);
 if (!definition.success || definition.data.name !== input.project || definition.data.revision !== revisionNumber.data) throw stale();
 const allowedDomains = [...new Set(definition.data.network?.allowedDomains ?? [])].sort();
 const [egress, rawPointer] = await Promise.all([read(deps, egressDomainsKey(input.orgId, { kind: "project", project: input.project })), read(deps, liveKeyOf(input.orgId, input.project))]);
 const parsedEgress = egress === undefined ? undefined : EgressDomainsItemSchema.safeParse(egress);
 if (parsedEgress !== undefined && (!parsedEgress.success || parsedEgress.data.orgId !== input.orgId || parsedEgress.data.owner.kind !== "project" || parsedEgress.data.owner.project !== input.project)) throw unavailable();
 const staff = parsedEgress?.success ? parsedEgress.data : undefined;
 const staffDomains = allowedDomains.filter(domain => !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)).map(domain => ({ domain, status: staff?.active === true ? staff.domains.find(entry => entry.domain === domain)?.status ?? "unknown" : "unknown" }));
 let liveProposal: Awaited<ReturnType<typeof readProjectAllowedDomainProposal>> | null = null;
 if (rawPointer !== undefined) {
  const checked = pointerSchema.safeParse(rawPointer);if (!checked.success || checked.data.orgId !== input.orgId || checked.data.project !== input.project) throw unavailable();
  if (Date.parse(checked.data.expiresAt) > deps.now()) liveProposal = await readProjectAllowedDomainProposal(deps, { ...input, proposalId: checked.data.proposalId });
 }
 const checkedDigest = contextDigest(input.orgId, input.project, revisionNumber.data, revision!.definition, meta);
 const [currentCatalog, currentMeta] = await Promise.all([read(deps, catalogKey), read(deps, metaKey)]);
 if (currentCatalog?.latestRevision !== revisionNumber.data || currentMeta?.status !== "active" || contextDigest(input.orgId, input.project, revisionNumber.data, revision!.definition, currentMeta) !== checkedDigest) throw stale();
 await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 return { orgId: input.orgId, project: input.project, baseRevision: revisionNumber.data, contextDigest: checkedDigest, allowedDomains, defaultDomains: [...DEFAULT_AGENT_ALLOW_DOMAINS], staffDomains, liveProposal };
}

const directSaveSchema = bodySchema.extend({ expectedContextDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const directReceiptSchema = z.object({ entityType: z.literal("EGRESS_PROPOSAL"), orgId: z.string(), project: z.string(), by: z.string(), requestId: z.string().uuid(),
 bodyHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.literal("applied"), mode: z.literal("direct_narrowing"), baseRevision: z.number().int().positive(), resultRevision: z.number().int().positive(), createdAt: z.string().datetime() }).passthrough();
/** Browser-reviewed deletion-only update. Preserve every immutable registration
 * field, including reviewed branch and setup pins; never use legacy registration
 * to reinterpret this as a different source/runtime revision. */
export async function commitDirectProjectAllowedDomains(deps: Dependencies, input: { orgId: OrgId; project: string; by: string; body: unknown }) {
 const actor = await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });
 const parsed = directSaveSchema.safeParse(input.body);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review a valid website change before saving.");
 const body = parsed.data, receiptKey = keyOf(input.orgId, input.project, body.requestId), bodyHash = domainRequestHash(input.orgId, input.project, input.by, body);
 const recover = async () => {
  const raw = await read(deps, receiptKey);if (raw === undefined) return undefined;
  if (raw.orgId !== input.orgId || raw.project !== input.project || raw.by !== input.by || raw.bodyHash !== bodyHash || raw.mode !== "direct_narrowing") throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different website save.");
  const receipt = directReceiptSchema.safeParse(raw);
  if (!receipt.success || receipt.data.requestId !== body.requestId || receipt.data.baseRevision !== body.expectedRevision || receipt.data.resultRevision !== body.expectedRevision + 1) throw unavailable();return receipt.data;
 };
 const replay = await recover();if (replay !== undefined) return replay;
 const metaKey = projectMetaKey(input.orgId, input.project), baseKey = projectRevisionKey(input.orgId, input.project, body.expectedRevision), catalogKey = orgProjectCatalogKey(input.orgId, input.project);
 const [meta, registered, catalog] = await Promise.all([read(deps, metaKey), read(deps, baseKey), read(deps, catalogKey)]);
 if (meta?.status !== "active" || !z.string().datetime().safeParse(meta.createdAt).success || typeof meta.createdBy !== "string" || registered === undefined || catalog?.latestRevision !== body.expectedRevision
  || contextDigest(input.orgId, input.project, body.expectedRevision, registered.definition, meta) !== body.expectedContextDigest) throw stale();
 const definition = StoredProjectDefinitionSchema.safeParse(registered.definition);
 if (!definition.success || definition.data.name !== input.project || definition.data.revision !== body.expectedRevision || registered.runtimeBinding === null || typeof registered.runtimeBinding !== "object" || Array.isArray(registered.runtimeBinding)) throw unavailable();
 const selections = selectionsSchema.safeParse(registered.workingBranchSelections ?? {});if (!selections.success) throw unavailable();
 for (const [name, pin] of Object.entries(selections.data)) {
  const repository = definition.data.repositories.find(repo => repo.name === name);if (repository === undefined || repository.installationId !== pin.installationId || repository.githubRepositoryId !== pin.repositoryId) throw unavailable();
 }
 const before = [...new Set(definition.data.network?.allowedDomains ?? [])].sort(), after = body.allowedDomains;
 if (isAllowedDomainWidening(before, after)) refuseAllowedDomainWidening();
 if (canonicalJson(before) === canonicalJson(after)) return { state: "unchanged" as const, resultRevision: body.expectedRevision };
 const next = body.expectedRevision + 1;if (!Number.isSafeInteger(next)) throw stale();
 const nextDefinition: Row = { ...(registered.definition as Row), revision: next };if (after.length === 0) delete nextDefinition.network;else nextDefinition.network = { allowedDomains: after };
 if (!StoredProjectDefinitionSchema.safeParse(nextDefinition).success) throw unavailable();
 const plan = await planLegacyDomainNarrowing({ ...deps, cloud: true, now: () => new Date(deps.now()) }, { orgId: input.orgId, project: input.project, by: input.by, body, before, after, authority: actor });
 // The planner reads META again. Replace that read's fence with the ORIGINAL
 // reviewed identity snapshot, so archive/restore cannot rebind this request.
 const isMeta = (item: TransactItem) => item.ConditionCheck?.Key?.pk === metaKey.pk && item.ConditionCheck.Key.sk === metaKey.sk;
 if (plan.items.filter(isMeta).length !== 1 || plan.items.some(item => item.Update?.Key?.pk === metaKey.pk && item.Update.Key.sk === metaKey.sk)) throw unavailable();
 const items: TransactItem[] = [...plan.items.filter(item => !isMeta(item)), immutableRecordFence(deps.tableName, metaKey, meta, []), immutableRecordFence(deps.tableName, baseKey, registered),
  { Put: { TableName: deps.tableName, Item: { ...registered, ...projectRevisionKey(input.orgId, input.project, next), registeredBy: input.by, registeredAt: new Date(deps.now()).toISOString(), definition: nextDefinition }, ConditionExpression: "attribute_not_exists(pk)" } },
  { Update: { TableName: deps.tableName, Key: catalogKey, UpdateExpression: "SET latestRevision = :next", ConditionExpression: "latestRevision = :base", ExpressionAttributeValues: { ":next": next, ":base": body.expectedRevision } } }];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This website save cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) {
  await readAllowedDomainActorConditions(deps, { orgId: input.orgId, project: input.project, actorId: input.by });const recovered = await recover();if (recovered !== undefined) return recovered;
  if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable();
 }
 await flushAuditEvents(deps, [plan.event]);const receipt = await recover();if (receipt === undefined) throw unavailable();return receipt;
}
