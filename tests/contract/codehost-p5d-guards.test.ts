// Enterprise foundations P5d fix round 1: the GitHub-only guards of the task side, on a host that is not GitHub. Each refusal comes before the first host call, claim, dispatch or push:
// acceptance refuses a workflow's own push of a fix or merge of the base before the worker is sent (so nothing is pushed), and the result handlers (which write the GitHub-keyed linked-pull-request
// rows) refuse before they read anything. An unknown host kind is refused with the router's sentence everywhere. Every guard here fails a test when it is removed.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, editionPolicy, type WorkflowSnapshot } from "@agentx/contracts";
import { acceptPullRequestLifecycle } from "../../packages/broker/src/aws/broker/acceptance.js";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { completedBranchSyncItems, completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { GITHUB_ONLY_MESSAGE } from "../../packages/broker/src/plugins/code-host/github-only.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { NO_HOST_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { refusal } from "../support/p5-host-world.js";

const REPOSITORY_URL = "https://github.com/example/demo.git";
const HEAD = "a".repeat(40);
const NEW_HEAD = "f".repeat(40);
const TREE = "b".repeat(40);
const BASE = "e".repeat(40);
const NOW = "2026-11-01T10:00:00.000Z";
const BRANCH = "agentx/10000000-0000-4000-8000-000000000001";

/** A started task whose project repository can be put on any host by its record, with a fake host and GitHub's adapter registered. */
async function world() {
  const model = new FakeHostModel({ url: REPOSITORY_URL, id: "9", fullName: "example/demo" });
  model.commit(BRANCH, { "a.txt": "1" });
  const cr = model.reconcile({ sourceBranch: BRANCH, targetBranch: "main", title: "t" }).cr;
  const getChangeRequest = vi.spyOn(FakeCodeHost.prototype, "getChangeRequest");
  const feedback = vi.spyOn(FakeCodeHost.prototype, "feedback");
  const github = { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true), getPullRequestFeedback: vi.fn(), getCommitTree: vi.fn(), getBranchHead: vi.fn(), getCommitParents: vi.fn() };
  const registry = createPluginRegistry({ codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), new FakeCodeHost(model)], checkRunners: [], policy: editionPolicy("enterprise") });
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, cloud: true, githubPullRequests: github, codeHost: registry.codeHost } });
  const setHost = (host: { kind: string; ref?: string } | undefined) => {
    for (const project of h.db.find((item) => item.entityType === "PROJECT")) {
      const definition = project.definition as { repositories: Array<Record<string, unknown>> };
      h.db.set({ ...project, definition: { ...definition, repositories: definition.repositories.map((repository) => {
        const { installationId, githubRepositoryId, host: previous, ...rest } = repository;
        void installationId; void githubRepositoryId; void previous;
        return host === undefined ? rest : { ...rest, host };
      }) } });
    }
  };
  setHost({ kind: "fake", ref: "r1" });
  const started = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const task = () => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; orgId: string; project: string; startingRevision: number };
  const workspaceId = task().workspaceId;
  const dependencies = brokerDependencies(h.brokerInput);
  return { h, model, cr, github, getChangeRequest, feedback, setHost, taskId, task, workspaceId, dependencies };
}

describe("acceptance of a workflow's own push or merge of the base, on a host that is not GitHub", () => {
  it.each([
    ["a registered other host", { kind: "fake", ref: "r1" }, GITHUB_ONLY_MESSAGE],
    ["a host this install has not registered", { kind: "gitfarm" }, NO_HOST_MESSAGE],
  ])("%s: refused before the pull request is read, an operation is claimed or the worker is sent to push", async (_name, host, message) => {
    const w = await world();
    w.setHost(host);
    w.h.db.set({ pk: `WORKSPACE#${w.workspaceId}`, sk: "PULL_REQUEST#demo#000000000001", entityType: "PULL_REQUEST", workspaceId: w.workspaceId, repository: "demo", repositoryUrl: REPOSITORY_URL, number: 1,
      url: w.model.crUrl("1"), state: "open", headBranch: BRANCH, baseBranch: "main", expectedHeadCommit: HEAD, title: "t", body: "", createdByOperationId: "op-0", updatedAt: NOW });
    const identity = { issuer: "test", subject: MAYA.developerId, ownerKey: String(w.h.db.get(`WORKSPACE#${w.workspaceId}`, "META")!.ownerKey), orgId: TEST_ORG, isAdministrator: false, claims: {} } as never;
    const operations = () => w.h.db.find((item) => item.pk === `WORKSPACE#${w.workspaceId}` && item.entityType === "OPERATION" && item.kind === "maintain");
    const idempotent = () => w.h.db.find((item) => String(item.pk).startsWith("IDEMPOTENCY#") && String(item.sk).includes("REQUEST#"));
    const before = { operations: operations().length, idempotent: idempotent().length };
    const fix = { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "append" };
    const sync = { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "sync" };
    await expect(acceptPullRequestLifecycle(w.dependencies, identity, w.workspaceId, fix, undefined,
      { workflowCandidate: { candidateDigest: "c".repeat(64), treeSha: TREE, baseCommitSha: BASE, expectedHeadCommit: HEAD } })).rejects.toThrow(refusal(message) as never);
    await expect(acceptPullRequestLifecycle(w.dependencies, identity, w.workspaceId, sync, undefined, { workflowSync: { baseCommit: BASE, expectedHeadCommit: HEAD } })).rejects.toThrow(refusal(message) as never);
    expect(operations()).toHaveLength(before.operations);
    expect(idempotent()).toHaveLength(before.idempotent);
    expect(w.getChangeRequest).not.toHaveBeenCalled();
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
    expect(w.model.changeRequests[0]!.state).toBe("open");
  });
});

