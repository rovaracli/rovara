// Lessons in the repo, lane R1b (review H1): a repo-only lesson and the task's own lesson about the same advice stay apart (a merge would cost the repo-only one its mark), linked both ways. At load, when both would
// reach the same task, only one does: the repo-only one is preferred, never both.
import { describe, expect, it } from "vitest";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { LessonSchema } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, MemoryVectors, PROJECT, WS, allowAllAccess, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const A = "github:repo/1001";

function setup() {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const clock = new Clock();
  const deps: LoadDeps = { access: allowAllAccess, store, embedder, vectors, settings: settings(), audit: new Audit(), now: clock.now };
  const add = async (...input: Lesson[]) => {
    const lessons = input.map((l) => ({ ...l, approvals: [...l.approvals, { approvalId: "ap-ann", by: "ann", at: 1, mode: "one" as const }] }));
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  return { deps, add };
}
const request = (): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "shared" },
});
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, ...over });
const repoOnlyProvenance = { ...lessonRecord().provenance, repoOnly: { place: A } };
const ids = async (deps: LoadDeps) => ((await loadLessonsForStage(deps, request())).context?.lessons ?? []).map((l) => l.id).sort();

describe("load: twin lessons never both reach a task", () => {
  it("control: two unlinked lessons about the same advice both load", async () => {
    const { deps, add } = setup();
    await add(conv("les_task0001", { counters: { loaded: 10, helpful: 9, harmful: 0, citationStale: 0 } }), conv("les_repo0001", { provenance: repoOnlyProvenance }));
    expect(await ids(deps)).toEqual(["les_repo0001", "les_task0001"]);
  });

  it("linked both ways (the repo-only draft names the task's lesson, which names it back): the repo-only one loads, though the other ranks higher", async () => {
    const { deps, add } = setup();
    await add(conv("les_task0001", { repoTwins: ["les_repo0001"], counters: { loaded: 10, helpful: 9, harmful: 0, citationStale: 0 } }), conv("les_repo0001", { provenance: repoOnlyProvenance, possibleDuplicateOf: "les_task0001" }));
    expect(await ids(deps)).toEqual(["les_repo0001"]);
  });

  it("either direction of the link is enough, and a pair neither of which is repo-only loads its higher-ranked lesson only", async () => {
    const one = setup();
    await one.add(conv("les_task0001", { counters: { loaded: 10, helpful: 9, harmful: 0, citationStale: 0 } }), conv("les_repo0001", { provenance: repoOnlyProvenance, possibleDuplicateOf: "les_task0001" }));
    expect(await ids(one.deps)).toEqual(["les_repo0001"]);
    const two = setup();
    await two.add(conv("les_aaaa0001", { repoTwins: ["les_bbbb0001"], counters: { loaded: 10, helpful: 9, harmful: 0, citationStale: 0 } }), conv("les_bbbb0001"));
    expect(await ids(two.deps)).toEqual(["les_aaaa0001"]);
  });

  it("a twin that is not active or not in the task's scope does not push the other out", async () => {
    const { deps, add } = setup();
    await add(conv("les_task0001", { repoTwins: ["les_repo0001"] }), conv("les_repo0001", { provenance: repoOnlyProvenance, possibleDuplicateOf: "les_task0001", scope: { repos: ["web"] } }));
    expect(await ids(deps)).toEqual(["les_task0001"]);
  });

  it("the new field is part of the lesson schema", () => {
    expect(LessonSchema.safeParse(conv("les_task0001", { repoTwins: ["les_repo0001"] })).success).toBe(true);
  });
});
