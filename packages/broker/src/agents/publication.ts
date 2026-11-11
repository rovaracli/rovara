// Agent publish requests (experience decision 24, owner decisions 91 and 92): asking to publish an agent to a project or to the whole company, on the existing approvals
// framework. A request is ONE change record of the subject kind `agent_publication` (approvals-store.ts), bound to the agent, its published version and that version's
// recipe digest, its owner, its share set's revision and the target. It is decided on the existing confirmation page (`/v1/app/approvals/{id}/decide`, browser only, with a
// fresh sign-in), by the rules registered here:
//   - a project request: a maintainer of that project (`manage_agents`) or an org owner or admin, never the person who asked. Approving it MOVES the agent to the project
//     with the approver accountable (as `PUT owner` does: the same cap, the same store write and its fences), and the author keeps an `edit` share;
//   - a company request: an org owner or admin only (an admin may approve their own request: the page's fresh sign-in is the confirmation). Approving it adds a company-wide
//     share at `use` through `saveShares` (`tests/contract/share-writers-gated.test.ts` lists this file).
// The handler re-checks everything at apply time: the binding, the guardrails, the project, the decider's live role, and decision 92 (a company-shared agent's owner moves
// only by an org owner or admin). The routes are in publication-routes.ts; this file holds the rules, the handler, the indexes and the views.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentPublicationKey,
  agentPublicationsIndexKey,
  agentXError,
  canonicalJson,
  orgProjectCatalogKey,
  projectAllows,
  projectArchivedMessage,
  type AgentId,
  type AgentPublication,
  type AgentPublishRequest,
  type AgentSummary,
  type AuditEventInput,
  type OrgId,
  type PublishTarget,
  type ResolvedRecipe,
} from "@agentx/contracts";
import { auditAgentPublication } from "../audit/events.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { safeDisplayName } from "../developer/person-name.js";
import { orgRoleOf, requireAccountable, resolveSurvivor, saveShares, validSharesOf, type AgentCaller, type AgentShare } from "./access.js";
import {
  confirmUrlFor,
  getApproval,
  mayDecideApproval,
  registerApprovalSubjectHandler,
  registerApproverRefusal,
  registerApproverRule,
  registerDecisionAuditEvents,
  shownText,
  type AgentPublicationSubject,
  type AnyApprovalRecord,
  type ApprovalDependencies,
  type ApprovalRecord,
  type ApproverSpec,
  type TransactItem,
} from "./approvals-store.js";
import { agentHasCompanyShare, orgAdmins, orgOwnerOrAdmin, requireWithinGuardrails, resolveRecipe } from "./changes.js";
import { lessSafeChanges } from "./less-safe.js";
import { sameMember } from "./lifecycle.js";
import { ownerCapCheck } from "./owner-cap-check.js";
import type { SpendRequestDependencies } from "../spend/requests.js";
import type { AgentRecord } from "./store.js";

export const PUBLICATION_PROJECT_RULE = "agent_publication_project";
export const PUBLICATION_COMPANY_RULE = "agent_publication_company";
const NAME_MAX = 80;
const isOrgAdmin = (role: string | undefined): boolean => role === "owner" || role === "admin";
const stale = (message: string) => agentXError("AGENT_REVISION_CONFLICT", message);
const SHARE_RANK: Record<string, number> = { view: 0, use: 1, edit: 2 };

/** The key part a target is indexed under: `company` or `project:<name>` (a project name never holds a colon). */
export const targetKeyOf = (target: PublishTarget): string => (target.kind === "company" ? "company" : `project:${target.project}`);

export const isPublicationRecord = (record: AnyApprovalRecord | undefined): record is ApprovalRecord & { subject: AgentPublicationSubject } =>
  record !== undefined && record.kind === "change" && record.subject.kind === "agent_publication";

/** The agent's stored shares that are a valid principal and level (a corrupted row gives nothing and is reported). */
export function agentShares(deps: ApprovalDependencies, orgId: OrgId, agentId: AgentId): Promise<AgentShare[]> {
  return validSharesOf(deps, { orgId, agentId }, () => deps.store.listShares(orgId, agentId), "agent_share_skipped");
}

// ---- who may decide

/** Whether `caller` holds `manage_agents` on `project` now (read live; an org owner or admin is a maintainer of every project). */
export async function maintainsProject(deps: ApprovalDependencies, orgId: OrgId, project: string, developerId: string): Promise<boolean> {
  const survivor = await resolveSurvivor(deps, orgId, developerId);
  const orgRole = await orgRoleOf(deps, orgId, survivor);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(orgId, project, { developerId: survivor, orgRole });
  return role !== undefined && projectAllows(role, "manage_agents");
}

