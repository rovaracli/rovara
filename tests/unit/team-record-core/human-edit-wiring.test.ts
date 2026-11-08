// Lessons capture lane: the production wiring of human fix-up commits and the merge commit, through the real Team record runtime. Nothing is read from a host until the lessons runtime installs an extractor;
// then a merged Rovara pull request queues a job (ids only, never a diff), the job proves the authors, reads the compare live through the host's capture adapter, hands it on once, and keeps nothing.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubMemberKey, githubInstallationKey, githubRepoProjectKey, projectRevisionKey, developerOrgKey, orgMemberKey } from "@agentx/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../../packages/broker/src/developer/task-records.js";
import type { CodeHostCaptureAdapter } from "../../../packages/broker/src/team-record/sources/capture-adapters.js";
import { githubPullRequestAddress } from "../../../packages/broker/src/team-record/sources/capture-adapters.js";
import type { CodeHostDiff, HumanEditInput, HumanEditJob } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, T0 } from "../../support/team-record-core.js";

const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const hex = (n: number): string => n.toString(16).padStart(40, "0");
const REPO_ID = 101;
const TASK = randomUUID();
const alice = { id: 123, login: "maya", type: "User" };
const bob = { id: 124, login: "bo", type: "User" };

function setup(adapters: CodeHostCaptureAdapter[]) {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...githubMemberKey(ORG_A, "123"), entityType: "GITHUB_MEMBER", developerId: "dev-1", orgId: ORG_A });
  db.set({ ...orgMemberKey(ORG_A, "dev-1"), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: "dev-1", role: "owner" });
  db.set({ ...developerOrgKey("dev-1"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", orgId: ORG_A, status: "active" });
  db.set({ ...githubRepoProjectKey(REPO_ID, ORG_A, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "web", installationId: 55, githubRepositoryId: REPO_ID });
  db.set({ ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION", definition: { name: "web", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: REPO_ID }], setup: [], readiness: [], orchestratorInstructions: "x" } });
  // A Rovara task and its pull request: Rovara's last push was hex(20).
  db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_A, project: "web", workflow: { pullRequests: [{ repositoryId: "api", number: 5, url: "https://github.com/acme/api/pull/5", headSha: hex(20), candidateDigest: "b".repeat(64), required: true, state: "OPEN" }] } });
  db.set({ ...githubWorkflowPullRequestKey("acme/api", 5), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/api", number: 5, repositoryId: "api", taskId: TASK, workspaceId: ORG_A, candidateDigest: "b".repeat(64), url: "https://github.com/acme/api/pull/5" });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk, captureAdapters: adapters, log: (e) => { if (process.env.DBG) console.log(JSON.stringify(e)); } })!;
  return { db, runtime };
}
const diff = (commits: CodeHostDiff["commits"]): CodeHostDiff => ({ status: "ahead", truncated: false, commits, files: [{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+await withRetry(f)" }] });
const githubAdapter = (read: () => Promise<CodeHostDiff | undefined>): CodeHostCaptureAdapter => ({
  host: "github", supports: { pullRequestComments: true, commentOutdated: true, humanEdits: true, authorship: "verified_commits_and_push_chain", mergeCommit: true }, pullRequestAddress: githubPullRequestAddress, diffs: { compare: read },
});
const envelope = (action: string) => ({ action, installation: { id: 55 }, repository: { id: REPO_ID, full_name: "acme/api", private: false, default_branch: "main" } });
const mergedDelivery = () => ({ eventName: "pull_request", deliveryId: randomUUID(), payload: { ...envelope("closed"), sender: alice, pull_request: {
  number: 5, html_url: "https://github.com/acme/api/pull/5", title: "Fix", body: "x", user: alice, head: { sha: hex(21), ref: "fix" }, base: { ref: "main" }, merged: true, merge_commit_sha: hex(99), updated_at: "2026-10-30T11:00:00Z" } } });
const addRow = (w: ReturnType<typeof setup>) => putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, {
  workspaceId: ORG_A, project: "web", source: "github", scope: `github:repo/${REPO_ID}`, enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
}, { edition: "enterprise" });

describe("a merged Rovara pull request", () => {
  it("notes the merge commit even before any extractor is installed, and reads nothing from the host", async () => {
    let compares = 0;
    const w = setup([githubAdapter(async () => { compares += 1; return undefined; })]);
    await addRow(w);
    await w.runtime.taps.github(mergedDelivery());
    expect(await w.runtime.mergeIndex.mergeCommitOf({ workspaceId: ORG_A, host: "github", repo: "acme/api", number: 5, taskId: TASK })).toBe(hex(99));
    // A revert named by that commit now finds the task.
    expect(await w.runtime.mergeIndex.byMergeCommit({ workspaceId: ORG_A, host: "github", repo: "acme/api", sha: hex(99) })).toMatchObject({ taskId: TASK, project: "web" });
    expect(compares).toBe(0);
    expect(w.runtime.humanEdit.installed()).toBe(false);
  });

  it("with an extractor and a queue installed: the job is ids only, and running it hands on the authors and the changed lines once", async () => {
    const queued: HumanEditJob[] = [];
    const handed: HumanEditInput[] = [];
    const w = setup([githubAdapter(async () => diff([{ sha: hex(22), author: { id: "123", login: "maya", isBot: false }, committer: { id: "123", login: "maya", isBot: false }, verified: true }]))]);
    await addRow(w);
    w.runtime.humanEdit.install({ extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } }, enqueue: async (job) => { queued.push(job); } });
    await w.runtime.taps.github(mergedDelivery());
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued[0])).not.toContain("withRetry");
    expect(queued[0]).toMatchObject({ project: "web", taskId: TASK, candidateHeadSha: hex(20), headSha: hex(21) });
    expect(await w.runtime.humanEdit.run(queued[0]!)).toBe("handed_on");
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ authors: ["dev-1"], taskId: TASK, link: "https://github.com/acme/api/pull/5" });
    // The same merge delivered twice reads the host once (the claim).
    expect(await w.runtime.humanEdit.run(queued[0]!)).toBe("skipped");
    expect(handed).toHaveLength(1);
  });

  it("outsider: a commit by someone who is not a linked member hands nothing on", async () => {
    const handed: HumanEditInput[] = [];
    const w = setup([githubAdapter(async () => diff([{ sha: hex(22), author: { id: String(bob.id), login: "bo", isBot: false }, committer: { id: String(bob.id), login: "bo", isBot: false }, verified: true }]))]);
    await addRow(w);
    w.runtime.humanEdit.install({ extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } }, enqueue: async () => undefined });
    expect(await w.runtime.humanEdit.run({ repo: { host: "github", id: String(REPO_ID), fullName: "acme/api", isPrivate: false, workspaceId: ORG_A, project: "web" }, project: "web", taskId: TASK, pullRequest: { number: 5, url: "https://github.com/acme/api/pull/5" }, candidateHeadSha: hex(20), headSha: hex(21) })).toBe("skipped");
    expect(handed).toEqual([]);
  });

  it("an extractor with no queue installed queues nothing (the ops queue's 30 seconds are not enough for a model call)", async () => {
    const w = setup([githubAdapter(async () => undefined)]);
    await addRow(w);
    w.runtime.humanEdit.install({ extractor: { extract: async () => ({ candidates: 0 }) } });
    const result = await w.runtime.taps.github(mergedDelivery());
    expect(result).toMatchObject({ failed: 0 });
  });
});

