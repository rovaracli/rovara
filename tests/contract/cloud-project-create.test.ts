import { capturingAuditDeps } from "../support/audit-capture.js";
import { upgradeTaskStopProjectInheritance } from "../../packages/broker/src/org/task-stop-bootstrap.js";
// Plan 2, Task 16 (replaces ruling R55): on a cloud install an owner or admin of an org creates a project from a repository its own GitHub
// connection reaches, with POST /v1/app/projects (POST /v1/dev/projects is the same route). The project is registered through the admin
// route's own registration code, as a new name in the org, and the creator is granted access like any developer.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
// The package the broker imports, not its source: the broker tests an error for that package's class.
import { agentXError as packageError } from "@rovara-code/contracts";
import { orgSettingsKey, projectAiKey, githubInstallationKey, orgGithubInstallationKey, orgMetaKey, projectCreateRequestKey, type GithubInstallationRecord, type OrgRole } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, orgScoped, projectMemberKey, projectMetaKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { cloudProjectDefaultsFromEnvironment } from "../../packages/broker/src/org/cloud-projects.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { call, loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const THIRD_ORG: OrgId = "org_cccccccccccccccccccc";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }, { availabilityZone: "us-west-2b", subnetId: "subnet-0fedcba9876543210" }],
  volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const CLOUD_PROJECTS = { runtimeBinding: BINDING, githubCredentialRef: "github-app" };
const NOT_CONNECTED = (fullName: string) => `Rovara can't reach ${fullName} through your organization's GitHub connection. Connect it with: agentx github connect`;
const REQUEST = "11111111-1111-4111-8111-111111111111";
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The repositories the fake GitHub App sees, by lower-case full name: GitHub's id and default branch. Installations: acme 55 (Maya's org), globex 66 (Omar's), rival 77 (a third org's). */
const VISIBLE = new Map([["acme/web", { id: 101, branch: "main" }], ["acme/api", { id: 102, branch: "trunk" }], ["globex/web", { id: 103, branch: "main" }], ["rival/secret", { id: 104, branch: "main" }]]);
const INSTALLATION_OF: Record<string, number> = { acme: 55, globex: 66, rival: 77 };
const BOUND_TO: Record<number, OrgId> = { 55: TEST_ORG, 66: OTHER_ORG, 77: THIRD_ORG };
const spelled = (fullName: string) => fullName.replace(/^acme\//, "Acme/");

function githubFake() {
  const lookup = (url: string) => {
    const [owner, name] = new URL(url).pathname.replace(/\.git$/, "").split("/").filter(Boolean) as [string, string];
    return { owner, name, fullName: `${owner}/${name}`, found: VISIBLE.get(`${owner}/${name}`.toLowerCase()) };
  };
  return {
    // What GitHub says covers the repository: nothing for one an installation limited to selected repositories does not include.
    installationForRepository: vi.fn(async (owner: string, name: string) => {
      const installationId = INSTALLATION_OF[owner.toLowerCase()];
      return installationId === undefined || !VISIBLE.has(`${owner}/${name}`.toLowerCase()) ? undefined : { installationId };
    }),
    getRepositoryIdentity: vi.fn(async (url: string) => {
      const { fullName, found } = lookup(url);
      return found === undefined ? undefined : { repositoryId: found.id, fullName: spelled(fullName), defaultBranch: found.branch };
    }),
    checkRepositoryAccess: vi.fn(async () => undefined),
  };
}

/**
 * A cloud install with two orgs: Maya's (TEST_ORG, GitHub account acme, installation 55) and Omar's (OTHER_ORG, globex, 66). Both people own
 * their org. `roles` changes that per test; `connected: false` leaves the orgs with no GitHub connection at all.
 */
async function cloudInstall(options: { roles?: Partial<Record<"maya" | "omar", OrgRole>>; connected?: boolean; configured?: boolean } = {}) {
  const github = githubFake();
  const orgOf = (who: Developer): OrgId => (who === OMAR ? OTHER_ORG : TEST_ORG);
  const harness = await createDeveloperTaskBroker({
    register: false,
    audit: capturingAuditDeps(),
    orgResolver: async ({ developerId }) => (developerId === OMAR.developerId ? OTHER_ORG : TEST_ORG),
    brokerExtra: {
      cloud: true,
      ...(options.configured === false ? {} : { cloudProjects: CLOUD_PROJECTS }),
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: github.getRepositoryIdentity, installationForRepository: github.installationForRepository },
      checkRepositoryAccess: github.checkRepositoryAccess,
    },
  });
  for (const [who, key] of [[MAYA, "maya"], [OMAR, "omar"]] as const) seedMembership(harness.db, who.developerId, { orgId: orgOf(who), role: options.roles?.[key] ?? "owner" });
  const bind = (installationId: number, orgId: OrgId, over: Partial<GithubInstallationRecord> = {}) => {
    const record: GithubInstallationRecord = {
      installationId, orgId, accountLogin: "acme", accountId: 900, accountType: "Organization", repositorySelection: "selected", installedByGithubUserId: "4343",
      boundByDeveloperId: MAYA.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
    };
    harness.db.set({ ...githubInstallationKey(installationId), entityType: "GITHUB_INSTALLATION", ...record });
    harness.db.set({ ...orgGithubInstallationKey(orgId, installationId), entityType: "ORG_GITHUB_INSTALLATION", ...record });
  };
  if (options.connected !== false) for (const [installation, org] of Object.entries(BOUND_TO)) bind(Number(installation), org);
  const create = (who: Developer, body: unknown, path = "/v1/app/projects") => harness.dev(who, "POST", path, body);
  /** The caller's projects as the app lists them. */
  const listed = async (who: Developer) => ((await harness.dev(who, "GET", "/v1/app/projects")).body.projects as Array<{ name: string; myRole: string; description?: string }>).map(({ name, myRole, description }) => ({ name, myRole, ...(description === undefined ? {} : { description }) }));
  /** Everything a creation writes: the revision, META, catalog entry, grant and replay record. */
  const written = () => harness.db.find(() => true).filter((item) => /PROJECT/.test(String(item.pk)) || /PROJECT|MEMBERSHIP/.test(String(item.entityType)));
  const projectRows = () => harness.db.find((item) => item.entityType === "PROJECT");
  return { ...harness, github, bind, create, listed, written, projectRows };
}

