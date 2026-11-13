// Convergence lane A5 (owner decision 60 item S2, convergence plan D3): Cloud's limit and session writers moved from string sets to marker rows, and the one-time
// migration and its reverse. Every rule is checked on rows as the previous release wrote them (a set) and as this one writes them (markers), and the migration
// is checked to be idempotent, resumable, exactly reversible, and silent (counts only) without --apply.
import { slackLimitPk, slackMemberLimitKey, slackOrganizationLimitKey } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { heldTasks } from "../support/limit-charges.js";
import { chargeConflict, chargeFormOf, chargeItems, chargedTaskIds, developerCharge, isTaskCharged, releaseConflict, releaseItems } from "../../packages/broker/src/developer/limits.js";
import { SessionManager, parkedOutboxIds, sessionWaitingKey } from "../../packages/broker/src/aws/sessions.js";
import { withdrawParkedDelivery } from "../../packages/broker/src/aws/parked-stop.js";
import { migrateS2MarkerRows, type S2Options } from "../../packages/broker/src/migrations/s2-marker-rows.js";
import { parseS2Args, runS2Migration } from "../../scripts/migrate-s2-marker-rows.js";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TABLE = "state";
const TEAM = "T0A5MONEY01";
const limits = { member: 3, organization: 20 };
const developerId = "d".repeat(64);
const slackCharge = (user = "U0MAYA001") => developerCharge({ orgId: TEST_ORG, teamId: TEAM, slackUserId: user, developerId });
const ownCharge = () => developerCharge({ orgId: TEST_ORG, developerId });
const send = (db: FakeDynamoDb, items: unknown[]) => db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: items } });
const fails = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a cancelled transaction"); }, (error: unknown) => error);
const options = (overrides: Partial<S2Options> = {}): S2Options => ({ direction: "forward", apply: true, pageSize: 2, maxMs: 60_000, pauseMs: 0, ...overrides });
const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: TABLE, now: () => Date.parse("2026-11-12T03:00:00.000Z"), sleep: async () => undefined });

/** A Slack member counter and an organization counter as the previous release left them: tasks in the `tasks` set, threads in `threads`. */
function oldRows(db: FakeDynamoDb, tasks: string[], user = "U0MAYA001"): void {
  db.set({ ...slackMemberLimitKey(TEST_ORG, TEAM, user), entityType: "SLACK_LIMIT", count: tasks.length + 1, threads: [`${TEAM}/C0A5/1.000001`], ...(tasks.length === 0 ? {} : { tasks: new Set(tasks) }) });
  db.set({ ...slackOrganizationLimitKey(TEST_ORG, TEAM), entityType: "SLACK_LIMIT", count: tasks.length + 1 });
}

const snapshot = (db: FakeDynamoDb) => [...db.items.values()].map((item) => structuredClone(item)).sort((a, b) => `${String(a.pk)}|${String(a.sk)}`.localeCompare(`${String(b.pk)}|${String(b.sk)}`));

