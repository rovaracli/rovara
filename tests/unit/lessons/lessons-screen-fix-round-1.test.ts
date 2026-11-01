// L3b fix round 1 (Opus review): erasure of an editor (B1), Helpful / Wrong here marks that name nobody after erasure and count once per person per lesson (S1, M1), a stale first approval
// (S2), the version a reject and a rollback were asked for (S3, S4).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approveLesson, rejectLesson, rollbackLessonSet, type ApproveDeps } from "../../../packages/broker/src/lessons/approve.js";
import { recordFeedback } from "../../../packages/broker/src/lessons/counters.js";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { LessonSchema } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, Judge, KEY, MemoryVectors, WS, allowAllAccess, directory, lessonRecord, seed, settings } from "./lesson-helpers.js";

const pending = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({
  id: "les_pend0001", status: "pending", tier: 1, tierReasons: ["not_a_fact"], type: "convention", approvals: [], pendingExpiresAt: 9e15,
  provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over,
});
function setup(eligible = ["owner", "ann", "bob", "dee"]) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const dir = directory({ eligibleIds: eligible });
  let n = 0;
  const deps: ApproveDeps = { access: allowAllAccess, store, directory: dir, settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  const vectors = new MemoryVectors();
  const port = lessonDeletionPort({ store, vectors, audit, now: clock.now });
  return { store, deps, audit, dir, port, clock };
}
const input = (approverId: string, extra: object = {}) => ({ ...KEY, lessonId: "les_pend0001", approverId, ...extra });
const edit = { title: "Use the shared retry helper", description: "", body: "Call withRetry for every HTTP call in api." };

describe("B1: an editor is a writer of the text", () => {
  it("records the editor as an editor, not an author, so a one-tap edit keeps working; the lesson is hard-deleted with all its versions when the editor is erased", async () => {
    const s = setup();
    await seed(s.store, pending());
    expect(await approveLesson(s.deps, input("ann", { edit }))).toMatchObject({ ok: true, status: "active" });
    const live = (await s.store.get(KEY, "les_pend0001"))!;
    expect(live.provenance.editors).toEqual(["ann"]);
    expect(live.provenance.authors).toEqual(["carl"]);
    expect(await s.port.erasePerson(WS, KEY.project, { developerId: "ann" }, new Set())).toEqual({ purged: ["les_pend0001"], scrubbed: [] });
    expect(await s.store.get(KEY, "les_pend0001")).toBeUndefined();
    expect(await s.store.getHead(KEY, "les_pend0001")).toBeUndefined();
    expect(await s.store.versions(KEY, "les_pend0001")).toEqual([]);
  });
  it("erasing someone who only approved (did not edit) still scrubs rather than deletes", async () => {
    const s = setup();
    await seed(s.store, pending());
    await approveLesson(s.deps, input("ann", { edit }));
    expect(await s.port.erasePerson(WS, KEY.project, { developerId: "owner" }, new Set())).toEqual({ purged: [], scrubbed: [] });
    await approveLesson(setup().deps, input("bob")).catch(() => undefined);
    const s2 = setup();
    await seed(s2.store, pending());
    await approveLesson(s2.deps, input("bob"));
    expect((await s2.port.erasePerson(WS, KEY.project, { developerId: "bob" }, new Set())).scrubbed).toEqual(["les_pend0001"]);
    expect((await s2.store.get(KEY, "les_pend0001"))!.approvals[0]!.by).toBe("erased");
  });
  it("a lesson stored before the field existed reads as having no editors", () => {
    const old = JSON.parse(JSON.stringify(lessonRecord())) as Record<string, unknown>;
    expect((old.provenance as Record<string, unknown>).editors).toBeUndefined();
    expect(LessonSchema.parse(old).provenance.editors).toBeUndefined();
  });
  it("a writer cannot be hidden by editing again: every edit adds the editor once", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["escalation_words"] }));
    await approveLesson(s.deps, input("ann", { edit }));
    await approveLesson(s.deps, input("ann", { edit: { ...edit, body: "Call withRetry for every outgoing HTTP call." } }));
    await approveLesson(s.deps, input("bob", { edit: { ...edit, body: "Call withRetry for every outgoing HTTP request." } }));
    expect((await s.store.getHead(KEY, "les_pend0001"))!.provenance.editors).toEqual(["ann", "bob"]);
  });
  it("an edit by the first approver of a tier-2 lesson resets the approvals: they become first again and a second person is still needed", async () => {
    const s = setup();
    await seed(s.store, pending({ tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"] }));
    await approveLesson(s.deps, input("ann"));
    const out = await approveLesson(s.deps, input("ann", { edit: { ...edit, body: "Reviewers check the retry helper is used." } }));
    expect(out).toMatchObject({ ok: true, status: "pending", needs: "second_person" });
    expect((await s.store.get(KEY, "les_pend0001"))!.approvals.map((a) => a.by)).toEqual(["ann"]);
  });
});

