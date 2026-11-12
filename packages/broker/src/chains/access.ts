// Who can do what with a chain (Plan 4 Task 3): Plan 3's agent rules, applied to a chain's owner, accountable maintainer and shares. The rules
// themselves are `evaluateOwned`, `checkShares`, `saveSharesOf` and `requireOwnerAllowed` in agents/access.ts, one implementation for both; this
// file reads a chain's record and its shares from the chain store and words the refusals for a chain.
//
// srv/automations: on top of the agent rules, experience review decision 16 (final-experience-proposal.md, 2026-11-10) (`automationRules`), judged on every read with the live project role: a project's chain is
// visible (`view`) to everyone with a role on that project, viewers included; changing it (`edit`, `manage`) is for maintainers of THAT project
// (`manage_agents`) and org owners and admins, so a share never lifts anyone else above `use`. Org owners and admins are untouched (they hold `manage` on every chain of their org). A member's own chain keeps the agent rules (it has no project).
// Owner decision 92 (a company-shared chain) is not an access level: it is held where a change is decided (routes.ts `requireOwnerOrAdminToMoveSharedChain`,
// the `chain_publish` and `chain_company_share` rules, and the trigger turn-on rule in triggers/routes.ts), as for an agent.
import { TRIAL_LIMITS_R49 } from "@agentx/cloud-contracts";
import { AGENT_ACCESS_LEVELS, agentXError, atLeast, projectAllows, type AgentAccessLevel, type AgentOwner, type ChainId, type OrgId } from "@rovara-code/contracts";
import {
  Lookups,
  evaluateOwned,
  orgRoleOf,
  requireOwnerAllowed,
  resolveSurvivor,
  saveSharesOf,
  validSharesOf,
  whoNeeds,
  type AgentCaller,
  type AgentShare,
  type Evaluation,
  type OwnedAccessDeps,
} from "../agents/access.js";
import { readGuardrails } from "../agents/guardrails.js";
import type { RequestMark } from "../agents/table-writes.js";
import type { ChainRecord, ChainStore } from "./store.js";

/** What chain access needs: the agent access dependencies, with the chain store in place of the agent store. */
export type ChainAccessDeps = OwnedAccessDeps & { store: Pick<ChainStore, "get" | "list" | "listShares" | "replaceShares"> };

export type ChainScope = "all" | "mine" | "shared" | { project: string };

const notFound = () => agentXError("NOT_FOUND", "no chain has that ID");

const levelRank = (level: AgentAccessLevel) => AGENT_ACCESS_LEVELS.indexOf(level);
const atMost = (level: AgentAccessLevel, cap: AgentAccessLevel): AgentAccessLevel => (levelRank(level) > levelRank(cap) ? cap : level);
const atLeastLevel = (level: AgentAccessLevel, floor: AgentAccessLevel): AgentAccessLevel => (levelRank(level) < levelRank(floor) ? floor : level);

/** What the caller holds on a chain, and whether they own it and by which shares (see `evaluateOwned`). A chain of another org gives nothing, to an org admin too. */
async function evaluateChain(lookups: Lookups<ChainAccessDeps>, chain: ChainRecord, withShares = false): Promise<Evaluation> {
  if (chain.orgId !== lookups.caller.orgId) return { access: "none", owns: false, viaShares: "none", sharedProjects: [] };
  const { deps } = lookups;
  const found = await evaluateOwned(lookups, chain, () => validSharesOf(deps, { orgId: chain.orgId, chainId: chain.chainId }, () => deps.store.listShares(chain.orgId, chain.chainId), "chain_share_skipped"), withShares);
  const admin = lookups.caller.orgRole === "owner" || lookups.caller.orgRole === "admin";
  return admin ? found : { ...found, access: await automationRules(lookups, chain, found.access) };
}

/**
 * Experience review decision 16 for a caller who is not an org owner or admin (see the top of this file), applied to what the agent rules gave (`access`): on a project's
 * chain, any role on that project raises it to `view`, and anyone without `manage_agents` there is capped at `use` (a share never lets them change it).
 * The role is read live on every call (the request's `Lookups`), never cached across requests.
 */
async function automationRules(lookups: Lookups<ChainAccessDeps>, chain: ChainRecord, access: AgentAccessLevel): Promise<AgentAccessLevel> {
  if (chain.owner.kind !== "project") return access;
  const role = await lookups.role(chain.owner.project);
  let level = access;
  if (role !== undefined) level = atLeastLevel(level, "view");
  if (role === undefined || !projectAllows(role, "manage_agents")) level = atMost(level, "use");
  return level;
}

/**
 * The access `caller` holds on `chain`: an org owner or admin `manage`; its member owner `manage`; for a project's chain a `manage_agents` holder
 * `manage` and a contributor `use`; the shares that name the caller (a project's capped by their role there); otherwise `none`. An archived chain
 * is capped at `view` for everyone without `manage`. Then experience review decision 16: any role on the owning project gives `view`, and only its maintainers (and
 * org owners and admins) hold more than `use`.
 */
export async function chainAccess(deps: ChainAccessDeps, caller: AgentCaller, chain: ChainRecord): Promise<AgentAccessLevel> {
  return (await evaluateChain(new Lookups(deps, caller), chain)).access;
}

/**
 * The chain, when the caller holds at least `wanted` on it. Below `view` the answer is `NOT_FOUND`, the same as for a chain that doesn't exist
 * (or is another org's), so a person can't tell a hidden chain from a missing one; below `wanted` it is `FORBIDDEN` and says what they can do.
 */
