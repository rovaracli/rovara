// Workflow artifact schema: a structured plan artifact with evidence, and the block reason for an unreadable plan.

import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WorkflowArtifactSchema } from "@agentx/contracts";

describe("WorkflowArtifactSchema", () => {
  const artifact = {
    id: "plan-2", type: "plan", version: 2, sha256: "a".repeat(64), producer: "planner", objectKey: "tasks/t1/plan-2.json", createdAt: "2026-10-09T12:00:00.000Z",
  };

  it("accepts a structured artifact with evidence, and a legacy artifact with neither field", () => {
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "structured", evidence: { objectKey: "tasks/t1/plan-2-evidence.json", sha256: "b".repeat(64) } }).success).toBe(true);
    expect(WorkflowArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "markdown" }).success).toBe(true);
  });

  it("refuses evidence without the structured format, and an unsafe evidence key", () => {
    const evidence = { objectKey: "tasks/t1/plan-2-evidence.json", sha256: "b".repeat(64) };
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, evidence }).success).toBe(false);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "markdown", evidence }).success).toBe(false);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "structured", evidence: { ...evidence, objectKey: "../escape" } }).success).toBe(false);
  });

  it("has a block reason for a plan that could not be read", () => {
    expect(WORKFLOW_BLOCK_REASONS.planUnreadable).toBe("the plan couldn't be read");
  });
});
