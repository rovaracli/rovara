// Test environment (wire-testenv), the setup routes through the whole broker: a setup draft run that is told to detect reports the environment it would propose; the broker keeps it only if it is the safest
// sandbox draft; a maintainer proposes it, proves it with the project's setup check, and approves it as revision 1. With the switch off none of it exists: the run is not asked to detect, a reported draft is
// kept nowhere, and the routes answer as any unknown path.
import { randomUUID } from "node:crypto";
import { DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_ENV_DETECT_FEATURE, TEST_ENV_DRAFT_RESULT_KEY, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, testEnvDigest, type TestEnvDraft } from "@rovara-code/contracts";
import { WorkerInvocationSchema, githubInstallationKey, orgGithubInstallationKey, type GithubInstallationRecord } from "@agentx/cloud-contracts";
import { noteBlockedTask, readProjectHealth } from "../../packages/broker/src/test-env/health.js";
import { healthPortsOf } from "../../packages/broker/src/test-env/health-wiring.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { candidatePassed } from "../support/candidate-check.js";

const NAME = "web";
const ENV = `/v1/app/projects/${NAME}/test-environment`;
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
const PREPARED = { result: { preparedBase: [{ repositoryId: "web", baseCommitSha: "e".repeat(40) }] } };
type Reply = { status: number; body: Record<string, unknown> };
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

const draftBody = (over: Record<string, unknown> = {}) => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [".github/**"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const draftOf = (environment = draftBody()): TestEnvDraft => ({ environment, valueSources: [{ field: "repos[0].checks[0]", source: "detector:node" }], pendingServices: [], notes: ["Found a Makefile."], questions: [] });

const SETUP_PROPOSAL = {
  setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "inferred", repo: "web", note: "a package.json" }] }],
  tests: [], notes: "ok",
};

async function setup() {
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      cloud: true, agents: {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn(), getFileAtCommit: vi.fn(async () => undefined), getDefaultBranchHead: vi.fn(async () => "c".repeat(40)) },
      checkRepositoryAccess: vi.fn(async () => undefined),
    },
  });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  const record: GithubInstallationRecord = { installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1", boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  h.db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
  h.db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
  h.db.set({
    ...projectRevisionKey(TEST_ORG, NAME, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: { name: NAME, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [command("make", ["old-setup"], 900)], readiness: [command("make", ["old-test"], 1800)], orchestratorInstructions: "Delegate work." },
  });
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, NAME), entityType: "PROJECT_CATALOG", name: NAME, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  h.db.set({ ...projectMetaKey(TEST_ORG, NAME), entityType: "PROJECT_META", name: NAME, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
  const contributor = async (who: Developer) => {
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: NAME, grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  };
  const ask = (): Promise<Reply> => h.dev(OMAR, "POST", `/v1/app/projects/${NAME}/setup-draft`, { requestId: randomUUID() });
  const operations = (workspaceId: string) => h.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId) as Array<{ id: string; kind: string; status: string; workflowMode?: string }>;
  const taskOf = (): { taskId: string; workspaceId: string } => h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft")[0] as never;
  /** Asks for a draft, prepares its machine, and finishes its run with `result`; answers the invocation the worker was sent. */
  const drafted = async (result: Record<string, unknown>) => {
    const reply = await ask();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = taskOf();
    const prepare = operations(task.workspaceId).find((operation) => operation.kind === "prepare")!;
    await h.finish(task.workspaceId, prepare.id, "SUCCEEDED", PREPARED);
    const own = operations(task.workspaceId).find((operation) => operation.kind === "task")!;
    const invocation = (h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === own.id)[0] as { invocation: { payload: Record<string, unknown>; kind: string } }).invocation;
    await h.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "SETUP_DRAFT", ...result } });
    return { task, invocation };
  };
  /** The proposal's candidate check, passed (TE-2): its workspace is ready at revision 1, with the commands the check ran. */
  const candidateCheckPassed = (digest: string, options: Parameters<typeof candidatePassed>[2] = {}) => candidatePassed(h.db, { orgId: TEST_ORG, project: NAME, digest, developerId: OMAR.developerId }, options);
  return { ...h, contributor, ask, drafted, candidateCheckPassed, operations };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const withSwitch = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const before = process.env.TEST_ENVIRONMENT_ENABLED;
  if (value === undefined) delete process.env.TEST_ENVIRONMENT_ENABLED; else process.env.TEST_ENVIRONMENT_ENABLED = value;
  try { return await run(); } finally { if (before === undefined) delete process.env.TEST_ENVIRONMENT_ENABLED; else process.env.TEST_ENVIRONMENT_ENABLED = before; }
};
afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; });
const drafts = (t: Setup) => t.db.find((item) => item.entityType === "TEST_ENV_DRAFT");

