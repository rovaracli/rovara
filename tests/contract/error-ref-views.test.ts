// Live interaction F1: ErrorRef on the task view, the session view and the health rows. Fixed codes and ids only; a view that shows no error has no reference (so no "Fix with agent" button).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ERROR_REF_KINDS, ErrorRefSchema, OrgServiceStatusSchema, SessionViewSchema, WORKFLOW_BLOCK_REASONS, connectorHealthErrorRef, modelAccessErrorRef, setupCheckErrorRef, taskFailureErrorRef,
  workflowBlockCode, workflowBlockErrorRef, type DeveloperTaskView,
} from "../../packages/contracts/src/index.js";
import { taskViewErrorRef } from "../../packages/broker/src/aws/developer-tasks/error-ref.js";
import { withServiceErrorRefs, type ServiceObservation } from "../../packages/broker/src/org/service-status.js";
import { sessionView } from "../../packages/broker/src/agent-sessions/read.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { sessionWorld, PRIYA, CELL, ORG_A } from "../support/agent-session-world.js";

const TASK = "0b1f6c1e-3c7d-4a3e-8c55-1a2b3c4d5e6f";
const AT = "2026-10-31T10:00:00.000Z";
const PLANTED = "Error: ENOENT /home/rovara/secret-path password=hunter2";

describe("the codes", () => {
  it("gives every fixed block sentence its own code, a valid ErrorRef, and no text", () => {
    const codes = new Set<string>();
    for (const [key, sentence] of Object.entries(WORKFLOW_BLOCK_REASONS)) {
      if (typeof sentence !== "string") continue;
      const ref = workflowBlockErrorRef({ taskId: TASK, blockReason: sentence, at: AT });
      expect(ref, key).toBeDefined();
      expect(ErrorRefSchema.safeParse(ref).success, key).toBe(true);
      expect(ref!.kind).toBe("workflow_block");
      expect(ref!.code, key).toBe(key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase());
      codes.add(ref!.code);
      expect(JSON.stringify(ref)).not.toContain(sentence.slice(0, 20));
    }
    expect(codes.size).toBe(Object.values(WORKFLOW_BLOCK_REASONS).filter((value) => typeof value === "string").length);
    expect(workflowBlockCode(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise)).toBe("LIVE_STEER_REAPPROVAL_REVISE");
  });

  it("gives the general code to a reason that is not a fixed sentence, and never copies it", () => {
    for (const reason of [undefined, "", PLANTED, "A project name acme-payments was removed"]) {
      const ref = workflowBlockErrorRef({ taskId: TASK, blockReason: reason, at: AT });
      expect(ref?.code, String(reason)).toBe("WORKFLOW_BLOCKED");
      expect(JSON.stringify(ref)).not.toContain("hunter2");
      expect(JSON.stringify(ref)).not.toContain("acme");
    }
  });

  it("builds a failure reference from the category and stage words, keeps the ref when the operation id is not a uuid, and refuses a bad task id", () => {
    expect(taskFailureErrorRef({ taskId: TASK, failure: { category: "setup_failed", stage: "setup" }, operationId: randomUUID(), at: AT })).toMatchObject({ kind: "operation_failed", code: "SETUP_FAILED_SETUP", subject: { taskId: TASK } });
    expect(taskFailureErrorRef({ taskId: TASK, failure: { category: "timed_out" }, operationId: "op-1", at: AT })).toEqual({ kind: "operation_failed", code: "TIMED_OUT", subject: { taskId: TASK }, at: AT });
    expect(taskFailureErrorRef({ taskId: "nope", failure: { category: "timed_out" }, at: AT })).toBeUndefined();
    expect(JSON.stringify(taskFailureErrorRef({ taskId: TASK, failure: { category: PLANTED }, at: AT }) ?? {})).not.toContain("hunter2");
  });

  it("builds setup, connector and model-access references; a setup check only has one when it failed or is outdated", () => {
    for (const status of ["unchecked", "checking", "ready"]) expect(setupCheckErrorRef({ project: "web", status, at: AT }), status).toBeUndefined();
    expect(setupCheckErrorRef({ project: "web", status: "failed", at: AT })).toEqual({ kind: "setup_check", code: "SETUP_CHECK_FAILED", subject: { project: "web" }, at: AT });
    expect(setupCheckErrorRef({ project: "web", status: "outdated", at: AT })?.code).toBe("SETUP_CHECK_OUTDATED");
    expect(setupCheckErrorRef({ project: "Not A Name", status: "failed", at: AT })).toBeUndefined();
    expect(connectorHealthErrorRef({ connectorId: "github-main", reason: "token expired", at: AT })).toMatchObject({ kind: "connector_health", code: "CONNECTOR_TOKEN_EXPIRED", subject: { connectorId: "github-main" } });
    expect(modelAccessErrorRef({ project: "web", reason: "access_denied", at: AT })).toMatchObject({ kind: "model_access", code: "MODEL_ACCESS_ACCESS_DENIED" });
    expect(ERROR_REF_KINDS).toHaveLength(6);
  });
});

