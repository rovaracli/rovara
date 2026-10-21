// Plan 3 Task 9: the org's skills registry. A skill is a SKILL.md an agent can read; an agent version pins the digest of each skill it
// uses when it is published, and a running step reads exactly those pinned contents through the internal route.
import { describe, expect, it } from "vitest";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { workspaceId: string; operationId: string; fence: number; actions: string[]; expiresAt: number };
const signing = { callbackSigningKey: "test-signing-key" };
const BASE = ["artifacts", "events", "result"];

describe("issueCapability", () => {
  it("grants the three base actions and nothing else by default", () => {
    expect(claimsOf(issueCapability(signing, "ws", "op", 3)).actions).toEqual(BASE);
    expect(claimsOf(issueCapability(signing, "ws", "op", 3, {})).actions).toEqual(BASE);
  });

  it("keeps the workspace, operation and fence in the claims and signs the body", () => {
    const token = issueCapability(signing, "ws-1", "op-1", 7);
    expect(claimsOf(token)).toMatchObject({ workspaceId: "ws-1", operationId: "op-1", fence: 7 });
    expect(token.split(".")).toHaveLength(2);
  });

  it.each([
    ["pullRequest", ["pull-request", "pull-request-update", "codebuild"]],
    ["feedbackBundles", ["feedback-bundles"]],
    ["feedbackApproval", ["feedback-approval"]],
    ["chatGptToken", ["chatgpt-token", "chatgpt-status"]],
    ["candidateExport", ["candidate-export"]],
    ["workflowE2E", ["e2e-admission", "e2e-evidence"]],
    ["modelAccess", ["model-access"]],
    ["agentSkills", ["agent-skills"]],
  ] as const)("%s adds its own actions and no others", (flag, added) => {
    const actions = claimsOf(issueCapability(signing, "ws", "op", 1, { [flag]: true })).actions;
    expect(actions.slice(0, 3)).toEqual(BASE);
    expect([...actions].sort()).toEqual([...BASE, ...added].sort());
  });

  it("a flag set to false adds nothing", () => {
    expect(claimsOf(issueCapability(signing, "ws", "op", 1, { pullRequest: false, agentSkills: false, modelAccess: false })).actions).toEqual(BASE);
  });

  it("lists every action in the order the positional flags always produced (the task capability of a workflow step)", () => {
    const all = issueCapability(signing, "ws", "op", 1, {
      pullRequest: true, feedbackBundles: true, feedbackApproval: true, chatGptToken: true, candidateExport: true, workflowE2E: true, modelAccess: true, agentSkills: true,
    });
    expect(claimsOf(all).actions).toEqual([
      "artifacts", "events", "result",
      "candidate-export", "e2e-admission", "e2e-evidence", "feedback-bundles", "feedback-approval", "chatgpt-token", "chatgpt-status", "model-access",
      "pull-request", "pull-request-update", "codebuild",
      "agent-skills",
    ]);
  });
});
