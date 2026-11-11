// Plan 4 Task 5: what the spend requests need to know of a chain run, which the chain runner (Task 6) answers from the run's records. A chain step is an
// ordinary task of Plan 3 with `task.chain`; whether a raise it asks for is a run-level raise (it takes the run past the limit it had left when the step
// started) is a fact of the run, not of the task, so the requests ask for it through this seam.
import type { OrgId } from "@rovara-code/contracts";

/** The run's side of one step: the chain it belongs to, and what the run had left of its own limit when the step's task was started (`remainingAtStartUsd`). */
export interface ChainRunStepLimits {
  chainId: string;
  remainingAtStartUsd: number;
}

export interface ChainRunSpendReader {
  /** The limits of a step of a run, or undefined when the run or the step can't be found (the request then fails closed: it is read as a run-level raise). */
  stepLimits(orgId: OrgId, ref: { chainRunId: string; stepId: string }): Promise<ChainRunStepLimits | undefined>;
}
