// TE-F1e item 7 (the broker send, its OWN commit so 7a can hold it back one release: DECISIONS 152, the worker advertises one release before the broker sends): the model plan a CHECKS round's task invocation
// carries, minted by the dispatcher at delivery. The capability names the operation only; the company comes from the workspace's own record, and the plan is made only while that company's productModels gate is
// on. Any failure is no plan: the round runs as today ("Not run", zero calls). Not wired in dispatcher.ts until F1-d's gate name is on the base (unwired by default).
import type { OrgId } from "@rovara-code/contracts";
import type { ProductModelPlan } from "@agentx/cloud-contracts";
import { MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS, signModelEgressCapability, type ModelEgressSigner } from "./capability.js";
import type { ProductModelsGate } from "./seams.js";

export interface ProductModelPlannerInput {
  /** KMS Sign with the product model egress key (not the invoke key). */
  readonly sign: ModelEgressSigner;
  readonly functionArn: string;
  readonly gate: ProductModelsGate;
  /** The workspace's company, from its own record. */
  readonly orgOf: (workspaceId: string) => Promise<OrgId | undefined>;
  readonly now: () => number;
}

export type ProductModelPlanner = (operation: { readonly workspaceId: string; readonly operationId: string; readonly fence: number }) => Promise<ProductModelPlan | undefined>;

export function createProductModelPlanner(input: ProductModelPlannerInput): ProductModelPlanner {
  return async (operation) => {
    try {
      const orgId = await input.orgOf(operation.workspaceId);
      if (orgId === undefined || !(await input.gate(orgId))) return undefined;
      const capability = await signModelEgressCapability({
        v: 1, purpose: "task", workspaceId: operation.workspaceId, operationId: operation.operationId, fence: operation.fence,
        expiresAt: Math.floor(input.now() / 1000) + MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS,
      }, input.sign);
      return { capability, functionArn: input.functionArn };
    } catch {
      return undefined;
    }
  };
}