describe("the feature strings", () => {
  it("the detect feature is one a worker advertises and the contract knows", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_ENV_DETECT_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(TEST_ENV_DETECT_FEATURE);
  });
});

describe("with the switch off", () => {
  it("the setup draft run is not asked to detect, a draft it reports is kept nowhere, and the routes do not exist", async () => {
    const t = await setup();
    const { invocation } = await withSwitch(undefined, () => t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() }));
    expect(invocation.payload).toMatchObject({ workflowMode: "SETUP_DRAFT" });
    expect(invocation.payload).not.toHaveProperty("testEnvDetect");
    expect(drafts(t)).toEqual([]);
    for (const [method, path] of [["GET", ENV], ["POST", `${ENV}/propose`], ["POST", `${ENV}/prove`], ["POST", `${ENV}/approve`]] as const) {
      const reply = await t.dev(OMAR, method, path, method === "GET" ? undefined : {});
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#"))).toEqual([]);
  });

  it("every look-alike value of the switch is off too", async () => {
    const t = await setup();
    for (const value of ["0", "true", "yes", " 1", "01", ""]) {
      const reply = await withSwitch(value, () => t.dev(OMAR, "GET", ENV));
      expect(reply.status, JSON.stringify(value)).toBe(404);
    }
  });
});

describe("with the switch on", () => {
  it("asks the setup draft run to detect, and the request still parses as a worker invocation", async () => {
    const t = await setup();
    const { invocation } = await withSwitch("1", () => t.drafted({ setupProposal: SETUP_PROPOSAL }));
    expect(invocation.payload).toMatchObject({ workflowMode: "SETUP_DRAFT", testEnvDetect: true });
    expect(WorkerInvocationSchema.safeParse(invocation).success).toBe(true);
  });

  it("walks propose, prove and approve to revision 1, and a replay of the approval answers the same revision", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() });
      expect(drafts(t)).toHaveLength(1);
      const read = await t.dev(OMAR, "GET", ENV);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body).toMatchObject({ draft: { status: "ready", notes: ["Found a Makefile."] } });
      expect(read.body.proposal).toBeUndefined();

      const proposed = await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
      const digest = testEnvDigest(draftBody());
      expect(proposed.body).toMatchObject({ proposal: { digest, risk: "medium", lessSafe: [], proved: false } });

      // No setup check yet: not proved, and the words say what to do.
      const early = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(early.status).toBe(400);
      expect(errorOf(early).message).toContain("check of this test environment");
      // And an unproved proposal cannot be approved.
      const unproved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(unproved.status).toBe(400);
      expect(errorOf(unproved).message).toContain("check of this test environment");
      // TS-UX-1 item 2: with a passing candidate check the proposal reads as proved with no Prove press; the read keeps nothing, and Approve keeps the report it derives from the check.
      t.candidateCheckPassed(digest);
      const shown = await t.dev(OMAR, "GET", ENV);
      expect(shown.body).toMatchObject({ proposal: { digest, proved: true } });
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROVE")).toEqual([]);

      const requestId = randomUUID();
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0, requestId });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 1, digest, replayed: false });
      expect((approved.body.state as { approved?: { revision: number; digest: string } }).approved).toMatchObject({ revision: 1, digest });
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROVE")).toHaveLength(1);
      // SH28: the project then needs repair (three tasks blocked by the same cause). A REPLAY of the approval that already stood proves nothing new: it leaves "Setup needs repair" as it is.
      process.env.NIGHTLY_HEALTH_ENABLED = "1";
      try {
        const store = { documentClient: t.db, tableName: "state", now: () => Date.now() };
        for (const id of ["task_1", "task_2", "task_3"]) await noteBlockedTask(store, healthPortsOf(store), { orgId: TEST_ORG, project: NAME, taskId: id, reason: "host_blocked" });
        expect((await readProjectHealth(store as never, TEST_ORG, NAME))?.state).toBe("needs_repair");
        const again = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0, requestId });
        expect(again.body).toMatchObject({ revision: 1, replayed: true });
        expect((await readProjectHealth(store as never, TEST_ORG, NAME))?.state).toBe("needs_repair");
      } finally { delete process.env.NIGHTLY_HEALTH_ENABLED; }
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
    });
  });

  it("keeps no draft that asks for more than the sandbox, and a propose with no draft is stale", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      const hostile = draftOf(draftBody({ tier: "shared", shared: { baseUrl: "https://beta.example.com", leaseScope: "env", dataNamespace: "task_prefix" }, accounts: [{ profileId: "buyer", provisioner: "seed_command", command: command("make", ["seed"], 60) }] }));
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: hostile });
      expect(drafts(t)).toEqual([]);
      const read = await t.dev(OMAR, "GET", ENV);
      expect(read.body).toMatchObject({ draft: { status: "none" } });
      const proposed = await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect(proposed.status).toBe(409);
      expect(errorOf(proposed).message).toContain("draft");
    });
  });

  it("approves only what is proved NOW: a setup check that failed since the proof stops the approval, and a replay of an approval already made still answers", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() });
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      const digest = testEnvDigest(draftBody());
      const workspace = t.candidateCheckPassed(digest);
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
      t.db.set({ pk: `WORKSPACE#${workspace}`, sk: "META", status: "PREPARATION_FAILED" });
      const stopped = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(stopped.status).toBe(400);
      expect(errorOf(stopped).message).toContain("check of this test environment");
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toEqual([]);
      t.candidateCheckPassed(digest);
      const requestId = randomUUID();
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0, requestId })).status).toBe(200);
      t.db.set({ pk: `WORKSPACE#${workspace}`, sk: "META", status: "PREPARATION_FAILED" });
      expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0, requestId })).body).toMatchObject({ revision: 1, replayed: true });
    });
  });

  it("keeps no draft too large to store, tells the maintainer so, and the setup draft itself still finishes", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      const huge = draftOf(draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: Array.from({ length: 16 }, (_, index) => ({ id: `c${String(index)}`, label: `Check ${String(index)}`, command: command("make", ["t", `--note=${String(index)}-${"x".repeat(8_100)}`, `--b=${"y".repeat(8_100)}`], 600), kind: "test" })) }] }));
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: huge });
      expect(drafts(t)).toEqual([]);
      const setupDraft = await t.dev(OMAR, "GET", `/v1/app/projects/${NAME}/setup-draft`);
      expect(setupDraft.body).toMatchObject({ status: "ready" });
      const read = await t.dev(OMAR, "GET", ENV);
      expect(read.body).toMatchObject({ draft: { status: "none", notes: ["The environment Rovara found was too large to keep, so none is proposed."] } });
    });
  });

  it("the run's stored result never carries the draft (it lives in its own item), so a huge report cannot make the terminal write too big", async () => {
    const t = await setup();
    const storedResults = () => t.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "SETUP_DRAFT") as Array<{ result?: Record<string, unknown> }>;
    await withSwitch("1", async () => {
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() });
      expect(drafts(t)).toHaveLength(1);
      expect(storedResults()).toHaveLength(1);
      expect(storedResults()[0]!.result).toMatchObject({ workflowMode: "SETUP_DRAFT", setupProposal: SETUP_PROPOSAL });
      expect(storedResults()[0]!.result).not.toHaveProperty(TEST_ENV_DRAFT_RESULT_KEY);
    });
    const hostile = await setup();
    await withSwitch("1", async () => {
      // A worker that ignores the cap and reports 600 KB: nothing of it is stored on the operation, the draft is refused with the marker, and the setup draft still finishes.
      await hostile.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: { ...draftOf(), notes: ["x".repeat(600 * 1_024)] } });
      const stored = hostile.db.find((item) => item.entityType === "OPERATION" && item.workflowMode === "SETUP_DRAFT")[0]!;
      expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThan(100 * 1_024);
      expect(((await hostile.dev(OMAR, "GET", `/v1/app/projects/${NAME}/setup-draft`)).body)).toMatchObject({ status: "ready" });
    });
  });

  it("a person who is not a project maintainer can read where it stands but cannot propose, prove or approve", async () => {
    const t = await setup();
    await t.contributor(MAYA);
    await withSwitch("1", async () => {
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() });
      const digest = testEnvDigest(draftBody());
      expect((await t.dev(MAYA, "GET", ENV)).status).toBe(200);
      for (const [path, body] of [[`${ENV}/propose`, {}], [`${ENV}/prove`, { digest }], [`${ENV}/approve`, { digest, expectedRevision: 0 }]] as const) {
        const reply = await t.dev(MAYA, "POST", path, body);
        expect(reply.status, path).toBe(403);
      }
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#"))).toHaveLength(1); // the draft only
    });
  });

  it("is not proved by a candidate check that ran other commands, one from older settings, or one that failed", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      const body = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("pytest", ["-q"], 1800), kind: "test" }] }] });
      await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf(body) });
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      const digest = testEnvDigest(body);
      // A check that ran only the settings' own commands (not the proposal's pytest) proves nothing for the proposal.
      const workspace = t.candidateCheckPassed(digest, { lists: { setup: [command("make", ["old-setup"], 900)], readiness: [command("make", ["old-test"], 1800)] } });
      const differs = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(differs.status).toBe(400);
      expect(errorOf(differs).message).toContain("not among the commands the check ran");
      // A check from older settings: the record is keyed by the revision, so this revision has none.
      t.candidateCheckPassed(digest, { revision: 7 });
      t.db.set({ ...(t.db.get(`WORKSPACE#${workspace}`, "META") as Record<string, unknown>), status: "READY" });
      // A failed check.
      t.candidateCheckPassed(digest, { status: "PREPARATION_FAILED" });
      expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(400);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#PROVE#"))).toEqual([]);
    });
  });
});