describe("workspace limits on both stored forms", () => {
  it("a task charged in the old set form is released through the set, once, exactly as before", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["old-1", "old-2"]);
    const charge = slackCharge();
    expect(await chargeFormOf(db, TABLE, charge, "old-1")).toBe("set");
    await send(db, releaseItems(TABLE, charge, "old-1", "set"));
    expect(db.get(charge.member)).toMatchObject({ count: 2, tasks: new Set(["old-2"]) });
    expect(db.get(charge.organization)).toMatchObject({ count: 2 });
    const repeat = await fails(send(db, releaseItems(TABLE, charge, "old-1", await chargeFormOf(db, TABLE, charge, "old-1"))));
    expect(await releaseConflict(db, TABLE, charge, "old-1", repeat, "set")).toBe("already_released");
    expect(db.get(charge.member)).toMatchObject({ count: 2 });
  });

  it("a task in the old set cannot be charged again by the new writer", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["old-1"]);
    const charge = slackCharge();
    const repeat = await fails(send(db, chargeItems(TABLE, charge, limits, "old-1")));
    expect(await chargeConflict(db, TABLE, charge, "old-1", repeat)).toBe("already_charged");
    expect(db.get(charge.member)).toMatchObject({ count: 2 });
    expect(db.get(charge.member.pk, "TASK#old-1")).toBeUndefined();
  });

  it("a new charge is a marker with Code's key; a repeat fails at the marker; the release frees it once", async () => {
    const db = new FakeDynamoDb();
    const charge = ownCharge();
    await send(db, chargeItems(TABLE, charge, limits, "new-1", "2026-11-12T00:00:00.000Z"));
    expect(db.get(charge.member.pk, "TASK#new-1")).toEqual({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "TASK#new-1", entityType: "DEVELOPER_LIMIT_TASK", taskId: "new-1", memberSk: "MEMBER", chargedAt: "2026-11-12T00:00:00.000Z" });
    const repeat = await fails(send(db, chargeItems(TABLE, charge, limits, "new-1")));
    expect(await chargeConflict(db, TABLE, charge, "new-1", repeat)).toBe("already_charged");
    expect(db.get(charge.member)).toMatchObject({ count: 1 });
    expect(await chargeFormOf(db, TABLE, charge, "new-1")).toBe("marker");
    await send(db, releaseItems(TABLE, charge, "new-1", "marker"));
    const again = await fails(send(db, releaseItems(TABLE, charge, "new-1", "marker")));
    expect(await releaseConflict(db, TABLE, charge, "new-1", again, "marker")).toBe("already_released");
    expect(db.get(charge.member)).toMatchObject({ count: 0 });
    expect(db.get(charge.organization)).toMatchObject({ count: 0 });
  });

  it("a release whose form moved under it (the migration ran in between) is retried, never called released", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["mid-1"]);
    const charge = slackCharge();
    const form = await chargeFormOf(db, TABLE, charge, "mid-1");
    await migrateS2MarkerRows(deps(db), options());
    const error = await fails(send(db, releaseItems(TABLE, charge, "mid-1", form)));
    await expect(releaseConflict(db, TABLE, charge, "mid-1", error, form)).rejects.toBe(error);
    expect(await isTaskCharged(db, TABLE, charge, "mid-1")).toBe(true);
  });

  it("the full counters still refuse a different task, in either form", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["a", "b"]);
    const charge = slackCharge();
    const full = await fails(send(db, chargeItems(TABLE, charge, limits, "c")));
    expect(await chargeConflict(db, TABLE, charge, "c", full)).toBe("member");
    await migrateS2MarkerRows(deps(db), options());
    const stillFull = await fails(send(db, chargeItems(TABLE, charge, limits, "c")));
    expect(await chargeConflict(db, TABLE, charge, "c", stillFull)).toBe("member");
  });

  it("chargedTaskIds reads both forms and only the member's own markers in a shared Slack partition", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["set-1"]);
    await send(db, chargeItems(TABLE, slackCharge(), { member: 9, organization: 99 }, "marker-1"));
    db.set({ ...slackMemberLimitKey(TEST_ORG, TEAM, "U0OTHER01"), entityType: "SLACK_LIMIT", count: 0 });
    await send(db, chargeItems(TABLE, slackCharge("U0OTHER01"), { member: 9, organization: 99 }, "other-1"));
    expect((await chargedTaskIds(db, TABLE, slackCharge().member)).sort()).toEqual(["marker-1", "set-1"]);
    expect(await chargedTaskIds(db, TABLE, slackCharge("U0OTHER01").member)).toEqual(["other-1"]);
    expect(slackCharge().member.pk).toBe(slackLimitPk(TEST_ORG, TEAM));
  });
});

