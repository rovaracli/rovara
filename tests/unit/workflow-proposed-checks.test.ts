// Proposed checks: the planner's `agentx-checks` block, read all or nothing.
import { describe, expect, it } from "vitest";
import { WorkflowCheckPolicySchema, workflowSelectedChecks } from "@agentx/contracts";

describe("workflowSelectedChecks", () => {
  it("lists required, then proposed, then the selected optional checks in project order", () => {
    const command = { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 60 };
    const policy = {
      required: [{ id: "required-1", label: "Required", command }],
      optional: [{ id: "lint", label: "Lint", command }, { id: "e2e", label: "E2E", command }, { id: "docs", label: "Docs", command }],
      selectedOptionalIds: ["docs", "lint"],
      proposed: [{ id: "proposed-1", label: "Proposed", command }],
    };
    expect(workflowSelectedChecks(policy).map((entry) => entry.id)).toEqual(["required-1", "proposed-1", "lint", "docs"]);
    expect(workflowSelectedChecks(undefined)).toEqual([]);
  });

  it("leaves out the proposed checks the owner removed, keeping proposal order", () => {
    const command = { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 60 };
    const proposed = ["proposed-1", "proposed-2", "proposed-3"].map((id) => ({ id, label: id, command }));
    const policy = { required: [], optional: [], selectedOptionalIds: [], proposed, selectedProposedIds: ["proposed-3", "proposed-1"] };
    expect(workflowSelectedChecks(policy).map((entry) => entry.id)).toEqual(["proposed-1", "proposed-3"]);
    expect(WorkflowCheckPolicySchema.safeParse(policy).success).toBe(true);
    // Only ids from the stored proposal, each once.
    expect(WorkflowCheckPolicySchema.safeParse({ ...policy, selectedProposedIds: ["proposed-9"] }).success).toBe(false);
    expect(WorkflowCheckPolicySchema.safeParse({ ...policy, selectedProposedIds: ["proposed-1", "proposed-1"] }).success).toBe(false);
  });
});