/** A project request: a maintainer of the target project or an org owner or admin, read live, and never the person who asked (D24, decision 91). */
async function mayDecideProjectRequest(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: AgentCaller): Promise<boolean> {
  if (!isPublicationRecord(record) || record.subject.target.kind !== "project" || caller.orgId !== record.orgId) return false;
  if (await sameMember(deps, record.orgId, record.requestedBy, caller.developerId)) return false;
  return maintainsProject(deps, record.orgId, record.subject.target.project, caller.developerId);
}

/** A company request: an org owner or admin, by the role they hold now (decision 91). An admin who asked may decide their own: the page's fresh sign-in is the check. */
async function mayDecideCompanyRequest(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: AgentCaller): Promise<boolean> {
  if (!isPublicationRecord(record) || record.subject.target.kind !== "company") return false;
  return orgOwnerOrAdmin(deps, record, caller);
}

/** Who is listed for a request (it decides only who sees it; the rule decides who may decide): the target's maintainers and the org's admins, never the person who asked a project request. */
export async function publicationApprovers(deps: ApprovalDependencies, orgId: OrgId, target: PublishTarget, requestedBy: string): Promise<ApproverSpec> {
  const admins = await orgAdmins(deps, orgId);
  if (target.kind === "company") return { kind: "rule", rule: PUBLICATION_COMPANY_RULE, candidates: admins };
  const candidates = new Set(admins);
  for (const member of await deps.projectMembers.list(orgId, target.project)) if (projectAllows(member.role, "manage_agents")) candidates.add(member.developerId);
  candidates.delete(requestedBy);
  return { kind: "rule", rule: PUBLICATION_PROJECT_RULE, candidates: [...candidates] };
}

// ---- what a request says

/** The fixed sentence of what approving does. */
export function effectOf(agentName: string, target: PublishTarget, authorName: string | undefined): string {
  const name = shownText(agentName, NAME_MAX);
  if (target.kind === "company") return `Shares ${name} with everyone in your company, who can then run it.`;
  return `Moves ${name} to the ${target.project} project.${authorName === undefined ? "" : ` ${authorName} keeps edit access.`}`;
}

const TRIGGER_KIND = { person: "manual", schedule: "schedule", event: "event" } as const;

/** What the approver is told the agent can do, from the resolved recipe of the version asked about. */
export function summaryOf(recipe: ResolvedRecipe, agent: Pick<AgentRecord, "monthlyBudgetUsd" | "maxPerRunUsd"> | undefined, extendsRef: { agentId: AgentId; version: number } | undefined): AgentSummary {
  const triggers = [...new Set(recipe.triggers.map((trigger) => TRIGGER_KIND[trigger.kind]))];
  return {
    steps: recipe.steps.length,
    tools: recipe.tools.map((tool) => ({ connector: "type" in tool.connector ? tool.connector.type : tool.connector.name, access: tool.access })),
    autonomy: recipe.autonomy, triggers, skills: recipe.skills.length,
    ...(agent?.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: agent.monthlyBudgetUsd }),
    ...(agent?.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: agent.maxPerRunUsd }),
    ...(extendsRef === undefined ? {} : { extends: extendsRef }),
    lessSafe: lessSafeChanges(undefined, recipe),
  };
}

const UNREADABLE_SUMMARY: AgentSummary = { steps: 0, tools: [], autonomy: "suggest", triggers: [], skills: 0, lessSafe: ["This version can't be read now, so what it can do is not shown."] };

async function personOf(deps: ApprovalDependencies, developerId: string): Promise<{ id: string; name: string }> {
  try {
    const record = await deps.signInStore.getDeveloper(developerId);
    return { id: developerId, name: shownText(safeDisplayName(record?.displayName ?? "", developerId), 200) || "a teammate" };
  } catch {
    return { id: developerId, name: "a teammate" };
  }
}

/** Whether what the request was bound to is still what the agent is: its owner, its published version and that version's digest, and it is active. */
async function isStale(deps: ApprovalDependencies, record: ApprovalRecord & { subject: AgentPublicationSubject }, agent: AgentRecord | undefined): Promise<boolean> {
  if (agent === undefined || agent.status === "archived" || agent.currentVersion !== record.subject.version) return true;
  if (canonicalJson(agent.owner) !== canonicalJson(record.subject.expectedOwner)) return true;
  const stored = await deps.store.getVersion(record.orgId, agent.agentId, record.subject.version);
  return stored?.digest !== record.subject.digest;
}

