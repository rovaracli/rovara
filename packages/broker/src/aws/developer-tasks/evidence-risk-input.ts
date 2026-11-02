// Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). It reads the pack kept for exactly this code through the
// evidence port, which exists only while the proof switch is on: with the switch off there is no port, nothing is read, and the risk is what it was before evidence existed. A fault only means no signal.
import { evidenceIsFor, workflowSelectedChecks, type WorkflowCheckPolicy } from "@agentx/contracts";
import { evidenceRiskSignal, type EvidenceRiskSignal } from "../../rovara-code/evidence-risk.js";
import type { EvidencePort, EvidenceTaskKey } from "./evidence-port.js";

/** Whether the approved check policy selects a check of kind `security`: then a scan was expected to run, and a missing pack means it could not be checked. */
export function securityCheckExpected(policy: WorkflowCheckPolicy | undefined): boolean {
  return workflowSelectedChecks(policy).some((check) => check.kind === "security");
}

/**
 * The risk signal for this code. `securityExpected` (see `securityCheckExpected`): with the switch on and a security check in the policy, a pack that cannot be had for exactly this code (not kept, the 6 s read timed out, the
 * store failed, or a pack of other code) is `evidenceUnavailable` and risk.ts makes the change at least medium. Without a security check in the policy a missing pack is no signal, as before. A fault in the read is never a
 * way to look Low.
 */
export async function evidenceRiskOfTask(port: Pick<EvidencePort, "pack"> | undefined, task: EvidenceTaskKey, candidateDigest: string | undefined, securityExpected = false): Promise<EvidenceRiskSignal | undefined> {
  if (port === undefined || candidateDigest === undefined) return undefined;
  const unavailable: EvidenceRiskSignal | undefined = securityExpected ? { highNewFindings: 0, evidenceUnavailable: true } : undefined;
  try {
    const pack = await port.pack(task, candidateDigest);
    if (pack === undefined || !evidenceIsFor(pack, candidateDigest)) return unavailable;
    return evidenceRiskSignal(pack, candidateDigest);
  } catch { return unavailable; }
}
