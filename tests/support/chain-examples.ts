// Plan 4: the worked example "investigate, then fix", as a chain design. Tasks 2, 6, 7, 8 and 10 use it as a fixture.
import type { ChainDefinitionInput } from "@rovara-code/contracts";

/**
 * A Root-cause analyst finds the cause and picks `fix` or `no_fix`; on `fix` a gate asks the starter or a maintainer; Rovara Code
 * fixes it; the Code reviewer reads the pull request. The design as a person writes it (every version is "current" until publish pins it).
 */
export const INVESTIGATE_THEN_FIX: ChainDefinitionInput = {
  start: "investigate",
  steps: [
    {
      kind: "agent",
      id: "investigate",
      name: "Find the cause",
      agent: { agentId: "root-cause-analyst", version: "current" },
      next: {
        kind: "branch",
        default: "no_fix",
        choices: [
          { id: "fix", description: "The cause is in our code and a code change fixes it", to: "approve_fix" },
          { id: "no_fix", description: "Not a code problem, or not enough evidence", to: "$end" },
        ],
      },
    },
    {
      kind: "gate",
      id: "approve_fix",
      name: "Approve the fix",
      prompt: "Should Rovara Code fix this?",
      approvers: [{ kind: "starter" }, { kind: "project_maintainers" }],
      onApprove: { to: "fix" },
      onReject: { to: "$end" },
    },
    {
      kind: "agent",
      id: "fix",
      name: "Fix it",
      agent: { agentId: "rovara-code", version: "current" },
      instructions: "Fix the cause the investigation found. Keep the change small.",
      next: { kind: "go", to: "review" },
    },
    {
      kind: "agent",
      id: "review",
      name: "Review the pull request",
      agent: { agentId: "code-reviewer", version: "current" },
      next: { kind: "end" },
    },
  ],
  limits: { maxRunUsd: 30 },
};
