// Review item 3 (lessons): the fence also holds an erased person's SOURCE ids, so a commit built from an earlier read cannot put them back into a lesson's audience snapshot.
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, draft, lessonRecord, seed } from "./lesson-helpers.js";

const restricted = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/C1", principals, capturedAt: "2026-10-30T09:00:00.000Z", liveCheck: "none" as const } });
const withAudience = (id: string, principals: string[], over: Partial<Parameters<typeof lessonRecord>[0]> = {}) => lessonRecord({ id, provenance: { ...draft().provenance, authors: ["carl"], audience: restricted(principals) }, ...over });
const principalsOf = (lesson: { provenance: { audience: unknown } }): string[] => ((lesson.provenance.audience as { acl?: { principals?: string[] } }).acl?.principals) ?? [];

describe("the lesson fence holds erased source ids", () => {
  it("after the erase scrubbed the project, a write from a stale read lands without the id", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: clock.now });
    await seed(store, withAudience("les_a0000001", ["U1", "UX"]));
    const stale = (await store.get(KEY, "les_a0000001"))!; // a writer reads now ...
    await port.scrubAudienceIds(WS, PROJECT, ["UX"]); // ... the erase scrubs and fences ...
    const result = await store.commit(KEY, await store.setVersion(KEY), [{ ...stale, version: stale.version + 1, updatedAt: clock.now() }], clock.now()); // ... and the writer commits what it read
    expect(result.ok).toBe(true);
    expect(principalsOf((await store.getHead(KEY, "les_a0000001"))!)).toEqual(["U1"]);
    expect((await store.versions(KEY, "les_a0000001")).map(principalsOf)).toEqual([["U1"], ["U1"]]);
  });
  it("a new lesson written after the fence never carries the id, and a rollback never brings it back", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: clock.now });
    await seed(store, withAudience("les_b0000001", ["U1", "UX"]));
    await seed(store, { ...withAudience("les_b0000001", ["U1", "UX"]), version: 2 });
    await store.fence(KEY, { sourceIds: ["UX"] });
    await seed(store, withAudience("les_c0000001", ["UX", "U2"]));
    expect(principalsOf((await store.getHead(KEY, "les_c0000001"))!)).toEqual(["U2"]);
    await port.scrubAudienceIds(WS, PROJECT, ["UX"]);
    await store.rollback(KEY, 1, await store.setVersion(KEY), clock.now());
    for (const id of ["les_b0000001", "les_c0000001"]) {
      expect(JSON.stringify(await store.getHead(KEY, id))).not.toContain("UX");
      expect(JSON.stringify(await store.versions(KEY, id))).not.toContain("UX");
    }
  });
  it("without the fence the id would stay (control)", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, withAudience("les_d0000001", ["U1", "UX"]));
    expect(principalsOf((await store.getHead(KEY, "les_d0000001"))!)).toEqual(["U1", "UX"]);
  });
});
