// Meta repo lane D (D2), broker side of the spec publication: the push grant that names only the meta repository, and the check GitHub answers before the spec pull request opens.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { issueRepositoryGrant } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { reconcilePullRequest } from "../../packages/broker/src/aws/broker/pull-request-reconcile.js";
import { specPublishProject, specPullRequestTitle, specTargetRepository } from "../../packages/broker/src/spec/publish-request.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const meta = { name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta", installationId: 7, githubRepositoryId: 99 };
const definition = StoredProjectDefinitionSchema.parse({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
  repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }, meta],
});

describe("the push grant for a spec publication", () => {
  const issued: Array<{ repositories: Array<{ repositoryUrl: string; access: string }> }> = [];
  const grants = new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" }));
  const dependencies = { repositoryGrants: { issue: (input: { repositories: Array<{ repositoryUrl: string; access: string }> }) => { issued.push(input); return grants.issue(input as never); } } } as never;
  const project = { definition, runtimeBinding: {} } as never;

  it("names the meta repository and nothing else when a spec is published", () => {
    issued.length = 0;
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push", "service-meta", true);
    expect(issued[0]!.repositories).toEqual([{ credentialRef: "github-app", repositoryUrl: "https://github.com/acme/service-meta.git", access: "push" }]);
  });
  it("still gives a code publication the code repositories only, and a push to the meta repository by name alone nothing", () => {
    issued.length = 0;
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push");
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push", "service-meta");
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push", undefined, true);
    expect(issued[0]!.repositories.map((entry) => entry.repositoryUrl)).toEqual(["https://github.com/acme/api.git"]);
    expect(issued[1]!.repositories).toEqual([]);
    expect(issued[2]!.repositories.map((entry) => entry.repositoryUrl)).toEqual(["https://github.com/acme/api.git"]);
  });
});

describe("the project a worker is sent for a spec publication", () => {
  it("lists the meta repository as a plain repository, without its pins or role, beside the code repositories", () => {
    const sent = specPublishProject(definition);
    expect(sent.repositories.map((entry) => entry.name)).toEqual(["api", "service-meta"]);
    expect(sent.repositories[1]).toEqual({ name: "service-meta", url: "https://github.com/acme/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app" });
    expect(JSON.stringify(sent)).not.toMatch(/installationId|githubRepositoryId|"role"/u);
  });
  it("finds the meta repository by its name only, and refuses a project without one", () => {
    expect(specTargetRepository(definition, "service-meta")?.url).toBe(meta.url);
    expect(specTargetRepository(definition, "api")).toBeUndefined();
    expect(() => specPublishProject(StoredProjectDefinitionSchema.parse({ ...definition, repositories: [definition.repositories[0]] }))).toThrow(/no meta repository/u);
  });
  it("titles the pull request with the task's title as one inert line", () => {
    expect(specPullRequestTitle("Fix @everyone <b>now</b>\nplease")).toBe("Rovara spec: Fix everyone bnow/b please");
    expect(specPullRequestTitle("   ")).toBe("Rovara spec: task");
  });
});

describe("opening the spec pull request", () => {
  const BASE = "b".repeat(40);
  const COMMIT = "c".repeat(40);
  function setup(github: Record<string, unknown>) {
    const db = new FakeDynamoDb();
    const operationId = randomUUID();
    const operation = {
      id: operationId, workspaceId: randomUUID(), kind: "publish", status: "RUNNING", fence: 2,
      publication: { spec: true, repository: "service-meta", repositoryUrl: meta.url, headBranch: `agentx/${operationId}`, baseBranch: "main", title: "Rovara spec: x", body: "b", draft: false, expectedBaseCommit: BASE, mode: "create", codeBuildGates: [] },
    };
    const reconcile = vi.fn(async () => ({ number: 5, url: "https://github.com/acme/service-meta/pull/5", draftRefused: false }));
    const dependencies = { documentClient: db, tableName: "state", githubPullRequests: { reconcilePullRequest: reconcile, getPullRequest: vi.fn(), updatePullRequest: vi.fn(), ...github } } as never;
    const body = { repository: "service-meta", repositoryUrl: meta.url, headBranch: operation.publication.headBranch, baseBranch: "main", commit: COMMIT, title: "Rovara spec: x", body: "b" };
    return { db, operation: operation as never, dependencies, reconcile, body };
  }
  const refused = async (github: Record<string, unknown>, code: RegExp) => {
    const t = setup(github);
    await expect(reconcilePullRequest(t.dependencies, t.operation, t.body)).rejects.toThrow(code);
    expect(t.reconcile).not.toHaveBeenCalled();
  };

  it("is refused, and nothing is opened, when the branch does not hold the pushed commit", async () => {
    await refused({ getBranchHead: async () => "d".repeat(40), getCommitParents: async () => [BASE] }, /not the spec commit/u);
  });
  it("is refused when the pushed commit's parent is not the meta commit the broker pinned, or it has more than one parent", async () => {
    await refused({ getBranchHead: async () => COMMIT, getCommitParents: async () => ["e".repeat(40)] }, /not the spec commit/u);
    await refused({ getBranchHead: async () => COMMIT, getCommitParents: async () => [BASE, "e".repeat(40)] }, /not the spec commit/u);
    await refused({ getBranchHead: async () => COMMIT, getCommitParents: async () => [] }, /not the spec commit/u);
  });
  it("is refused when GitHub cannot be asked", async () => {
    await refused({}, /cannot verify the pushed spec/u);
    await refused({ getBranchHead: async () => COMMIT }, /cannot verify the pushed spec/u);
  });
  it("is refused for a callback outside the operation's scope, as every publication is", async () => {
    const t = setup({ getBranchHead: async () => COMMIT, getCommitParents: async () => [BASE] });
    await expect(reconcilePullRequest(t.dependencies, t.operation, { ...t.body, baseBranch: "release" })).rejects.toThrow(/outside the operation scope/u);
    expect(t.reconcile).not.toHaveBeenCalled();
  });
  it("opens a pull request that is not a draft and carries no checks section, once GitHub confirms the commit and its parent", async () => {
    const t = setup({ getBranchHead: async () => COMMIT, getCommitParents: async () => [BASE] });
    const error = await reconcilePullRequest(t.dependencies, t.operation, t.body).then(() => undefined, (failure: unknown) => failure);
    expect(String(error)).toBe('undefined');
    expect(t.reconcile).toHaveBeenCalledTimes(1);
    expect(t.reconcile.mock.calls[0]![0]).toMatchObject({ headBranch: t.body.headBranch, baseBranch: "main", title: "Rovara spec: x", body: "b", draft: false });
  });
});
