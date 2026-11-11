// Lessons in the repo, lane R1b: the edits reflection through the REAL Team record runtime. A merged Rovara pull request delivered to the GitHub tap queues a job (ids only); the job proves the authors, reads the compare
// live through the host's capture adapter and hands the edit to the REAL human-edit extractor, which runs the edits reflection (the edits, with the pull request's comments for context) in the lessons World. The task end's
// comments reflection is its own call and does not depend on any of this; a skipped job leaves it untouched.
// Mutation check (by hand): removing the edits path from the extractor fails the first test.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { githubInstallationKey, githubRepoProjectKey, developerOrgKey, orgMemberKey } from "@agentx/cloud-contracts";
import { createTeamRecordRuntime } from "../../packages/broker/src/team-record/runtime.js";
import { SdkUnavailableError } from "../../packages/broker/src/team-record/aws-adapters.js";
import { putSourceConfig } from "../../packages/broker/src/team-record/store.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { githubPullRequestAddress, type CodeHostCaptureAdapter } from "../../packages/broker/src/team-record/sources/capture-adapters.js";
import type { CodeHostDiff, HumanEditJob } from "../../packages/broker/src/team-record/sources/codehost.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ORG_A, T0 } from "../support/team-record-core.js";
import { HEAD, PROJECT, PUSHED, TASK, World } from "../support/lessons-repo-reflect-world.js";

const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const REPO_ID = 9;
const PR = "https://github.com/acme/api/pull/7";
const maya = { id: "123", login: "maya", isBot: false };
const alice = { id: 123, login: "maya", type: "User" };

function setup(adapters: CodeHostCaptureAdapter[]) {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...githubMemberKey(ORG_A, "123"), entityType: "GITHUB_MEMBER", developerId: "ann", orgId: ORG_A });
  db.set({ ...orgMemberKey(ORG_A, "ann"), entityType: "ORG_MEMBER", orgId: ORG_A, developerId: "ann", role: "owner" });
  db.set({ ...developerOrgKey("ann"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", orgId: ORG_A, status: "active" });
  db.set({ ...githubRepoProjectKey(REPO_ID, ORG_A, PROJECT), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: PROJECT, installationId: 55, githubRepositoryId: REPO_ID });
  db.set({ ...projectRevisionKey(ORG_A, PROJECT, 1), entityType: "PROJECT_REVISION", definition: { name: PROJECT, revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: REPO_ID }], setup: [], readiness: [], orchestratorInstructions: "x" } });
  // The Rovara task and its pull request: Rovara's last push was PUSHED (the lessons World's task record is the other side of the same task).
  db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_A, project: PROJECT, workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: PR, headSha: PUSHED, candidateDigest: "b".repeat(64), required: true, state: "OPEN" }] } });
  db.set({ ...githubWorkflowPullRequestKey("acme/api", 7), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/api", number: 7, repositoryId: "api", taskId: TASK, workspaceId: ORG_A, candidateDigest: "b".repeat(64), url: PR });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk, captureAdapters: adapters, log: () => undefined })!;
  return { db, runtime };
}
const diff = (commits: CodeHostDiff["commits"]): CodeHostDiff => ({ status: "ahead", truncated: false, commits, files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-for (;;) {}\n+await withRetryEDIT(() => fetch())" }] });
const githubAdapter = (read: () => Promise<CodeHostDiff | undefined>): CodeHostCaptureAdapter => ({
  host: "github", supports: { pullRequestComments: true, commentOutdated: true, humanEdits: true, authorship: "verified_commits_and_push_chain", mergeCommit: true }, pullRequestAddress: githubPullRequestAddress, diffs: { compare: read },
});
const mergedDelivery = () => ({ eventName: "pull_request", deliveryId: randomUUID(), payload: { action: "closed", installation: { id: 55 }, repository: { id: REPO_ID, full_name: "acme/api", private: false, default_branch: "main" }, sender: alice, pull_request: {
  number: 7, html_url: PR, title: "Fix", body: "x", user: alice, head: { sha: HEAD, ref: "fix" }, base: { ref: "main" }, merged: true, merge_commit_sha: "9".repeat(40), updated_at: "2026-10-30T11:00:00Z" } } });
const addRow = (w: ReturnType<typeof setup>) => putSourceConfig({ documentClient: w.db, tableName: "TeamRecord" }, {
  workspaceId: ORG_A, project: PROJECT, source: "github", scope: `github:repo/${REPO_ID}`, enabled: true, retention: "C", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "ann", updatedAt: "2026-10-30T10:00:00.000Z",
}, { edition: "enterprise" });

async function merged(commits: CodeHostDiff["commits"]) {
  const lessons = new World({ mergedHead: HEAD, pushedHead: PUSHED });
  const queued: HumanEditJob[] = [];
  const w = setup([githubAdapter(async () => diff(commits))]);
  await addRow(w);
  w.runtime.humanEdit.install({ extractor: lessons.extractor(), enqueue: async (job) => { queued.push(job); } });
  await w.runtime.taps.github(mergedDelivery());
  return { lessons, queued, runtime: w.runtime };
}

describe("the edits reflection through the real Team record runtime", () => {
  it("a merged delivery queues a job; the job proves the author, reads the compare and runs the REAL extractor: one edits call with the edit and the pull request's comments, repo-only for the repository", async () => {
    const { lessons, queued, runtime } = await merged([{ sha: "c".repeat(40), author: maya, committer: maya, verified: true }]);
    expect(queued).toHaveLength(1);
    expect(await runtime.humanEdit.run(queued[0]!, { leased: true })).toBe("handed_on");
    expect(lessons.repoCalls()).toHaveLength(1);
    const prompt = lessons.repoCalls()[0]!.user;
    expect(prompt).toContain("withRetryEDIT");
    expect(prompt).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
    expect((await lessons.lessons()).some((lesson) => lesson.provenance.repoOnly?.place === `github:repo/${REPO_ID}`)).toBe(true);
    // The job again (a redelivery) makes no second call.
    await runtime.humanEdit.run(queued[0]!, { leased: true });
    expect(lessons.repoCalls()).toHaveLength(1);
  });

  it("a job the tap skips ('Update branch': a merge commit in the range) makes no edits call, and the task end's comments reflection is a call of its own that still runs", async () => {
    const { lessons, queued, runtime } = await merged([{ sha: "c".repeat(40), author: maya, committer: maya, verified: true, merge: true }]);
    expect(await runtime.humanEdit.run(queued[0]!, { leased: true })).toBe("skipped");
    expect(lessons.repoCalls()).toHaveLength(0);
    await lessons.end();
    expect(lessons.repoCalls()).toHaveLength(1);
    expect(lessons.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
  });
});
