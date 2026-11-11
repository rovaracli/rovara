// 058-stop-close (QA6-13, S1): a Stop pressed while a step is being dispatched (its invocation waits for the workspace's compute) used to leave the operation
// INTERRUPTED and the workspace BUSY: the cancel reached a worker that had never seen the step, failed with NOT_FOUND, and the broker held the workspace "as the worker
// may still run it" until the reconciler's idle check, ten minutes later. Stop then said "Nothing was running" and Close said "still working".
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workspaceSessionKey } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

/** A task whose preparation is done and whose first coding step is dispatching (its operation holds the workspace). */
async function dispatching() {
  const harness = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const meta = () => harness.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
  await harness.finish(workspaceId, String(meta().activeOperationId), "SUCCEEDED");
  const operationId = String(meta().activeOperationId);
  const outbox = () => harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
  const operation = () => harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown>;
  const stop = () => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
  const close = (requestId = randomUUID(), discard = false) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId, ...(discard ? { discard_unpublished: true } : {}) });
  /** The dispatcher took the step (DISPATCHING) and parked it: the session's compute is not ready, so nothing reached a worker. */
  const park = () => {
    harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!.status = "DISPATCHING";
    outbox().status = "WAITING_FOR_SESSION";
    harness.db.set({ ...workspaceSessionKey(workspaceId), entityType: "SESSION", state: "PROVISIONING", generation: 1, waitingOutboxIds: new Set([String(outbox().id)]) });
  };
  return { ...harness, taskId, workspaceId, operationId, meta, outbox, operation, stop, close, park };
}

const SAFE = { result: { safeToClose: true, repositories: [] } };