const error = (response: { body: Record<string, unknown> }) => response.body.error as { code: string; message: string };

describe("POST /v1/app/projects", () => {
  it("lets an owner create a project for a repository under a connected account: active, created by the caller, listed with the maintainer role, and pinned to the installation and GitHub's repository id", async () => {
    const h = await cloudInstall();
    const created = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ duplicate: false, project: { definition: { name: "web", revision: 1 } } });
    // What a tenant is told: no installation id, repository id or credential.
    expect((created.body.project as { definition: unknown }).definition).toEqual({
      name: "web", revision: 1,
      repositories: [{ name: "web", url: "https://github.com/Acme/web.git", path: "repo/web", defaultBranch: "main" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
    });
    // The stored revision is bound to the foundation's workers with the built-in credential, and its repository entry carries the pin.
    expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 1))).toMatchObject({
      entityType: "PROJECT", registeredBy: MAYA.developerId, runtimeBinding: BINDING,
      definition: { repositories: [{ name: "web", credentialRef: "github-app", installationId: 55, githubRepositoryId: 101 }] },
    });
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ entityType: "PROJECT_META", status: "active", createdBy: MAYA.developerId });
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 1 });
    expect(h.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, "web"))).toMatchObject({ entityType: "MEMBERSHIP", role: "developer", ownerKey: MAYA.developerId });
    // Every row is the org's own, but GitHub's repository index (Plan 4 Task 21), which holds ids only and is found by GitHub's repository id before the org is known.
    expect(h.written().every((item) => String(item.pk).startsWith(`ORG#${TEST_ORG}#`) || (String(item.pk) === "GITHUB_REPO#101" && item.sk === `${TEST_ORG}#web`))).toBe(true);
    expect(h.db.get("GITHUB_REPO#101", `${TEST_ORG}#web`)).toMatchObject({ orgId: TEST_ORG, project: "web", installationId: 55, githubRepositoryId: 101 });
    expect(await h.listed(MAYA)).toEqual([{ name: "web", myRole: "maintainer" }]);
  });

  it("keeps POST /v1/dev/projects as the same route", async () => {
    const h = await cloudInstall();
    const created = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" }, "/v1/dev/projects");
    expect(created.status).toBe(201);
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ status: "active" });
  });

  it("lets an admin create a project too", async () => {
    const h = await cloudInstall({ roles: { maya: "admin" } });
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", myRole: "maintainer" }]);
  });

  it("never tells a tenant the shared launch template, subnets, credential, installation or repository id, on a new project or a replay", async () => {
    const h = await cloudInstall();
    for (const status of [201, 200]) {
      const answered = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
      expect(answered.status).toBe(status);
      const text = JSON.stringify(answered.body);
      for (const internal of ["lt-0123456789abcdef0", "subnet-0123456789abcdef0", "subnet-0fedcba9876543210", "runtimeBinding", "credentialRef", "github-app", "installationId", "githubRepositoryId", MAYA.developerId]) {
        expect(text, internal).not.toContain(internal);
      }
    }
  });

  it("takes the name, description and commands from the body, and the default branch from GitHub", async () => {
    const h = await cloudInstall();
    const created = await h.create(MAYA, { requestId: REQUEST, repository: "Acme/API", name: "payments-api", description: "Payments, as a service.", setupCommand: "npm ci", testCommand: "npm test -- --run" });
    expect(created.status).toBe(201);
    expect((created.body.project as { definition: Record<string, unknown> }).definition).toMatchObject({
      name: "payments-api",
      repositories: [{ name: "api", url: "https://github.com/Acme/API.git", path: "repo/api", defaultBranch: "trunk" }],
      setup: [{ cwd: "repo/api", executable: "npm", args: ["ci"], timeoutSeconds: 900 }],
      readiness: [{ cwd: "repo/api", executable: "npm", args: ["test", "--", "--run"], timeoutSeconds: 1800 }],
    });
    expect(h.db.get(projectMetaKey(TEST_ORG, "payments-api"))).toMatchObject({ description: "Payments, as a service." });
    expect(await h.listed(MAYA)).toEqual([{ name: "payments-api", myRole: "maintainer", description: "Payments, as a service." }]);
  });

  it("keeps every command of testCommands and setupCommands, in order, and a replay of the same list is the same request", async () => {
    const h = await cloudInstall();
    const body = { requestId: REQUEST, repository: "acme/api", name: "api", setupCommands: ["pip install -r requirements-dev.txt", "npm ci"], testCommands: ["python3 -m ruff check .", "python3 -m pytest"] };
    const created = await h.create(MAYA, body);
    expect(created.status).toBe(201);
    expect((created.body.project as { definition: Record<string, unknown> }).definition).toMatchObject({
      setup: [{ executable: "pip", args: ["install", "-r", "requirements-dev.txt"] }, { executable: "npm", args: ["ci"] }],
      readiness: [{ executable: "python3", args: ["-m", "ruff", "check", "."] }, { executable: "python3", args: ["-m", "pytest"] }],
    });
    const again = await h.create(MAYA, body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
  });

  it("refuses a list together with the single command it would repeat, and a bad command in a list names its place", async () => {
    const h = await cloudInstall();
    expect(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web", testCommand: "npm test", testCommands: ["npm test", "npm run lint"] })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    const bad = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web", testCommands: ["npm test", "npm test \"x"] });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(String((bad.body.error as { message: string }).message)).toContain("testCommands.1");
    expect(h.written()).toEqual([]);
  });

  it("refuses a member with 403 and writes and reads nothing", async () => {
    const h = await cloudInstall({ roles: { maya: "member" } });
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.written()).toEqual([]);
    expect(h.github.installationForRepository).not.toHaveBeenCalled();
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
  });

  it("refuses a repository of an owner the org has not connected with GITHUB_NOT_CONNECTED, and writes nothing", async () => {
    const h = await cloudInstall();
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "initech/app" });
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED("initech/app") });
    expect(h.written()).toEqual([]);
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
  });

  it("refuses an org that has connected no GitHub account at all, and one whose connection is suspended or removed", async () => {
    const none = await cloudInstall({ connected: false });
    expect(error(await none.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).code).toBe("GITHUB_NOT_CONNECTED");
    expect(none.written()).toEqual([]);
    for (const status of ["suspended", "removed"] as const) {
      const h = await cloudInstall();
      h.bind(55, TEST_ORG, { status });
      expect(error(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).code, status).toBe("GITHUB_NOT_CONNECTED");
      expect(h.written()).toEqual([]);
    }
  });

  it("refuses a repository outside a `selected` installation with GITHUB_NOT_CONNECTED, and writes nothing", async () => {
    const h = await cloudInstall();
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "acme/not-selected" });
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED("acme/not-selected") });
    expect(h.written()).toEqual([]);
  });

  it("refuses a repository whose installation is another org's, and writes nothing", async () => {
    const h = await cloudInstall();
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "rival/secret" });
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED("rival/secret") });
    expect(h.written()).toEqual([]);
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
  });

  it("answers a moved or renamed repository with a 400 that says so, not a 500, and writes nothing", async () => {
    const h = await cloudInstall();
    h.github.getRepositoryIdentity.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(error(refused).message).toContain("moved or renamed acme/web; use its current owner/name");
    expect(h.written()).toEqual([]);
    // GitHub being down is not the member's mistake.
    h.github.getRepositoryIdentity.mockRejectedValueOnce(packageError("RUNTIME_UNAVAILABLE", "GitHub repository lookup failed with HTTP 502"));
    expect((await h.create(MAYA, { requestId: requestId(2), repository: "acme/web" })).status).toBe(503);
    expect(h.written()).toEqual([]);
  });

  it("answers a network failure reaching GitHub with 503, not as a moved repository, and a programming TypeError is not relabeled", async () => {
    const h = await cloudInstall();
    h.github.getRepositoryIdentity.mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") }));
    const down = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(down).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(error(down).message).not.toContain("moved or renamed");
    h.github.getRepositoryIdentity.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'x')"));
    const bug = await h.create(MAYA, { requestId: requestId(2), repository: "acme/web" });
    // The broker's own catch-all answers it (generic words, logged by name); it is not relabeled as a repository problem.
    expect(error(bug).message).toContain("AgentX could not handle this request");
    expect(error(bug).message).not.toContain("moved or renamed");
    expect(h.written()).toEqual([]);
  });

  it("refuses a repository GitHub spells under another owner with 403 and writes nothing", async () => {
    const h = await cloudInstall();
    // The connection's check passes (as for the first lookup), then GitHub describes the repository under another owner.
    h.github.getRepositoryIdentity.mockResolvedValueOnce({ repositoryId: 101, fullName: "acme/web", defaultBranch: "main" });
    h.github.getRepositoryIdentity.mockResolvedValueOnce({ repositoryId: 101, fullName: "rival/web", defaultBranch: "main" });
    expect(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.written()).toEqual([]);
  });

  it("refuses when the second read of the repository is not the repository the connection was checked for, and writes nothing", async () => {
    const h = await cloudInstall();
    h.github.getRepositoryIdentity.mockResolvedValueOnce({ repositoryId: 101, fullName: "acme/web", defaultBranch: "main" });
    h.github.getRepositoryIdentity.mockResolvedValueOnce({ repositoryId: 999, fullName: "acme/web", defaultBranch: "main" });
    const refused = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(error(refused).message).toContain("try again");
    expect(h.written()).toEqual([]);
    // Asked again, with GitHub steady, it creates.
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
  });

  it("answers two orgs' projects as each org's alone: both create web on repositories their own connection reaches", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    expect((await h.create(OMAR, { requestId: REQUEST, repository: "globex/web" })).status).toBe(201);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", myRole: "maintainer" }]);
    expect(await h.listed(OMAR)).toEqual([{ name: "web", myRole: "maintainer" }]);
    expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 1))).toMatchObject({ definition: { repositories: [{ url: "https://github.com/Acme/web.git", installationId: 55, githubRepositoryId: 101 }] } });
    expect(h.db.get(projectRevisionKey(OTHER_ORG, "web", 1))).toMatchObject({ definition: { repositories: [{ url: "https://github.com/globex/web.git", installationId: 66, githubRepositoryId: 103 }] } });
    expect(h.projectRows()).toHaveLength(2);
    // Another org's repository stays out of reach, and neither org sees a project only the other made.
    expect((await h.create(OMAR, { requestId: requestId(2), repository: "acme/api" })).status).toBe(403);
    expect((await h.create(MAYA, { requestId: requestId(3), repository: "acme/api", name: "api" })).status).toBe(201);
    expect(await h.listed(OMAR)).toEqual([{ name: "web", myRole: "maintainer" }]);
    expect(h.db.get(projectMemberKey(OTHER_ORG, MAYA.developerId, "api"))).toBeUndefined();
    // The same requestId in two orgs is two requests.
    expect(h.db.get(projectCreateRequestKey(TEST_ORG, REQUEST))).toMatchObject({ projectName: "web" });
    expect(h.db.get(projectCreateRequestKey(OTHER_ORG, REQUEST))).toMatchObject({ projectName: "web" });
  });

  it("answers RUNTIME_UNAVAILABLE where the control plane has no runtime defaults to build a project with", async () => {
    const h = await cloudInstall({ configured: false });
    expect(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(h.written()).toEqual([]);
  });

  it.each([
    ["no request id", { repository: "acme/web" }],
    ["a request id that is not a UUID", { requestId: "again", repository: "acme/web" }],
    ["no repository", { requestId: REQUEST, name: "web" }],
    ["a repository without an owner", { requestId: REQUEST, repository: "web" }],
    ["a repository URL", { requestId: REQUEST, repository: "https://github.com/acme/web" }],
    ["a repository named ..", { requestId: REQUEST, repository: "acme/.." }],
    ["a repository named .", { requestId: REQUEST, repository: "acme/." }],
    ["a repository named .git", { requestId: REQUEST, repository: "acme/.git" }],
    ["a name that is not a project name", { requestId: REQUEST, repository: "acme/web", name: "My Web" }],
    ["a description over 280 characters", { requestId: REQUEST, repository: "acme/web", description: "x".repeat(281) }],
    ["a command that chains steps", { requestId: REQUEST, repository: "acme/web", setupCommand: "npm ci && npm run build" }],
    ["a command with an unclosed quote", { requestId: REQUEST, repository: "acme/web", testCommand: "npm test \"x" }],
    ["an org of its own choosing", { requestId: REQUEST, repository: "acme/web", orgId: OTHER_ORG }],
  ])("refuses %s with 400 CONFIG_INVALID and writes nothing", async (_name, body) => {
    const h = await cloudInstall();
    expect(await h.create(MAYA, body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(h.written()).toEqual([]);
    expect(h.github.installationForRepository).not.toHaveBeenCalled();
  });
});

describe("a project's name in its org", () => {
  it("is taken once: the same name twice is PROJECT_NAME_TAKEN, and the first project is untouched", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: requestId(1), repository: "acme/web" })).status).toBe(201);
    const before = h.written().length;
    const again = await h.create(MAYA, { requestId: requestId(2), repository: "acme/web" });
    expect(error(again).code).toBe("PROJECT_NAME_TAKEN");
    expect(error(again).message).toBe("Your organization already has a project named `web` (it may be archived). Choose another name.");
    const other = await h.create(MAYA, { requestId: requestId(3), repository: "acme/api", name: "web" });
    expect(error(other).code).toBe("PROJECT_NAME_TAKEN");
    expect(h.projectRows()).toHaveLength(1);
    expect(h.written()).toHaveLength(before);
    // The refused request left no replay record behind: it can be sent again with another name.
    expect(h.db.get(projectCreateRequestKey(TEST_ORG, requestId(3)))).toBeUndefined();
    expect((await h.create(MAYA, { requestId: requestId(3), repository: "acme/api", name: "api" })).status).toBe(201);
  });

  it("stays taken after the project is archived", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: requestId(1), repository: "acme/web" })).status).toBe(201);
    h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, "web")) as Record<string, unknown>), status: "archived" });
    expect(error(await h.create(MAYA, { requestId: requestId(2), repository: "acme/web" })).code).toBe("PROJECT_NAME_TAKEN");
    // A project that was archived before this request, seeded without a revision of its own, is taken as well.
    h.db.set({ ...projectMetaKey(TEST_ORG, "legacy"), entityType: "PROJECT_META", name: "legacy", status: "archived", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "unknown" });
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "legacy"), entityType: "PROJECT_CATALOG", name: "legacy", latestRevision: 1 });
    expect(error(await h.create(MAYA, { requestId: requestId(3), repository: "acme/api", name: "legacy" })).code).toBe("PROJECT_NAME_TAKEN");
  });
});

