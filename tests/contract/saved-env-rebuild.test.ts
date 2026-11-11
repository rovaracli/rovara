// Saved project images (SV wiring): the rebuild job on the broker's side. The registry queues a job with its commits; this starts it as a read-only PINNED preparation on a fresh workspace of the approver, and the
// dispatcher hands the lease token to the worker ONCE, at delivery, so the stored invocation never holds it.
// The dispatcher module reads its table name when it loads.
vi.hoisted(() => { process.env["STATE_TABLE_NAME"] ??= "state"; });
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, PREPARE_SAVED_ENV_BUILD_FEATURE, SavedEnvBuildResultSchema, WORKFLOW_DISPATCH_DUE_INDEX, WORKSPACE_PROJECT_INDEX, agentXError, savedEnvRepositoryName, type Ec2RuntimeBinding, type OrgId } from "@rovara-code/contracts";
import { WORKER_INVOCATION_FEATURES } from "@agentx/cloud-contracts";
import { WorkerInvocationSchema, type WorkerInvocation } from "@agentx/cloud-contracts";
import { createSavedEnvBuildLease } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { ownerForAutomaticRun, startSavedEnvRebuild, type SavedEnvBuildInputs } from "../../packages/broker/src/aws/broker/saved-env-rebuild.js";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { checkRebuild, leaseForDispatch } from "../../packages/broker/src/test-env/saved-env.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { sweepSavedEnvBuilds } from "../../packages/broker/src/aws/broker/saved-env-sweep.js";
import { call } from "../support/slack-broker.js";
import { dynamoSavedEnvStore } from "../../packages/broker/src/test-env/saved-env-store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { OMAR } from "../support/developer-task-broker.js";
import { NAME, setupWizardBench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";
import { savedEnvWorld } from "../support/saved-env-world.js";

afterEach(() => { delete process.env.SAVED_ENV_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const HEAD = "d".repeat(40);
const INPUTS: SavedEnvBuildInputs = { baseImageDigest: `sha256:${"b".repeat(64)}`, secretNames: ["NPM_TOKEN"], detectorGlobs: ["**/conftest.py"] };
const ids = { orgId: TEST_ORG, projectId: NAME };

async function world() {
  process.env.TEST_ENVIRONMENT_ENABLED = "1";
  const w = savedEnvWorld({ ids, now: Date.now(), heads: new Map([["web", HEAD]]) });
  const t = await setupWizardBench({ brokerExtra: { savedEnvDeps: w.deps } });
  const digest = await t.approveFirst();
  w.state.approved = { revision: 1, digest };
  process.env.SAVED_ENV_ENABLED = "1";
  const dependencies = brokerDependencies(t.brokerInput as never);
  const queue = async () => {
    const checked = await checkRebuild(w.deps, w.ids, "poll");
    if (!checked.ok || !checked.queued) throw new Error(`not queued ${JSON.stringify(checked)}`);
    return checked.job;
  };
  const start = (inputs: SavedEnvBuildInputs | null = INPUTS) => startSavedEnvRebuild(dependencies, w.ids, async () => inputs ?? undefined);
  const workspaces = () => t.db.find((item) => item.entityType === "WORKSPACE");
  const outbox = () => t.db.find((item) => item.entityType === "OUTBOX");
  /** What this job's start left: the operation made for a job, its workspace and its outbox record. */
  const mine = () => {
    const operation = t.db.find((item) => item.entityType === "OPERATION" && item.savedEnvJobId !== undefined)[0] as Record<string, unknown> | undefined;
    return { operation, workspace: operation === undefined ? undefined : workspaces().find((item) => item.id === operation.workspaceId), outbox: operation === undefined ? undefined : outbox().find((item) => item.operationId === operation.id) };
  };
  return { t, w, digest, queue, start, workspaces, outbox, mine, dependencies };
}

describe("starting the job", () => {
  it("makes a read-only preparation on a fresh workspace of the approver, pinned to the job's commits, carrying the build and no credential", async () => {
    const { t, w, digest, queue, start, mine } = await world();
    const job = await queue();
    const started = await start();
    expect(started).toMatchObject({ started: true });
    const workspace = mine().workspace as Record<string, unknown>;
    expect(workspace).toMatchObject({ ownerKey: OMAR.developerId, orgId: TEST_ORG, projectName: NAME, status: "PREPARING" });
    // not the approver's default workspace, and no membership change
    expect(t.db.find((item) => item.entityType === "DEFAULT_WORKSPACE" && item.workspaceId === workspace.id)).toEqual([]);
    const operation = mine().operation!;
    expect(operation).toMatchObject({ kind: "prepare", savedEnvJobId: job.jobId, preparePins: [{ repository: "web", commit: HEAD }] });
    const invocation = WorkerInvocationSchema.parse((mine().outbox as unknown as { invocation: unknown }).invocation);
    if (invocation.kind !== "prepare") throw new Error("not a preparation");
    expect(invocation.payload).toMatchObject({ readOnly: true, pins: [{ repository: "web", commit: HEAD }] });
    expect(invocation.payload.savedEnvBuild).toMatchObject({
      jobId: job.jobId, reason: "no_image", approved: { revision: 1, digest }, repository: savedEnvRepositoryName({ env: "test", orgId: TEST_ORG, projectId: NAME }), commits: { web: HEAD },
      baseImageDigest: INPUTS.baseImageDigest, secretNames: ["NPM_TOKEN"], detectorGlobs: ["**/conftest.py"],
    });
    expect(invocation.payload.savedEnvBuild?.leaseToken).toBeUndefined();
    // the lease token is nowhere in what is stored, and the job has not been given out
    const token = w.row()!.job!.leaseToken;
    expect(JSON.stringify(t.db.find(() => true))).not.toContain(token);
    expect(w.row()!.job!.dispatchedAt).toBeUndefined();
  });

  it("starts one workspace per job: a retried trigger finds the job already started", async () => {
    const { queue, start, workspaces } = await world();
    await queue();
    const before = workspaces().length;
    expect(await start()).toMatchObject({ started: true });
    expect(await start()).toEqual({ started: false, why: "already_started" });
    expect(workspaces()).toHaveLength(before + 1);
  });

  it("starts nothing, and writes nothing, when the job cannot be built for: switch off, nothing queued, a moved approval, no approver, a missing commit, no build inputs", async () => {
    const off = await world();
    await off.queue();
    const counts = new Map<unknown, number>();
    counts.set(off, off.workspaces().length);
    delete process.env.SAVED_ENV_ENABLED;
    expect(await off.start()).toEqual({ started: false, why: "disabled" });

    const none = await world();
    expect(await none.start()).toEqual({ started: false, why: "nothing_queued" });

    const moved = await world();
    await moved.queue();
    moved.w.state.approved = { revision: 1, digest: "9".repeat(64) };
    const job = moved.w.row()!.job!;
    moved.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...moved.w.row()!, job: { ...job, approved: { revision: 1, digest: "9".repeat(64) } } });
    expect(await moved.start()).toEqual({ started: false, why: "approved_moved" });

    const noOwner = await world();
    await noOwner.queue();
    for (const item of noOwner.t.db.find((row) => String(row.sk).startsWith("TESTENV") || row.approvedBy !== undefined)) if (item.approvedBy !== undefined) noOwner.t.db.set({ ...item, approvedBy: "" });
    expect(await noOwner.start()).toEqual({ started: false, why: "no_owner" });

    const partial = await world();
    await partial.queue();
    const row = partial.w.row()!;
    partial.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...row, job: { ...row.job!, commits: { other: HEAD } } });
    expect(await partial.start()).toEqual({ started: false, why: "commits_mismatch" });

    const bare = await world();
    await bare.queue();
    expect(await bare.start(null)).toEqual({ started: false, why: "no_build_inputs" });

    for (const run of [off, none, moved, noOwner, partial, bare]) expect(run.mine().operation, "nothing was started").toBeUndefined();
  });

  it("does not start for a job whose lease has run out, or a project that was archived or turned off", async () => {
    const expired = await world();
    await expired.queue();
    expired.w.clock.now += 4 * 3_600_000;
    expect(await expired.start()).toEqual({ started: false, why: "nothing_queued" });
    const off = await world();
    await off.queue();
    off.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...off.w.row()!, enabled: false });
    expect(await off.start()).toEqual({ started: false, why: "nothing_queued" });
    const given = await world();
    await given.queue();
    const row = given.w.row()!;
    given.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...row, job: { ...row.job!, dispatchedAt: new Date().toISOString() } });
    expect(await given.start()).toEqual({ started: false, why: "nothing_queued" });
    expect(expired.mine().operation).toBeUndefined();
    expect(off.mine().operation).toBeUndefined();
    expect(given.mine().operation).toBeUndefined();
  });
});

