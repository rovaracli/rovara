// Enterprise foundations P5d: a workflow publication opens the pull request only on the checked code. GitHub, not the worker, says what the branch holds: its head must be the reported commit, that
// commit's tree the checked one, and (once opened) the pull request's own head must still be the checked commit, or it is closed again. This is that check run on a FakeCodeHost, which the
// repository's record names. `assertCurrentWorkflowPublication` (the workflow's own authority check, which needs a whole task) is stood in for: it is not what is under test.
import { describe, expect, it, vi } from "vitest";
import { editionPolicy } from "../../packages/contracts/src/index.js";
import { reconcilePullRequest } from "../../packages/broker/src/aws/broker/pull-request-reconcile.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectRow, pullRequestDetails } from "../support/p5-world.js";

vi.mock("../../packages/broker/src/aws/broker/admin-and-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCurrentWorkflowPublication: vi.fn(async () => undefined),
}));

const URL_ = "https://git.example.test/acme/api";
const WORKSPACE = "ws-1";
const BRANCH = "agentx/10000000-0000-4000-8000-000000000001";

/** After the pull request is opened, the branch moves (a force-push between the check and the open). */
class MovingHost extends FakeCodeHost {
  moveAfterOpen = false;
  override async reconcileChangeRequest(...args: Parameters<FakeCodeHost["reconcileChangeRequest"]>) {
    const result = await super.reconcileChangeRequest(...args);
    if (this.moveAfterOpen) this.model.commit(BRANCH, { "late.txt": "z" });
    return result;
  }
}

function world() {
  const db = new FakeDynamoDb();
  db.set(projectRow([{ name: "api", url: URL_, host: { kind: "fake", ref: "r1" } }]));
  db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE", id: WORKSPACE, orgId: TEST_ORG, ownerKey: "owner", projectName: "demo", projectRevision: 1, status: "READY", fence: 1 });
  const model = new FakeHostModel({ url: URL_, id: "7", fullName: "acme/api" });
  const host = new MovingHost(model);
  const github = { getPullRequest: vi.fn(async (_u: string, n: number) => pullRequestDetails(n)), updatePullRequest: vi.fn(), reconcilePullRequest: vi.fn(), getCommitTree: vi.fn(), getBranchHead: vi.fn(), getCommitParents: vi.fn() };
  const registry = createPluginRegistry({ codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), host], checkRunners: [], policy: editionPolicy("enterprise") });
  const dependencies = { documentClient: db, tableName: "state", environmentName: "test", githubPullRequests: github, codeHost: registry.codeHost } as never;
  const commit = model.commit(BRANCH, { "a.txt": "x" });
  const checked = { expectedTreeSha: model.revision(commit).tree, expectedCommitSha: commit, publicationMode: "COMMITTED_HEAD", candidateDigest: "c".repeat(64) };
  const operation = (extra: Record<string, unknown> = {}) => ({
    id: "op-1", workspaceId: WORKSPACE, kind: "publish", status: "RUNNING", fence: 1, createdAt: "2026-10-31T10:00:00.000Z", updatedAt: "2026-10-31T10:00:00.000Z",
    publication: { repository: "api", repositoryUrl: URL_, headBranch: BRANCH, baseBranch: "main", title: "Fix it", body: "Body", draft: true, codeBuildGates: [], ...checked, ...extra },
  }) as never;
  const body = (pushed: string) => ({ repository: "api", repositoryUrl: URL_, headBranch: BRANCH, baseBranch: "main", title: "Fix it", body: "Body", commit: pushed });
  return { db, model, host, github, dependencies, commit, operation, body };
}

describe("a workflow publication on a fake host", () => {
  it("opens the pull request when the branch head and its tree are the checked ones, and keeps it open when its own head is still the checked commit", async () => {
    const w = world();
    const result = await reconcilePullRequest(w.dependencies, w.operation(), w.body(w.commit));
    expect(result).toMatchObject({ number: 1, draft: true });
    expect(w.model.changeRequests[0]).toMatchObject({ state: "open", draft: true });
    expect(w.db.get(`WORKSPACE#${WORKSPACE}`, "PULL_REQUEST#api#000000000001")).toMatchObject({ expectedHeadCommit: w.commit });
    for (const asked of [w.github.getCommitTree, w.github.getBranchHead, w.github.getPullRequest, w.github.reconcilePullRequest]) expect(asked).not.toHaveBeenCalled();
  });

  it("refuses, opening nothing, when the branch holds another commit than the one reported", async () => {
    const w = world();
    w.model.commit(BRANCH, { "b.txt": "y" });
    await expect(reconcilePullRequest(w.dependencies, w.operation(), w.body(w.commit))).rejects.toThrow("the pushed commit is not the checked code");
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("refuses, opening nothing, when the commit's tree is not the checked tree", async () => {
    const w = world();
    await expect(reconcilePullRequest(w.dependencies, w.operation({ expectedTreeSha: "f".repeat(40) }), w.body(w.commit))).rejects.toThrow("the pushed commit is not the checked code");
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("closes the pull request again, and refuses, when the branch moved between the check and the open", async () => {
    const w = world();
    w.host.moveAfterOpen = true;
    await expect(reconcilePullRequest(w.dependencies, w.operation(), w.body(w.commit))).rejects.toThrow("the opened pull request is not the checked code");
    expect(w.model.changeRequests[0]).toMatchObject({ state: "closed" });
    expect(w.db.get(`WORKSPACE#${WORKSPACE}`, "PULL_REQUEST#api#000000000001")).toBeUndefined();
  });

  it("cannot verify a pinned base on a host that has no commit-parent read: it stops before anything is opened, and GitHub is not asked", async () => {
    const w = world();
    await expect(reconcilePullRequest(w.dependencies, w.operation({ expectedBaseCommit: w.model.headOf("main") }), w.body(w.commit))).rejects.toThrow("cannot verify the pushed tree");
    expect(w.model.changeRequests).toHaveLength(0);
    expect(w.github.getCommitParents).not.toHaveBeenCalled();
  });
});