describe("replaying a creation", () => {
  it("answers the same request again with 200 and duplicate true, writes nothing more, and records the request for a day", async () => {
    const h = await cloudInstall();
    const first = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web", name: "web-app", description: "The web app." });
    expect(first.status).toBe(201);
    const record = h.db.get(projectCreateRequestKey(TEST_ORG, REQUEST)) as Record<string, unknown>;
    expect(record).toMatchObject({ pk: orgScoped(TEST_ORG, "PROJECT_CREATE_REQUEST"), sk: REQUEST, projectName: "web-app" });
    expect(record.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof record.createdAt).toBe("string");
    expect(typeof record.expiresAt).toBe("number");
    // The State table deletes it when the day is over: its TTL attribute holds the same instant.
    expect(record.indexExpiresAt).toBe(record.expiresAt);
    expect(Number(record.expiresAt) - Math.floor(Date.parse(String(record.createdAt)) / 1000)).toBe(86400);
    const before = h.written().length;
    const lookups = h.github.installationForRepository.mock.calls.length;
    const again = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web", name: "web-app", description: "The web app." });
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, project: { definition: { name: "web-app", revision: 1 } } } });
    expect(again.body.project).toEqual(first.body.project);
    expect(h.written()).toHaveLength(before);
    // The replay is answered before GitHub is asked anything.
    expect(h.github.installationForRepository.mock.calls).toHaveLength(lookups);
    // The same body spelled with another case of the repository is the same body.
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "ACME/Web", name: "web-app", description: "The web app." })).status).toBe(200);
  });

  it("answers the race of two identical requests as a duplicate: the one that lost the name re-reads the record and answers 200", async () => {
    const h = await cloudInstall();
    const first = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(first.status).toBe(201);
    // The second request's replay check ran before the first one's transaction landed: it reads no record, then loses the name.
    const key = projectCreateRequestKey(TEST_ORG, REQUEST);
    const send = h.db.send.bind(h.db);
    let hidden = false;
    h.db.send = async (command) => {
      const asked = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
      if (!hidden && asked?.pk === key.pk && asked.sk === key.sk) { hidden = true; return { Item: undefined }; }
      return send(command);
    };
    const before = h.written().length;
    const second = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(hidden).toBe(true);
    expect(second).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(second.body.project).toEqual(first.body.project);
    expect(h.written()).toHaveLength(before);
    // The same race with another body under the same id loses with the conflict, not the name.
    hidden = false;
    expect(error(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web", description: "Other words." })).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses the same requestId with another body as IDEMPOTENCY_CONFLICT, and changes nothing", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    const before = h.written().length;
    for (const body of [{ repository: "acme/api" }, { repository: "acme/web", name: "other" }, { repository: "acme/web", description: "Now with words." }]) {
      const conflict = await h.create(MAYA, { requestId: REQUEST, ...body });
      expect(conflict.status, JSON.stringify(body)).toBe(409);
      expect(error(conflict).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(h.written()).toHaveLength(before);
  });

  it("is checked before GitHub: a replay is answered even when the connection has since been removed", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    h.bind(55, TEST_ORG, { status: "removed" });
    expect(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).toMatchObject({ status: 200, body: { duplicate: true } });
    // A new request for the same repository is refused: the connection is gone.
    expect(error(await h.create(MAYA, { requestId: requestId(2), repository: "acme/web", name: "web-2" })).code).toBe("GITHUB_NOT_CONNECTED");
  });

  it("binds the request to the person who made it (final review M2): another person's use of the id is IDEMPOTENCY_CONFLICT and answers nothing", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    const record = h.db.get(projectCreateRequestKey(TEST_ORG, REQUEST)) as Record<string, unknown>;
    expect(record.by).toBe(MAYA.developerId);
    // The record names someone else, as if another owner of the org had sent the id first.
    h.db.set({ ...record, by: "5".repeat(64) });
    const before = h.written().length;
    const stolen = await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" });
    expect(stolen.status).toBe(409);
    expect(error(stolen).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(stolen.body.project).toBeUndefined();
    expect(h.written()).toHaveLength(before);
  });

  it("does not answer a replay to a member: the role is checked first", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
    expect(await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
  });

  it("takes a record past its day as no record: the id can be used again", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    h.db.set({ ...(h.db.get(projectCreateRequestKey(TEST_ORG, REQUEST)) as Record<string, unknown>), expiresAt: Math.floor(Date.now() / 1000) - 1 });
    const later = await h.create(MAYA, { requestId: REQUEST, repository: "acme/api", name: "api" });
    expect(later.status).toBe(201);
    expect(h.db.get(projectCreateRequestKey(TEST_ORG, REQUEST))).toMatchObject({ projectName: "api" });
  });
});

