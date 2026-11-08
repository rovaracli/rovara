// SRL-3 (owner decision 24b): reverts of Rovara pull requests are recorded. The production `RovaraPullRequestIndexPort` finds the Rovara pull request merged as a given commit
// from an index row written when the merge is recorded (`rovara-code/merge-commit-index.ts`). Proved here: the row is written in the merge's own transaction, `byMergeCommit` finds the
// pull request, a different company / repository / task / commit never matches, and a revert named by commit records `rovara.closed{reverted}` exactly once through the real runtime.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, githubInstallationKey, githubMemberKey, githubRepoProjectKey, developerOrgKey, projectRevisionKey, type OrgId } from "@agentx/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { SdkUnavailableError } from "../../../packages/broker/src/team-record/aws-adapters.js";
import { createRovaraPullRequestIndex } from "../../../packages/broker/src/rovara-code/rovara-pull-request-index.js";
import { mergeCommitIndexItem, mergeCommitKey, backfillMergeCommitIndex } from "../../../packages/broker/src/rovara-code/merge-commit-index.js";
import { mergedStateItems } from "../../../packages/broker/src/rovara-code/merged-state.js";
import { taskKey } from "../../../packages/broker/src/developer/task-records.js";
import { parseBackfillArgs, runBackfill } from "../../../scripts/backfill-merge-commit-index.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, T0 } from "../../support/team-record-core.js";

const NOW = "2026-11-08T10:00:00.000Z";
const hex = (n: number): string => n.toString(16).padStart(40, "0");
const MERGE = hex(0xabc);
const HEAD = hex(0x111);
const TASK = "task-1";
const URL_ = "https://github.com/acme/api/pull/7";
const linkKey = { pk: "GITHUB_PR#acme/api", sk: `PR#${"7".padStart(10, "0")}` };

