// What happens to chains when a member leaves or is merged (Plan 4 Task 18): chains follow Plan 3's agent rules. A removed member's chains move to the first org owner (one
// `owner_changed` event each, the chain's budget counting against the new owner's total, R65, which an `owner_cap` request asks an admin to confirm when it leaves them over
// the cap), an `accountable` id moves to another grant maintainer of that project, else the first org owner, and their shares are dropped. A merge rewrites `owner`,
// `accountable` and the shares of the duplicate to the survivor. Both are repeatable: they run again after a run that stopped half-way.
import type { AgentPrincipal, OrgId } from "@agentx/contracts";
import { checkTime, registerMemberMover, type LifecycleDeps } from "../agents/lifecycle.js";
import type { MoveCause } from "../agents/store.js";
import type { ChainStore } from "./store.js";

type Deps = LifecycleDeps & { chains?: ChainStore };

const SYSTEM = "system";
const CONFLICT_RETRIES = 3;
const isConflict = (error: unknown) => (error as { code?: string } | null)?.code === "CHAIN_REVISION_CONFLICT";

/** Runs `attempt` again when something else changed the chain in between; `attempt` reads what it needs again each time. */
async function untilSettled(attempt: () => Promise<void>): Promise<void> {
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isConflict(error) || tried >= CONFLICT_RETRIES) throw error;
    }
  }
}

const principal = (developerId: string): AgentPrincipal => ({ kind: "member", developerId });

/** Another maintainer of the project by grant, else `fallback` (the first org owner). */
async function otherMaintainer(deps: Deps, orgId: OrgId, project: string, leaving: string, fallback: string): Promise<string> {
  for (const row of await deps.projectMembers.list(orgId, project)) {
    if (row.role === "maintainer" && row.source === "grant" && row.developerId !== leaving) return row.developerId;
  }
  return fallback;
}

/**
 * The chains `from` owns become `to`'s, and the ones whose accountable maintainer `from` is have `replacement` (for the chain's project) instead. Answers who was given
 * a chain, so their cap is looked at.
 */
async function moveChains(
  deps: Deps, orgId: OrgId, from: string, to: string, replacement: (project: string) => Promise<string>, cause: MoveCause,
): Promise<readonly string[]> {
  const chains = deps.chains;
  if (chains === undefined) return [];
  const took = new Set<string>();
  for (const listed of await chains.list(orgId)) {
    const ownedByFrom = listed.owner.kind === "member" && listed.owner.developerId === from;
    const accountableFrom = listed.accountable?.developerId === from;
    if (!ownedByFrom && !accountableFrom) continue;
    checkTime(deps);
    await untilSettled(async () => {
      const chain = await chains.get(orgId, listed.chainId);
      if (chain === undefined) return;
      if (chain.owner.kind === "member" && chain.owner.developerId === from) {
        await chains.setOwner(orgId, chain.chainId, { kind: "member", developerId: to }, SYSTEM, undefined, undefined, { cause });
        took.add(to);
      } else if (chain.owner.kind === "project" && chain.accountable?.developerId === from) {
        const next = await replacement(chain.owner.project);
        await chains.setAccountable(orgId, chain.chainId, { developerId: next }, SYSTEM, undefined, { cause });
        took.add(next);
      }
    });
  }
  return [...took];
}

/** A member was removed: see the top of this file. `successorId` is the first owner of the org. */
export function onChainOwnersRemoved(deps: Deps, removal: { orgId: OrgId; developerId: string; successorId: string }): Promise<readonly string[]> {
  const { orgId, developerId, successorId } = removal;
  // Their shares are deleted and not handed to the owner, who already manages what they took over.
  return moveChains(deps, orgId, developerId, successorId, (project) => otherMaintainer(deps, orgId, project, developerId, successorId), { kind: "member_removed", developerId });
}

/** The shares of a removed member are dropped by the cut-off, which runs also after a rejoin (a share carries no time, so all of them go). */
export function onChainSharesCutOff(deps: Deps, cut: { orgId: OrgId; developerId: string }): Promise<void> {
  return dropShares(deps, cut.orgId, cut.developerId, { kind: "member_removed", developerId: cut.developerId });
}

/** Two accounts were found to be one person: the duplicate's chains, accountable ids and shares become the survivor's. */
export function onChainOwnersMerged(deps: Deps, merge: { orgId: OrgId; survivorId: string; duplicateId: string }): Promise<readonly string[]> {
  const { orgId, survivorId, duplicateId } = merge;
  const cause: MoveCause = { kind: "member_merged", developerId: duplicateId };
  return moveChains(deps, orgId, duplicateId, survivorId, async () => survivorId, cause).then(async (took) => {
    await moveShares(deps, orgId, duplicateId, survivorId, cause);
    return took;
  });
}

/** The shares naming `from` become `to`'s (a merge). */
async function moveShares(deps: Deps, orgId: OrgId, from: string, to: string, cause: MoveCause): Promise<void> {
  const chains = deps.chains;
  if (chains === undefined) return;
  for (const chainId of await chains.listSharedWith(orgId, principal(from))) {
    checkTime(deps);
    await chains.reassignShare({ orgId, chainId, from: principal(from), to: principal(to), by: SYSTEM, cause });
  }
}

/** What `moveChains` leaves of a removed member's shares: they are dropped. (For a merge the shares moved with the chains.) */
async function dropShares(deps: Deps, orgId: OrgId, developerId: string, cause: MoveCause): Promise<void> {
  const chains = deps.chains;
  if (chains === undefined) return;
  for (const chainId of await chains.listSharedWith(orgId, principal(developerId))) {
    checkTime(deps);
    await chains.reassignShare({ orgId, chainId, from: principal(developerId), by: SYSTEM, cause });
  }
}

/** Registers the chain movers with Plan 3's member lifecycle. Safe to call more than once. */
export function registerChainMovers(): () => void {
  return registerMemberMover({
    name: "chains",
    merged: (deps, merge) => onChainOwnersMerged(deps, merge),
    removed: (deps, removal) => onChainOwnersRemoved(deps, removal),
    cutOff: (deps, cut) => onChainSharesCutOff(deps, cut),
  });
}

registerChainMovers();
