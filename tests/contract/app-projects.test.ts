// Plan 2, Task 11: project META records, the effective project role (org owners and admins maintain every project in their org), the
// refusals that belong where new work starts, and the app's project list and detail.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppProjectDetailSchema, AppProjectsResponseSchema, PROJECT_PERMISSIONS, ProjectSetupStatusSchema, agentXError, formatCommandLine, parseCommandLine, projectAllows, projectMetaKey, type OrgId, type ProjectCommand, type ProjectPermission, type ProjectRole } from "@rovara-code/contracts";
import { type OrgRole } from "@agentx/cloud-contracts";
import { orgMemberKey as orgMemberKeyOf } from "../../packages/cloud-contracts/src/org-node.js";
import { orgProjectCatalogKey, projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { checkProjectAccess, effectiveProjectRole, requireNewWorkAllowed, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject, registerRevision, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace, serviceCall } from "../support/slack-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { developerTaskIdentity, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { createCandidateManifest } from "@rovara-code/contracts";
import { TEST_ORG } from "../support/orgs.js";
import { readBrokerSource } from "../support/broker-source.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;

/** A project written the way registration writes it (revision, catalog entry), for a list or detail test. */
function seedProject(db: FakeDynamoDb, orgId: OrgId, name: string, options: { branch?: string; repository?: string; description?: string; status?: "active" | "archived"; meta?: boolean; revision?: number } = {}): void {
  const revision = options.revision ?? 1;
  const repository = options.repository ?? `acme/${name}`;
  const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
  db.set({
    ...projectRevisionKey(orgId, name, revision), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision,
      repositories: [{ name: "web", url: `https://github.com/${repository}.git`, path: "repo/web", defaultBranch: options.branch ?? "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test", "--", "--run"], 1800)],
      orchestratorInstructions: "Delegate work.",
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: revision, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  if (options.meta !== false && (options.status !== undefined || options.description !== undefined)) {
    db.set({
      ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: options.status ?? "active",
      ...(options.description === undefined ? {} : { description: options.description }),
      createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId,
      ...(options.status === "archived" ? { archivedAt: "2026-10-03T00:00:00.000Z", archivedBy: MAYA.developerId } : {}),
    });
  }
}

const setRole = (db: FakeDynamoDb, who: Developer, role: OrgRole, orgId: OrgId = TEST_ORG) => seedMembership(db, who.developerId, { orgId, role });
const listed = async (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, who: Developer, query = "") =>
  (await h.dev(who, "GET", `/v1/app/projects${query}`)).body.projects as Array<{ name: string; myRole: string; status: string }> | undefined;

describe("project roles and the contract schemas", () => {
  it("gives each role its permissions", () => {
    expect(PROJECT_PERMISSIONS.viewer).toEqual(["view"]);
    expect(PROJECT_PERMISSIONS.contributor).toEqual(["view", "start_tasks"]);
    expect([...PROJECT_PERMISSIONS.maintainer].sort()).toEqual([
      "approve_spend", "approve_writes", "archive", "edit_settings", "manage_agents", "manage_members", "setup_check", "start_tasks", "view", "view_spend",
    ]);
    const all: ProjectPermission[] = [
      "view", "start_tasks", "edit_settings", "manage_members", "archive", "setup_check", "manage_agents", "approve_spend", "approve_writes", "view_spend",
    ];
    for (const role of ["maintainer", "contributor", "viewer"] as ProjectRole[]) {
      for (const action of all) expect(projectAllows(role, action), `${role} ${action}`).toBe(PROJECT_PERMISSIONS[role].includes(action));
    }
  });

  it("parses the project list response and lists the five setup statuses", () => {
    expect(ProjectSetupStatusSchema.options).toEqual(["unchecked", "checking", "ready", "failed", "outdated"]);
    const response = { projects: [{
      name: "web", description: "The site", status: "active", latestRevision: 3, repositories: [{ fullName: "acme/web", defaultBranch: "main" }],
      myRole: "maintainer", setup: { status: "failed", checkedRevision: 3, checkedAt: "2026-10-20T00:00:00.000Z", failedStep: "setup: npm ci" },
    }] };
    expect(AppProjectsResponseSchema.parse(response)).toEqual(response);
    expect(() => AppProjectsResponseSchema.parse({ projects: [{ ...response.projects[0], myRole: "developer" }] })).toThrow();
    expect(() => AppProjectsResponseSchema.parse({ projects: [{ ...response.projects[0], status: "deleted" }] })).toThrow();
  });

  it("builds the project's META key beside its revisions", () => {
    expect(projectMetaKey(TEST_ORG, "web")).toEqual({ pk: `ORG#${TEST_ORG}#PROJECT#web`, sk: "META" });
    expect(projectMetaKey(TEST_ORG, "web").pk).not.toBe(projectMetaKey(OTHER_ORG, "web").pk);
  });

  it("shows a command as one line that reads back to the same words", () => {
    const command = (executable: string, ...args: string[]): ProjectCommand => ({ cwd: "repo/web", executable, args, timeoutSeconds: 60 });
    for (const original of [
      command("sh", "-c", "a 'b' c"), command("npm", "test", "--", "--run"), command("node", "-e", 'console.log("hi there")'), command("echo", ""),
      command("sh", "-c", `it's "both" & more`), command("git", "log", "--format=%H %s"),
    ]) {
      const line = formatCommandLine(original);
      const parsed = parseCommandLine(line, "repo/web", 60);
      expect([parsed.executable, ...parsed.args], line).toEqual([original.executable, ...original.args]);
    }
    expect(formatCommandLine(command("npm", "test", "--", "--run"))).toBe("npm test -- --run");
    expect(formatCommandLine(command("sh", "-c", "a 'b' c"))).toBe(`sh -c 'a '"'"'b'"'"' c'`);
  });

  it("adds the two error codes with the status a conflict has", () => {
    expect(agentXError("PROJECT_NAME_TAKEN", "x").statusCode).toBe(409);
    expect(agentXError("PROJECT_ARCHIVED", "x").statusCode).toBe(409);
  });
});

describe("effectiveProjectRole", () => {
  it("makes org owners and admins maintainers with no grant, and reads a developer grant as contributor", () => {
    expect(effectiveProjectRole({ orgRole: "owner", developerId: "d" }, undefined, false)).toBe("maintainer");
    expect(effectiveProjectRole({ orgRole: "admin", developerId: "d" }, undefined, false)).toBe("maintainer");
    expect(effectiveProjectRole({ orgRole: "member", developerId: "d" }, { role: "developer" }, false)).toBe("contributor");
    expect(effectiveProjectRole({ orgRole: "member", developerId: "d" }, undefined, true)).toBe("contributor");
    expect(effectiveProjectRole({ orgRole: "member", developerId: "d" }, undefined, false)).toBeUndefined();
    // An administrator row is no grant for a developer's access (FR-013), and an owner is a maintainer whatever the grant says.
    expect(effectiveProjectRole({ orgRole: "member", developerId: "d" }, { role: "administrator" }, false)).toBeUndefined();
    expect(effectiveProjectRole({ orgRole: "owner", developerId: "d" }, { role: "developer" }, false)).toBe("maintainer");
  });
});

describe("GET /v1/app/projects", () => {
  it("lists a project to an org owner who holds no grant on it, as a maintainer, in the shape the schema parses", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const answer = await h.dev(OMAR, "GET", "/v1/app/projects");
    expect(answer.status).toBe(200);
    expect(AppProjectsResponseSchema.parse(answer.body)).toEqual({ projects: [{
      name: "payments", status: "active", latestRevision: 1, repositories: [{ name: "demo", fullName: "example/demo", defaultBranch: "main" }],
      myRole: "maintainer", setup: { status: "unchecked" },
    }] });
  });

  it("lists every project of the org's catalog to an admin, and none of another org's", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "admin");
    seedProject(h.db, TEST_ORG, "web");
    seedProject(h.db, OTHER_ORG, "elsewhere");
    expect((await listed(h, OMAR))!.map((project) => [project.name, project.myRole])).toEqual([["payments", "maintainer"], ["web", "maintainer"]]);
  });

  it("lists to a member only the projects they hold a grant or channel access on, as a contributor", async () => {
    const h = await createSingleAnswerPlanBroker();
    seedProject(h.db, TEST_ORG, "web");
    seedProject(h.db, TEST_ORG, "ledger");
    grantProject(h.db, OMAR, "web");
    expect((await listed(h, OMAR))!.map((project) => [project.name, project.myRole])).toEqual([["web", "contributor"]]);
    // Maya is in the channel bound to payments, which lets channel members use it.
    expect((await listed(h, MAYA))!.map((project) => [project.name, project.myRole])).toEqual([["payments", "contributor"]]);
  });

  it("hides an archived project unless asked for it", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    seedProject(h.db, TEST_ORG, "old", { status: "archived", description: "Retired" });
    expect((await listed(h, OMAR))!.map((project) => project.name)).toEqual(["payments"]);
    const withArchived = await h.dev(OMAR, "GET", "/v1/app/projects?include=archived");
    expect(AppProjectsResponseSchema.parse(withArchived.body).projects.map((project) => [project.name, project.status, project.description])).toEqual([
      ["old", "archived", "Retired"], ["payments", "active", undefined],
    ]);
  });

  it("derives the setup status from the project's META on every read", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const workspaceId = randomUUID();
    // A check that started just now: one that has been PREPARING for over 50 minutes reads as failed (Task 22).
    const startedAt = new Date().toISOString();
    const check = (revision: number) => ({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId,
      setupCheck: { workspaceId, revision, startedAt, startedBy: OMAR.developerId } });
    seedProject(h.db, TEST_ORG, "web");
    const status = async () => (await listed(h, OMAR) as unknown as Array<{ name: string; setup: { status: string; checkedRevision?: number; checkedAt?: string } }>).find((project) => project.name === "web")!.setup;
    expect(await status()).toEqual({ status: "unchecked" });
    for (const [workspaceStatus, expected] of [["PREPARING", "checking"], ["READY", "ready"], ["PREPARATION_FAILED", "failed"]] as const) {
      h.db.set(check(1));
      h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, status: workspaceStatus });
      expect(await status(), workspaceStatus).toMatchObject({ status: expected, checkedRevision: 1, checkedAt: startedAt });
    }
    seedProject(h.db, TEST_ORG, "web", { revision: 2 });
    expect(await status()).toMatchObject({ status: "outdated", checkedRevision: 1 });
  });
});

