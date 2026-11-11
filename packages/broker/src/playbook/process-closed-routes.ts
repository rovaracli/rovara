// "How we work" (H8): a project's process layer is edited only through How we work and runs only as the project's way of working. The general agent routes must not act on it either:
// no share write (the project's people already have it through the project), no owner or accountable move by a person (it belongs to its project), and no other agent built on it.
// Each check is one call from the store, where every route and confirmation lands. Ordinary agents are unchanged.
import { agentXError } from "@rovara-code/contracts";

export const PROCESS_SHARE_MESSAGE = "How we work is shared with the project's people already; it can't be shared separately.";
export const PROCESS_OWNER_MESSAGE = "How we work belongs to its project.";
export const PROCESS_BASE_USE_MESSAGE = "An agent can't be built on a project's How we work.";

const isProcess = (agent: { purpose?: string | undefined } | undefined): boolean => agent?.purpose === "process";

/** Refuses (CONFIG_INVALID, 400) any share write on a process layer. Reading who can see it is not a write. */
export function requireNoSharesOnProcess(agent: { purpose?: string | undefined } | undefined): void {
  if (isProcess(agent)) throw agentXError("CONFIG_INVALID", PROCESS_SHARE_MESSAGE);
}

/**
 * Refuses (CONFIG_INVALID, 400) a person's owner or accountable-person change on a process layer. Rovara's own lifecycle moves (a member merged, removed or no longer a maintainer) carry
 * a `cause` and go through: the layer must keep an accountable person who is still there.
 */
export function requireNoOwnerMoveOnProcess(agent: { purpose?: string | undefined } | undefined, options: { cause?: unknown } | undefined): void {
  if (isProcess(agent) && options?.cause === undefined) throw agentXError("CONFIG_INVALID", PROCESS_OWNER_MESSAGE);
}

/** Refuses (CONFIG_INVALID, 400) building another agent on `base` when `base` is a process layer. A built-in or an unknown base (`undefined`) passes; the caller reads the base itself. */
export function requireBaseIsNotProcess(base: { purpose?: string | undefined } | undefined): void {
  if (isProcess(base)) throw agentXError("CONFIG_INVALID", PROCESS_BASE_USE_MESSAGE);
}
