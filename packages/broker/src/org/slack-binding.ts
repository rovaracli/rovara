// Release 0.4.17: a Slack channel bound to a project. The binding item and its reader are the ones the operator's `admin slack bind` uses
// (broker.ts `putSlackBinding`); this module adds the org owner's or admin's own bind and unbind (`PUT|DELETE /v1/app/projects/{name}/slack-channel`),
// which the route has already authorized. A bind or unbind, its request record and its audit item are ONE transaction (the one request-id pattern,
// `request-records`), so a replay of the request id applies nothing and a change is never made without its record.
//
// The Slack team must be one the org already has (its own bound teams) or the installation's own team; binding the installation's team to the org is
// refused (SLACK_TEAM_TAKEN) when another org holds it. A channel is bound to one project: binding one that belongs to another project is refused,
// and the owner unbinds it there first. Everything is keyed by the `orgId` it is given.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SLACK_BINDING_SK_PREFIX, SlackChannelBindingSchema, agentXError, orgPk, projectPk, slackBindingKey, slackBindingPk, type OrgId, type OrgKey, type SlackChannelBinding } from "@rovara-code/contracts";
import { type AuditEventInput } from "@agentx/cloud-contracts";
import { auditOccurrence, auditSlackChannelBound, auditSlackChannelUnbound } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvent, type AuditRuntime } from "../audit/outbox.js";
import { readRequestRecord, requestRecordPut, requireSameRequest, type RequestTransactItem } from "./request-records.js";
import type { OrgStore } from "./store.js";

type Send = { send(command: unknown): Promise<unknown> };

/** The item a binding is stored as. The operator's bind and the owner's bind write this one shape. */
export function slackBindingItem(orgId: OrgId, binding: SlackChannelBinding, updatedBy: string): Record<string, unknown> {
  return { ...slackBindingKey(orgId, binding.teamId, binding.channelId), entityType: "SLACK_BINDING", ...binding, updatedBy };
}

/** A channel's binding inside one org; another org's binding for the same team and channel is never read. Bindings written before channels followed the latest revision also carry projectRevision, which is ignored. */
export async function readSlackBinding(deps: { documentClient: Send; tableName: string }, orgId: OrgId, teamId: string, channelId: string): Promise<SlackChannelBinding | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: slackBindingKey(orgId, teamId, channelId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (!item) return undefined;
  return SlackChannelBindingSchema.parse({ teamId: item.teamId, channelId: item.channelId, projectName: item.projectName, updatedAt: item.updatedAt });
}

/** The channels an org has bound in one Slack workspace, across its projects (their ids only). */
export async function listTeamChannels(deps: { documentClient: Send; tableName: string }, orgId: OrgId, teamId: string): Promise<string[]> {
  const channels: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": slackBindingPk(orgId, teamId), ":prefix": SLACK_BINDING_SK_PREFIX },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ channelId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) if (typeof item.channelId === "string") channels.push(item.channelId);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return channels;
}

export interface ProjectSlackChannelDependencies {
  documentClient: Send;
  tableName: string;
  now: () => Date;
  /** The Audit Ledger's outbox: a change is recorded in the transaction that makes it. Absent on a legacy install. */
  audit?: AuditRuntime;
  orgs: Pick<OrgStore, "bindSlackTeam">;
  /** The installation's own Slack team, which an org may take as its own while no other org holds it. Absent on a Rovara Cloud install (its orgs connect their own) or one with no Slack team. */
  installSlackTeamId?: string;
}

export interface ProjectSlackChannelActor { developerId: string }

/** The Slack teams the org already has, from the reverse items `bindSlackTeam` writes in the org's own partition. */
async function orgSlackTeams(deps: ProjectSlackChannelDependencies, orgId: OrgId): Promise<string[]> {
  const teams: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "SLACK_TEAM#" },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) if (typeof item.sk === "string") teams.push(item.sk.slice("SLACK_TEAM#".length));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return teams;
}

/** What an owner tells the Rovara operator, who alone connects a Slack workspace to an org on a cloud install. */
const connectHint = (orgId: OrgId, teamId: string) => `Ask a Rovara operator to connect it: rovara admin slack connect-team --org ${orgId} --team ${teamId}`;