describe("Stop while the step is still waiting for the workspace's compute (never sent to a worker)", () => {
  it("ends the operation at once: cancelled, the workspace free, the parked delivery withdrawn", async () => {
    const { db, stop, park, meta, operation, outbox, operationId, workspaceId } = await dispatching();
    park();
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    expect(meta()).toMatchObject({ status: "READY" });
    expect(meta()).not.toHaveProperty("activeOperationId");
    // The delivery waiting for the compute is withdrawn: when the compute comes up nothing is sent, and nothing is retried against a task that has stopped.
    expect(outbox()).toMatchObject({ status: "FAILED" });
    const session = db.get(`WORKSPACE#${workspaceId}`, "SESSION") as { waitingOutboxIds?: Set<string> };
    expect(session.waitingOutboxIds?.has(String(outbox().id)) ?? false).toBe(false);
    // The stop's own record shows it: this operation's cancel was answered without a worker.
    const cancels = db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel" && item.targetOperationId === operationId);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ status: "SUCCEEDED" });
  });

  it("then Close works at once: the check for unpublished work starts and the task closes", async () => {
    const { db, stop, park, close, meta, taskId, workspaceId, finish } = await dispatching();
    park();
    await stop();
    const started = await close();
    expect(started.body).toMatchObject({ closed: false, task: { closing: true } });
    await finish(workspaceId, String(meta().activeOperationId), "SUCCEEDED", SAFE);
    expect(db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
    expect(meta()).toMatchObject({ status: "CLOSED" });
  });

  it("a repeated Stop is harmless and still does not claim a task is running", async () => {
    const { stop, park, operation } = await dispatching();
    park();
    await stop();
    const again = await stop();
    expect(again.status).toBe(200);
    expect(operation()).toMatchObject({ status: "CANCELLED" });
  });

  it("a late delivery of the withdrawn step does nothing: the dispatcher's guard sees an operation that is no longer dispatchable", async () => {
    const { park, stop, operation } = await dispatching();
    park();
    await stop();
    // markDispatching in the dispatcher is conditional on ACCEPTED or DISPATCHING; a cancelled operation is neither.
    expect(["ACCEPTED", "DISPATCHING"]).not.toContain(operation().status);
  });
});

describe("Stop when the step may already be with a worker (not parked)", () => {
  it("still asks the worker to stop it (the worker, not the broker, knows what it holds)", async () => {
    const { stop, operation, db, workspaceId, operationId } = await dispatching();
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel" && item.targetOperationId === operationId)).toHaveLength(1);
  });
});

describe("a task left INTERRUPTED and holding its workspace (a stop that did not reach it)", () => {
  /** What the QA run left: the step INTERRUPTED by a failed cancel, the workspace still BUSY with it. `compute` is what the control plane knows of the workspace's worker. */
  async function orphaned(compute: "alive" | "gone") {
    const h = await dispatching();
    const record = h.operation();
    record.status = "INTERRUPTED";
    record.error = "NOT_FOUND: active operation not found";
    h.db.set({ ...workspaceSessionKey(h.workspaceId), entityType: "SESSION", state: compute === "alive" ? "READY" : "STOPPED", generation: 1, privateIp: "10.0.0.1" });
    return h;
  }

  it("Close does not drop the hold while the worker may still run the old step: it says so, marks the request for the reconciler, and closes and deletes nothing", async () => {
    const { close, meta, operation, workspaceId, operationId, db, taskId, deleteEc2Session } = await orphaned("alive");
    const refused = await close();
    expect(refused.body).toMatchObject({ error: { code: "TASK_BUSY" } });
    expect(JSON.stringify(refused.body)).toContain("earlier stop did not reach this task");
    expect(meta()).toMatchObject({ status: "BUSY", activeOperationId: operationId });
    expect(operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(operation()).not.toHaveProperty("workspaceReleasedAt");
    expect(operation()).toHaveProperty("closeRequestedAt");
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "close")).toHaveLength(0);
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
    expect(deleteEc2Session).not.toHaveBeenCalled();
    // Asking again changes nothing and still keeps the hold; a new work request cannot start in the held workspace.
    expect((await close()).body).toMatchObject({ error: { code: "TASK_BUSY" } });
    expect(meta()).toMatchObject({ status: "BUSY", activeOperationId: operationId });
  });

  it("the not-confirmed answers promise nothing they cannot keep: no 'within N minutes', and they say a busy worker keeps the workspace held and that nothing is deleted", async () => {
    const { close, dev, db, taskId } = await orphaned("alive");
    const closeAnswer = JSON.stringify((await close()).body);
    expect(closeAnswer).toContain("close the task again then");
    expect(closeAnswer).toContain("about every 10 minutes");
    expect(closeAnswer).toContain("still busy, the workspace stays reserved until it finishes");
    expect(closeAnswer).toContain("nothing is deleted");
    expect(closeAnswer).not.toMatch(/within (about )?\d+ minutes/u);
    const meta = db.get(`DEVTASK#${taskId}`, "META") as { sessionId?: string; agent?: unknown };
    delete meta.agent;
    const stopAnswer = JSON.stringify((await dev(MAYA, "POST", `/v1/app/sessions/${String(meta.sessionId)}/stop`, { requestId: randomUUID() })).body);
    expect(stopAnswer).toContain("after about 10 minutes (about 30 if the stop was retried)");
    expect(stopAnswer).toContain("Pressing Close task asks for a faster release");
    expect(stopAnswer).toContain("stays reserved until it finishes");
    expect(stopAnswer).toContain("Nothing is deleted");
    expect(stopAnswer).not.toMatch(/within (about )?\d+ minutes/u);
  });

  it("Close is the way forward once the compute is gone: it frees the hold and starts the check for unpublished work", async () => {
    const { close, meta, operation, workspaceId, db } = await orphaned("gone");
    const started = await close();
    expect(started.body).toMatchObject({ closed: false, task: { closing: true } });
    expect(operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "compute-gone" });
    expect(meta()).toMatchObject({ status: "CLOSING" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "close")).toHaveLength(1);
  });

  it("fails closed on work: with the compute gone, unpublished code still refuses the close and lists it", async () => {
    const { close, meta, workspaceId, finish, taskId, db } = await orphaned("gone");
    const requestId = randomUUID();
    await close(requestId);
    await finish(workspaceId, String(meta().activeOperationId), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    const again = await close(requestId);
    expect(again.body).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
    expect(meta()).toMatchObject({ status: "READY" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
  });

  it("fails closed when the check cannot run: a failed check deletes nothing", async () => {
    const { close, meta, workspaceId, finish, taskId, db, deleteEc2Session } = await orphaned("gone");
    await close();
    await finish(workspaceId, String(meta().activeOperationId), "FAILED", { error: "workspace inspection failed" });
    expect(deleteEc2Session).not.toHaveBeenCalled();
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
  });

  it("a running operation is still never released by Close", async () => {
    const h = await dispatching();
    h.operation().status = "RUNNING";
    const refused = await h.close();
    expect(refused.body).toMatchObject({ error: { code: "TASK_BUSY" } });
    expect(h.meta()).toMatchObject({ status: "BUSY", activeOperationId: h.operationId });
  });

  it("Stop says so: the earlier stop did not reach the task (not 'nothing was running')", async () => {
    const { db, taskId, operation, dev } = await orphaned("alive");
    // A plain task (no agent-step run): the stop of an agent-step run is the run's own.
    const meta = db.get(`DEVTASK#${taskId}`, "META") as { sessionId?: string; agent?: unknown };
    delete meta.agent;
    const sessionId = String(meta.sessionId);
    const stopped = await dev(MAYA, "POST", `/v1/app/sessions/${sessionId}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(JSON.stringify(stopped.body)).toContain("earlier stop did not reach this task");
    expect(operation()).toMatchObject({ status: "INTERRUPTED" });
  });
});

describe("a Stop that withdraws the parked delivery at the moment the session re-queues it (review: the missing race)", () => {
  it("the re-queue wins: nothing is withdrawn and the cancel goes the ordinary way, to the worker, leaving the workspace held until the worker answers", async () => {
    const { db, park, stop, meta, operation, outbox, operationId, workspaceId } = await dispatching();
    park();
    const id = String(outbox().id);
    // The session becomes ready and re-queues the delivery (PENDING, out of the parked set) just before the withdrawal's transaction commits.
    const send = db.send.bind(db);
    let requeued = false;
    db.send = async (command) => {
      if (!requeued && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("STOPPED_BEFORE_START")) {
        requeued = true;
        (db.get(`OUTBOX#${id}`, "OUTBOX") as Record<string, unknown>).status = "PENDING";
        (db.get(`WORKSPACE#${workspaceId}`, "SESSION") as { waitingOutboxIds: Set<string> }).waitingOutboxIds.delete(id);
      }
      return send(command);
    };
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(requeued).toBe(true);
    // Not withdrawn, not ended here: the delivery is live, so the worker (which may already hold the step) is asked to stop it.
    expect(outbox()).toMatchObject({ status: "PENDING" });
    expect(operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(meta()).toMatchObject({ status: "BUSY", activeOperationId: operationId });
    const cancels = db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel" && item.targetOperationId === operationId);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ status: "ACCEPTED" });
  });
});
