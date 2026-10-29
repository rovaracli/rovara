// Plan 2, Task 17: a project maintainer changes its commands, devcontainer, repositories and allowed domains with
// PUT /v1/app/projects/{name}/settings. Each change is a new immutable revision; a stale edit is refused; a domain is refused unless it
// names one owner's site (the Public Suffix List decides); `network` never reaches a worker.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AllowedDomainSchema, DEFAULT_AGENT_ALLOW_DOMAINS, ProjectDefinitionSchema, egressDomainsKey, ProjectNetworkSchema, ProjectSettingsBodySchema, StoredProjectDefinitionSchema, githubInstallationKey, githubRepoProjectKey, orgGithubInstallationKey,
  orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, workerProjectDefinition, type GithubInstallationRecord, type OrgId, type OrgRole,
} from "../../packages/contracts/src/index.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { call } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const CLOUD_PROJECTS = { runtimeBinding: BINDING, githubCredentialRef: "github-app" };
const FIELD_MESSAGE = (field: string) => `${field}: must be a domain name such as artifacts.acme.dev or *.acme.dev`;
const STALE = "someone changed this project's settings; reload and try again";
const NOT_CONNECTED = (repository: string) => `Rovara can't reach ${repository} through your organization's GitHub connection. Connect it with: agentx github connect`;

/** The repositories the fake GitHub App sees, by lower-case full name: default branch and GitHub's repository id. */
const VISIBLE = new Map([["acme/web", { branch: "main", id: 1 }], ["acme/api", { branch: "trunk", id: 2 }], ["acme/lib", { branch: "main", id: 3 }], ["globex/web", { branch: "main", id: 4 }]]);

function githubFake() {
  return {
    getRepositoryIdentity: vi.fn(async (url: string) => {
      const [owner, name] = new URL(url).pathname.replace(/\.git$/, "").split("/").filter(Boolean) as [string, string];
      const found = VISIBLE.get(`${owner}/${name}`.toLowerCase());
      return found === undefined ? undefined : { repositoryId: found.id, fullName: `${owner}/${name}`, defaultBranch: found.branch };
    }),
    checkRepositoryAccess: vi.fn(async () => undefined),
  };
}

const command = (executable: string, args: string[], timeoutSeconds: number, cwd = "repo/web") => ({ cwd, executable, args, timeoutSeconds });

/** A project written the way registration writes it: revision 1 with one repository, a setup and a test command, the catalog entry and META. */
function seedProject(db: FakeDynamoDb, orgId: OrgId = TEST_ORG, name = "web", extra: Record<string, unknown> = {}, recordExtra: Record<string, unknown> = {}): void {
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, ...recordExtra,
    definition: {
      name, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)],
      orchestratorInstructions: "Delegate work.", ...extra,
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
}

/** What an org's GitHub connection looks like once Task 13 binds it: the org's record and the global one, both carrying the same record. */
function seedInstallation(db: FakeDynamoDb, installationId: number, accountLogin: string, extra: Partial<GithubInstallationRecord> = {}, orgId: OrgId = TEST_ORG, globalOrgId: OrgId = orgId): void {
  const record: GithubInstallationRecord = {
    installationId, orgId, accountLogin, accountId: 900 + installationId, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1",
    boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
  };
  db.set({ ...orgGithubInstallationKey(orgId, installationId), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...githubInstallationKey(installationId), entityType: "GITHUB_INSTALLATION", ...record, orgId: globalOrgId });
}

async function install(options: { cloud?: boolean; owner?: OrgRole } = {}) {
  const github = githubFake();
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      ...(options.cloud === false ? {} : { cloud: true }), cloudProjects: CLOUD_PROJECTS,
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: github.getRepositoryIdentity },
      checkRepositoryAccess: github.checkRepositoryAccess,
    },
  });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: options.owner ?? "admin" });
  seedProject(h.db);
  const put = (who: Developer, body: Record<string, unknown>, name = "web") => h.dev(who, "PUT", `/v1/app/projects/${name}/settings`, { requestId: randomUUID(), expectedRevision: 1, ...body });
  const detail = async (who: Developer = OMAR, name = "web") => (await h.dev(who, "GET", `/v1/app/projects/${name}`)).body as { latestRevision: number; settings: { setupCommands: string[]; testCommands: string[]; devcontainer: { repository: string; configPath: string } | null; allowedDomains: Array<{ domain: string; status: string }> }; repositories: Array<{ fullName: string; defaultBranch: string }>; description?: string };
  const revisions = (name = "web", orgId: OrgId = TEST_ORG) => h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(orgId, name, 1).pk);
  const revision = (n: number, name = "web", orgId: OrgId = TEST_ORG) => h.db.get(projectRevisionKey(orgId, name, n)) as { definition: Record<string, unknown>; runtimeBinding: unknown; registeredBy: string } | undefined;
  return { ...h, github, put, detail, revisions, revision };
}

