// Enterprise foundations P5d: before a CI fix round's coding run is paid for, the pull request's head is read (dispatch.ts `currentPullRequestHead`) from the code host the repository's RECORD names.
// This is the CI-fix-spend world with the task's repository on a fake host: the head comes from the fake host's change request, GitHub is never asked, and a record that names a host this install
// has not registered reads as "cannot say" (the round waits; nothing is paid, nothing is guessed).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkflowSnapshotSchema, createCandidateManifest, editionPolicy, startWorkflowFix, type WorkflowSnapshot } from "@agentx/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { ciEvidenceItem, ciOutputBlock } from "../../packages/broker/src/rovara-code/ci-fix.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

const NOW = "2026-10-25T12:00:00.000Z";
const PROXY_URL = "http://internal-proxy.example.test:4000";
const REPOSITORY_URL = "https://github.com/example/demo.git";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const HEAD = "a".repeat(40);

async function world() {
  const access = fakeModelAccess();
  const model = new FakeHostModel({ url: REPOSITORY_URL, id: "9", fullName: "example/demo" });
  model.commit("agentx/fix", { "a.txt": "1" });
  const cr = model.reconcile({ sourceBranch: "agentx/fix", targetBranch: "main", title: "t" }).cr;
  cr.id = "7";
  cr.frozenHead = HEAD;
  const getPullRequest = vi.fn();
  const github = { reconcilePullRequest: vi.fn(), getPullRequest, updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true) };
  const registry = createPluginRegistry({ codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), new FakeCodeHost(model)], checkRunners: [], policy: editionPolicy("enterprise") });
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true, githubPullRequests: github, codeHost: registry.codeHost } });
  // The task's repository is on another host, by its record (`setHost`; a task cannot START on a host this install has not registered, so a test flips the record afterwards).
  const setHost = (host: { kind: string; ref?: string }) => {
    for (const project of h.db.find((item) => item.entityType === "PROJECT")) {
      const definition = project.definition as { repositories: Array<Record<string, unknown>> };
      h.db.set({ ...project, definition: { ...definition, repositories: definition.repositories.map((repository) => {
        const { installationId, githubRepositoryId, ...rest } = repository;
        void installationId; void githubRepositoryId;
        return { ...rest, host };
      }) } });
    }
  };
  setHost({ kind: "fake", ref: "r1" });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  await new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workspaceId: string; workflow: WorkflowSnapshot };
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const byMode = (workspaceId: string, mode: string) => operations(workspaceId).filter((item) => item.workflowMode === mode);
  const sweep = () => h.handler({ source: "agentx.workflow-dispatch-recovery" });

  async function inFixRound() {
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = String((reply.body.task as { taskId: string }).taskId);
    const workspaceId = meta(taskId).workspaceId;
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await h.finish(workspaceId, String(byMode(workspaceId, "PLAN").at(-1)!.id), "CANCELLED");
    const pullRequest = { repositoryId: "demo", number: 7, headSha: HEAD, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: model.crUrl("7") };
    const waiting = WorkflowSnapshotSchema.parse({
      ...meta(taskId).workflow, revision: 30, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate, reviewBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: NOW, results: [], reviewOnly: true },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
      pullRequests: [pullRequest], blockReason: undefined,
    });
    const fixing = startWorkflowFix(waiting, { source: "ci", problems: ["test"], now: NOW });
    h.db.set({ ...meta(taskId), workflow: fixing, checkPolicy: undefined });
    const block = ciOutputBlock([{ name: "test", conclusion: "failure", url: "https://example.test/runs/1", log: "Error: boom in handler" }]);
    h.db.set((ciEvidenceItem("state", { orgId: TEST_ORG, taskId, revision: fixing.revision, block, now: Date.parse(NOW) }) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    h.db.set((workflowDispatchItem("state", taskId, fixing.revision, "IMPLEMENT", candidate.digest, NOW) as { Put: { Item: Record<string, unknown> } }).Put.Item);
    return { taskId, workspaceId };
  }
  return { h, access, model, cr, meta, byMode, sweep, inFixRound, getPullRequest, setHost };
}

describe("the head of a pull request, read before a CI fix round's run is paid for", () => {
  it("is read from the fake host the repository's record names: the run starts when the head is the one the round was made for, and GitHub is not asked", async () => {
    const t = await world();
    const { workspaceId } = await t.inFixRound();
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toHaveLength(1);
    expect(t.getPullRequest).not.toHaveBeenCalled();
  });

  it("stops the round, with nothing paid for, when the fake host shows a head a person pushed", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    t.cr.frozenHead = "9".repeat(40);
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toEqual([]);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(t.getPullRequest).not.toHaveBeenCalled();
  });

  it("starts nothing for a record that names a host this install has not registered (the head cannot be said): the row stays, and GitHub is not asked", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.inFixRound();
    t.setHost({ kind: "examplehost" });
    await t.sweep();
    expect(t.byMode(workspaceId, "IMPLEMENT")).toEqual([]);
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", fixSource: "ci" });
    expect(t.h.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && item.taskId === taskId)).toHaveLength(1);
    expect(t.getPullRequest).not.toHaveBeenCalled();
  });
});