// ---- delivery: the lease token is added when the invocation goes to the worker

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
const binding: Ec2RuntimeBinding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const };

async function buildRecord(): Promise<{ record: Ec2OutboxRecord; jobId: string }> {
  const { queue, start, mine } = await world();
  const job = await queue();
  await start();
  const record = mine().outbox as unknown as Ec2OutboxRecord;
  return { record, jobId: job.jobId };
}

function delivery(overrides: Partial<Ec2DeliveryDependencies> = {}) {
  const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
  const dependencies: Ec2DeliveryDependencies = {
    sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) }, binding: async () => binding, sign: kmsSign, post, progress: async () => undefined,
    applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined, now: () => Date.now(),
    workerFeatures: async () => [...WORKER_INVOCATION_FEATURES],
    ...overrides,
  };
  return { deliver: createEc2Delivery(dependencies), post };
}
const sentInvocation = (post: ReturnType<typeof delivery>["post"]): WorkerInvocation => WorkerInvocationSchema.parse(JSON.parse(post.mock.calls[0]![1].body));

describe("delivery", () => {
  it("puts the lease token in the invocation the worker is sent, once per delivery, and leaves the stored record without it", async () => {
    const { record, jobId } = await buildRecord();
    const lease = vi.fn(async (_record: Ec2OutboxRecord, id: string) => (id === jobId ? "L".repeat(40) : undefined));
    const { deliver, post } = delivery({ savedEnvBuildLease: lease });
    await expect(deliver(record, record.invocation)).resolves.toBe("DELIVERED");
    const sent = sentInvocation(post);
    expect(sent.kind === "prepare" && sent.payload.savedEnvBuild?.leaseToken).toBe("L".repeat(40));
    expect(lease).toHaveBeenCalledWith(record, jobId);
    expect(JSON.stringify(record)).not.toContain("L".repeat(40));
  });

  it("does not deliver a job whose lease is gone (already handed out, expired, moved on): nothing is posted", async () => {
    const { record } = await buildRecord();
    const { deliver, post } = delivery({ savedEnvBuildLease: async () => undefined });
    await expect(deliver(record, record.invocation)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses to deliver a build without the lease function (a wiring error), and never sends it to a worker that lacks the feature", async () => {
    const { record } = await buildRecord();
    const bare = delivery();
    await expect(bare.deliver(record, record.invocation)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(bare.post).not.toHaveBeenCalled();
    const lease = vi.fn(async () => "L".repeat(40));
    const older = delivery({ savedEnvBuildLease: lease, workerFeatures: async () => WORKER_INVOCATION_FEATURES.filter((feature) => feature !== PREPARE_SAVED_ENV_BUILD_FEATURE) });
    await expect(older.deliver(record, record.invocation)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(older.post).not.toHaveBeenCalled();
    expect(lease).not.toHaveBeenCalled();
  });

  it("does not take the lease for a preparation that carries no build", async () => {
    const { record } = await buildRecord();
    const plain = structuredClone(record);
    if (plain.invocation.kind === "prepare") delete plain.invocation.payload.savedEnvBuild;
    const lease = vi.fn(async () => "L".repeat(40));
    const { deliver, post } = delivery({ savedEnvBuildLease: lease });
    await expect(deliver(plain, plain.invocation)).resolves.toBe("DELIVERED");
    expect(lease).not.toHaveBeenCalled();
    expect(sentInvocation(post)).toMatchObject({ kind: "prepare" });
  });
});

// ---- the dispatcher's lease: leaseForDispatch over the real store

describe("the dispatcher's lease", () => {
  async function leased() {
    const db = new FakeDynamoDb({ indexKeys: { [WORKFLOW_DISPATCH_DUE_INDEX.name]: { partition: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sort: WORKFLOW_DISPATCH_DUE_INDEX.sortKey } } });
    const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
    const w = savedEnvWorld({ ids: { orgId, projectId: NAME }, now: Date.now() });
    // the registry's own writes go through the Dynamo store (with no audit ledger: the queue entry would need one, so it is seeded as the row alone)
    const store = dynamoSavedEnvStore({ documentClient: db, tableName: "state", now: Date.now });
    const job = { jobId: "job-1", leaseToken: "T".repeat(40), reason: "no_image" as const, approved: { revision: 1, digest: "a".repeat(64) }, commits: { web: HEAD }, expectedKey: "c".repeat(64), createdAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 3_600_000).toISOString() };
    await store.commit({ orgId, projectId: NAME, version: 1, enabled: true, images: [], job, health: "never_proved" }, null, { action: "activity", orgId, projectId: NAME, at: new Date().toISOString() });
    const workspaceId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, orgId, projectName: NAME });
    const record = { workspaceId } as Ec2OutboxRecord;
    return { db, store, lease: createSavedEnvBuildLease({ documentClient: db as never, tableName: "state", env: { SAVED_ENV_ENABLED: "1" } }), record, orgId, w };
  }

  it("hands the token to the operation it was made for, again to the same operation, and to no other", async () => {
    const { lease, record, store, orgId } = await leased();
    const mine = { ...record, operationId: "op-1" };
    expect(await lease(mine, "job-1")).toBe("T".repeat(40));
    expect((await store.get(orgId, NAME))?.job).toMatchObject({ dispatchedOperationId: "op-1" });
    expect(await lease(mine, "job-1")).toBe("T".repeat(40));
    expect(await lease({ ...record, operationId: "op-2" }, "job-1")).toBeUndefined();
  });

  it("does not take the lease for another job, and gives nothing while the switch is off", async () => {
    const { lease, record, store, orgId, db } = await leased();
    expect(await lease({ ...record, operationId: "op-1" }, "another-job")).toBeUndefined();
    expect((await store.get(orgId, NAME))?.job?.dispatchedAt).toBeUndefined();
    const off = createSavedEnvBuildLease({ documentClient: db as never, tableName: "state", env: {} });
    expect(await off({ ...record, operationId: "op-1" }, "job-1")).toBeUndefined();
    expect((await store.get(orgId, NAME))?.job?.dispatchedAt).toBeUndefined();
  });

  it("never hands over the token of a job that replaced the one the operation was made for between the check and the hand-over", async () => {
    const { db, record, orgId } = await leased();
    let reads = 0;
    const racing = { send: async (command: unknown) => {
      const answer = await (db as unknown as { send(command: unknown): Promise<unknown> }).send(command);
      const item = (answer as { Item?: Record<string, unknown> }).Item;
      if (item?.entityType === "SAVED_ENV" && (reads += 1) === 1) {
        // another job takes over after the first read
        db.set({ ...item, version: 2, job: { ...(item.job as object), jobId: "job-2", leaseToken: "N".repeat(40) } });
      }
      return answer;
    } };
    const lease = createSavedEnvBuildLease({ documentClient: racing as never, tableName: "state", env: { SAVED_ENV_ENABLED: "1" } });
    expect(await lease({ ...record, operationId: "op-1" }, "job-1")).toBeUndefined();
    void orgId;
  });

  it("reads the table name when it is used, not when the lease is made", async () => {
    const { db, record, orgId } = await leased();
    const before = process.env["STATE_TABLE_NAME"];
    delete process.env["STATE_TABLE_NAME"];
    try {
      const lease = createSavedEnvBuildLease({ documentClient: db as never, env: { SAVED_ENV_ENABLED: "1" } });
      process.env["STATE_TABLE_NAME"] = "state";
      expect(await lease({ ...record, operationId: "op-1" }, "job-1")).toBe("T".repeat(40));
    } finally { if (before === undefined) delete process.env["STATE_TABLE_NAME"]; else process.env["STATE_TABLE_NAME"] = before; }
    void orgId;
  });

  it("gives nothing for a workspace it cannot place", async () => {
    const { lease } = await leased();
    expect(await lease({ workspaceId: randomUUID() } as Ec2OutboxRecord, "job-1")).toBeUndefined();
  });
});

