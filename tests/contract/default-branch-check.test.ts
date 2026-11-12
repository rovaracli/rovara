// 0.5.16: the default-branch check. When a project is added, Rovara reads the chosen default branch on GitHub before any setup work starts. An empty branch (git's empty tree) with code on another branch
// gets the suggestion; a repository with no code at all says so; a non-empty branch behaves as before; GitHub that cannot answer fails open (and starts nothing by itself); another company's repository is refused;
// choosing another branch runs the same check; and no setup draft starts while the branch is empty, missing or has no code, until the person explicitly continues.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@rovara-code/contracts";
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { githubInstallationKey, orgGithubInstallationKey, type GithubInstallationRecord } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, setupDraftKey, type OrgId } from "@rovara-code/contracts";
import { GIT_EMPTY_TREE_SHA, GitHubAppCredentialProvider, type RepositoryBranchProbe } from "../../packages/broker/src/github-app.js";
import { branchStateOf } from "../../packages/broker/src/org/branch-check.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const NAME = "web";
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const entry = (name: string, empty: boolean, lastCommitAt?: string) => ({ name, empty, ...(lastCommitAt === undefined ? {} : { lastCommitAt }) });

// ---- GitHub's side: the probe, against a fake GitHub

const REPO = "https://github.com/acme/web.git";
const API = "https://api.github.com/repos/acme/web";
const SCOPE = { orgId: TEST_ORG } as const;
const TOKEN = ["installation", "token", "for", "tests"].join("-");
const sha = (n: number) => n.toString(16).padStart(40, "0");

/** A fake GitHub repository: `branches` is what it holds (a tree of GIT_EMPTY_TREE_SHA is an empty branch). `fail` makes the named path answer 500. */
function githubWorld(branches: Record<string, { tree: string; date: string }>, options: { fail?: (path: string) => boolean; unbound?: boolean } = {}) {
  const paths: string[] = [];
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 7, account: { login: "acme" } }), { status: 200 });
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: TOKEN, expires_at: "2030-01-01T00:00:00Z" }), { status: 201 });
    expect(init?.redirect).toBe("error");
    const path = url.slice(API.length);
    paths.push(path);
    if (options.fail?.(path) === true) return new Response("{}", { status: 500 });
    if (path.startsWith("/branches?")) return new Response(JSON.stringify(Object.keys(branches).sort().map((name, at) => ({ name, commit: { sha: sha(at + 1) } }))), { status: 200 });
    const name = decodeURIComponent(path.replace(/^\/branches\//u, "")), found = branches[name];
    if (found === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ name, commit: { sha: sha(9), commit: { tree: { sha: found.tree }, committer: { date: found.date } } } }), { status: 200 });
  }) as typeof fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation,
    requireInstallationBound: async (orgId: OrgId) => { if (options.unbound === true || orgId !== TEST_ORG) throw agentXError("GITHUB_NOT_CONNECTED", "not connected"); },
  });
  return { provider, paths };
}
const FULL = sha(0x5);
// Git's empty tree, spelled out here on purpose: the test must not take it from the code it checks.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const empty = { tree: EMPTY_TREE, date: "2026-11-01T00:00:00Z" };
const code = (date: string) => ({ tree: FULL, date });

