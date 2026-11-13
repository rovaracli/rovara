// 0.5.18 (Slack merged identity): a Slack-only sign-in merged into the person's web sign-in. A Slack request must start the task under the SURVIVOR (never the merged-away id again), a
// task already made under the merged-away id is handed on to the survivor when they press on it, following the merge never crosses a company, and the backfill hands the rest on (dry run first,
// idempotent). The design approval's owner seat is in design-review-e2e.test.ts ("0.5.18").
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgBanKey, orgMemberKey } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { mergeSurvivor } from "../../packages/broker/src/developer/merged-owner.js";
import { backfillMergedTaskOwners } from "../../packages/broker/src/developer/merged-owner-backfill.js";
import { taskIndexKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { seatTaskOwner } from "../../packages/broker/src/aws/developer-routes/owner-seat.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { MAYA, createSingleAnswerPlanBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const SLACK_ID = developerIdForSlackUser(MAYA.slackUserId!);
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;

/** Maya's Slack-only sign-in (its own developer, provider slack), merged into her web sign-in (MAYA, "d…d"): its membership moved with the merge, as the sign-in function's merge does. */
function mergeSlackIntoWeb(h: Harness): void {
  h.db.set({ pk: `DEVELOPER#${SLACK_ID}`, sk: "META", provider: "slack", slackUserId: MAYA.slackUserId, displayName: "Maya", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: MAYA.developerId, mergedAt: "2026-11-12T07:14:41.000Z" });
  h.db.delete(developerOrgKey(SLACK_ID));
  h.db.delete(orgMemberKey(TEST_ORG, SLACK_ID));
}

const threadOf = (ts: string) => ({ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: ts });
async function slackStart(h: Harness, ts: string) {
  return h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: threadOf(ts), userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
}
const taskOf = (h: Harness, taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { developerId: string; currentOwner?: { developerId: string } };

describe("a Slack request from a person whose Slack sign-in was merged into their web sign-in", () => {
  it("starts the task under the survivor, as the person their web sign-in knows, never under the merged-away id", async () => {
    const h = await createSingleAnswerPlanBroker();
    mergeSlackIntoWeb(h);
    const started = await slackStart(h, "1695500000.000101");
    expect(started.statusCode, started.body).toBe(200);
    const task = taskOf(h, String((JSON.parse(started.body) as { taskId: string }).taskId));
    expect(task.developerId).toBe(MAYA.developerId);
    expect(task.developerId).not.toBe(SLACK_ID);
    expect(task).toMatchObject({ provider: MAYA.provider, developerName: MAYA.name, slackUserId: MAYA.slackUserId });
    expect(h.db.find((item) => item.pk === `DEVELOPER#${SLACK_ID}` && String(item.sk).startsWith("TASK#"))).toEqual([]);
  });

  it("a task made under the merged-away id before the fix is handed on to the survivor when they press on it from Slack, and their press works", async () => {
    const h = await createSingleAnswerPlanBroker();
    // Before the merge (the Slack-only person is a member of their own): the task is the Slack id's.
    seedMembership(h.db, SLACK_ID);
    const started = await slackStart(h, "1695500000.000102");
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    expect(taskOf(h, taskId).developerId).toBe(SLACK_ID);
    mergeSlackIntoWeb(h);
    const stop = await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadOf("1695500000.000102"), userId: MAYA.slackUserId });
    expect((JSON.parse(stop.body) as { outcome?: string }).outcome).not.toBe("NOT_OWNER");
    // The creator stays as history; the survivor is the task's owner now, with the task-list row.
    expect(taskOf(h, taskId)).toMatchObject({ developerId: SLACK_ID, currentOwner: { developerId: MAYA.developerId } });
    expect(h.db.find((item) => item.pk === `DEVELOPER#${MAYA.developerId}` && String(item.sk).endsWith(`#${taskId}`))).toHaveLength(1);
  });

  it("two companies: a survivor who is a member of ANOTHER company is refused, and no task is written in either", async () => {
    const h = await createSingleAnswerPlanBroker();
    mergeSlackIntoWeb(h);
    h.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    seedMembership(h.db, MAYA.developerId, { orgId: OTHER_ORG, role: "owner" });
    const before = h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META").length;
    const started = await slackStart(h, "1695500000.000103");
    expect(started.statusCode).toBe(403);
    expect(h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(before);
  });

  it("review L6: a survivor whose sign-in is revoked is refused, and no task is written", async () => {
    const h = await createSingleAnswerPlanBroker();
    mergeSlackIntoWeb(h);
    h.db.set({ ...(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META") as Record<string, unknown>), revoked: true });
    const before = h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META").length;
    const started = await slackStart(h, "1695500000.000104");
    expect(started.statusCode).toBe(403);
    expect(h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(before);
  });

  it("review L6: a merge chain longer than 5 hops is refused (the owner seat's bound), and one of 5 is followed", async () => {
    const hops = (h: Harness, count: number) => {
      // The Slack id, then count-1 intermediate merged-away ids, then MAYA: `count` merges in all.
      const ids = [SLACK_ID, ...Array.from({ length: count - 1 }, (_, index) => String(index + 1).repeat(64).slice(0, 64)), MAYA.developerId];
      for (let index = 0; index < ids.length - 1; index += 1) {
        h.db.set({ pk: `DEVELOPER#${ids[index]!}`, sk: "META", provider: "cloud", displayName: "Old", firstSignInAt: "x", lastSignInAt: "x", revoked: false, mergedInto: ids[index + 1] });
        h.db.delete(developerOrgKey(ids[index]!));
        h.db.delete(orgMemberKey(TEST_ORG, ids[index]!));
      }
    };
    const long = await createSingleAnswerPlanBroker();
    hops(long, 6);
    expect((await slackStart(long, "1695500000.000105")).statusCode).toBe(403);
    const ok = await createSingleAnswerPlanBroker();
    hops(ok, 5);
    const started = await slackStart(ok, "1695500000.000106");
    expect(started.statusCode, started.body).toBe(200);
    expect(taskOf(ok, String((JSON.parse(started.body) as { taskId: string }).taskId)).developerId).toBe(MAYA.developerId);
    const chain = new Map<string, { mergedInto?: string }>(Array.from({ length: 7 }, (_, index) => [String(index), index === 6 ? {} : { mergedInto: String(index + 1) }]));
    expect(await mergeSurvivor(async (id) => chain.get(id), "1")).toBe("6");
    expect(await mergeSurvivor(async (id) => chain.get(id), "0")).toBeUndefined();
  });

  it("single-org install: a survivor with a member row but no company pointer row (DEVELOPER_ORG) is still seated in that company", async () => {
    const h = await createSingleAnswerPlanBroker();
    mergeSlackIntoWeb(h);
    h.db.delete(developerOrgKey(MAYA.developerId));
    expect(h.db.get(orgMemberKey(TEST_ORG, MAYA.developerId))).toBeDefined();
    const started = await slackStart(h, "1695500000.000107");
    expect(started.statusCode, started.body).toBe(200);
    expect(taskOf(h, String((JSON.parse(started.body) as { taskId: string }).taskId)).developerId).toBe(MAYA.developerId);
  });

  it("a merge chain that loops is refused, never guessed", async () => {
    const records = new Map<string, { mergedInto?: string }>([["a", { mergedInto: "b" }], ["b", { mergedInto: "a" }], ["c", { mergedInto: "d" }], ["d", {}]]);
    const read = async (id: string) => records.get(id);
    expect(await mergeSurvivor(read, "a")).toBeUndefined();
    expect(await mergeSurvivor(read, "c")).toBe("d");
    expect(await mergeSurvivor(read, "d")).toBe("d");
  });
});

describe("the backfill of tasks still held by a merged-away id", () => {
  const DUP = "1".repeat(64);
  const SURVIVOR = "2".repeat(64);
  const OUTSIDER_DUP = "3".repeat(64);
  const OUTSIDER = "4".repeat(64);
  const OPEN = "11111111-1111-4111-8111-111111111111";
  const CLOSED = "22222222-2222-4222-8222-222222222222";
  const ELSEWHERE = "33333333-3333-4333-8333-333333333333";
  const CREATED = "2026-11-13T09:00:00.000Z";

  function store() {
    const db = new FakeDynamoDb();
    const person = (id: string, extra: Record<string, unknown> = {}) => db.set({ pk: `DEVELOPER#${id}`, sk: "META", provider: "cloud", displayName: "Person", revoked: false, ...extra });
    person(DUP, { provider: "slack", slackUserId: "U0DUP00001", mergedInto: SURVIVOR });
    person(SURVIVOR);
    person(OUTSIDER_DUP, { mergedInto: OUTSIDER });
    person(OUTSIDER);
    db.set({ ...developerOrgKey(SURVIVOR), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "member" });
    // The outsider's survivor is in another company; their duplicate's task is in ours: it must never be handed across.
    db.set({ ...developerOrgKey(OUTSIDER), entityType: "DEVELOPER_ORG", orgId: OTHER_ORG, role: "member" });
    const task = (taskId: string, developerId: string, extra: Record<string, unknown> = {}) => {
      db.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId, orgId: TEST_ORG, developerId, developerName: "Person", provider: "slack", project: "payments", createdAt: CREATED, ...extra });
      db.set({ ...taskIndexKey(developerId, CREATED, taskId), taskId, status: "RUNNING" });
    };
    task(OPEN, DUP);
    task(CLOSED, DUP, { closedAt: CREATED });
    task(ELSEWHERE, OUTSIDER_DUP);
    return db;
  }
  /** A client that closes the task (as a person's close would) just before the first transaction it is asked to write. */
  const closingBeforeWrite = (db: FakeDynamoDb, taskId: string) => {
    let closed = false;
    return { send: async (command: unknown) => {
      if (!closed && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        closed = true;
        db.set({ ...(db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>), closedAt: "2026-11-13T09:30:00.000Z" });
      }
      return db.send(command as never);
    } };
  };
  const run = (db: FakeDynamoDb, apply: boolean) => backfillMergedTaskOwners({ documentClient: db, stateTable: "state", signInTable: "signin", now: () => Date.parse("2026-11-13T10:00:00.000Z") }, { apply });

  it("a dry run reads only and names the open task it would hand on; --apply hands it on; a second --apply changes nothing; a closed task and another company's are left alone", async () => {
    const db = store();
    const pristine = JSON.stringify(db.find(() => true));
    const dry = await run(db, false);
    expect(dry).toMatchObject({ apply: false, merged: 2, closedSkipped: 1, taskIds: [OPEN], outcomes: { would_hand: 1, handed: 0, gone: 1 } });
    expect(JSON.stringify(db.find(() => true)), "a dry run writes nothing").toBe(pristine);

    const applied = await run(db, true);
    expect(applied).toMatchObject({ apply: true, taskIds: [OPEN], outcomes: { handed: 1, would_hand: 0, gone: 1 } });
    expect(db.get(`DEVTASK#${OPEN}`, "META")).toMatchObject({ developerId: DUP, currentOwner: { developerId: SURVIVOR } });
    expect(db.get(taskIndexKey(SURVIVOR, CREATED, OPEN))).toBeDefined();
    expect(db.get(`DEVTASK#${CLOSED}`, "META")).not.toHaveProperty("currentOwner");
    expect(db.get(`DEVTASK#${ELSEWHERE}`, "META")).not.toHaveProperty("currentOwner");

    const after = JSON.stringify(db.find(() => true));
    const again = await run(db, true);
    expect(again).toMatchObject({ taskIds: [], outcomes: { handed: 0, already: 1 } });
    expect(JSON.stringify(db.find(() => true)), "a second apply changes nothing").toBe(after);
  });

  it("review L3: a task closed between the read and the write is not handed on (the write holds only while it is open)", async () => {
    const db = store();
    const summary = await backfillMergedTaskOwners({ documentClient: closingBeforeWrite(db, OPEN), stateTable: "state", signInTable: "signin", now: () => Date.parse("2026-11-13T10:00:00.000Z") }, { apply: true });
    expect(summary.outcomes).toMatchObject({ handed: 0, closed: 1 });
    expect(summary.taskIds).toEqual([]);
    expect(db.get(`DEVTASK#${OPEN}`, "META")).not.toHaveProperty("currentOwner");
  });

  it("review L3: nothing is handed to a survivor whose sign-in is revoked, or who is banned from the company", async () => {
    for (const block of ["revoked", "banned"] as const) {
      const db = store();
      if (block === "revoked") db.set({ ...(db.get(`DEVELOPER#${SURVIVOR}`, "META") as Record<string, unknown>), revoked: true });
      else db.set({ ...orgBanKey(TEST_ORG, SURVIVOR), entityType: "ORG_BAN" });
      const summary = await run(db, true);
      expect(summary.outcomes, block).toMatchObject({ handed: 0, refused: 1 });
      expect(db.get(`DEVTASK#${OPEN}`, "META"), block).not.toHaveProperty("currentOwner");
    }
  });
});

describe("the task owner's seat (owner-seat.ts), read on its own", () => {
  const OWNER = "5".repeat(64);
  const SURVIVOR = "6".repeat(64);
  const TASK = "44444444-4444-4444-8444-444444444444";
  const CREATED = "2026-11-13T09:00:00.000Z";
  function world(survivor: { orgId: OrgId; role: string } | undefined) {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVELOPER#${OWNER}`, sk: "META", provider: "slack", slackUserId: "U0OWNER001", displayName: "Old", revoked: false, mergedInto: SURVIVOR });
    db.set({ pk: `DEVELOPER#${SURVIVOR}`, sk: "META", provider: "cloud", displayName: "Person", revoked: false });
    if (survivor !== undefined) seedMembership(db, SURVIVOR, survivor as never);
    db.set({ pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, orgId: TEST_ORG, developerId: OWNER, developerName: "Old", provider: "slack", project: "payments", createdAt: CREATED });
    db.set({ ...taskIndexKey(OWNER, CREATED, TASK), taskId: TASK, status: "RUNNING" });
    const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-13T10:00:00.000Z"), developer: { signInTableName: "signin" }, orgs: new OrgStore({ documentClient: db, tableName: "state", now: Date.now }), agents: {} };
    const task = () => db.get(`DEVTASK#${TASK}`, "META") as unknown as DeveloperTaskRecord;
    return { db, seat: () => seatTaskOwner(deps as never, TEST_ORG, task()), task };
  }

  it("seats the survivor of a merged-away owner in this company, after handing the task on", async () => {
    const w = world({ orgId: TEST_ORG, role: "member" });
    expect(await w.seat()).toMatchObject({ kind: "seated", handedOn: true, caller: { developerId: SURVIVOR, orgId: TEST_ORG } });
    expect(w.task().currentOwner).toMatchObject({ developerId: SURVIVOR });
  });

  it("review L5: a survivor who is a member but an Auditor gets its own outcome, not 'no longer a member', and the task is not handed on", async () => {
    const w = world({ orgId: TEST_ORG, role: "auditor" });
    expect(await w.seat()).toEqual({ kind: "not_writer" });
    expect(w.task()).not.toHaveProperty("currentOwner");
  });

  it("two companies: a survivor of another company, or of none, is 'not_member' and the task is not handed across", async () => {
    for (const survivor of [{ orgId: OTHER_ORG, role: "owner" }, undefined]) {
      const w = world(survivor);
      expect(await w.seat()).toMatchObject({ kind: "not_member", reason: "survivor_not_member" });
      expect(w.task()).not.toHaveProperty("currentOwner");
    }
  });
});
