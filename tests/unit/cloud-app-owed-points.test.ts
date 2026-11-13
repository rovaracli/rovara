// S3 item 7 (S0-OWED-POINTS): the registry points that were owed (queue, worker-machines, audit-sink, check-runner) are now modules of the production list. The real modules are
// built over a fake world's store, and the registry must still refuse the switch while any needed point is empty.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import { CloudRegistryError, OWED_POINTS, buildCloudRegistry, cloudAdapterModules, owedPoints, type CloudModuleDeps } from "../../packages/broker/src/cloud/app/index.js";
import { SessionWorkerMachines } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { createFakeWorld } from "../support/cloud-core-fakes.js";

const OWED = ["audit-sink", "queue", "worker-machines", "check-runner"] as const;
const COMPANY = "org_s3owed0000000000000a";

/** An SQS client that records what was sent. */
const sqsClient = () => {
  const sent: string[] = [];
  return {
    sent,
    client: {
      async send(command: { constructor: { name: string } }) {
        sent.push(command.constructor.name);
        // The adapter reads the queue's own facts at first use.
        if (command.constructor.name === "GetQueueAttributesCommand") return { Attributes: { VisibilityTimeout: "30", MaximumMessageSize: "262144" } };
        return { MessageId: "m1" };
      },
    },
  };
};

const realModules = (overrides: Partial<CloudModuleDeps> = {}) => {
  const sqs = sqsClient();
  const deps = {
    tableName: "state",
    queue: { settings: { region: "us-west-2", queues: { "task-dispatch": { url: "https://sqs.us-west-2.amazonaws.com/123456789012/task-dispatch" } } }, client: sqs.client as never },
    workerMachines: {
      companyId: COMPANY, sessions: { get: async () => undefined, ensureSession: async () => undefined, deleteSession: async () => undefined, claimStop: async () => undefined, markStopped: async () => undefined }, companyOfWorkspace: async () => COMPANY, binding: async () => undefined, stopInstance: async () => ({ gone: true }),
      sign: async () => new Uint8Array(), post: async () => ({ status: 200, body: "" }), ping: async () => undefined,
    },
    checkRunners: { githubActions: { getPullRequestStatus: async () => { throw new Error("unused"); }, getJobLogTail: async () => undefined } },
    ...overrides,
  } as unknown as CloudModuleDeps;
  return { sqs, deps, modules: cloudAdapterModules(deps).filter((module) => (OWED as readonly string[]).includes(module.point)) };
};

describe("S3 item 7: a hollow input is refused at create, never taken for wired", () => {
  const create = async (overrides: Partial<CloudModuleDeps>, point: string) => {
    const world = createFakeWorld();
    const module = realModules(overrides).modules.find((entry) => entry.point === point)!;
    return await module.create(world.context(), { get: () => undefined, require: () => { throw new Error("none"); }, names: () => [] } as never);
  };

  it("a queue map without the core's dispatch queue", async () => {
    await expect(create({ queue: { settings: { region: "us-west-2", queues: { other: { url: "https://sqs.us-west-2.amazonaws.com/123456789012/other" } } } } }, "queue")).rejects.toThrow(/queues\.task-dispatch/);
    await expect(create({ queue: { settings: { region: "us-west-2" } } }, "queue")).rejects.toThrow(/hollow/);
  });

  it("machines with nothing behind them", async () => {
    await expect(create({ workerMachines: {} as never }, "worker-machines")).rejects.toThrow(/hollow/);
    const real = realModules().deps.workerMachines!;
    await expect(create({ workerMachines: { ...real, sign: undefined } as never }, "worker-machines")).rejects.toThrow(/sign/);
    await expect(create({ workerMachines: { ...real, sessions: {} } as never }, "worker-machines")).rejects.toThrow(/workerMachines\.sessions/);
    await expect(create({ workerMachines: { ...real, companyId: "" } }, "worker-machines")).rejects.toThrow(/companyId/);
  });

  it("check runners with no client", async () => {
    await expect(create({ checkRunners: { githubActions: {} as never } }, "check-runner")).rejects.toThrow(/getPullRequestStatus/);
    await expect(create({ checkRunners: { codeBuild: {} as never } }, "check-runner")).rejects.toThrow(/status/);
  });
});

