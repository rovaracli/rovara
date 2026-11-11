// Plan 2, Task 22: the setup check. A maintainer asks for `POST /v1/app/projects/{name}/setup-check`; the broker prepares a fresh workspace of the
// caller's at the project's latest revision (the setup commands, then the test commands), and the project's setup status follows that workspace:
// unchecked, checking, ready, failed (with the failing step) or outdated (a newer revision exists). It passes the admissions a task start passes
// except the model budget, and it is replayable by request id in the same transaction that starts it.
import { fakeModelAccess } from "../support/fake-model-access.js";
import { orgSettingsKey } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppProjectDetailSchema, machineTimeMonthKey, orgMetaKey, projectMemberKey, projectMetaKey, projectRevisionKey, type OrgId, type OrgRole, type ProjectRole } from "../../packages/contracts/src/index.js";
import { sweepStuckSetupChecks } from "../../packages/broker/src/aws/setup-check-close.js";
import { FAILED_REASON_MAX, failedStepOf, setupCheckRecordKey, setupCheckWatchKey } from "../../packages/broker/src/org/project-setup-check.js";
import { MAYA, OMAR, createDeveloperTaskBroker, registerRevision, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

const ORG_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const NAME = "payments";
const PATH = `/v1/app/projects/${NAME}/setup-check`;
const PLANTED = "xoxb-2222222222-planted-secret";
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const command = (executable: string, args: string[]) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });

/** The project the way a real one is: a setup command and a test command at revision 1. */
function withCommands(h: Harness): void {
  const key = projectRevisionKey(TEST_ORG, NAME, 1);
  const item = h.db.get(key) as { definition: Record<string, unknown> };
  h.db.set({ ...item, ...key, definition: { ...item.definition, setup: [command("npm", ["ci"])], readiness: [command("npm", ["test"])] } });
}

async function harness(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}): Promise<Harness> {
  const h = await createDeveloperTaskBroker(options);
  withCommands(h);
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return h;
}

/** A signed-in person with the given org role and (optionally) a project grant. */
async function addPerson(h: Harness, who: Developer, orgRole: OrgRole, grant?: ProjectRole): Promise<void> {
  await h.orgOf(who);
  h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: orgRole });
  if (grant !== undefined) {
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: NAME, grantId: randomUUID(),
      role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
  }
}