/**
 * One request as `caller` reads it. `canDecide` is what the server would allow now (it decides again at decide): a person the rule lets decide, on a request that is
 * still waiting, in time and not stale. The confirmation link is given only to them.
 */
export async function publishRequestView(deps: ApprovalDependencies, caller: AgentCaller, record: ApprovalRecord & { subject: AgentPublicationSubject }): Promise<AgentPublishRequest> {
  const subject = record.subject;
  const agent = await deps.store.get(record.orgId, subject.agentId);
  const waiting = record.status === "PENDING";
  const expired = waiting && Date.parse(record.expiresAt) <= deps.now();
  const staleNow = waiting && !expired && await isStale(deps, record, agent);
  const state: AgentPublishRequest["state"] = record.status === "PENDING" ? (expired ? "expired" : staleNow ? "stale" : "pending")
    : record.status === "DECLINED" ? "declined" : record.status === "APPROVED_FAILED" ? "failed"
      : record.status === "EXPIRED" ? (record.withdrawnBy === undefined ? "expired" : "withdrawn") : "approved";
  let summary = UNREADABLE_SUMMARY;
  try {
    const stored = await deps.store.getVersion(record.orgId, subject.agentId, subject.version);
    summary = summaryOf(await resolveRecipe(deps, record.orgId, subject.agentId, subject.version), agent, stored?.extends);
  } catch { /* a version that can't be resolved now (its base was archived) is shown without what it can do */ }
  const requester = await sameMember(deps, record.orgId, record.requestedBy, caller.developerId);
  const mayDecide = waiting && !expired && !staleNow && await mayDecideApproval(deps, caller, record);
  const reason: AgentPublishRequest["approval"]["reason"] = mayDecide || !waiting ? null : expired ? "expired" : staleNow ? "stale"
    : requester && subject.target.kind === "project" ? "you_requested" : subject.target.kind === "project" ? "not_a_maintainer" : "not_an_admin";
  const author = subject.expectedOwner.kind === "member" ? await personOf(deps, subject.expectedOwner.developerId) : undefined;
  return {
    requestId: subject.requestId, approvalId: record.approvalId,
    agent: { agentId: subject.agentId, name: agent === undefined ? "An agent that can't be found" : agent.name, description: agent?.description ?? "" },
    target: subject.target, version: subject.version, digest: subject.digest, state,
    requestedBy: await personOf(deps, record.requestedBy), requestedAt: record.createdAt, expiresAt: record.expiresAt,
    note: subject.note ?? null,
    decidedBy: record.decidedBy === undefined ? null : await personOf(deps, record.decidedBy), decidedAt: record.decidedAt ?? null,
    summary,
    effect: effectOf(agent?.name ?? "the agent", subject.target, author?.name),
    approval: { canDecide: mayDecide, reason, freshSignInNeeded: true, confirmUrl: mayDecide ? confirmUrlFor(deps, record) : null },
    ...(record.status === "DECLINED" && record.declineReason !== undefined ? { declineReason: shownText(record.declineReason, 300) } : {}),
    ...(record.status === "APPROVED_FAILED" ? { failureText: shownText(record.failure ?? "Rovara could not carry it out.", 400) } : {}),
  };
}

/** Whether `caller` may see a request: they asked it, they may decide it now, they are an org owner or admin, or it targets a project they maintain. */
export async function maySeeRequest(deps: ApprovalDependencies, caller: AgentCaller, record: ApprovalRecord & { subject: AgentPublicationSubject }): Promise<boolean> {
  if (caller.orgId !== record.orgId) return false;
  if (isOrgAdmin(caller.orgRole) && isOrgAdmin(await orgRoleOf(deps, record.orgId, caller.developerId))) return true;
  if (await sameMember(deps, record.orgId, record.requestedBy, caller.developerId)) return true;
  if (record.subject.target.kind === "project" && await maintainsProject(deps, record.orgId, record.subject.target.project, caller.developerId)) return true;
  return mayDecideApproval(deps, caller, record);
}

