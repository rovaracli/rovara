// The project's monthly cap on automatic runs and the one function every automatic job starts a run with (owner decision 2026-11-02).
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTOMATIC_RUNS_PER_MONTH, MAX_AUTOMATIC_RUNS_PER_MONTH, agentXError, systemOwnerIdOf, type OrgId } from "@rovara-code/contracts";
import { aiToolTurn } from "../../packages/broker/src/developer/task-records.js";
import { runRequestKey } from "@rovara-code/contracts";
import { claimAutomaticRun, readAutomaticRunsCap, readAutomaticRunsUse, releaseAutomaticRun, setAutomaticRunsCap } from "../../packages/broker/src/automatic-runs/cap.js";
import { startAutomaticRun } from "../../packages/broker/src/automatic-runs/start.js";
import type { AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import type { TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "partner-service";
const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

function bench() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const audit = capturingAuditDeps({ db });
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit };
  const started: AgentRunRequest[] = [];
  const fail: { error: Error | undefined } = { error: undefined };
  const run = { ...deps, startAgentRun: (request: AgentRunRequest) => { if (fail.error !== undefined) return Promise.reject(fail.error); started.push(request); return Promise.resolve({ taskId: "t", runLimitUsd: 1, stopAtUsd: 1, paused: false }); } };
  return { db, clock, audit, deps, started, fail, run };
}
const claim = (b: ReturnType<typeof bench>, n: number) => claimAutomaticRun(b.deps, { orgId: ORG, project: PROJECT, requestId: id(n), job: "nightly" });
const maintainer = (b: ReturnType<typeof bench>, cap: number, requestId = "request-cap-0001") => setAutomaticRunsCap(b.deps, { orgId: ORG, project: PROJECT, role: "maintainer", changedBy: "dev_m", cap, requestId });
const job = (n: number, extra: Record<string, unknown> = {}) => ({ orgId: ORG, project: PROJECT, job: "nightly" as const, requestId: id(n), agent: { agentId: "rovara-code" as const }, input: { text: "Nightly test run." }, origin: "automatic" as const, purpose: "saved_env_rebuild" as const, ...extra });

