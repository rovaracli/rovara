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
import { limitMarkerMove, memoryResume, runDataMove, type DataMove, type MoveContext, type MovePage, type MoveReport } from "../../packages/broker/src/cloud/migrations/index.js";
import { MemoryDocumentStore } from "@rovara-code/broker/ports";

const TABLE = "state";
const TEAM = "T0A5MONEY01";
const limits = { member: 3, organization: 20 };
const developerId = "d".repeat(64);
const slackCharge = (user = "U0MAYA001") => developerCharge({ orgId: TEST_ORG, teamId: TEAM, slackUserId: user, developerId });
const ownCharge = () => developerCharge({ orgId: TEST_ORG, developerId });
const send = (db: FakeDynamoDb, items: unknown[]) => db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: items } });
const fails = async (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a cancelled transaction"); }, (error: unknown) => error);

// ---- the data move over the fake table: the move's own client is the fake (it reads and writes sets), its sources are scans of the fake ----
const context = (): MoveContext => ({ store: new MemoryDocumentStore(), now: () => new Date("2026-11-12T03:00:00.000Z"), log: () => undefined });
const scan = (db: FakeDynamoDb, pageSize: number, filter: { expression: string; names: Record<string, string>; values?: Record<string, unknown> }) => async (_context: MoveContext, cursor: string | undefined): Promise<MovePage> => {
  const start = cursor === undefined ? undefined : JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  const page = await db.send({ constructor: { name: "ScanCommand" }, input: { TableName: TABLE, Limit: pageSize, FilterExpression: filter.expression, ExpressionAttributeNames: filter.names, ...(filter.values === undefined ? {} : { ExpressionAttributeValues: filter.values }), ...(start === undefined ? {} : { ExclusiveStartKey: start }) } }) as { Items?: MovePage["items"]; LastEvaluatedKey?: Record<string, unknown> };
  return { items: page.Items ?? [], ...(page.LastEvaluatedKey === undefined ? {} : { cursor: Buffer.from(JSON.stringify(page.LastEvaluatedKey), "utf8").toString("base64url") }) };
};
const s2Move = (db: FakeDynamoDb, pageSize = 2): DataMove => limitMarkerMove({
  client: db, tableName: TABLE, sleep: async () => undefined,
  scanSets: scan(db, pageSize, { expression: "attribute_exists(#tasks) OR attribute_exists(#waiting)", names: { "#tasks": "tasks", "#waiting": "waitingOutboxIds" } }),
  scanMarkers: scan(db, pageSize, { expression: "#type = :limit OR #type = :waiting", names: { "#type": "entityType" }, values: { ":limit": "DEVELOPER_LIMIT_TASK", ":waiting": "SESSION_WAITING" } }),
});
const run = (db: FakeDynamoDb, direction: "forward" | "reverse", apply = true, extra: { maxPages?: number; resume?: ReturnType<typeof memoryResume>; pageSize?: number } = {}): Promise<MoveReport> =>
  runDataMove(s2Move(db, extra.pageSize), context(), { direction, apply, ...(extra.maxPages === undefined ? {} : { maxPages: extra.maxPages }), ...(extra.resume === undefined ? {} : { resume: extra.resume }) });

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
    await run(db, "forward");
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
    await run(db, "forward");
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

describe("the S2 move (forward)", () => {
  it("moves every set entry to a marker, leaves the counts alone, and is a no-op the second time", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2", "t3"]);
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["t4"]) });
    db.set({ pk: "WORKSPACE#ws-1", sk: "SESSION", entityType: "SESSION", workspaceId: "ws-1", state: "PROVISIONING", generation: 2, waitingOutboxIds: new Set(["o1", "o2"]) });
    const first = await run(db, "forward");
    expect(first).toMatchObject({ done: true, scanned: 6, writes: 6, conflicts: 0 });
    expect(db.get(slackCharge().member)).not.toHaveProperty("tasks");
    expect(db.get(slackCharge().member)).toMatchObject({ count: 4, threads: [`${TEAM}/C0A5/1.000001`] });
    expect(heldTasks(db, slackCharge().member)).toEqual(["t1", "t2", "t3"]);
    expect(heldTasks(db, ownCharge().member)).toEqual(["t4"]);
    expect(db.get(slackCharge().member.pk, "TASK#t1")).toMatchObject({ entityType: "DEVELOPER_LIMIT_TASK", taskId: "t1", memberSk: slackCharge().member.sk, migratedFrom: "s2-migration" });
    expect(db.get("WORKSPACE#ws-1", "SESSION")).not.toHaveProperty("waitingOutboxIds");
    expect(await parkedOutboxIds(db, TABLE, "ws-1", db.get("WORKSPACE#ws-1", "SESSION"))).toEqual(["o1", "o2"]);
    const before = snapshot(db);
    const second = await run(db, "forward");
    expect(second).toMatchObject({ scanned: 0, writes: 0, conflicts: 0 });
    expect(snapshot(db)).toEqual(before);
  });

  it("moves both counter families: the person's own and a Slack team member's", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["slack-1"]);
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["own-1"]) });
    await run(db, "forward");
    expect(heldTasks(db, slackCharge().member)).toEqual(["slack-1"]);
    expect(heldTasks(db, ownCharge().member)).toEqual(["own-1"]);
    expect(db.items.size).toBe(2 + 1 + 2);
  });

  it("a dry run writes nothing and reports what an apply would do", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2"]);
    const before = snapshot(db);
    const report = await run(db, "forward", false);
    expect(report).toMatchObject({ mode: "dry-run", done: true, writes: 2, conflicts: 0 });
    expect(snapshot(db)).toEqual(before);
    expect(db.commandNames().filter((name) => name !== "ScanCommand" && name !== "GetCommand")).toEqual([]);
  });

  it("a run stopped halfway and resumed does the same work once", async () => {
    const db = new FakeDynamoDb();
    for (const user of ["U0A00001", "U0A00002", "U0A00003", "U0A00004", "U0A00005"]) oldRows(db, [`${user}-task`], user);
    const resume = memoryResume();
    const partial = await run(db, "forward", true, { maxPages: 1, pageSize: 2, resume });
    expect(partial.done).toBe(false);
    expect(resume.state?.done).toBe(false);
    const rest = await run(db, "forward", true, { pageSize: 2, resume });
    expect(rest.done).toBe(true);
    expect(partial.writes + rest.writes).toBe(5);
    for (const user of ["U0A00001", "U0A00002", "U0A00003", "U0A00004", "U0A00005"]) expect(heldTasks(db, slackCharge(user).member)).toEqual([`${user}-task`]);
    expect(resume.state?.done).toBe(true);
  });

  it("an entry already in both forms is a conflict, left alone", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["both"]);
    db.set({ pk: slackLimitPk(TEST_ORG, TEAM), sk: "TASK#both", entityType: "DEVELOPER_LIMIT_TASK", taskId: "both", memberSk: "MEMBER#U0MAYA001", chargedAt: "x" });
    const before = snapshot(db);
    const report = await run(db, "forward");
    expect(report).toMatchObject({ writes: 0, conflicts: 1 });
    expect(report.conflictList[0]?.key.sk).toBe("TASK#both");
    expect(report.conflictList[0]?.reason).toContain("already a marker row");
    expect(snapshot(db)).toEqual(before);
  });

  it("a member released while the run is going is skipped, never written; a member added is left in the set for the next run", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["keep-1", "gone-1"]);
    const counter = slackCharge().member;
    let tripped = false;
    const racing = new Proxy(db, { get(target, name, receiver) {
      if (name !== "send") return Reflect.get(target, name, receiver) as unknown;
      return async (command: { constructor: { name: string } }) => {
        if (!tripped && command.constructor.name === "TransactWriteCommand") {
          tripped = true;
          // A release takes `gone-1` out of the set, and a new charge adds `new-1`, between the plan and the write.
          db.set({ ...db.get(counter)!, tasks: new Set(["keep-1", "new-1"]) });
        }
        return target.send(command as never);
      };
    } });
    const report = await runDataMove(limitMarkerMove({ client: racing, tableName: TABLE, sleep: async () => undefined, scanSets: scan(db, 5, { expression: "attribute_exists(#tasks)", names: { "#tasks": "tasks" } }), scanMarkers: scan(db, 5, { expression: "#type = :t", names: { "#type": "entityType" }, values: { ":t": "DEVELOPER_LIMIT_TASK" } }) }), context(), { direction: "forward", apply: true });
    expect(report.conflicts).toBe(0);
    expect(report.skipped).toEqual({ "gone before the write": 1 });
    expect(report.writes).toBe(1);
    expect(db.get(counter.pk, "TASK#gone-1")).toBeUndefined();
    expect(db.get(counter)).toMatchObject({ tasks: new Set(["new-1"]), count: 3 });
    expect(db.get(counter.pk, "TASK#keep-1")).toBeDefined();
    // The next run takes the member that was added.
    expect(await run(db, "forward")).toMatchObject({ writes: 1, conflicts: 0 });
    expect(heldTasks(db, counter)).toEqual(["keep-1", "new-1"]);
  });

  it("a write that is refused twice with the member still in the set is a conflict, and nothing is overwritten", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["stuck-1"]);
    const before = snapshot(db);
    const refusing = new Proxy(db, { get(target, name, receiver) {
      if (name !== "send") return Reflect.get(target, name, receiver) as unknown;
      return async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "TransactWriteCommand") throw Object.assign(new Error("refused"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
        return target.send(command as never);
      };
    } });
    const report = await runDataMove(limitMarkerMove({ client: refusing, tableName: TABLE, sleep: async () => undefined, scanSets: scan(db, 5, { expression: "attribute_exists(#tasks)", names: { "#tasks": "tasks" } }), scanMarkers: scan(db, 5, { expression: "#type = :t", names: { "#type": "entityType" }, values: { ":t": "DEVELOPER_LIMIT_TASK" } }) }), context(), { direction: "forward", apply: true });
    expect(report).toMatchObject({ writes: 0, conflicts: 1 });
    expect(report.conflictList[0]?.reason).toBe("changed under the move twice");
    expect(snapshot(db)).toEqual(before);
  });
});