/** The agent view's `publication`: how far it is published now, and the request that waits for a target, when `caller` may see one. */
export async function publicationOf(deps: ApprovalDependencies, caller: AgentCaller, agent: AgentRecord): Promise<AgentPublication> {
  const shares = await agentShares(deps, agent.orgId, agent.agentId);
  const projects = [...new Set([...(agent.owner.kind === "project" ? [agent.owner.project] : []), ...shares.flatMap((share) => (share.principal.kind === "project" ? [share.principal.project] : []))])];
  const level: AgentPublication["level"] = shares.some((share) => share.principal.kind === "org") ? "company" : projects.length > 0 ? "project" : "personal";
  let pending: AgentPublication["pending"] = null;
  const pointers = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": agentPublicationKey(agent.orgId, agent.agentId, { pending: "company" }).pk, ":prefix": "PENDING#" }, ConsistentRead: true, Limit: 50,
  })) as { Items?: Array<{ approvalId?: unknown }> };
  for (const pointer of pointers.Items ?? []) {
    if (typeof pointer.approvalId !== "string") continue;
    const record = await getApproval(deps, agent.orgId, pointer.approvalId);
    if (!isPublicationRecord(record) || record.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now() || record.subject.agentId !== agent.agentId) continue;
    if (!await maySeeRequest(deps, caller, record)) continue;
    if (pending === null || record.createdAt > pending.requestedAt) pending = { requestId: record.subject.requestId, target: record.subject.target, requestedAt: record.createdAt };
  }
  return { level, projects, pending };
}

// ---- indexes written with the request

/**
 * The items a new request writes in the same transaction as its record: the org's index item, the agent's history item, and the agent's pending pointer for the target,
 * conditional on there being none, or on it still naming `seenApprovalId` (a request that ended): two requests for one agent and target can't both wait.
 */
export function publicationIndexItems(deps: Pick<ApprovalDependencies, "tableName">, record: ApprovalRecord & { subject: AgentPublicationSubject }, seenApprovalId: string | undefined): TransactItem[] {
  const { orgId, approvalId, createdAt, requestedBy } = record;
  const subject = record.subject;
  const fields = { orgId, approvalId, agentId: subject.agentId, targetKey: targetKeyOf(subject.target), requestedBy, createdAt };
  const pointer = agentPublicationKey(orgId, subject.agentId, { pending: targetKeyOf(subject.target) });
  return [
    { Put: { TableName: deps.tableName, Item: { ...agentPublicationsIndexKey(orgId, createdAt, approvalId), entityType: "AGENT_PUBLICATION_INDEX", ...fields }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...agentPublicationKey(orgId, subject.agentId, { request: { createdAt, approvalId } }), entityType: "AGENT_PUBLICATION_REQUEST", ...fields }, ConditionExpression: "attribute_not_exists(pk)" } },
    {
      Put: {
        TableName: deps.tableName, Item: { ...pointer, entityType: "AGENT_PUBLICATION_PENDING", ...fields },
        ...(seenApprovalId === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "attribute_not_exists(pk) OR approvalId = :seen", ExpressionAttributeValues: { ":seen": seenApprovalId } }),
      },
    },
  ];
}

/** The request that waits for this agent and target now (in time), and the approval id the pointer names (to condition a new pointer on). */
export async function waitingFor(deps: ApprovalDependencies, orgId: OrgId, agentId: AgentId, target: PublishTarget): Promise<{ waiting?: ApprovalRecord; seen?: string }> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: agentPublicationKey(orgId, agentId, { pending: targetKeyOf(target) }), ConsistentRead: true })) as { Item?: { approvalId?: unknown } };
  const seen = typeof response.Item?.approvalId === "string" ? response.Item.approvalId : undefined;
  if (seen === undefined) return {};
  const record = await getApproval(deps, orgId, seen);
  return record !== undefined && record.status === "PENDING" && Date.parse(record.expiresAt) > deps.now() ? { waiting: record, seen } : { seen };
}

export function requestedEvent(record: ApprovalRecord & { subject: AgentPublicationSubject }): AuditEventInput {
  return auditAgentPublication({
    orgId: record.orgId, actor: auditActorOf(record.requestedBy), occurredAt: record.createdAt, occurrence: record.approvalId, action: "agent_publication.requested", agentId: record.subject.agentId,
    facts: { approvalId: record.approvalId, targetKind: record.subject.target.kind, version: record.subject.version },
  });
}

