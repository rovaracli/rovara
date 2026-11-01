// Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). It reads the pack kept for exactly this code through the
// evidence port, which exists only while the proof switch is on: with the switch off there is no port, nothing is read, and the risk is what it was before evidence existed. A fault only means no signal.
import { evidenceRiskSignal, type EvidenceRiskSignal } from "../../rovara-code/evidence-risk.js";
import type { EvidencePort, EvidenceTaskKey } from "./evidence-port.js";

export async function evidenceRiskOfTask(port: Pick<EvidencePort, "pack"> | undefined, task: EvidenceTaskKey, candidateDigest: string | undefined): Promise<EvidenceRiskSignal | undefined> {
  if (port === undefined || candidateDigest === undefined) return undefined;
  try { return evidenceRiskSignal(await port.pack(task, candidateDigest), candidateDigest); } catch { return undefined; }
}
