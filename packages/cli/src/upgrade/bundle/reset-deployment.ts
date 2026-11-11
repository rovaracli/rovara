// Enterprise foundations, N6 fix round 2 (review N8): a deployment that failed and whose bundle was then withdrawn leaves a progress record that makes the deployer refuse
// every other bundle. Only the customer's administrators (the operator role has no Parameter Store access) clear it, with this command.
import { DEPLOY_LOCK_STALE_MS, deployLockParameter, deployProgressParameter } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import type { ParameterStore } from "../../environments/parameter-store.js";

export interface ResetOutcome {
  /** The bundle the cleared progress record belonged to, or undefined if there was none. */
  bundleId: string | undefined;
  clearedProgress: boolean;
  clearedLock: boolean;
}

export async function resetDeployment(input: { store: ParameterStore; env: string; now: number }): Promise<ResetOutcome> {
  const progress = await input.store.get(deployProgressParameter(input.env));
  const lock = await input.store.get(deployLockParameter(input.env));
  // A run that holds a live lock is working now: clearing under it would let a second run start. A lock that cannot be read has no date to go by and is what this command is for.
  if (lock !== undefined) {
    let startedAt: number | undefined;
    try {
      startedAt = (JSON.parse(lock.value) as { startedAt?: unknown }).startedAt as number | undefined;
    } catch {
      startedAt = undefined;
    }
    if (typeof startedAt === "number" && input.now - startedAt < DEPLOY_LOCK_STALE_MS) {
      throw agentXError("CONFIG_INVALID", `a deployer run took its lock ${Math.max(0, Math.round((input.now - startedAt) / 60_000))} minutes ago and may still be working; nothing was cleared. Try again after ${Math.ceil(DEPLOY_LOCK_STALE_MS / 60_000)} minutes from its start, or when its log shows it ended`);
    }
  }
  let bundleId: string | undefined;
  try {
    bundleId = progress === undefined ? undefined : (JSON.parse(progress.value) as { bundleId?: string }).bundleId;
  } catch {
    bundleId = undefined;
  }
  if (progress !== undefined) await input.store.delete(deployProgressParameter(input.env));
  if (lock !== undefined) await input.store.delete(deployLockParameter(input.env));
  return { bundleId, clearedProgress: progress !== undefined, clearedLock: lock !== undefined };
}