describe("GET /v1/app/projects/{name}", () => {
  it("shows the setup and test commands of the latest revision, the repositories and who created the project", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    seedProject(h.db, TEST_ORG, "web", { description: "The website", branch: "trunk", repository: "Acme/web" });
    const answer = await h.dev(OMAR, "GET", "/v1/app/projects/web");
    expect(answer.status).toBe(200);
    expect(AppProjectDetailSchema.parse(answer.body)).toEqual({
      name: "web", description: "The website", status: "active", latestRevision: 1, repositories: [{ name: "web", fullName: "Acme/web", defaultBranch: "trunk" }],
      myRole: "maintainer", setup: { status: "unchecked" },
      settings: { setupCommands: ["npm ci"], testCommands: ["npm test -- --run"], devcontainer: null, allowedDomains: [] },
      // TE-4: commands nobody has checked are unproven, and with nothing proved before there is nothing to go back to.
      settingsProof: { status: "unproven", reason: "These commands have not been checked yet.", canUndo: false },
      createdAt: "2026-10-02T00:00:00.000Z", createdBy: { developerId: MAYA.developerId, name: MAYA.name },
    });
  });

  it("reads a project that predates META as active, created by unknown", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    // The admin route that registered payments wrote its META; take it away, as for a project registered before Plan 2.
    expect(h.db.get(projectMetaKey(TEST_ORG, "payments"))).toMatchObject({ entityType: "PROJECT_META", status: "active" });
    h.db.delete(projectMetaKey(TEST_ORG, "payments"));
    const answer = AppProjectDetailSchema.parse((await h.dev(OMAR, "GET", "/v1/app/projects/payments")).body);
    expect(answer).toMatchObject({ status: "active", createdBy: { developerId: "unknown" } });
  });

  it("answers 404 PROJECT_NOT_FOUND to a member with no access, and the same to a missing or malformed name, never 403", async () => {
    const h = await createSingleAnswerPlanBroker();
    seedProject(h.db, TEST_ORG, "web");
    const seen = new Set<string>();
    for (const name of ["web", "missing", "Not%20A%20Name!"]) {
      const answer = await h.dev(OMAR, "GET", `/v1/app/projects/${name}`);
      expect(answer.status, name).toBe(404);
      expect(answer.body.error, name).toMatchObject({ code: "PROJECT_NOT_FOUND" });
      seen.add(JSON.stringify(answer.body.error));
    }
    expect(seen.size).toBe(1);
    grantProject(h.db, OMAR, "web");
    expect((await h.dev(OMAR, "GET", "/v1/app/projects/web")).status).toBe(200);
  });

  it("shows a granted member the project as a contributor, and an archived project as archived", async () => {
    const h = await createSingleAnswerPlanBroker();
    seedProject(h.db, TEST_ORG, "web", { status: "archived" });
    grantProject(h.db, OMAR, "web");
    expect((await h.dev(OMAR, "GET", "/v1/app/projects/web")).body).toMatchObject({ name: "web", status: "archived", myRole: "contributor" });
  });
});