export function withdrawnEvent(record: ApprovalRecord & { subject: AgentPublicationSubject }, by: string, at: string): AuditEventInput {
  return auditAgentPublication({
    orgId: record.orgId, actor: auditActorOf(by), occurredAt: at, occurrence: record.approvalId, action: "agent_publication.withdrawn", agentId: record.subject.agentId,
    facts: { approvalId: record.approvalId, targetKind: record.subject.target.kind, version: record.subject.version },
  });
}

// ---- what approving does

/**
 * Decision 92: an agent the whole company can use (a stored company share) changes owner only by an org owner or admin, on every path that moves it (a `PUT owner`, a
 * publish request applied at once, an approved project request). `role` is the mover's live org role.
 */
export async function requireOwnerOrAdminToMoveShared(deps: ApprovalDependencies, orgId: OrgId, agentId: AgentId, role: string | undefined): Promise<void> {
  if (isOrgAdmin(role) || !await agentHasCompanyShare(deps, orgId, agentId)) return;
  throw agentXError("FORBIDDEN", "This agent is shared with your whole company, so only an organization owner or admin can change who owns it.");
}

/** Refuses a project that is not in the company's catalog (`PROJECT_NOT_FOUND`) or that is archived (`PROJECT_ARCHIVED`). */
export async function requireOpenProject(deps: ApprovalDependencies, orgId: OrgId, project: string): Promise<void> {
  const listed = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgProjectCatalogKey(orgId, project), ConsistentRead: true })) as { Item?: unknown };
  if (listed.Item === undefined) throw agentXError("PROJECT_NOT_FOUND", `no project called ${project} in your company`);
  if ((await readProjectMeta(deps, orgId, project))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
}

/** The author keeps editing an agent that moved to a project: an `edit` share for its former member owner, unless they already hold edit or are the accountable maintainer. */
export async function keepAuthorEditing(deps: ApprovalDependencies, orgId: OrgId, by: string, agentId: AgentId, author: string, accountable: string): Promise<void> {
  if (author === accountable) return;
  const agent = await deps.store.get(orgId, agentId);
  if (agent === undefined) return;
  const shares = await agentShares(deps, orgId, agentId);
  const mine = shares.find((share) => share.principal.kind === "member" && share.principal.developerId === author);
  if (mine !== undefined && (SHARE_RANK[mine.level] ?? -1) >= SHARE_RANK["edit"]!) return;
  const others = shares.filter((share) => share !== mine);
  await saveShares(deps, orgId, by, agent, [...others, { principal: { kind: "member", developerId: author }, level: "edit" }]);
}

