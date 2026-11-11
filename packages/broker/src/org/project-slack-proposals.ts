import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, SlackTeamIdSchema, SlackChannelIdSchema, SlackChannelBindingSchema, agentXError, canonicalJson, projectMetaKey, projectPk, slackBindingKey, type OrgId } from "@rovara-code/contracts";
import { orgSlackTeamKey, slackTeamOrgKey } from "@agentx/cloud-contracts";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditOccurrence, auditSlackChannelProposed, auditSlackChannelDecision } from "../audit/events.js";
import { bindProjectChannel, type ProjectSlackChannelDependencies } from "./slack-binding.js";
import { readRequestRecord, requireSameRequest } from "./request-records.js";
import { readProjectSlackTarget, requireProjectSlackAuthority, readProjectSlackBindApproval } from "./project-slack-browser.js";
import type { SecondPersonEvidenceDependencies } from "./second-person-evidence.js";
interface Dependencies extends SecondPersonEvidenceDependencies { audit?: AuditRuntime; orgs: ProjectSlackChannelDependencies["orgs"] }
type Scope = { orgId: OrgId; project: string; by: string };
type Row = Record<string, unknown>;
const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/);
const bodySchema = z.object({ requestId: uuid, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, expectedContextDigest: sha }).strict();
const proposalSchema = z.object({ entityType: z.literal("SLACK_BINDING_PROPOSAL"), orgId: z.string(), project: AgentXNameSchema, proposalId: uuid,
 by: z.string().regex(/^[a-f0-9]{64}$/), bodyHash: sha, teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, contextDigest: sha,
 state: z.enum(["pending", "applied", "cancelled", "rejected"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), indexExpiresAt: z.number().int().positive(),
}).passthrough();
export type SlackBindingProposal = z.infer<typeof proposalSchema>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const keyOf = (orgId: OrgId, project: string, id: string) => ({ pk: projectPk(orgId, project), sk: `SLACK_BINDING_PROPOSAL#${id}` });
const liveKeyOf = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "SLACK_BINDING_PROPOSAL_LIVE" });
const stale = () => agentXError("CHANGE_STALE", "Review the current Slack proposal before sending.");
const missing = () => agentXError("NOT_FOUND", "Slack proposal information was not found.");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Slack proposal information could not be verified.");
async function read(deps: SecondPersonEvidenceDependencies, key: { pk: string; sk: string }): Promise<Row | undefined> {
 const row = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Row }).Item;
 if (row !== undefined && Buffer.byteLength(JSON.stringify(row), "utf8") > 32768) throw unavailable();return row;
}
function checkedProposal(raw: Row, input: { orgId: OrgId; project: string; proposalId: string }): SlackBindingProposal {
 const parsed = proposalSchema.safeParse(raw);
 if (!parsed.success || parsed.data.orgId !== input.orgId || parsed.data.project !== input.project || parsed.data.proposalId !== input.proposalId) throw unavailable();
 const row = parsed.data;
 if (Date.parse(row.expiresAt) !== Date.parse(row.createdAt) + 86400000 || row.indexExpiresAt !== Math.floor(Date.parse(row.expiresAt) / 1000) + 30 * 86400
  || row.bodyHash !== digest({ orgId: row.orgId, project: row.project, by: row.by, body: { requestId: row.proposalId, teamId: row.teamId, channelId: row.channelId, expectedContextDigest: row.contextDigest } })) throw unavailable();
 return row;
}
function snapshot(deps: SecondPersonEvidenceDependencies, key: { pk: string; sk: string }, row: Row, fields: readonly string[]): TransactItem {
 const names: Record<string, string> = {}, values: Row = {}, clauses = ["attribute_exists(pk)"];
 for (const [i, field] of fields.entries()) { const name = `#p${String(i)}`, value = `:p${String(i)}`;names[name] = field;if (row[field] === undefined) clauses.push(`attribute_not_exists(${name})`);else { clauses.push(`${name} = ${value}`);values[value] = row[field]; } }
 return { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
}
function requireAudit(deps: Dependencies) {
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
}
/** Read-only company owner/admin view, including terminal/expired history. */
export async function readProjectSlackProposal(deps: Dependencies, input: Scope & { proposalId: string }): Promise<SlackBindingProposal> {
 await requireProjectSlackAuthority(deps, input);if (!uuid.safeParse(input.proposalId).success) throw missing();
 const row = await read(deps, keyOf(input.orgId, input.project, input.proposalId));if (row === undefined) throw missing();return checkedProposal(row, input);
}
/** Creation pins the unlinked target and project identity, but never binds it. */
export async function proposeProjectSlackBinding(deps: Dependencies, input: Scope & { body: unknown }): Promise<SlackBindingProposal> {
 const authority = await requireProjectSlackAuthority(deps, input), parsed = bodySchema.safeParse(input.body);
 if (!parsed.success) throw agentXError("CONFIG_INVALID", "Review valid Slack IDs and a fresh request id.");
 const body = parsed.data, key = keyOf(input.orgId, input.project, body.requestId), bodyHash = digest({ orgId: input.orgId, project: input.project, by: input.by, body });
 const owned = async () => { const row = await read(deps, key);if (row === undefined) return undefined;if (row.by !== input.by || row.bodyHash !== bodyHash) throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different Slack proposal.");return checkedProposal(row, { ...input, proposalId: body.requestId }); };
 const previous = await owned();if (previous !== undefined) return previous;
 requireAudit(deps);
 const target = await readProjectSlackTarget(deps, { ...input, teamId: body.teamId, channelId: body.channelId });
 if (authority.project.status !== "active" || target.projectStatus !== "active" || target.state !== "unlinked" || target.contextDigest !== body.expectedContextDigest) throw stale();
 const now = deps.now(), expiresAt = new Date(now + 86400000).toISOString(), liveKey = liveKeyOf(input.orgId, input.project), pointer = await read(deps, liveKey);
 if (pointer !== undefined && (pointer.entityType !== "SLACK_BINDING_PROPOSAL_LIVE" || pointer.orgId !== input.orgId || pointer.project !== input.project || !uuid.safeParse(pointer.proposalId).success || !z.string().datetime().safeParse(pointer.expiresAt).success)) throw unavailable();
 if (pointer !== undefined && Date.parse(String(pointer.expiresAt)) > now) throw stale();
 const proposal = proposalSchema.parse({ ...key, entityType: "SLACK_BINDING_PROPOSAL", orgId: input.orgId, project: input.project, proposalId: body.requestId, by: input.by, bodyHash,
  teamId: body.teamId, channelId: body.channelId, contextDigest: body.expectedContextDigest, state: "pending", createdAt: new Date(now).toISOString(), expiresAt, indexExpiresAt: Math.floor(now / 1000) + 31 * 86400 });
 const event = auditSlackChannelProposed({ orgId: input.orgId, actor: { kind: "member", id: input.by }, projectName: input.project, teamId: body.teamId, channelId: body.channelId,
  requestId: body.requestId, occurredAt: proposal.createdAt, occurrence: auditOccurrence(input.project, body.requestId, "proposed") });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
 const items: TransactItem[] = [...authority.conditions,
  snapshot(deps, projectMetaKey(input.orgId, input.project), authority.project, ["name", "status", "archiveRevision", "createdAt", "createdBy"]),
  { ConditionCheck: { TableName: deps.tableName, Key: slackTeamOrgKey(body.teamId), ConditionExpression: "orgId = :org", ExpressionAttributeValues: { ":org": input.orgId } } },
  { ConditionCheck: { TableName: deps.tableName, Key: orgSlackTeamKey(input.orgId, body.teamId), ConditionExpression: "attribute_exists(pk)" } },
  { ConditionCheck: { TableName: deps.tableName, Key: slackBindingKey(input.orgId, body.teamId, body.channelId), ConditionExpression: "attribute_not_exists(pk)" } },
  { Put: { TableName: deps.tableName, Item: proposal, ConditionExpression: "attribute_not_exists(pk)" } },
  { Put: { TableName: deps.tableName, Item: { ...liveKey, entityType: "SLACK_BINDING_PROPOSAL_LIVE", orgId: input.orgId, project: input.project, proposalId: body.requestId, expiresAt, indexExpiresAt: proposal.indexExpiresAt },
   ConditionExpression: pointer === undefined ? "attribute_not_exists(pk)" : "proposalId = :old AND expiresAt = :expires",
   ...(pointer === undefined ? {} : { ExpressionAttributeValues: { ":old": pointer.proposalId, ":expires": pointer.expiresAt } }) } }, ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This Slack proposal cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) { await requireProjectSlackAuthority(deps, input);const recovered = await owned();if (recovered !== undefined) return recovered;if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable(); }
 await flushAuditEvents(deps, [event]);return proposal;
}
/** Applies exactly the stored target through the canonical binding writer. */
export async function approveProjectSlackBinding(deps: Dependencies, input: Scope & { proposalId: string; requestId: string }) {
 await requireProjectSlackAuthority(deps, input);if (!uuid.safeParse(input.requestId).success || !uuid.safeParse(input.proposalId).success) throw missing();
 const proposal = await readProjectSlackProposal(deps, input), now = deps.now();
 const expected = { by: input.by, action: "bind", bodyHash: createHash("sha256").update(JSON.stringify([proposal.teamId, proposal.channelId, proposal.proposalId])).digest("hex") };
 const receipt = await readRequestRecord(deps.documentClient, deps.tableName, { pk: projectPk(input.orgId, input.project), sk: `SLACK_BINDING_REQUEST#${input.requestId}` }, now);
 if (receipt !== undefined) {
  requireSameRequest(receipt, expected);
  const response = z.object({ binding: SlackChannelBindingSchema, changed: z.literal(true) }).strict().safeParse(receipt.response);
  if (!response.success || response.data.binding.teamId !== proposal.teamId || response.data.binding.channelId !== proposal.channelId || response.data.binding.projectName !== input.project) throw unavailable();return response.data;
 }
 requireAudit(deps);
 if (proposal.state !== "pending" || Date.parse(proposal.expiresAt) <= now || Date.parse(proposal.createdAt) > now) throw stale();
 const proof = await readProjectSlackBindApproval(deps, { ...input, proposerId: proposal.by, approverId: input.by, teamId: proposal.teamId, channelId: proposal.channelId });
 if (proof.contextDigest !== proposal.contextDigest) throw stale();
 const liveKey = liveKeyOf(input.orgId, input.project);
 return bindProjectChannel({ ...deps, now: () => new Date(deps.now()) }, input.orgId, input.project,
  { requestId: input.requestId, teamId: proposal.teamId, channelId: proposal.channelId, actor: { developerId: input.by } }, {
   teamId: proposal.teamId, proposalId: proposal.proposalId, proposerId: proposal.by, expiresAt: proposal.expiresAt, mode: proof.decision.mode, conditions: proof.conditions,
   transitions: [
    { Put: { TableName: deps.tableName, Item: { ...proposal, state: "applied", decidedAt: new Date(now).toISOString(), decidedBy: input.by, mode: proof.decision.mode },
     ConditionExpression: "#state = :pending AND bodyHash = :hash AND expiresAt = :expires AND expiresAt > :now",
     ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":pending": "pending", ":hash": proposal.bodyHash, ":expires": proposal.expiresAt, ":now": new Date(now).toISOString() } } },
    { Delete: { TableName: deps.tableName, Key: liveKey, ConditionExpression: "proposalId = :id AND orgId = :org AND #project = :project AND expiresAt = :expires", ExpressionAttributeNames: { "#project": "project" },
     ExpressionAttributeValues: { ":id": proposal.proposalId, ":org": input.orgId, ":project": input.project, ":expires": proposal.expiresAt } } },
   ],
   revalidate: async () => { await requireProjectSlackAuthority(deps, input);const team = await read(deps, slackTeamOrgKey(proposal.teamId));if (team?.orgId !== input.orgId) throw stale(); },
  });
}
/** Only the single scoped pointer is read; no cross-project proposal scan. */
export async function readLiveProjectSlackProposal(deps: Dependencies, input: Scope): Promise<SlackBindingProposal | null> {
 await requireProjectSlackAuthority(deps, input);const pointer = await read(deps, liveKeyOf(input.orgId, input.project));if (pointer === undefined) return null;
 if (pointer.entityType !== "SLACK_BINDING_PROPOSAL_LIVE" || pointer.orgId !== input.orgId || pointer.project !== input.project || !uuid.safeParse(pointer.proposalId).success || !z.string().datetime().safeParse(pointer.expiresAt).success) throw unavailable();
 const proposal = await readProjectSlackProposal(deps, { ...input, proposalId: String(pointer.proposalId) });
 if (proposal.expiresAt !== pointer.expiresAt || proposal.state !== "pending") throw unavailable();return proposal;
}


const decisionBodySchema = z.object({ requestId: uuid, proposalId: uuid, decision: z.enum(["cancel", "reject"]) }).strict();
const decisionReceiptSchema = z.object({ entityType: z.literal("SLACK_BINDING_PROPOSAL"), kind: z.literal("decision_receipt"), orgId: z.string(), project: AgentXNameSchema,
 by: z.string(), requestId: uuid, proposalId: uuid, bodyHash: sha, state: z.enum(["cancelled", "rejected"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), indexExpiresAt: z.number().int().positive() }).passthrough();
/** One live actor, one conditional pending transition, pointer removal, receipt and audit. */
export async function decideProjectSlackProposal(deps: Dependencies, input: Scope & { body: unknown }) {
 const authority = await requireProjectSlackAuthority(deps, input), parsed = decisionBodySchema.safeParse(input.body);
 if (!parsed.success || parsed.data.requestId === parsed.data.proposalId) throw agentXError("CONFIG_INVALID", "Review a valid Slack decision with a fresh request id.");
 const body = parsed.data, receiptKey = keyOf(input.orgId, input.project, body.requestId), bodyHash = digest({ orgId: input.orgId, project: input.project, by: input.by, body });
 const state = body.decision === "cancel" ? "cancelled" as const : "rejected" as const;
 const recover = async () => {
  const row = await read(deps, receiptKey);if (row === undefined) return undefined;
  if (row.orgId !== input.orgId || row.project !== input.project || row.by !== input.by || row.bodyHash !== bodyHash || row.kind !== "decision_receipt") throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different Slack decision.");
  const result = decisionReceiptSchema.safeParse(row);if (!result.success || result.data.requestId !== body.requestId || result.data.proposalId !== body.proposalId || result.data.state !== state) throw unavailable();
  if (Date.parse(result.data.expiresAt) <= deps.now()) throw stale();return result.data;
 };
 const prior = await recover();if (prior !== undefined) return prior;
 requireAudit(deps);const proposal = await readProjectSlackProposal(deps, { ...input, proposalId: body.proposalId });
 if (body.decision === "reject" && input.by === proposal.by) throw agentXError("FORBIDDEN", "Another live company owner or admin must reject this Slack proposal.");
 const now = deps.now(), at = new Date(now).toISOString();
 if (proposal.state !== "pending" || Date.parse(proposal.expiresAt) <= now || Date.parse(proposal.createdAt) > now) throw stale();
 const receipt = decisionReceiptSchema.parse({ ...receiptKey, entityType: "SLACK_BINDING_PROPOSAL", kind: "decision_receipt", orgId: input.orgId, project: input.project, by: input.by,
  requestId: body.requestId, proposalId: proposal.proposalId, bodyHash, state, createdAt: at, expiresAt: proposal.expiresAt, indexExpiresAt: proposal.indexExpiresAt });
 const event = auditSlackChannelDecision({ orgId: input.orgId, actor: { kind: "member", id: input.by }, projectName: input.project, teamId: proposal.teamId, channelId: proposal.channelId,
  requestId: body.requestId, proposalId: proposal.proposalId, state, occurredAt: at, occurrence: auditOccurrence(input.project, body.requestId, state), related: [proposal.by] });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
 const items: TransactItem[] = [...authority.conditions,
  snapshot(deps, projectMetaKey(input.orgId, input.project), authority.project, ["name", "status", "archiveRevision", "createdAt", "createdBy"]),
  { Put: { TableName: deps.tableName, Item: { ...proposal, state, decidedAt: at, decidedBy: input.by, decisionRequestId: body.requestId },
   ConditionExpression: "#state = :pending AND bodyHash = :hash AND expiresAt = :expires AND expiresAt > :now",
   ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":pending": "pending", ":hash": proposal.bodyHash, ":expires": proposal.expiresAt, ":now": at } } },
  { Delete: { TableName: deps.tableName, Key: liveKeyOf(input.orgId, input.project), ConditionExpression: "proposalId = :id AND orgId = :org AND #project = :project AND expiresAt = :expires",
   ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":id": proposal.proposalId, ":org": input.orgId, ":project": input.project, ":expires": proposal.expiresAt } } },
  { Put: { TableName: deps.tableName, Item: receipt, ConditionExpression: "attribute_not_exists(pk)" } }, ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This Slack decision cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) { await requireProjectSlackAuthority(deps, input);const recovered = await recover();if (recovered !== undefined) return recovered;if (error instanceof Error && error.name === "TransactionCanceledException") throw stale();throw unavailable(); }
 await flushAuditEvents(deps, [event]);return receipt;
}

/** Scoped actor-owned decision readback; TTL cleanup never extends receipt authority. */
export async function readProjectSlackDecision(deps: Dependencies, input: Scope & { requestId: string }) {
 await requireProjectSlackAuthority(deps, input);if (!uuid.safeParse(input.requestId).success) throw missing();
 const raw = await read(deps, keyOf(input.orgId, input.project, input.requestId));
 if (raw === undefined || raw.by !== input.by || raw.orgId !== input.orgId || raw.project !== input.project || raw.kind !== "decision_receipt") throw missing();
 const row = decisionReceiptSchema.safeParse(raw);if (!row.success || row.data.requestId !== input.requestId) throw unavailable();
 if (Date.parse(row.data.expiresAt) <= deps.now()) throw missing();return row.data;
}