describe("older workers", () => {
  // A repository entry as a worker of before Task 15 parses it (strict): a field it does not list fails the parse.
  const OLD_ENTRY_FIELDS = ["name", "url", "path", "defaultBranch", "credentialRef", "access"];
  const oldStrictEntry = z.object(Object.fromEntries(OLD_ENTRY_FIELDS.map((field) => [field, z.unknown().optional()]))).strict();

  it("a created project's invocations carry its repositories without the installation and repository id, and the strict entry of before parses them", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
    const stored = (h.db.get(projectRevisionKey(TEST_ORG, "web", 1)) as { definition: { repositories: Array<Record<string, unknown>> } }).definition.repositories[0]!;
    expect(stored).toMatchObject({ installationId: 55, githubRepositoryId: 101 });
    expect(oldStrictEntry.safeParse(stored).success).toBe(false);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "web", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect(started.status).toBe(200);
    const carrying = h.db.find((item) => item.entityType === "OUTBOX").map((item) => item.invocation as { kind: string; payload: { project?: { repositories: Array<Record<string, unknown>> } } })
      .filter((invocation) => invocation.payload.project !== undefined);
    expect(carrying.length).toBeGreaterThan(0);
    for (const invocation of carrying) {
      for (const repository of invocation.payload.project!.repositories) {
        expect(repository, invocation.kind).not.toHaveProperty("installationId");
        expect(repository, invocation.kind).not.toHaveProperty("githubRepositoryId");
        expect(oldStrictEntry.safeParse(repository).success, invocation.kind).toBe(true);
      }
    }
  });
});

