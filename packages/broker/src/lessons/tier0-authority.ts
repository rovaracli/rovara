// Learning v2 wiring: the production `Tier0Authority`. It asks the shared second-person evidence reader (org/second-person-evidence.ts, the one project-allowed-domains and the other
// approval flows use) who may act, and hands back the commit conditions that pin both people's live authority and the company's membership generation. The setting write carries them
// (`Tier0Fence`), so a person added or removed between this read and the write stops the change.
import { readSecondPersonApprovalEvidence, type SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import type { Tier0Authority } from "./sole-owner-switch.js";

export function secondPersonTier0Authority(deps: SecondPersonEvidenceDependencies): Tier0Authority {
  return {
    async eligibility(scope, who) {
      const evidence = await readSecondPersonApprovalEvidence(deps, {
        orgId: scope.workspaceId, ...(scope.kind === "project" ? { project: scope.project } : {}), proposerId: who.proposerId, approverId: who.approverId,
      });
      const input = evidence.decisionInput;
      return {
        complete: input.complete, membershipVersion: input.membershipVersion, ownerIds: [...input.ownerIds], eligibleIds: [...input.eligibleIds],
        lastEligibleLossAtMs: input.lastEligibleLossAtMs, fence: evidence.conditions,
      };
    },
  };
}
