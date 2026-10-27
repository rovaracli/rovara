// Playbook P1: what the Proof section needs from storage, read where the version 2 description is built or rewritten: the approved plan (when it is a structured one with claims), the rows of the task's
// browser and API round for the current code, and the test proof (does a new test fail on the original code?). Informational: a fault in any of them only leaves that input out, so the description is
// published without it; none of them can block a pull request or change a verdict.
import type { E2EScenarioResults, WorkflowSnapshot } from "@agentx/contracts";
import type { TestProofActions } from "../developer/test-proof-lines.js";
import type { LoadedDocument } from "../developer/plan-artifacts.js";
import type { ProofContext } from "./proof-section.js";
import { loadTestProof } from "./test-proof-reader.js";

export interface ProofInputsDeps {
  actions: TestProofActions;
  /** The task's browser and API rows; read only when the workflow requires that round. */
  scenarioResults?: (() => Promise<E2EScenarioResults | undefined>) | undefined;
}

/** The Proof section's inputs for a version 2 workflow, or undefined when there is no approved structured plan with claims (nothing is read then, and the description has no Proof section). */
export async function loadProofContext(
  deps: ProofInputsDeps, task: { ownerKey: string; workspaceId: string }, workflow: WorkflowSnapshot, approvedPlan: LoadedDocument | undefined,
): Promise<ProofContext | undefined> {
  const plan = approvedPlan?.format === "structured" ? approvedPlan.plan : undefined;
  if (plan === undefined || plan.claims.length === 0) return undefined;
  const testProof = await loadTestProof(deps.actions, task, workflow.candidate?.digest);
  let scenarioRows: ProofContext["scenarioRows"];
  if (workflow.e2e?.required === true && deps.scenarioResults !== undefined) {
    try { scenarioRows = (await deps.scenarioResults())?.scenarios; } catch { scenarioRows = undefined; }
  }
  return { plan, ...(scenarioRows === undefined ? {} : { scenarioRows }), ...(testProof === undefined ? {} : { testProof }) };
}