export async function requireChainAccess(
  deps: ChainAccessDeps,
  caller: AgentCaller,
  chainId: ChainId,
  wanted: Exclude<AgentAccessLevel, "none">,
): Promise<{ chain: ChainRecord; access: AgentAccessLevel }> {
  const chain = await deps.store.get(caller.orgId, chainId);
  if (chain === undefined) throw notFound();
  const access = await chainAccess(deps, caller, chain);
  if (!atLeast(access, "view")) throw notFound();
  if (atLeast(access, wanted)) return { chain, access };
  throw agentXError("FORBIDDEN", `You can ${access} ${chain.name}; ${wanted} needs ${whoNeeds(chain, wanted)}.`);
}

export interface VisibleChain {
  chainId: ChainId;
  name: string;
  access: AgentAccessLevel;
  record: ChainRecord;
}

/** The chains `caller` can see (`view` or more) in a scope, each with the access they hold, in the order of the directory. */
export async function listVisibleChains(deps: ChainAccessDeps, caller: AgentCaller, scope: ChainScope): Promise<VisibleChain[]> {
  const lookups = new Lookups(deps, caller);
  const admin = caller.orgRole === "owner" || caller.orgRole === "admin";
  // A project's list is for people with a role on it; without one there is nothing to show.
  if (typeof scope === "object" && (await lookups.role(scope.project)) === undefined && !admin) return [];
  const needsShares = scope === "shared" || typeof scope === "object";
  const visible: VisibleChain[] = [];
  for (const record of await deps.store.list(caller.orgId)) {
    const found = await evaluateChain(lookups, record, needsShares);
    if (!atLeast(found.access, "view")) continue;
    let included: boolean;
    if (scope === "all") included = true;
    else if (scope === "mine") included = found.owns;
    else if (scope === "shared") included = !found.owns && atLeast(found.viaShares, "view");
    else included = (record.owner.kind === "project" && record.owner.project === scope.project) || found.sharedProjects.includes(scope.project);
    if (included) visible.push({ chainId: record.chainId, name: record.name, access: found.access, record });
  }
  return visible;
}

/**
 * Makes `shares` the chain's whole share set, in one transaction with the share-index items and a `shared` event. It does not ask who may: the
 * route has checked `manage` (`requireChainAccess`), and a confirmed pending change has had its decider checked by the approval's rule. An unknown
 * member or project is `CONFIG_INVALID`; at most 50 shares; a set that is already the chain's writes nothing. One save changes at most 48 shares.
 */
export async function setChainShares(deps: ChainAccessDeps, input: { orgId: OrgId; chainId: ChainId; shares: AgentShare[]; by: string; request?: RequestMark }): Promise<AgentShare[]> {
  const chain = await deps.store.get(input.orgId, input.chainId);
  if (chain === undefined) throw notFound();
  return saveSharesOf(deps, input.orgId, input.by, chain.sharesRevision ?? 0, input.shares, {
    current: () => validSharesOf(deps, { orgId: input.orgId, chainId: input.chainId }, () => deps.store.listShares(input.orgId, input.chainId), "chain_share_skipped"),
    replace: (change) => deps.store.replaceShares({ orgId: input.orgId, chainId: input.chainId, ...change }),
  }, input.request, "chain");
}

/** Refuses an owner the caller may not name for a chain, or for a change of its owner (`current`); Plan 3's owner rules, in a chain's words. */
export function requireChainOwnerAllowed(deps: OwnedAccessDeps, caller: AgentCaller, owner: AgentOwner, current?: AgentOwner): Promise<AgentOwner> {
  return requireOwnerAllowed(deps, caller, owner, current, "a chain");
}

/** Someone who may answer for a project's chain: in the org, holding `manage_agents` on the project. Returned as the survivor of any merge. */
export async function requireChainAccountable(deps: OwnedAccessDeps, orgId: OrgId, project: string, developerId: string): Promise<{ developerId: string }> {
  const survivor = await resolveSurvivor(deps, orgId, developerId);
  const orgRole = await orgRoleOf(deps, orgId, survivor);
  if (orgRole === undefined) throw agentXError("CONFIG_INVALID", "accountable: nobody in your company has that ID");
  const role = await deps.projectMembers.roleOf(orgId, project, { developerId: survivor, orgRole });
  if (role === undefined || !projectAllows(role, "manage_agents")) throw agentXError("CONFIG_INVALID", `accountable: that person needs to be a maintainer of ${project}`);
  return { developerId: survivor };
}

/**
 * Refuses a chain budget the company's guardrails (the most one agent or chain may be given a month) or a trial org's limits (R49) don't allow: checked when the
 * change is asked for, and again when an admin approves it over the owner cap, since either may have changed meanwhile.
 */
export async function requireChainBudgetAllowed(
  deps: Parameters<typeof readGuardrails>[0] & { orgs?: { getOrg(orgId: OrgId): Promise<{ plan?: string } | undefined> } },
  orgId: OrgId, monthlyUsd: number | null | undefined,
): Promise<void> {
  if (typeof monthlyUsd !== "number") return;
  const guardrails = await readGuardrails(deps, orgId);
  if (monthlyUsd > guardrails.maxAgentMonthlyUsd) {
    throw agentXError("CONFIG_INVALID", `monthlyUsd: your company's guardrails allow at most $${String(guardrails.maxAgentMonthlyUsd)} a month for one chain`);
  }
  const trialCap = TRIAL_LIMITS_R49.agentMonthlyUsd;
  if (monthlyUsd > trialCap && (await deps.orgs?.getOrg(orgId))?.plan === "trial") {
    throw agentXError("CONFIG_INVALID", `monthlyUsd: a trial organization's chain budget is at most $${String(trialCap)} a month; upgrade the plan to raise it`);
  }
}