describe("another code host", () => {
  it("registers by the same interface, its events go to the host-neutral tap, and its identities resolve under its own name", async () => {
    const gitfarm: CodeHostCaptureAdapter = {
      host: "gitfarm", supports: { pullRequestComments: true, commentOutdated: true, humanEdits: false, authorship: "none", mergeCommit: true },
      pullRequestAddress: () => undefined, repositoryAddress: (fullName) => `https://git.example.test/${fullName}`,
    };
    const w = setup([gitfarm]);
    expect(w.runtime.captureAdapters.support()["gitfarm"]).toMatchObject({ humanEdits: false });
    await putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, {
      workspaceId: ORG_A, project: "web", source: "codehost:gitfarm", scope: "codehost:gitfarm:repo/7", enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
    }, { edition: "enterprise" });
    const repo = { host: "gitfarm", id: "7", fullName: "pkg/api", isPrivate: false, workspaceId: ORG_A, project: "web" };
    const result = await w.runtime.taps.codeHost({ type: "comment", repo, prNumber: 3, id: "9", url: "https://git.example.test/pkg/api/cr/3#9", action: "created", surface: "review_comment", body: "Use withRetry", author: { id: "123", login: "maya", isBot: false }, path: "src/a.ts", at: "2026-10-30T10:00:00.000Z", version: "created:1" });
    expect(result).toMatchObject({ written: 1, refused: 0 });
    const row = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]!;
    expect(row).toMatchObject({ source: "codehost:gitfarm", kind: "github.review_comment", trust: "member", actor: { developerId: "dev-1" } });
  });
});
