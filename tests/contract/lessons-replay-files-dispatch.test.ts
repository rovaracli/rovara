// Lane 7, the file arm (DECISIONS 50.5, 68): through the real dispatcher. A replay copy's lessons reach the worker as `evalFiles` (a file for its checkout), never as a prompt block or stored text; a worker that does not
// list "task.evalFiles.v1" is not sent the step (it would run the arm with no file and say nothing); a file that cannot be built sends the step without one.
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { evalFilesFromRefs, learnedContextFromRefs, type DeliveryDeps } from "../../packages/broker/src/lessons/deliver.js";
import { InMemorySnapshotStore, buildSnapshot } from "../../packages/broker/src/lessons/replay-snapshot-store.js";
import { InMemoryLessonStore } from "../../packages/broker/src/lessons/store.js";
import { EVAL_FILES_FEATURE, LEARNED_CONTEXT_FEATURE } from "@rovara-code/contracts";
import type { WorkerInvocation } from "../../packages/cloud-contracts/src/protocol.js";
import { Clock, KEY, PROJECT, WS, allSharedTasks, allowAllAccess, lessonRecord, seed, settings } from "../unit/lessons/lesson-helpers.js";

const A = "les_aaaaaaaaaaaaaaaaaa01", B = "les_aaaaaaaaaaaaaaaaaa02";
const SECRET = "Wrap every HTTP call in withRetry from the shared helpers.";
const ann = { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const };
const conv = (id: string, over = {}) => lessonRecord({ id, type: "convention", tier: 1, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], approvals: [ann], scope: {}, ...over });

async function world(mode: "On" | "Off" = "On") {
  const store = new InMemoryLessonStore();
  await seed(store, conv(A, { title: "Use withRetry", body: SECRET }), conv(B, { title: "Live only", body: "Only live." }));
  const snapshots = new InMemorySnapshotStore();
  const snapshot = buildSnapshot({ key: KEY, refs: [{ id: A, version: 1 }], createdBy: "op", at: "2026-11-01T00:00:00.000Z" });
  await snapshots.put(snapshot);
  const deps: DeliveryDeps = { store, snapshots, settings: settings({ mode }), access: { ...allowAllAccess, taskVisibility: allSharedTasks }, identity: async () => ({ principals: [], groups: [] }), now: new Clock().now };
  const refs = (over: Record<string, unknown> = {}) => ({ v: 1 as const, orgId: WS, project: PROJECT, setVersion: 0, stage: "IMPLEMENT" as const, audience: { kind: "shared" as const }, taskId: "copy-1", snapshotId: snapshot.snapshotId, lessons: [{ id: A, version: 1 }], file: { repository: "api" }, ...over });
  return { deps, refs, snapshot };
}

describe("delivery builds the file from the frozen snapshot", () => {
  it("renders the snapshot's lessons in R2's format, for the named repository, and never as a prompt block", async () => {
    const w = await world();
    const files = await evalFilesFromRefs(w.deps, w.refs());
    expect(files).toMatchObject({ repository: "api", lessonsFile: { path: ".rovara/lessons.md" } });
    expect(files?.lessonsFile.content).toContain(SECRET);
    expect(files?.lessonsFile.content).not.toContain("Only live.");
    expect(files?.pointerLine).toContain(".rovara/lessons.md");
    expect(await learnedContextFromRefs(w.deps, w.refs())).toBeUndefined();
  });
  it("delivers nothing for refs that are not a file arm's, a missing snapshot, a lesson the snapshot does not name, or a project whose mode no longer loads", async () => {
    const w = await world();
    expect(await evalFilesFromRefs(w.deps, w.refs({ file: undefined }))).toBeUndefined();
    expect(await evalFilesFromRefs(w.deps, w.refs({ snapshotId: undefined }))).toBeUndefined();
    expect(await evalFilesFromRefs(w.deps, w.refs({ snapshotId: `snp_${"9".repeat(20)}` }))).toBeUndefined();
    expect(await evalFilesFromRefs(w.deps, w.refs({ lessons: [{ id: B, version: 1 }] }))).toBeUndefined();
    expect(await evalFilesFromRefs((await world("Off")).deps, w.refs())).toBeUndefined();
  });
});

describe("the dispatcher sends a copy's file only to a worker that places it", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const };
  async function deliver(features: readonly string[] | undefined, files: Ec2DeliveryDependencies["evalFilesFromRefs"]) {
    const w = await world();
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    const deliverEc2 = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, setupRecipesNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
      binding: async () => binding, sign: kmsSign, post, progress: async () => undefined, now: () => Date.parse("2026-11-01T12:00:00.000Z"),
      ...(features === undefined ? {} : { workerFeatures: async () => features }),
      learnedFromRefs: async (refs) => learnedContextFromRefs(w.deps, refs), ...(files === undefined ? {} : { evalFilesFromRefs: files }),
    });
    const markFailed = vi.fn(async () => undefined), markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, maxAttempts: 1, log: () => undefined });
    const operationId = randomUUID(), workspaceId = randomUUID();
    const invocation = { protocolVersion: 1, kind: "task", operationId, workspaceId, fence: 2, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "do it", learnedRefs: w.refs() } } as WorkerInvocation;
    const queued: Ec2OutboxRecord = { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation };
    await handler({ Records: [{ messageId: "m", body: JSON.stringify(queued) }] });
    const body = post.mock.calls[0]?.[1]?.body;
    return { w, post, markFailed, markDelivered, queued, sent: body === undefined ? undefined : (JSON.parse(body) as { payload: Record<string, unknown> }) };
  }
  const build = (w: Awaited<ReturnType<typeof world>>) => async (refs: Parameters<NonNullable<Ec2DeliveryDependencies["evalFilesFromRefs"]>>[0]) => evalFilesFromRefs(w.deps, refs);

  it("a worker that lists the feature gets evalFiles, and no learnedRefs or learnedContext; the queued copy holds ids, not the lesson's words", async () => {
    const w = await world();
    const run = await deliver([LEARNED_CONTEXT_FEATURE, EVAL_FILES_FEATURE], build(w));
    expect(run.markDelivered).toHaveBeenCalledTimes(1);
    expect(run.sent?.payload).toMatchObject({ evalFiles: { repository: "api", lessonsFile: { path: ".rovara/lessons.md" } } });
    expect(JSON.stringify(run.sent)).toContain(SECRET);
    expect(run.sent?.payload).not.toHaveProperty("learnedRefs");
    expect(run.sent?.payload).not.toHaveProperty("learnedContext");
    expect(JSON.stringify(run.queued)).not.toContain(SECRET);
  });
  it("a worker that does not list it is refused the step, whatever else it lists", async () => {
    const w = await world();
    for (const features of [[LEARNED_CONTEXT_FEATURE], ["task.workflowMode"]]) {
      const run = await deliver(features, build(w));
      expect(run.post).not.toHaveBeenCalled();
      expect(run.markDelivered).not.toHaveBeenCalled();
    }
  });
  it("a file that cannot be built sends the step without one (the arm then records that it loaded nothing)", async () => {
    const run = await deliver([LEARNED_CONTEXT_FEATURE, EVAL_FILES_FEATURE], async () => { throw new Error("db down"); });
    expect(run.markDelivered).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(run.sent)).not.toMatch(/evalFiles|learnedRefs|learnedContext|withRetry/u);
  });
});
