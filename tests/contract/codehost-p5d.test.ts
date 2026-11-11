// Enterprise foundations P5d: the broker's task side reaches a repository's pull requests through the CodeHost port of the host its RECORD names (task P7), never by address and never by a
// default. These tests run the moved paths on a FakeCodeHost beside GitHub, and show the two refusals: a host kind this install has not registered is refused with the router's fixed
// sentence, and a step the port cannot express yet (left for P6) is refused on any host that is not GitHub with its own fixed sentence. Nothing is asked of GitHub for a record that names
// another host.
import { describe, expect, it, vi } from "vitest";
import { editionPolicy } from "@agentx/cloud-contracts";
import { createCandidateManifest } from "@rovara-code/contracts";
import { createWorkflowSnapshot } from "@agentx/cloud-contracts";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { e2ePublicationContext } from "../../packages/broker/src/aws/developer-tasks/publication-context.js";
import { answerWithCiChecks } from "../../packages/broker/src/aws/broker/plan-answers.js";
import { completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { reconcilePullRequestUpdate } from "../../packages/broker/src/aws/broker/feedback-and-codebuild.js";
import { rewriteOpenLinearCloseLines, reconcilePullRequest } from "../../packages/broker/src/aws/broker/pull-request-reconcile.js";
import {
  GITHUB_ONLY_MESSAGE, canReadTree, githubProviderOf, githubProviderOfRecord, hostNameOf, hostOfProjectRepository, hostOfRepository, hostOfWorkspaceRepository, pullRequestFactsOf, repositoryOfProject,
} from "../../packages/broker/src/aws/broker/repository-hosts.js";
import { publishSpecFilesOf, readMetaFileOf, readSpecPullRequestOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { requireGithubRecord } from "../../packages/broker/src/plugins/code-host/github-only.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { NO_HOST_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectRow } from "../support/p5-world.js";
import { FAKE_META_URL, FAKE_URL, GITHUB_META_URL, GITHUB_URL, MYSTERY_URL, REPOSITORIES, SCOPE, TASK, WORKSPACE, refusal, world } from "../support/p5-host-world.js";

describe("which code host a repository record names (the shared module)", () => {
  it("is the host of the record: no host is GitHub, a fake host is the fake; an unknown kind is refused with the router's fixed sentence, which does not echo the kind", () => {
    const w = world();
    const records = Object.fromEntries(REPOSITORIES.map((repository) => [repository.name, projectRow([repository]).definition.repositories[0]!]));
    expect(hostOfRepository(w.dependencies, records.web as never).kind).toBe("github");
    expect(hostOfRepository(w.dependencies, records.api as never)).toBe(w.fakeHost);
    expect(() => hostOfRepository(w.dependencies, records.mystery as never)).toThrow(refusal(NO_HOST_MESSAGE));
    expect(() => hostOfRepository(w.dependencies, records.mystery as never)).not.toThrow(/examplehost/u);
  });

  it("finds the record by the project's name for it, else by address; an address held by repositories on different hosts is refused, not guessed", () => {
    const definitions = projectRow(REPOSITORIES).definition.repositories as never[];
    expect(repositoryOfProject(definitions, { name: "api", url: "ignored" })?.name).toBe("api");
    expect(repositoryOfProject(definitions, { url: FAKE_URL })?.name).toBe("api");
    expect(repositoryOfProject(definitions, { url: "https://nowhere.example.test/x" })).toBeUndefined();
    const clash = projectRow([{ name: "a", url: GITHUB_URL }, { name: "b", url: GITHUB_URL, host: { kind: "fake" } }]).definition.repositories as never[];
    expect(() => repositoryOfProject(clash, { url: GITHUB_URL })).toThrow(refusal(NO_HOST_MESSAGE));
    // The same address held twice on one host is not a clash.
    const twice = projectRow([{ name: "a", url: GITHUB_URL }, { name: "b", url: GITHUB_URL }]).definition.repositories as never[];
    expect(repositoryOfProject(twice, { url: GITHUB_URL })?.name).toBe("a");
  });

  it("finds the host of a repository of the project a task or workspace pinned, and refuses one the project does not hold", async () => {
    const w = world();
    const task = { orgId: TEST_ORG, project: "demo", startingRevision: 1 };
    expect(await hostOfProjectRepository(w.dependencies as never, task, "demo", 1, { name: "api", url: FAKE_URL })).toBe(w.fakeHost);
    expect((await hostOfWorkspaceRepository(w.dependencies as never, WORKSPACE, { url: GITHUB_URL })).kind).toBe("github");
    await expect(hostOfProjectRepository(w.dependencies as never, task, "demo", 1, { url: "https://github.com/acme/other.git" })).rejects.toThrow(refusal("not part of the project"));
    await expect(hostOfProjectRepository(w.dependencies as never, task, "demo", 1, { name: "mystery", url: MYSTERY_URL })).rejects.toThrow(refusal(NO_HOST_MESSAGE));
  });

  it("gives the GitHub provider only for GitHub: the fixed 'not available yet' sentence for any other host, and the router's sentence for an unknown one", () => {
    const w = world();
    const records = Object.fromEntries(REPOSITORIES.map((repository) => [repository.name, projectRow([repository]).definition.repositories[0]!]));
    expect(githubProviderOf(w.dependencies, hostOfRepository(w.dependencies, records.web as never))).toBe(w.github);
    expect(() => githubProviderOf(w.dependencies, w.fakeHost)).toThrow(refusal(GITHUB_ONLY_MESSAGE));
    expect(() => githubProviderOfRecord(w.dependencies, records.api as never)).toThrow(refusal(GITHUB_ONLY_MESSAGE));
    expect(() => githubProviderOfRecord(w.dependencies, records.mystery as never)).toThrow(refusal(NO_HOST_MESSAGE));
    expect(GITHUB_ONLY_MESSAGE).not.toMatch(/fake|examplehost/u);
  });

  it("the route side's pure check: GitHub and a record with no host pass; a registered other host is 'not available yet'; an unknown kind is the router's sentence; with no router only GitHub is known", () => {
    const records = Object.fromEntries(REPOSITORIES.map((repository) => [repository.name, projectRow([repository]).definition.repositories[0]!]));
    const w = world();
    expect(() => requireGithubRecord(records.web as never, w.registry.codeHost)).not.toThrow();
    expect(() => requireGithubRecord(records.api as never, w.registry.codeHost)).toThrow(refusal(GITHUB_ONLY_MESSAGE));
    expect(() => requireGithubRecord(records.mystery as never, w.registry.codeHost)).toThrow(refusal(NO_HOST_MESSAGE));
    expect(() => requireGithubRecord(records.web as never, undefined)).not.toThrow();
    expect(() => requireGithubRecord(records.api as never, undefined)).toThrow(refusal(NO_HOST_MESSAGE));
  });

  it("says what it asked by name only for GitHub, keeps the harness probes for GitHub alone, and reads a feedback read in GitHub's words", () => {
    const w = world({ github: { getCommitTree: undefined } });
    expect(hostNameOf({ kind: "github" })).toBe("GitHub");
    expect(hostNameOf({ kind: "fake" })).toBe("the code host");
    // A GitHub provider built without the read cannot read a tree; a host that is not GitHub always can (the port is total).
    expect(canReadTree(w.dependencies as never, { kind: "github" })).toBe(false);
    expect(canReadTree(w.dependencies as never, { kind: "fake" })).toBe(true);
    const facts = pullRequestFactsOf({
      changeRequest: { ref: { repository: { url: FAKE_URL }, id: "12", url: "https://x.test/12" }, state: "merged", sourceBranch: "s", targetBranch: "t", headRevision: "h".repeat(40), headTreeRevision: "t".repeat(40), title: "t", body: "" }, comments: [], threads: [],
    } as never);
    expect(facts.pullRequest).toEqual({ number: 12, url: "https://x.test/12", state: "merged", headBranch: "s", baseBranch: "t", headCommit: "h".repeat(40), headTreeSha: "t".repeat(40) });
  });
});

describe("P5d: the spec pull request and the meta repository's files", () => {
  const task = { orgId: TEST_ORG, project: "demo", startingRevision: 1, taskId: TASK, workspaceId: WORKSPACE, ownerKey: "owner", title: "T" } as never;

  it("reads the spec pull request on the fake host the meta repository's record names: reviewers are eligible by their standing there, and the answer is the host's", async () => {
    const w = world();
    w.metaModel.commit("agentx/spec", { "spec.md": "x" });
    const cr = w.metaModel.reconcile({ sourceBranch: "agentx/spec", targetBranch: "main", title: "spec" }).cr;
    w.metaModel.setAccount("alice", "write");
    w.metaModel.setAccount("bob", "read");
    w.metaModel.setAccount("rovara[bot]", "write", "Bot");
    const head = w.metaModel.headOf("agentx/spec");
    for (const login of ["alice", "bob", "rovara[bot]"]) w.metaModel.addReview(cr.id, { login, state: "APPROVED", revision: head });
    const registry = createPluginRegistry({ codeHosts: [githubCodeHost(w.github as never, { credentialRef: "github-app" }), w.fakeMetaHost], checkRunners: [], policy: editionPolicy("enterprise") });
    const facts = await readSpecPullRequestOf({ ...w.dependencies, codeHost: registry.codeHost })(task, FAKE_META_URL, Number(cr.id));
    expect(facts?.headSha).toBe(head);
    expect(Object.fromEntries(facts!.reviews.map((review) => [review.login, review.eligible]))).toEqual({ alice: true, bob: false, "rovara[bot]": false });
    expect(w.github.getPullRequestStatus).not.toHaveBeenCalled();
    expect(w.github.getRepositoryPermission).not.toHaveBeenCalled();
  });

  it("never counts an approval a host gives no account id for (it cannot be told from an Auditor's); an objection without one still blocks", async () => {
    class IdlessHost extends FakeCodeHost {
      override async changeRequestStatus(...args: Parameters<FakeCodeHost["changeRequestStatus"]>) {
        const status = await super.changeRequestStatus(...args);
        return { ...status, reviews: status.reviews.map((review) => ({ ...review, reviewer: { login: review.reviewer.login } })) };
      }
    }
    const w = world();
    w.metaModel.commit("agentx/spec", { "spec.md": "x" });
    const cr = w.metaModel.reconcile({ sourceBranch: "agentx/spec", targetBranch: "main", title: "spec" }).cr;
    w.metaModel.setAccount("alice", "write");
    w.metaModel.setAccount("bob", "write");
    const head = w.metaModel.headOf("agentx/spec");
    w.metaModel.addReview(cr.id, { login: "alice", state: "APPROVED", revision: head });
    w.metaModel.addReview(cr.id, { login: "bob", state: "CHANGES_REQUESTED", revision: head });
    const registry = createPluginRegistry({ codeHosts: [githubCodeHost(w.github as never, { credentialRef: "github-app" }), new IdlessHost(w.metaModel)], checkRunners: [], policy: editionPolicy("enterprise") });
    const facts = await readSpecPullRequestOf({ ...w.dependencies, codeHost: registry.codeHost })(task, FAKE_META_URL, Number(cr.id));
    expect(facts!.reviews.map((review) => [review.login, review.state])).toEqual([["bob", "CHANGES_REQUESTED"]]);
  });

  it("reads nothing, and asks nobody, for a record that names a host this install has not registered", async () => {
    const w = world({ repositories: [{ name: "meta", url: MYSTERY_URL, role: "meta", host: { kind: "examplehost" } }] });
    expect(await readSpecPullRequestOf(w.dependencies)(task, MYSTERY_URL, 1)).toBeUndefined();
    expect(w.github.getPullRequestStatus).not.toHaveBeenCalled();
  });

  it("reads a size-capped file only from GitHub: a repository on another host, or on an unknown one, reads as 'not there' and GitHub is not asked", async () => {
    const w = world();
    expect(await readMetaFileOf(w.dependencies)(task, GITHUB_META_URL, "a.md", "a".repeat(40), 1_000)).toBe("file");
    expect(w.github.getFileAtCommit).toHaveBeenCalledWith(GITHUB_META_URL, "a.md", "a".repeat(40), SCOPE, { maxBytes: 1_000 });
    w.github.getFileAtCommit.mockClear();
    expect(await readMetaFileOf(w.dependencies)(task, FAKE_META_URL, "a.md", "a".repeat(40), 1_000)).toBeUndefined();
    expect(await readMetaFileOf(w.dependencies)(task, MYSTERY_URL, "a.md", "a".repeat(40), 1_000)).toBeUndefined();
    expect(w.github.getFileAtCommit).not.toHaveBeenCalled();
  });

  it("does not publish a spec to a meta repository on another host: a permanent refusal before any credential is issued", async () => {
    const issue = vi.fn();
    const w = world({ repositories: [{ name: "meta", url: FAKE_META_URL, role: "meta", host: { kind: "fake", ref: "r2" } }] });
    const dependencies = { ...w.dependencies, repositoryGrants: { issue, exchange: vi.fn() } } as never;
    const published = await publishSpecFilesOf(dependencies)({ ...(task as object), startingRevision: 1 } as never, { files: [{ path: "s/a.md", content: "x" }], knowledgeCommit: "a".repeat(40) } as never, "agentx/spec");
    expect(published).toEqual({ ok: false, transient: false });
    expect(issue).not.toHaveBeenCalled();
    expect(w.github.reconcilePullRequest).not.toHaveBeenCalled();
  });
});

describe("P5d: the publication of a pull request", () => {
  function publication(repository: string, repositoryUrl: string, extra: Record<string, unknown> = {}) {
    return {
      id: "op-1", workspaceId: WORKSPACE, kind: "publish", status: "RUNNING", fence: 1, createdAt: "2026-10-31T10:00:00.000Z", updatedAt: "2026-10-31T10:00:00.000Z",
      publication: { repository, repositoryUrl, headBranch: "agentx/10000000-0000-4000-8000-000000000001", baseBranch: "main", title: "Fix it", body: "Body", draft: true, codeBuildGates: [], ...extra },
    } as never;
  }
  const callback = (repository: string, repositoryUrl: string, commit = "a".repeat(40)) => ({ repository, repositoryUrl, headBranch: "agentx/10000000-0000-4000-8000-000000000001", baseBranch: "main", title: "Fix it", body: "Body", commit });

  it("opens the pull request on the fake host the repository's record names, records it, and does not ask GitHub", async () => {
    const w = world();
    w.model.commit("agentx/10000000-0000-4000-8000-000000000001", { "a.txt": "x" });
    const result = await reconcilePullRequest(w.dependencies, publication("api", FAKE_URL), callback("api", FAKE_URL));
    expect(result).toMatchObject({ number: 1, reconciled: false, draft: true });
    expect(w.model.changeRequests).toHaveLength(1);
    expect(w.model.changeRequests[0]).toMatchObject({ title: "Fix it", sourceBranch: "agentx/10000000-0000-4000-8000-000000000001", targetBranch: "main", draft: true });
    expect(w.db.get(`WORKSPACE#${WORKSPACE}`, "PULL_REQUEST#api#000000000001")).toMatchObject({ repository: "api", repositoryUrl: FAKE_URL, number: 1, state: "open" });
    expect(w.github.reconcilePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a repository whose host this install has not registered, before anything is opened", async () => {
    const w = world();
    await expect(reconcilePullRequest(w.dependencies, publication("mystery", MYSTERY_URL), callback("mystery", MYSTERY_URL))).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(w.github.reconcilePullRequest).not.toHaveBeenCalled();
    expect(w.model.changeRequests).toHaveLength(0);
  });
});

describe("P5d: a pushed fix to an open pull request (the update callback)", () => {
  const branch = "agentx/10000000-0000-4000-8000-000000000002";
  function updateWorld(repository: string, url: string) {
    const w = world();
    const first = w.model.commit(branch, { "a.txt": "1" });
    const cr = w.model.reconcile({ sourceBranch: branch, targetBranch: "main", title: "t", body: "b" }).cr;
    const pushed = w.model.commit(branch, { "a.txt": "2" });
    w.db.set({
      pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#${repository}#${cr.id.padStart(12, "0")}`, entityType: "PULL_REQUEST", workspaceId: WORKSPACE, repository, repositoryUrl: url,
      number: Number(cr.id), url: w.model.crUrl(cr.id), state: "open", headBranch: branch, baseBranch: "main", expectedHeadCommit: first, title: "t", body: "b", createdByOperationId: "op-0", updatedAt: "2026-10-31T10:00:00.000Z",
    });
    const operation = { id: "op-2", workspaceId: WORKSPACE, kind: "maintain", status: "RUNNING", fence: 1, maintenance: { repository, pullRequestNumber: Number(cr.id), action: "append", headBranch: branch, baseBranch: "main", expectedHeadCommit: first, codeBuildGates: [] } } as never;
    const body = { repository, pullRequestNumber: Number(cr.id), action: "append", headBranch: branch, baseBranch: "main", previousCommit: first, commit: pushed };
    return { ...w, cr, first, pushed, operation, body };
  }

  it("takes the update when the fake host shows the pull request at the pushed head, and records it", async () => {
    const w = updateWorld("api", FAKE_URL);
    const result = await reconcilePullRequestUpdate(w.dependencies, w.operation, w.body);
    expect(result).toMatchObject({ state: "open", reconciled: false });
    expect(w.db.get(`WORKSPACE#${WORKSPACE}`, `PULL_REQUEST#api#${w.cr.id.padStart(12, "0")}`)).toMatchObject({ expectedHeadCommit: w.pushed });
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
  });

  it("refuses the update when the fake host shows another head than the pushed one (a stale fence)", async () => {
    const w = updateWorld("api", FAKE_URL);
    await expect(reconcilePullRequestUpdate(w.dependencies, w.operation, { ...w.body, commit: "f".repeat(40) })).rejects.toThrow(/does not match the worker update/u);
  });

  it("refuses the update when the pull request's base branch is not the one the record holds, and when its source branch is not", async () => {
    const w = updateWorld("api", FAKE_URL);
    w.cr.targetBranch = "release";
    await expect(reconcilePullRequestUpdate(w.dependencies, w.operation, w.body)).rejects.toThrow(/does not match the worker update/u);
    w.cr.targetBranch = "main";
    w.model.branches.set("agentx/someone-else", w.pushed);
    w.cr.sourceBranch = "agentx/someone-else";
    await expect(reconcilePullRequestUpdate(w.dependencies, w.operation, w.body)).rejects.toThrow(/does not match the worker update/u);
  });

  it("refuses a record that names a host this install has not registered", async () => {
    const w = updateWorld("mystery", MYSTERY_URL);
    await expect(reconcilePullRequestUpdate(w.dependencies, w.operation, w.body)).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
  });
});

describe("P5d: a workflow's published pull request is recorded for the host the repository's record names", () => {
  // Replaces (P10): another registered host was stopped here with GITHUB_ONLY_MESSAGE; the link is that host's own neutral row now (the host's change request is checked below, as GitHub's is).
  it("goes on to its own checks for a repository on another registered host or on GitHub, and stops with the router's sentence for an unknown one", async () => {
    const w = world();
    const commit = "c".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId: "api", commitSha: commit, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const owner = taskOwnerKey("d".repeat(64), TASK);
    const workflow = { ...createWorkflowSnapshot({ taskId: TASK, ownerId: owner, now: "2026-10-31T10:00:00.000Z", definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }), stage: "PULL_REQUEST", state: "READY", candidate };
    w.db.set({ ...(w.db.get(`DEVTASK#${TASK}`, "META") as object), workflow });
    const operation = { id: "op-9", workspaceId: WORKSPACE, kind: "publish", status: "SUCCEEDED", fence: 1 } as never;
    const result = (repository: string, url: string) => ({
      repository, number: 3, url, headBranch: "agentx/10000000-0000-4000-8000-000000000001", baseBranch: "main", commit, checks: [], codeBuildChecks: [], reconciled: false,
    });
    const run = (repository: string, url: string) => completedWorkflowItems(w.dependencies, operation, { taskId: TASK } as never, "SUCCEEDED", "2026-10-31T10:01:00.000Z", result(repository, url));
    await expect(run("mystery", `${MYSTERY_URL}/pull/3`)).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    // Neither GitHub's repository nor another registered host's is stopped by the host check: each goes on, and (no pull request record here) is stopped by the next check instead.
    await expect(run("api", `${FAKE_URL}/pull/3`)).rejects.not.toThrow(refusal(GITHUB_ONLY_MESSAGE));
    await expect(run("web", "https://github.com/acme/web/pull/3")).rejects.not.toThrow(refusal(GITHUB_ONLY_MESSAGE));
    expect(w.github.getPullRequestFeedback).not.toHaveBeenCalled();
  });
});

describe("P5d: the CI checks a plan adds are read only for GitHub repositories", () => {
  it("asks GitHub's reader for the GitHub repository alone: a repository on another host, or on an unknown one, adds no checks and is not read", async () => {
    const w = world({ github: { agentRepositoryReader: vi.fn(async () => { throw new Error("no reader in this test"); }) } });
    const project = w.db.find((item) => item.entityType === "PROJECT")[0] as never;
    const dependencies = { ...w.dependencies, cloud: true } as never;
    const task = w.db.get(`DEVTASK#${TASK}`, "META") as never;
    await answerWithCiChecks(dependencies, task, project, "plan text");
    const calls = (w.github as unknown as { agentRepositoryReader: ReturnType<typeof vi.fn> }).agentRepositoryReader.mock.calls.map((call) => (call as string[])[0]);
    expect(calls).toEqual(expect.arrayContaining([GITHUB_URL]));
    expect(calls).not.toContain(FAKE_URL);
    expect(calls).not.toContain(MYSTERY_URL);
  });
});

describe("P5d: the registered repository's identity in the publication context is asked only of GitHub", () => {
  const DEV = { developerId: "d".repeat(64), orgId: TEST_ORG } as never;
  function contextWorld(repository: string, repositoryId: string) {
    const w = world();
    const commit = "c".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId: repository, commitSha: commit, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const owner = taskOwnerKey(DEV_ID, TASK);
    const base = createWorkflowSnapshot({ taskId: TASK, ownerId: owner, now: "2026-10-31T10:00:00.000Z", definitionVersion: "1.1.0", understand: true, pathFrom: "understand" });
    const workflow = { ...base, candidate, e2e: { required: true, currentRoundId: "round-1" } };
    w.db.set({ ...(w.db.get(`DEVTASK#${TASK}`, "META") as object), taskId: TASK, workflow, ownerKey: owner, developerId: DEV_ID, developerName: "Maya", provider: "oidc" });
    const identity = vi.fn(async () => ({ repositoryId: 999, fullName: "acme/web" }));
    const deps = {
      documentClient: w.db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00.000Z"), orgId: TEST_ORG, registeredRepositoryIdentity: identity,
      actions: { projectRevision: async () => w.db.find((item) => item.entityType === "PROJECT")[0] },
    } as never;
    const input = { taskRef: TASK, subject: { projectName: "demo", projectRevision: 1, repositoryId: Number(repositoryId), commitSha: commit, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }, sourceBindingRef: `cli-source:v1:${"a".repeat(64)}` };
    return { deps, input, identity };
  }
  const DEV_ID = "d".repeat(64);

  it("says UNKNOWN, without asking GitHub, for a repository on another host; GitHub's identity is asked for a GitHub repository", async () => {
    const other = contextWorld("api", "7");
    expect(await e2ePublicationContext(other.deps, DEV, TASK, other.input)).toMatchObject({ status: "UNKNOWN", reasonCode: "registered_repository_host_unsupported" });
    expect(other.identity).not.toHaveBeenCalled();
    const github = contextWorld("web", "7");
    expect(await e2ePublicationContext(github.deps, DEV, TASK, github.input)).toMatchObject({ status: "UNKNOWN", reasonCode: "registered_repository_id_mismatch" });
    expect(github.identity).toHaveBeenCalledWith(GITHUB_URL, TEST_ORG);
  });
});

describe("P5d: the Linear 'Fixes' line in the descriptions of the open pull requests", () => {
  it("is set on the fake host's pull request through the port, and a record on an unknown host counts as failed without touching GitHub", async () => {
    const w = world();
    // The block markers Rovara writes; the test reads them from the source of the body helper so it cannot drift.
    const { ROVARA_STATUS_START, ROVARA_STATUS_END } = await import("../../packages/broker/src/rovara-code/pull-request-body.js");
    const body = `Intro\n${ROVARA_STATUS_START}\nStatus\n${ROVARA_STATUS_END}\n`;
    w.model.commit("agentx/lin", { "l.txt": "1" });
    w.model.commit("agentx/lin2", { "l.txt": "2" });
    const cr = w.model.reconcile({ sourceBranch: "agentx/lin", targetBranch: "main", title: "t", body }).cr;
    const otherCr = w.model.reconcile({ sourceBranch: "agentx/lin2", targetBranch: "main", title: "t2", body }).cr;
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#api#${cr.id.padStart(12, "0")}`, entityType: "PULL_REQUEST", repository: "api", repositoryUrl: FAKE_URL, number: Number(cr.id), body });
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#mystery#${otherCr.id.padStart(12, "0")}`, entityType: "PULL_REQUEST", repository: "mystery", repositoryUrl: MYSTERY_URL, number: Number(otherCr.id), body });
    const task = {
      ...(w.db.get(`DEVTASK#${TASK}`, "META") as object),
      workflow: { pullRequests: [{ repositoryId: "api", number: Number(cr.id), state: "OPEN" }, { repositoryId: "mystery", number: Number(otherCr.id), state: "OPEN" }] },
    } as never;
    const result = await rewriteOpenLinearCloseLines(w.dependencies, task, "ENG-12");
    expect(result).toEqual({ updated: 1, failed: 1 });
    expect(cr.body).toContain("ENG-12");
    expect(otherCr.body).toBe(body);
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
    expect(w.github.updatePullRequest).not.toHaveBeenCalled();
  });
});

