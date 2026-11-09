// Lessons in the repo, lane R2: the per-repository state on the Team record table. Every write is conditional on the revision that was read; the item is under the LESSONSET prefix the project and workspace erase wipe.
import { describe, expect, it } from "vitest";
import { dynamoRepoFileStore } from "../../../packages/broker/src/lessons/dynamo-repo-file.js";
import { InMemoryRepoFileStore, newRepoFileState } from "../../../packages/broker/src/lessons/repo-file-state.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { KEY, PLACE, OTHER_PLACE } from "./repo-file-helpers.js";

const stores = (): Array<[string, () => InMemoryRepoFileStore | ReturnType<typeof dynamoRepoFileStore>]> => [
  ["in memory", () => new InMemoryRepoFileStore()],
  ["dynamo", () => dynamoRepoFileStore({ documentClient: new FakeDynamoDb({ indexKeys: {} }) as never, tableName: "t" })],
];

describe.each(stores())("the repo file state store: %s", (_name, make) => {
  it("creates once, then only under the revision that was read; a stale write is refused and changes nothing", async () => {
    const store = make();
    const first = await store.put(KEY, { ...newRepoFileState(PLACE, "api"), enabled: true }, 0);
    expect(first!.revision).toBe(1);
    expect(await store.put(KEY, newRepoFileState(PLACE, "other"), 0)).toBeUndefined();
    const second = await store.put(KEY, { ...first!, unmerged: 2 }, 1);
    expect(second).toMatchObject({ revision: 2, unmerged: 2 });
    expect(await store.put(KEY, { ...first!, unmerged: 9 }, 1)).toBeUndefined();
    expect(await store.get(KEY, PLACE)).toMatchObject({ revision: 2, unmerged: 2, name: "api" });
  });

  it("lists a project's repositories only, in place order, and keeps companies and projects apart", async () => {
    const store = make();
    await store.put(KEY, newRepoFileState(OTHER_PLACE, "web"), 0);
    await store.put(KEY, newRepoFileState(PLACE, "api"), 0);
    await store.put({ ...KEY, project: "proj-2" }, newRepoFileState(PLACE, "api"), 0);
    expect((await store.list(KEY)).map((s) => s.place)).toEqual([PLACE, OTHER_PLACE]);
    expect(await store.get({ ...KEY, project: "proj-3" }, PLACE)).toBeUndefined();
  });

  it("drops fields that are undefined (a cleared problem) instead of failing the write", async () => {
    const store = make();
    const saved = await store.put(KEY, { ...newRepoFileState(PLACE, "api"), problem: "file_too_big" }, 0);
    const cleared = await store.put(KEY, { ...saved!, problem: undefined }, 1);
    expect((await store.get(KEY, PLACE))!.problem).toBeUndefined();
    expect(cleared!.revision).toBe(2);
  });
});
