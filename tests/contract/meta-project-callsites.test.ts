// Meta repo lane A, follow-up to the re-check: tests for the call sites that no other test reached. Each fails when the line it names is reverted.
//   - I3: the places that look up a repository to publish to, maintain or open a pull request in use the project's CODE repositories (never a pure meta repository);
//   - I4: a finished prepare stores the task's knowledgeCommit from the broker's choice only; a half-finished workspace at another commit is refused;
//   - the handler wiring (the push queue and the meta routes) and the config reader's size cap (M3).
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StoredProjectDefinitionSchema, orgProjectCatalogKey, projectRevisionKey } from "../../packages/contracts/src/index.js";
import { completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { metaConfigQueueFor, metaRepoRouteDependencies, metaRepositoryReaders } from "../../packages/broker/src/aws/broker/meta-repo-wiring.js";
import { prepareWorkspace, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { readBrokerSource } from "../support/broker-source.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const META = { name: "service-meta", url: "https://github.com/example/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" };
const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000010`;
const user = "U0123456789";

describe("pull-request actions (I3, acceptance.ts)", () => {
  it("refuse a repository that is only the project's meta repository", async () => {
    const getDefaultBranchHead = vi.fn(async () => "c".repeat(40));
    const { handler, db } = createBroker({ extra: { githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getDefaultBranchHead } } });
    await registerSlackProject(handler, { extraRepositories: [META] });
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const outboxBefore = db.find((item) => item.entityType === "OUTBOX").length;
    const refused = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, { requestId: randomUUID(), repository: "service-meta", pullRequestNumber: 1, action: "close" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("repository is not registered for this project");
    expect(db.find((item) => item.entityType === "OUTBOX").length).toBe(outboxBefore);
  });
});

// ---- the broker's completion of a prepare and of a publish, with the project in a table

const PROJECT = "payments";
const definition = StoredProjectDefinitionSchema.parse({
  name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
  repositories: [{ name: "api", url: "https://github.com/example/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }, META],
});
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
function brokerWorld(workflow: Record<string, unknown>) {
  const db = new FakeDynamoDb();
  const taskId = randomUUID();
  db.set({ ...projectRevisionKey(TEST_ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition });
  db.set({ ...orgProjectCatalogKey(TEST_ORG, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...taskKey(taskId), entityType: "DEVTASK", taskId, orgId: TEST_ORG, project: PROJECT, startingRevision: 1, workspaceId: randomUUID(), workflow });
  const dependencies = { documentClient: db, tableName: "state", cloud: false } as never;
  const pointer = { taskId } as never;
  return { db, dependencies, pointer, taskId };
}
const COMMIT = "a".repeat(40);
const prepareOperation = (knowledgeCommit: string | undefined) => ({ kind: "prepare", id: randomUUID(), workspaceId: randomUUID(), ...(knowledgeCommit === undefined ? {} : { knowledgeCommit }) }) as never;
const updateOf = (items: unknown[]) => (items[0] as { Update: { UpdateExpression: string; ExpressionAttributeValues?: Record<string, unknown> } }).Update;

describe("a finished prepare and the task's knowledgeCommit (I4, workflow-items.ts)", () => {
  const base = [{ repositoryId: "api", baseCommitSha: "b".repeat(40) }];
  it("stores the commit the broker chose when the worker reports the same one", async () => {
    const w = brokerWorld({ stage: "PLAN" });
    const items = await completedWorkflowItems(w.dependencies, prepareOperation(COMMIT), w.pointer, "SUCCEEDED", "2026-10-31T10:00:00.000Z", { preparedBase: base, knowledgeCommit: COMMIT });
    expect(updateOf(items)).toMatchObject({ UpdateExpression: "SET preparedBase = :base, knowledgeCommit = :knowledgeCommit", ExpressionAttributeValues: { ":knowledgeCommit": COMMIT } });
  });
  it("stores nothing the worker chose: another reported commit, none reported, or no choice by the broker all remove it", async () => {
    const w = brokerWorld({ stage: "PLAN" });
    for (const [chosen, result] of [[COMMIT, { preparedBase: base, knowledgeCommit: "d".repeat(40) }], [COMMIT, { preparedBase: base }], [undefined, { preparedBase: base, knowledgeCommit: COMMIT }]] as const) {
      const items = await completedWorkflowItems(w.dependencies, prepareOperation(chosen), w.pointer, "SUCCEEDED", "2026-10-31T10:00:00.000Z", result);
      const update = updateOf(items);
      expect(update.UpdateExpression).toBe("SET preparedBase = :base REMOVE knowledgeCommit");
      expect(JSON.stringify(update.ExpressionAttributeValues)).not.toContain("knowledgeCommit");
    }
  });
});

describe("a finished publish (I3, workflow-items.ts)", () => {
  const refusal = async (promise: Promise<unknown>): Promise<{ code: string; unregistered: boolean }> => {
    try { await promise; return { code: "ok", unregistered: false }; } catch (error) { const e = error as { code?: string; message?: string }; return { code: e.code ?? "other", unregistered: (e.message ?? "").includes("published pull request repository is not part of the task's registered project revision") }; }
  };
  const published = (repository: string) => ({ repository, number: 7, url: `https://github.com/example/${repository}/pull/7`, headBranch: `agentx/${randomUUID()}`, baseBranch: "main", commit: "d".repeat(40), checks: [], codeBuildChecks: [], reconciled: false });
  const publishOperation = () => ({ kind: "publish", id: randomUUID(), workspaceId: randomUUID() }) as never;
  const publishing = { stage: "PULL_REQUEST", state: "READY", candidate: { digest: "x", repositories: [] } };
  it("does not accept a pull request reported for the meta repository", async () => {
    const w = brokerWorld(publishing);
    expect(await refusal(completedWorkflowItems(w.dependencies, publishOperation(), w.pointer, "SUCCEEDED", "2026-10-31T10:00:00.000Z", published("service-meta")))).toEqual({ code: "CONFIG_INVALID", unregistered: true });
  });
  it("gets past that check for a code repository (so the refusal above is about the repository)", async () => {
    const w = brokerWorld(publishing);
    expect((await refusal(completedWorkflowItems(w.dependencies, publishOperation(), w.pointer, "SUCCEEDED", "2026-10-31T10:00:00.000Z", published("api")))).unregistered).toBe(false);
  });
});

