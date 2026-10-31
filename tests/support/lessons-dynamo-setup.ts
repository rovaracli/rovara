// Runs the learning lane's tests against the DynamoDB lesson store (LR-W2): `vitest.lessons-dynamo.config.ts` loads this file, and every `new InMemoryLessonStore()` in those tests
// then builds a `DynamoLessonStore` on a fake table. The suite is the contract: the same tests must pass for both stores.
import { vi } from "vitest";
import type * as LessonStoreModule from "../../packages/broker/src/lessons/store.js";
import { createHash } from "node:crypto";
import { FakeDynamoDb } from "./fake-dynamodb.js";

/** A made-up workspace id in a test becomes a valid, distinct org id; a real one stays itself. */
const orgOfTest = (workspaceId: string): never => (/^org_[0-9a-z]{20}$/u.test(workspaceId) ? workspaceId : `org_${createHash("sha256").update(workspaceId).digest("hex").slice(0, 20)}`) as never;

vi.mock("../../packages/broker/src/lessons/store.js", async (importOriginal) => {
  const original = await importOriginal<typeof LessonStoreModule>();
  const { DynamoLessonStore } = await import("../../packages/broker/src/lessons/dynamo-store.js");
  class DynamoBacked extends DynamoLessonStore {
    private readonly onceLog = new Map<string, Set<string>>();
    constructor() {
      super({ documentClient: new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } }), tableName: "TeamRecord" }, Date.now, orgOfTest);
    }
    override async markOnce(key: { workspaceId: string; project: string }, name: string): Promise<boolean> {
      const fresh = await super.markOnce(key, name);
      if (fresh) { const id = `${key.workspaceId}|${key.project}`; (this.onceLog.get(id) ?? this.onceLog.set(id, new Set()).get(id)!).add(name); }
      return fresh;
    }
    /** For tests: the idempotency keys written so far (the in-memory store has the same method). */
    onceNames(key: { workspaceId: string; project: string }): string[] { return [...(this.onceLog.get(`${key.workspaceId}|${key.project}`) ?? [])]; }
  }
  return { ...original, InMemoryLessonStore: DynamoBacked };
});
