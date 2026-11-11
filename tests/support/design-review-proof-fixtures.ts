// Design review stage, DR12: the plan and workflow the Proof section tests read (the same shapes tests/contract/rovara-code-proof-table.test.ts uses), and a design document.
import { randomUUID } from "node:crypto";
import type { PlanDocument } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { createCandidateManifest } from "@rovara-code/contracts";

const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER_ID = "a".repeat(64);
const NOW = "2026-10-27T12:00:00.000Z";
export const PROOF_CODE = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const command = { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 };
const check = (id: string, label: string) => ({ id, label, command });

/** Claims "1" (child "1.1"), "2", "3". Check `unit` proves 1.1, `lint` proves 2; claim 3 has no check. */
export function proofPlan(): PlanDocument {
  return {
    schemaVersion: 1,
    title: "Retry failed payments",
    why: [{ text: "Failed payments are dropped.", author: "Priya" }],
    claims: [
      { id: "1", text: "Payments that time out are retried.", children: [{ id: "1.1", text: "The retry waits longer each time." }] },
      { id: "2", text: "A payment is never charged twice." },
      { id: "3", text: "The retry count is shown on the payment page." },
    ],
    notChanging: ["The refund flow stays as it is."],
    risks: ["A slow gateway could keep a retry open."],
    decisions: [],
    checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["1.1"], lint: ["2"] } },
  };
}

export function proofWorkflow(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: PROOF_CODE.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW });
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_ID, now: NOW, definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate: PROOF_CODE,
    checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [check("unit", "Unit tests"), check("lint", "Lint")] },
    verification: { candidateDigest: PROOF_CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
    ...extra,
  });
}

/** A design in the fixed template. §3.1 names R1 and R1.1, §3.2 names R2 (and mentions §3.9 in prose, which has no heading), R3 appears only inside a code fence. */
export const DESIGN_TEXT = [
  "# Design: retry failed payments",
  "",
  "## 1. Problem and goal",
  "Covers R1, R2 and R3.",
  "",
  "## 2. Current system",
  "Today a timeout throws (src/charge.ts:10).",
  "",
  "## 3. Proposed design",
  "",
  "### 3.1 Retry queue",
  "R1 is met by a queue. R1.1 is met by exponential backoff.",
  "",
  "### 3.2 Idempotency key",
  "R2 is met by a key per charge. See also §3.9 for the rollout.",
  "",
  "### 3.3 Display",
  "```text",
  "R3 would be shown here",
  "```",
  "",
  "## 4. Alternatives considered",
  "None worth listing. R2 again, outside section 3.",
].join("\n");
