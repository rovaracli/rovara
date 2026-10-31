// Enterprise foundations, N6 fix round 2 (review N8): a deployment that failed and whose bundle was then withdrawn leaves a progress record that makes the deployer refuse
// every other bundle. Only the customer's administrators (the operator role has no Parameter Store access) clear it, with this command.
import { deployLockParameter, deployProgressParameter } from "@agentx/contracts";
import type { ParameterStore } from "../../environments/parameter-store.js";

export interface ResetOutcome {
  /** The bundle the cleared progress record belonged to, or undefined if there was none. */
  bundleId: string | undefined;
  clearedProgress: boolean;
  clearedLock: boolean;
}

export async function resetDeployment(input: { store: ParameterStore; env: string }): Promise<ResetOutcome> {
  const progress = await input.store.get(deployProgressParameter(input.env));
  const lock = await input.store.get(deployLockParameter(input.env));
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