describe("PUT /v1/app/projects/{name}/settings: who and which revision", () => {
  it("refuses a stale expectedRevision with PROJECT_REVISION_MISMATCH and writes no revision", async () => {
    const h = await install();
    expect((await h.put(OMAR, { setupCommands: ["npm run setup"] })).status).toBe(200);
    expect(h.revisions()).toHaveLength(2);
    const stale = await h.put(OMAR, { setupCommands: ["make setup"] });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(h.revisions()).toHaveLength(2);
    // An expectedRevision ahead of the latest is no revision the person saw either.
    const ahead = await h.put(OMAR, { setupCommands: ["make setup"], expectedRevision: 9 });
    expect(ahead.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(h.revisions()).toHaveLength(2);
    // The one that matches goes through, as revision 3.
    expect((await h.put(OMAR, { setupCommands: ["make setup"], expectedRevision: 2 })).status).toBe(200);
    expect(h.revision(3)!.definition).toMatchObject({ revision: 3, setup: [{ executable: "make", args: ["setup"] }] });
  });

  it("answers a change that another save made first as the same mismatch", async () => {
    const h = await install();
    // A second maintainer's save lands between this one's read and its write: revision 2 exists with other content.
    const first = h.put(OMAR, { setupCommands: ["npm run a"] });
    const second = h.put(OMAR, { setupCommands: ["npm run b"] });
    const answers = await Promise.all([first, second]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH", message: STALE });
    expect(h.revisions()).toHaveLength(2);
  });

  it("refuses a contributor with 403, and answers 404 to a member with no access", async () => {
    const h = await install();
    grantProject(h.db, MAYA, "web");
    const refused = await h.put(MAYA, { setupCommands: ["npm run setup"] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "only a project maintainer can change its settings" });
    expect(h.revisions()).toHaveLength(1);
    h.db.delete(projectMemberKey(TEST_ORG, MAYA.developerId, "web"));
    const hidden = await h.put(MAYA, { setupCommands: ["npm run setup"] });
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("lets an org admin with no grant change the settings, as a new revision registered by them on the project's own runtime", async () => {
    const h = await install();
    const saved = await h.put(OMAR, { setupCommands: ["npm run setup"] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ project: { name: "web", latestRevision: 2, myRole: "maintainer" }, warnings: [] });
    expect(h.revision(2)).toMatchObject({ registeredBy: OMAR.developerId, runtimeBinding: BINDING, definition: { revision: 2, name: "web" } });
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 2 });
    // The previous revision is untouched.
    expect(h.revision(1)!.definition).toMatchObject({ revision: 1, setup: [{ executable: "npm", args: ["ci"] }] });
  });

  it("answers 403 on an install that is not Rovara Cloud, with the administrator's command", async () => {
    const h = await install({ cloud: false });
    const refused = await h.put(OMAR, { setupCommands: ["npm run setup"] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "ask an administrator to change this project with agentx admin project register" });
    expect(h.revisions()).toHaveLength(1);
  });

  it("never reaches another org's project of the same name", async () => {
    const h = await install();
    h.db.delete(projectRevisionKey(TEST_ORG, "web", 1));
    h.db.delete(orgProjectCatalogKey(TEST_ORG, "web"));
    seedProject(h.db, OTHER_ORG, "web");
    const refused = await h.put(OMAR, { setupCommands: ["npm run setup"] });
    expect(refused.status).toBe(404);
    expect(h.revisions("web", OTHER_ORG)).toHaveLength(1);
  });

  it("refuses an unknown field, a body that changes nothing, and a body that is not the schema", async () => {
    const h = await install();
    expect((await h.put(OMAR, { runtimeBinding: {} })).status).toBe(400);
    const nothing = await h.put(OMAR, {});
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "body: give at least one setting to change" });
    const tooMany = await h.put(OMAR, { setupCommands: Array.from({ length: 17 }, () => "npm ci") });
    expect(tooMany.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((tooMany.body.error as { message: string }).message).toMatch(/^setupCommands: /);
    const long = await h.put(OMAR, { testCommands: ["x".repeat(501)] });
    expect((long.body.error as { message: string }).message).toMatch(/^testCommands\.0: /);
    expect((await h.dev(OMAR, "PUT", "/v1/app/projects/web/settings", { expectedRevision: 1, setupCommands: ["npm ci"] })).status).toBe(400);
    expect(h.revisions()).toHaveLength(1);
  });
});

describe("commands", () => {
  it("round-trip through GET /v1/app/projects/{name}, with each command's directory and timeout", async () => {
    const h = await install();
    const saved = await h.put(OMAR, { setupCommands: ["npm ci", "npm run build -- --prod"], testCommands: ["npm test -- --run"] });
    expect(saved.status).toBe(200);
    expect(h.revision(2)!.definition).toMatchObject({
      setup: [command("npm", ["ci"], 900), command("npm", ["run", "build", "--", "--prod"], 900)],
      readiness: [command("npm", ["test", "--", "--run"], 1800)],
    });
    const shown = await h.detail();
    expect(shown.latestRevision).toBe(2);
    expect(shown.settings.setupCommands).toEqual(["npm ci", "npm run build -- --prod"]);
    expect(shown.settings.testCommands).toEqual(["npm test -- --run"]);
    expect((saved.body.project as typeof shown).settings).toEqual(shown.settings);
  });

  it("changes only the fields given: the other list, the repositories and the runtime stay as they were", async () => {
    const h = await install();
    await h.put(OMAR, { testCommands: [] });
    expect(h.revision(2)!.definition).toMatchObject({ setup: [command("npm", ["ci"], 900)], readiness: [], repositories: [{ name: "web", url: "https://github.com/acme/web.git" }] });
  });

  it("names the field and index of a command it cannot read, and writes nothing", async () => {
    const h = await install();
    for (const [field, body, reason] of [
      ["setupCommands.1", { setupCommands: ["npm ci", "npm ci && npm test"] }, "&&"],
      ["testCommands.0", { testCommands: ["echo 'unclosed"] }, "unclosed quote"],
      ["setupCommands.0", { setupCommands: ["  "] }, "empty"],
    ] as const) {
      const refused = await h.put(OMAR, body);
      expect(refused.status, field).toBe(400);
      expect((refused.body.error as { message: string }).message, field).toContain(`${field}: `);
      expect((refused.body.error as { message: string }).message, field).toContain(reason);
    }
    expect(h.revisions()).toHaveLength(1);
  });

  it("runs the new commands in the project's first repository", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    expect((await h.put(OMAR, { addRepositories: ["acme/api"] })).status).toBe(200);
    expect((await h.put(OMAR, { setupCommands: ["make"], expectedRevision: 2 })).status).toBe(200);
    expect((h.revision(3)!.definition as { setup: Array<{ cwd: string }> }).setup[0]!.cwd).toBe("repo/web");
  });

  it("writes no revision when nothing changed, and answers with the project as it is", async () => {
    const h = await install();
    const same = await h.put(OMAR, { setupCommands: ["npm ci"], testCommands: ["npm test"] });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ project: { latestRevision: 1 }, warnings: [] });
    expect(h.revisions()).toHaveLength(1);
  });
});

