// Task 23 (ruling R55): on a cloud install an owner or admin of an org creates a project with POST /v1/dev/projects, for a repository
// under the org's operator-set GitHub owner. It registers through the admin route's own registration code, and the creator is granted
// access like any developer.
import { describe, expect, it, vi } from "vitest";
import { agentXError, orgMetaKey, orgProjectCatalogKey, projectMemberKey, projectRevisionKey, type OrgId, type OrgRole } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { cloudProjectDefaultsFromEnvironment } from "../../packages/broker/src/org/cloud-projects.js";
import { call } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }, { availabilityZone: "us-west-2b", subnetId: "subnet-0fedcba9876543210" }],
  volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const CLOUD_PROJECTS = { runtimeBinding: BINDING, githubCredentialRef: "github-app" };
const SUPPORT_MESSAGE = "ask Rovara support to connect your GitHub organization";

/** The repositories the fake GitHub App sees, by lower-case full name, with their default branch. */
const VISIBLE = new Map([["acme/web", "main"], ["acme/api", "trunk"], ["globex/web", "main"], ["rival/secret", "main"]]);
const spelled = (fullName: string) => fullName.replace(/^acme\//, "Acme/");

function githubFake() {
  const lookup = (url: string) => {
    const [owner, name] = new URL(url).pathname.replace(/\.git$/, "").split("/").filter(Boolean) as [string, string];
    return { fullName: `${owner}/${name}`, branch: VISIBLE.get(`${owner}/${name}`.toLowerCase()) };
  };
  return {
    getRepositoryIdentity: vi.fn(async (url: string) => {
      const found = lookup(url);
      return found.branch === undefined ? undefined : { repositoryId: 7, fullName: spelled(found.fullName), defaultBranch: found.branch };
    }),
    checkRepositoryAccess: vi.fn(async (repository: { url: string }) => {
      if (lookup(repository.url).branch === undefined) throw agentXError("CONFIG_INVALID", "the GitHub App cannot access that repository");
    }),
  };
}

/**
 * A cloud install with two orgs: Maya's (TEST_ORG, GitHub owner acme) and Omar's (OTHER_ORG, owner globex). Both people own their org.
 * `roles` and `owners` change that per test; an owner of undefined leaves the org with none.
 */
async function cloudInstall(options: { roles?: Partial<Record<"maya" | "omar", OrgRole>>; owners?: { [org: string]: string | undefined }; configured?: boolean } = {}) {
  const github = githubFake();
  const orgOf = (who: Developer): OrgId => (who === OMAR ? OTHER_ORG : TEST_ORG);
  const harness = await createDeveloperTaskBroker({
    register: false,
    orgResolver: async ({ developerId }) => (developerId === OMAR.developerId ? OTHER_ORG : TEST_ORG),
    brokerExtra: {
      cloud: true,
      ...(options.configured === false ? {} : { cloudProjects: CLOUD_PROJECTS }),
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: github.getRepositoryIdentity },
      checkRepositoryAccess: github.checkRepositoryAccess,
    },
  });
  const owners: { [org: string]: string | undefined } = { [TEST_ORG]: "acme", [OTHER_ORG]: "globex", ...options.owners };
  for (const [who, key] of [[MAYA, "maya"], [OMAR, "omar"]] as const) {
    seedMembership(harness.db, who.developerId, { orgId: orgOf(who), role: options.roles?.[key] ?? "owner" });
    const meta = harness.db.get(orgMetaKey(orgOf(who))) as Record<string, unknown>;
    const owner = owners[orgOf(who)];
    harness.db.set({ ...meta, ...(owner === undefined ? {} : { githubOwner: owner }) });
  }
  const create = (who: Developer, body: unknown) => harness.dev(who, "POST", "/v1/dev/projects", body);
  const listed = async (who: Developer) => ((await harness.dev(who, "GET", "/v1/dev/projects")).body.projects as Array<{ name: string; access: string }>).map(({ name, access }) => ({ name, access }));
  const projectRows = () => harness.db.find((item) => item.entityType === "PROJECT");
  const everyRow = (db: FakeDynamoDb) => db.find(() => true).filter((item) => /PROJECT|MEMBERSHIP/.test(String(item.entityType)));
  return { ...harness, github, create, listed, projectRows, everyRow };
}