const check = (h: Harness, who: Developer, requestId: string = randomUUID()) => h.dev(who, "POST", PATH, { requestId });
const setupOf = async (h: Harness, who: Developer = OMAR) => (AppProjectDetailSchema.parse((await h.dev(who, "GET", `/v1/app/projects/${NAME}`)).body)).setup;
const metaOf = (h: Harness) => h.db.get(projectMetaKey(TEST_ORG, NAME)) as { setupCheck?: { workspaceId: string; revision: number; startedAt: string; startedBy: string }; status: string } | undefined;
const workspaces = (h: Harness) => h.db.find((item) => item.entityType === "WORKSPACE");
const requestItems = (h: Harness) => h.db.find((item) => item.entityType === "PROJECT_SETUP_CHECK_REQUEST");
const prepareOf = (h: Harness, workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
const rejection = (response: { status: number; body: Record<string, unknown> }) => ({ status: response.status, code: (response.body.error as { code?: string } | undefined)?.code, message: (response.body.error as { message?: string } | undefined)?.message });

/** Starts a check and returns the check's workspace and prepare operation. */
async function started(h: Harness, who: Developer = OMAR) {
  const response = await check(h, who);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const workspaceId = metaOf(h)!.setupCheck!.workspaceId;
  return { workspaceId, operationId: prepareOf(h, workspaceId), response };
}

describe("POST /v1/app/projects/{name}/setup-check: the status", () => {
  it("moves from unchecked to checking, then to ready once the workspace is READY", async () => {
    const h = await harness();
    expect(await setupOf(h)).toEqual({ status: "unchecked" });
    const { workspaceId, operationId, response } = await started(h);
    const answered = AppProjectDetailSchema.parse(response.body.project);
    expect(answered.setup).toMatchObject({ status: "checking", checkedRevision: 1 });
    expect(metaOf(h)!.setupCheck).toMatchObject({ workspaceId, revision: 1, startedBy: OMAR.developerId });
    expect(await setupOf(h)).toMatchObject({ status: "checking", checkedRevision: 1 });
    await h.finish(workspaceId, operationId, "SUCCEEDED");
    expect(await setupOf(h)).toMatchObject({ status: "ready", checkedRevision: 1 });
    expect(await setupOf(h)).not.toHaveProperty("failedStep");
    // The list says the same.
    const listed = (await h.dev(OMAR, "GET", "/v1/app/projects")).body.projects as Array<{ name: string; setup: { status: string } }>;
    expect(listed.find((project) => project.name === NAME)!.setup.status).toBe("ready");
  });

  it("prepares a workspace that is the caller's own, in their org, at the latest revision, and starts no task", async () => {
    const h = await harness();
    const { workspaceId } = await started(h);
    expect(workspaces(h)).toHaveLength(1);
    expect(h.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ orgId: TEST_ORG, projectName: NAME, projectRevision: 1, status: "PREPARING" });
    expect(h.db.find((item) => item.entityType === "OUTBOX")).toHaveLength(1);
    expect(h.db.find((item) => item.entityType === "DEVELOPER_TASK")).toEqual([]);
  });

  it("is failed with a step that starts 'test: ' when a readiness command fails", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: "readiness check 0 (npm test in repo/demo) exited 1\nLast lines:\n2 failing" });
    const setup = await setupOf(h);
    expect(setup.status).toBe("failed");
    expect(setup.failedStep).toMatch(/^test: npm test/);
    expect(setup.failedStep).toContain("exited 1");
    expect(setup.failedStep).not.toContain("\n");
  });

  it("carries an ErrorRef (Fix with agent) only while the check is failed or outdated, with fixed codes and no failure text (live interaction F1)", async () => {
    const h = await harness();
    expect(await setupOf(h)).not.toHaveProperty("errorRef");
    const { workspaceId, operationId } = await started(h);
    expect(await setupOf(h)).not.toHaveProperty("errorRef");
    await h.finish(workspaceId, operationId, "FAILED", { error: `setup step 0 (npm ci in repo/demo) exited 1\nLast lines:\nnpm ERR! ${PLANTED}` });
    const failed = await setupOf(h);
    expect(failed.errorRef).toMatchObject({ kind: "setup_check", code: "SETUP_CHECK_FAILED", subject: { project: NAME }, at: failed.checkedAt });
    expect(JSON.stringify(failed.errorRef)).not.toContain(PLANTED);
    expect(JSON.stringify(failed.errorRef)).not.toContain("npm");
    // The list says the same.
    const listed = (await h.dev(OMAR, "GET", "/v1/app/projects")).body.projects as Array<{ name: string; setup: { errorRef?: { code: string } } }>;
    expect(listed.find((project) => project.name === NAME)!.setup.errorRef?.code).toBe("SETUP_CHECK_FAILED");
    // A new check starts: the failure is no longer shown.
    await check(h, OMAR);
    expect(await setupOf(h)).not.toHaveProperty("errorRef");
  });

  it("is failed with a step that starts 'setup: ' and names the command when a setup command fails", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: "setup step 0 (npm ci in repo/demo) exited 1\nLast lines:\nnpm ERR! boom" });
    expect((await setupOf(h)).failedStep).toMatch(/^setup: npm ci/);
  });

  it("keeps the first 300 characters of the reason, redacted, on one line, with no control characters", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    const error = `setup step 0 (npm ci in repo/demo) exited 1\n\u001b[31m${PLANTED}\u001b[0m ‮evil‬ ${"y".repeat(2_000)}`;
    await h.finish(workspaceId, operationId, "FAILED", { error });
    const step = (await setupOf(h)).failedStep!;
    expect(step.startsWith("setup: npm ci - ")).toBe(true);
    expect([...step.slice("setup: npm ci - ".length)].length).toBeLessThanOrEqual(300);
    expect(step).not.toContain(PLANTED);
    expect(step).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("keeps the whole failing step to 300 characters when the command is long and the error is 700: the command stays named, the reason is cut with an ellipsis", async () => {
    const h = await harness();
    const args = ["run", "test:integration", "--workspace=packages/payments-service", "--reporter=verbose", "--bail", "--coverage", "--runInBand", "--testTimeout=60000", "--detectOpenHandles"];
    const key = projectRevisionKey(TEST_ORG, NAME, 1);
    const item = h.db.get(key) as { definition: Record<string, unknown> };
    h.db.set({ ...item, ...key, definition: { ...item.definition, readiness: [command("npm", args)] } });
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: `readiness check 0 (npm test in repo/demo) exited 1\nLast lines:\n${"z".repeat(700)}` });
    const step = (await setupOf(h)).failedStep!;
    expect(step.length).toBeLessThanOrEqual(300);
    expect(step).toMatch(/^test: npm run test:integration --workspace=packages\/payments-service /);
    expect(step.endsWith("…")).toBe(true);
  });

  it("never returns more than the cap from failedStepOf, for a named step, an unnamed one and a long command", () => {
    const definition = { setup: [command("make", ["x".repeat(400)])], readiness: [] };
    for (const error of ["setup step 0 (make in repo/demo) exited 1 " + "e".repeat(700), "readiness check 7 (nope) " + "e".repeat(700), "clone failed " + "e".repeat(700), "setup step 0 (make in repo/demo) exited 1", ""]) {
      const step = failedStepOf(error, definition);
      expect(step.length).toBeLessThanOrEqual(FAILED_REASON_MAX);
    }
    expect(failedStepOf("setup step 0 (make in repo/demo) " + "e".repeat(700), definition)).toMatch(/^setup: make x{100,} - .*…$/u);
    expect(failedStepOf("clone failed " + "e".repeat(700), definition)).toHaveLength(300);
    expect(failedStepOf("clone failed", definition)).toBe("setup: clone failed");
  });

  it("redacts again what it reads, in case an operation was stored unredacted", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: "setup step 0 (npm ci in repo/demo) exited 1" });
    const key = { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` };
    h.db.set({ ...(h.db.get(key) as Record<string, unknown>), error: `setup step 0 (npm ci in repo/demo) exited 1 ${PLANTED}` });
    const step = (await setupOf(h)).failedStep!;
    expect(step).toMatch(/^setup: npm ci - /);
    expect(step).not.toContain(PLANTED);
  });

  it("names only the stage when the failure is no command (a clone that failed)", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: "repository default branch does not exist: main" });
    expect((await setupOf(h)).failedStep).toBe("setup: repository default branch does not exist: main");
  });

  it("turns ready into outdated when a new settings revision is registered", async () => {
    const h = await harness();
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "SUCCEEDED");
    expect((await setupOf(h)).status).toBe("ready");
    await registerRevision(h.handler, 2, {});
    expect(await setupOf(h)).toMatchObject({ status: "outdated", checkedRevision: 1 });
  });

  it("reads a check that never finished, after 50 minutes, as failed, and lets a new check start", async () => {
    const h = await harness();
    const { workspaceId } = await started(h);
    const meta = metaOf(h)!;
    h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>), setupCheck: { ...meta.setupCheck!, startedAt: new Date(Date.now() - 51 * 60_000).toISOString() } });
    expect(await setupOf(h)).toMatchObject({ status: "failed", failedStep: "setup: did not finish within 50 minutes" });
    const again = await check(h, OMAR);
    expect(again.status).toBe(202);
    expect(metaOf(h)!.setupCheck!.workspaceId).not.toBe(workspaceId);
  });

  it("starts a new check after a failed one, and after a ready one", async () => {
    const h = await harness();
    const first = await started(h);
    await h.finish(first.workspaceId, first.operationId, "FAILED", { error: "setup step 0 (npm ci in repo/demo) exited 1" });
    const second = await started(h);
    expect(second.workspaceId).not.toBe(first.workspaceId);
    await h.finish(second.workspaceId, second.operationId, "SUCCEEDED");
    expect((await setupOf(h)).status).toBe("ready");
    const third = await started(h);
    expect(third.workspaceId).not.toBe(second.workspaceId);
  });
});

describe("POST /v1/app/projects/{name}/setup-check: who and when", () => {
  it("answers 403 to a viewer, writes nothing, and the same to a contributor (only maintainers check setup)", async () => {
    const h = await harness();
    await addPerson(h, KIT, "member", "viewer");
    expect(rejection(await check(h, KIT))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
    h.db.set({ ...(h.db.get(projectMemberKey(TEST_ORG, KIT.developerId, NAME)) as Record<string, unknown>), role: "developer", projectRole: "contributor" });
    expect(rejection(await check(h, KIT))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(workspaces(h)).toEqual([]);
  });

  it("refuses a viewer grant even when the project's channel would make the person a contributor", async () => {
    const h = await harness();
    await addPerson(h, MAYA, "member", "viewer");
    // Maya is in the channel bound to payments; an explicit viewer grant wins over it.
    expect(rejection(await check(h, MAYA))).toMatchObject({ status: 403 });
    expect(workspaces(h)).toEqual([]);
  });

  it("lets an org owner with no grant run it, and a project maintainer with a grant", async () => {
    const h = await harness();
    expect((await check(h, OMAR)).status).toBe(202);
    const other = await harness();
    await addPerson(other, KIT, "member", "maintainer");
    expect((await check(other, KIT)).status).toBe(202);
    expect(other.db.get(`WORKSPACE#${metaOf(other)!.setupCheck!.workspaceId}`, "META")).toMatchObject({ orgId: TEST_ORG });
  });

  it("answers 404 PROJECT_NOT_FOUND for a person with no access, a missing project and another org's project, and writes nothing", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG) });
    withCommands(h);
    seedMembership(h.db, OMAR.developerId, { orgId: ORG_B, role: "owner" });
    // Omar owns another org that has no project of this name.
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(rejection(await h.dev(OMAR, "POST", "/v1/app/projects/nothing-here/setup-check", { requestId: randomUUID() }))).toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    // A member of the project's own org with no grant and no channel access reads the same.
    await addPerson(h, KIT, "member");
    expect(rejection(await check(h, KIT))).toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
  });

  it("refuses a check on an archived project with PROJECT_ARCHIVED and writes nothing", async () => {
    const h = await harness();
    h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>), status: "archived", archivedAt: "2026-10-03T00:00:00.000Z", archivedBy: OMAR.developerId });
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 409, code: "PROJECT_ARCHIVED" });
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
  });

  it("refuses with PROJECT_ARCHIVED, and starts nothing, when the project is archived between the checks and the write", async () => {
    const h = await harness();
    const send = h.db.send.bind(h.db);
    let archived = false;
    h.db.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand" && !archived) {
        archived = true;
        h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>), status: "archived", archivedAt: "x", archivedBy: "y" });
      }
      return send(command as never);
    });
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 409, code: "PROJECT_ARCHIVED" });
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
  });

  it("answers 409 WORKSPACE_BUSY to a second check while one is checking, and starts nothing", async () => {
    const h = await harness();
    await started(h);
    expect(rejection(await check(h, OMAR))).toEqual({ status: 409, code: "WORKSPACE_BUSY", message: "a setup check is already running for this project" });
    expect(workspaces(h)).toHaveLength(1);
    expect(requestItems(h)).toHaveLength(1);
  });

  it("lets only one of two checks that start together win; the other is 409", async () => {
    const h = await harness();
    const answers = await Promise.all([check(h, OMAR), check(h, OMAR)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    expect(workspaces(h)).toHaveLength(1);
    expect(requestItems(h)).toHaveLength(1);
  });

  it("validates the body: a request id is required and nothing else is accepted", async () => {
    const h = await harness();
    for (const body of [{}, { requestId: "nope" }, { requestId: randomUUID(), project: "x" }]) {
      expect((await h.dev(OMAR, "POST", PATH, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(workspaces(h)).toEqual([]);
  });
});

describe("POST /v1/app/projects/{name}/setup-check: admissions", () => {
  async function cloud(plan: "trial" | "team", extra: Record<string, unknown> = {}) {
    const h = await harness({ brokerExtra: { cloud: true } });
    h.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "acme", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "dev1", plan, ...extra });
    return h;
  }

  it("refuses a locked trial org with TRIAL_LOCKED and writes no workspace", async () => {
    const h = await cloud("trial");
    const mark = h.db.commandNames().length;
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 403, code: "TRIAL_LOCKED", message: "Connect GitHub to start your free trial." });
    expect(h.db.commandNames().slice(mark)).not.toContain("TransactWriteCommand");
    expect(workspaces(h)).toEqual([]);
    expect(h.db.find((item) => item.entityType === "OPERATION" || item.entityType === "OUTBOX")).toEqual([]);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
    expect(requestItems(h)).toEqual([]);
  });

  it("refuses an org whose month of machine time is used up with MACHINE_TIME_EXCEEDED", async () => {
    const h = await cloud("trial", { trialUnlockedAt: 1 });
    h.db.set({ ...machineTimeMonthKey(TEST_ORG, new Date().toISOString().slice(0, 7)), entityType: "MACHINE_TIME", seconds: 20 * 3600 });
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 402, code: "MACHINE_TIME_EXCEEDED" });
    expect(workspaces(h)).toEqual([]);
  });

  it("refuses with GITHUB_NOT_CONNECTED, and writes nothing, when the org's GitHub connection no longer reaches a repository", async () => {
    const installationForRepository = vi.fn(async () => undefined);
    const h = await harness({ brokerExtra: { cloud: true, githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), installationForRepository } } });
    h.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "acme", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "dev1", plan: "team" });
    expect(rejection(await check(h, OMAR))).toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(installationForRepository).toHaveBeenCalled();
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
  });

  it("admits an unlocked trial org", async () => {
    const h = await cloud("trial", { trialUnlockedAt: 1 });
    expect((await check(h, OMAR)).status).toBe(202);
  });

  it("asks for no model budget: an install whose model proxy cannot answer still checks", async () => {
    const refuse = () => { throw new Error("the proxy must not be asked"); };
    const h = await harness({ brokerExtra: { modelAccess: { access: { orgSpend: refuse, spend: refuse }, proxyUrl: "http://internal-proxy.example.test:4000" } } });
    expect((await check(h, OMAR)).status).toBe(202);
  });

  it("refuses with WORKSPACE_LIMIT when the person's limit is reached, and writes no check workspace", async () => {
    const h = await harness({ memberLimit: 1 });
    await addPerson(h, MAYA, "owner");
    const task = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix it", client: "claude-code" });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const before = workspaces(h).length;
    expect(rejection(await check(h, MAYA))).toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(workspaces(h)).toHaveLength(before);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
    expect(requestItems(h)).toEqual([]);
  });

  it("refuses with WORKSPACE_LIMIT when the organization's limit is reached", async () => {
    const h = await harness({ organizationLimit: 1 });
    await addPerson(h, MAYA, "owner");
    expect((await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix it", client: "claude-code" })).status).toBe(200);
    expect(rejection(await check(h, OMAR))).toMatchObject({ code: "WORKSPACE_LIMIT" });
  });
});