describe("allowed domains", () => {
  const REFUSED = ["*", "*.com", "10.0.0.1", "localhost", "*.github.io", "github.io", "*.s3.amazonaws.com", "a..b", "*.sch.uk", "*.kawasaki.jp", "*.0emm.com"];

  it.each(REFUSED)("refuses %s with its field and index, and no revision", async (bad) => {
    const h = await install();
    const refused = await h.put(OMAR, { allowedDomains: ["ok.acme.dev", "also.acme.dev", bad] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: FIELD_MESSAGE("allowedDomains.2") });
    expect(JSON.stringify(refused.body)).not.toContain(bad === "*" ? "\u0000" : `${bad}"`);
    expect(h.revisions()).toHaveLength(1);
  });

  it("also refuses an IPv6 literal, a scheme, a path, a port, a trailing dot, an unknown top level of digits, a space, and a name over 253 characters", async () => {
    const h = await install();
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`;
    for (const bad of ["::1", "[::1]", "2001:db8::1", "https://acme.dev", "acme.dev/path", "acme.dev:443", "acme.dev.", "acme.1", "1.2.3.4", "ac me.dev", "-acme.dev", "acme-.dev", "", long, "*.*.acme.dev", "foo.*.acme.dev", "*acme.dev", "*.localhost"]) {
      const refused = await h.put(OMAR, { allowedDomains: [bad] });
      expect(refused.body.error, JSON.stringify(bad)).toMatchObject({ code: "CONFIG_INVALID", message: FIELD_MESSAGE("allowedDomains.0") });
    }
    expect(h.revisions()).toHaveLength(1);
  });

  it("accepts foo.github.io, *.acme.co.uk and a wildcard over an exception rule's registrable name, and stores them in the revision", async () => {
    const h = await install();
    const saved = await h.put(OMAR, { allowedDomains: ["foo.github.io", "*.acme.co.uk", "artifacts.acme.dev", "*.www.ck"] });
    expect(saved.status).toBe(200);
    // Each is a new request: on cloud a domain waits for Rovara's approval (Task 18).
    expect(saved.body.warnings).toEqual(["foo.github.io", "*.acme.co.uk", "artifacts.acme.dev", "*.www.ck"].map((domain) => `${domain} is waiting for Rovara to approve it`));
    expect(h.revision(2)!.definition).toMatchObject({ network: { allowedDomains: ["foo.github.io", "*.acme.co.uk", "artifacts.acme.dev", "*.www.ck"] } });
    expect((await h.detail()).settings.allowedDomains).toEqual(["foo.github.io", "*.acme.co.uk", "artifacts.acme.dev", "*.www.ck"].map((domain) => ({ domain, status: "pending" })));
  });

  it("stores Artifacts.ACME.dev as artifacts.acme.dev, once", async () => {
    const h = await install();
    expect((await h.put(OMAR, { allowedDomains: ["Artifacts.ACME.dev", "artifacts.acme.dev", "*.ACME.dev"] })).status).toBe(200);
    expect(h.revision(2)!.definition).toMatchObject({ network: { allowedDomains: ["artifacts.acme.dev", "*.acme.dev"] } });
  });

  it("says a domain every project already has is already allowed, and still saves it", async () => {
    const h = await install();
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).toContain("registry.npmjs.org");
    expect(DEFAULT_AGENT_ALLOW_DOMAINS).toContain("*.amazonaws.com");
    const saved = await h.put(OMAR, { allowedDomains: ["registry.npmjs.org", "*.amazonaws.com", "artifacts.acme.dev"] });
    expect(saved.status).toBe(200);
    expect(saved.body.warnings).toEqual(["registry.npmjs.org is already allowed for every project", "*.amazonaws.com is already allowed for every project", "artifacts.acme.dev is waiting for Rovara to approve it"]);
    expect(h.revision(2)!.definition).toMatchObject({ network: { allowedDomains: ["registry.npmjs.org", "*.amazonaws.com", "artifacts.acme.dev"] } });
  });

  it("clears the list with an empty one, leaving no network key behind, and leaves it alone when not given", async () => {
    const h = await install();
    await h.put(OMAR, { allowedDomains: ["artifacts.acme.dev"] });
    await h.put(OMAR, { testCommands: ["npm run check"], expectedRevision: 2 });
    expect(h.revision(3)!.definition).toMatchObject({ network: { allowedDomains: ["artifacts.acme.dev"] } });
    expect((await h.put(OMAR, { allowedDomains: [], expectedRevision: 3 })).status).toBe(200);
    expect(h.revision(4)!.definition).not.toHaveProperty("network");
    expect((await h.detail()).settings.allowedDomains).toEqual([]);
  });

  // Ruling C29: the egress item is written BEFORE the revision, so a failure of the second leaves state the schedule repairs (final review I2).
  it("writes the egress item before the new revision, so a revision that fails to land is repaired by the schedule, not left unseen", async () => {
    const h = await install();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"entityType":"PROJECT"') && !JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await h.put(OMAR, { allowedDomains: ["artifacts.acme.dev"] });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h.revisions()).toHaveLength(1);
    expect(h.db.get(egressDomainsKey(TEST_ORG, { kind: "project", project: "web" }))).toMatchObject({ domains: [{ domain: "artifacts.acme.dev", status: "pending" }] });
  });

  it("makes no revision when the egress item cannot be written", async () => {
    const h = await install();
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const failed = await h.put(OMAR, { allowedDomains: ["artifacts.acme.dev"] });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h.revisions()).toHaveLength(1);
  });

  it("refuses more than 50 domains", async () => {
    const h = await install();
    const refused = await h.put(OMAR, { allowedDomains: Array.from({ length: 51 }, (_, index) => `a${String(index)}.acme.dev`) });
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((refused.body.error as { message: string }).message).toMatch(/^allowedDomains: /);
  });
});

describe("AllowedDomainSchema and ProjectNetworkSchema", () => {
  it("lower-cases, refuses by one message that names no value, and holds at most 50 in a network", () => {
    expect(AllowedDomainSchema.parse("Foo.GitHub.IO")).toBe("foo.github.io");
    expect(AllowedDomainSchema.parse("*.Acme.Co.UK")).toBe("*.acme.co.uk");
    expect(AllowedDomainSchema.parse("amazonaws.com")).toBe("amazonaws.com");
    expect(AllowedDomainSchema.parse("*.amazonaws.com")).toBe("*.amazonaws.com");
    for (const bad of ["com", "co.uk", "*.co.uk", "github.io", "*.s3.amazonaws.com", "s3.amazonaws.com", "10.0.0.1", "localhost", "*", "a..b", "*.sch.uk", "*.kawasaki.jp", "*.0emm.com", "*.compute.amazonaws.com", "*.ck"]) {
      const result = AllowedDomainSchema.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error!.issues.map((issue) => issue.message), bad).toEqual(["must be a domain name such as artifacts.acme.dev or *.acme.dev"]);
    }
    // A wildcard over a name whose every child is a suffix is refused (a `*.X` rule), but the exception rule's name, and a bare X, are names.
    for (const good of ["sch.uk", "city.kawasaki.jp", "*.city.kawasaki.jp", "www.ck", "*.www.ck", "0emm.com", "*.a.acme.sch.uk"]) {
      expect(AllowedDomainSchema.safeParse(good).success, good).toBe(true);
    }
    expect(AllowedDomainSchema.safeParse(7).success).toBe(false);
    expect(ProjectNetworkSchema.parse({ allowedDomains: ["Artifacts.acme.dev"] })).toEqual({ allowedDomains: ["artifacts.acme.dev"] });
    expect(ProjectNetworkSchema.safeParse({ allowedDomains: ["artifacts.acme.dev"], extra: 1 }).success).toBe(false);
    expect(ProjectNetworkSchema.safeParse({ allowedDomains: Array.from({ length: 51 }, (_, index) => `a${String(index)}.acme.dev`) }).success).toBe(false);
  });

  it("is a field of a stored project definition, and nothing else changes in one", () => {
    const base = { name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    expect(StoredProjectDefinitionSchema.parse({ ...base, network: { allowedDomains: ["a.acme.dev"] } })).toMatchObject({ network: { allowedDomains: ["a.acme.dev"] } });
    expect(StoredProjectDefinitionSchema.safeParse({ ...base, network: { allowedDomains: ["com"] } }).success).toBe(false);
  });

  it("reads a stored domain that a newer suffix list would refuse, but refuses it when a definition is written", () => {
    const base = { name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    for (const domain of ["*.sch.uk", "*.kawasaki.jp", "github.io", "*.github.io", "s3.amazonaws.com"]) {
      const network = { allowedDomains: [domain] };
      expect(StoredProjectDefinitionSchema.parse({ ...base, network }), domain).toMatchObject({ network });
      expect(ProjectNetworkSchema.parse(network), domain).toEqual(network);
      expect(ProjectDefinitionSchema.safeParse({ ...base, network }).success, domain).toBe(false);
    }
    expect(ProjectDefinitionSchema.safeParse({ ...base, network: { allowedDomains: ["a.acme.dev", "*.acme.dev"] } }).success).toBe(true);
    // The read check is still a hostname's shape.
    for (const bad of ["*", "com", "10.0.0.1", "a..b", "https://acme.dev", ""]) {
      expect(StoredProjectDefinitionSchema.safeParse({ ...base, network: { allowedDomains: [bad] } }).success, bad).toBe(false);
    }
    expect(StoredProjectDefinitionSchema.parse(base)).not.toHaveProperty("network");
  });

  it("parses the settings body with its limits", () => {
    const base = { requestId: randomUUID(), expectedRevision: 3 };
    expect(ProjectSettingsBodySchema.safeParse(base).success).toBe(true);
    expect(ProjectSettingsBodySchema.safeParse({ ...base, devcontainer: null, description: "A site", setupCommands: ["a"], testCommands: [], addRepositories: ["acme/api"], removeRepositories: ["web"] }).success).toBe(true);
    for (const bad of [{ expectedRevision: 0 }, { expectedRevision: 1.5 }, { requestId: "nope" }, { addRepositories: ["api"] }, { addRepositories: ["acme/.."] }, { description: "x".repeat(281) }, { setupCommands: "npm ci" }, { devcontainer: { repository: "web", other: 1 } }, { other: 1 }]) {
      expect(ProjectSettingsBodySchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("devcontainer", () => {
  it("sets the devcontainer to a repository of the project, by its name or its GitHub name, and removes it with null", async () => {
    const h = await install();
    expect((await h.put(OMAR, { devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" } })).status).toBe(200);
    expect(h.revision(2)!.definition).toMatchObject({ devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" } });
    expect((await h.detail()).settings.devcontainer).toEqual({ repository: "web", configPath: ".devcontainer/ci.json" });
    expect((await h.put(OMAR, { devcontainer: { repository: "Acme/Web" }, expectedRevision: 2 })).status).toBe(200);
    expect(h.revision(3)!.definition).toMatchObject({ devcontainer: { repository: "web" } });
    expect((h.revision(3)!.definition.devcontainer as Record<string, unknown>).configPath).toBeUndefined();
    expect((await h.put(OMAR, { devcontainer: null, expectedRevision: 3 })).status).toBe(200);
    expect(h.revision(4)!.definition).not.toHaveProperty("devcontainer");
    expect((await h.detail()).settings.devcontainer).toBeNull();
  });

  it("refuses a devcontainer that names a repository outside the project with CONFIG_INVALID", async () => {
    const h = await install();
    const refused = await h.put(OMAR, { devcontainer: { repository: "elsewhere" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "devcontainer.repository: is not a repository of this project" });
    expect((await h.put(OMAR, { devcontainer: { repository: "acme/api" } })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(h.revisions()).toHaveLength(1);
  });

  it("refuses a config path that leaves the repository", async () => {
    const h = await install();
    const refused = await h.put(OMAR, { devcontainer: { repository: "web", configPath: "../x.json" } });
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(h.revisions()).toHaveLength(1);
  });
});

describe("repositories", () => {
  it("adds a repository of a connected account as the entry project creation builds, and shows it", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    const saved = await h.put(OMAR, { addRepositories: ["Acme/api"] });
    expect(saved.status).toBe(200);
    expect(h.revision(2)!.definition).toMatchObject({
      repositories: [
        { name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" },
        { name: "api", url: "https://github.com/Acme/api.git", path: "repo/api", defaultBranch: "trunk", credentialRef: "github-app" },
      ],
    });
    expect((await h.detail()).repositories).toEqual([{ name: "web", fullName: "acme/web", defaultBranch: "main" }, { name: "api", fullName: "Acme/api", defaultBranch: "trunk" }]);
  });

  it("refuses an added repository that is not connected with GITHUB_NOT_CONNECTED, and writes no revision", async () => {
    const h = await install();
    // No installation at all, then one for another account.
    const none = await h.put(OMAR, { addRepositories: ["acme/api"] });
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED("acme/api") });
    seedInstallation(h.db, 55, "acme");
    const other = await h.put(OMAR, { addRepositories: ["globex/web"] });
    expect(other.body.error).toMatchObject({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED("globex/web") });
    expect(h.revisions()).toHaveLength(1);
    expect(h.github.getRepositoryIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["suspended", { status: "suspended" as const }, TEST_ORG],
    ["removed", { status: "removed" as const }, TEST_ORG],
    ["bound to another org", {}, OTHER_ORG],
    ["limited to selected repositories, which the connection check cannot yet see", { repositorySelection: "selected" as const }, TEST_ORG],
  ])("treats an installation that is %s as not connected", async (_label, extra, globalOrg) => {
    const h = await install();
    seedInstallation(h.db, 55, "acme", extra, TEST_ORG, globalOrg);
    const refused = await h.put(OMAR, { addRepositories: ["acme/api"] });
    expect(refused.body.error).toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(h.revisions()).toHaveLength(1);
  });

  it("does not take another org's installation of the same account as this org's", async () => {
    const h = await install();
    seedInstallation(h.db, 77, "acme", {}, OTHER_ORG);
    const refused = await h.put(OMAR, { addRepositories: ["acme/api"] });
    expect(refused.body.error).toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });

  it("refuses a repository GitHub cannot show, one already in the project, and one whose name another repository holds", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    expect((await h.put(OMAR, { addRepositories: ["acme/missing"] })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await h.put(OMAR, { addRepositories: ["acme/web"] })).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "addRepositories.0: is already a repository of this project" });
    expect((await h.put(OMAR, { addRepositories: ["acme/api", "acme/api"] })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(h.revisions()).toHaveLength(1);
  });

  it("removes a repository by its name or its GitHub name, but never the last one or the devcontainer's", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    await h.put(OMAR, { addRepositories: ["acme/api", "acme/lib"] });
    expect((await h.put(OMAR, { removeRepositories: ["lib"], expectedRevision: 2 })).status).toBe(200);
    expect((h.revision(3)!.definition.repositories as Array<{ name: string }>).map((repository) => repository.name)).toEqual(["web", "api"]);
    expect((await h.put(OMAR, { removeRepositories: ["acme/api"], devcontainer: { repository: "api" }, expectedRevision: 3 })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    await h.put(OMAR, { devcontainer: { repository: "api" }, expectedRevision: 3 });
    const kept = await h.put(OMAR, { removeRepositories: ["api"], expectedRevision: 4 });
    expect(kept.status).toBe(400);
    expect(kept.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "removeRepositories.0: is the devcontainer's repository; change the devcontainer first" });
    // Moving the devcontainer away in the same save is allowed.
    expect((await h.put(OMAR, { removeRepositories: ["api"], devcontainer: null, expectedRevision: 4 })).status).toBe(200);
    expect((h.revision(5)!.definition.repositories as Array<{ name: string }>).map((repository) => repository.name)).toEqual(["web"]);
  });

  it("refuses removing the last repository with CONFIG_INVALID, and a repository the project does not have", async () => {
    const h = await install();
    const last = await h.put(OMAR, { removeRepositories: ["web"] });
    expect(last.status).toBe(400);
    expect(last.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "removeRepositories: a project keeps at least one repository" });
    expect((await h.put(OMAR, { removeRepositories: ["nothing"] })).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "removeRepositories.0: is not a repository of this project" });
    expect(h.revisions()).toHaveLength(1);
  });

  it("replaces a repository in one save, adding the new one before removing the old", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    expect((await h.put(OMAR, { addRepositories: ["acme/api"], removeRepositories: ["web"], setupCommands: [], testCommands: [] })).status).toBe(200);
    expect((h.revision(2)!.definition.repositories as Array<{ name: string }>).map((repository) => repository.name)).toEqual(["api"]);
  });
});

describe("removing a repository that commands run in", () => {
  it("is refused while a kept command runs there, and allowed when the same save replaces the commands", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    await h.put(OMAR, { setupCommands: ["npm ci"], testCommands: ["npm run check"] });
    const refused = await h.put(OMAR, { addRepositories: ["acme/api"], removeRepositories: ["web"], setupCommands: ["npm ci"], expectedRevision: 2 });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID", message: "removeRepositories.0: commands run in it; replace setupCommands and testCommands in the same save" });
    const revisions = 2;
    expect(h.revisions()).toHaveLength(revisions);
    const replaced = await h.put(OMAR, { addRepositories: ["acme/api"], removeRepositories: ["web"], setupCommands: ["npm ci"], testCommands: ["npm run check"], expectedRevision: revisions });
    expect(replaced.status).toBe(200);
    expect((h.revision(revisions + 1)!.definition.setup as Array<{ cwd: string }>)[0]!.cwd).toBe((h.revision(revisions + 1)!.definition.repositories as Array<{ path: string }>)[0]!.path);
  });
});

describe("description", () => {
  it("changes META only: no new revision, and the catalog stays", async () => {
    const h = await install();
    const saved = await h.put(OMAR, { description: "The marketing site" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ project: { description: "The marketing site", latestRevision: 1 }, warnings: [] });
    expect(h.revisions()).toHaveLength(1);
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ description: "The marketing site", status: "active", createdBy: MAYA.developerId });
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 1 });
  });

  it("goes with a revision when other settings change in the same save, and an empty one removes it", async () => {
    const h = await install();
    expect((await h.put(OMAR, { description: "Docs", testCommands: ["npm run check"] })).status).toBe(200);
    expect(h.revisions()).toHaveLength(2);
    expect((await h.detail()).description).toBe("Docs");
    expect((await h.put(OMAR, { description: "", expectedRevision: 2 })).status).toBe(200);
    expect((await h.detail()).description).toBeUndefined();
  });

  it("is checked against expectedRevision like any other change", async () => {
    const h = await install();
    await h.put(OMAR, { testCommands: ["npm run check"] });
    expect((await h.put(OMAR, { description: "Late" })).body.error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ description: "The site" });
  });

  it("gives a project that predates META its META item, with the description", async () => {
    const h = await install();
    h.db.delete(projectMetaKey(TEST_ORG, "web"));
    expect((await h.put(OMAR, { description: "Old project" })).status).toBe(200);
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ entityType: "PROJECT_META", name: "web", status: "active", description: "Old project", createdBy: "unknown" });
  });
});

describe("a project with an E2E policy", () => {
  it("is changed by an administrator only", async () => {
    const h = await install();
    seedProject(h.db, TEST_ORG, "web", {}, { setupApproval: { proposalRef: "project-setup-proposals/x/y.json", proposalSha256: "a".repeat(64), candidateDigest: "b".repeat(64), decision: "decline" } });
    const refused = await h.put(OMAR, { testCommands: ["npm run check"] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "this project carries an end-to-end policy or a setup approval that only an administrator can change; ask an administrator to change it with agentx admin project register" });
    expect(h.revisions()).toHaveLength(1);
  });
});

describe("older workers", () => {
  // The project definition's fields before Task 17, as a strict schema from 308a2cf8 knew them: a field it does not list fails its parse.
  const OLD_FIELDS = ["name", "revision", "repositories", "setup", "readiness", "devcontainer", "orchestratorInstructions", "models", "integrations", "actionPolicy", "developerTasks", "e2e"];
  const oldStrict = z.object(Object.fromEntries(OLD_FIELDS.map((field) => [field, z.unknown().optional()]))).strict();

  it("workerProjectDefinition drops network and nothing else", () => {
    const definition = { name: "web", revision: 2, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x", network: { allowedDomains: ["a.acme.dev"] } };
    expect(oldStrict.safeParse(definition).success).toBe(false);
    const stripped = workerProjectDefinition(definition);
    expect(stripped).not.toHaveProperty("network");
    expect(oldStrict.safeParse(stripped).success).toBe(true);
    expect(Object.keys(stripped).sort()).toEqual(Object.keys(definition).filter((key) => key !== "network").sort());
    expect(definition.network).toBeDefined();
    expect(workerProjectDefinition({ name: "x" })).toEqual({ name: "x" });
  });

  it("builds the invocation of a project with network without a network key, whichever way the worker is sent the project", async () => {
    const h = await createDeveloperTaskBroker();
    // The stored revision carries network (an administrator registered it, as Task 17 allows), and the strict schema of before parses the invocation.
    const response = await call(h.handler, {
      method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
      body: {
        definition: {
          name: "payments", revision: 2,
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
          setup: [], readiness: [], orchestratorInstructions: "Delegate work.", network: { allowedDomains: ["artifacts.acme.dev"] },
        },
        runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
      },
    });
    expect(response.status).toBe(201);
    expect(h.db.get(projectRevisionKey(TEST_ORG, "payments", 2))).toMatchObject({ definition: { network: { allowedDomains: ["artifacts.acme.dev"] } } });
    grantProject(h.db, MAYA);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    expect(started.status).toBe(200);
    const invocations = h.db.find((item) => item.entityType === "OUTBOX").map((item) => item.invocation as { kind: string; payload: { project?: Record<string, unknown> } });
    const carrying = invocations.filter((invocation) => invocation.payload.project !== undefined);
    expect(carrying.length).toBeGreaterThan(0);
    for (const invocation of carrying) {
      expect(invocation.payload.project, invocation.kind).not.toHaveProperty("network");
      expect(invocation.payload.project!.revision).toBe(2);
      expect(oldStrict.safeParse(invocation.payload.project).success, invocation.kind).toBe(true);
    }
  });
});

describe("agentx project show and agentx project settings", () => {
  const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
  const ISSUER = `${URL_}/v1/auth`;
  const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  const detail = {
    name: "web", description: "The site", status: "active", latestRevision: 4, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready", checkedRevision: 4, checkedAt: "2026-10-20T00:00:00.000Z" },
    settings: { setupCommands: ["npm ci"], testCommands: ["npm test"], devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json" }, allowedDomains: [{ domain: "artifacts.acme.dev", status: "approved" }, { domain: "x.acme.dev", status: "pending" }] },
    createdAt: "2026-10-02T00:00:00.000Z", createdBy: { developerId: "d", name: "Maya Chen" },
  };

  async function signedIn(answer: (request: { method: string; path: string; body: unknown }) => Response) {
    const home = await mkdtemp(join(tmpdir(), "agentx-project-settings-"));
    dirs.push(home);
    await saveDeveloperEnvironment(home, "staging", entry);
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    const out: string[] = [];
    const err: string[] = [];
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const request = { method: init?.method ?? "GET", path: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
      requests.push(request);
      return answer(request);
    });
    const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
    return { out, err, run, requests };
  }

  it("shows a project: its revision, commands, devcontainer, repositories and each domain's status", async () => {
    const h = await signedIn(() => Response.json(detail));
    expect(await h.run(["project", "show", "web"])).toBe(0);
    expect(h.requests).toEqual([{ method: "GET", path: "/v1/app/projects/web", body: undefined }]);
    const text = h.out.join("");
    for (const expected of ["web", "The site", "revision 4", "acme/web", "npm ci", "npm test", ".devcontainer/devcontainer.json", "artifacts.acme.dev", "approved", "x.acme.dev", "pending", "maintainer"]) expect(text).toContain(expected);
    expect(h.err.join("")).toBe("");
  });

  it("--json prints the project", async () => {
    const h = await signedIn(() => Response.json(detail));
    expect(await h.run(["--json", "project", "show", "web"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { project: { name: "web", latestRevision: 4 } } });
  });

  it("reads the revision, then sends only the settings given, with that revision as expectedRevision", async () => {
    const h = await signedIn((request) => (request.method === "GET" ? Response.json(detail) : Response.json({ project: { ...detail, latestRevision: 5 }, warnings: ["registry.npmjs.org is already allowed for every project"] })));
    expect(await h.run([
      "project", "settings", "web", "--setup-command", "npm ci", "--setup-command", "npm run build", "--test-command", "npm test", "--allow-domain", "registry.npmjs.org", "--allow-domain", "Artifacts.acme.dev",
      "--description", "New words", "--add-repository", "acme/api", "--remove-repository", "old", "--devcontainer-repository", "web", "--devcontainer-config", ".devcontainer/ci.json",
    ])).toBe(0);
    expect(h.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/app/projects/web", "PUT /v1/app/projects/web/settings"]);
    expect(h.requests[1]!.body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, expectedRevision: 4, description: "New words",
      setupCommands: ["npm ci", "npm run build"], testCommands: ["npm test"], allowedDomains: ["registry.npmjs.org", "Artifacts.acme.dev"],
      addRepositories: ["acme/api"], removeRepositories: ["old"], devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" },
    });
    expect(h.out.join("")).toContain("revision 5");
    expect(h.err.join("") + h.out.join("")).toContain("registry.npmjs.org is already allowed for every project");
  });

  it("sends an empty list for --clear-setup-commands, --clear-test-commands and --clear-allowed-domains, and null for --remove-devcontainer", async () => {
    const h = await signedIn((request) => (request.method === "GET" ? Response.json(detail) : Response.json({ project: detail, warnings: [] })));
    expect(await h.run(["project", "settings", "web", "--clear-setup-commands", "--clear-test-commands", "--clear-allowed-domains", "--remove-devcontainer"])).toBe(0);
    expect(h.requests[1]!.body).toMatchObject({ expectedRevision: 4, setupCommands: [], testCommands: [], allowedDomains: [], devcontainer: null });
  });

  it("asks for a setting to change, and sends nothing, when none is given", async () => {
    const h = await signedIn(() => Response.json(detail));
    expect(await h.run(["project", "settings", "web"])).not.toBe(0);
    expect(h.err.join("")).toContain("give at least one setting to change");
    expect(h.requests).toEqual([]);
  });

  it("shows the server's reason when it refuses a domain", async () => {
    const h = await signedIn((request) => (request.method === "GET" ? Response.json(detail) : Response.json({ error: { code: "CONFIG_INVALID", message: FIELD_MESSAGE("allowedDomains.0") } }, { status: 400 })));
    expect(await h.run(["project", "settings", "web", "--allow-domain", "github.io"])).not.toBe(0);
    expect(h.err.join("")).toContain(FIELD_MESSAGE("allowedDomains.0"));
  });
});

describe("GitHub's events find a project by repository (Plan 4 Task 21)", () => {
  const PINNED = [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: 1 }];
  const rows = (h: { db: FakeDynamoDb }) => h.db.find((item) => String(item.pk).startsWith("GITHUB_REPO#")).map((item) => [item.pk, item.sk]);

  it("writes the index row of each pinned repository with the revision that holds it, and none for a repository without a pin", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    seedProject(h.db, TEST_ORG, "web", { repositories: PINNED });
    expect(rows(h)).toEqual([]);
    expect((await h.put(OMAR, { setupCommands: ["make"] })).status).toBe(200);
    expect(rows(h)).toEqual([[githubRepoProjectKey(1, TEST_ORG, "web").pk, `${TEST_ORG}#web`]]);
    expect(h.db.get(githubRepoProjectKey(1, TEST_ORG, "web"))).toMatchObject({ orgId: TEST_ORG, project: "web", installationId: 55, githubRepositoryId: 1 });
    // The repository added through the by-records connection has no pin, so no row names it.
    expect((await h.put(OMAR, { addRepositories: ["acme/api"], expectedRevision: 2 })).status).toBe(200);
    expect(rows(h)).toEqual([[githubRepoProjectKey(1, TEST_ORG, "web").pk, `${TEST_ORG}#web`]]);
  });

  it("deletes the row with the revision that removes the repository, in the same write, and leaves another project's row alone", async () => {
    const h = await install();
    seedInstallation(h.db, 55, "acme");
    seedProject(h.db, TEST_ORG, "web", { repositories: PINNED });
    h.db.set({ ...githubRepoProjectKey(1, TEST_ORG, "other"), entityType: "GITHUB_REPO_PROJECT", orgId: TEST_ORG, project: "other", installationId: 55, githubRepositoryId: 1 });
    expect((await h.put(OMAR, { addRepositories: ["acme/api"] })).status).toBe(200);
    expect(rows(h)).toHaveLength(2);
    const removed = await h.put(OMAR, { removeRepositories: ["web"], setupCommands: ["make"], testCommands: ["make test"], expectedRevision: 2 });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(rows(h)).toEqual([[githubRepoProjectKey(1, TEST_ORG, "other").pk, `${TEST_ORG}#other`]]);
  });
});

it("refuses the cloud settings registration path with a fixed409 when latest has working branch selections",async()=>{const h=await install(),key=projectRevisionKey(TEST_ORG,"web",1),before=h.db.get(key)!;h.db.set({...before,workingBranchSelections:{web:{branch:"release/current"}}});const result=await h.put(OMAR,{setupCommands:["npm run changed"]});expect(result.status,JSON.stringify(result.body)).toBe(409);expect(result.body.error).toMatchObject({code:"PROJECT_REVISION_MISMATCH",message:STALE});expect(h.revision(2)).toBeUndefined();expect(h.db.get(key)?.workingBranchSelections).toEqual({web:{branch:"release/current"}});});