/** A task waiting at the stage the handlers expect, with the pull request the operation names. */
function handlerFixtures(w: Awaited<ReturnType<typeof world>>, stage: "update" | "sync", pushed = NEW_HEAD) {
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: TREE, baseCommitSha: BASE }]);
  const base = createWorkflowSnapshot({ taskId: w.taskId, ownerId: taskOwnerKey(MAYA.developerId, w.taskId), now: NOW, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" });
  const pullRequest = { repositoryId: "demo", number: 1, headSha: HEAD, headTreeSha: TREE, candidateDigest: candidate.digest, required: true, state: "OPEN", url: w.model.crUrl("1") };
  const workflow = (stage === "update"
    ? { ...base, stage: "PULL_REQUEST", state: "RUNNING", candidate, pullRequests: [pullRequest] }
    : { ...base, stage: "WAIT_FOR_MERGE", state: "RUNNING", candidate, pullRequests: [pullRequest], branchSync: { repositoryId: "demo", number: 1, expectedHeadCommit: HEAD, baseCommit: BASE } }) as unknown as WorkflowSnapshot;
  const maintenance = {
    repository: "demo", pullRequestNumber: 1, action: stage === "update" ? "append" : "sync", headBranch: BRANCH, baseBranch: "main", expectedHeadCommit: HEAD, codeBuildGates: [],
    ...(stage === "update" ? { workflowCandidate: { candidateDigest: candidate.digest, treeSha: TREE, baseCommitSha: BASE, expectedHeadCommit: HEAD } } : { workflowSync: { baseCommit: BASE, expectedHeadCommit: HEAD } }),
  };
  const operation = { id: "op-5", workspaceId: w.workspaceId, kind: "maintain", status: "SUCCEEDED", fence: 1, maintenance } as never;
  w.h.db.set({ ...w.task(), workflow });
  const task = { ...w.task(), workflow } as never;
  const result = { action: stage === "update" ? "append" : "sync", repository: "demo", number: 1, url: w.model.crUrl("1"), state: "open", headBranch: BRANCH, baseBranch: "main", commit: pushed, treeSha: TREE, checks: [], reconciled: false };
  return { operation, task, result };
}

describe("the handlers of a pushed fix and of a merge of the base, on a host that is not GitHub", () => {
  it.each([
    ["a registered other host", { kind: "fake", ref: "r1" }, GITHUB_ONLY_MESSAGE],
    ["a host this install has not registered", { kind: "gitfarm" }, NO_HOST_MESSAGE],
  ])("%s: the pushed-fix result stops before any read", async (_name, host, message) => {
    const w = await world();
    w.setHost(host);
    const f = handlerFixtures(w, "update");
    await expect(completedWorkflowItems(w.dependencies, f.operation, { taskId: w.taskId } as never, "SUCCEEDED", NOW, f.result)).rejects.toThrow(refusal(message) as never);
    expect(w.feedback).not.toHaveBeenCalled();
    expect(w.github.getPullRequestFeedback).not.toHaveBeenCalled();
  });

  it.each([
    ["a registered other host", { kind: "fake", ref: "r1" }, GITHUB_ONLY_MESSAGE],
    ["a host this install has not registered", { kind: "gitfarm" }, NO_HOST_MESSAGE],
  ])("%s: the merge-of-the-base result stops before any read", async (_name, host, message) => {
    const w = await world();
    w.setHost(host);
    const f = handlerFixtures(w, "sync");
    await expect(completedBranchSyncItems(w.dependencies, f.operation, f.task, "SUCCEEDED", NOW, f.result, undefined)).rejects.toThrow(refusal(message) as never);
    expect(w.feedback).not.toHaveBeenCalled();
    expect(w.github.getPullRequestFeedback).not.toHaveBeenCalled();
  });
});