describe("POST /v1/app/projects/{name}/setup-check: the request id", () => {
  it("returns the stored outcome for a repeated request id and writes nothing", async () => {
    const h = await harness();
    const requestId = randomUUID();
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    const mark = h.db.commandNames().length;
    const again = await check(h, OMAR, requestId);
    expect(again.status).toBe(200);
    expect(AppProjectDetailSchema.parse(again.body.project).setup).toMatchObject({ status: "checking" });
    expect(h.db.commandNames().slice(mark).filter((name) => ["TransactWriteCommand", "PutCommand", "UpdateCommand", "DeleteCommand"].includes(name))).toEqual([]);
    expect(workspaces(h)).toHaveLength(1);
  });

  it("returns the stored outcome for a late replay after the check finished and another check started, and starts nothing", async () => {
    const h = await harness();
    const requestId = randomUUID();
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    const one = metaOf(h)!.setupCheck!.workspaceId;
    await h.finish(one, prepareOf(h, one), "SUCCEEDED");
    const second = await started(h);
    expect((await check(h, OMAR, requestId)).status).toBe(200);
    expect(workspaces(h)).toHaveLength(2);
    expect(metaOf(h)!.setupCheck!.workspaceId).toBe(second.workspaceId);
  });

  it("answers the same request id sent twice together once as a start and once as its replay", async () => {
    const h = await harness();
    const requestId = randomUUID();
    const answers = await Promise.all([check(h, OMAR, requestId), check(h, OMAR, requestId)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 202]);
    expect(workspaces(h)).toHaveLength(1);
    expect(requestItems(h)).toHaveLength(1);
  });

  it("answers a replay even when the project has since been archived (the id was used)", async () => {
    const h = await harness();
    const requestId = randomUUID();
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    h.db.set({ ...(h.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>), status: "archived", archivedAt: "x", archivedBy: "y" });
    expect((await check(h, OMAR, requestId)).status).toBe(200);
  });

  it("refuses a request id another person used with IDEMPOTENCY_CONFLICT, and starts nothing", async () => {
    const h = await harness();
    await addPerson(h, KIT, "member", "maintainer");
    const requestId = randomUUID();
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    expect(rejection(await check(h, KIT, requestId))).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(workspaces(h)).toHaveLength(1);
  });

  it("stores the request in the same transaction as the check, with an expiry, in at most 100 items", async () => {
    const h = await harness();
    const requestId = randomUUID();
    const sent: number[] = [];
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: unknown[] } }) => {
      if (command.constructor.name === "TransactWriteCommand") sent.push(command.input?.TransactItems?.length ?? 0);
      return send(command as never);
    });
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeLessThanOrEqual(100);
    const [request] = requestItems(h);
    expect(request).toMatchObject({ pk: projectMetaKey(TEST_ORG, NAME).pk, sk: `SETUP_CHECK_REQUEST#${requestId}`, by: OMAR.developerId, workspaceId: metaOf(h)!.setupCheck!.workspaceId });
    expect(typeof request!.indexExpiresAt).toBe("number");
    expect(request!.indexExpiresAt as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("leaves neither the workspace, the META record nor the request when the transaction fails, and the same id then works", async () => {
    const h = await harness();
    const requestId = randomUUID();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    expect((await check(h, OMAR, requestId)).status).toBeGreaterThanOrEqual(500);
    expect(workspaces(h)).toEqual([]);
    expect(requestItems(h)).toEqual([]);
    expect(metaOf(h)!.setupCheck).toBeUndefined();
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    expect(workspaces(h)).toHaveLength(1);
  });

  it("lets an expired but not yet deleted request id be used again", async () => {
    const h = await harness();
    const requestId = randomUUID();
    h.db.set({ pk: projectMetaKey(TEST_ORG, NAME).pk, sk: `SETUP_CHECK_REQUEST#${requestId}`, entityType: "PROJECT_SETUP_CHECK_REQUEST", by: KIT.developerId, workspaceId: randomUUID(), indexExpiresAt: Math.floor(Date.now() / 1000) - 10 });
    expect((await check(h, OMAR, requestId)).status).toBe(202);
    expect(requestItems(h)).toHaveLength(1);
    expect(requestItems(h)[0]).toMatchObject({ by: OMAR.developerId });
  });

  it("retries when a transaction is cancelled and reads nothing that explains it", async () => {
    const h = await harness();
    h.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] } });
    expect((await check(h, OMAR)).status).toBe(202);
    expect(workspaces(h)).toHaveLength(1);
  });

  it("gives up with a retryable WORKSPACE_BUSY when the transaction keeps being cancelled for no reason that can be read back", async () => {
    const h = await harness();
    h.db.injectFault({ command: "TransactWriteCommand", times: 5, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] } });
    expect(rejection(await check(h, OMAR))).toMatchObject({ status: 409, code: "WORKSPACE_BUSY" });
    expect(workspaces(h)).toEqual([]);
  });
});