describe("a task's checks", () => {
  const withLint = () => draftOf(draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [
    { id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" },
    { id: "lint", label: "Lint", command: command("ruff", ["check"], 600), kind: "lint" },
  ] }] }));
  const approveEnvironment = async (t: Setup, draft: TestEnvDraft) => {
    await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draft });
    const proposed = await t.dev(OMAR, "POST", `${ENV}/propose`, {});
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const digest = testEnvDigest(draft.environment);
    t.candidateCheckPassed(digest);
    expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
    const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  };
  const startTask = async (t: Setup) => {
    const started = await t.dev(OMAR, "POST", `/v1/app/projects/${NAME}/code`, { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const record = t.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { checkPolicy: { required: Array<{ id: string; label: string; kind?: string; command: { executable: string } }> } } };
    return { taskId, required: record.workflow.checkPolicy.required, pins: t.db.find((item) => item.entityType === "TEST_ENV_PIN" && item.taskId === taskId) };
  };

  it("are the project's own while the switch is off, even for a project with an approved environment, and nothing is pinned", async () => {
    const t = await setup();
    await withSwitch("1", () => approveEnvironment(t, withLint()));
    const task = await withSwitch(undefined, () => startTask(t));
    expect(task.required.map((check) => check.command.executable)).toEqual(["make"]);
    expect(task.required.every((check) => check.kind === undefined)).toBe(true);
    expect(task.pins).toEqual([]);
  });

  it("are the approved environment's with the switch on, with their kinds, and the revision the task started with is pinned", async () => {
    const t = await setup();
    await withSwitch("1", async () => {
      await approveEnvironment(t, withLint());
      const task = await startTask(t);
      expect(task.required.map((check) => [check.label, check.kind, check.command.executable])).toEqual([["Unit tests", "test", "make"], ["Lint", "lint", "ruff"]]);
      expect(task.pins).toHaveLength(1);
      expect(task.pins[0]).toMatchObject({ revision: 1, digest: testEnvDigest(withLint().environment) });
      expect(task.pins[0]!.unused).toBeUndefined();
    });
  });

  it("with the switch on but no approved environment are the project's own and nothing is pinned", async () => {
    const t = await setup();
    const task = await withSwitch("1", () => startTask(t));
    expect(task.required.map((check) => check.command.executable)).toEqual(["make"]);
    expect(task.pins).toEqual([]);
  });
});