describe("the repository lookups of publishing, maintaining and reconciling use the code repositories only (I3)", () => {
  // These sites handle operations that already passed the publish gate and need whole task workflows to drive; the lookups are pinned by what the source says, so a revert fails here.
  const source = readBrokerSource();
  const count = (text: string) => source.split(text).length - 1;
  it.each([
    ["acceptance.ts pull request", "codeRepositoriesOf(project.definition).find((candidate) => candidate.name === request.repository)", 2],
    ["workflow-items.ts pull request update (feedback read)", "codeRepositoriesOf(project.definition).find((entry) => entry.name === maintenance.repository)", 2],
    ["workflow-items.ts changed pull request", "codeRepositoriesOf(project.definition).find((entry) => entry.name === pullRequest.repositoryId)", 1],
    ["workflow-items.ts published pull request", "codeRepositoriesOf(project.definition).find((entry) => entry.name === published.data.repository)", 1],
    ["pull-request-reconcile.ts work breakdown base", "codeRepositoriesOf(project.definition).find((entry) => entry.name === invocation.graph.items[0]?.repository)", 1],
  ])("%s", (_name, text, times) => {
    expect(count(text)).toBe(times);
    // And no lookup of those names goes through the full list.
    expect(count(text.replace("codeRepositoriesOf(project.definition)", "project.definition.repositories"))).toBe(0);
  });
  it("pins the push grant to code repositories", () => {
    expect(count('access === "push" ? codeRepositoriesOf(project.definition) : project.definition.repositories')).toBe(1);
  });
});

// ---- the worker resumes a half-finished workspace

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv })).stdout.trim();

