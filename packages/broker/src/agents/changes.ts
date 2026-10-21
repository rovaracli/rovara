// Plan 3 Task 7: the changes to an agent that decide which recipe runs or who can use it (publish, rollback, adopting a built-in's
// version, a company-wide share) and the approvals behind them. Each starts from the caller's request: a change that makes nothing
// less safe applies at once; any other creates a pending change (approvals.ts) and applies nothing until a person confirms it on the
// page. The handlers registered at the bottom are what confirming does: they re-check that what was shown is still what is there,
// then apply exactly that.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  EMPTY_RECIPE,
  agentXError,
  atLeast,
  diffRecipes,
  orgPk,
  projectAllows,
  recipeDigest,
  type AgentId,
  type BaseRef,
  type OrgId,
  type ResolvedRecipe,
} from "@agentx/contracts";
import { agentAccess, checkShares, resolveSurvivor, saveShares, type AgentCaller, type AgentShare } from "./access.js";
import {
  confirmUrlFor,
  createPendingChange,
  registerApprovalSubjectHandler,
  registerApproverRule,
  type AgentChangeSubject,
  type ApprovalDependencies,
  type ApprovalRecord,
  type ApproverSpec,
} from "./approvals.js";
import { lessSafeChanges } from "./less-safe.js";
import { resolveAgent, type AgentRecord, type AgentVersion, type RecipeProblemsError } from "./store.js";

/** What a route answers for a change: done, or waiting on the page. */
export type ChangeResult<T> =
  | { applied: true; value: T }
  | { applied: false; confirmUrl: string; changes: string[] };

const isOrgAdmin = (orgRole: string): boolean => orgRole === "owner" || orgRole === "admin";

/** Resolves a recipe, reporting a recipe that can't run by its first problem, `<path>: <message>`. */
export async function resolveRecipe(deps: ApprovalDependencies, orgId: OrgId, agentId: AgentId, version: number | "current" | "draft"): Promise<ResolvedRecipe> {
  try {
    return await resolveAgent(deps.store, orgId, agentId, version, deps.resolveSkill === undefined ? {} : { resolveSkill: deps.resolveSkill });
  } catch (error) {
    const first = (error as Partial<RecipeProblemsError>).problems?.[0];
    if (first !== undefined) throw agentXError("CONFIG_INVALID", `${first.path}: ${first.message}`);
    throw error;
  }
}

/** The recipe of the agent a layer builds on, at the version it pinned; nothing to build on is the empty recipe. */
export async function resolveBase(deps: ApprovalDependencies, orgId: OrgId, base: BaseRef | undefined): Promise<ResolvedRecipe> {
  return base === undefined ? structuredClone(EMPTY_RECIPE) : resolveRecipe(deps, orgId, base.agentId, base.version);
}

/** What runs now: the published version, or before any is published the base the agent builds on. */
async function runningNow(deps: ApprovalDependencies, agent: AgentRecord, fallbackBase: BaseRef | undefined): Promise<ResolvedRecipe> {
  return agent.currentVersion === undefined ? resolveBase(deps, agent.orgId, fallbackBase) : resolveRecipe(deps, agent.orgId, agent.agentId, agent.currentVersion);
}

// ---- who is asked

async function orgAdmins(deps: ApprovalDependencies, orgId: OrgId): Promise<string[]> {
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "MEMBER#" },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ developerId?: unknown; role?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) if (typeof item.developerId === "string" && typeof item.role === "string" && isOrgAdmin(item.role)) ids.push(item.developerId);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return ids;
}

/**
 * Who sees a change to this agent listed for confirmation: the owner (the member, or a project's accountable maintainer and every
 * maintainer with `manage_agents`) and the org's owners and admins. It decides only who is shown it; the rule decides who may decide.
 */
export async function agentApprovers(deps: ApprovalDependencies, agent: AgentRecord, rule: "agent_publish" | "agent_manager"): Promise<ApproverSpec> {
  const candidates = new Set(await orgAdmins(deps, agent.orgId));
  if (agent.owner.kind === "member") candidates.add(await resolveSurvivor(deps, agent.orgId, agent.owner.developerId));
  else {
    for (const member of await deps.projectMembers.list(agent.orgId, agent.owner.project)) if (projectAllows(member.role, "manage_agents")) candidates.add(member.developerId);
    if (agent.accountable !== undefined) candidates.add(await resolveSurvivor(deps, agent.orgId, agent.accountable.developerId));
  }
  return { kind: "rule", rule, candidates: [...candidates] };
}