/** The rows a published Rovara pull request has: its reverse link and the task with the pull request recorded. */
function seedTask(db: FakeDynamoDb, over: { orgId?: OrgId; taskId?: string; headSha?: string | undefined } = {}) {
  const taskId = over.taskId ?? TASK;
  db.set({ ...linkKey, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/api", repositoryId: "api", number: 7, url: URL_, taskId, workspaceId: "workspace", candidateDigest: "d".repeat(64), createdAt: NOW });
  db.set({ ...taskKey(taskId), taskId, orgId: over.orgId ?? ORG_A, project: "web", workflow: { pullRequests: [{ repositoryId: "api", number: 7, url: URL_, state: "MERGED", ...(over.headSha === undefined && "headSha" in over ? {} : { headSha: over.headSha ?? HEAD }) }] } });
}
function seedIndex(db: FakeDynamoDb, over: Partial<Record<string, unknown>> = {}) {
  db.set({ ...mergeCommitKey(ORG_A, "acme/api", MERGE)!, entityType: "GITHUB_WORKFLOW_MERGE", orgId: ORG_A, repositoryFullName: "acme/api", repositoryId: "api", number: 7, url: URL_, taskId: TASK, mergeCommit: MERGE, createdAt: NOW, ...over });
}
const portOf = (db: FakeDynamoDb) => createRovaraPullRequestIndex({ documentClient: db, tableName: "State" });
const ask = (over: Partial<{ workspaceId: string; host: string; repo: string; sha: string }> = {}) => ({ workspaceId: ORG_A, host: "github", repo: "acme/api", sha: MERGE, ...over });

describe("SRL-3: the index row is written with the merge", () => {
  const flow = (state: "OPEN" | "MERGED", url = URL_) => ({ stage: "WAIT_FOR_MERGE", pullRequests: [{ repositoryId: "api", number: 7, url, state }] }) as never;
  const items = (observed: Array<{ repositoryId: string; number: number; mergeCommit?: string }>, url = URL_) =>
    mergedStateItems({ documentClient: new FakeDynamoDb(), tableName: "State" }, { taskId: TASK, orgId: ORG_A }, flow("OPEN"), flow("MERGED", url), NOW, observed);
  const putsOf = (list: Awaited<ReturnType<typeof items>>) => list.flatMap((item) => ("Put" in item && item.Put ? [item.Put.Item as Record<string, unknown>] : [])).filter((item) => item.entityType === "GITHUB_WORKFLOW_MERGE");

  it("a pull request that moves to MERGED with a merge commit gets one index row, keyed by repository and commit, holding no person", async () => {
    const [row, ...rest] = putsOf(await items([{ repositoryId: "api", number: 7, mergeCommit: MERGE }]));
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ ...mergeCommitKey(ORG_A, "acme/api", MERGE), orgId: ORG_A, repositoryFullName: "acme/api", repositoryId: "api", number: 7, url: URL_, taskId: TASK, mergeCommit: MERGE });
    expect(row!.pk).toBe(`ORG#${ORG_A}#GITHUB_MERGE`);
    expect(typeof row![INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    expect(Object.keys(row!).sort()).toEqual(["createdAt", INDEX_EXPIRY_ATTRIBUTE, "entityType", "mergeCommit", "number", "orgId", "pk", "repositoryFullName", "repositoryId", "sk", "taskId", "url"].sort());
  });

  it("a merge that names no commit, a malformed commit, or a pull request that is not on GitHub writes no row, and never fails the merge record", async () => {
    expect(putsOf(await items([{ repositoryId: "api", number: 7 }]))).toEqual([]);
    expect(putsOf(await items([{ repositoryId: "api", number: 7, mergeCommit: "not-a-sha" }]))).toEqual([]);
    expect(putsOf(await items([{ repositoryId: "api", number: 7, mergeCommit: MERGE.toUpperCase() }]))).toHaveLength(1);
    expect(putsOf(await items([{ repositoryId: "api", number: 7, mergeCommit: MERGE }], "https://git.example.com/acme/api/pull/7"))).toEqual([]);
    expect(putsOf(await items([{ repositoryId: "other", number: 9, mergeCommit: MERGE }]))).toEqual([]);
  });

  it("L2: a merge that got no row is counted by reason in one line, with no task, repository or commit in it", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await items([{ repositoryId: "api", number: 7 }]);
      await items([{ repositoryId: "api", number: 7, mergeCommit: "nope" }]);
      await items([{ repositoryId: "api", number: 7, mergeCommit: MERGE }]);
    } finally { log.mockRestore(); }
    const missed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "merge_commit_index.missed");
    expect(missed).toEqual([
      { component: "broker", level: "warn", event: "merge_commit_index.missed", reason: "no_merge_commit", count: 1 },
      { component: "broker", level: "warn", event: "merge_commit_index.missed", reason: "bad_merge_commit", count: 1 },
    ]);
    expect(lines.join("\n")).not.toContain(TASK);
  });

  it("a pull request already merged before this save gets no new row (a replay writes nothing)", async () => {
    const list = await mergedStateItems({ documentClient: new FakeDynamoDb(), tableName: "State" }, { taskId: TASK, orgId: ORG_A }, flow("MERGED"), flow("MERGED"), NOW, [{ repositoryId: "api", number: 7, mergeCommit: MERGE }]);
    expect(putsOf(list)).toEqual([]);
  });

  it("the row is applied in the merge's transaction and applying it twice leaves one identical row", async () => {
    const db = new FakeDynamoDb();
    const put = mergeCommitIndexItem("State", { orgId: ORG_A, repositoryFullName: "Acme/API", repositoryId: "api", number: 7, url: URL_, taskId: TASK, mergeCommit: MERGE, now: NOW })!;
    await db.send(new TransactWriteCommand({ TransactItems: [put] }));
    const first = db.get(mergeCommitKey(ORG_A, "acme/api", MERGE)!);
    await db.send(new TransactWriteCommand({ TransactItems: [put] }));
    expect(db.get(mergeCommitKey(ORG_A, "acme/api", MERGE)!)).toEqual(first);
    expect(db.find((item) => item.entityType === "GITHUB_WORKFLOW_MERGE")).toHaveLength(1);
  });
});