// Final review I3. A check takes a limit slot, which its end gives back, and its workspace is closed when the check ends, when a new check
// supersedes it, or (a check that never reported) by the sweep. The tests count open workspaces and the member counter.
describe("the setup check's workspace and slot (final review I3)", () => {
  /** Every workspace item that is not closed. */
  const openWorkspaces = (h: Harness) => h.db.find((item) => item.sk === "META" && String(item.pk).startsWith("WORKSPACE#") && item.entityType === "WORKSPACE" && item.status !== "CLOSED");
  /** The slots the people's counters hold (the member counter is the one with a set of holders; the org's counter moves with it). */
  const heldSlots = (h: Harness) => h.db.find((item) => (item.entityType === "SLACK_LIMIT" || item.entityType === "DEVELOPER_LIMIT") && item.tasks !== undefined)
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 0), 0);

  it("takes a slot while checking, so a person at their limit cannot start a task meanwhile, and gives it back when the check succeeds", async () => {
    const h = await harness({ memberLimit: 1 });
    const { workspaceId, operationId } = await started(h);
    expect(heldSlots(h)).toBeGreaterThan(0);
    const refused = await h.dev(OMAR, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix it", client: "claude-code" });
    expect(rejection(refused)).toMatchObject({ code: "WORKSPACE_LIMIT" });
    await h.finish(workspaceId, operationId, "SUCCEEDED");
    expect(heldSlots(h)).toBe(0);
    expect(openWorkspaces(h)).toEqual([]);
    expect(h.deleteEc2Session).toHaveBeenCalledWith(workspaceId);
    expect(h.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
    // The status still reads what the check found.
    expect(await setupOf(h)).toMatchObject({ status: "ready", checkedRevision: 1 });
    const task = await h.dev(OMAR, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix it", client: "claude-code" });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
  });

  it("gives the slot back and closes the workspace when the check fails, and the status still names the failing step", async () => {
    const h = await harness({ memberLimit: 1 });
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "FAILED", { error: "setup step 0 (npm ci in repo/demo) exited 1" });
    expect(heldSlots(h)).toBe(0);
    expect(openWorkspaces(h)).toEqual([]);
    expect(h.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    expect(await setupOf(h)).toMatchObject({ status: "failed", failedStep: expect.stringMatching(/^setup: npm ci/) as string });
  });

  it("closes the check's workspace when the same result is reported again after the first close did not land (follow-up N5)", async () => {
    for (const [status, closedFrom] of [["SUCCEEDED", "READY"], ["FAILED", "PREPARATION_FAILED"]] as const) {
      const h = await harness({ memberLimit: 1 });
      h.deleteEc2Session!.mockRejectedValueOnce(new Error("compute is busy"));
      const { workspaceId, operationId } = await started(h);
      await h.finish(workspaceId, operationId, status, status === "FAILED" ? { error: "setup step 0 (npm ci in repo/demo) exited 1" } : {});
      expect(openWorkspaces(h), status).toHaveLength(1);
      expect(heldSlots(h), status).toBeGreaterThan(0);
      // The worker repeats the result it already sent.
      await h.finish(workspaceId, operationId, status, status === "FAILED" ? { error: "setup step 0 (npm ci in repo/demo) exited 1" } : {});
      expect(openWorkspaces(h), status).toEqual([]);
      expect(heldSlots(h), status).toBe(0);
      expect(h.db.get(`WORKSPACE#${workspaceId}`, "META"), status).toMatchObject({ status: "CLOSED", closedFrom });
    }
  });

  it("refuses a check that would pass the limit when the counter fills between the read and the write", async () => {
    const h = await harness();
    // The counters fill just as the transaction is sent; the cancellation names the first counter.
    h.db.injectFault({
      command: "TransactWriteCommand",
      match: (input) => {
        for (const item of (input.TransactItems as Array<{ Update?: { Key: { pk: string; sk: string } } }>).slice(0, 2)) h.db.set({ ...item.Update!.Key, entityType: "DEVELOPER_LIMIT", count: 99 });
        return true;
      },
      error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] },
    });
    expect(rejection(await check(h, OMAR))).toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(workspaces(h)).toEqual([]);
  });

  it("closes the workspace a new check supersedes when its own close did not land, and takes only the new check's slot", async () => {
    const h = await harness({ memberLimit: 2 });
    h.deleteEc2Session!.mockRejectedValueOnce(new Error("compute is busy"));
    const first = await started(h);
    await h.finish(first.workspaceId, first.operationId, "SUCCEEDED");
    // The close after the result failed: the workspace is open and still holds its slot.
    expect(openWorkspaces(h)).toHaveLength(1);
    expect(heldSlots(h)).toBe(1);
    const second = await started(h);
    expect(h.db.get(`WORKSPACE#${first.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(h.deleteEc2Session).toHaveBeenCalledWith(first.workspaceId);
    expect(openWorkspaces(h).map((item) => (item as { id?: string }).id)).toEqual([second.workspaceId]);
    expect(heldSlots(h)).toBe(1);
    await h.finish(second.workspaceId, second.operationId, "SUCCEEDED");
    expect(openWorkspaces(h)).toEqual([]);
    expect(heldSlots(h)).toBe(0);
  });

  it("lets the sweep fail and close a check that never reported, and give its slot back", async () => {
    const h = await harness({ memberLimit: 1 });
    const { workspaceId, operationId } = await started(h);
    const deleteCompute = vi.fn(async () => undefined);
    // Not yet 50 minutes: untouched.
    expect(await sweepStuckSetupChecks(h.db, "state", new Date(Date.now() + 10 * 60_000), deleteCompute)).toEqual({ closed: [], dropped: 0, kept: 0 });
    expect(openWorkspaces(h)).toHaveLength(1);
    const late = new Date(Date.now() + 55 * 60_000);
    expect(await sweepStuckSetupChecks(h.db, "state", late, deleteCompute)).toEqual({ closed: [workspaceId], dropped: 0, kept: 0 });
    expect(deleteCompute).toHaveBeenCalledWith(expect.objectContaining({ id: workspaceId }));
    expect(openWorkspaces(h)).toEqual([]);
    expect(heldSlots(h)).toBe(0);
    expect(h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED" });
    expect(h.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    expect(h.db.find((item) => item.pk === "SETUP_CHECK_WATCH")).toEqual([]);
    // Run again: nothing left to do.
    expect(await sweepStuckSetupChecks(h.db, "state", late, deleteCompute)).toEqual({ closed: [], dropped: 0, kept: 0 });
    expect(heldSlots(h)).toBe(0);
  });

  it("closes a finished check the sweep finds still open, and keeps the watch when the compute cannot be deleted yet", async () => {
    const h = await harness({ memberLimit: 1 });
    h.deleteEc2Session!.mockRejectedValueOnce(new Error("compute is busy"));
    const { workspaceId, operationId } = await started(h);
    await h.finish(workspaceId, operationId, "SUCCEEDED");
    expect(openWorkspaces(h)).toHaveLength(1);
    const late = new Date(Date.now() + 55 * 60_000);
    const failing = vi.fn(async () => { throw new Error("busy"); });
    expect(await sweepStuckSetupChecks(h.db, "state", late, failing)).toEqual({ closed: [], dropped: 0, kept: 1 });
    expect(openWorkspaces(h)).toHaveLength(1);
    expect(await sweepStuckSetupChecks(h.db, "state", late, vi.fn(async () => undefined))).toEqual({ closed: [workspaceId], dropped: 0, kept: 0 });
    expect(openWorkspaces(h)).toEqual([]);
    expect(heldSlots(h)).toBe(0);
  });

  describe("the sweep over a backlog (follow-up N4)", () => {
    const old = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    /** A finished check whose close did not land: record, open READY workspace and watch, as the start and the prepare callback leave them. */
    function seedCheck(h: Harness, index: number): string {
      const workspaceId = `ws-backlog-${String(index).padStart(4, "0")}`;
      h.db.set({ ...setupCheckRecordKey(workspaceId), entityType: "SETUP_CHECK", workspaceId, createdAt: old(index) });
      h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, status: "READY", deploymentMode: "ec2-ebs" });
      h.db.set({ ...setupCheckWatchKey(old(index), workspaceId), entityType: "SETUP_CHECK_WATCH", workspaceId });
      return workspaceId;
    }
    const watches = (h: Harness) => h.db.find((item) => item.pk === "SETUP_CHECK_WATCH");

    it("pages through every stuck watch, not one page of 100", async () => {
      const h = await harness();
      const ids = Array.from({ length: 250 }, (_, index) => seedCheck(h, index));
      const swept = await sweepStuckSetupChecks(h.db, "state", new Date(), vi.fn(async () => undefined));
      expect(swept).toEqual({ closed: ids, dropped: 0, kept: 0 });
      expect(watches(h)).toEqual([]);
      expect(h.db.get(`WORKSPACE#${ids[249]!}`, "META")).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
    });

    it("moves past a hundred watches that cannot be closed and closes the one behind them, and says which were kept", async () => {
      const h = await harness();
      const stuck = Array.from({ length: 101 }, (_, index) => seedCheck(h, index));
      const behind = seedCheck(h, 500);
      const logs: Array<Record<string, unknown>> = [];
      const deleteCompute = vi.fn(async (workspace: { id: string }) => { if (stuck.includes(workspace.id)) throw new Error("busy"); });
      const swept = await sweepStuckSetupChecks(h.db, "state", new Date(), deleteCompute, (entry) => { logs.push(entry); });
      expect(swept).toEqual({ closed: [behind], dropped: 0, kept: 101 });
      expect(watches(h)).toHaveLength(101);
      expect(h.db.get(`WORKSPACE#${behind}`, "META")).toMatchObject({ status: "CLOSED" });
      expect(logs.filter((entry) => entry.event === "stuck_setup_check.close_failed")).toHaveLength(101);
      expect(logs).toContainEqual({ event: "stuck_setup_check.close_failed", workspaceId: stuck[0], error: "Error" });
    });

    it("logs a check that is kept because it is busy, not only one whose close threw", async () => {
      const h = await harness();
      const id = seedCheck(h, 1);
      // A workspace in a state a close does not take (here DELETING): the sweep leaves it and the watch stays.
      h.db.set({ ...(h.db.get(`WORKSPACE#${id}`, "META") as Record<string, unknown>), status: "DELETING" });
      const logs: Array<Record<string, unknown>> = [];
      expect(await sweepStuckSetupChecks(h.db, "state", new Date(), vi.fn(async () => undefined), (entry) => { logs.push(entry); })).toEqual({ closed: [], dropped: 0, kept: 1 });
      expect(logs).toContainEqual({ event: "stuck_setup_check.kept", workspaceId: id });
    });

    it("does not let a watch it cannot drop block the others", async () => {
      const h = await harness();
      h.db.set({ pk: "SETUP_CHECK_WATCH", sk: `${old(0)}#orphan`, entityType: "SETUP_CHECK_WATCH" });
      const id = seedCheck(h, 1);
      const send = h.db.send.bind(h.db);
      h.db.send = (async (command: { constructor: { name: string }; input?: { Key?: { sk?: string } } }) => {
        if (command.constructor.name === "DeleteCommand" && command.input?.Key?.sk === `${old(0)}#orphan`) throw new Error("throttled");
        return send(command as never);
      });
      const logs: Array<Record<string, unknown>> = [];
      const swept = await sweepStuckSetupChecks(h.db, "state", new Date(), vi.fn(async () => undefined), (entry) => { logs.push(entry); });
      expect(swept).toEqual({ closed: [id], dropped: 0, kept: 1 });
      expect(logs).toContainEqual({ event: "stuck_setup_check.close_failed", workspaceId: undefined, error: "Error" });
    });

    it("stops at its time budget, always closing at least one, and leaves the rest for the next run", async () => {
      const h = await harness();
      const ids = Array.from({ length: 5 }, (_, index) => seedCheck(h, index));
      const logs: Array<Record<string, unknown>> = [];
      const swept = await sweepStuckSetupChecks(h.db, "state", new Date(), vi.fn(async () => undefined), (entry) => { logs.push(entry); }, { budgetMs: 0 });
      expect(swept).toEqual({ closed: [ids[0]], dropped: 0, kept: 0 });
      expect(watches(h)).toHaveLength(4);
      expect(logs).toContainEqual({ event: "stuck_setup_check.sweep_incomplete", closed: 1, dropped: 0, kept: 0 });
    });
  });

  it("takes the check's slot, workspace, watch and record in the one transaction, within 100 items", async () => {
    const h = await harness();
    const sent: Array<Array<Record<string, unknown>>> = [];
    const send = h.db.send.bind(h.db);
    h.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<Record<string, unknown>> } }) => {
      if (command.constructor.name === "TransactWriteCommand") sent.push(command.input?.TransactItems ?? []);
      return send(command as never);
    });
    const { workspaceId } = await started(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeLessThanOrEqual(100);
    expect(h.db.get(`WORKSPACE#${workspaceId}`, "SETUP_CHECK")).toMatchObject({ orgId: TEST_ORG, project: NAME, workspaceId });
    expect(h.db.find((item) => item.pk === "SETUP_CHECK_WATCH")).toHaveLength(1);
  });

  it("does not touch another person's check workspace or any task's workspace when it supersedes", async () => {
    const h = await harness({ memberLimit: 3 });
    await addPerson(h, MAYA, "owner");
    const task = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix it", client: "claude-code" });
    expect(task.status).toBe(200);
    const first = await started(h);
    await h.finish(first.workspaceId, first.operationId, "SUCCEEDED");
    const second = await started(h);
    await h.finish(second.workspaceId, second.operationId, "SUCCEEDED");
    const stillOpen = openWorkspaces(h);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]).toMatchObject({ ownerKey: expect.any(String) as string });
    expect(h.deleteEc2Session!.mock.calls.map(([id]) => id).sort()).toEqual([first.workspaceId, second.workspaceId].sort());
  });
});

it("M47 setup-check refuses enrolled work without a trusted dollar admission basis", async () => {
  const access = fakeModelAccess(), h = await harness({ brokerExtra: { modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" } } });
  h.db.set({ ...orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId: TEST_ORG, revision: 1,
    policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 0 } }, enrollment: { version: 1, state: "enabled" } });
  expect(rejection(await check(h, OMAR))).toMatchObject({ status: 409, code: "TASK_STOP_CONFIG_MISSING" });
  expect(h.db.find(row => row.entityType === "WORKSPACE" || row.entityType === "OPERATION" || row.entityType === "DEVELOPER_TASK")).toHaveLength(0);
  expect(access.mintedKeys()).toHaveLength(0);
});