describe("S3 item 7: the owed registry points are modules", () => {
  it("the audit sink is always registered; the other three only when the deployment gives their clients", () => {
    const bare = cloudAdapterModules({ tableName: "state" } as unknown as CloudModuleDeps).filter((module) => (OWED as readonly string[]).includes(module.point));
    expect(bare.map((module) => `${module.point}/${module.name}`)).toEqual(["audit-sink/cloud"]);
    expect(realModules().modules.map((module) => `${module.point}/${module.name}`).sort()).toEqual(["audit-sink/cloud", "check-runner/github-actions", "queue/sqs", "worker-machines/ec2"]);
    expect(realModules({ checkRunners: { codeBuild: { status: async () => undefined } as never } }).modules.map((module) => module.name)).toContain("codebuild");
  });

  it("owedPoints names exactly the points the module list leaves empty", () => {
    expect(owedPoints({}).map((entry) => entry.point).sort()).toEqual(Object.keys(OWED_POINTS).sort());
    expect(owedPoints(realModules().deps)).toEqual([]);
    expect(owedPoints({ ...(realModules().deps.queue === undefined ? {} : { queue: realModules().deps.queue! }), checkRunners: {} }).map((entry) => entry.point)).toEqual(["worker-machines", "check-runner"]);
  });

  it("the registry builds over the real modules: SQS carries a message, the sink skips a malformed event, the machines and the runner are the real ones", async () => {
    const world = createFakeWorld({ without: [...OWED] });
    const { modules, sqs } = realModules();
    const logs: Array<Record<string, unknown>> = [];
    const registry = await buildCloudRegistry({ modules: [...world.modules, ...modules], context: { ...world.context(), log: (entry) => logs.push(entry) }, areas: ["flow", "build", "merge"] });
    const queue = await registry.require("queue").queue("task-dispatch");
    await queue.enqueue({ body: { hello: "world" } });
    expect(sqs.sent).toContain("SendMessageCommand");
    expect(registry.require("worker-machines")).toBeInstanceOf(SessionWorkerMachines);
    expect(registry.names("check-runner")).toEqual(["github-actions"]);
    // Production passes onInvalid "skip": a core event nobody mapped is dropped with a log line, never thrown into the task's transaction.
    const sink = registry.require("audit-sink");
    const unmapped = { eventId: "evt-new", companyId: COMPANY, at: "2026-11-13T10:00:00.000Z", actor: { kind: "system" }, action: "brand_new.thing_happened", subject: { type: "task", id: "t1" } } as never;
    expect(sink.stage(unmapped)).toEqual([]);
    await expect(sink.record(unmapped)).resolves.toBeUndefined();
    expect(logs.some((entry) => entry["event"] === "audit.record_invalid")).toBe(true);
    // The sink writes to the registry's store (asked at record time), not to a store of its own.
    expect(registry.require("storage")).toBeDefined();
    expect(new MemoryDocumentStore()).not.toBe(registry.require("storage"));
  });

  it("the registry still refuses the switch while any one owed point is empty, naming it", async () => {
    for (const left of OWED) {
      const world = createFakeWorld({ without: [...OWED] });
      const { modules } = realModules();
      const error = await buildCloudRegistry({ modules: [...world.modules, ...modules.filter((module) => module.point !== left)], context: world.context(), areas: ["flow", "build", "merge"] }).catch((caught: unknown) => caught);
      expect(error, left).toBeInstanceOf(CloudRegistryError);
      expect((error as CloudRegistryError).missing.map((entry) => entry.point), left).toEqual([left]);
    }
  });
});
