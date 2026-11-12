// Lane A9: Cloud's CodeBuild check runner (`packages/broker/src/plugins/check-runner/codebuild`, over Cloud's `CodeBuildGateway`) under Code's CheckRunner suite. The gateway is an
// in-memory CodeBuild (no AWS): a build per idempotency token, read again by its id, finished by the world.
import type { CodeBuildCheckResult } from "@rovara-code/contracts";
import type { CodeBuildGateway } from "../../../packages/broker/src/codebuild.js";
import { codeBuildCheckRunner } from "../../../packages/broker/src/plugins/check-runner/codebuild/index.js";
import type { CheckRunnerWorld } from "../../../vendor/rovara-code/tests/support/ports/check-runner-conformance.js";
import { defineCloudAdapter } from "../registry.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, githubModel } from "./github-app-world.js";

/** CodeBuild as the gateway sees it: `start` is idempotent by token, `status` reads a build by id. */
export class InMemoryCodeBuild implements CodeBuildGateway {
  readonly builds = new Map<string, CodeBuildCheckResult>();
  private readonly tokens = new Map<string, string>();
  async start(input: Parameters<CodeBuildGateway["start"]>[0]): Promise<CodeBuildCheckResult> {
    const existing = this.tokens.get(input.idempotencyToken);
    if (existing !== undefined) return this.builds.get(existing)!;
    const buildId = `${input.projectName}:build-${String(this.builds.size + 1)}`;
    const result: CodeBuildCheckResult = { gate: input.gate, projectName: input.projectName, buildId, status: "IN_PROGRESS", requestedSourceVersion: input.commit, logsUrl: `https://logs.example.test/${buildId}` };
    this.builds.set(buildId, result);
    this.tokens.set(input.idempotencyToken, buildId);
    return result;
  }
  async status(input: Parameters<CodeBuildGateway["status"]>[0]): Promise<CodeBuildCheckResult> {
    const found = this.builds.get(input.buildId);
    if (found === undefined) throw new Error("no such build");
    return found;
  }
  finish(buildId: string, status: CodeBuildCheckResult["status"]): void {
    this.builds.set(buildId, { ...this.builds.get(buildId)!, status });
  }
}

export function codeBuildWorld(): CheckRunnerWorld & { gateway: InMemoryCodeBuild } {
  const gateway = new InMemoryCodeBuild();
  return {
    runner: codeBuildCheckRunner({ gateway, allowedRepositories: [GITHUB_REPO_URL] }), model: githubModel(), gateway,
    repository: { url: GITHUB_REPO_URL }, unregistered: { url: GITHUB_OTHER_URL }, scope: GITHUB_ORG_SCOPE, project: "agentx-unit",
    changeRequest: () => { throw new Error("CodeBuild has no change requests"); },
    finishRun: (runId, conclusion) => { gateway.finish(runId, conclusion === "success" ? "SUCCEEDED" : "FAILED"); },
  };
}

export const codeBuildCheckRunnerAdapter = defineCloudAdapter({
  port: "check-runner",
  name: "CodeBuild",
  harness: { makeWorld: codeBuildWorld },
});
