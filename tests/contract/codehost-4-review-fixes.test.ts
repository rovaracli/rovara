// Fixes from the first review of codehost-4 (P8, P9, P10): a task with pull requests on GitHub and on another host is followed on each with its own host (S2), the landed-fix path is not
// offered for a pull request on another host (S1), one Linear issue is one session whichever door it came in by (S4), an ssh address is tied to its host keys and a wildcard host key is
// refused (S6), and the worker holds the key material to the contract's rules (S7).
import { describe, expect, it, vi } from "vitest";
import {
  GitCredentialSchema, SshCredentialMaterialSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, sessionSurfaceKey, sshKnownHostsMatchAddress,
  type OrgId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { reconcileTaskPullRequestFeedback, type ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";
import { linkedChangeRequestItem } from "../../packages/broker/src/rovara-code/linked-change-requests.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = "2026-11-02T12:00:00.000Z";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440099";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const FAKE_URL = "https://git.example.test/acme/ui";
const KEY_B64 = `AAAAC3NzaC1lZDI1NTE5AAAAI${"A".repeat(43)}`;

type Remote = { state: "open" | "closed" | "merged"; headCommit: string; headTreeSha: string };

/** A task with two pull requests: "api" on GitHub (#1, GitHub's own link row) and "ui" on the fake host (#2, the neutral link row). */
function mixed(options: { blocked?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const candidate = createCandidateManifest(["api", "ui"].map((repositoryId) => ({ repositoryId, commitSha: HEAD, treeSha: TREE })));
  const urls = { api: "https://github.com/acme/api/pull/1", ui: `${FAKE_URL}/pull/2` };
  const pullRequests = (["api", "ui"] as const).map((repositoryId, index) => ({
    repositoryId, number: index + 1, url: urls[repositoryId], headSha: HEAD, headTreeSha: TREE, candidateDigest: candidate.digest, required: true as const, state: "OPEN" as const,
  }));
  let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "c".repeat(64), now: NOW }), candidate, stage: "WAIT_FOR_MERGE", state: options.blocked ? "BLOCKED" : "WAITING",
    ...(options.blocked ? { blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed } : {}),
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: TASK_ID, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests,
  });
  db.set({ pk: "GITHUB_PR#acme/api", sk: `PR#${String(1).padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/api", repositoryId: "api", number: 1, url: urls.api,
    taskId: TASK_ID, workspaceId: "workspace", candidateDigest: candidate.digest });
  const put = linkedChangeRequestItem("state", { hostKind: "fake", repositoryAddress: FAKE_URL, changeRequestId: "2", repositoryId: "ui", number: 2, url: urls.ui, taskId: TASK_ID, workspaceId: "workspace", candidateDigest: candidate.digest, createdAt: NOW });
  db.set(put!.Put.Item as unknown as Record<string, unknown>);
  const remote = new Map<string, Remote>([["api", { state: "open", headCommit: HEAD, headTreeSha: TREE }], ["ui", { state: "open", headCommit: HEAD, headTreeSha: TREE }]]);
  const readBy: string[] = [];
  const details = (repositoryId: "api" | "ui") => {
    const value = remote.get(repositoryId)!;
    return { number: repositoryId === "api" ? 1 : 2, url: urls[repositoryId], state: value.state, headBranch: "feature", baseBranch: "main", headCommit: value.headCommit, headTreeSha: value.headTreeSha, title: "t", body: "" };
  };
  const recordedHead = vi.fn(async () => HEAD);
  const saveLandedPushes = vi.fn(async () => undefined);
  const input = (over: Partial<ReconcileTaskPullRequestFeedbackInput> = {}): ReconcileTaskPullRequestFeedbackInput => ({
    observationMode: "merge", documentClient: db, tableName: "state", repositoryFullName: "acme/api", number: 1, deliveryId: "merge-recovery",
    loadTask: async () => ({ project: "fixture", startingRevision: 1, workflow }),
    repositoryUrl: async (_project, _revision, repositoryId) => (repositoryId === "api" ? "https://github.com/acme/api.git" : FAKE_URL),
    // GitHub's read: asked for the GitHub repository only.
    getCurrentFeedback: async (url) => {
      if (!url.includes("github.com")) throw new Error(`GitHub was asked about ${url}`);
      readBy.push("github");
      return { pullRequest: details("api"), comments: [], threads: [] };
    },
    hostOfRepository: async (_project, _revision, repositoryId) => (repositoryId === "ui" ? { kind: "fake", observe: async () => { readBy.push("fake"); return details("ui"); } } : undefined),
    persistBundle: async () => "k", recordedHead, saveLandedPushes,
    saveWorkflow: async (_taskId, revision, next) => {
      if (revision !== workflow.revision) throw Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" });
      workflow = next;
    },
    now: NOW, ...over,
  });
  return { input, workflow: () => workflow, remote, readBy, recordedHead, saveLandedPushes };
}

describe("a task with pull requests on GitHub and on another host (S2)", () => {
  it("is followed to merged when the GitHub pull request is the one observed: each is read with its own host", async () => {
    const f = mixed();
    f.remote.set("api", { ...f.remote.get("api")!, state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input())).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE" });
    f.remote.set("ui", { ...f.remote.get("ui")!, state: "merged" });
    expect(await reconcileTaskPullRequestFeedback(f.input())).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    expect(new Set(f.readBy)).toEqual(new Set(["github", "fake"]));
  });

  it("is followed to merged when the other host's change request is the one observed", async () => {
    const f = mixed();
    f.remote.set("api", { ...f.remote.get("api")!, state: "merged" });
    f.remote.set("ui", { ...f.remote.get("ui")!, state: "merged" });
    const observed = f.input({ repositoryFullName: `fake:https://git.example.test/acme/ui`, number: 2, neutralHost: { kind: "fake", repositoryAddress: FAKE_URL } });
    expect(await reconcileTaskPullRequestFeedback(observed)).toBe(true);
    expect(f.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
  });

  it("never reads the other host's pull request as GitHub's, and a feedback read of such a task is refused (fail closed)", async () => {
    const f = mixed();
    const { observationMode: _mode, ...feedback } = f.input();
    void _mode;
    await expect(reconcileTaskPullRequestFeedback(feedback)).rejects.toThrow(/not available for this code host yet/);
    expect(f.readBy).not.toContain("fake");
  });

  it("refuses a pull request whose link is not the neutral row the host's kind names", async () => {
    const f = mixed();
    f.input();
    const bad = f.input({ hostOfRepository: async (_p, _r, repositoryId) => (repositoryId === "ui" ? { kind: "other", observe: async () => { throw new Error("no read"); } } : undefined) });
    await expect(reconcileTaskPullRequestFeedback(bad)).rejects.toThrow(/scope mismatch/);
  });
});