describe("the task view's reference", () => {
  const base = { taskId: TASK, status: "RUNNING" as DeveloperTaskView["status"], workflow: undefined, failure: undefined, operationId: undefined, creatorRemoved: false, at: AT };

  it("is a workflow_block for a blocked step, an operation_failed for a failed or interrupted task, and nothing otherwise", () => {
    const blocked = { state: "BLOCKED" as const, blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise };
    expect(taskViewErrorRef({ ...base, workflow: blocked })).toMatchObject({ kind: "workflow_block", code: "LIVE_STEER_REAPPROVAL_REVISE" });
    expect(taskViewErrorRef({ ...base, status: "FAILED", failure: { category: "task_failed", message: PLANTED }, operationId: randomUUID() })).toMatchObject({ kind: "operation_failed", code: "TASK_FAILED" });
    expect(taskViewErrorRef({ ...base, status: "INTERRUPTED", failure: { category: "interrupted", message: "x" } })?.code).toBe("INTERRUPTED");
    // A blocked step wins over a failure.
    expect(taskViewErrorRef({ ...base, status: "FAILED", workflow: blocked, failure: { category: "task_failed", message: "x" } })?.kind).toBe("workflow_block");
    // No error to fix.
    expect(taskViewErrorRef(base)).toBeUndefined();
    expect(taskViewErrorRef({ ...base, workflow: { state: "WAITING" as never, blockReason: undefined } })).toBeUndefined();
    expect(taskViewErrorRef({ ...base, status: "FAILED", failure: undefined })).toBeUndefined();
    for (const status of ["SUCCEEDED", "CLOSED", "CANCELLED"] as const) expect(taskViewErrorRef({ ...base, status, workflow: blocked }), status).toBeUndefined();
    expect(taskViewErrorRef({ ...base, workflow: blocked, creatorRemoved: true })).toBeUndefined();
    expect(taskViewErrorRef({ ...base, status: "FAILED", failure: { category: "task_failed", message: "x" }, creatorRemoved: true })).toBeUndefined();
    expect(taskViewErrorRef({ ...base, workflow: blocked, at: "yesterday" })).toBeUndefined();
  });

  it("never holds the failure message or the block reason's text", () => {
    const ref = taskViewErrorRef({ ...base, status: "FAILED", failure: { category: "task_failed", message: PLANTED }, operationId: randomUUID() });
    expect(JSON.stringify(ref)).not.toContain("hunter2");
    expect(JSON.stringify(ref)).not.toContain("ENOENT");
    expect(Object.keys(ref!).sort()).toEqual(["at", "code", "kind", "operationId", "subject"]);
  });
});

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