describe("probeBranches (GitHub's side)", () => {
  it("knows git's empty tree by its id", () => { expect(GIT_EMPTY_TREE_SHA).toBe(EMPTY_TREE); });

  it("tells an empty main from one with files by its tree, and suggests the other branches that have code, newest commit first", async () => {
    const w = githubWorld({ main: empty, "001-dag-orchestrator": code("2026-11-10T00:00:00Z"), old: code("2026-01-01T00:00:00Z"), "also-empty": empty, wip: code("2026-11-12T00:00:00Z") });
    const probe = await w.provider.probeBranches(REPO, "main", SCOPE);
    expect(probe.branch).toMatchObject({ name: "main", empty: true });
    expect(probe.others.map((other) => other.name)).toEqual(["wip", "001-dag-orchestrator", "old"]);
    expect(probe.searchedAll).toBe(true);
    expect(branchStateOf(probe)).toBe("empty");
  });

  it("a branch with files is answered by one read: no branch list is fetched", async () => {
    const w = githubWorld({ main: code("2026-11-01T00:00:00Z"), other: code("2026-11-02T00:00:00Z") });
    const probe = await w.provider.probeBranches(REPO, "main", SCOPE);
    expect(branchStateOf(probe)).toBe("has_files");
    expect(w.paths).toEqual(["/branches/main"]);
  });

  it("a repository with no code on any branch is no_code; with no branch at all it is no_code too", async () => {
    expect(branchStateOf(await githubWorld({ main: empty, side: empty }).provider.probeBranches(REPO, "main", SCOPE))).toBe("no_code");
    const none = await githubWorld({}).provider.probeBranches(REPO, "main", SCOPE);
    expect(none.branch).toBeUndefined();
    expect(branchStateOf(none)).toBe("no_code");
  });

  it("a branch the repository does not have is missing when another branch has code", async () => {
    const probe = await githubWorld({ trunk: code("2026-11-01T00:00:00Z") }).provider.probeBranches(REPO, "main", SCOPE);
    expect(branchStateOf(probe)).toBe("missing");
    expect(probe.others.map((other) => other.name)).toEqual(["trunk"]);
  });

  it("looks into at most 12 other branches and says it did not see them all (so 'no code' is never claimed)", async () => {
    const many: Record<string, { tree: string; date: string }> = { main: empty };
    for (let n = 0; n < 15; n += 1) many[`b${String(n).padStart(2, "0")}`] = n === 14 ? code("2026-11-01T00:00:00Z") : empty;
    const w = githubWorld(many);
    const probe = await w.provider.probeBranches(REPO, "main", SCOPE);
    expect(probe.searchedAll).toBe(false);
    expect(branchStateOf(probe)).toBe("empty");
    expect(w.paths.filter((path) => path.startsWith("/branches/"))).toHaveLength(1 + 12);
  });

  it("throws RUNTIME_UNAVAILABLE when GitHub fails, never a guess", async () => {
    await expect(githubWorld({ main: empty }, { fail: (path) => path === "/branches/main" }).provider.probeBranches(REPO, "main", SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(githubWorld({ main: empty }, { fail: (path) => path.startsWith("/branches?") }).provider.probeBranches(REPO, "main", SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("is refused for a company the repository's installation is not bound to (decision 131)", async () => {
    const w = githubWorld({ main: code("2026-11-01T00:00:00Z") });
    await expect(w.provider.probeBranches(REPO, "main", { orgId: OTHER_ORG })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(w.paths).toEqual([]);
  });

  it("refuses a branch name that is not one before reading anything", async () => {
    const w = githubWorld({ main: empty });
    await expect(w.provider.probeBranches(REPO, "../x", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.paths).toEqual([]);
  });
});

// ---- the broker's side: the routes and the gate

function seedInstallation(db: FakeDynamoDb): void {
  const record: GithubInstallationRecord = {
    installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1",
    boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
}
function seedProject(db: FakeDynamoDb, orgId: OrgId, name: string): void {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [{ cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 }], readiness: [{ cwd: "repo/web", executable: "npm", args: ["test"], timeoutSeconds: 1800 }], orchestratorInstructions: "Delegate work.",
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
}

/** What GitHub holds, by branch, for the project's one repository; `down` makes every read fail. */
type Repo = { branches: Record<string, { empty: boolean; at?: string }>; down?: boolean; notConnected?: boolean };
function probeOf(repo: Repo, branch: string): RepositoryBranchProbe {
  const found = repo.branches[branch];
  const others = Object.entries(repo.branches).filter(([name, value]) => name !== branch && !value.empty).map(([name, value]) => entry(name, false, value.at)).sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
  return { branch: found === undefined ? undefined : entry(branch, found.empty, found.at), others, searchedAll: true };
}

async function setup(repo: Repo) {
  const access = fakeModelAccess();
  const state = { repo };
  const probeBranches = vi.fn(async (_url: string, branch: string, scope: unknown) => {
    if (state.repo.notConnected === true || (scope as { orgId?: string }).orgId !== TEST_ORG) throw agentXError("GITHUB_NOT_CONNECTED", "not connected");
    if (state.repo.down === true) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub is down");
    return probeOf(state.repo, branch);
  });
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      cloud: true, agents: {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      githubPullRequests: {
        reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), probeBranches,
        getRepositoryIdentity: vi.fn(async () => ({ fullName: "acme/web", defaultBranch: "main", githubRepositoryId: 4242 })), getFileAtCommit: vi.fn(async () => undefined), getDefaultBranchHead: vi.fn(async () => "c".repeat(40)),
      },
      checkRepositoryAccess: vi.fn(async () => undefined),
      modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" },
    },
  });
  access.setMemberSpent(TEST_ORG, OMAR.developerId, 0); access.setOrgSpent(TEST_ORG, 0);
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  seedInstallation(h.db);
  seedProject(h.db, TEST_ORG, NAME);
  seedProject(h.db, OTHER_ORG, "theirs");
  const person = async (who: Developer, orgRole: "member" | "admin", grant?: "viewer" | "contributor" | "maintainer") => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: orgRole });
    if (grant !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: NAME, grantId: randomUUID(), role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
  };
  const base = `/v1/app/projects/${NAME}`;
  const check = (who: Developer = OMAR, name = NAME) => h.dev(who, "GET", `/v1/app/projects/${name}/branch-check`);
  const draft = (who: Developer = OMAR) => h.dev(who, "POST", `${base}/setup-draft`, { requestId: randomUUID() });
  const choose = (branch: string, expectedRevision = 1, who: Developer = OMAR) => h.dev(who, "PUT", `${base}/default-branch`, { requestId: randomUUID(), expectedRevision, repository: "web", branch });
  const proceed = (branch = "main", who: Developer = OMAR) => h.dev(who, "POST", `${base}/branch-check/continue`, { repository: "web", branch });
  const revisions = () => h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(TEST_ORG, NAME, 1).pk);
  const drafts = () => h.db.find((item) => item.entityType === "SETUP_DRAFT" && item.project === NAME);
  return { ...h, person, state, check, draft, choose, proceed, revisions, drafts, probeBranches };
}
const rows = (body: Record<string, unknown>) => body.repositories as Array<{ repository: string; branch: string; state: string; alternatives: Array<{ name: string }>; continued: boolean }>;

describe("GET /v1/app/projects/{name}/branch-check", () => {
  it("an empty main with code on another branch suggests the most recently changed one and lists the others; the draft does not start", async () => {
    const t = await setup({ branches: { main: { empty: true }, "001-dag-orchestrator": { empty: false, at: "2026-11-10T00:00:00Z" }, old: { empty: false, at: "2026-01-01T00:00:00Z" } } });
    const reply = await t.check();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ revision: 1, blocked: true });
    expect(rows(reply.body)[0]).toMatchObject({ repository: "web", branch: "main", state: "empty", continued: false });
    expect(rows(reply.body)[0]!.alternatives.map((other) => other.name)).toEqual(["001-dag-orchestrator", "old"]);
    const asked = await t.draft();
    expect(asked.status).toBe(409);
    expect(asked.body.error).toMatchObject({ code: "WORKSPACE_NOT_READY" });
    expect(t.drafts()).toHaveLength(0);
    expect(t.db.get(setupDraftKey(TEST_ORG, NAME))).toBeUndefined();
  });

  it("accepting the suggestion saves the branch as the next revision, answers the check on the new branch, and the draft starts", async () => {
    const t = await setup({ branches: { main: { empty: true }, "001-dag-orchestrator": { empty: false, at: "2026-11-10T00:00:00Z" } } });
    const done = await t.choose("001-dag-orchestrator");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(t.probeBranches).toHaveBeenCalledWith("https://github.com/acme/web.git", "001-dag-orchestrator", expect.objectContaining({ orgId: TEST_ORG }));
    expect(done.body.check).toMatchObject({ revision: 2, blocked: false });
    expect(rows(done.body.check as Record<string, unknown>)[0]).toMatchObject({ branch: "001-dag-orchestrator", state: "has_files" });
    expect(t.revisions()).toHaveLength(2);
    const stored = t.db;
    const latest = (stored.get(projectRevisionKey(TEST_ORG, NAME, 2)) as { definition: { repositories: Array<{ defaultBranch: string }>; revision: number } }).definition;
    expect(latest.repositories[0]!.defaultBranch).toBe("001-dag-orchestrator");
    expect(((await t.dev(OMAR, "GET", `/v1/app/projects/${NAME}`)).body as { repositories: Array<{ defaultBranch: string }> }).repositories[0]!.defaultBranch).toBe("001-dag-orchestrator");
    const asked = await t.draft();
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(t.drafts()).toHaveLength(1);
  });

  it("a repository with no code at all is no_code, with no suggestion, and holds the draft back", async () => {
    const t = await setup({ branches: { main: { empty: true } } });
    const reply = await t.check();
    expect(rows(reply.body)[0]).toMatchObject({ state: "no_code", alternatives: [] });
    expect(reply.body.blocked).toBe(true);
    expect((await t.draft()).status).toBe(409);
    expect(t.drafts()).toHaveLength(0);
  });

  it("a non-empty main behaves as before: nothing is blocked and the draft starts", async () => {
    const t = await setup({ branches: { main: { empty: false, at: "2026-11-10T00:00:00Z" }, other: { empty: false } } });
    const reply = await t.check();
    expect(rows(reply.body)[0]).toMatchObject({ state: "has_files", alternatives: [] });
    expect(reply.body.blocked).toBe(false);
    expect((await t.draft()).status).toBe(202);
  });

  it("a branch that is gone from the repository is missing, with the branches that do exist, and blocks", async () => {
    const t = await setup({ branches: { trunk: { empty: false, at: "2026-11-10T00:00:00Z" } } });
    const reply = await t.check();
    expect(rows(reply.body)[0]).toMatchObject({ state: "missing" });
    expect(rows(reply.body)[0]!.alternatives.map((other) => other.name)).toEqual(["trunk"]);
    expect((await t.draft()).status).toBe(409);
  });

  it("GitHub that cannot answer fails open: unchecked, nothing blocked, and still nothing is started for the person", async () => {
    const t = await setup({ branches: {}, down: true });
    const reply = await t.check();
    expect(reply.status).toBe(200);
    expect(rows(reply.body)[0]).toMatchObject({ state: "unchecked", alternatives: [] });
    expect(reply.body.blocked).toBe(false);
    // The check itself starts no draft; the person's own press is not held back by GitHub being down.
    expect(t.drafts()).toHaveLength(0);
    expect((await t.draft()).status).toBe(202);
  });

  it("another company's project is not found, and GitHub is never asked", async () => {
    const t = await setup({ branches: { main: { empty: true } } });
    const reply = await t.check(OMAR, "theirs");
    expect(reply.status).toBe(404);
    expect(t.probeBranches).not.toHaveBeenCalled();
    expect((await t.dev(OMAR, "PUT", "/v1/app/projects/theirs/default-branch", { requestId: randomUUID(), expectedRevision: 1, repository: "web", branch: "x" })).status).toBe(404);
    expect((await t.dev(OMAR, "POST", "/v1/app/projects/theirs/branch-check/continue", { repository: "web", branch: "main" })).status).toBe(404);
  });

  it("a repository the company's GitHub connection does not reach is refused, not failed open, and holds the draft", async () => {
    const t = await setup({ branches: { main: { empty: false } }, notConnected: true });
    const reply = await t.check();
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(reply.body)).toContain("GITHUB_NOT_CONNECTED");
    const asked = await t.draft();
    expect(asked.status).toBeGreaterThanOrEqual(400);
    expect(t.drafts()).toHaveLength(0);
  });

  it("only a project maintainer may check, change or continue; a person with no access finds nothing", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false } } });
    const nobody: Developer = { developerId: "5".repeat(64), name: "Nia", provider: "oidc", sessionId: "s-nia" };
    await t.person(nobody, "member");
    await t.person(KIT, "member", "contributor");
    for (const who of [nobody, KIT]) {
      expect([403, 404]).toContain((await t.check(who)).status);
      expect([403, 404]).toContain((await t.choose("other", 1, who)).status);
      expect([403, 404]).toContain((await t.proceed("main", who)).status);
    }
    expect((await t.check(KIT)).status).toBe(403);
    expect(t.revisions()).toHaveLength(1);
    expect(t.probeBranches).not.toHaveBeenCalled();
    // A maintainer is allowed.
    const lead: Developer = { developerId: "6".repeat(64), name: "Lee", provider: "oidc", sessionId: "s-lee" };
    await t.person(lead, "member", "maintainer");
    expect((await t.check(lead)).status).toBe(200);
  });
});

