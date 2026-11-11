// EMB-7 M1: the hourly job's clean-up of REEMBED# state runs AFTER every company's work and BEFORE the GitHub repository pass, so it must never use the time the pass needs. It gets a small share of what is left
// of the run (and none when under the GitHub pass's own two seconds would remain), a cap on the workspaces it looks at, and what it could not reach waits for the next hour.
import { describe, expect, it } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { readReembedStates } from "../../../packages/broker/src/team-record/reembed.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const table = (db: FakeDynamoDb) => ({ documentClient: db as never, tableName: "TeamRecord" });
/** Workspaces that left the directory but still hold a re-embed state: the sweep deletes them without a closing check. */
const leftOvers = (count: number): OrgId[] => Array.from({ length: count }, (_, index) => `org_gone${String(index).padStart(16, "0")}`);

function seed(db: FakeDynamoDb, orgs: readonly OrgId[]): void {
  for (const orgId of orgs) db.set({ pk: "TEAM_RECORD_ORGS", sk: `REEMBED#${orgId}`, entityType: "TEAM_RECORD_REEMBED_STATE", orgId, servedAt: 5, idleUntil: 0, passWork: 0 });
}
/** A clock that moves `stepMs` for every delete of a re-embed state, so each removal "takes time". */
function build(db: FakeDynamoDb, clock: { now: number }, stepMs: number, extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}) {
  const send = db.send;
  db.send = async (command) => {
    const input = (command as { input?: { Key?: { sk?: unknown } } }).input;
    if (command.constructor.name === "DeleteCommand" && typeof input?.Key?.sk === "string" && input.Key.sk.startsWith("REEMBED#")) clock.now += stepMs;
    return send(command);
  };
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => clock.now, log: () => undefined, ...extra });
  if (runtime === undefined) throw new Error("the runtime was not built");
  return runtime;
}

describe("the hourly job's re-embed state clean-up (EMB-7 M1)", () => {
  it("runs with the budget it has, and removes the state of workspaces that left the directory", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    seed(db, leftOvers(3));
    const summary = await build(db, { now: NOW }, 0).jobs.run("hourly");
    expect(summary.details.reembedStateDeleted).toBe(3);
    expect((await readReembedStates(table(db))).size).toBe(0);
  });

  it("is skipped (a counted detail, nothing read or deleted) when the run's budget leaves the GitHub pass under its two seconds", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    seed(db, leftOvers(3));
    const summary = await build(db, { now: NOW }, 0, { jobBudgetMs: 1_500 }).jobs.run("hourly");
    expect(summary.details.reembedSweepSkipped).toBe(1);
    expect(summary.details.reembedStateDeleted).toBe(0);
    expect((await readReembedStates(table(db))).size).toBe(3);
  });

  it("stops at its own time limit instead of walking every workspace, and the rest is removed by the next hour's run", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    seed(db, leftOvers(10));
    const clock = { now: NOW };
    // 3 s budget: the GitHub pass keeps its 2 s, the sweep gets 1 s; each removal takes 400 ms, so three start (0, 400, 800) and the fourth (1,200) does not
    const runtime = build(db, clock, 400, { jobBudgetMs: 3_000 });
    const first = await runtime.jobs.run("hourly");
    expect(first.details.reembedStateDeleted).toBe(3);
    expect(first.details.reembedSweepLeft).toBe(7);
    expect((await readReembedStates(table(db))).size).toBe(7);
    clock.now += 3_600_000;
    const second = await runtime.jobs.run("hourly");
    expect(second.details.reembedStateDeleted).toBe(3);
    expect((await readReembedStates(table(db))).size).toBe(4);
  });
});
