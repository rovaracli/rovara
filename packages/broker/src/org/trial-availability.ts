// Enterprise foundations E3: the free trial, the GitHub-account claim that unlocks it and the trial state shown to the person exist only where the edition has trial and
// billing (Public). An install with no edition (deployed before editions) keeps today's behaviour, which is decided by its own cloud flag.
import type { EditionPolicy } from "@agentx/cloud-contracts";

export function trialAvailable(policy: EditionPolicy | undefined): boolean {
  return policy === undefined || policy.features.trialAndBilling;
}