describe("SRL-3: byMergeCommit", () => {
  it("finds the Rovara pull request merged as that commit", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    seedIndex(db);
    expect(await portOf(db).byMergeCommit(ask())).toEqual({ taskId: TASK, project: "web", number: 7, url: URL_, candidateHeadSha: HEAD, mergeCommitSha: MERGE });
  });

  it("the repository name's case and the commit's case do not matter", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    seedIndex(db);
    expect(await portOf(db).byMergeCommit(ask({ repo: "Acme/API", sha: MERGE.toUpperCase() }))).toMatchObject({ taskId: TASK });
  });

  it("another company never resolves it (positive control: the owner does)", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    seedIndex(db);
    expect(await portOf(db).byMergeCommit(ask({ workspaceId: ORG_A }))).toMatchObject({ taskId: TASK });
    expect(await portOf(db).byMergeCommit(ask({ workspaceId: ORG_B }))).toBeUndefined();
    // A task of another company behind a row that names this one is refused too.
    const other = new FakeDynamoDb();
    seedTask(other, { orgId: ORG_B });
    seedIndex(other);
    expect(await portOf(other).byMergeCommit(ask())).toBeUndefined();
  });

  it("another repository, another commit, another host, or a malformed commit never matches", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    seedIndex(db);
    const port = portOf(db);
    expect(await port.byMergeCommit(ask({ repo: "acme/web" }))).toBeUndefined();
    expect(await port.byMergeCommit(ask({ repo: "evil/api" }))).toBeUndefined();
    expect(await port.byMergeCommit(ask({ sha: hex(0xdef) }))).toBeUndefined();
    expect(await port.byMergeCommit(ask({ host: "gitlab" }))).toBeUndefined();
    expect(await port.byMergeCommit(ask({ sha: "abc" }))).toBeUndefined();
    expect(await port.byMergeCommit(ask({ repo: "acme/api#x" }))).toBeUndefined();
  });

  it("a row that does not say what its key says, or whose task or link moved, is a miss (fail closed)", async () => {
    for (const over of [{ repositoryFullName: "acme/web" }, { mergeCommit: hex(1) }, { taskId: "task-2" }, { number: 8 }, { url: "https://github.com/acme/api/pull/9" }, { entityType: "OTHER" }]) {
      const db = new FakeDynamoDb();
      seedTask(db);
      seedIndex(db, over);
      expect(await portOf(db).byMergeCommit(ask()), JSON.stringify(over)).toBeUndefined();
    }
    const noHead = new FakeDynamoDb();
    seedTask(noHead, { headSha: undefined });
    seedIndex(noHead);
    expect(await portOf(noHead).byMergeCommit(ask())).toBeUndefined();
    expect(await portOf(new FakeDynamoDb()).byMergeCommit(ask())).toBeUndefined();
  });

  it("byNumber is unchanged: the same lookup by pull request number", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    expect(await portOf(db).byNumber({ workspaceId: ORG_A, host: "github", repo: "acme/api", number: 7 })).toEqual({ taskId: TASK, project: "web", number: 7, url: URL_, candidateHeadSha: HEAD });
    expect(await portOf(db).byNumber({ workspaceId: ORG_B, host: "github", repo: "acme/api", number: 7 })).toBeUndefined();
  });
});

// ---- the whole path through the real runtime
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const noSdk = async (): Promise<never> => { throw new SdkUnavailableError(); };
const OWNER = "a".repeat(64);
const REPO_ID = 101;
const alice = { id: 123, login: "maya", type: "User" };