describe("two orgs with a project of the same name", () => {
  async function twoOrgs() {
    const h = await createSingleAnswerPlanBroker({
      register: false,
      orgResolver: async ({ developerId }) => (developerId === OMAR.developerId ? OTHER_ORG : TEST_ORG),
    });
    seedProject(h.db, TEST_ORG, "web", { branch: "main", description: "Maya's org" });
    seedProject(h.db, OTHER_ORG, "web", { branch: "other-branch", description: "Omar's org" });
    seedProject(h.db, OTHER_ORG, "secret", { description: "Only in the other org" });
    return h;
  }

  it("never reaches another org's project: a member's own web is returned, the other org's secret is 404", async () => {
    const h = await twoOrgs();
    grantProject(h.db, MAYA, "web");
    const own = await h.dev(MAYA, "GET", "/v1/app/projects/web");
    expect(own.body).toMatchObject({ name: "web", description: "Maya's org", repositories: [{ defaultBranch: "main" }] });
    for (const name of ["secret"]) {
      const answer = await h.dev(MAYA, "GET", `/v1/app/projects/${name}`);
      expect(answer.status).toBe(404);
      expect(answer.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
    expect((await listed(h, MAYA))!.map((project) => project.name)).toEqual(["web"]);
  });

  it("answers 404 for a name only the other org has, even to an owner, and for the same name when the caller has no grant", async () => {
    const h = await twoOrgs();
    setRole(h.db, MAYA, "owner");
    expect((await h.dev(MAYA, "GET", "/v1/app/projects/secret")).status).toBe(404);
    expect((await listed(h, MAYA))!.map((project) => project.name)).toEqual(["web"]);
    // A member of this org with no grant on its web does not get the other org's web in its place.
    const member = await twoOrgs();
    const answer = await member.dev(MAYA, "GET", "/v1/app/projects/web");
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain("other-branch");
    expect(JSON.stringify(answer.body)).not.toContain("Omar's org");
  });

  it("lists to each org's owner only that org's catalog", async () => {
    const h = await twoOrgs();
    setRole(h.db, MAYA, "owner");
    setRole(h.db, OMAR, "owner", OTHER_ORG);
    expect((await listed(h, MAYA))!.map((project) => project.name)).toEqual(["web"]);
    expect((await listed(h, OMAR))!.map((project) => project.name)).toEqual(["secret", "web"]);
    expect((await h.dev(OMAR, "GET", "/v1/app/projects/web")).body).toMatchObject({ description: "Omar's org" });
  });
});

describe("checkProjectAccess and the effective role", () => {
  const caller = (who: Developer, orgRole: OrgRole): DeveloperCaller & { orgId: OrgId } => ({
    developerId: who.developerId, sessionId: who.sessionId, amr: who.provider, name: who.name, orgId: TEST_ORG, orgRole,
    ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }),
  });
  const deps = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => ({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer as never, now: Date.now });

  it("counts an org owner or admin as granted and returns a maintainer; a grant gives a contributor; a channel gives a contributor", async () => {
    const h = await createSingleAnswerPlanBroker();
    expect(await checkProjectAccess(deps(h), caller(OMAR, "owner"), "payments")).toMatchObject({ access: "granted", role: "maintainer", revision: 1 });
    expect(await checkProjectAccess(deps(h), caller(OMAR, "admin"), "payments")).toMatchObject({ access: "granted", role: "maintainer" });
    await expect(checkProjectAccess(deps(h), caller(OMAR, "member"), "payments")).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    grantProject(h.db, OMAR, "payments");
    expect(await checkProjectAccess(deps(h), caller(OMAR, "member"), "payments")).toMatchObject({ access: "granted", role: "contributor" });
    expect(await checkProjectAccess(deps(h), caller(MAYA, "member"), "payments")).toMatchObject({ access: "channel", role: "contributor" });
  });

  it("never refuses an archived project, because the E2E rechecks of running tasks call it", async () => {
    const h = await createSingleAnswerPlanBroker();
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
    expect(await checkProjectAccess(deps(h), caller(OMAR, "owner"), "payments")).toMatchObject({ role: "maintainer" });
  });

  it("does not bypass a project that does not exist, nor one in another org", async () => {
    const h = await createSingleAnswerPlanBroker();
    seedProject(h.db, OTHER_ORG, "elsewhere");
    await expect(checkProjectAccess(deps(h), caller(OMAR, "owner"), "elsewhere")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(checkProjectAccess(deps(h), caller(OMAR, "owner"), "nothing")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("requireNewWorkAllowed", () => {
  const reader = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => ({ documentClient: h.db, tableName: "state" });

  it("refuses an archived project for every kind of new work, from META", async () => {
    const h = await createSingleAnswerPlanBroker();
    await expect(requireNewWorkAllowed(reader(h), TEST_ORG, "payments", "maintainer", "task")).resolves.toBeUndefined();
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y" });
    for (const kind of ["task", "setup_check"] as const) {
      await expect(requireNewWorkAllowed(reader(h), TEST_ORG, "payments", "maintainer", kind)).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    }
    // Another org's archived project is not this org's.
    await expect(requireNewWorkAllowed(reader(h), OTHER_ORG, "payments", "maintainer", "task")).resolves.toBeUndefined();
  });

  it("refuses a viewer a task but not a setup check, with the viewer message", async () => {
    const h = await createSingleAnswerPlanBroker();
    await expect(requireNewWorkAllowed(reader(h), TEST_ORG, "payments", "viewer", "task")).rejects.toMatchObject({
      code: "PROJECT_ACCESS_DENIED", message: expect.stringContaining("You can view `payments` but not start tasks in it. Ask a maintainer to make you a contributor.") as string,
    });
    await expect(requireNewWorkAllowed(reader(h), TEST_ORG, "payments", "viewer", "setup_check")).resolves.toBeUndefined();
    await expect(requireNewWorkAllowed(reader(h), TEST_ORG, "payments", "contributor", "task")).resolves.toBeUndefined();
  });
});

describe("starting a task", () => {
  it("accepts a start from an org owner who holds no grant (I4)", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    expect(h.db.get(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"))).toBeUndefined();
    const started = await h.dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(started.status).toBe(200);
    expect(started.body.task).toMatchObject({ status: "STARTING", project: "payments" });
    // An admin too; a plain member with no grant is still refused.
    setRole(h.db, OMAR, "admin");
    expect((await h.dev(OMAR, "POST", "/v1/dev/tasks", start())).status).toBe(200);
    setRole(h.db, OMAR, "member");
    expect((await h.dev(OMAR, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses a start in an archived project with PROJECT_ARCHIVED, records the refusal, and creates no workspace", async () => {
    const h = await createSingleAnswerPlanBroker();
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
    for (const who of [MAYA, OMAR]) {
      if (who === OMAR) setRole(h.db, OMAR, "owner");
      const refused = await h.dev(who, "POST", "/v1/dev/tasks", start());
      expect(refused.status, who.name).toBe(409);
      expect(refused.body.error, who.name).toMatchObject({ code: "PROJECT_ARCHIVED" });
    }
    expect(h.db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(0);
    expect(h.db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
    // Restoring (the status back to active) makes starts work again.
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "x", createdBy: "y" });
    expect((await h.dev(MAYA, "POST", "/v1/dev/tasks", start())).status).toBe(200);
  });

  it("starts a Slack-bound thread's new workspace only while the project is active, and keeps an existing thread's going", async () => {
    const h = await createSingleAnswerPlanBroker();
    const first = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`;
    expect((await ensureWorkspace(h.handler, first, "U0MAYA001")).status).toBe(200);
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y" });
    const second = await ensureWorkspace(h.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000200`, "U0MAYA001");
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "PROJECT_ARCHIVED" });
    // The first thread's workspace still answers.
    expect((await ensureWorkspace(h.handler, first, "U0MAYA001")).status).toBe(200);
  });
});


/** The broker module reads its environment when first imported, so it is imported after a harness has loaded it. */
const registerProjectFor = async (...args: unknown[]) =>
  (await import("../../packages/broker/src/aws/broker.js") as unknown as { registerProjectFor: (...input: unknown[]) => Promise<{ duplicate: boolean }> }).registerProjectFor(...args);

describe("the project's META item at registration", () => {
  const definition = (name: string, revision = 1) => ({
    name, revision,
    repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  });
  const actor = { orgId: TEST_ORG, ownerKey: MAYA.developerId };

  it("is written by the admin route for a project new to the org, and a later revision leaves it alone", async () => {
    const h = await createSingleAnswerPlanBroker();
    expect(h.db.get(projectMetaKey(TEST_ORG, "payments"))).toMatchObject({
      entityType: "PROJECT_META", name: "payments", status: "active", createdBy: expect.stringMatching(/^[0-9a-f]{64}$/) as string, createdAt: expect.any(String) as string,
    });
    const before = h.db.get(projectMetaKey(TEST_ORG, "payments"));
    await registerRevision(h.handler, 2, {});
    expect(h.db.get(projectMetaKey(TEST_ORG, "payments"))).toEqual(before);
  });

  it("leaves a project that predates META without one when a new revision is registered", async () => {
    const h = await createSingleAnswerPlanBroker();
    h.db.delete(projectMetaKey(TEST_ORG, "payments"));
    await registerRevision(h.handler, 2, {});
    expect(h.db.get(projectMetaKey(TEST_ORG, "payments"))).toBeUndefined();
  });

  it("is written with revision 1, the catalog entry and the creator's grant in one transaction when the name must be new", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    const sent: Array<Record<string, unknown>> = [];
    h.db.injectFault({ command: "TransactWriteCommand", match: (input) => { if (!JSON.stringify(input).includes("REV#000000000001")) return false; sent.push(input); return true; }, error: { name: "InternalServerError" } });
    await expect(registerProjectFor(h.brokerInput as never, actor, { definition: definition("web"), runtimeBinding: BINDING },
      { creatorMembership: "developer", requireNewName: true, description: "The site" })).rejects.toBeDefined();
    // Nothing was written by the failed attempt: META is part of the one transaction, not a write beside it.
    for (const key of [projectMetaKey(TEST_ORG, "web"), projectRevisionKey(TEST_ORG, "web", 1), orgProjectCatalogKey(TEST_ORG, "web"), projectMemberKey(TEST_ORG, MAYA.developerId, "web")]) {
      expect(h.db.get(key), key.sk).toBeUndefined();
    }
    const items = (sent[0]!.TransactItems as Array<Record<string, { Item?: { sk?: string }; Key?: { sk?: string } }>>).map((item) => Object.values(item)[0]!.Item?.sk ?? Object.values(item)[0]!.Key?.sk);
    expect(items).toEqual(expect.arrayContaining(["META", "REV#000000000001", "PROJECT#web"]));
    expect(sent).toHaveLength(1);

    const created = await registerProjectFor(h.brokerInput, actor, { definition: definition("web"), runtimeBinding: BINDING },
      { creatorMembership: "developer", requireNewName: true, description: "The site" });
    expect(created.duplicate).toBe(false);
    expect(h.db.get(projectMetaKey(TEST_ORG, "web"))).toMatchObject({ entityType: "PROJECT_META", name: "web", status: "active", description: "The site", createdBy: MAYA.developerId });
    expect(h.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, "web"))).toMatchObject({ entityType: "MEMBERSHIP", role: "developer", ownerKey: MAYA.developerId, grantId: expect.any(String) as string });
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 1 });
  });

  it("refuses a name that is taken, an archived one, and one whose catalog entry predates META, writing no META", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    const register = (name: string) => registerProjectFor(h.brokerInput, actor, { definition: definition(name), runtimeBinding: BINDING }, { creatorMembership: "none", requireNewName: true });
    await register("web");
    await expect(register("web")).rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
    h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "x", createdBy: "y" });
    await expect(register("web")).rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
    // A catalog entry from before Plan 2: no META anywhere.
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "old"), entityType: "PROJECT_CATALOG", name: "old", latestRevision: 1, firstRegisteredAt: "2026-01-01T00:00:00.000Z" });
    await expect(register("old")).rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
    expect(h.db.get(projectMetaKey(TEST_ORG, "old"))).toBeUndefined();
    expect(h.db.get(projectRevisionKey(TEST_ORG, "old", 1))).toBeUndefined();
  });

  // The transaction's items are the revision, META, the catalog update, then any setup rows (no grant here: creatorMembership "none").
  const cancelled = (...codes: string[]) => ({ name: "TransactionCanceledException", cancellationReasons: codes.map((Code) => ({ Code })) });
  const createWeb = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) =>
    registerProjectFor(h.brokerInput, actor, { definition: definition("web"), runtimeBinding: BINDING }, { creatorMembership: "none", requireNewName: true });

  it("answers PROJECT_NAME_TAKEN when the META or the catalog condition fails between the read and the commit", async () => {
    for (const codes of [["None", "ConditionalCheckFailed", "None"], ["None", "None", "ConditionalCheckFailed"], ["ConditionalCheckFailed", "ConditionalCheckFailed", "ConditionalCheckFailed"]]) {
      const h = await createSingleAnswerPlanBroker({ register: false });
      h.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes("REV#000000000001"), error: cancelled(...codes) });
      await expect(createWeb(h), codes.join()).rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
    }
  });

  it("finds the META item behind the creator's grant when there is one", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    h.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes("REV#000000000001"), error: cancelled("None", "None", "ConditionalCheckFailed", "None") });
    await expect(registerProjectFor(h.brokerInput as never, actor, { definition: definition("web"), runtimeBinding: BINDING }, { creatorMembership: "developer", requireNewName: true }))
      .rejects.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
  });

  it("answers a retryable conflict, not PROJECT_NAME_TAKEN, when the transaction only met another in flight", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    h.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes("REV#000000000001"), error: cancelled("None", "TransactionConflict", "None") });
    const error = await createWeb(h).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
    // Nothing was registered, so the same request works once the conflict is gone.
    await expect(createWeb(h)).resolves.toMatchObject({ duplicate: false });
  });

  it("does not call a failed setup-row condition a taken name: it is the admission's own error", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    h.db.injectFault({ command: "TransactWriteCommand", match: input => JSON.stringify(input).includes("REV#000000000001"), error: cancelled("None", "None", "None", "ConditionalCheckFailed") });
    const error = await createWeb(h).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
    expect(error).not.toMatchObject({ code: "PROJECT_NAME_TAKEN" });
  });

  it("keeps the same name in another org separate: it is not taken there", async () => {
    const h = await createSingleAnswerPlanBroker({ register: false });
    await registerProjectFor(h.brokerInput, actor, { definition: definition("web"), runtimeBinding: BINDING }, { creatorMembership: "none", requireNewName: true });
    await expect(registerProjectFor(h.brokerInput as never, { orgId: OTHER_ORG, ownerKey: OMAR.developerId }, { definition: definition("web"), runtimeBinding: BINDING }, { creatorMembership: "none", requireNewName: true })).resolves.toMatchObject({ duplicate: false });
    expect(h.db.get(projectMetaKey(OTHER_ORG, "web"))).toMatchObject({ createdBy: OMAR.developerId });
  });
});