async function startedTask() {
  const harness = await createSingleAnswerPlanBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
  const read = async () => (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as Record<string, unknown>;
  return { harness, taskId, record, workspaceId: record.workspaceId, read };
}

describe("a real task view", () => {
  it("carries a workflow_block reference for a blocked step, with the fixed code and the task, and none once the step is not blocked", async () => {
    const t = await startedTask();
    expect((await t.read()).errorRef).toBeUndefined();
    t.harness.db.set({ ...t.record, workflow: { ...t.record.workflow, state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise } });
    const blocked = await t.read();
    expect(blocked.errorRef).toMatchObject({ kind: "workflow_block", code: "LIVE_STEER_REAPPROVAL_REVISE", subject: { taskId: t.taskId } });
    expect(ErrorRefSchema.safeParse(blocked.errorRef).success).toBe(true);
    t.harness.db.set({ ...t.record, workflow: { ...t.record.workflow, state: "BLOCKED", blockReason: PLANTED } });
    const odd = await t.read();
    expect((odd.errorRef as { code: string }).code).toBe("WORKFLOW_BLOCKED");
    expect(JSON.stringify(odd.errorRef)).not.toContain("hunter2");
    t.harness.db.set(t.record);
    expect((await t.read()).errorRef).toBeUndefined();
  });

  it("carries an operation_failed reference for a task whose setup failed, naming the failed operation, and not the failure text", async () => {
    const t = await startedTask();
    const prepare = operations(t.harness, t.workspaceId).find((item) => item.kind === "prepare")!;
    await t.harness.finish(t.workspaceId, String(prepare.id), "FAILED", { error: PLANTED });
    const failed = await t.read();
    expect(failed.status).toBe("FAILED");
    expect(failed.errorRef).toMatchObject({ kind: "operation_failed", subject: { taskId: t.taskId } });
    expect((failed.errorRef as { code: string }).code).toMatch(/^[A-Z][A-Z0-9_]+$/u);
    expect(JSON.stringify(failed.errorRef)).not.toContain("hunter2");
  });
});

describe("the session view", () => {
  const taskViewOf = (task: { taskId: string; project: string }, extra: Record<string, unknown>) => ({
    taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false,
    createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [], ...extra,
  });
  const read = async (extra: Record<string, unknown>) => {
    const w = sessionWorld();
    const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task: { taskId: string; project: string }) => taskViewOf(task, extra) as never } as Parameters<typeof sessionView>[0];
    const { sessionId, taskId } = w.seedSession();
    return { taskId, session: await sessionView(deps, { ...w.caller(PRIYA, ORG_A) }, sessionId) };
  };

  it("carries the task's own reference and parses, and carries none when the task shows no error", async () => {
    const withRef = await read({ errorRef: { kind: "workflow_block", code: "CHECKS_UNCONFIRMED", subject: { taskId: TASK }, at: AT } });
    expect(withRef.session.errorRef).toEqual({ kind: "workflow_block", code: "CHECKS_UNCONFIRMED", subject: { taskId: TASK }, at: AT });
    expect(SessionViewSchema.parse(withRef.session)).toEqual(withRef.session);
    const without = await read({});
    expect(without.session).not.toHaveProperty("errorRef");
    expect(SessionViewSchema.safeParse(without.session).success).toBe(true);
  });
});

describe("the health rows", () => {
  const row = (reason: ServiceObservation["reason"], observation: ServiceObservation["observation"], state: ServiceObservation["state"], kind: "web" | "api" = "web"): ServiceObservation =>
    ({ kind, state, observation, reason, ...(observation === "unknown" ? {} : { expiresAt: "2026-11-30T00:00:00.000Z" }) });

  it("gives a reference to a row that is an error (expired, not ready, unreadable evidence, a store that is down) and to no other row", () => {
    const rows = withServiceErrorRefs([
      row("expired", "expired", "ready", "web"), row("not_ready", "warning", "parked", "api"),
      row("invalid_evidence", "unknown", "unknown", "web"), row("unavailable", "unknown", "unknown", "api"),
      row("qualified", "qualified", "ready"), row("expiring", "warning", "ready"), row("not_observed", "unknown", "unknown"), row("not_configured", "unknown", "unknown"),
    ], AT);
    const withRef = rows.filter((entry) => entry.errorRef !== undefined);
    expect(withRef.map((entry) => entry.reason)).toEqual(["expired", "not_ready", "invalid_evidence", "unavailable"]);
    expect(rows[0]!.errorRef).toEqual({ kind: "connector_health", code: "CONNECTOR_EXPIRED", subject: { connectorId: "runtime-web" }, at: AT });
    expect(rows[1]!.errorRef?.subject).toEqual({ connectorId: "runtime-api" });
    for (const entry of rows.slice(4)) expect(entry, entry.reason).not.toHaveProperty("errorRef");
  });

  it("parses with the status schema (two rows, web then api) and holds no text", () => {
    const checks = withServiceErrorRefs([row("expired", "expired", "ready", "web"), row("qualified", "qualified", "ready", "api")], AT);
    const status = { orgId: ORG_A, source: "stored_runtime_qualification" as const, checkedAt: AT, configured: true, checks };
    expect(OrgServiceStatusSchema.parse(status)).toEqual(status);
  });
});
