// Enterprise foundations P4: the plug-ins the broker registers. GitHub is the code host (wrapping the existing GitHub App provider, which is not edited) and GitHub
// Actions and CodeBuild are the check runners. The router and the runners are given to the broker beside the old `githubPullRequests` name, which stays as an alias
// for one release so the consumers keep compiling until tasks P5a to P5e move them to the port.
import type { EditionPolicy } from "@agentx/cloud-contracts";
import type { CodeBuildGateway } from "../../codebuild.js";
import { githubActionsCheckRunner, type GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import { codeBuildCheckRunner } from "../../plugins/check-runner/codebuild/index.js";
import { githubCodeHost, type GitHubCodeHostProvider } from "../../plugins/code-host/github/index.js";
import { createPluginRegistry, type PluginRegistry } from "../../plugins/registry.js";

export function createBrokerPlugins(input: {
  provider: GitHubCodeHostProvider & GitHubActionsProvider;
  /** The credential reference the GitHub App provider was configured with (GITHUB_APP_CREDENTIAL_REF). */
  credentialRef: string;
  codeBuild: CodeBuildGateway;
  /** P6: the GitHub App's webhook secret, so the code host can verify and normalise a delivery. */
  webhookSecret?: (options?: { refresh?: boolean }) => Promise<string>;
  policy?: EditionPolicy;
}): PluginRegistry {
  return createPluginRegistry({
    codeHosts: [githubCodeHost(input.provider, { credentialRef: input.credentialRef, ...(input.webhookSecret === undefined ? {} : { webhookSecret: input.webhookSecret }) })],
    checkRunners: [
      { kind: "github-actions", create: () => githubActionsCheckRunner(input.provider) },
      { kind: "codebuild", create: (context) => codeBuildCheckRunner({ gateway: input.codeBuild, allowedRepositories: context.allowedRepositories }) },
    ],
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
}