async function confirmPublication(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<void> {
  if (!isPublicationRecord(record)) throw agentXError("CONFIG_INVALID", "this is not a publish request");
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  const by = await resolveSurvivor(deps, record.orgId, record.decidedBy);
  const subject = record.subject;
  const agent = await deps.store.get(record.orgId, subject.agentId);
  if (agent === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
  if (agent.status === "archived") throw agentXError("AGENT_UNAVAILABLE", `${agent.name} is archived, so it can't be published. Unarchive it first, then ask again.`);
  const role = await orgRoleOf(deps, record.orgId, by);
  if (role === undefined) throw agentXError("FORBIDDEN", "Your company access changed, so this can't be applied.");

  if (subject.target.kind === "project") {
    const project = subject.target.project;
    // A redrive after a crash between the owner move and the share (m-1): the move that was approved is in place, so only the author's share is made sure of.
    if (agent.owner.kind === "project" && agent.owner.project === project && agent.accountable !== undefined && await sameMember(deps, record.orgId, agent.accountable.developerId, by)) {
      if (subject.expectedOwner.kind === "member") await keepAuthorEditing(deps, record.orgId, by, agent.agentId, subject.expectedOwner.developerId, agent.accountable.developerId);
      return;
    }
    // Bound to the share set that was shown too, as a company request is: the approver decided about who could use it then.
    if ((agent.sharesRevision ?? 0) !== subject.expectedSharesRevision) throw stale("Who this agent is shared with changed after this was asked. Ask again.");
    await requireBound(deps, record, agent);
    await requireOpenProject(deps, record.orgId, project);
    // The approver must still maintain the project (the store's write fences the same grant at commit) and answers for the agent from now on.
    const accountable = await requireAccountable(deps, record.orgId, project, by).catch(() => { throw agentXError("FORBIDDEN", `You are no longer a maintainer of ${project}, so this can't be applied.`); });
    // Decision 92: an agent the whole company can use changes hands only by an org owner or admin.
    await requireOwnerOrAdminToMoveShared(deps, record.orgId, agent.agentId, role);
    const owner = { kind: "project" as const, project };
    const { accountable: _before, ...kept } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- the new owner decides it
    // The cap reads only the store, the table and the owner counters; the approval's dependencies are the agent routes' own at run time (their extra fields are optional).
    const cap = await ownerCapCheck(deps as unknown as SpendRequestDependencies, record.orgId, { kind: "agent", agentId: agent.agentId }, agent, { ...kept, owner, accountable });
    if ("over" in cap) throw agentXError("CONFIG_INVALID", `Moving ${shownText(agent.name, NAME_MAX)} to ${project} would take the agent budgets you answer for past your company's monthly cap. Ask an organization admin to raise the cap, then ask again.`);
    await deps.store.setOwner(record.orgId, agent.agentId, owner, by, accountable, undefined, { actor: { developerId: by, role }, manageSnapshot: agent, ownerCap: cap.ownerCap });
    if (subject.expectedOwner.kind === "member") await keepAuthorEditing(deps, record.orgId, by, agent.agentId, subject.expectedOwner.developerId, accountable.developerId);
    await deps.triggerHooks?.recheckTriggersForTarget(record.orgId, { kind: "agent", agentId: agent.agentId });
    return;
  }

  const shares = await agentShares(deps, record.orgId, agent.agentId);
  const company = shares.find((share) => share.principal.kind === "org");
  // Already shared with the company at use or more (a redrive after the share landed): nothing to do.
  if (company !== undefined && (SHARE_RANK[company.level] ?? -1) >= SHARE_RANK["use"]!) return;
  if (!isOrgAdmin(role)) throw agentXError("FORBIDDEN", "Only an organization owner or admin can share an agent with the whole company.");
  if ((agent.sharesRevision ?? 0) !== subject.expectedSharesRevision) throw stale("Who this agent is shared with changed after this was asked. Ask again.");
  await requireBound(deps, record, agent);
  await saveShares(deps, record.orgId, by, agent, [...shares.filter((share) => share.principal.kind !== "org"), { principal: { kind: "org" }, level: "use" }]);
}

/** What the request was bound to is still what the agent is (owner, version, digest), and that version is still within the company's guardrails. */
async function requireBound(deps: ApprovalDependencies, record: ApprovalRecord & { subject: AgentPublicationSubject }, agent: AgentRecord): Promise<void> {
  if (canonicalJson(agent.owner) !== canonicalJson(record.subject.expectedOwner)) throw stale("The agent's owner changed after this was asked. Ask again.");
  if (await isStale(deps, record, agent)) throw stale("The agent changed after this was asked. Ask again.");
  // The guardrails may have tightened since this was asked.
  await requireWithinGuardrails(deps, record.orgId, await resolveRecipe(deps, record.orgId, agent.agentId, record.subject.version));
}

/** Registers the two rules, their words, the handler and the decision's audit events. Safe to call more than once. */
export function registerPublicationApprovals(): void {
  registerApproverRule(PUBLICATION_PROJECT_RULE, mayDecideProjectRequest);
  registerApproverRule(PUBLICATION_COMPANY_RULE, mayDecideCompanyRequest);
  registerApproverRefusal(PUBLICATION_PROJECT_RULE, async (_deps, record) => {
    const project = isPublicationRecord(record) && record.subject.target.kind === "project" ? record.subject.target.project : "the project";
    return { text: `Only a maintainer of ${project} or an organization owner or admin can decide this, and never the person who asked.`, who: `a maintainer of ${project} or an organization owner or admin, other than the person who asked` };
  });
  registerApproverRefusal(PUBLICATION_COMPANY_RULE, async () => ({ text: "Only an organization owner or admin can decide this.", who: "an organization owner or admin" }));
  registerApprovalSubjectHandler("agent_publication", confirmPublication);
  registerDecisionAuditEvents("agent_publication", (record, decision) => {
    if (!isPublicationRecord(record)) return [];
    return [auditAgentPublication({
      orgId: record.orgId, actor: auditActorOf(decision.by), occurredAt: decision.at, occurrence: record.approvalId, ...(decision.proof === undefined ? {} : { proof: decision.proof }),
      action: decision.decision === "APPROVE" ? "agent_publication.approved" : "agent_publication.declined", agentId: record.subject.agentId,
      facts: { approvalId: record.approvalId, targetKind: record.subject.target.kind, version: record.subject.version, ...(decision.decision === "DECLINE" ? { explained: decision.reason !== undefined } : {}) },
    })];
  });
}
