// Convergence lane A4 (cloud/ec2-machines): the dispatcher Lambda as the host of Rovara Code's `runDispatchOnce`, over Cloud's EC2 machines adapter.
// Code's task flow (the vendored core, on Code's in-memory store and queue) starts tasks for two companies; their dispatch messages reach the dispatcher as an
// SQS batch, the core hands each operation to that company's EC2 machines, and the worker (which checks each token as the real one does) is given each job once.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition, type QueueService } from "@rovara-code/contracts";
import { RepositoryGrantService } from "@rovara-code/broker";
import { MemoryDocumentStore, MemoryQueueService, createAllowAllAdmission, createNoopAuditSink, createTransactionalOutbox, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { TASK_FLOW_INDEXES, createOwnerTaskAccess, createStoreProjectSource, createTaskFlow, workspaceKey, type TaskFlow, type TaskFlowDeps } from "@rovara-code/broker/core/task-flow";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { coreDispatchMessage, createCoreDispatchHost, type CoreDispatchHostDependencies } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import { COMPANY_A, COMPANY_B, createSessionMachinesWorld } from "../support/session-machines-world.js";

const QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:dispatch";
const definition: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

interface SqsRecord { messageId: string; receiptHandle: string; body: string; eventSource: string; eventSourceARN: string; attributes: { ApproximateReceiveCount: string } }

/** Code's task flow for two companies on one store and one queue, and Cloud's EC2 machines for each. */
async function createWorld(options: { enabled?: boolean } = {}) {
  const machinesWorld = createSessionMachinesWorld();
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  const queues = new MemoryQueueService();
  const grants = new RepositoryGrantService(Buffer.alloc(32, 5), async () => ({ token: "unused" }));
  const companyOfWorkspace = async (workspaceId: string): Promise<OrgId | undefined> => ((await store.get(workspaceKey(workspaceId)))?.companyId as OrgId | undefined);
  const depsOf = (companyId: OrgId, dispatchQueues: QueueService = queues): TaskFlowDeps => {
    const deps: TaskFlowDeps = {
      companyId, store, queues: dispatchQueues, outbox: createTransactionalOutbox({ store, queues }),
      machines: machinesWorld.machinesFor(companyId, { companyOfWorkspace }),
      admission: createAllowAllAdmission(), audit: createNoopAuditSink(), projects: createStoreProjectSource(store, companyId), access: createOwnerTaskAccess(),
      repositoryGrants: grants, callbackSigningKey: Buffer.alloc(32, 9), limits: { member: 5, organization: 20 },
    };
    return deps;
  };
  const flows = new Map<OrgId, TaskFlow>();
  for (const company of [COMPANY_A, COMPANY_B]) {
    await store.put({ item: { ...projectRevisionKey(company, definition.name, definition.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(company, definition.name), entityType: "PROJECT_CATALOG", latestRevision: definition.revision } });
    flows.set(company, createTaskFlow(depsOf(company)));
  }
  const changeVisibility = vi.fn<CoreDispatchHostDependencies["changeVisibility"]>(async () => undefined);
  const depsFor = vi.fn((companyId: OrgId, dispatchQueues: Parameters<CoreDispatchHostDependencies["depsFor"]>[1]) => depsOf(companyId, dispatchQueues));
  const host = createCoreDispatchHost({ enabled: () => options.enabled ?? true, companyOfWorkspace, depsFor, changeVisibility, log: () => undefined });
  const deliverEc2 = vi.fn(async () => "DELIVERED" as const);
  const markDispatching = vi.fn(async () => true);
  const handler = createDispatcherHandler({
    queueArn: QUEUE_ARN, coreDispatch: host, deliverEc2, markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined, maxAttempts: 50, log: () => undefined,
  });
  /** Takes the core's staged dispatch messages off its queue, as the outbox relay would put them on SQS. */
  const staged = async (): Promise<SqsRecord[]> => {
    const queue = await queues.queue("task-dispatch");
    const messages = await queue.receive({ maxMessages: 10 });
    for (const message of messages) await queue.ack(message.receiptHandle);
    return messages.map((message) => ({ messageId: randomUUID(), receiptHandle: `rh-${randomUUID()}`, body: JSON.stringify(message.body), eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" } }));
  };
  const again = (record: SqsRecord): SqsRecord => ({ ...record, receiptHandle: `rh-${randomUUID()}`, attributes: { ApproximateReceiveCount: String(Number(record.attributes.ApproximateReceiveCount) + 1) } });
  const start = async (company: OrgId) => (await flows.get(company)!.start({ principal: localOwnerPrincipal({ companyId: company }), client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint" })).task;
  return { machinesWorld, store, flows, host, handler, deliverEc2, markDispatching, changeVisibility, depsFor, staged, again, start };
}

const failures = (answer: unknown) => (answer as { batchItemFailures: Array<{ itemIdentifier: string }> }).batchItemFailures.map((failure) => failure.itemIdentifier);

describe("the dispatcher as the host of the core's dispatch", () => {
  it("hands each operation to its own company's EC2 machine, once, after the machine is ready, and acknowledges it only then", async () => {
    const w = await createWorld();
    const taskA = await w.start(COMPANY_A);
    const taskB = await w.start(COMPANY_B);
    let batch = await w.staged();
    expect(batch).toHaveLength(2);

    // First receive: both machines are starting. Nothing is sent, each record is hidden to come back (never deleted), and each company got its own deps.
    expect(failures(await w.handler({ Records: batch }))).toEqual(batch.map((record) => record.messageId));
    expect(w.changeVisibility).toHaveBeenCalledTimes(2);
    expect(w.changeVisibility.mock.calls.map(([handle]) => handle).sort()).toEqual(batch.map((record) => record.receiptHandle).sort());
    expect(w.depsFor.mock.calls.map(([company]) => company).sort()).toEqual([COMPANY_A, COMPANY_B]);
    expect(w.machinesWorld.posts).toEqual([]);
    await w.machinesWorld.settle();

    // Second receive: both ready; each job goes to the instance of its own workspace, the token passes the worker's own check, and both records are done.
    batch = batch.map(w.again);
    expect(failures(await w.handler({ Records: batch }))).toEqual([]);
    const accepted = w.machinesWorld.posts.filter((post) => post.status === 200);
    expect(accepted.map((post) => post.workspaceId).sort()).toEqual([taskA.workspaceId, taskB.workspaceId].sort());
    for (const instance of w.machinesWorld.instances.values()) expect(instance.accepted.size).toBe(1);
    // Today's path saw none of it.
    expect(w.deliverEc2).not.toHaveBeenCalled();
    expect(w.markDispatching).not.toHaveBeenCalled();

    // SQS delivers a record again: the worker is handed the same operation, says it already has it, and runs it once.
    expect(failures(await w.handler({ Records: [w.again(batch[0]!)] }))).toEqual([]);
    for (const instance of w.machinesWorld.instances.values()) expect(instance.accepted.size).toBe(1);
    expect(w.machinesWorld.posts.filter((post) => post.status !== 200)).toEqual([]);
  });

  it("keeps the core's fences: a job whose workspace was closed before the machine was ready is ended, never sent, and its machine is ended", async () => {
    const w = await createWorld();
    const task = await w.start(COMPANY_A);
    const batch = await w.staged();
    expect(failures(await w.handler({ Records: batch }))).toHaveLength(1);
    await w.machinesWorld.settle();
    await w.flows.get(COMPANY_A)!.close({ principal: localOwnerPrincipal({ companyId: COMPANY_A }), client: "test" }, task.taskId);
    await w.machinesWorld.settle();
    expect(failures(await w.handler({ Records: batch.map(w.again) }))).toEqual([]);
    expect(w.machinesWorld.posts).toEqual([]);
    expect([...w.machinesWorld.instances.values()].filter((instance) => instance.running)).toEqual([]);
  });

  it("never runs a company's operation on another company's machines, even when its message says the workspace of another company", async () => {
    const w = await createWorld();
    const taskA = await w.start(COMPANY_A);
    const [record] = await w.staged();
    // The workspace is moved to company B after the message was staged: the host gives the message to B's deps, and B's core finds the operation is not B's.
    // It sets the message aside (dead letter); with no dead-letter function the record is kept for the queue's redrive policy, never deleted and never run.
    const workspace = (await w.store.get(workspaceKey(taskA.workspaceId)))!;
    await w.store.put({ item: { ...workspace, companyId: COMPANY_B } });
    expect(failures(await w.handler({ Records: [record!] }))).toEqual([record!.messageId]);
    expect(w.changeVisibility).not.toHaveBeenCalled();
    expect(w.depsFor.mock.calls.map(([company]) => company)).toEqual([COMPANY_B]);
    expect(w.machinesWorld.executions).toEqual([]);
    expect(w.machinesWorld.posts).toEqual([]);
  });

  it("takes nothing with the switch off: a core message goes down today's path, and a batch of today's records is not touched by the host", async () => {
    const off = await createWorld({ enabled: false });
    await off.start(COMPANY_A);
    const batch = await off.staged();
    // Today's path cannot read a core message as an outbox record: it is retried, as any record it cannot parse.
    expect(failures(await off.handler({ Records: batch }))).toEqual([batch[0]!.messageId]);
    expect(off.depsFor).not.toHaveBeenCalled();
    expect(off.machinesWorld.executions).toEqual([]);

    const on = await createWorld();
    const outbox = { messageId: randomUUID(), receiptHandle: "rh", eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" }, body: JSON.stringify({ id: randomUUID(), operationId: randomUUID(), workspaceId: randomUUID(), deploymentMode: "ec2-ebs", invocation: { not: "a core message" } }) };
    expect(on.host.take([outbox])).toEqual(new Set());
  });

  it("reads a core message strictly: exactly its three fields, version 1 and two UUIDs", () => {
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    expect(coreDispatchMessage(JSON.stringify({ v: 1, workspaceId, operationId }))).toEqual({ v: 1, workspaceId, operationId });
    for (const body of [
      JSON.stringify({ v: 2, workspaceId, operationId }), JSON.stringify({ v: 1, workspaceId, operationId, invocation: {} }), JSON.stringify({ v: 1, workspaceId: "ws-1", operationId }),
      JSON.stringify([1]), "not json", JSON.stringify({ v: 1, workspaceId }),
    ]) expect(coreDispatchMessage(body)).toBeUndefined();
  });

  it("never drops a record it could not place: an unknown workspace, or a fault in the core, leaves the record to come back", async () => {
    const w = await createWorld();
    const unknown = { messageId: randomUUID(), receiptHandle: "rh-1", eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" }, body: JSON.stringify({ v: 1, workspaceId: randomUUID(), operationId: randomUUID() }) };
    expect(failures(await w.handler({ Records: [unknown] }))).toEqual([unknown.messageId]);
    expect(w.depsFor).not.toHaveBeenCalled();

    await w.start(COMPANY_A);
    const [record] = await w.staged();
    w.depsFor.mockImplementationOnce(() => { throw new Error("the store is unreachable"); });
    expect(failures(await w.handler({ Records: [record!] }))).toEqual([record!.messageId]);
  });
});
