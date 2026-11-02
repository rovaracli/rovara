// Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). It reads the pack kept for exactly this code through the
// evidence port, which exists only while the proof switch is on: with the switch off there is no port, nothing is read, and the risk is what it was before evidence existed. A fault only means no signal.
import { proofEvidenceEnabled } from "../../proof/switch.js";
import { evidenceIsFor, workflowSelectedChecks, type WorkflowCheckPolicy } from "@agentx/contracts";
import { evidenceRiskSignal, type EvidenceRiskSignal } from "../../rovara-code/evidence-risk.js";
import type { EvidencePort, EvidenceTaskKey } from "./evidence-port.js";

/** The ids (as the worker reports them, `readiness:<index>` in selected order) of the security checks the approved policy selects: a scan was expected from each. */
export function securityCheckIdsOf(policy: WorkflowCheckPolicy | undefined): string[] {
  return workflowSelectedChecks(policy).flatMap((check, index) => (check.kind === "security" ? [`readiness:${String(index)}`] : []));
}

/**
 * The risk signal for this code. `securityChecks` (see `securityCheckIdsOf`): with a security check in the approved policy, a scan that could not be checked is `evidenceUnavailable` and risk.ts makes the change at least
 * medium, never silently low. That is: no pack for exactly this code could be had (never kept, the 6 s read timed out, the store failed, a pack of other code), or the pack has no findings for one of those checks (they were
 * dropped as inconsistent or untrusted, or the scan wrote nothing that could be read), or the pack does not hold the check at all. A new high finding in another check still counts. Without a security check in the policy a
 * missing pack is no signal, as before.
 *
 * `port === undefined` means the proof switch is off, or a caller that was never given the port: with the switch on (`switchOn`) and a security check expected the second reading is the one that must not look Low.
 */
export async function evidenceRiskOfTask(port: Pick<EvidencePort, "pack"> | undefined, task: EvidenceTaskKey, candidateDigest: string | undefined, securityChecks: readonly string[] = [], switchOn: boolean = proofEvidenceEnabled()): Promise<EvidenceRiskSignal | undefined> {
  if (candidateDigest === undefined) return undefined;
  const unavailable: EvidenceRiskSignal | undefined = securityChecks.length > 0 ? { highNewFindings: 0, evidenceUnavailable: true } : undefined;
  if (port === undefined) return switchOn ? unavailable : undefined;
  try {
    const pack = await port.pack(task, candidateDigest);
    if (pack === undefined || !evidenceIsFor(pack, candidateDigest)) return unavailable;
    const signal = evidenceRiskSignal(pack, candidateDigest);
    const unchecked = securityChecks.some((id) => pack.checks.find((check) => check.checkId === id)?.findings === undefined);
    return unchecked ? { highNewFindings: signal?.highNewFindings ?? 0, ...(signal?.unverifiedHighFindings === undefined ? {} : { unverifiedHighFindings: signal.unverifiedHighFindings }), evidenceUnavailable: true } : signal;
  } catch { return unavailable; }
}
