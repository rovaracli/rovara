// E2E (area 10): the verdict path on the evidence a worker returns. Live application checks need a browser and the app running, which neither journey can do on
// fakes; what both copies decide from a CHECKS operation's admission and evidence is compared instead: `verifyWorkflowE2EEvidence` on the same task,
// operation, candidate and stored objects, answered as the verdict and the diagnostic reason. Each engine stores the admission text in its own object store
// (helper `putObject(key, text)`: S3 on Cloud's side, the ObjectStorage port on the core's) under the same key.
import { createHash } from "node:crypto";
import { createCandidateManifest } from "@rovara-code/contracts";
import type { DecisionCase, DecisionKit } from "./decision.js";

const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const TASK_ID = "4b0d7d0e-0f3e-4d8a-9a51-6f1a2b3c4d5e";
/** A task in VERIFY with the round the operation names; `null`: a task with no workflow at all. */
const task = (e2e: Record<string, unknown> | null = { currentRoundId: "r1", currentGroupRunIds: ["g1"] }) => ({ taskId: TASK_ID, ...(e2e === null ? {} : { workflow: { stage: "VERIFY", state: "RUNNING", revision: 4, e2e } }) });

const refOf = (key: string, text: string) => ({ key, sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text) });
const admission = (patch: Record<string, unknown> = {}, ref = refOf("workflow-e2e-admission/a.json", "{}")) => ({
  taskId: TASK_ID, candidateDigest: candidate.digest, roundId: "r1", groupRunIds: ["g1"], admissionRef: ref, ...patch,
});
const operation = (reference: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({ operationId: "op-1", status: "RUNNING", ...(reference === undefined ? {} : { workflowE2EAdmission: reference }), ...extra });
const verify = (label: string, args: (kit: DecisionKit) => Promise<readonly unknown[]> | readonly unknown[]): DecisionCase => ({ fn: "verifyWorkflowE2EEvidence", label, args });
const put = async (kit: DecisionKit, key: string, text: string) => { await (kit.helpers.putObject as (key: string, text: string) => Promise<void>)(key, text); return refOf(key, text); };

export const E2E_CASES: readonly DecisionCase[] = [
  verify("workflow-missing", () => [operation(admission()), task(null), candidate]),
  verify("baseline-purpose", () => [operation(admission({ purpose: "baseline" })), task(), candidate]),
  verify("replay-purpose", () => [operation(admission({ purpose: "replay" })), task(), candidate]),
  verify("grounding-purpose", () => [operation(admission({ purpose: "grounding" })), task(), candidate]),
  verify("no-admission", () => [operation(undefined), task(), candidate]),
  verify("other-candidate", () => [operation(admission({ candidateDigest: "f".repeat(64) })), task(), candidate]),
  verify("other-round", () => [operation(admission({ roundId: "r0" })), task(), candidate]),
  verify("admission-not-stored", () => [operation(admission({}, refOf("workflow-e2e-admission/missing.json", "{}"))), task(), candidate]),
  verify("admission-digest-wrong", async (kit) => {
    const ref = await put(kit, "workflow-e2e-admission/tampered.json", "{\"schemaVersion\":1}");
    return [operation(admission({}, { ...ref, sha256: "0".repeat(64) })), task(), candidate];
  }),
  verify("stale-projection-other-round", async (kit) => {
    const ref = await put(kit, "workflow-e2e-admission/stale.json", "{}");
    return [operation(admission({ roundId: "r0" }, ref)), task(), candidate, { results: [], allowStaleProjection: true }];
  }),
  verify("application-plan-portable-admission", async (kit) => {
    const ref = await put(kit, "workflow-e2e-admission/portable.json", "{\"schemaVersion\":1}");
    return [operation(admission({}, ref)), task({ currentRoundId: "r1", currentGroupRunIds: ["g1"], applicationSelection: { scenarios: ["checkout"] } }), candidate];
  }),
  verify("portable-admission-unreadable-shape", async (kit) => {
    const ref = await put(kit, "workflow-e2e-admission/shape.json", "{\"schemaVersion\":1,\"unexpected\":true}");
    return [operation(admission({}, ref)), task(), candidate];
  }),
];