/**
 * The Slack team a call is about: the one named, which must be the org's or the installation's, or the only one there is. Anything else is
 * SLACK_TEAM_NOT_BOUND (a team of another org, or of no one the org can reach) and nothing is written.
 */
export async function resolveBindTeam(deps: ProjectSlackChannelDependencies, orgId: OrgId, requested: string | undefined): Promise<string> {
  const allowed = new Set(await orgSlackTeams(deps, orgId));
  if (deps.installSlackTeamId !== undefined) allowed.add(deps.installSlackTeamId);
  if (requested !== undefined) {
    if (!allowed.has(requested)) throw agentXError("SLACK_TEAM_NOT_BOUND", `that Slack workspace is not connected to your organization. ${connectHint(orgId, requested)}`);
    return requested;
  }
  const [only, ...others] = [...allowed];
  if (only === undefined) throw agentXError("SLACK_TEAM_NOT_BOUND", `Slack is not connected to your organization yet. ${connectHint(orgId, "<Slack workspace ID>")}`);
  if (others.length > 0) throw agentXError("CONFIG_INVALID", "your organization has more than one Slack workspace; name the one with teamId");
  return only;
}

const requestKey = (orgId: OrgId, project: string, requestId: string): OrgKey => ({ pk: projectPk(orgId, project), sk: `SLACK_BINDING_REQUEST#${requestId}` });
const bodyHashOf = (teamId: string, channelId: string) => createHash("sha256").update(`${teamId}\n${channelId}`, "utf8").digest("hex");
const ATTEMPTS = 3;
const STALE = () => agentXError("CHANGE_STALE", "that channel was changed by someone else at the same time; try again");
const takenBy = (project: string) => agentXError("CONFIG_INVALID", `that channel is bound to the project ${project}; unbind it there first`);

/** Commits the change with its request record and audit item. False when the transaction was cancelled (read again: the same request id may have got in first). */
async function commit(deps: ProjectSlackChannelDependencies, items: RequestTransactItem[], event?: AuditEventInput): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...(event === undefined ? [] : auditPending(deps, event))] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
  if (event !== undefined) await flushAuditEvents(deps, [event]);
  return true;
}

