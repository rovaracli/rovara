// Company rollout gate (TE-A1) on the evidence port: the port is made once for the install, and every read of it is for one task of one company. A company whose `proofEvidence` gate is not on is shown nothing: the same
// as the install's proof switch off for it, instantly. The company is the task's own (`task.orgId`); a task whose company is unknown reads as off. A gate that cannot be read reads as off for what is shown (`pack`, `context`, `view`) and is told apart for the risk: `on` throws then, so the risk reads it as "evidence unavailable" instead of as a gate that is really off.
import { companyFeatureOn, type FeatureRolloutDeps } from "../../org/feature-rollout.js";
import type { EvidencePort, EvidenceTaskKey } from "./evidence-port.js";

export function gatedEvidencePort(port: EvidencePort, store: FeatureRolloutDeps, env: NodeJS.ProcessEnv = process.env): EvidencePort {
  // What is shown: a gate that cannot be read shows nothing. `on` (the risk's question) throws on a failed read instead, so the risk is never silently lower for it.
  const shown = (task: EvidenceTaskKey): Promise<boolean> => companyFeatureOn(store, task.orgId, "proofEvidence", env);
  const on = (task: EvidenceTaskKey): Promise<boolean> => companyFeatureOn(store, task.orgId, "proofEvidence", env, { onReadFailure: "throw" });
  return {
    on,
    scoped: (gates) => gatedEvidencePort(port, { ...store, gates }, env),
    download: port.download,
    async pack(task, digest) { return (await shown(task)) ? port.pack(task, digest) : undefined; },
    async context(task, digest) { return (await shown(task)) ? port.context(task, digest) : undefined; },
    async view(task, digest) { return (await shown(task)) ? port.view(task, digest) : undefined; },
  };
}
