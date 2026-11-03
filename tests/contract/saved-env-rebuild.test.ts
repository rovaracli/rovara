// Saved project images (SV wiring): the rebuild job on the broker's side. The registry queues a job with its commits; this starts it as a read-only PINNED preparation on a fresh workspace of the approver, and the
// dispatcher hands the lease token to the worker ONCE, at delivery, so the stored invocation never holds it.
// The dispatcher module reads its table name when it loads.
vi.hoisted(() => { process.env["STATE_TABLE_NAME"] ??= "state"; });
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREPARE_SAVED_ENV_BUILD_FEATURE, WORKER_INVOCATION_FEATURES, WORKFLOW_DISPATCH_DUE_INDEX, WorkerInvocationSchema, savedEnvRepositoryName, type Ec2RuntimeBinding, type OrgId, type WorkerInvocation } from "@agentx/contracts";
import { createSavedEnvBuildLease } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { startSavedEnvRebuild, type SavedEnvBuildInputs } from "../../packages/broker/src/aws/broker/saved-env-rebuild.js";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { checkRebuild } from "../../packages/broker/src/test-env/saved-env.js";
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

  it("hands the token over once, for the job the operation was made for", async () => {
    const { lease, record, store, orgId } = await leased();
    expect(await lease(record, "job-1")).toBe("T".repeat(40));
    expect((await store.get(orgId, NAME))?.job?.dispatchedAt).toBeDefined();
    expect(await lease(record, "job-1")).toBeUndefined();
  });

  it("does not take the lease for another job, and gives nothing while the switch is off", async () => {
    const { lease, record, store, orgId, db } = await leased();
    expect(await lease(record, "another-job")).toBeUndefined();
    expect((await store.get(orgId, NAME))?.job?.dispatchedAt).toBeUndefined();
    const off = createSavedEnvBuildLease({ documentClient: db as never, tableName: "state", env: {} });
    expect(await off(record, "job-1")).toBeUndefined();
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
    expect(await lease(record, "job-1")).toBeUndefined();
    void orgId;
  });

  it("gives nothing for a workspace it cannot place", async () => {
    const { lease } = await leased();
    expect(await lease({ workspaceId: randomUUID() } as Ec2OutboxRecord, "job-1")).toBeUndefined();
  });
});