// ---- who it runs as, and that the workspace is out of every list

describe("who a rebuild runs as", () => {
  it("is the approver while they are an active member of the company, through one named seam", async () => {
    const { w, queue, start, dependencies } = await world();
    await queue();
    expect(await ownerForAutomaticRun(dependencies, { orgId: TEST_ORG, project: NAME, approvedRevision: 1 })).toBe(OMAR.developerId);
    expect(await start()).toMatchObject({ started: true });
    void w;
  });

  it("is nobody when the approver is no longer a member of the company, or the revision has no approver: the start is refused and nothing is written", async () => {
    const { t, queue, start, dependencies, mine } = await world();
    await queue();
    for (const item of t.db.find((row) => row.approvedBy !== undefined)) t.db.set({ ...item, approvedBy: "dev-who-left" });
    expect(await ownerForAutomaticRun(dependencies, { orgId: TEST_ORG, project: NAME, approvedRevision: 1 })).toBeUndefined();
    expect(await start()).toEqual({ started: false, why: "no_owner" });
    expect(mine().operation).toBeUndefined();
    // a member of ANOTHER company is not an owner here
    for (const item of t.db.find((row) => row.approvedBy !== undefined)) t.db.set({ ...item, approvedBy: OMAR.developerId });
    expect(await ownerForAutomaticRun(dependencies, { orgId: "org_zzzzzzzzzzzzzzzzzzzz", project: NAME, approvedRevision: 1 })).toBeUndefined();
  });

  it("writes the workspace without the project index attributes, so it is in no list of workspaces", async () => {
    const { queue, start, mine } = await world();
    await queue();
    await start();
    const workspace = mine().workspace!;
    expect(workspace[WORKSPACE_PROJECT_INDEX.partitionKey]).toBeUndefined();
    expect(workspace[WORKSPACE_PROJECT_INDEX.sortKey]).toBeUndefined();
    expect(workspace).toMatchObject({ entityType: "WORKSPACE", status: "PREPARING", ownerKey: OMAR.developerId });
  });
});