describe("the S2 reverse", () => {
  const world = () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["t1", "t2"]);
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["t4"]) });
    db.set({ pk: "WORKSPACE#ws-1", sk: "SESSION", entityType: "SESSION", workspaceId: "ws-1", state: "PROVISIONING", generation: 2, waitingOutboxIds: new Set(["o1"]) });
    return db;
  };

  it("forward, reverse, forward: the reverse gives back the original rows exactly, and the second forward gives the first forward's rows", async () => {
    const db = world();
    const original = snapshot(db);
    const forward1 = await run(db, "forward");
    expect(forward1).toMatchObject({ writes: 4, conflicts: 0 });
    const moved = snapshot(db).map((item) => ({ ...item, chargedAt: undefined, parkedAt: undefined }));
    expect(snapshot(db)).not.toEqual(original);
    const reversed = await run(db, "reverse");
    expect(reversed).toMatchObject({ writes: 4, conflicts: 0, done: true });
    expect(snapshot(db)).toEqual(original);
    // And again: nothing left to move back.
    expect(await run(db, "reverse")).toMatchObject({ scanned: 0, writes: 0 });
    const forward2 = await run(db, "forward");
    expect(forward2).toMatchObject({ writes: 4, conflicts: 0 });
    expect(snapshot(db).map((item) => ({ ...item, chargedAt: undefined, parkedAt: undefined }))).toEqual(moved);
  });

  it("a reverse stopped halfway and resumed gives the same result", async () => {
    const db = world();
    const original = snapshot(db);
    await run(db, "forward");
    const resume = memoryResume();
    const partial = await run(db, "reverse", true, { maxPages: 1, pageSize: 1, resume });
    expect(partial.done).toBe(false);
    expect((await run(db, "reverse", true, { pageSize: 1, resume })).done).toBe(true);
    expect(snapshot(db)).toEqual(original);
  });

  it("a reverse dry run writes nothing", async () => {
    const db = world();
    await run(db, "forward");
    const before = snapshot(db);
    expect(await run(db, "reverse", false)).toMatchObject({ mode: "dry-run", writes: 4 });
    expect(snapshot(db)).toEqual(before);
  });

  it("also moves markers the new writers made since the switch, so the previous release can release them", async () => {
    const db = new FakeDynamoDb();
    const charge = ownCharge();
    await send(db, chargeItems(TABLE, charge, limits, "after-switch"));
    await run(db, "reverse");
    expect(db.get(charge.member)).toMatchObject({ count: 1, tasks: new Set(["after-switch"]) });
    expect(db.get(charge.member.pk, "TASK#after-switch")).toBeUndefined();
    // The previous release's own release (the set form) now frees it.
    await send(db, releaseItems(TABLE, charge, "after-switch", "set"));
    expect(db.get(charge.member)).toMatchObject({ count: 0 });
  });

  it("a marker whose counter is gone is an orphan conflict, left alone", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: slackLimitPk(TEST_ORG, TEAM), sk: "TASK#lost", entityType: "DEVELOPER_LIMIT_TASK", taskId: "lost", memberSk: "MEMBER#U0GONE001", chargedAt: "x" });
    const report = await run(db, "reverse");
    expect(report).toMatchObject({ writes: 0, conflicts: 1 });
    expect(report.conflictList[0]?.reason).toContain("orphan");
    expect(db.get(slackLimitPk(TEST_ORG, TEAM), "TASK#lost")).toBeDefined();
  });

  it("a marker also in the set is a conflict, left alone", async () => {
    const db = new FakeDynamoDb();
    oldRows(db, ["twice"]);
    db.set({ pk: slackLimitPk(TEST_ORG, TEAM), sk: "TASK#twice", entityType: "DEVELOPER_LIMIT_TASK", taskId: "twice", memberSk: "MEMBER#U0MAYA001", chargedAt: "x" });
    const report = await run(db, "reverse");
    expect(report).toMatchObject({ writes: 0, conflicts: 1 });
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