describe("the monthly cap on a project's automatic runs", () => {
  it("is a sensible default until a maintainer sets one", async () => {
    const b = bench();
    expect(await readAutomaticRunsCap(b.deps, ORG, PROJECT)).toEqual({ cap: DEFAULT_AUTOMATIC_RUNS_PER_MONTH, isDefault: true });
    expect(await readAutomaticRunsUse(b.deps, ORG, PROJECT)).toEqual({ month: "2026-11", cap: 100, capIsDefault: true, used: 0, paused: false });
  });

  it("counts runs started this month, once per request, and says so", async () => {
    const b = bench();
    expect(await claim(b, 1)).toEqual({ claimed: true, used: 1, cap: 100, replay: false });
    expect(await claim(b, 2)).toMatchObject({ claimed: true, used: 2 });
    // a retried start of the same request counts once
    expect(await claim(b, 1)).toMatchObject({ claimed: true, used: 2, replay: true });
    expect(await readAutomaticRunsUse(b.deps, ORG, PROJECT)).toMatchObject({ used: 2, paused: false });
  });

  it("pauses at the cap: the run is refused, the pause is recorded once for the month with its audit event, and nothing more is counted", async () => {
    const b = bench();
    await maintainer(b, 2);
    await claim(b, 1);
    await claim(b, 2);
    expect(await claim(b, 3)).toEqual({ claimed: false, used: 2, cap: 2 });
    expect(await claim(b, 4)).toEqual({ claimed: false, used: 2, cap: 2 });
    expect(await readAutomaticRunsUse(b.deps, ORG, PROJECT)).toMatchObject({ used: 2, cap: 2, paused: true });
    const paused = b.audit.recordedBy("automatic_runs.paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: PROJECT }, facts: { month: "2026-11", cap: 2 } });
  });

  it("a cap of 0 allows no run at all, not even the month's first: nothing is counted, claimed or started, and the pause is recorded once", async () => {
    const b = bench();
    await maintainer(b, 0);
    expect(await claim(b, 1)).toEqual({ claimed: false, used: 0, cap: 0 });
    expect(await claim(b, 2)).toEqual({ claimed: false, used: 0, cap: 0 });
    expect(await readAutomaticRunsUse(b.deps, ORG, PROJECT)).toMatchObject({ used: 0, cap: 0, paused: true });
    expect(b.audit.recordedBy("automatic_runs.paused")).toHaveLength(1);
    // no claim row was written for a refused run, so giving it back is a no-op and a later raise starts it
    await maintainer(b, 1, "request-cap-0002");
    expect(await claim(b, 1)).toMatchObject({ claimed: true, used: 1, replay: false });
  });

  it("a retried start whose run already exists is answered as a replay, even when the cap has since been set to 0", async () => {
    const b = bench();
    expect(await claim(b, 1)).toMatchObject({ claimed: true, used: 1, replay: false });
    await maintainer(b, 0);
    expect(await claim(b, 1)).toEqual({ claimed: true, used: 1, cap: 0, replay: true });
    // a different request is refused, and the pause is only recorded for that one
    expect(await claim(b, 2)).toEqual({ claimed: false, used: 1, cap: 0 });
    expect(b.audit.recordedBy("automatic_runs.paused")).toHaveLength(1);
  });

  it("starts again the next month, and the new month can be paused and recorded again", async () => {
    const b = bench();
    await maintainer(b, 1);
    await claim(b, 1);
    expect((await claim(b, 2)).claimed).toBe(false);
    b.clock.now = Date.UTC(2026, 11, 1, 6, 0, 0);
    expect(await claim(b, 3)).toMatchObject({ claimed: true, used: 1 });
    expect((await claim(b, 4)).claimed).toBe(false);
    expect(b.audit.recordedBy("automatic_runs.paused").map((event) => event.facts?.month)).toEqual(["2026-11", "2026-12"]);
  });

  it("gives the place back when the run was never started, and only once", async () => {
    const b = bench();
    await maintainer(b, 1);
    await claim(b, 1);
    await releaseAutomaticRun(b.deps, { orgId: ORG, project: PROJECT, requestId: id(1) });
    await releaseAutomaticRun(b.deps, { orgId: ORG, project: PROJECT, requestId: id(1) });
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(0);
    expect(await claim(b, 2)).toMatchObject({ claimed: true, used: 1 });
  });

  it("holds under two claims at once: never more than the cap", async () => {
    const b = bench();
    await maintainer(b, 3);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => claim(b, n)));
    expect(results.filter((result) => result.claimed)).toHaveLength(3);
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(3);
  });

  it("a stored cap that is damaged reads as the default, never as no cap and never as every run stopped", async () => {
    const b = bench();
    await maintainer(b, 5);
    const stored = b.db.find((item) => item.entityType === "AUTOMATIC_RUNS_SETTINGS")[0]!;
    for (const bad of [-1, 1.5, "7", 99_999, null]) {
      b.db.set({ ...stored, monthlyCap: bad });
      expect(await readAutomaticRunsCap(b.deps, ORG, PROJECT), String(bad)).toEqual({ cap: DEFAULT_AUTOMATIC_RUNS_PER_MONTH, isDefault: true });
    }
  });
});

describe("a conflict is not the cap", () => {
  const conflict = (b: ReturnType<typeof bench>, times: number) => b.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUTOMATIC_RUN_CLAIM"), times,
    error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] } });

  it("a conflicting write at count 0 is tried again, and the run takes its place", async () => {
    const b = bench();
    conflict(b, 1);
    expect(await claim(b, 1)).toMatchObject({ claimed: true, used: 1, replay: false });
    expect(b.audit.recordedBy("automatic_runs.paused")).toHaveLength(0);
  });

  it("a conflict that does not pass is a fault that may pass (WORKSPACE_BUSY), never the cap: no pause marker, no pause audit, nothing counted", async () => {
    const b = bench();
    conflict(b, 10);
    expect(await codeOf(claim(b, 1))).toBe("WORKSPACE_BUSY");
    expect(b.db.find((item) => item.entityType === "AUTOMATIC_RUNS_PAUSED")).toHaveLength(0);
    expect(b.audit.recordedBy("automatic_runs.paused")).toHaveLength(0);
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(0);
  });

  it("the cap is told only when the counter's own condition failed", async () => {
    const b = bench();
    b.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUTOMATIC_RUN_CLAIM"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] } });
    expect(await claim(b, 1)).toMatchObject({ claimed: false });
    expect(b.audit.recordedBy("automatic_runs.paused")).toHaveLength(1);
  });
});