describe("the operator-set GitHub owner is gone", () => {
  beforeAll(loadSlackBroker);

  it("has no PUT /v1/admin/org/github-owner: an operator gets what any unknown administration path gets (the router's catch-all 403), and the org is unchanged", async () => {
    const { handler, db } = await createAdminBroker({ extra: { cloud: true } });
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "owner" });
    const removed = await adminCall(handler, { method: "PUT", path: "/v1/admin/org/github-owner", body: { orgId: TEST_ORG, githubOwner: "acme" }, admin: true });
    const unknown = await adminCall(handler, { method: "PUT", path: "/v1/admin/org/no-such-setting", body: { orgId: TEST_ORG, githubOwner: "acme" }, admin: true });
    expect(removed).toMatchObject({ status: unknown.status, body: { error: { code: "FORBIDDEN", message: (unknown.body.error as { message: string }).message } } });
    expect((db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk) as Record<string, unknown>).githubOwner).toBeUndefined();
  });

  it("an org item that still carries the old githubOwner attribute reads and creates as any other", async () => {
    const h = await cloudInstall();
    h.db.set({ ...(h.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), githubOwner: "somebody-else" });
    const org = await h.dev(MAYA, "GET", "/v1/app/org");
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ org: { orgId: TEST_ORG }, role: "owner" });
    // The attribute decides nothing: the connection does.
    expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
  });
});