describe("the S2 migration (forward)", () => {
  it("moves every set entry to a marker, leaves the counts alone, and is a no-op the second time", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2", "t3"]);
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["t4"]) });
    db.set({ pk: "WORKSPACE#ws-1", sk: "SESSION", entityType: "SESSION", workspaceId: "ws-1", state: "PROVISIONING", generation: 2, waitingOutboxIds: new Set(["o1", "o2"]) });
    const first = await migrateS2MarkerRows(deps(db), options());
    expect(first.finished).toBe(true);
    expect(first.counts).toMatchObject({ limitCounters: 2, limitEntries: 4, limitMoved: 4, limitConflicts: 0, sessions: 1, sessionEntries: 2, sessionMoved: 2, sessionConflicts: 0 });
    expect(db.get(slackCharge().member)).not.toHaveProperty("tasks");
    expect(db.get(slackCharge().member)).toMatchObject({ count: 4, threads: [`${TEAM}/C0A5/1.000001`] });
    expect(heldTasks(db, slackCharge().member)).toEqual(["t1", "t2", "t3"]);
    expect(heldTasks(db, ownCharge().member)).toEqual(["t4"]);
    expect(db.get("WORKSPACE#ws-1", "SESSION")).not.toHaveProperty("waitingOutboxIds");
    expect(await parkedOutboxIds(db, TABLE, "ws-1", db.get("WORKSPACE#ws-1", "SESSION"))).toEqual(["o1", "o2"]);
    const before = snapshot(db);
    const second = await migrateS2MarkerRows(deps(db), options());
    expect(second.counts).toMatchObject({ limitEntries: 0, limitMoved: 0, sessionEntries: 0, sessionMoved: 0 });
    expect(snapshot(db)).toEqual(before);
  });

  it("a dry run writes nothing and reports counts only", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2"]);
    const before = snapshot(db);
    const result = await migrateS2MarkerRows(deps(db), options({ apply: false }));
    expect(result).toMatchObject({ applied: false, finished: true, counts: { limitEntries: 2, limitMoved: 2 } });
    expect(snapshot(db)).toEqual(before);
    expect(db.commandNames().filter((name) => name !== "ScanCommand" && name !== "GetCommand")).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("t1");
  });

  it("stops at --max-ms with a key to resume from, and the resumed run finishes the same work once", async () => {
    const db = new FakeDynamoDb();
    for (const user of ["U0A00001", "U0A00002", "U0A00003", "U0A00004", "U0A00005"]) oldRows(db, [`${user}-task`], user);
    let clock = 0;
    const ticking = { ...deps(db), now: () => (clock += 1_000) };
    const partial = await migrateS2MarkerRows(ticking, options({ maxMs: 500 }));
    expect(partial.finished).toBe(false);
    expect(partial.resume).toBeDefined();
    const rest = await migrateS2MarkerRows(deps(db), options({ start: partial.resume }));
    expect(rest.finished).toBe(true);
    expect(partial.counts.limitMoved + rest.counts.limitMoved).toBe(5);
    for (const user of ["U0A00001", "U0A00002", "U0A00003", "U0A00004", "U0A00005"]) expect(heldTasks(db, slackCharge(user).member)).toEqual([`${user}-task`]);
  });

  it("an entry already in both forms is left alone and reported as a conflict", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["both"]);
    db.set({ pk: slackLimitPk(TEST_ORG, TEAM), sk: "TASK#both", entityType: "DEVELOPER_LIMIT_TASK", taskId: "both", memberSk: "MEMBER#U0MAYA001", chargedAt: "x" });
    const before = snapshot(db);
    const result = await migrateS2MarkerRows(deps(db), options());
    expect(result.counts).toMatchObject({ limitEntries: 1, limitMoved: 0, limitConflicts: 1 });
    expect(snapshot(db)).toEqual(before);
  });
});