async function orgAdminApprovers(deps: ApprovalDependencies, orgId: OrgId): Promise<ApproverSpec> {
  return { kind: "rule", rule: "org_admin", candidates: await orgAdmins(deps, orgId) };
}

async function waitForPerson(
  deps: ApprovalDependencies, caller: AgentCaller, requestId: string, subject: AgentChangeSubject, changes: string[], approvers: ApproverSpec,
): Promise<ChangeResult<never>> {
  const record = await createPendingChange(deps, { orgId: caller.orgId, requestId, requestedBy: caller.developerId, subject, changes, approvers });
  // A replay of a request that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return { applied: false, confirmUrl: confirmUrlFor(deps, record), changes: record.changes };
}

// ---- publish, rollback, adopt, share

/**
 * Publishes the agent's draft at `expectedRevision`. A draft that makes nothing less safe than what runs now (the published version, or
 * for a first publish the base it builds on) is published at once; any other waits for the owner or an org admin on the page, bound to
 * this draft revision and its digest.
 */
export async function publishDraft(
  deps: ApprovalDependencies, caller: AgentCaller, agent: AgentRecord, input: { requestId: string; expectedRevision: number; note?: string | undefined },
): Promise<ChangeResult<AgentVersion>> {
  const draft = await deps.store.getDraft(agent.orgId, agent.agentId);
  if (draft === undefined || draft.revision !== input.expectedRevision || agent.draftRevision !== input.expectedRevision) {
    throw agentXError("AGENT_REVISION_CONFLICT", "Someone else changed this agent's draft. Reload it and make your change again.");
  }
  const next = await resolveRecipe(deps, agent.orgId, agent.agentId, "draft");
  const digest = recipeDigest(next);
  const changes = lessSafeChanges(await runningNow(deps, agent, draft.extends), next);
  if (changes.length === 0) {
    const version = await deps.store.publish({ orgId: agent.orgId, agentId: agent.agentId, expectedDraftRevision: input.expectedRevision, digest, by: caller.developerId, ...(input.note === undefined ? {} : { note: input.note }) });
    return { applied: true, value: version };
  }
  const subject: AgentChangeSubject = {
    kind: "agent_publish", agentId: agent.agentId, draftRevision: input.expectedRevision, digest,
    ...(agent.currentVersion === undefined ? {} : { expectedCurrentVersion: agent.currentVersion }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  return waitForPerson(deps, caller, input.requestId, subject, changes, await agentApprovers(deps, agent, "agent_publish"));
}

/** Makes an earlier version current. A rollback is compared like a publish: one that makes anything less safe waits for the page. */
export async function rollbackAgent(
  deps: ApprovalDependencies, caller: AgentCaller, agent: AgentRecord, input: { requestId: string; version: number },
): Promise<ChangeResult<AgentRecord>> {
  if (agent.currentVersion === undefined) throw agentXError("CONFIG_INVALID", `${agent.name} has no published version to roll back from`);
  if (input.version === agent.currentVersion) throw agentXError("CONFIG_INVALID", `version: ${String(input.version)} is already the current version`);
  if (await deps.store.getVersion(agent.orgId, agent.agentId, input.version) === undefined) throw agentXError("NOT_FOUND", `${agent.name} has no version ${String(input.version)}`);
  const current = await resolveRecipe(deps, agent.orgId, agent.agentId, agent.currentVersion);
  const target = await resolveRecipe(deps, agent.orgId, agent.agentId, input.version);
  const changes = lessSafeChanges(current, target);
  if (changes.length === 0) {
    return { applied: true, value: await deps.store.rollback({ orgId: agent.orgId, agentId: agent.agentId, version: input.version, expectedCurrentVersion: agent.currentVersion, by: caller.developerId }) };
  }
  const subject: AgentChangeSubject = { kind: "agent_rollback", agentId: agent.agentId, version: input.version, digest: recipeDigest(target), expectedCurrentVersion: agent.currentVersion };
  return waitForPerson(deps, caller, input.requestId, subject, changes, await agentApprovers(deps, agent, "agent_publish"));
}

/** Moves the org's pin of a built-in to one of its released versions; org owners and admins only (the route checks), and a less-safe one waits for an org admin on the page. */
export async function adoptBuiltin(
  deps: ApprovalDependencies, caller: AgentCaller, agentId: AgentId, input: { requestId: string; version: number },
): Promise<ChangeResult<{ pinnedVersion: number; changes: string[] }>> {
  const pinned = (await deps.store.ensureBuiltinSettings(caller.orgId, agentId, caller.developerId)).pinnedVersion;
  const target = deps.store.builtinRecipe(agentId, input.version);
  if (input.version === pinned) return { applied: true, value: { pinnedVersion: pinned, changes: [] } };
  const current = deps.store.builtinRecipe(agentId, pinned);
  const changes = lessSafeChanges(current, target);
  if (changes.length === 0) {
    await deps.store.adoptBuiltinVersion({ orgId: caller.orgId, agentId, version: input.version, expectedPinnedVersion: pinned, by: caller.developerId });
    return { applied: true, value: { pinnedVersion: input.version, changes: diffRecipes(current, target) } };
  }
  const subject: AgentChangeSubject = { kind: "builtin_adopt", agentId, version: input.version, digest: recipeDigest(target), expectedPinnedVersion: pinned };
  return waitForPerson(deps, caller, input.requestId, subject, changes, await orgAdminApprovers(deps, caller.orgId));
}

const SHARE_RANK = { view: 0, use: 1, edit: 2 } as const;

/**
 * Makes `shares` the agent's share set (the caller has `manage`). Sharing with the whole company, or raising what the company can do,
 * waits for the page (R66): the change is stored as it would be written and applies only while who the agent is shared with is
 * still what was shown. Any other change, lowering or removing the company share included, applies at once.
 */
export async function shareAgent(
  deps: ApprovalDependencies, caller: AgentCaller, agent: AgentRecord, input: { requestId: string; shares: unknown },
): Promise<ChangeResult<AgentShare[]>> {
  // Refused now, not when it is confirmed: a change nobody could apply is not worth asking a person about.
  const shares = await checkShares(deps, agent.orgId, caller.developerId, input.shares);
  const wantedCompany = shares.find((share) => share.principal.kind === "org");
  const storedCompany = (await deps.store.listShares(agent.orgId, agent.agentId)).find((share) => (share.principal as { kind?: unknown } | undefined)?.kind === "org");
  const widens = wantedCompany !== undefined && (storedCompany === undefined || SHARE_RANK[wantedCompany.level] > (SHARE_RANK[storedCompany.level] ?? -1));
  if (!widens) return { applied: true, value: await saveShares(deps, agent.orgId, caller.developerId, agent, shares) };
  const can = { view: "see", use: "run", edit: "change" }[wantedCompany.level];
  const subject: AgentChangeSubject = { kind: "agent_share", agentId: agent.agentId, shares, expectedSharesRevision: agent.sharesRevision ?? 0 };
  return waitForPerson(deps, caller, input.requestId, subject, [`Shares ${agent.name} with everyone in your company, who can then ${can} it`], await agentApprovers(deps, agent, "agent_manager"));
}

// ---- what confirming does

const STALE_DRAFT = "The draft changed after this was asked. Publish again.";
const stale = (message: string) => agentXError("AGENT_REVISION_CONFLICT", message);

const decider = (record: ApprovalRecord): string => record.decidedBy ?? record.requestedBy;

async function liveAgent(deps: ApprovalDependencies, record: ApprovalRecord, agentId: AgentId): Promise<AgentRecord> {
  const agent = await deps.store.get(record.orgId, agentId);
  if (agent === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
  if (agent.status === "archived") throw agentXError("AGENT_UNAVAILABLE", `${agent.name} is archived, so it can't be changed. Unarchive it first.`);
  return agent;
}

async function confirmPublish(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const subject = record.subject as Extract<AgentChangeSubject, { kind: "agent_publish" }>;
  const agent = await liveAgent(deps, record, subject.agentId);
  const draft = await deps.store.getDraft(record.orgId, subject.agentId);
  if (draft === undefined || draft.revision !== subject.draftRevision || agent.draftRevision !== subject.draftRevision) throw stale(STALE_DRAFT);
  if (agent.currentVersion !== subject.expectedCurrentVersion) throw stale("The published version changed after this was asked. Publish again.");
  // The draft's base is pinned, so its content can't move under the same revision; the digest still catches a changed skill.
  if (recipeDigest(await resolveRecipe(deps, record.orgId, subject.agentId, "draft")) !== subject.digest) throw stale(STALE_DRAFT);
  await deps.store.publish({
    orgId: record.orgId, agentId: subject.agentId, expectedDraftRevision: subject.draftRevision, digest: subject.digest, by: decider(record),
    ...(subject.note === undefined ? {} : { note: subject.note }),
  });
}

async function confirmRollback(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const subject = record.subject as Extract<AgentChangeSubject, { kind: "agent_rollback" }>;
  const agent = await liveAgent(deps, record, subject.agentId);
  if (agent.currentVersion !== subject.expectedCurrentVersion) throw stale("The published version changed after this was asked. Roll back again.");
  if (recipeDigest(await resolveRecipe(deps, record.orgId, subject.agentId, subject.version)) !== subject.digest) throw stale("That version changed after this was asked. Roll back again.");
  await deps.store.rollback({ orgId: record.orgId, agentId: subject.agentId, version: subject.version, expectedCurrentVersion: subject.expectedCurrentVersion, by: decider(record) });
}

async function confirmAdopt(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const subject = record.subject as Extract<AgentChangeSubject, { kind: "builtin_adopt" }>;
  const pinned = (await deps.store.getBuiltinSettings(record.orgId, subject.agentId))?.pinnedVersion;
  if (pinned !== subject.expectedPinnedVersion) throw stale("The version your company uses changed after this was asked. Adopt again.");
  if (recipeDigest(deps.store.builtinRecipe(subject.agentId, subject.version)) !== subject.digest) throw stale("That version changed after this was asked. Adopt again.");
  await deps.store.adoptBuiltinVersion({ orgId: record.orgId, agentId: subject.agentId, version: subject.version, expectedPinnedVersion: subject.expectedPinnedVersion, by: decider(record) });
}

async function confirmShare(deps: ApprovalDependencies, record: ApprovalRecord): Promise<void> {
  const subject = record.subject as Extract<AgentChangeSubject, { kind: "agent_share" }>;
  const agent = await liveAgent(deps, record, subject.agentId);
  if ((agent.sharesRevision ?? 0) !== subject.expectedSharesRevision) throw stale("Who this agent is shared with changed after this was asked. Share again.");
  await saveShares(deps, record.orgId, decider(record), agent, subject.shares);
}

/** The owner, an accountable or managing maintainer of the owning project, or an org owner or admin: whoever holds `manage` on the agent now (R68). */
async function managesAgent(deps: ApprovalDependencies, record: ApprovalRecord, caller: AgentCaller): Promise<boolean> {
  const agentId = (record.subject as { agentId?: unknown }).agentId;
  if (caller.orgId !== record.orgId || typeof agentId !== "string") return false;
  const agent = await deps.store.get(record.orgId, agentId);
  return agent !== undefined && atLeast(await agentAccess(deps, caller, agent), "manage");
}

/**
 * Registers what Task 7 makes confirmable: the `agent_publish` rule (publish and rollback; the agent's owner or an org owner or admin,
 * evaluated live), the `agent_manager` rule for sharing company-wide, the `org_admin` rule (adopting a built-in's version, and the
 * guardrail relaxations Task 8 makes), and the handlers for each subject kind. Safe to call more than once.
 */
export function registerAgentApprovals(): void {
  registerApproverRule("agent_publish", managesAgent);
  registerApproverRule("agent_manager", managesAgent);
  registerApproverRule("org_admin", async (_deps, record, caller) => caller.orgId === record.orgId && isOrgAdmin(caller.orgRole));
  registerApprovalSubjectHandler("agent_publish", confirmPublish);
  registerApprovalSubjectHandler("agent_rollback", confirmRollback);
  registerApprovalSubjectHandler("builtin_adopt", confirmAdopt);
  registerApprovalSubjectHandler("agent_share", confirmShare);
}
