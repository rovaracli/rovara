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

  it("leased: the worker's lease is the once-claim, so the tap's own claim is left out (a worker that died after the claim cannot leave the edit unlearned); unleased, the claim still holds", async () => {
    const queued: HumanEditJob[] = [];
    const handed: HumanEditInput[] = [];
    const w = setup([githubAdapter(async () => diff([{ sha: hex(22), author: { id: "123", login: "maya", isBot: false }, committer: { id: "123", login: "maya", isBot: false }, verified: true }]))]);
    await addRow(w);
    w.runtime.humanEdit.install({ extractor: { extract: async (input) => { handed.push(input); return { candidates: 1 }; } }, enqueue: async (job) => { queued.push(job); } });
    await w.runtime.taps.github(mergedDelivery());
    expect(await w.runtime.humanEdit.run(queued[0]!, { leased: true })).toBe("handed_on");
    expect(await w.runtime.humanEdit.run(queued[0]!, { leased: true })).toBe("handed_on");
    expect(handed).toHaveLength(2);
    // The claim was never taken by those runs, so the first unleased run is the one that claims; its repeat is skipped.
    expect(await w.runtime.humanEdit.run(queued[0]!)).toBe("handed_on");
    expect(await w.runtime.humanEdit.run(queued[0]!)).toBe("skipped");
    expect(handed).toHaveLength(3);
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

describe("what a person's own commits changed (for a comment that led to a change)", () => {
  const repo = { host: "github", id: String(REPO_ID), fullName: "acme/api", isPrivate: false, workspaceId: ORG_A, project: "web" };
  const range = { repo, project: "web", base: hex(20), head: hex(21) };
  const maya = { id: "123", login: "maya", isBot: false };
  async function files(commits: CodeHostDiff["commits"]) {
    const w = setup([githubAdapter(async () => diff(commits))]);
    await addRow(w);
    return w.runtime.humanEdit.provenFiles(range);
  }
  it("gives the files of a clean range of a linked member's verified commits", async () => {
    expect(await files([{ sha: hex(22), author: maya, committer: maya, verified: true }])).toEqual([{ path: "src/a.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+await withRetry(f)" }]);
  });
  it("gives nothing for a merge commit (a branch updated from main), an outsider's commit, or a range with Rovara's own push in it", async () => {
    expect(await files([{ sha: hex(22), author: maya, committer: maya, verified: true, merge: true }])).toBeUndefined();
    expect(await files([{ sha: hex(22), author: { id: "124", login: "bo", isBot: false }, committer: { id: "124", login: "bo", isBot: false }, verified: true }])).toBeUndefined();
    expect(await files([{ sha: hex(22), author: { id: "1", login: "rovara[bot]", isBot: true }, committer: { id: "1", login: "rovara[bot]", isBot: true }, verified: true }])).toBeUndefined();
  });
  it("gives nothing when capture is not on for the repository", async () => {
    const w = setup([githubAdapter(async () => diff([{ sha: hex(22), author: maya, committer: maya, verified: true }]))]);
    expect(await w.runtime.humanEdit.provenFiles(range)).toBeUndefined();
  });
  it("sourceExcluded: an excluded account is excluded; a missing source row gives true (nothing is proved for it)", async () => {
    const w = setup([]);
    await putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, {
      workspaceId: ORG_A, project: "web", source: "github", scope: `github:repo/${REPO_ID}`, enabled: true, retention: "C", exclude: ["999"], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
    }, { edition: "enterprise" });
    expect(await w.runtime.sourceExcluded({ workspaceId: ORG_A, source: "github", scope: `github:repo/${REPO_ID}`, accountId: "999" })).toBe(true);
    expect(await w.runtime.sourceExcluded({ workspaceId: ORG_A, source: "github", scope: `github:repo/${REPO_ID}`, accountId: "123" })).toBe(false);
    expect(await w.runtime.sourceExcluded({ workspaceId: ORG_A, source: "github", scope: "github:repo/404", accountId: "123" })).toBe(true);
  });
});

describe("another code host", () => {
  const examplehost: CodeHostCaptureAdapter = {
    host: "examplehost", supports: { pullRequestComments: true, commentOutdated: true, humanEdits: false, authorship: "none", mergeCommit: true },
    pullRequestAddress: () => undefined, repositoryAddress: (fullName) => `https://git.example.test/${fullName}`,
  };
  const addExamplehostRow = (w: ReturnType<typeof setup>) => putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, {
    workspaceId: ORG_A, project: "web", source: "codehost:examplehost", scope: "codehost:examplehost:repo/7", enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z",
  }, { edition: "enterprise" });
  const comment = (repo: Record<string, unknown>, authorId: string) => ({ type: "comment" as const, repo: repo as never, prNumber: 3, id: "9", url: "https://git.example.test/pkg/api/cr/3#9", action: "created" as const, surface: "review_comment" as const, body: "Use withRetry", author: { id: authorId, login: "maya", isBot: false }, path: "src/a.ts", at: "2026-10-30T10:00:00.000Z", version: "created:1" });
  const ci = (repo: Record<string, unknown>) => ({ type: "ci" as const, repo: repo as never, id: "run1", name: "build", conclusion: "success", headSha: hex(3), prNumbers: [3], at: "2026-10-30T10:00:00.000Z" });
  const binding = { workspaceId: ORG_A, project: "web" };

  it("registers by the same interface and its events go to the host-neutral tap", async () => {
    const w = setup([examplehost]);
    expect(w.runtime.captureAdapters.support()["examplehost"]).toMatchObject({ humanEdits: false });
    await addExamplehostRow(w);
    const repo = { host: "examplehost", id: "7", fullName: "pkg/api", isPrivate: false, workspaceId: ORG_A, project: "web" };
    const result = await w.runtime.taps.codeHost(ci(repo), binding);
    expect(result).toMatchObject({ written: 1 });
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]).toMatchObject({ source: "codehost:examplehost", kind: "github.ci" });
  });

  it("H3: a plug-in account whose id equals a linked member's GITHUB id is an outsider (GitHub links are not plug-in links), never that member", async () => {
    const w = setup([examplehost]);
    await addExamplehostRow(w);
    const repo = { host: "examplehost", id: "7", fullName: "pkg/api", isPrivate: false, workspaceId: ORG_A, project: "web" };
    // "123" is dev-1's GitHub account id; on examplehost it is somebody else.
    const result = await w.runtime.taps.codeHost(comment(repo, "123"), binding);
    // Nothing is stored for an account that is not linked (and none is linked for a plug-in yet), and nothing is stored as dev-1's.
    expect(result).toMatchObject({ written: 0 });
    const rows = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
    expect(JSON.stringify(rows)).not.toContain("dev-1");
    expect(rows).toEqual([]);
    // The same id on GitHub itself still resolves to the member.
    expect(await w.runtime.actors.resolve({ workspaceId: ORG_A, project: "web", system: "github", sourceId: "123" })).toMatchObject({ developerId: "dev-1", trust: "member" });
    expect(await w.runtime.actors.resolve({ workspaceId: ORG_A, project: "web", system: "codehost:examplehost", sourceId: "123" })).toEqual({ trust: "outsider" });
  });

  it("L6: the plug-in's server-side binding overwrites the workspace and project the event claims", async () => {
    const w = setup([examplehost]);
    await addExamplehostRow(w);
    const lying = { host: "examplehost", id: "7", fullName: "pkg/api", isPrivate: false, workspaceId: "org-victim-0000", project: "other" };
    const result = await w.runtime.taps.codeHost(ci(lying), binding);
    expect(result).toMatchObject({ written: 1 });
    const rows = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: ORG_A, project: "web" });
  });
});