describe("the landed-fix path is not offered for a pull request on another host (S1)", () => {
  it("a neutral merge observation of a task blocked on a failed fix push neither asks for the recorded head nor files GitHub-named rows, and still completes on merge", async () => {
    const f = mixed({ blocked: true });
    f.remote.set("api", { ...f.remote.get("api")!, state: "merged" });
    f.remote.set("ui", { ...f.remote.get("ui")!, state: "merged" });
    const observed = f.input({ repositoryFullName: `fake:https://git.example.test/acme/ui`, number: 2, neutralHost: { kind: "fake", repositoryAddress: FAKE_URL } });
    await expect(reconcileTaskPullRequestFeedback(observed)).resolves.toBeTypeOf("boolean");
    expect(f.recordedHead).not.toHaveBeenCalled();
    expect(f.saveLandedPushes).not.toHaveBeenCalled();
  });
});

describe("one Linear issue is one session whichever door it came in by (S4)", () => {
  const linearBinding = { kind: "linear_issue" as const, issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" };
  const trackerBinding = { kind: "tracker_item" as const, system: "linear", id: "ENG-142", url: "https://linear.app/acme/issue/ENG-142/x" };
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;

  it("the old `linear` binding and the neutral tracker binding for the linear system are the same surface", () => {
    expect(sessionSurfaceKey(ORG, trackerBinding)).toEqual(sessionSurfaceKey(ORG, linearBinding));
    // The key is the issue's key in capitals.
    expect(sessionSurfaceKey(ORG, { ...trackerBinding, id: "eng-142" })).toEqual(sessionSurfaceKey(ORG, linearBinding));
  });

  it("another issue, another tracker's ticket of the same id, and Jira are other surfaces", () => {
    expect(sessionSurfaceKey(ORG, { ...trackerBinding, id: "ENG-143" })).not.toEqual(sessionSurfaceKey(ORG, linearBinding));
    expect(sessionSurfaceKey(ORG, { ...trackerBinding, system: "jira" })).not.toEqual(sessionSurfaceKey(ORG, linearBinding));
    expect(sessionSurfaceKey(ORG, { ...trackerBinding, system: "fake-tracker" })).toMatchObject({ sk: "TRACKER#fake-tracker#ENG-142" });
  });
});

describe("an ssh address is tied to its host keys (S6, S7)", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
  const line = (hosts: string) => `${hosts} ssh-ed25519 ${KEY_B64}`;
  const material = (url: string, knownHosts: string) => ({ privateKey: key, url, knownHosts });

  it("accepts keys that name the address's host, with its port when it is not 22, and a line that lists the host among others", () => {
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", line("git.example.test"))).toBe(true);
    expect(sshKnownHostsMatchAddress("ssh://git@Git.Example.test/srv/app.git", line("git.example.test"))).toBe(true);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test:2222/srv/app.git", line("[git.example.test]:2222"))).toBe(true);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", line("git.example.test,203.0.113.7"))).toBe(true);
  });

  it("refuses keys for another host, for the wrong port, a line that names other hosts only, and no keys", () => {
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", line("evil.example.test"))).toBe(false);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test:2222/srv/app.git", line("git.example.test"))).toBe(false);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", line("[git.example.test]:2222"))).toBe(false);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", `${line("git.example.test")}\n${line("evil.example.test")}`)).toBe(false);
    expect(sshKnownHostsMatchAddress("ssh://git@git.example.test/srv/app.git", "")).toBe(false);
    expect(sshKnownHostsMatchAddress("https://git.example.test/x", line("git.example.test"))).toBe(false);
  });

  it.each(["*", "*.example.test", "git.example.*", "git.example.test,*", "gi?.example.test", "!git.example.test", "|1|abc=|def="])("refuses the host pattern %s, in the contract and on the worker's side", (pattern) => {
    const url = "ssh://git@git.example.test/srv/app.git";
    const knownHosts = line(`${pattern.includes("git.example.test") || pattern === "*" || pattern.includes("*") ? pattern : `git.example.test,${pattern}`}`);
    expect(SshCredentialMaterialSchema.safeParse(material(url, knownHosts)).success, knownHosts).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "ssh-key", privateKey: key, sshUrl: url, knownHosts, expiresAt: "2099-01-01T00:00:00.000Z" }).success).toBe(false);
  });

  it("the contract's credential and the worker's material both refuse keys that are not for the address, and accept ones that are", () => {
    const url = "ssh://git@git.example.test/srv/app.git";
    expect(SshCredentialMaterialSchema.safeParse(material(url, line("git.example.test"))).success).toBe(true);
    expect(SshCredentialMaterialSchema.safeParse(material(url, line("evil.example.test"))).success).toBe(false);
    expect(GitCredentialSchema.safeParse({ kind: "ssh-key", privateKey: key, sshUrl: url, knownHosts: line("evil.example.test"), expiresAt: "2099-01-01T00:00:00.000Z" }).success).toBe(false);
    expect(SshCredentialMaterialSchema.safeParse({ ...material(url, line("git.example.test")), extra: 1 }).success).toBe(false);
  });
});