// The task paths: acceptTask, both pull-request accepts, getAuthorizedOperation and the workspace connectors.
const requireProjectAuthority = async (...args: unknown[]) =>
  (await import("../../packages/broker/src/aws/broker.js") as unknown as { requireProjectAuthority: (...input: unknown[]) => Promise<{ kind: string; role?: string }> }).requireProjectAuthority(...args);

describe("what authorizes work on a project's task paths (requireProjectAuthority)", () => {
  const OWNER_KEY = "f".repeat(64);
  const authority = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, options?: unknown) =>
    requireProjectAuthority(h.brokerInput, TEST_ORG, OWNER_KEY, "payments", options);
  const outcome = (promise: Promise<unknown>) => promise.then((value) => value as { kind: string; role?: string }, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));

  it("returns a grant as it always has, whatever the org role", async () => {
    const h = await createSingleAnswerPlanBroker();
    h.db.set({ ...projectMemberKey(TEST_ORG, OWNER_KEY, "payments"), entityType: "MEMBERSHIP", ownerKey: OWNER_KEY, projectName: "payments", role: "developer", grantId: randomUUID() });
    expect(await authority(h)).toMatchObject({ kind: "grant", membership: { role: "developer" } });
  });

  it("accepts a live org owner or admin with no grant, reading the role afresh each time, and refuses them once demoted", async () => {
    const h = await createSingleAnswerPlanBroker();
    for (const role of ["owner", "admin"] as const) {
      setRole(h.db, { developerId: OWNER_KEY } as Developer, role);
      expect(await authority(h), role).toEqual({ kind: "org-role", role });
    }
    setRole(h.db, { developerId: OWNER_KEY } as Developer, "member");
    expect(await outcome(authority(h))).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: project not found" });
  });

  it("reads the task creator's record when the workspace runs a developer task, and not the workspace owner's", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    expect(await authority(h, { taskCreator: async () => OMAR.developerId })).toEqual({ kind: "org-role", role: "owner" });
    setRole(h.db, OMAR, "member");
    expect(await outcome(authority(h, { taskCreator: async () => OMAR.developerId }))).toMatchObject({ code: "NOT_FOUND" });
  });

  for (const [label, extra, expected] of [
    ["a private install", {}, { code: "NOT_FOUND", message: "NOT_FOUND: project not found" }],
    ["a legacy install", { environmentName: undefined }, { code: "NOT_FOUND", message: "NOT_FOUND: project not found" }],
    ["a cloud install, for anyone who is not a developer task's creator", { cloud: true }, { code: "NOT_FOUND", message: "NOT_FOUND: project not found" }],
  ] as const) {
    it(`answers NOT_FOUND "project not found" for no grant and no org member record, on ${label}`, async () => {
      const h = await createSingleAnswerPlanBroker({ brokerExtra: extra });
      expect(await outcome(authority(h))).toEqual(expected);
    });
  }

  it("says the task's creator is no longer a member only on a cloud install, when a developer task's creator has no member record", async () => {
    const cloud = await createSingleAnswerPlanBroker({ brokerExtra: { cloud: true } });
    cloud.db.delete(orgMemberKeyOf(TEST_ORG, OMAR.developerId));
    expect(await outcome(authority(cloud, { taskCreator: async () => OMAR.developerId }))).toEqual({ code: "TASK_ACCESS_DENIED", message: "TASK_ACCESS_DENIED: you are no longer a member of this organization" });
    for (const brokerExtra of [{}, { environmentName: undefined }]) {
      const other = await createSingleAnswerPlanBroker({ brokerExtra });
      other.db.delete(orgMemberKeyOf(TEST_ORG, OMAR.developerId));
      expect(await outcome(authority(other, { taskCreator: async () => OMAR.developerId }))).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND: project not found" });
    }
  });

  it("does not take another org's owner role as authority here", async () => {
    const h = await createSingleAnswerPlanBroker();
    seedMembership(h.db, OWNER_KEY, { orgId: OTHER_ORG, role: "owner" });
    expect(await outcome(authority(h))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers a Slack thread's workspace with no grant NOT_FOUND on every service path, as before", async () => {
    for (const brokerExtra of [{}, { environmentName: undefined }]) {
      const h = await createSingleAnswerPlanBroker({ brokerExtra });
      const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000300`;
      const prepared = await ensureWorkspace(h.handler, thread, "U0MAYA001");
      expect(prepared.status).toBe(200);
      const workspaceId = String(prepared.body.workspaceId);
      for (const grant of h.db.find((item) => item.entityType === "MEMBERSHIP" && !String(item.pk).includes(MAYA.developerId))) h.db.delete(grant as { pk: string; sk: string });
      const operationId = randomUUID();
      for (const [method, path, body] of [
        ["GET", `/v1/service/workspaces/${workspaceId}/operations/${operationId}`, undefined],
        ["POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId: randomUUID(), prompt: "more" }],
        ["POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, { requestId: randomUUID(), repository: "demo", title: "A change" }],
        ["POST", `/v1/service/workspaces/${workspaceId}/pull-request-actions`, { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "close" }],
        ["GET", `/v1/service/workspaces/${workspaceId}/connectors/github/tools`, undefined],
      ] as const) {
        const answer = await serviceCall(h.handler, thread, "U0MAYA001", method, path, body);
        expect(answer.status, path).toBe(404);
        expect(answer.body.error, path).toMatchObject({ code: "NOT_FOUND", message: "project not found" });
      }
    }
  });

  it("is what every task path calls: none of the five still asks requireMembership", () => {
    const source = readBrokerSource();
    for (const name of ["acceptTask", "acceptPullRequest", "acceptPullRequestLifecycle", "getAuthorizedOperation", "authorizeWorkspaceConnectors"]) {
      const at = source.indexOf(`async function ${name}(`);
      expect(at, name).toBeGreaterThan(-1);
      // (a function another module of the split calls is exported: `export async function`)
      const next = source.slice(at + 10).search(/\n(?:export )?async function /);
      const body = next === -1 ? source.slice(at) : source.slice(at, at + 10 + next);
      expect(body, name).toContain("requireProjectAuthority(");
      expect(body, name).not.toContain("requireMembership(");
    }
  });
});

describe("an org owner's task keeps going without a grant (I4)", () => {
  const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
  const operations = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

  /** A Quick workflow task of `maker`, taken to the point where its IMPLEMENT step is running. */
  async function implementing(h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, maker: Developer) {
    const started = await h.dev(maker, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; ownerKey: string; workflow: Record<string, unknown> };
    const workspaceId = record.workspaceId;
    h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Fix retry handling.\n";
    await finishPlanningWithMarkdown(h, workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
    const revision = (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
    const approved = await h.dev(maker, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const implementation = operations(h, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const passing = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
    const finishImplementation = () => h.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passing } });
    return { taskId, workspaceId, ownerKey: record.ownerKey, finishImplementation };
  }
  /** The task owner's key holds the grant that preparation wrote; an owner with no grant at all is that grant gone. */
  const withoutGrant = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, ownerKey: string) => h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));

  it("dispatches the owner's task to REVIEW with no grant, and stops at the next dispatch once they are a plain member", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const first = await implementing(h, OMAR);
    withoutGrant(h, first.ownerKey);
    await first.finishImplementation();
    expect(operations(h, first.workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toHaveLength(1);

    const second = await implementing(h, OMAR);
    withoutGrant(h, second.ownerKey);
    setRole(h.db, OMAR, "member");
    await second.finishImplementation();
    expect(operations(h, second.workspaceId).filter((operation) => operation.workflowMode === "REVIEW")).toHaveLength(0);
  });

  it("accepts a continue, a pull request and a pull request action of the owner's idle task with no grant", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const started = await h.dev(OMAR, "POST", "/v1/dev/tasks", start());
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as unknown as DeveloperTaskRecord;
    const active = () => String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    h.db.delete(projectMemberKey(TEST_ORG, task.ownerKey, "payments"));
    const identity = developerTaskIdentity(task, TEST_ORG);
    const settle = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code?: string; message?: string });

    const continued = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    for (const refusal of [
      await settle(h.actions.acceptPullRequest(identity, task.workspaceId, { requestId: randomUUID(), repository: "demo", title: "A change", draft: true }, () => [])),
      await settle(h.actions.acceptPullRequestUpdate(identity, task.workspaceId, { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "append" } as never, () => [], { candidateDigest: "a".repeat(64), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40), expectedHeadCommit: "d".repeat(40) })),
    ]) {
      expect(refusal?.message ?? "", "pull request path").not.toContain("project not found");
    }

    setRole(h.db, OMAR, "member");
    const refused = await h.dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "again" });
    // S2 (this replaces the old 404 "project not found"): an owner demoted to member with no grant is refused up front, by the send-back's project access rule.
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("says the creator is no longer a member, on a cloud install only, when their member record is gone", async () => {
    for (const [cloud, expected] of [[true, { code: "TASK_ACCESS_DENIED", message: "TASK_ACCESS_DENIED: you are no longer a member of this organization" }], [false, { code: "NOT_FOUND", message: "NOT_FOUND: project not found" }]] as const) {
      const h = await createSingleAnswerPlanBroker({ ...(cloud ? { brokerExtra: { cloud: true } } : {}) });
      setRole(h.db, OMAR, "owner");
      const started = await h.dev(OMAR, "POST", "/v1/dev/tasks", start());
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const task = h.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as unknown as DeveloperTaskRecord;
      h.db.delete(projectMemberKey(TEST_ORG, task.ownerKey, "payments"));
      // Gone from the org without the removal's tombstone, so R60's check (which runs first at the call sites) lets it through to this one.
      h.db.delete(orgMemberKeyOf(TEST_ORG, OMAR.developerId));
      const error = await h.actions.acceptTask(developerTaskIdentity(task, TEST_ORG), task.workspaceId, { requestId: randomUUID(), conversationId: task.conversationId, prompt: "more" }, () => [])
        .then(() => undefined, (caught: unknown) => caught as { code: string; message: string });
      expect(error, String(cloud)).toMatchObject(expected);
    }
  });
});

describe("a required-E2E round of an org owner's task (finding 5, I4)", () => {
  const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
  type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
  const operations = (h: Harness, workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const sweep = (h: Harness) => h.handler({ source: "agentx.workflow-dispatch-recovery" });

  /** `maker`'s Quick workflow task, past implementation, waiting in VERIFY on a required E2E round whose CHECKS dispatch is due. */
  async function waitingForRound(h: Harness, maker: Developer) {
    const started = await h.dev(maker, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; ownerKey: string; workflow: Record<string, unknown> };
    const workspaceId = record.workspaceId;
    h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
    // The creator's sign-in record, as the E2E recheck reads it (the harness's carries no entity type).
    h.db.set({ ...(h.db.get(`DEVELOPER#${maker.developerId}`, "META") as Record<string, unknown>), entityType: "DEVELOPER" });
    await h.finish(workspaceId, String(operations(h, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Fix retry handling.\n";
    await finishPlanningWithMarkdown(h, workspaceId, String(operations(h, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
    const revision = (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number } }).workflow.revision;
    await h.dev(maker, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    const implementation = operations(h, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const passing = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
    await h.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passing } });
    // The round is due: the task waits in VERIFY on a required E2E, its workspace idle, with the CHECKS dispatch row not yet warmed.
    const taskRow = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: { revision: number } & Record<string, unknown> };
    const waiting = { ...taskRow.workflow, stage: "VERIFY", state: "WAITING",
      e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } };
    h.db.set({ ...taskRow, workflow: waiting });
    const workspace = h.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
    const { activeOperationId: _active, ...idle } = workspace;
    void _active;
    h.db.set({ ...idle, status: "READY" });
    for (const operation of operations(h, workspaceId).filter((item) => item.workflowMode === "REVIEW")) h.db.set({ ...operation, status: "SUCCEEDED" });
    for (const row of h.db.find((item) => item.pk === "WORKFLOW_DISPATCH")) h.db.delete(row as { pk: string; sk: string });
    const now = new Date().toISOString();
    const dispatchSk = `${taskId}#${waiting.revision}`;
    h.db.set({ pk: "WORKFLOW_DISPATCH", sk: dispatchSk, entityType: "WORKFLOW_DISPATCH", taskId, workflowRevision: waiting.revision, kind: "CHECKS", candidateDigest: candidate.digest,
      createdAt: now, attempts: 0, nextAttemptAt: now, dispatchDuePk: "WORKFLOW_DISPATCH", dispatchDueSk: `${now}#${dispatchSk}`, indexExpiresAt: Math.floor(Date.now() / 1_000) + 86_400 });
    return { taskId, workspaceId, ownerKey: record.ownerKey, candidate };
  }
  const readiness = (h: Harness, workspaceId: string) => operations(h, workspaceId).filter((item) => item.workflowE2EReadiness !== undefined);

  it("passes the creator-authority recheck for an org owner with no grant, on the live member record", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const { workspaceId, ownerKey } = await waitingForRound(h, OMAR);
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
    await sweep(h);
    expect(readiness(h, workspaceId)).toHaveLength(1);
  });

  it("fails the round's authority check once the owner is demoted to member, and starts no warm-up", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const { workspaceId, ownerKey } = await waitingForRound(h, OMAR);
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
    setRole(h.db, OMAR, "member");
    await sweep(h);
    expect(readiness(h, workspaceId)).toHaveLength(0);
    // S2 (this replaces parking the row): the step is not started, the row goes (nothing retries it), and the task is blocked with a plain reason; the owner's Retry, once they have access again, is the way on.
    expect(h.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
    const blocked = h.db.find((item) => item.entityType === "DEVELOPER_TASK")[0] as { workflow: { state: string; blockReason?: string } };
    expect(blocked.workflow).toMatchObject({ state: "BLOCKED" });
    expect(blocked.workflow.blockReason).toContain("Rovara didn't start");
  });

  it("records an org-role proof naming the live role, which a demotion removes and a later grant replaces with a direct-membership proof", async () => {
    const h = await createSingleAnswerPlanBroker();
    const { requireWorkflowE2ECreatorAuthority } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      requireWorkflowE2ECreatorAuthority: (dependencies: unknown, task: unknown) => Promise<Record<string, unknown>>;
    };
    setRole(h.db, OMAR, "owner");
    const { taskId, ownerKey } = await waitingForRound(h, OMAR);
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
    const task = () => h.db.get(`DEVTASK#${taskId}`, "META");
    const member = h.db.get(orgMemberKeyOf(TEST_ORG, OMAR.developerId)) as { joinedAt: string };
    const proof = await requireWorkflowE2ECreatorAuthority(h.brokerInput, task());
    expect(proof).toEqual({ kind: "org-role", developerId: OMAR.developerId, project: "payments", orgId: TEST_ORG, role: "owner", memberUpdatedAt: member.joinedAt });

    // The proof is read fresh on every round: admin is another proof, a plain member has none and fails with the existing rejection.
    setRole(h.db, OMAR, "admin");
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).toMatchObject({ kind: "org-role", role: "admin" });
    setRole(h.db, OMAR, "member");
    await expect(requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).rejects.toMatchObject({
      code: "TASK_ACCESS_DENIED", message: expect.stringContaining("the original creator no longer has current access to this task's project") as string,
    });
    // A grant makes it the direct-membership proof again, owner or not.
    grantProject(h.db, OMAR, "payments");
    h.db.set({ ...(h.db.get(projectMemberKey(TEST_ORG, OMAR.developerId, "payments")) as Record<string, unknown>), grantId: randomUUID() });
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).toMatchObject({ kind: "direct-membership", role: "developer" });
  });

  it("takes the creator-authority proof from the person who took the task over, never the creator's (Plan 5 Task 12a)", async () => {
    const h = await createSingleAnswerPlanBroker();
    const { requireWorkflowE2ECreatorAuthority } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      requireWorkflowE2ECreatorAuthority: (dependencies: unknown, task: unknown) => Promise<Record<string, unknown>>;
    };
    setRole(h.db, OMAR, "owner");
    const { taskId, ownerKey } = await waitingForRound(h, OMAR);
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
    const task = () => h.db.get(`DEVTASK#${taskId}`, "META")!;
    // Before the take-over the creator, an org owner, is the proof.
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).toMatchObject({ kind: "org-role", developerId: OMAR.developerId, role: "owner" });
    // Maya takes the task over (she has signed in, so her record exists): the proof is hers (a plain member with a grant), and the owner's own role no longer carries it.
    h.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", entityType: "DEVELOPER", developerId: MAYA.developerId, provider: "slack", slackUserId: MAYA.slackUserId, displayName: MAYA.name, revoked: false, firstSignInAt: "x", lastSignInAt: "x" });
    h.db.set({ ...task(), currentOwner: { developerId: MAYA.developerId, name: MAYA.name, provider: "slack", slackUserId: MAYA.slackUserId, since: "2026-10-22T11:00:00.000Z" } });
    grantProject(h.db, MAYA, "payments");
    h.db.set({ ...(h.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, "payments")) as Record<string, unknown>), grantId: randomUUID() });
    expect(await requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).toMatchObject({ kind: "direct-membership", developerId: MAYA.developerId, role: "developer" });
    // Demoted to a project viewer, she can no longer run the checks, though the creator is still an org owner.
    h.db.set({ ...(h.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, "payments")) as Record<string, unknown>), role: "viewer", projectRole: "viewer" });
    await expect(requireWorkflowE2ECreatorAuthority(h.brokerInput, task())).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("does not start the round when the project is archived while it is pending (S2: this replaces I4, where it kept going)", async () => {
    const h = await createSingleAnswerPlanBroker();
    setRole(h.db, OMAR, "owner");
    const { workspaceId, ownerKey } = await waitingForRound(h, OMAR);
    h.db.delete(projectMemberKey(TEST_ORG, OMAR.developerId, "payments"));
    h.db.delete(projectMemberKey(TEST_ORG, ownerKey, "payments"));
    h.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
    await sweep(h);
    expect(readiness(h, workspaceId)).toHaveLength(0);
    expect(h.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
  });
});