// ---- the lease routes answer to the capability, long after the repository grant is gone

const HEADERS = (capability: string) => ({ "x-agentx-callback-capability": capability });

describe("the lease routes, with time moved on", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function running() {
    const built = await world();
    const job = await built.queue();
    const started = await built.start();
    if (!started.started) throw new Error("not started");
    const invocation = WorkerInvocationSchema.parse((built.mine().outbox as unknown as { invocation: unknown }).invocation);
    if (invocation.kind !== "prepare") throw new Error("not a preparation");
    const leased = await leaseForDispatch(built.w.deps, built.w.ids, started.operationId);
    if (!leased.ok) throw new Error("not leased");
    const path = (route: string) => `/v1/internal/workspaces/${started.workspaceId}/operations/${started.operationId}/${route}`;
    const result = () => SavedEnvBuildResultSchema.parse({
      ok: true, repository: savedEnvRepositoryName({ env: "test", orgId: TEST_ORG, projectId: NAME }), tag: "kcccc-1", imageDigest: `sha256:${"7".repeat(64)}`,
      manifest: { schemaVersion: 1, environmentKey: "c".repeat(64), testEnvRevision: 1, commits: [{ repositoryId: "web", sha: HEAD }], proveReportDigest: "b".repeat(64), imageDigest: `sha256:${"7".repeat(64)}`, builtAt: new Date().toISOString() },
    });
    return { ...built, job, started, invocation, token: leased.job.leaseToken, path, result };
  }

  it("answer to the callback capability and the lease for the whole lease, when the real repository grant (15 minutes) has long expired", async () => {
    const r = await running();
    const grant = r.invocation.payload.repositoryGrant;
    expect(() => r.dependencies.repositoryGrants.inspect(grant)).not.toThrow();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    r.w.clock.now += 2 * 3_600_000;
    // the grant that the lease routes used to need is gone ...
    expect(() => r.dependencies.repositoryGrants.inspect(grant)).toThrow();
    // ... and the push login and the result still work
    const login = await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: HEADERS(r.invocation.callbackCapability), body: { jobId: r.job.jobId, leaseToken: r.token } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.login).toMatchObject({ repository: savedEnvRepositoryName({ env: "test", orgId: TEST_ORG, projectId: NAME }), username: "AWS" });
    const recorded = await call(r.t.handler, { method: "POST", path: r.path("saved-env-result"), headers: HEADERS(r.invocation.callbackCapability), body: { jobId: r.job.jobId, leaseToken: r.token, result: r.result() } });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body).toMatchObject({ recorded: true });
    expect(r.w.row()?.images[0]?.digest).toBe(`sha256:${"7".repeat(64)}`);
  });

  it("refuse the repository grant alone, no capability, another operation's capability, a capability without these actions, and a wrong lease", async () => {
    const r = await running();
    const body = { jobId: r.job.jobId, leaseToken: r.token };
    const grantOnly = await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: { "x-agentx-repository-grant": r.invocation.payload.repositoryGrant }, body });
    expect(grantOnly.status).toBeGreaterThanOrEqual(400);
    expect((await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: {}, body })).status).toBeGreaterThanOrEqual(400);
    // refused (a capability for another operation, or without these actions, is forbidden or stale; never accepted)
    const other = issueCapability(r.dependencies, r.started.workspaceId, randomUUID(), 1, { savedEnvBuild: true });
    expect((await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: HEADERS(other), body })).status).toBeGreaterThanOrEqual(400);
    const plain = issueCapability(r.dependencies, r.started.workspaceId, r.started.operationId, 1);
    expect((await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: HEADERS(plain), body })).status).toBeGreaterThanOrEqual(400);
    expect((await call(r.t.handler, { method: "POST", path: r.path("saved-env-result"), headers: HEADERS(plain), body: { ...body, result: r.result() } })).status).toBeGreaterThanOrEqual(400);
    expect((await call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: HEADERS(r.invocation.callbackCapability), body: { ...body, leaseToken: "x".repeat(40) } })).status).toBe(403);
    expect(r.w.row()?.images).toEqual([]);
  });

  it("count each push login against the operation: three, then refused", async () => {
    const r = await running();
    const ask = () => call(r.t.handler, { method: "POST", path: r.path("saved-env-push-login"), headers: HEADERS(r.invocation.callbackCapability), body: { jobId: r.job.jobId, leaseToken: r.token } });
    expect([(await ask()).status, (await ask()).status, (await ask()).status, (await ask()).status]).toEqual([200, 200, 200, 403]);
    expect(r.t.db.find((item) => item.entityType === "OPERATION" && item.id === r.started.operationId)[0]).toMatchObject({ savedEnvPushLoginCount: 3 });
  });

  it("only a rebuild preparation is given the capability for them", async () => {
    const r = await running();
    const plain = issueCapability(r.dependencies, r.started.workspaceId, r.started.operationId, 1, { savedEnvBuild: true });
    expect(r.invocation.callbackCapability).toBeDefined();
    // the preparation of a task has an ordinary capability: the actions are not in it
    const ordinary = JSON.parse(Buffer.from(issueCapability(r.dependencies, "w", "o", 1).split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(ordinary.actions).not.toContain("saved-env-push-login");
    expect(ordinary.actions).not.toContain("saved-env-result");
    const build = JSON.parse(Buffer.from(plain.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(build.actions).toEqual(expect.arrayContaining(["saved-env-push-login", "saved-env-result"]));
    const own = JSON.parse(Buffer.from(r.invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(own.actions).toEqual(expect.arrayContaining(["saved-env-push-login", "saved-env-result"]));
  });
});

describe("with the switch off the broker is as it was", () => {
  it("answers the saved image paths as unknown paths, before the body is read, and puts no saved image key in the session sweep's answer", async () => {
    const { t } = await world();
    delete process.env.SAVED_ENV_ENABLED;
    const bad = "{not json";
    const w = "11111111-1111-4111-8111-111111111111";
    const ask = (route: string) => t.handler({ rawPath: `/v1/internal/workspaces/${w}/operations/${w}/${route}`, rawQueryString: "", routeKey: "ANY /v1/internal/{proxy+}", headers: { "x-agentx-callback-capability": "x" }, body: bad, requestContext: { requestId: "r", http: { method: "POST" } } });
    // the answer is the answer to any path that does not exist
    const unknown = await ask("not-a-route");
    for (const route of ["saved-env-push-login", "saved-env-result", "saved-env-fallback"]) {
      const reply = await ask(route);
      expect(reply.statusCode, route).toBe(unknown.statusCode);
      expect(reply.body, route).toBe(unknown.body);
    }
    const swept = await t.handler({ source: "agentx.session-sweep" });
    const answer = JSON.parse((swept as { body?: string }).body ?? JSON.stringify(swept)) as Record<string, unknown>;
    expect(Object.keys(answer).filter((key) => key.startsWith("savedEnv"))).toEqual([]);
    process.env.SAVED_ENV_ENABLED = "1";
    const on = await t.handler({ source: "agentx.session-sweep" });
    const onAnswer = JSON.parse((on as { body?: string }).body ?? JSON.stringify(on)) as Record<string, unknown>;
    expect(Object.keys(onAnswer)).toEqual(expect.arrayContaining(["savedEnv", "savedEnvBuilds"]));
  });
});

// ---- the end of a build: the job, the workspace, its compute

describe("settling the end of a build", () => {
  async function started() {
    const r = await world();
    const job = await r.queue();
    const begun = await r.start();
    if (!begun.started) throw new Error("not started");
    const marker = () => r.t.db.get(`SAVED_ENV_BUILD_START#${job.jobId}`, "START") as Record<string, unknown>;
    const workspace = () => r.t.db.get(`WORKSPACE#${begun.workspaceId}`, "META") as Record<string, unknown>;
    const operation = () => r.t.db.get(`WORKSPACE#${begun.workspaceId}`, `OPERATION#${begun.operationId}`) as Record<string, unknown>;
    const sweep = () => sweepSavedEnvBuilds(r.dependencies, 10, { SAVED_ENV_ENABLED: "1" });
    // what the setup draft of the harness did to its own workspace is not this build's
    r.t.deleteEc2Session?.mockClear();
    const later = (ms: number) => { r.w.clock.now += ms; vi.setSystemTime(Date.now() + ms); };
    return { ...r, job, begun, marker, workspace, operation, sweep, later };
  }
  const TEN = 11 * 60_000;
  afterEach(() => { vi.useRealTimers(); });

  it("leaves a build that is still running alone and looks at it again later", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    // not due yet
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 0, failed: 0 });
    s.later(TEN);
    const dueBefore = String(s.marker()[WORKFLOW_DISPATCH_DUE_INDEX.sortKey]);
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 1, failed: 0 });
    expect(String(s.marker()[WORKFLOW_DISPATCH_DUE_INDEX.sortKey]) > dueBefore).toBe(true);
    expect(s.t.deleteEc2Session).not.toHaveBeenCalled();
    expect(s.w.row()?.job?.jobId).toBe(s.job.jobId);
    expect(s.workspace().status).toBe("PREPARING");
  });

  it("ends the job and retires the workspace when the operation failed: compute deleted, workspace closed with an expiry, marker settled", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    await s.t.finish(s.begun.workspaceId, s.begun.operationId, "FAILED", { error: "the clone failed" });
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(s.w.row()?.job).toBeUndefined();
    expect(s.w.row()).toMatchObject({ health: "needs_repair", lastFailure: "operation_failed" });
    expect(s.t.deleteEc2Session).toHaveBeenCalledWith(s.begun.workspaceId);
    expect(s.workspace()).toMatchObject({ status: "CLOSED" });
    expect(s.workspace()[INDEX_EXPIRY_ATTRIBUTE]).toBeGreaterThan(Date.now() / 1000);
    expect(s.workspace().activeOperationId).toBeUndefined();
    expect(s.marker().retiredAt).toBeDefined();
    expect(s.marker()[WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]).toBeUndefined();
    // settled once: a second pass finds nothing
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 0, failed: 0 });
    expect(s.t.deleteEc2Session).toHaveBeenCalledTimes(1);
  });

  it("retires the workspace of a build that was recorded (the operation succeeded) without touching the recorded image", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    s.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...s.w.row()!, job: undefined, health: "healthy" });
    await s.t.finish(s.begun.workspaceId, s.begun.operationId, "SUCCEEDED", { result: { manifestPath: "x" } });
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(s.w.row()).toMatchObject({ health: "healthy" });
    expect(s.w.row()?.lastFailure).toBeUndefined();
    expect(s.t.deleteEc2Session).toHaveBeenCalledTimes(1);
  });

  it("ends a build whose lease ran out while its operation never reported (a worker that was lost), and ends the operation", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    s.later(4 * 3_600_000);
    expect(await s.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(s.w.row()).toMatchObject({ health: "needs_repair", lastFailure: "lease_expired" });
    expect(s.operation()).toMatchObject({ status: "FAILED" });
    expect(s.workspace()).toMatchObject({ status: "CLOSED" });
  });

  it("requeues for the heads now when the repository moved since the queue", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    s.w.state.heads = new Map([["web", "9".repeat(40)]]);
    await s.t.finish(s.begun.workspaceId, s.begun.operationId, "FAILED", { error: "the branch moved" });
    s.later(TEN);
    await s.sweep();
    expect(s.w.row()?.job).toMatchObject({ commits: { web: "9".repeat(40) } });
    expect(s.w.row()?.job?.jobId).not.toBe(s.job.jobId);
    expect(s.w.row()?.lastFailure).toBeUndefined();
  });

  it("keeps looking when the compute cannot be deleted just now, and retires it when it can", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    await s.t.finish(s.begun.workspaceId, s.begun.operationId, "FAILED", { error: "x" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    s.t.deleteEc2Session!.mockRejectedValueOnce(agentXError("WORKSPACE_BUSY", "the compute is starting"));
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 1, failed: 0 });
    expect(s.workspace().status).not.toBe("CLOSED");
    expect(s.marker().retiredAt).toBeUndefined();
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(s.workspace()).toMatchObject({ status: "CLOSED" });
  });

  it("ends a build whose job was recorded but whose operation never ended, after a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    s.w.store.rows.set(`${TEST_ORG}#${NAME}`, { ...s.w.row()!, job: undefined, health: "healthy" });
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 1, failed: 0 });
    s.later(25 * 3_600_000);
    expect(await s.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(s.workspace()).toMatchObject({ status: "CLOSED" });
    expect(s.w.row()).toMatchObject({ health: "healthy" });
  });

  it("clears the workspace's active operation when it retires a build whose worker never reported", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    expect(s.workspace().activeOperationId).toBeDefined();
    s.later(4 * 3_600_000);
    await s.sweep();
    expect(s.workspace().activeOperationId).toBeUndefined();
  });

  it("skips a marker that was settled but is still listed by the index, and deletes no compute twice for a workspace that is already closed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const s = await started();
    s.t.db.set({ ...s.marker(), retiredAt: new Date().toISOString() });
    s.later(TEN);
    expect(await s.sweep()).toEqual({ settled: 0, waiting: 0, failed: 0 });
    expect(s.t.deleteEc2Session).not.toHaveBeenCalled();
    // a workspace closed by an earlier pass whose marker was not updated: settled without another delete
    const closed = await started();
    await closed.t.finish(closed.begun.workspaceId, closed.begun.operationId, "FAILED", { error: "x" });
    closed.t.db.set({ ...closed.workspace(), status: "CLOSED", closedAt: new Date().toISOString() });
    closed.t.deleteEc2Session?.mockClear();
    closed.later(TEN);
    expect(await closed.sweep()).toEqual({ settled: 1, waiting: 0, failed: 0 });
    expect(closed.t.deleteEc2Session).not.toHaveBeenCalled();
  });

  it("does nothing with the switch off or no registry", async () => {
    const s = await started();
    expect(await sweepSavedEnvBuilds(s.dependencies, 10, {})).toBe("off");
    expect(await sweepSavedEnvBuilds({ ...s.dependencies, savedEnvDeps: undefined } as never, 10, { SAVED_ENV_ENABLED: "1" })).toBe("off");
  });

  it("gives every start marker an expiry", async () => {
    const s = await started();
    expect(Number(s.marker()[INDEX_EXPIRY_ATTRIBUTE])).toBeGreaterThan(Date.now() / 1000 + 29 * 86_400);
    expect(s.marker()).toMatchObject({ orgId: TEST_ORG, projectId: NAME, jobId: s.job.jobId, workspaceId: s.begun.workspaceId, operationId: s.begun.operationId });
  });
});

