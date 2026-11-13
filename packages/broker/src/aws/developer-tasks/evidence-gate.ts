// Company rollout gate (TE-A1) on the evidence port: the port is made once for the install, and every read of it is for one task of one company. A company whose `proofEvidence` gate is not on is shown nothing: the same
// as the install's proof switch off for it, instantly. The company is the task's own (`task.orgId`); a task whose company is unknown reads as off. A gate that cannot be read reads as off.
import { companyFeatureOn, type FeatureRolloutDeps } from "../../org/feature-rollout.js";
import type { EvidencePort, EvidenceTaskKey } from "./evidence-port.js";

export function gatedEvidencePort(port: EvidencePort, store: FeatureRolloutDeps, env: NodeJS.ProcessEnv = process.env): EvidencePort {
  const on = (task: EvidenceTaskKey): Promise<boolean> => companyFeatureOn(store, task.orgId, "proofEvidence", env);
  return {
    on,
    scoped: (gates) => gatedEvidencePort(port, { ...store, gates }, env),
    download: port.download,
    async pack(task, digest) { return (await on(task)) ? port.pack(task, digest) : undefined; },
    async context(task, digest) { return (await on(task)) ? port.context(task, digest) : undefined; },
    async view(task, digest) { return (await on(task)) ? port.view(task, digest) : undefined; },
  };
}