describe("the org-role proof at commit", () => {
  it("holds only while the member record still names the role and time the proof saw", async () => {
    const h = await createSingleAnswerPlanBroker();
    const { orgRoleAuthorityCheck } = await import("../../packages/broker/src/aws/broker.js") as unknown as {
      orgRoleAuthorityCheck: (table: string, proof: Record<string, unknown>) => Record<string, unknown>;
    };
    const { OrgStore } = await import("../../packages/broker/src/org/store.js");
    const store = new OrgStore({ documentClient: h.db, tableName: "state", now: () => Date.now() });
    const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
    setRole(h.db, OMAR, "owner");
    // A second owner, so the first can be demoted.
    setRole(h.db, MAYA, "owner");
    const joinedAt = (h.db.get(orgMemberKeyOf(TEST_ORG, OMAR.developerId)) as { joinedAt: string }).joinedAt;
    const proof = { developerId: OMAR.developerId, orgId: TEST_ORG, role: "owner", memberUpdatedAt: joinedAt };
    const commits = () => h.db.send(new TransactWriteCommand({ TransactItems: [orgRoleAuthorityCheck("state", proof) as never] })).then(() => true, () => false);
    expect(await commits()).toBe(true);
    await store.setRole({ orgId: TEST_ORG, developerId: OMAR.developerId, role: "member" });
    expect(await commits()).toBe(false);
    // Promoted back, the member record carries a new role time, so the earlier proof does not come back to life.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.setRole({ orgId: TEST_ORG, developerId: OMAR.developerId, role: "owner" });
    expect(await commits()).toBe(false);
    const { memberUpdatedAt } = await (async () => {
      const record = h.db.get(orgMemberKeyOf(TEST_ORG, OMAR.developerId)) as { roleUpdatedAt: string };
      return { memberUpdatedAt: record.roleUpdatedAt };
    })();
    expect(memberUpdatedAt).toEqual(expect.any(String) as string);
    expect(await h.db.send(new TransactWriteCommand({ TransactItems: [orgRoleAuthorityCheck("state", { ...proof, memberUpdatedAt }) as never] })).then(() => true, () => false)).toBe(true);
  });
});