async function runtimeWorld() {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...githubMemberKey(ORG_A, "123"), entityType: "GITHUB_MEMBER", developerId: "dev-1", orgId: ORG_A });
  db.set({ ...developerOrgKey("dev-1"), entityType: "DEVELOPER_ORG", orgId: ORG_A, role: "member" });
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", orgId: ORG_A, status: "active" });
  db.set({ ...githubRepoProjectKey(REPO_ID, ORG_A, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "web", installationId: 55, githubRepositoryId: REPO_ID });
  db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT_REVISION",
    definition: { name: "web", revision: 1, repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: REPO_ID }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
  });
  const runtime = createTeamRecordRuntime({ env: { ...ON, TEAM_RECORD_VECTORS_ROLE_ARN: undefined }, documentClient: db, stateTableName: "State", now: () => T0, sdk: noSdk });
  if (runtime === undefined) throw new Error("the runtime was not built");
  const added = await runtime.routes({
    method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: { orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" },
    write: { orgRole: "owner", browserSession: true, body: () => ({ action: "add", requestId: randomUUID(), source: "github", scope: `github:repo/${String(REPO_ID)}`, retention: "C", audienceDefault: "maintainers", enabled: true }) },
  });
  expect(added).toMatchObject({ status: 200 });
  return { db, runtime };
}
const envelope = { installation: { id: 55 }, repository: { id: REPO_ID, full_name: "acme/api", private: false, default_branch: "main" } };
const push = (message: string, id = hex(0xf00)) => ({ eventName: "push", deliveryId: randomUUID(), payload: { ...envelope, action: "push", ref: "refs/heads/main", before: hex(1), after: id, sender: alice, commits: [{ id, message }] } });
const eventRows = (db: FakeDynamoDb) => db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
const closedRows = (db: FakeDynamoDb) => eventRows(db).filter((row) => row.kind === "rovara.closed" && !row.tombstone);

describe("SRL-3: a revert of a Rovara pull request is recorded", () => {
  it("SRL-3: a push whose message says 'This reverts commit <merge commit>' records nothing here: the runtime has no compare reader yet, and a revert told only by a commit message counts only when its commit is proved a member's", async () => {
    const { db, runtime } = await runtimeWorld();
    seedTask(db);
    seedIndex(db);
    const before = eventRows(db).length;
    expect(await runtime.taps.github(push(`Revert "Fix cart"\n\nThis reverts commit ${MERGE}.`))).toMatchObject({ written: 0, failed: 0 });
    expect(eventRows(db)).toHaveLength(before);
    expect(closedRows(db)).toEqual([]);
  });

  it("a merged revert pull request whose body names the merge commit records rovara.closed{reverted} once, however often it is delivered", async () => {
    const { db, runtime } = await runtimeWorld();
    seedTask(db);
    seedIndex(db);
    const pr = { number: 20, html_url: "https://github.com/acme/api/pull/20", title: 'Revert "Fix cart"', body: `This reverts commit ${MERGE}.`, user: alice, head: { sha: hex(20), ref: "revert-fix" }, base: { ref: "main" }, merged: true, merge_commit_sha: hex(0xf02), updated_at: "2026-11-08T11:00:00Z" };
    const deliver = () => runtime.taps.github({ eventName: "pull_request", deliveryId: randomUUID(), payload: { ...envelope, action: "closed", pull_request: pr, sender: alice } });
    expect(await deliver()).toMatchObject({ failed: 0 });
    expect(closedRows(db)).toHaveLength(1);
    expect(closedRows(db)[0]).toMatchObject({ workspaceId: ORG_A, project: "web", structured: { taskId: TASK, outcome: "reverted" } });
    await deliver();
    expect(closedRows(db)).toHaveLength(1);
  });

  it("a revert of a commit no Rovara pull request was merged as, or in another repository or company, records nothing and fails nothing", async () => {
    const { db, runtime } = await runtimeWorld();
    seedTask(db);
    // The index row belongs to another company's repository of the same name and commit: it must not match here.
    seedIndex(db, { orgId: ORG_B });
    const before = eventRows(db).length;
    expect(await runtime.taps.github(push(`This reverts commit ${MERGE}.`))).toMatchObject({ written: 0, failed: 0 });
    expect(await runtime.taps.github(push(`This reverts commit ${hex(0x999)}.`, hex(0xf03)))).toMatchObject({ written: 0, failed: 0 });
    expect(eventRows(db)).toHaveLength(before);
    expect(closedRows(db)).toEqual([]);
  });
});