describe("POST /v1/app/projects on an install that is not cloud", () => {
  async function privateInstall() {
    const harness = await createDeveloperTaskBroker({ register: false, brokerExtra: { cloudProjects: CLOUD_PROJECTS } });
    seedMembership(harness.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    return harness;
  }

  it("refuses an owner with 403 and points at agentx project add, writing nothing", async () => {
    const h = await privateInstall();
    for (const path of ["/v1/app/projects", "/v1/dev/projects"]) {
      const refused = await h.dev(MAYA, "POST", path, { requestId: REQUEST, repository: "acme/web" });
      expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
      expect((refused.body.error as { message: string }).message).toContain("ask an administrator to run agentx project add");
    }
    expect(h.db.find((item) => item.entityType === "PROJECT")).toHaveLength(0);
  });

  it("leaves the administrator's registration as it was: it registers, and the registrant administers the project", async () => {
    const h = await privateInstall();
    const registered = await call(h.handler, {
      method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
      body: {
        definition: { name: "payments", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
        runtimeBinding: BINDING,
      },
    });
    expect(registered).toMatchObject({ status: 201, body: { duplicate: false } });
    const row = h.db.find((item) => item.entityType === "MEMBERSHIP" && item.projectName === "payments");
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ role: "administrator" });
  });
});