describe("a half-finished workspace (I4, worker prepare.ts)", () => {
  it("is not resumed at a meta commit other than the one asked for", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-resume-"));
    const sources: Record<string, string> = {};
    for (const [name, files] of [["api", { "README.md": "# api\n" }], ["service-meta", { "AGENTS.md": "# rules\n" }]] as const) {
      const dir = join(root, `${name}-source`);
      await mkdir(dir, { recursive: true });
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", dir], { env: gitEnv });
      for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), text, "utf8"); }
      await git(dir, "add", "-A");
      await git(dir, "commit", "--quiet", "-m", "init");
      sources[name] = dir;
    }
    const first = await git(sources["service-meta"]!, "rev-parse", "HEAD");
    await writeFile(join(sources["service-meta"]!, "AGENTS.md"), "# later\n", "utf8");
    await git(sources["service-meta"]!, "commit", "--quiet", "-am", "later");
    const later = await git(sources["service-meta"]!, "rev-parse", "HEAD");
    const project = StoredProjectDefinitionSchema.parse({ name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "x", repositories: [{ name: "api", url: "https://github.com/example/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }] });
    const materializer: RepositoryMaterializer = async (repository, target) => {
      await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(sources[repository.name === "service-meta" ? "service-meta" : "api"]!).href, target], { env: gitEnv });
    };
    const request = (commit: string) => ({ repository: { name: "service-meta", url: META.url, path: META.path, defaultBranch: "main", credentialRef: "github-app" }, paths: ["AGENTS.md"], commit });
    const rootPath = await mkdtemp(join(root, "ws-"));
    await prepareWorkspace({ rootPath, project, readOnly: true, materializer, meta: request(first) });
    // The workspace did not finish (it stopped before it was complete): the manifest is not complete but already records the meta repository.
    const manifestPath = join(rootPath, ".agentx/preparation-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, complete: false }), "utf8");
    await expect(prepareWorkspace({ rootPath, project, readOnly: true, materializer, meta: request(later) })).rejects.toThrow("another commit than the one asked for");
    // The same commit resumes.
    await expect(prepareWorkspace({ rootPath, project, readOnly: true, materializer, meta: request(first) })).resolves.toMatchObject({ complete: true, meta: { resolvedCommit: first } });
  });
});

// ---- the handler's wiring and the config reader's cap

describe("the handler's meta repo wiring", () => {
  const handlerSource = readBrokerSource();
  it("hands the GitHub trigger handler the push queue, and the route dependencies the meta routes", () => {
    expect(handlerSource).toContain("queueMetaConfigImport: metaConfigQueueFor(dependencies),");
    expect(handlerSource).toContain("Object.assign(routeDependencies, metaRepoRouteDependencies(dependencies, routeDependencies.projectSettings));");
  });
  it("gives the routes createFromMeta always, and metaConfig only where the settings pieces exist", () => {
    const dependencies = { cloud: true, githubPullRequests: {}, documentClient: {}, tableName: "t" } as never;
    expect(Object.keys(metaRepoRouteDependencies(dependencies, undefined))).toEqual(["createFromMeta"]);
    const withSettings = metaRepoRouteDependencies(dependencies, { registerRevision: vi.fn() });
    expect(Object.keys(withSettings.metaConfig ?? {}).sort()).toEqual(["getHead", "readMetaFile", "registerRevision"]);
  });
  it("queues an import by reading the branch head, not by trusting the event", async () => {
    const getDefaultBranchHead = vi.fn(async () => "b".repeat(40));
    const getFileAtCommit = vi.fn(async () => undefined);
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(TEST_ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition });
    db.set({ ...orgProjectCatalogKey(TEST_ORG, PROJECT), entityType: "PROJECT_CATALOG", name: PROJECT, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    const queue = metaConfigQueueFor({ cloud: true, tableName: "state", documentClient: db, githubPullRequests: { getDefaultBranchHead, getFileAtCommit } } as never);
    await queue({ orgId: TEST_ORG, project: PROJECT, commit: "e".repeat(40) });
    expect(getDefaultBranchHead).toHaveBeenCalledWith(META.url, "main", { orgId: TEST_ORG });
    // The files are read at the head GitHub said, not at the event's commit.
    expect(getFileAtCommit.mock.calls.every((call) => (call as unknown[])[2] === "b".repeat(40))).toBe(true);
    expect(getFileAtCommit).toHaveBeenCalled();
  });
  it("reads a config file with the size cap, in the org's scope", async () => {
    const getFileAtCommit = vi.fn(async () => "version: 1\n");
    // The code host of the repository is found from the project's record (task P5e), so the project is there.
    const db = new FakeDynamoDb();
    db.set({ ...projectRevisionKey(TEST_ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition });
    const readers = metaRepositoryReaders({ cloud: true, tableName: "state", documentClient: db, githubPullRequests: { getFileAtCommit } } as never);
    await readers.readMetaFile({ orgId: TEST_ORG, project: PROJECT, repository: { name: "m", url: META.url }, commit: "a".repeat(40), path: ".rovara/project.yaml" });
    expect(getFileAtCommit).toHaveBeenCalledWith(META.url, ".rovara/project.yaml", "a".repeat(40), { orgId: TEST_ORG }, { maxBytes: 262_144 });
  });
});
