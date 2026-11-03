// Ending an automatic run Rovara stops itself, and the session sweep that ends one that outlives its time (owner decision 2026-11-02, Opus review M2): a system owner has no person to resume or stop its run, so a hung
// run must not hold the project's only automatic slot for ever.
import { describe, expect, it, vi } from "vitest";
import { AUTOMATIC_RUN_MAX_MS, systemOwnerIdOf, systemOwnerName, type OrgId } from "@agentx/contracts";
import { AUTOMATIC_RUN_WATCH_PK, markAutomaticTaskEnded, putAutomaticRunWatch, sweepAutomaticRuns } from "../../packages/broker/src/automatic-runs/end.js";
import { FINISHED_RELEASE_PK } from "../../packages/broker/src/aws/developer-tasks/release.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "partner-service";
const SYSTEM = systemOwnerIdOf(ORG, PROJECT);
const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
const slot = "c".repeat(64);
const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function bench() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const audit = capturingAuditDeps({ db });
  const released: string[] = [];
  const cancelled: string[] = [];
  const sweep = () => sweepAutomaticRuns({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, release: (id) => { released.push(id); return Promise.resolve(); }, cancelLive: (task) => { cancelled.push(task.taskId); return Promise.resolve(); } });
  const run = async (n: number, extra: Record<string, unknown> = {}, job = "nightly") => {
    const task = { pk: `DEVTASK#${taskId(n)}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: taskId(n), orgId: ORG, project: PROJECT, developerId: SYSTEM, provider: "system", developerName: systemOwnerName(PROJECT),
      workspaceId: `ws-${String(n)}`, createdAt: new Date(clock.now).toISOString(), ...extra };
    db.set(task);
    await putAutomaticRunWatch(db, AUDIT_CAPTURE_TABLE, { orgId: ORG, project: PROJECT, job, taskId: taskId(n), startedAt: new Date(clock.now).toISOString(), nowMs: clock.now });
    return task as unknown as DeveloperTaskRecord;
  };
  const task = (n: number) => db.get(`DEVTASK#${taskId(n)}`, "META") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a stored row is asserted field by field
  const watches = () => db.find((item) => item.pk === AUTOMATIC_RUN_WATCH_PK);
  return { db, clock, audit, released, cancelled, sweep, run, task, watches };
}

describe("the session sweep ends an automatic run that outlives its time", () => {
  it("cancels it on its worker, ends it, asks for its slot back, and audits it once as the system with the reason", async () => {
    const b = bench();
    await b.run(1, { nightlyRun: { slotId: slot, envRevision: 1, branch: "main", headSha: "d".repeat(40) } });
    b.clock.now += AUTOMATIC_RUN_MAX_MS + 60_000;
    const report = await b.sweep();
    expect(report).toMatchObject({ ended: 1, audited: 1 });
    expect(b.cancelled).toEqual([taskId(1)]);
    expect(b.released).toContain(taskId(1));
    expect(b.task(1)).toMatchObject({ agentRunEnd: { state: "CANCELLED" }, automaticEnd: { reason: "too_old" } });
    expect(b.db.get(FINISHED_RELEASE_PK, `TASK#${taskId(1)}`)).toMatchObject({ taskId: taskId(1) });
    const events = b.audit.recordedBy("automatic_run.ended");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: PROJECT }, facts: { job: "nightly", reason: "too_old" } });
    // the night's own row says it did not finish because of Rovara's side
    expect(b.db.find((item) => item.entityType === "TEST_ENV_NIGHT")).toHaveLength(1);
    // a second pass ends nothing more and audits nothing more
    expect(await b.sweep()).toMatchObject({ ended: 0, audited: 0 });
    expect(b.audit.recordedBy("automatic_run.ended")).toHaveLength(1);
  });

  it("leaves a run that is within its time alone", async () => {
    const b = bench();
    await b.run(1);
    b.clock.now += AUTOMATIC_RUN_MAX_MS - 60_000;
    expect(await b.sweep()).toMatchObject({ ended: 0, watching: 1 });
    expect(b.task(1).agentRunEnd).toBeUndefined();
    expect(b.cancelled).toEqual([]);
  });

  it("drops the watch once the slot is back (the task is released), and for a task that is gone", async () => {
    const b = bench();
    await b.run(1, { agentRunEnd: { state: "COMPLETE", at: "2026-11-05T07:00:00.000Z" }, releasedAt: "2026-11-05T07:01:00.000Z" });
    await putAutomaticRunWatch(b.db, AUDIT_CAPTURE_TABLE, { orgId: ORG, project: PROJECT, job: "nightly", taskId: taskId(2), startedAt: new Date(T0).toISOString(), nowMs: T0 });
    expect(b.watches()).toHaveLength(2);
    expect(await b.sweep()).toMatchObject({ dropped: 2 });
    expect(b.watches()).toHaveLength(0);
    expect(b.audit.recordedBy("automatic_run.ended")).toHaveLength(0);
  });

  it("keeps the watch, and asks again, while an ended run's workspace is still busy", async () => {
    const b = bench();
    await b.run(1, { agentRunEnd: { state: "COMPLETE", at: "2026-11-05T07:00:00.000Z" } });
    expect(await b.sweep()).toMatchObject({ watching: 1, dropped: 0 });
    expect(b.released).toEqual([taskId(1)]);
    expect(b.watches()).toHaveLength(1);
  });

  it("a worker that cannot be told does not stop the run being ended", async () => {
    const b = bench();
    await b.run(1);
    b.clock.now += AUTOMATIC_RUN_MAX_MS + 1;
    const failing = { documentClient: b.db, tableName: AUDIT_CAPTURE_TABLE, now: () => b.clock.now, audit: b.audit.audit, release: () => Promise.resolve(), cancelLive: () => Promise.reject(new Error("no worker")), log: vi.fn() };
    expect(await sweepAutomaticRuns(failing)).toMatchObject({ ended: 1 });
    expect(failing.log).toHaveBeenCalledWith(expect.objectContaining({ event: "automatic_run.cancel_failed" }));
    expect(b.task(1).agentRunEnd).toMatchObject({ state: "CANCELLED" });
  });

  it("never ends a person's task: a watch that names one is dropped and the task untouched", async () => {
    const b = bench();
    const person = "a".repeat(64);
    await b.run(1, { developerId: person, provider: "oidc" });
    b.clock.now += AUTOMATIC_RUN_MAX_MS + 60_000;
    expect(await b.sweep()).toMatchObject({ ended: 0, dropped: 1 });
    expect(b.task(1).agentRunEnd).toBeUndefined();
    expect(b.cancelled).toEqual([]);
    await expect(markAutomaticTaskEnded(b.db, AUDIT_CAPTURE_TABLE, { taskId: taskId(1), developerId: person, project: PROJECT }, "too_old", new Date(b.clock.now).toISOString())).rejects.toThrow(/system owner/u);
  });

  it("an end already made by the dispatch guard is audited by the sweep, once", async () => {
    const b = bench();
    const task = await b.run(1);
    await markAutomaticTaskEnded(b.db, AUDIT_CAPTURE_TABLE, task, "project_stopped", new Date(T0).toISOString());
    expect(await b.sweep()).toMatchObject({ ended: 0, audited: 1 });
    expect(await b.sweep()).toMatchObject({ audited: 0 });
    expect(b.audit.recordedBy("automatic_run.ended").map((event) => event.facts)).toEqual([{ job: "nightly", reason: "project_stopped" }]);
  });
});
