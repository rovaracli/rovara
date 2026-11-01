// Enterprise foundations P5d/P5e: pieces the tests of the broker's task side and route side share. The code host of a repository is found from the project revision a task pinned, so a
// test that reaches a pull request needs the project row; and the code host adapter maps whole pull requests, so a stand-in for GitHub's provider answers whole ones.
import { projectRevisionKey } from "../../packages/contracts/src/index.js";
import { TEST_ORG } from "./orgs.js";

export interface TestRepository { name: string; url: string; role?: "code" | "meta"; host?: { kind: string; ref?: string; installationId?: number; repositoryId?: number } }

/** The stored row of project `name` at `revision`, holding `repositories`. */
export function projectRow(repositories: readonly TestRepository[], name = "demo", revision = 1, orgId = TEST_ORG) {
  return {
    ...projectRevisionKey(orgId, name, revision), entityType: "PROJECT", registeredAt: "2026-10-31T00:00:00.000Z",
    definition: {
      name, revision, setup: [], readiness: [], orchestratorInstructions: "x",
      repositories: repositories.map((repository, index) => ({ name: repository.name, url: repository.url, path: `repo/${String(index)}`, defaultBranch: "main", credentialRef: "github-app", ...(repository.role === undefined ? {} : { role: repository.role }), ...(repository.host === undefined ? {} : { host: repository.host }) })),
    },
  };
}

/** What GitHub's provider returns for a pull request, whole (the adapter maps every field). */
export function pullRequestDetails(number: number, overrides: Partial<{ url: string; state: "open" | "closed" | "merged"; headBranch: string; baseBranch: string; headCommit: string; title: string; body: string }> = {}) {
  return { number, url: `https://github.com/example/demo/pull/${String(number)}`, state: "open" as const, headBranch: "agentx/x", baseBranch: "main", headCommit: "d".repeat(40), title: "t", body: "", ...overrides };
}
