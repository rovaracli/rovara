// Lessons in production, lane 2 (WB-7): a commit that meets an unfinished earlier change (the staged rollback's open intent) resumes it first and tries once more; still stuck is a fixed LESSON_BUSY refusal,
// never the RUNTIME_UNAVAILABLE that `heal` throws (a route would show that as the service being down).
import { describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { DynamoLessonStore } from "../../../packages/broker/src/lessons/dynamo-store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { ORG_A } from "../../support/team-record-core.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { lessonRecord } from "./lesson-helpers.js";

const KEY = { workspaceId: ORG_A, project: "web" };
const mk = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, workspaceId: ORG_A, project: "web", ...over });
const BIG = Array.from({ length: 130 }, (_, i) => `les_big${String(i).padStart(5, "0")}`);
const isFinal = (command: unknown): boolean => (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("LESSONSET#SNAP#");

async function commitAll(store: DynamoLessonStore, lessons: Lesson[]): Promise<void> {
  for (let i = 0; i < lessons.length; i += 30) await store.commit(KEY, await store.setVersion(KEY), lessons.slice(i, i + 30), 10);
}

/** A table with a rollback that died before its final step: the intent is open and names the lessons it had rewritten. */
async function withOpenIntent() {
  const db = new FakeDynamoDb();
  const store = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" });
  await commitAll(store, BIG.map((id) => mk(id)));
  await commitAll(store, BIG.map((id) => ({ ...mk(id, { title: "Later" }), version: 2 })));
  const dying = new DynamoLessonStore({ documentClient: { send: async (command: unknown) => { if (isFinal(command)) throw new Error("process died"); return db.send(command as never); } }, tableName: "TeamRecord" });
  await expect(dying.rollback(KEY, 5, 10, 30)).rejects.toThrow("process died");
  expect(db.find((item) => item.sk === "LESSONSET#RBINTENT")).toHaveLength(1);
  return { db, store };
}
const commitOne = async (store: DynamoLessonStore) => store.commit(KEY, await store.setVersion(KEY), [mk("les_other001")], 50);

describe("a commit that meets a stuck intent", () => {
  it("resumes the intent first: the ordinary case finishes it and the commit goes through (no refusal)", async () => {
    const { db, store } = await withOpenIntent();
    expect(await commitOne(store)).toMatchObject({ ok: true });
    expect(db.find((item) => item.sk === "LESSONSET#RBINTENT")).toEqual([]);
  });

  it("tries once more when the first resume could not finish, and goes through when the second does", async () => {
    const { db } = await withOpenIntent();
    let missedOnce = false;
    const flaky = new DynamoLessonStore({
      documentClient: { send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const key = (command as { input: { Key?: { sk?: string } } }).input.Key;
        // The version item the heal needs is not there the first time it asks (a read that came back empty), then it is.
        if (!missedOnce && name === "GetCommand" && /#V#000000000002$/u.test(key?.sk ?? "")) { missedOnce = true; return {}; }
        return db.send(command as never);
      } },
      tableName: "TeamRecord",
    });
    expect(await commitOne(flaky)).toMatchObject({ ok: true });
    expect(missedOnce).toBe(true);
  });

  it("still stuck after the second try is a fixed LESSON_BUSY (409) refusal, the intent stays for the next call, and the text names nothing", async () => {
    const { db, store } = await withOpenIntent();
    const intent = db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]!;
    db.delete({ pk: intent.pk as string, sk: `LESSON#${(intent.ids as string[])[0]!}#V#000000000002` });
    const outcome = await commitOne(store).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(AgentXError);
    expect(outcome).toMatchObject({ code: "LESSON_BUSY", statusCode: 409 });
    expect((outcome as Error).message).not.toMatch(/les_|version|RUNTIME_UNAVAILABLE/u);
    expect(db.find((item) => item.sk === "LESSONSET#RBINTENT")).toHaveLength(1);
    // A rollback meets the same intent the same way.
    await expect(store.rollback(KEY, 5, await store.setVersion(KEY), 60)).rejects.toMatchObject({ code: "LESSON_BUSY" });
  });

  it("L5: every busy refusal is counted on the intent and logged with a hashed scope and the intent's age; the fifth is recorded as an alert (stuckAt) and its text says it needs an administrator, not 'try again'", async () => {
    const { db } = await withOpenIntent();
    const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
    const store = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" }, () => 1_000, undefined, (event, fields) => logs.push({ event, fields }));
    const intent = db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]!;
    db.delete({ pk: intent.pk as string, sk: `LESSON#${(intent.ids as string[])[0]!}#V#000000000002` });
    const texts: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const error = await commitOne(store).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: "LESSON_BUSY", statusCode: 409 });
      texts.push(error!.message);
      const row = db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]!;
      expect(row["busyCount"]).toBe(attempt);
      expect(row["stuckAt"] !== undefined, `after ${attempt}`).toBe(attempt >= 5);
    }
    // The first four say "try again"; from the fifth on the refusal says the repair needs an administrator (a permanent fault must not read as a passing one).
    expect(new Set(texts.slice(0, 4)).size).toBe(1);
    expect(texts[0]).toMatch(/try again/iu);
    expect(texts[4]).toMatch(/administrator/iu);
    expect(texts[4]).not.toMatch(/try again/iu);
    // The log line is fixed, names the scope only as a hash and the age and the tries as numbers; the alert line is its own event.
    const stuck = logs.filter((line) => line.event === "lessons.intent_stuck");
    expect(stuck).toHaveLength(6);
    expect(JSON.stringify(stuck)).not.toMatch(/les_|org_|web/u);
    expect(stuck[0]!.fields).toMatchObject({ tries: 1 });
    expect(typeof stuck[0]!.fields["scope"]).toBe("string");
    expect(logs.filter((line) => line.event === "lessons.intent_stuck_alert")).toHaveLength(1);
  });

  it("LP-13 C2: the hourly job can ask whether a project has a rollback that did not finish: no intent is no; a fresh one (still running) is no; an old one, or one already recorded as an alert, is yes; nothing is changed by asking; a table fault throws", async () => {
    const { db } = await withOpenIntent();
    const asAt = (ms: number) => new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" }, () => ms);
    const intentBefore = structuredClone(db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]);
    const openedAt = Number(intentBefore!["at"]);
    expect(await asAt(openedAt + 60_000).hasStuckRollback(KEY)).toBe(false);
    expect(await asAt(openedAt + 15 * 60_000).hasStuckRollback(KEY)).toBe(true);
    // another project has none
    expect(await asAt(openedAt + 60 * 60_000).hasStuckRollback({ workspaceId: ORG_A, project: "api" })).toBe(false);
    // recorded as an alert before it is old
    const row = db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]!;
    db.set({ ...row, stuckAt: openedAt + 1 });
    expect(await asAt(openedAt + 60_000).hasStuckRollback(KEY)).toBe(true);
    expect(db.find((item) => item.sk === "LESSONSET#RBINTENT")[0]).toEqual({ ...intentBefore, stuckAt: openedAt + 1 });
    const broken = new DynamoLessonStore({ documentClient: { send: async () => { throw new Error("table down"); } }, tableName: "TeamRecord" });
    await expect(broken.hasStuckRollback(KEY)).rejects.toThrow("table down");
    // mended: gone
    expect(await commitOne(asAt(openedAt + 120_000))).toMatchObject({ ok: true });
    expect(await asAt(openedAt + 120_000).hasStuckRollback(KEY)).toBe(false);
  });

  it("a fault of the table itself is not turned into a busy refusal", async () => {
    const { db } = await withOpenIntent();
    const broken = new DynamoLessonStore({ documentClient: { send: async (command: unknown) => { if ((command as { constructor: { name: string } }).constructor.name === "GetCommand") throw new Error("table down"); return db.send(command as never); } }, tableName: "TeamRecord" });
    await expect(commitOne(broken)).rejects.toThrow("table down");
  });
});
