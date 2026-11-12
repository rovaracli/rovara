// Lane A9: Cloud's GitHub App code host (`packages/broker/src/plugins/code-host/github`, over Cloud's `GitHubAppCredentialProvider`) under Code's CodeHost suite. Webhook deliveries
// (P6, `events.normalise`) are signed the way GitHub signs them with a secret made at run time.
import { githubCodeHost } from "../../../packages/broker/src/plugins/code-host/github/index.js";
import { githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../../../vendor/rovara-code/tests/support/ports/github-deliveries.js";
import type { CodeHostWorld } from "../../../vendor/rovara-code/tests/support/ports/code-host-conformance.js";
import { defineCloudAdapter } from "../registry.js";
import { GITHUB_NOW, GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi, cloudProviderOver, githubModel, workingBranch } from "./github-app-world.js";

export function githubAppCodeHostWorld(): CodeHostWorld & { api: GitHubFixtureApi } {
  const model = githubModel();
  const api = new GitHubFixtureApi(model);
  const host = githubCodeHost(cloudProviderOver(api), { credentialRef: "github", now: () => GITHUB_NOW, webhookSecret: webhookSecretReader() });
  return {
    host, model, api, repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, now: () => GITHUB_NOW, branch: workingBranch,
    signedDelivery: (event) => event.kind === "change_request.opened"
      ? githubDelivery("pull_request", githubPayloads.pullRequest("opened", Number(event.id)))
      : githubDelivery("push", githubPayloads.push(`refs/heads/${event.branch}`, event.revision)),
    forgedDelivery: () => githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { signature: signGithubBody("{}") }),
    limitReads: (retryAt) => { api.limitReadsFor((retryAt - GITHUB_NOW) / 1_000); },
  };
}

export const githubAppCodeHost = defineCloudAdapter({
  port: "code-host",
  name: "GitHub App",
  harness: { makeWorld: githubAppCodeHostWorld },
});