describe("SRL-3: the optional backfill", () => {
  const outcome = (over: Record<string, unknown> = {}) => ({
    pk: `ORG#${ORG_A}#OUTCOME#web#review`, sk: `SAMPLE#${randomUUID()}`, entityType: "OUTCOME_SAMPLE", orgId: ORG_A, project: "web", taskId: TASK, state: "held",
    pr: { repositoryId: "api", number: 7, mergeCommit: MERGE, mergedAt: NOW }, ...over,
  });

  it("puts the missing row for a scored merge, once, and a second run changes nothing", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    db.set(outcome());
    db.set(outcome({ sk: `SAMPLE#${randomUUID()}` }));
    const first = await backfillMergeCommitIndex({ documentClient: db, tableName: "State", now: () => Date.parse(NOW) });
    expect(first).toMatchObject({ scanned: 2, created: 1, existing: 0, skipped: 1, finished: true }); // the second sample is the same pull request
    expect(await portOf(db).byMergeCommit(ask())).toMatchObject({ taskId: TASK, mergeCommitSha: MERGE });
    const second = await backfillMergeCommitIndex({ documentClient: db, tableName: "State", now: () => Date.parse(NOW) });
    expect(second).toMatchObject({ created: 0, existing: 1, finished: true });
    expect(db.find((item) => item.entityType === "GITHUB_WORKFLOW_MERGE")).toHaveLength(1);
  });

  it("skips a sample whose task is gone, whose pull request is not recorded merged, or whose commit is malformed", async () => {
    const db = new FakeDynamoDb();
    seedTask(db);
    db.set(outcome({ taskId: "gone" }));
    db.set(outcome({ pr: { repositoryId: "api", number: 7, mergeCommit: "nope" } }));
    db.set(outcome({ pr: { repositoryId: "api", number: 99, mergeCommit: MERGE } }));
    db.set(outcome({ pr: undefined }));
    const result = await backfillMergeCommitIndex({ documentClient: db, tableName: "State", now: () => Date.parse(NOW) });
    expect(result).toMatchObject({ created: 0, finished: true });
    expect(result.skipped).toBeGreaterThanOrEqual(3);
    expect(db.find((item) => item.entityType === "GITHUB_WORKFLOW_MERGE")).toEqual([]);
  });
});

describe("SRL-3: the backfill command", () => {
  it("needs a table and a profile, refuses unknown or repeated options, and runs the backfill", async () => {
    expect(() => parseBackfillArgs(["--profile", "p"])).toThrow(/--table/u);
    expect(() => parseBackfillArgs(["--table", "State"])).toThrow(/--profile/u);
    expect(() => parseBackfillArgs(["--table", "State", "--profile", "p", "--region", "us-west-2", "--bogus", "1"])).toThrow(/unknown option/u);
    expect(() => parseBackfillArgs(["--table", "State", "--profile", "p", "--region", "us-west-2", "--table", "Other"])).toThrow(/twice/u);
    expect(() => parseBackfillArgs(["--table", "State", "--profile", "p", "--region", "us-west-2", "--max-ms", "soon"])).toThrow(/whole number/u);
    // L4: the region has no default (staging is us-west-2, this Mac defaults to us-east-1).
    expect(() => parseBackfillArgs(["--table", "State", "--profile", "p"])).toThrow(/--region/u);
    expect(() => parseBackfillArgs(["--table", "State", "--profile", "p", "--region", "west"])).toThrow(/--region/u);
    const args = parseBackfillArgs(["--table", "State", "--profile", "p", "--region", "us-west-2"]);
    expect(args).toMatchObject({ table: "State", profile: "p", region: "us-west-2" });
    const db = new FakeDynamoDb();
    seedTask(db);
    db.set({ pk: `ORG#${ORG_A}#OUTCOME#web#review`, sk: "SAMPLE#1", entityType: "OUTCOME_SAMPLE", orgId: ORG_A, taskId: TASK, pr: { repositoryId: "api", number: 7, mergeCommit: MERGE } });
    expect(await runBackfill({ ...args, pauseMs: 0 }, db, () => Date.parse(NOW))).toMatchObject({ created: 1, finished: true });
  });
});