describe("a workspace that is not the job's", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("is left alone, and the marker is dropped, when its operation names another job or none", async () => {
    for (const link of ["another-job", undefined] as const) {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const r = await world();
      const job = await r.queue();
      const begun = await r.start();
      if (!begun.started) throw new Error("not started");
      r.t.deleteEc2Session?.mockClear();
      const operationRow = r.t.db.get(`WORKSPACE#${begun.workspaceId}`, `OPERATION#${begun.operationId}`) as Record<string, unknown>;
      const { savedEnvJobId: _gone, ...without } = operationRow;
      void _gone;
      r.t.db.set(link === undefined ? without : { ...operationRow, savedEnvJobId: link });
      await r.t.finish(begun.workspaceId, begun.operationId, "FAILED", { error: "x" });
      r.w.clock.now += 11 * 60_000;
      vi.setSystemTime(Date.now() + 11 * 60_000);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await sweepSavedEnvBuilds(r.dependencies, 10, { SAVED_ENV_ENABLED: "1" });
      expect(r.t.deleteEc2Session, String(link)).not.toHaveBeenCalled();
      expect((r.t.db.get(`WORKSPACE#${begun.workspaceId}`, "META") as Record<string, unknown>).status, String(link)).not.toBe("CLOSED");
      expect(r.t.db.get(`SAVED_ENV_BUILD_START#${job.jobId}`, "START"), String(link)).toBeUndefined();
      vi.useRealTimers();
    }
  });
});
