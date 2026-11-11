// The two budget questions the older tests ask, put to Task 31's functions: may this member (or, with none, the org alone) start work, and what may the
// task's next key spend. `admitWork` and `mintOperationKey` take a payer, a place and the run's limits; these take the three things those tests always named.
import { ROVARA_CODE_AGENT_ID, type OrgId } from "@rovara-code/contracts";
import type { AdmissionDependencies, BudgetDependencies, SpendPath } from "../../packages/broker/src/org/budget.js";
import { admitWork } from "../../packages/broker/src/spend/admission.js";
import { mintOperationKey } from "../../packages/broker/src/spend/admission.js";

/** Whether `developerId` (or, with none, the org alone: Slack work of an unlinked requester) may start `path` work in the `web` project. */
export function admitMember(deps: AdmissionDependencies, input: { orgId: OrgId; developerId?: string | undefined; path: SpendPath }): Promise<{ maxBudgetUsd: number }> {
  return admitWork(deps, {
    orgId: input.orgId, project: "web", agentId: ROVARA_CODE_AGENT_ID, agentName: "Rovara Code", path: input.path,
    payer: input.developerId === undefined ? { kind: "project", project: "web" } : { kind: "member", developerId: input.developerId },
  });
}

/** What a task of `budgetUsd` whose earlier keys are `previousKeyIds` may spend on its next key (the key is minted, as `mintOperationKey` does). */
export async function nextKeyCap(
  deps: BudgetDependencies, input: { orgId: OrgId; developerId?: string | undefined; budgetUsd: number; previousKeyIds: readonly string[]; budgetBaselineUsd?: number | undefined },
): Promise<{ maxBudgetUsd: number }> {
  const minted = await mintOperationKey(deps, {
    orgId: input.orgId, ...(input.developerId === undefined ? {} : { developerId: input.developerId }), refId: "task-1", ttlSeconds: 3600,
    runLimitUsd: input.budgetUsd, stopAtUsd: input.budgetUsd, taskKeyIds: input.previousKeyIds,
    ...(input.budgetBaselineUsd === undefined ? {} : { budgetBaselineUsd: input.budgetBaselineUsd }),
  });
  if (minted.outcome !== "minted") throw new Error("the key was not recorded");
  return { maxBudgetUsd: minted.maxBudgetUsd };
}