/** Server-only atomic approval context. Never derived from public JSON. */
export interface ReviewedSlackBind {
 teamId: string; proposalId: string; proposerId: string; expiresAt: string;
 mode: "second_person" | "sole_owner_exception";
 conditions: RequestTransactItem[]; transitions: RequestTransactItem[];
 revalidate(): Promise<void>;
}
async function bindReviewed(deps: ProjectSlackChannelDependencies, orgId: OrgId, project: string,
 input: { requestId: string; channelId: string; teamId?: string | undefined; actor: ProjectSlackChannelActor }, reviewed: ReviewedSlackBind) {
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
 if (input.teamId !== reviewed.teamId) throw STALE();
 const expected = { by: input.actor.developerId, action: "bind", bodyHash: createHash("sha256").update(JSON.stringify([reviewed.teamId, input.channelId, reviewed.proposalId])).digest("hex") };
 const key = requestKey(orgId, project, input.requestId);
 const replay = async () => { const row = await readRequestRecord(deps.documentClient, deps.tableName, key, deps.now().getTime());if (row === undefined) return undefined;requireSameRequest(row, expected);return row.response as { binding: SlackChannelBinding; changed: boolean }; };
 await reviewed.revalidate();const previous = await replay();if (previous !== undefined) return previous;
 const at = deps.now();if (!Number.isFinite(Date.parse(reviewed.expiresAt)) || at.getTime() >= Date.parse(reviewed.expiresAt)) throw STALE();
 const binding = SlackChannelBindingSchema.parse({ teamId: reviewed.teamId, channelId: input.channelId, projectName: project, updatedAt: at.toISOString() }), response = { binding, changed: true };
 const event = auditSlackChannelBound({ orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: at.toISOString(),
  occurrence: auditOccurrence(input.requestId, project, reviewed.teamId, input.channelId), projectName: project, teamId: reviewed.teamId, channelId: input.channelId,
  mode: reviewed.mode, proposalId: reviewed.proposalId, related: [reviewed.proposerId, input.actor.developerId],
 });
 const pending = auditPending(deps, event);if (pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
 const items: RequestTransactItem[] = [...reviewed.conditions,
  { Put: { TableName: deps.tableName, Item: slackBindingItem(orgId, binding, input.actor.developerId), ConditionExpression: "attribute_not_exists(pk)" } },
  ...reviewed.transitions, requestRecordPut(deps.tableName, key, "SLACK_BINDING_REQUEST", { ...expected, response }, at.getTime()), ...pending];
 if (items.length > 100) throw agentXError("CONFIG_INVALID", "This Slack approval cannot fit one transaction.");
 try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
 catch (error) { await reviewed.revalidate();const recovered = await replay();if (recovered !== undefined) return recovered;if (error instanceof Error && error.name === "TransactionCanceledException") throw STALE();throw agentXError("RUNTIME_UNAVAILABLE", "Check the Slack request status before sending again."); }
 await flushAuditEvents(deps, [event]);return response;
}

/** `PUT /v1/app/projects/{name}/slack-channel`, after the route's checks of the caller's role and the body. */
export async function bindProjectChannel(
  deps: ProjectSlackChannelDependencies,
  orgId: OrgId,
  project: string,
  input: { requestId: string; channelId: string; teamId?: string | undefined; actor: ProjectSlackChannelActor },
  reviewed?: ReviewedSlackBind,
): Promise<{ binding: SlackChannelBinding; changed: boolean }> {
  if (reviewed !== undefined) return bindReviewed(deps, orgId, project, input, reviewed);
  const teamId = await resolveBindTeam(deps, orgId, input.teamId);
  const expected = { by: input.actor.developerId, action: "bind", bodyHash: bodyHashOf(teamId, input.channelId) };
  const key = requestKey(orgId, project, input.requestId);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const nowMs = deps.now().getTime();
    const stored = await readRequestRecord(deps.documentClient, deps.tableName, key, nowMs);
    if (stored !== undefined) {
      requireSameRequest(stored, expected);
      return stored.response as { binding: SlackChannelBinding; changed: boolean };
    }
    const existing = await readSlackBinding(deps, orgId, teamId, input.channelId);
    if (existing !== undefined && existing.projectName !== project) throw takenBy(existing.projectName);
    const changed = existing === undefined;
    const binding = existing ?? SlackChannelBindingSchema.parse({ teamId, channelId: input.channelId, projectName: project, updatedAt: new Date(nowMs).toISOString() });
    const response = { binding, changed };
    // The team joins the org first (idempotent); a team another org already holds is refused here (SLACK_TEAM_TAKEN).
    if (changed) await deps.orgs.bindSlackTeam({ orgId, teamId });
    const write: RequestTransactItem[] = changed
      ? [{ Put: { TableName: deps.tableName, Item: slackBindingItem(orgId, binding, input.actor.developerId), ConditionExpression: "attribute_not_exists(pk)" } }]
      : [];
    const event = changed ? await tryAuditEvent(deps, () => auditSlackChannelBound({
      orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: new Date(nowMs).toISOString(),
      occurrence: auditOccurrence(input.requestId, project, teamId, input.channelId), projectName: project, teamId, channelId: input.channelId,
    })) : undefined;
    if (await commit(deps, [...write, requestRecordPut(deps.tableName, key, "SLACK_BINDING_REQUEST", { ...expected, response }, nowMs)], event)) return response;
  }
  throw STALE();
}

