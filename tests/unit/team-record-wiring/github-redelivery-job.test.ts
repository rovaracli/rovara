// SRL-5a: the hourly team-record job runs the GitHub redelivery sweep with a real runtime and the fake table: the sweep's state survives between runs, a broken GitHub never fails the job,
// the sweep touches no record row, and an install without a GitHub App skips it.
import { describe, expect, it } from "vitest";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import type { DeliveriesPort, DeliveryEntry } from "../../../packages/broker/src/team-record/github-redelivery.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";

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

  it("a GitHub that is down does not fail the job, deletes nothing and is counted", async () => {
    const deliveries: DeliveriesPort = { list: async () => { throw new Error("secret detail from GitHub"); }, redeliver: async () => { throw new Error("no"); } };
    const { runtime, db, logs } = build(deliveries);
    const before = JSON.stringify(db.find(() => true));
    const summary = await runtime.jobs.run("hourly");
    expect(summary.details.githubRedeliveryFailed).toBe(1);
    expect(JSON.stringify(logs)).not.toContain("secret detail");
    expect(JSON.stringify(db.find(() => true))).toBe(before);
  });

  it("writes only its own state item: no record row, event or tombstone", async () => {
    const deliveries: DeliveriesPort = { list: async () => ({ entries: [failedDelete] }), redeliver: async () => "requested" };
    const { runtime, db } = build(deliveries);
    await runtime.jobs.run("hourly");
    const items = db.find(() => true) as Array<{ entityType?: string }>;
    expect(items.map((item) => item.entityType)).toEqual(["TEAM_RECORD_GITHUB_REDELIVERY"]);
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