describe("the S2 reverse", () => {
  it("restores the old rows exactly: forward then reverse leaves the table as it was", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2"]);
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["t4"]) });
    db.set({ pk: "WORKSPACE#ws-1", sk: "SESSION", entityType: "SESSION", workspaceId: "ws-1", state: "PROVISIONING", generation: 2, waitingOutboxIds: new Set(["o1"]) });
    const original = snapshot(db);
    await migrateS2MarkerRows(deps(db), options());
    expect(snapshot(db)).not.toEqual(original);
    const reversed = await migrateS2MarkerRows(deps(db), options({ direction: "reverse" }));
    expect(reversed.counts).toMatchObject({ limitEntries: 3, limitMoved: 3, limitOrphans: 0, sessionEntries: 1, sessionMoved: 1 });
    expect(snapshot(db)).toEqual(original);
    // And again: nothing left to move back.
    expect((await migrateS2MarkerRows(deps(db), options({ direction: "reverse" }))).counts).toMatchObject({ limitEntries: 0, sessionEntries: 0 });
  });

  it("also moves markers the new writers made since the switch, so the previous release can release them", async () => {
    const db = new FakeDynamoDb();
    const charge = ownCharge();
    await send(db, chargeItems(TABLE, charge, limits, "after-switch"));
    await migrateS2MarkerRows(deps(db), options({ direction: "reverse" }));
    expect(db.get(charge.member)).toMatchObject({ count: 1, tasks: new Set(["after-switch"]) });
    expect(db.get(charge.member.pk, "TASK#after-switch")).toBeUndefined();
    // The previous release's own release (the set form) now frees it.
    await send(db, releaseItems(TABLE, charge, "after-switch", "set"));
    expect(db.get(charge.member)).toMatchObject({ count: 0 });
  });

  it("a marker whose counter is gone is an orphan, left alone", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: slackLimitPk(TEST_ORG, TEAM), sk: "TASK#lost", entityType: "DEVELOPER_LIMIT_TASK", taskId: "lost", memberSk: "MEMBER#U0GONE001", chargedAt: "x" });
    const result = await migrateS2MarkerRows(deps(db), options({ direction: "reverse" }));
    expect(result.counts).toMatchObject({ limitEntries: 1, limitOrphans: 1, limitMoved: 0 });
    expect(db.get(slackLimitPk(TEST_ORG, TEAM), "TASK#lost")).toBeDefined();
  });
});