/** Server-only reviewed context; never parsed from a public request body. */
export interface ReviewedSlackUnbind {
  teamId: string;
  observed?: SlackChannelBinding;
  conditions: RequestTransactItem[];
  revalidate(): Promise<void>;
}
async function unbindReviewed(deps: ProjectSlackChannelDependencies, orgId: OrgId, project: string,
 input: { requestId: string; channelId: string; teamId?: string | undefined; actor: ProjectSlackChannelActor }, reviewed: ReviewedSlackUnbind): Promise<{ teamId: string; channelId: string; removed: boolean }> {
  if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
  const teamId = reviewed.teamId;
  if (input.teamId !== teamId || (reviewed.observed !== undefined && (reviewed.observed.projectName !== project || reviewed.observed.teamId !== teamId || reviewed.observed.channelId !== input.channelId))) throw STALE();
  const key = requestKey(orgId, project, input.requestId), expected = { by: input.actor.developerId, action: "unbind", bodyHash: bodyHashOf(teamId, input.channelId) };
  const replay = async () => { const stored = await readRequestRecord(deps.documentClient, deps.tableName, key, deps.now().getTime());if (stored === undefined) return undefined;requireSameRequest(stored, expected);return stored.response as { teamId: string; channelId: string; removed: boolean }; };
  await reviewed.revalidate();const previous = await replay();if (previous !== undefined) return previous;
  const at = deps.now(), response = { teamId, channelId: input.channelId, removed: reviewed.observed !== undefined };
  const bindingKey = slackBindingKey(orgId, teamId, input.channelId);
  const mutation: RequestTransactItem = reviewed.observed === undefined
    ? { ConditionCheck: { TableName: deps.tableName, Key: bindingKey, ConditionExpression: "attribute_not_exists(pk)" } }
    : { Delete: { TableName: deps.tableName, Key: bindingKey, ConditionExpression: "projectName = :project AND updatedAt = :at AND teamId = :team AND channelId = :channel",
      ExpressionAttributeValues: { ":project": project, ":at": reviewed.observed.updatedAt, ":team": teamId, ":channel": input.channelId } } };
  const event = reviewed.observed === undefined ? undefined : auditSlackChannelUnbound({ orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: at.toISOString(),
    occurrence: auditOccurrence(input.requestId, project, teamId, input.channelId), projectName: project, teamId, channelId: input.channelId });
  const pending = event === undefined ? [] : auditPending(deps, event);if (event !== undefined && pending.length !== 1) throw agentXError("AUDIT_UNAVAILABLE", "Slack changes require the audit ledger.");
  const items = [...reviewed.conditions, mutation, requestRecordPut(deps.tableName, key, "SLACK_BINDING_REQUEST", { ...expected, response }, at.getTime()), ...pending];
  if (items.length > 100) throw agentXError("CONFIG_INVALID", "This Slack change cannot fit one transaction.");
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) { await reviewed.revalidate();const recovered = await replay();if (recovered !== undefined) return recovered;if (error instanceof Error && error.name === "TransactionCanceledException") throw STALE();throw error; }
  if (event !== undefined) await flushAuditEvents(deps, [event]);return response;
}

/** `DELETE /v1/app/projects/{name}/slack-channel`, after the route's checks. `removed` is false for a channel that was not bound (the request is still recorded). */
export async function unbindProjectChannel(
  deps: ProjectSlackChannelDependencies,
  orgId: OrgId,
  project: string,
  input: { requestId: string; channelId: string; teamId?: string | undefined; actor: ProjectSlackChannelActor },
  reviewed?: ReviewedSlackUnbind,
): Promise<{ teamId: string; channelId: string; removed: boolean }> {
  if (reviewed !== undefined) return unbindReviewed(deps, orgId, project, input, reviewed);
  const teamId = await resolveBindTeam(deps, orgId, input.teamId);
  const expected = { by: input.actor.developerId, action: "unbind", bodyHash: bodyHashOf(teamId, input.channelId) };
  const key = requestKey(orgId, project, input.requestId);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const nowMs = deps.now().getTime();
    const stored = await readRequestRecord(deps.documentClient, deps.tableName, key, nowMs);
    if (stored !== undefined) {
      requireSameRequest(stored, expected);
      return stored.response as { teamId: string; channelId: string; removed: boolean };
    }
    const existing = await readSlackBinding(deps, orgId, teamId, input.channelId);
    if (existing !== undefined && existing.projectName !== project) throw takenBy(existing.projectName);
    const response = { teamId, channelId: input.channelId, removed: existing !== undefined };
    const remove: RequestTransactItem[] = existing === undefined ? [] : [{ Delete: {
      TableName: deps.tableName, Key: slackBindingKey(orgId, teamId, input.channelId),
      ConditionExpression: "attribute_exists(pk) AND projectName = :project", ExpressionAttributeValues: { ":project": project },
    } }];
    const event = existing === undefined ? undefined : await tryAuditEvent(deps, () => auditSlackChannelUnbound({
      orgId, actor: { kind: "member", id: input.actor.developerId }, occurredAt: new Date(nowMs).toISOString(),
      occurrence: auditOccurrence(input.requestId, project, teamId, input.channelId), projectName: project, teamId, channelId: input.channelId,
    }));
    if (await commit(deps, [...remove, requestRecordPut(deps.tableName, key, "SLACK_BINDING_REQUEST", { ...expected, response }, nowMs)], event)) return response;
  }
  throw STALE();
}