describe("cloudProjectDefaultsFromEnvironment", () => {
  const env = { EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0", EC2_WORKER_SUBNETS: "us-west-2a=subnet-0123456789abcdef0,us-west-2b=subnet-0fedcba9876543210", GITHUB_APP_CREDENTIAL_REF: "github-app" };

  it("builds the binding project add builds, from the foundation's launch template and subnet pairs", () => {
    expect(cloudProjectDefaultsFromEnvironment(env)).toEqual(CLOUD_PROJECTS);
  });

  it("is undefined when a part is missing or the binding is invalid, so project creation answers RUNTIME_UNAVAILABLE", () => {
    expect(cloudProjectDefaultsFromEnvironment({})).toBeUndefined();
    expect(cloudProjectDefaultsFromEnvironment({ ...env, EC2_WORKER_SUBNETS: undefined })).toBeUndefined();
    expect(cloudProjectDefaultsFromEnvironment({ ...env, GITHUB_APP_CREDENTIAL_REF: "" })).toBeUndefined();
    expect(cloudProjectDefaultsFromEnvironment({ ...env, EC2_WORKER_LAUNCH_TEMPLATE_ID: "not-a-template" })).toBeUndefined();
    expect(cloudProjectDefaultsFromEnvironment({ ...env, EC2_WORKER_SUBNETS: "us-west-2a" })).toBeUndefined();
  });
});

it("real cloud project creation atomically seeds explicit task-stop inheritance", async () => {
 const h = await cloudInstall();h.db.set({ ...orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1, enrollment: { version: 1, state: "enabled" }, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } } });
 expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);
 expect(h.db.get(projectAiKey(TEST_ORG, "web"))).toMatchObject({ entityType: "PROJECT_AI", orgId: TEST_ORG, project: "web", revision: 1, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
});
it("a real registered legacy project with no PROJECT_AI can be upgraded without fixtures", async () => {
 const h = await cloudInstall();expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);const key = projectAiKey(TEST_ORG, "web");h.db.delete(key);
 await upgradeTaskStopProjectInheritance({ documentClient: h.db, tableName: "state", now: Date.now }, { orgId: TEST_ORG, project: "web" });
 expect(h.db.get(key)).toMatchObject({ orgId: TEST_ORG, project: "web", revision: 1, projectPays: false, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
});
it("Spending repairs a missing PROJECT_AI through the real project and authenticated routes", async () => {
 const h = await cloudInstall();expect((await h.create(MAYA, { requestId: REQUEST, repository: "acme/web" })).status).toBe(201);const key = projectAiKey(TEST_ORG, "web");h.db.delete(key);
 const view = await h.dev(MAYA, "GET", "/v1/app/org/task-stop-policy/projects/web/editing");expect(view.status).toBe(200);expect(view.body.sourceState).toBe("missing");
 const applied = await h.dev(MAYA, "PUT", "/v1/app/org/task-stop-policy/projects/web", { requestId: randomUUID(), expectedRevision: view.body.revision, expectedPolicyDigest: view.body.sourceDigest, policy: { kind: "limited", stopMicrousd: 1234567 } });
 expect(applied.status).toBe(200);expect(h.db.get(key)).toMatchObject({ revision: 1, orgId: TEST_ORG, project: "web", taskStopPolicy: { schemaVersion: 1, stopMicrousd: 1234567 } });
});