describe("PUT /v1/app/projects/{name}/default-branch", () => {
  it("runs the same check on the branch chosen: an empty one is saved but still holds the draft, and the answer says so", async () => {
    const t = await setup({ branches: { main: { empty: false }, scratch: { empty: true }, other: { empty: false, at: "2026-11-01T00:00:00Z" } } });
    const done = await t.choose("scratch");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(rows(done.body.check as Record<string, unknown>)[0]).toMatchObject({ branch: "scratch", state: "empty" });
    expect(rows(done.body.check as Record<string, unknown>)[0]!.alternatives.map((other) => other.name)).toEqual(["other", "main"]);
    expect((done.body.check as { blocked: boolean }).blocked).toBe(true);
    expect((await t.draft()).status).toBe(409);
  });

  it("refuses a branch the repository does not have and writes no revision", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false } } });
    const reply = await t.choose("nope");
    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.revisions()).toHaveLength(1);
  });

  it("refuses a stale revision, and a repeat of the same choice is no new revision", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false } } });
    expect((await t.choose("other")).status).toBe(200);
    const again = await t.choose("other", 2);
    expect(again.status).toBe(200); // the project already uses it: nothing to change
    expect(t.revisions()).toHaveLength(2);
    const behind = await t.choose("main", 1);
    expect(behind.status).toBe(409);
    expect(behind.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
  });

  it("a GitHub that cannot answer is a retry, and nothing is saved", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false } }, down: true });
    const reply = await t.choose("other");
    expect(reply.status).toBeGreaterThanOrEqual(500);
    expect(t.revisions()).toHaveLength(1);
  });

  it("refuses another company's repository (the installation is bound to this company only)", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false } }, notConnected: true });
    const reply = await t.choose("other");
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(reply.body)).toContain("GITHUB_NOT_CONNECTED");
    expect(t.revisions()).toHaveLength(1);
  });
});