describe("the nightly schedule after an approval", () => {
  const SCHEDULER_ENV = {
    AGENTX_ENV: "staging", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AWS_LAMBDA_FUNCTION_NAME: "agentx-staging-broker",
    CHAIN_SCHEDULE_ROLE_ARN: "arn:aws:iam::123456789012:role/agentx-staging-chain-schedule", CHAIN_SCHEDULE_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-chain-schedule",
  };
  const withSchedulerEnv = async <T>(run: () => Promise<T>): Promise<T> => {
    const before = Object.fromEntries(Object.keys(SCHEDULER_ENV).map((key) => [key, process.env[key]]));
    Object.assign(process.env, SCHEDULER_ENV);
    try { return await run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  const approveOnce = async (t: Setup) => {
    await t.drafted({ setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draftOf() });
    await t.dev(OMAR, "POST", `${ENV}/propose`, {});
    const digest = testEnvDigest(draftBody());
    t.candidateCheckPassed(digest);
    await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
    return t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
  };

  it("follows the approved environment (a project with the nightly run off has its schedule removed), and a scheduler that fails does not undo the approval", async () => {
    const t = await setup();
    const send = vi.spyOn(SchedulerClient.prototype, "send").mockRejectedValue(new Error("scheduler down"));
    try {
      const approved = await withSwitch("1", () => withSchedulerEnv(() => approveOnce(t)));
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteScheduleCommand);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
    } finally { send.mockRestore(); }
  });

  it("makes no scheduler call while the switch is off, or where the install has no schedule group settings", async () => {
    const send = vi.spyOn(SchedulerClient.prototype, "send").mockResolvedValue({} as never);
    try {
      const off = await setup();
      // Off: the routes do not exist at all, so no approval can reach the hook.
      await withSwitch(undefined, () => withSchedulerEnv(async () => { expect((await off.dev(OMAR, "POST", `${ENV}/approve`, { digest: "a".repeat(64), expectedRevision: 0 })).status).toBe(404); }));
      const noGroup = await setup();
      expect((await withSwitch("1", () => approveOnce(noGroup))).status).toBe(200);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});