describe("a maintainer edits the cap", () => {
  it("is audited with the cap before and after, by the maintainer", async () => {
    const b = bench();
    expect(await maintainer(b, 40)).toMatchObject({ cap: 40, capIsDefault: false });
    const events = b.audit.recordedBy("project.automatic_runs_cap_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: "dev_m" }, target: { kind: "project", name: PROJECT }, facts: { fromCap: DEFAULT_AUTOMATIC_RUNS_PER_MONTH, toCap: 40 } });
    await maintainer(b, 60, "request-cap-0002");
    expect(b.audit.recordedBy("project.automatic_runs_cap_changed").map((event) => event.facts)).toEqual([{ fromCap: 100, toCap: 40 }, { fromCap: 40, toCap: 60 }]);
  });

  it("is a maintainer's: a contributor, a viewer and no role at all are refused, and nothing is written or audited", async () => {
    const b = bench();
    for (const role of ["contributor", "viewer", undefined] as const) {
      expect(await codeOf(setAutomaticRunsCap(b.deps, { orgId: ORG, project: PROJECT, role, changedBy: "dev_x", cap: 5, requestId: "request-cap-0001" }))).toBe("FORBIDDEN");
    }
    expect(b.db.find((item) => item.entityType === "AUTOMATIC_RUNS_SETTINGS")).toHaveLength(0);
    expect(b.audit.recordedBy("project.automatic_runs_cap_changed")).toHaveLength(0);
  });

  it("takes a whole number from 0 to the maximum, and a request id", async () => {
    const b = bench();
    for (const cap of [-1, 1.5, MAX_AUTOMATIC_RUNS_PER_MONTH + 1, Number.NaN]) expect(await codeOf(maintainer(b, cap)), String(cap)).toBe("CONFIG_INVALID");
    expect(await codeOf(maintainer(b, 5, "x"))).toBe("CONFIG_INVALID");
    expect(await maintainer(b, 0)).toMatchObject({ cap: 0, paused: true });
    expect(await maintainer(b, MAX_AUTOMATIC_RUNS_PER_MONTH, "request-cap-0002")).toMatchObject({ cap: MAX_AUTOMATIC_RUNS_PER_MONTH });
  });

  it("a replay of a request changes and audits nothing more", async () => {
    const b = bench();
    await maintainer(b, 40);
    await maintainer(b, 70, "request-cap-0002");
    await maintainer(b, 40);
    expect((await readAutomaticRunsCap(b.deps, ORG, PROJECT)).cap).toBe(70);
    expect(b.audit.recordedBy("project.automatic_runs_cap_changed")).toHaveLength(2);
  });

  it("raising the cap lets paused runs go on at once", async () => {
    const b = bench();
    await maintainer(b, 1);
    await claim(b, 1);
    expect((await claim(b, 2)).claimed).toBe(false);
    await maintainer(b, 2, "request-cap-0002");
    expect(await claim(b, 2)).toMatchObject({ claimed: true, used: 2 });
  });
});

describe("startAutomaticRun, the one start every automatic job uses", () => {
  it("starts the run as the project's system owner: no starter, the project pays, the job and the approver on the request", async () => {
    const b = bench();
    expect(await startAutomaticRun(b.run, job(1, { setupApprovedBy: "dev_a" }))).toEqual({ started: { taskId: "t", runLimitUsd: 1, stopAtUsd: 1, paused: false } });
    expect(b.started).toHaveLength(1);
    expect(b.started[0]).toMatchObject({
      requestId: id(1), orgId: ORG, project: PROJECT, origin: "automatic", owner: { developerId: systemOwnerIdOf(ORG, PROJECT) },
      automatic: { job: "nightly", purpose: "saved_env_rebuild", approvedBy: "dev_a" }, payer: { kind: "project", project: PROJECT }, payerFromRules: true,
    });
    expect(b.started[0]!.startedBy).toBeUndefined();
  });

  it("does not start the run at the cap: it answers automatic_cap and the shared start is never called", async () => {
    const b = bench();
    await maintainer(b, 1);
    await startAutomaticRun(b.run, job(1));
    expect(await startAutomaticRun(b.run, job(2))).toEqual({ skipped: "automatic_cap" });
    expect(b.started).toHaveLength(1);
  });

  it("gives the place back when the start fails, so the retry of the same request counts once", async () => {
    const b = bench();
    b.fail.error = agentXError("WORKSPACE_LIMIT", "full");
    expect(await codeOf(startAutomaticRun(b.run, job(1)))).toBe("WORKSPACE_LIMIT");
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(0);
    b.fail.error = undefined;
    await startAutomaticRun(b.run, job(1));
    await startAutomaticRun(b.run, job(1));
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(1);
  });

  it("keeps the place when the start failed AFTER the run was made (the answer was lost): the run is the month's, and the retry counts it once", async () => {
    const b = bench();
    const lost = { ...b.run, startAgentRun: (request: AgentRunRequest) => {
      b.db.set({ ...runRequestKey(ORG, request.requestId), entityType: "RUN_REQUEST", orgId: ORG, taskId: "t-lost", fingerprint: "f", runLimitUsd: 1, stopAtUsd: 1, paused: false });
      return Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "the answer was lost"));
    } };
    expect(await codeOf(startAutomaticRun(lost, job(1)))).toBe("RUNTIME_UNAVAILABLE");
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(1);
    // the retry of the same request finds the claim and starts (answers) once
    await startAutomaticRun(b.run, job(1));
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(1);
  });

  it("records the start for the project page even where no audit ledger is configured, and says so when the record cannot be written", async () => {
    const b = bench();
    const noAudit = { documentClient: b.db, tableName: AUDIT_CAPTURE_TABLE, now: () => b.clock.now, startAgentRun: b.run.startAgentRun };
    await startAutomaticRun(noAudit, job(1));
    expect(b.db.find((item) => item.entityType === "AUTOMATIC_RUN_STARTED")).toHaveLength(1);
    expect(b.db.find((item) => item.entityType === "AUTOMATIC_RUN_WATCH")).toHaveLength(1);
    const log = vi.fn();
    b.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUTOMATIC_RUN_STARTED"), error: { name: "InternalServerError" } });
    expect("started" in await startAutomaticRun(b.run, job(2, { log }))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "automatic_run.start_not_recorded" }));
  });

  it("refuses a purpose that does not match what it runs, before anything is taken: the nightly purpose needs the night's facts, a rebuild has none", async () => {
    const b = bench();
    expect(await codeOf(startAutomaticRun(b.run, job(1, { purpose: "nightly_run" })))).toBe("CONFIG_INVALID");
    expect(await codeOf(startAutomaticRun(b.run, job(2, { nightlyRun: { slotId: "a".repeat(64), envRevision: 1, branch: "main", headSha: "b".repeat(40) } })))).toBe("CONFIG_INVALID");
    expect((await readAutomaticRunsUse(b.deps, ORG, PROJECT)).used).toBe(0);
    expect(b.started).toHaveLength(0);
  });

  it("audits the start once as 'automatic: <job>' with the person who approved the setup, and 'none' when it names nobody", async () => {
    const b = bench();
    await startAutomaticRun(b.run, job(1, { setupApprovedBy: "dev_a" }));
    await startAutomaticRun(b.run, job(1, { setupApprovedBy: "dev_a" }));
    await startAutomaticRun(b.run, job(2, { job: "image_rebuild" }));
    const events = b.audit.recordedBy("automatic_run.started");
    expect(events).toHaveLength(2);
    const byJob = (word: string) => events.find((event) => event.facts?.job === word);
    expect(byJob("nightly")).toMatchObject({ actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: PROJECT }, facts: { job: "nightly", setupApprovedBy: "dev_a", runsThisMonth: 1, cap: 100 } });
    expect(byJob("image_rebuild")).toMatchObject({ facts: { setupApprovedBy: "none" } });
  });

  it("does not wait on, or fail for, its audit trail", async () => {
    const b = bench();
    b.audit.queueDown();
    expect(await startAutomaticRun(b.run, job(1, { setupApprovedBy: "dev_a" }))).toMatchObject({ started: { taskId: "t" } });
  });
});

describe("a turn record's owner", () => {
  const party = (developerId: string, provider: string) => ({ taskId: id(1), developerId, provider, developerName: "x", client: "api" }) as never;
  const record = (developerId: string, provider: string) => aiToolTurn({ party: party(developerId, provider), turnId: id(2), action: "close", phase: "completed", outcome: "succeeded", receivedAt: "2026-11-05T06:00:00.000Z", finishedAt: "2026-11-05T06:00:01.000Z", request: "close", response: "done" });

  it("a system owner's id goes with the system provider, and only with it", () => {
    expect(() => record(systemOwnerIdOf(ORG, PROJECT), "system")).not.toThrow();
    expect(() => record("a".repeat(64), "oidc")).not.toThrow();
    expect(() => record(systemOwnerIdOf(ORG, PROJECT), "oidc")).toThrow();
    expect(() => record("a".repeat(64), "system")).toThrow();
  });
});
