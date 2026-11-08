// SRL-5a: the hourly team-record job runs the GitHub redelivery sweep with a real runtime and the fake table: the sweep's state survives between runs, a broken GitHub never fails the job,
// the sweep touches no record row, and an install without a GitHub App skips it.
import { describe, expect, it } from "vitest";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import type { DeliveriesPort, DeliveryEntry } from "../../../packages/broker/src/team-record/github-redelivery.js";
import { opsFailuresCheck } from "../../../packages/broker/src/team-record/ops-failures.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const failedDelete: DeliveryEntry = { id: 77, guid: "00000000-0000-4000-8000-000000000077", deliveredAt: new Date(NOW - 3_600_000).toISOString(), redelivery: false, event: "issue_comment", action: "deleted", statusCode: 503 };

function build(deliveries: DeliveriesPort | undefined) {
  const db = new FakeDynamoDb({ indexKeys });
  const logs: Array<Record<string, unknown>> = [];
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, log: (entry) => logs.push(entry), ...(deliveries === undefined ? {} : { githubDeliveries: deliveries }) });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return { db, runtime, logs };
}

describe("the hourly job's GitHub redelivery sweep", () => {
  it("asks for a failed delete once, keeps its state between runs, and reports counts only", async () => {
    const asked: number[] = [];
    const entries = [failedDelete];
    const deliveries: DeliveriesPort = {
      list: async () => ({ entries: [...entries] }),
      redeliver: async (id) => { asked.push(id); entries.unshift({ ...failedDelete, id: 78, redelivery: true, deliveredAt: new Date(NOW).toISOString(), statusCode: 200 }); return "requested"; },
    };
    const { runtime } = build(deliveries);
    const first = await runtime.jobs.run("hourly");
    expect(first.details).toMatchObject({ githubRedelivered: 1, githubRedeliveryFailed: 0, githubRedeliveryDeferred: 0, githubRedeliveryGaps: 0 });
    const second = await runtime.jobs.run("hourly");
    expect(second.details.githubRedelivered).toBe(0);
    expect(asked).toEqual([77]);
  });

  it("a GitHub that is down does not fail the job, deletes nothing, is counted in the job summary and as ONE fixed operator line, and never shows on any company's Health (R2)", async () => {
    const deliveries: DeliveriesPort = { list: async () => { throw new Error("secret detail from GitHub"); }, redeliver: async () => { throw new Error("no"); } };
    const { runtime, db, logs } = build(deliveries);
    const summary = await runtime.jobs.run("hourly");
    expect(summary.details.githubRedeliveryFailed).toBe(1);
    expect(JSON.stringify(logs)).not.toContain("secret detail");
    expect(logs.filter((entry) => entry.event === "record.github_sweep_problem")).toHaveLength(1);
    // Nothing is written for it, and a company's Health does not move: the sweep is App-wide and its failures are Rovara's to alarm on.
    expect(db.find(() => true)).toEqual([]);
    const health = await runtime.opsFailures(TEST_ORG);
    expect(health).toEqual({ eraseSweep: 0, tombstone: 0 });
    expect(opsFailuresCheck(health).status).toBe("ok");
  });

  it("a delivery GitHub says it no longer has (404) is a delete lost for good: it is a problem line, not just a count (R3)", async () => {
    const deliveries: DeliveriesPort = { list: async () => ({ entries: [failedDelete] }), redeliver: async () => "gone" };
    const { runtime, logs } = build(deliveries);
    const summary = await runtime.jobs.run("hourly");
    expect(summary.details).toMatchObject({ githubRedeliveryGone: 1, githubRedelivered: 0 });
    expect(logs.map((entry) => entry.event)).toContain("record.github_redelivery_gone");
    expect(logs.find((entry) => entry.event === "record.github_sweep_problem")).toMatchObject({ gone: 1 });
  });

  it("writes only its own state item: no record row, event or tombstone", async () => {
    const deliveries: DeliveriesPort = { list: async () => ({ entries: [failedDelete] }), redeliver: async () => "requested" };
    const { runtime, db } = build(deliveries);
    await runtime.jobs.run("hourly");
    const items = db.find(() => true) as Array<{ entityType?: string }>;
    expect(items.map((item) => item.entityType)).toEqual(["TEAM_RECORD_GITHUB_REDELIVERY"]);
  });

  it("two hourly runs that overlap cannot write over each other: the one that saves second finds the state changed and drops its own (L11)", async () => {
    const entries = [failedDelete];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFirst: DeliveriesPort = { list: async () => { await gate; return { entries }; }, redeliver: async () => "requested" };
    const fast: DeliveriesPort = { list: async () => ({ entries }), redeliver: async () => "requested" };
    const db = new FakeDynamoDb({ indexKeys });
    const logs: Array<Record<string, unknown>> = [];
    const a = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, githubDeliveries: slowFirst, log: (entry) => logs.push(entry) })!;
    const b = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, githubDeliveries: fast })!;
    const running = a.jobs.run("hourly");
    await b.jobs.run("hourly");
    release();
    await running;
    const state = db.find((item) => item.sk === "GHREDELIVERY#state")[0] as { rev: number };
    // The fast run wrote revision 1; the slow run (which read "no state") was refused, so the state is still revision 1.
    expect(state.rev).toBe(1);
    expect(logs.map((entry) => entry.event)).toContain("record.github_redelivery_state_conflict");
  });

  it("a state item without a revision (hand-written, or an older or future format) reads as version 0: the next run saves it and later runs keep working, with no conflict (R7)", async () => {
    const deliveries: DeliveriesPort = { list: async () => ({ entries: [failedDelete] }), redeliver: async () => "requested" };
    const { runtime, db, logs } = build(deliveries);
    await runtime.jobs.run("hourly");
    const written = { ...db.find((item) => item.sk === "GHREDELIVERY#state")[0]! };
    delete written["rev"];
    db.set(written);
    expect((db.find((item) => item.sk === "GHREDELIVERY#state")[0] as { rev?: number }).rev).toBeUndefined();
    const second = await runtime.jobs.run("hourly");
    expect(second.details.githubRedeliveryFailed).toBe(0);
    expect(logs.map((entry) => entry.event)).not.toContain("record.github_redelivery_state_conflict");
    expect((db.find((item) => item.sk === "GHREDELIVERY#state")[0] as { rev: number }).rev).toBe(1);
    const third = await runtime.jobs.run("hourly");
    expect(third.details.githubRedeliveryFailed).toBe(0);
    expect(logs.map((entry) => entry.event)).not.toContain("record.github_redelivery_state_conflict");
    expect((db.find((item) => item.sk === "GHREDELIVERY#state")[0] as { rev: number }).rev).toBe(2);
  });

  it("an install whose GitHub App is not set up skips the sweep quietly: no call, no failure counted", async () => {
    let called = 0;
    const db = new FakeDynamoDb({ indexKeys });
    const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, githubAppReady: async () => false, githubDeliveries: { list: async () => { called += 1; return { entries: [] }; }, redeliver: async () => "requested" } });
    const summary = await runtime!.jobs.run("hourly");
    expect(called).toBe(0);
    expect(summary.details.githubRedeliveryFailed).toBeUndefined();
    expect(db.find(() => true)).toEqual([]);
  });

  it("an install without a GitHub App skips the sweep", async () => {
    const { runtime, db } = build(undefined);
    const summary = await runtime.jobs.run("hourly");
    expect(Object.keys(summary.details).filter((key) => key.startsWith("githubRedelivery") || key === "githubRedelivered")).toEqual([]);
    expect(db.find(() => true)).toEqual([]);
  });

  it("is not run by the nightly job", async () => {
    let listed = 0;
    const { runtime } = build({ list: async () => { listed += 1; return { entries: [] }; }, redeliver: async () => "requested" });
    await runtime.jobs.run("nightly");
    expect(listed).toBe(0);
  });
});