describe("POST /v1/app/projects/{name}/branch-check/continue", () => {
  it("lets the draft start once the person explicitly continues, only for that exact branch", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false }, scratch: { empty: true } } });
    expect((await t.draft()).status).toBe(409);
    const gone = await t.proceed("main");
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body).toMatchObject({ blocked: false });
    expect(rows(gone.body)[0]).toMatchObject({ state: "empty", continued: true });
    expect((await t.draft()).status).toBe(202);
  });

  it("a branch the project does not have now is not a choice for it, and a new branch asks again", async () => {
    const t = await setup({ branches: { main: { empty: true }, other: { empty: false }, scratch: { empty: true } } });
    expect((await t.proceed("scratch")).status).toBe(409);
    expect((await t.proceed("main")).status).toBe(200);
    expect((await t.choose("scratch")).status).toBe(200);
    const again = await t.check();
    expect(rows(again.body)[0]).toMatchObject({ branch: "scratch", state: "empty", continued: false });
    expect(again.body.blocked).toBe(true);
    expect((await t.draft()).status).toBe(409);
  });
});

describe("the setup run (switch su) takes the same gate", () => {
  it("is refused while the branch is empty, starts once the person continues, and is never blocked by an unchecked branch", async () => {
    const variable = BROKER_SETTINGS.setupAgent.variable, before = process.env[variable];
    process.env[variable] = "1";
    try {
      const empty = await setup({ branches: { main: { empty: true }, other: { empty: false } } });
      const start = (t: typeof empty) => t.dev(OMAR, "POST", `/v1/app/projects/${NAME}/setup-agent`, { requestId: randomUUID() });
      const refused = await start(empty);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toMatchObject({ code: "WORKSPACE_NOT_READY" });
      expect(empty.db.find((item) => item.entityType === "SETUP_AGENT" && item.project === NAME)).toHaveLength(0);
      expect((await empty.proceed("main")).status).toBe(200);
      const started = await start(empty);
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      expect(empty.db.find((item) => item.entityType === "SETUP_AGENT" && item.project === NAME)).toHaveLength(1);
      const down = await setup({ branches: {}, down: true });
      expect((await start(down)).status).toBe(202);
    } finally {
      if (before === undefined) delete process.env[variable]; else process.env[variable] = before;
    }
  });
});
