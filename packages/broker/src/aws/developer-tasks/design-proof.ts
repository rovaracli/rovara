// Design review stage, DR7 slice C (DR12 wiring): the two ports `loadProofDesignContext` reads, built from what the broker holds. The design text is the task's latest design document read back through the artifact store
// (and checked against the approved digest by the loader); the approval is the record the design's approval wrote in the SAME transaction as the decision (`design-decision.ts`): the approver's label, the risk tier, the
// open blockers and the cleaned one-line reason. No design review on the task, no approval record or a record that cannot be read gives no context, and the Proof section is exactly what it was.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { WorkflowSnapshot } from "@agentx/cloud-contracts";
import { readLatestDesignText } from "../../design-review/route-facts.js";
import { loadProofDesignContext, type ProofDesignPorts } from "../../design-review/proof-context.js";
import type { ProofDesignContext } from "../../design-review/proof-line.js";
import { designApprovalKey } from "./design-decision.js";

export interface DesignProofReads {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  taskId: string;
  readArtifact(objectKey: string, maxBytes: number): Promise<string>;
}

export function designProofPortsOf(reads: DesignProofReads): ProofDesignPorts {
  return {
    designText: (workflow) => readLatestDesignText(workflow, (key, max) => reads.readArtifact(key, max).catch(() => undefined)),
    async approval(_workflow, designDigest) {
      const found = await reads.documentClient.send(new GetCommand({ TableName: reads.tableName, Key: designApprovalKey(reads.taskId, designDigest), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const item = found.Item;
      if (item === undefined || item["designDigest"] !== designDigest || typeof item["approverLabel"] !== "string") return undefined;
      const tier = item["tier"];
      const blockers = item["openBlockers"];
      if ((tier !== "low" && tier !== "medium" && tier !== "high") || typeof blockers !== "number" || !Number.isInteger(blockers) || blockers < 0) return undefined;
      return { approverLabel: item["approverLabel"], tier, openBlockers: blockers, ...(typeof item["proofReason"] === "string" ? { reason: item["proofReason"] } : {}) };
    },
  };
}

/** The `design` port of `loadProofContext`: the Proof section's design context for a workflow, or undefined. */
export const proofDesignContextOf = (reads: DesignProofReads) => (workflow: WorkflowSnapshot): Promise<ProofDesignContext | undefined> => loadProofDesignContext(designProofPortsOf(reads), workflow);