describe("POST /v1/dev/projects", () => {
  it("lets an owner create a project for a repository under the org's GitHub owner, built like project add, listed as granted, under the org's keys", async () => {
    const h = await cloudInstall();
    const created = await h.create(MAYA, { repository: "acme/web" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ duplicate: false, project: { definition: { name: "web", revision: 1 }, runtimeBinding: BINDING } });
    expect((created.body.project as { definition: unknown }).definition).toEqual({
      name: "web", revision: 1,
      repositories: [{ name: "web", url: "https://github.com/Acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
    });
    expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 1))).toMatchObject({ entityType: "PROJECT", registeredBy: MAYA.developerId });
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 1 });
    expect(h.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, "web"))).toMatchObject({ entityType: "MEMBERSHIP", role: "developer", ownerKey: MAYA.developerId });
    expect(h.everyRow(h.db).every((item) => String(item.pk).startsWith(`ORG#${TEST_ORG}#`))).toBe(true);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", access: "granted" }]);
  });

  it("tells the projects list the caller's org role, which agentx whoami uses to say who may create", async () => {
    const h = await cloudInstall({ roles: { maya: "owner", omar: "member" } });
    expect((await h.dev(MAYA, "GET", "/v1/dev/projects")).body).toMatchObject({ developer: { orgRole: "owner" } });
    expect((await h.dev(OMAR, "GET", "/v1/dev/projects")).body).toMatchObject({ developer: { orgRole: "member" } });
  });

  it("lets an admin create a project too", async () => {
    const h = await cloudInstall({ roles: { maya: "admin" } });
    expect((await h.create(MAYA, { repository: "acme/web" })).status).toBe(201);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", access: "granted" }]);
  });

  it("takes the project name, setup command and test command from the body, and the default branch from GitHub", async () => {
    const h = await cloudInstall();
    const created = await h.create(MAYA, { repository: "Acme/API", name: "payments-api", setupCommand: "npm ci", testCommand: "npm test -- --run" });
    expect(created.status).toBe(201);
    expect((created.body.project as { definition: Record<string, unknown> }).definition).toMatchObject({
      name: "payments-api",
      repositories: [{ name: "api", url: "https://github.com/Acme/API.git", path: "repo/api", defaultBranch: "trunk" }],
      setup: [{ cwd: "repo/api", executable: "npm", args: ["ci"], timeoutSeconds: 900 }],
      readiness: [{ cwd: "repo/api", executable: "npm", args: ["test", "--", "--run"], timeoutSeconds: 1800 }],
    });
  });

  it("refuses a member with 403 and writes nothing", async () => {
    const h = await cloudInstall({ roles: { maya: "member" } });
    const refused = await h.create(MAYA, { repository: "acme/web" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.everyRow(h.db)).toEqual([]);
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
  });

  it("refuses a repository under another owner with 403, compares owners without regard to case, and writes nothing", async () => {
    const h = await cloudInstall();
    const refused = await h.create(MAYA, { repository: "rival/secret" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect((refused.body.error as { message: string }).message).toContain("acme");
    expect(h.everyRow(h.db)).toEqual([]);
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
    expect(h.github.checkRepositoryAccess).not.toHaveBeenCalled();
    // The same owner spelled in another case is the same owner.
    expect((await h.create(MAYA, { repository: "ACME/web" })).status).toBe(201);
  });

  it("refuses an org with no allowed GitHub owner with 403 and the support message, and writes nothing", async () => {
    const h = await cloudInstall({ owners: { [TEST_ORG]: undefined } });
    const refused = await h.create(MAYA, { repository: "acme/web" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect((refused.body.error as { message: string }).message).toContain(SUPPORT_MESSAGE);
    expect(h.everyRow(h.db)).toEqual([]);
  });

  it("refuses a repository the GitHub App cannot see with 400 CONFIG_INVALID and writes nothing", async () => {
    const h = await cloudInstall();
    expect(await h.create(MAYA, { repository: "acme/not-installed" })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(h.everyRow(h.db)).toEqual([]);
  });

  it("answers a second org's project as that org's alone: two orgs each create web on repositories under their own owners", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { repository: "acme/web" })).status).toBe(201);
    expect((await h.create(OMAR, { repository: "globex/web" })).status).toBe(201);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", access: "granted" }]);
    expect(await h.listed(OMAR)).toEqual([{ name: "web", access: "granted" }]);
    expect((h.db.get(projectRevisionKey(TEST_ORG, "web", 1)) as { definition: { repositories: Array<{ url: string }> } }).definition.repositories[0]?.url).toBe("https://github.com/Acme/web.git");
    expect((h.db.get(projectRevisionKey(OTHER_ORG, "web", 1)) as { definition: { repositories: Array<{ url: string }> } }).definition.repositories[0]?.url).toBe("https://github.com/globex/web.git");
    expect(h.projectRows()).toHaveLength(2);
    // Another org's repository stays out of reach, and neither org sees a project only the other made.
    expect((await h.create(OMAR, { repository: "acme/api" })).status).toBe(403);
    expect((await h.create(MAYA, { repository: "acme/api", name: "api" })).status).toBe(201);
    expect(await h.listed(OMAR)).toEqual([{ name: "web", access: "granted" }]);
    expect(h.db.get(projectMemberKey(OTHER_ORG, MAYA.developerId, "api"))).toBeUndefined();
  });

  it("answers an identical re-creation with 200 and duplicate true, and still grants the creator", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { repository: "acme/web" })).status).toBe(201);
    h.db.delete(projectMemberKey(TEST_ORG, MAYA.developerId, "web"));
    expect(await h.listed(MAYA)).toEqual([]);
    const again = await h.create(MAYA, { repository: "acme/web" });
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, project: { definition: { name: "web" } } } });
    expect(h.projectRows()).toHaveLength(1);
    expect(await h.listed(MAYA)).toEqual([{ name: "web", access: "granted" }]);
  });

  it("refuses the same project name for a different repository with 409 and changes nothing", async () => {
    const h = await cloudInstall();
    expect((await h.create(MAYA, { repository: "acme/web" })).status).toBe(201);
    expect(await h.create(MAYA, { repository: "acme/api", name: "web" })).toMatchObject({ status: 409, body: { error: { code: "PROJECT_REVISION_MISMATCH" } } });
    expect(h.projectRows()).toHaveLength(1);
  });

  it.each([
    ["no repository", { name: "web" }],
    ["a repository without an owner", { repository: "web" }],
    ["a repository URL", { repository: "https://github.com/acme/web" }],
    ["a name that is not a project name", { repository: "acme/web", name: "My Web" }],
    ["a command that chains steps", { repository: "acme/web", setupCommand: "npm ci && npm run build" }],
    ["a command with an unclosed quote", { repository: "acme/web", testCommand: "npm test \"x" }],
    ["an org of its own choosing", { repository: "acme/web", orgId: OTHER_ORG }],
  ])("refuses %s with 400 CONFIG_INVALID and writes nothing", async (_name, body) => {
    const h = await cloudInstall();
    expect(await h.create(MAYA, body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(h.everyRow(h.db)).toEqual([]);
  });

  it("answers RUNTIME_UNAVAILABLE where the control plane has no runtime defaults to build a project with", async () => {
    const h = await cloudInstall({ configured: false });
    expect(await h.create(MAYA, { repository: "acme/web" })).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE" } } });
    expect(h.everyRow(h.db)).toEqual([]);
  });
});

describe("POST /v1/dev/projects on an install that is not cloud", () => {
  async function privateInstall() {
    const harness = await createDeveloperTaskBroker({ register: false, brokerExtra: { cloudProjects: CLOUD_PROJECTS } });
    seedMembership(harness.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    return harness;
  }

  it("refuses an owner with 403 and points at agentx project add, writing nothing", async () => {
    const h = await privateInstall();
    const refused = await h.dev(MAYA, "POST", "/v1/dev/projects", { repository: "acme/web" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect((refused.body.error as { message: string }).message).toContain("ask an administrator to run agentx project add");
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
