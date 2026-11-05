// 058-stop-close (QA6-13): a Stop that reaches the worker before the task it targets is running used to fail with NOT_FOUND ("active operation not found"). The broker then
// left the task INTERRUPTED and its workspace held, "as the worker may still run it", for the reconciler to free ten minutes later. These tests pin the worker's side of the
// fix: a cancel for an operation the worker has not seen is remembered (so the operation never starts), and a cancel for one it has taken but not yet registered stops it the
// moment it registers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { executeWorkerCancelInvocation } from "../../packages/worker/src/cancel-invocation.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function journal() {
  const root = await mkdtemp(join(tmpdir(), "agentx-cancel-before-start-"));
  roots.push(root);
  return new OperationJournal(root);
}

const workspaceId = randomUUID();
const cancelOf = (targetOperationId: string): Extract<WorkerInvocation, { kind: "cancel" }> => ({
  protocolVersion: 1, kind: "cancel", operationId: randomUUID(), workspaceId, fence: 4, projectRevision: 1,
  callbackCapability: "x".repeat(40), payload: { targetOperationId },
});
const taskInvocation = (operationId: string): WorkerInvocation => ({
  protocolVersion: 1, kind: "close", operationId, workspaceId, fence: 4, projectRevision: 1, callbackCapability: "x".repeat(40), payload: {},
});

describe("a cancel for an operation this worker has never been sent", () => {
  it("succeeds, and the operation is refused if it arrives afterwards", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(await store.get(target)).toMatchObject({ operationId: target, workspaceId, fence: 4, status: "CANCELLED" });
    // The task arrives late (its delivery was already on the way): it is answered as a duplicate that ended cancelled, and never runs.
    const late = await store.accept(taskInvocation(target));
    expect(late).toMatchObject({ duplicate: true, record: { status: "CANCELLED" } });
  });

  it("is idempotent: a second cancel for it succeeds the same way", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await executeWorkerCancelInvocation(cancelOf(target), controller, store);
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toMatchObject({ status: "CANCELLED" });
  });
});

describe("a cancel for an operation the worker has taken but that has not registered yet", () => {
  it("stops it the moment it registers, and answers once it has ended", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    let aborted = 0;
    const answer = executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 5_000, pollMs: 10 });
    // The task is still preparing: it registers a little later, as run-task does after the checkout and the session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const unregister = controller.register(target, { abort: async () => { aborted += 1; } });
    expect(controller.isCancelled(target)).toBe(true);
    // The run sees the stop on its next check and ends cancelled, as a stopped run does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.transition(target, "CANCELLED", "operation cancelled");
    unregister();
    await expect(answer).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(aborted).toBe(1);
  });

  it("registers an already-cancelled operation with the stop in place, so the run's first check ends it", async () => {
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    expect(controller.cancelWhenRegistered(target)).toBe(true);
    expect(controller.isCancelled(target)).toBe(true);
    controller.register(target, { abort: async () => undefined });
    expect(controller.isCancelled(target)).toBe(true);
  });

  it("fails closed when the operation does not end in time: the cancel fails (the broker keeps the workspace held), and the stop stays in place", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 60, pollMs: 10 })).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
    expect(controller.isCancelled(target)).toBe(true);
  });

  it("leaves a finished operation alone: its cancel fails as before, and nothing is remembered", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "SUCCEEDED");
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(controller.isCancelled(target)).toBe(false);
  });
});

describe("a cancel for a running (registered) operation", () => {
  it("is unchanged: aborts it and marks the journal", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    let aborted = 0;
    controller.register(target, { abort: async () => { aborted += 1; } });
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(aborted).toBe(1);
    expect(await store.get(target)).toMatchObject({ status: "CANCELLED" });
  });
});