describe("parked deliveries on both stored forms", () => {
  const sessions = (db: FakeDynamoDb) => new SessionManager({ documentClient: db as never, tableName: TABLE, now: () => new Date("2026-11-12T00:00:00.000Z") });

  it("a session reads parked records from the old set and from markers, and releasing one removes it from both", async () => {
    const db = new FakeDynamoDb();
    const ws = "11111111-1111-4111-8111-111111111111", oldId = "22222222-2222-4222-8222-222222222222", newId = "33333333-3333-4333-8333-333333333333";
    db.set({ pk: `WORKSPACE#${ws}`, sk: "SESSION", entityType: "SESSION", workspaceId: ws, state: "PROVISIONING", generation: 1, availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0", waitingOutboxIds: new Set([oldId]) });
    db.set({ ...sessionWaitingKey(ws, newId), entityType: "SESSION_WAITING", workspaceId: ws, outboxId: newId, parkedAt: "x" });
    for (const id of [oldId, newId]) db.set({ pk: `OUTBOX#${id}`, sk: "OUTBOX", status: "WAITING_FOR_SESSION", workspaceId: ws, operationId: `op-${id}` });
    expect((await sessions(db).get(ws))?.waitingOutboxIds).toEqual([oldId, newId].sort());
    expect((await sessions(db).requeueParked(ws)).requeued.sort()).toEqual([oldId, newId].sort());
    expect(db.get(`WORKSPACE#${ws}`, "SESSION")).not.toHaveProperty("waitingOutboxIds");
    expect(db.get(sessionWaitingKey(ws, newId))).toBeUndefined();
    expect(db.get(`OUTBOX#${newId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
    expect((await sessions(db).get(ws))?.waitingOutboxIds).toBeUndefined();
  });

  it("a Stop withdraws a parked delivery in either form", async () => {
    for (const form of ["set", "marker"] as const) {
      const db = new FakeDynamoDb();
      db.set({ pk: "WORKSPACE#ws-3", sk: "SESSION", entityType: "SESSION", workspaceId: "ws-3", state: "PROVISIONING", generation: 1, ...(form === "set" ? { waitingOutboxIds: new Set(["o3"]) } : {}) });
      if (form === "marker") db.set({ ...sessionWaitingKey("ws-3", "o3"), entityType: "SESSION_WAITING", workspaceId: "ws-3", outboxId: "o3", parkedAt: "x" });
      db.set({ pk: "OUTBOX#o3", sk: "OUTBOX", status: "WAITING_FOR_SESSION", workspaceId: "ws-3", operationId: "op-3" });
      expect(await withdrawParkedDelivery(db, TABLE, "ws-3", "op-3")).toBe(true);
      expect(db.get("OUTBOX#o3", "OUTBOX")).toMatchObject({ status: "FAILED" });
      expect(await parkedOutboxIds(db, TABLE, "ws-3", db.get("WORKSPACE#ws-3", "SESSION"))).toEqual([]);
    }
  });
});

describe("the migration script's resume file", () => {
  it("keeps a stopped run's key in a mode-600 file, never in its output, and the next run goes on from it and deletes the file", async () => {
    const db = new FakeDynamoDb();
    // A key that names a person, as an ORG_EMAIL# row can: it must never reach the output.
    db.set({ pk: "ORG_EMAIL#person@example.com", sk: "MEMBER", entityType: "ORG_EMAIL" });
    for (const user of ["U0B00001", "U0B00002", "U0B00003", "U0B00004"]) oldRows(db, [`${user}-task`], user);
    const resumeFile = join(mkdtempSync(join(tmpdir(), "s2-resume-")), "resume.json");
    const args = { ...parseS2Args(["--table", TABLE, "--region", "us-west-2", "--direction", "forward", "--apply", "yes", "--page-size", "1", "--max-ms", "0", "--resume-file", resumeFile], {}), pauseMs: 0 };
    let clock = 0;
    const first = await runS2Migration(args, db, () => (clock += 1));
    expect(first.finished).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(/ORG_EMAIL|example\.com|"pk"|"sk"/);
    expect(existsSync(resumeFile)).toBe(true);
    expect(statSync(resumeFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(resumeFile, "utf8"))).toHaveProperty("pk");
    let moved = first.counts.limitMoved;
    for (let run = 0; run < 20 && existsSync(resumeFile); run += 1) moved += (await runS2Migration(args, db, () => (clock += 1))).counts.limitMoved;
    expect(existsSync(resumeFile)).toBe(false);
    expect(moved).toBe(4);
  });

  it("a dry run and an applying run keep separate resume files by default", () => {
    expect(parseS2Args(["--table", "State", "--region", "us-west-2", "--direction", "forward"], {}).resumeFile).not.toBe(parseS2Args(["--table", "State", "--region", "us-west-2", "--direction", "forward", "--apply", "yes"], {}).resumeFile);
  });
});

describe("the migration script's arguments", () => {
  it("needs a table, a region and a direction, and writes only with --apply yes", () => {
    expect(parseS2Args(["--table", "State", "--region", "us-west-2", "--direction", "forward"], {})).toMatchObject({ apply: false, direction: "forward" });
    expect(parseS2Args(["--table", "State", "--region", "us-west-2", "--direction", "reverse", "--apply", "yes"], {})).toMatchObject({ apply: true, direction: "reverse" });
    expect(() => parseS2Args(["--region", "us-west-2", "--direction", "forward"], {})).toThrow(/--table/);
    expect(() => parseS2Args(["--table", "State", "--direction", "forward"], {})).toThrow(/--region/);
    expect(() => parseS2Args(["--table", "State", "--region", "us-west-2"], {})).toThrow(/--direction/);
    expect(() => parseS2Args(["--table", "State", "--region", "us-west-2", "--direction", "forward", "--apply", "true"], {})).toThrow(/--apply/);
  });
});
