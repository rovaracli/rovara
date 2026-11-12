// Lane A9: Cloud's GitHub Actions check runner (`packages/broker/src/plugins/check-runner/github-actions`, over Cloud's `GitHubAppCredentialProvider`) under Code's CheckRunner suite.
// It lists the checks of a change request only and reads a job's log tail; it starts nothing (Rovara does not start GitHub Actions runs).
import { githubActionsCheckRunner } from "../../../packages/broker/src/plugins/check-runner/github-actions/index.js";
import type { CheckRunnerWorld } from "../../../vendor/rovara-code/tests/support/ports/check-runner-conformance.js";
import { defineCloudAdapter } from "../registry.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi, cloudProviderOver, githubModel, workingBranch } from "./github-app-world.js";

export function githubActionsWorld(): CheckRunnerWorld {
  const model = githubModel();
  const runner = githubActionsCheckRunner(cloudProviderOver(new GitHubFixtureApi(model)));
  return {
    runner, model, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "unit",
    changeRequest: () => {
      const revision = model.commit(workingBranch(1), { "src/a.ts": "export const a = 1;\n" });
      const { cr } = model.reconcile({ sourceBranch: workingBranch(1), targetBranch: "main", title: "t" });
      return { ref: { repository: { url: GITHUB_REPO_URL }, id: cr.id, url: model.crUrl(cr.id) }, revision };
    },
    finishRun: () => { throw new Error("GitHub Actions runs are not started by Rovara"); },
  };
}

export const githubActionsCheckRunnerAdapter = defineCloudAdapter({
  port: "check-runner",
  name: "GitHub Actions",
  harness: { makeWorld: githubActionsWorld },
});
