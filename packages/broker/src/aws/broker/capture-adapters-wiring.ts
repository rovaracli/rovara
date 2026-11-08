// Part of the broker: the GitHub code host through the one capture interface learning reads a host by (team-record/sources/capture-adapters.ts). A code-host plug-in builds its own adapter with
// `captureAdapterOf` and is added to the same list (`createTeamRecordRuntime({ captureAdapters })`); nothing else changes.
//   - pull request comments: listed through the `CodeHost` port's `feedback` read (the words and the people come from the Team record);
//   - human fix-up commits: a compare of two commits read with a `contents: read` installation token (`github-app.ts getRepositoryCompareJson`);
//   - the merge commit: from GitHub's own pull request event.
import type { GitHubTokenScope } from "../../github-app.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import { changeRequestRef } from "../../rovara-code/host-port.js";
import { captureAdapterOf, githubPullRequestAddress, type CodeHostCaptureAdapter } from "../../team-record/sources/capture-adapters.js";
import { createGithubDiffReader } from "../../team-record/sources/github.js";
import type { CodeHost } from "@agentx/contracts";

export function githubCaptureAdapter(input: {
  provider: { getRepositoryCompareJson(repositoryUrl: string, apiPath: string, scope: GitHubTokenScope): Promise<{ status: number; body: unknown }> };
  codeHost: Pick<CodeHost, "feedback">;
  /** A cloud install mints every token for one company; a private install has one system scope. */
  cloud: boolean;
}): CodeHostCaptureAdapter {
  const scopeOf = (workspaceId: string): GitHubTokenScope => (input.cloud ? { orgId: workspaceId } : { system: "private-install" });
  const diffs = createGithubDiffReader(async (path, context) => (context === undefined
    ? { status: 0, body: undefined }
    : input.provider.getRepositoryCompareJson(`https://github.com/${context.fullName}`, path, scopeOf(context.workspaceId))));
  return captureAdapterOf({
    host: GITHUB_HOST_KIND, codeHost: input.codeHost, pullRequestAddress: githubPullRequestAddress, repositoryAddress: (fullName) => `https://github.com/${fullName}`,
    refOf: (address) => changeRequestRef(`https://github.com/${address.repository}`, address.number), scopeOf, diffs,
  });
}
