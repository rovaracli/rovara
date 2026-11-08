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

  it("a fault of the table itself is not turned into a busy refusal", async () => {
    const { db } = await withOpenIntent();
    const broken = new DynamoLessonStore({ documentClient: { send: async (command: unknown) => { if ((command as { constructor: { name: string } }).constructor.name === "GetCommand") throw new Error("table down"); return db.send(command as never); } }, tableName: "TeamRecord" });
    await expect(commitOne(broken)).rejects.toThrow("table down");
  });
});
