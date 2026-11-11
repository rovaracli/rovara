// L7: the metric's reader of the v1.2 corrections and its text-free matcher (lessons/metric-source.ts). Read-only; a signature-less correction is unjudged, not guessed.
import { describe, expect, it } from "vitest";
import { projectLearningKey } from "@rovara-code/contracts";
import { signatureOf } from "../../../packages/broker/src/learning/similarity.js";
import { learningSalt } from "../../../packages/broker/src/learning/standing.js";
import { sameMistakeTwice } from "../../../packages/broker/src/lessons/metric.js";
import { signatureMatcher, v12CorrectionSource } from "../../../packages/broker/src/lessons/metric-source.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { DAY_MS, NOW_MS, iso, makeWorld, seedItem } from "../../support/learning-world.js";
import { lessonRecord, seed } from "./lesson-helpers.js";

const world = makeWorld();
const { orgId, project } = world.scope;
const key = { workspaceId: orgId, project };
const salt = learningSalt(world.scope);
const sig = (text: string) => [...signatureOf(text, salt)];

let n = 0;
function put(text: string | undefined, over: { at?: number; taskId?: string; standing?: "member" | "outsider"; author?: string; source?: string; repeatOf?: string; signature?: string[] } = {}): string {
  n += 1;
  const at = over.at ?? NOW_MS - 3_000_000 + n * 1000;
  const id = `c${String(n).padStart(5, "0")}`;
  seedItem(world.db, orgId, project, `CORRECTION#${iso(at)}#${id}`, {
    entityType: "LEARNING_CORRECTION", id, stage: "build", source: over.source ?? "send_back", sourceRef: { taskId: over.taskId ?? `t${n}` }, taskId: over.taskId ?? `t${n}`,
    signature: over.signature ?? (text === undefined ? [] : sig(text)), author: over.author ?? "dev1", standing: over.standing ?? "member",
    createdAt: iso(at), projectCreatedAt: world.scope.projectCreatedAt, indexExpiresAt: Math.floor(at / 1000) + 180 * 86400,
    ...(over.repeatOf === undefined ? {} : { repeatOf: over.repeatOf }),
  });
  return id;
}
const range = { since: NOW_MS - 30 * DAY_MS, until: NOW_MS };

describe("v12CorrectionSource", () => {
  it("reads this project's member corrections in the range, oldest first, with the kinds mapped and the signature kept (the text may be gone)", async () => {
    const a = put("use the shared retry helper", { source: "send_back" });
    const b = put("keep the diff small", { source: "pr_comment" });
    put("outsider words", { standing: "outsider" });
    put("erased words", { author: "erased" });
    put("too old", { at: NOW_MS - 60 * DAY_MS });
    const source = v12CorrectionSource(world.deps, world.scope);
    const read = await source.list(key, range, 100);
    expect(read.truncated).toBe(false);
    // The outsider's and the erased person's are read, marked not-a-member (the measure leaves them out); the old one is outside the range.
    expect(read.corrections).toHaveLength(4);
    expect(read.corrections.filter((c) => c.member).map((c) => [c.id, c.kind])).toEqual([[a, "send_back"], [b, "review_comment"]]);
    expect(read.corrections.filter((c) => !c.member)).toHaveLength(2);
    expect(read.corrections[0]!.signature).toEqual(sig("use the shared retry helper"));
    expect(read.corrections.every((c) => c.text === undefined)).toBe(true);
    expect(read.corrections.every((c) => c.at >= range.since && c.at < range.until)).toBe(true);
  });

  it("bounds the read and says so; a key for another organisation or project reads nothing", async () => {
    const source = v12CorrectionSource(world.deps, world.scope);
    const cut = await source.list(key, range, 2);
    expect(cut.corrections).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    expect(await source.list({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", project }, range, 100)).toEqual({ corrections: [], truncated: false });
    expect(await source.list({ workspaceId: orgId, project: "other" }, range, 100)).toEqual({ corrections: [], truncated: false });
  });

  it("another project's corrections in the same table are not read", async () => {
    seedItem(world.db, orgId, "other", `CORRECTION#${iso(NOW_MS - 1000)}#cX`, { entityType: "LEARNING_CORRECTION", id: "cX", stage: "build", source: "send_back", sourceRef: { taskId: "tx" }, taskId: "tx", signature: ["h"], author: "dev1", standing: "member", createdAt: iso(NOW_MS - 1000), projectCreatedAt: world.scope.projectCreatedAt, indexExpiresAt: Math.floor(NOW_MS / 1000) + 1e7 });
    const read = await v12CorrectionSource(world.deps, world.scope).list(key, range, 1000);
    expect(read.corrections.some((c) => c.id === "cX")).toBe(false);
    expect(projectLearningKey(orgId, "other", "x").pk).not.toBe(projectLearningKey(orgId, project, "x").pk);
  });
});

describe("signatureMatcher", () => {
  const matcher = signatureMatcher(world.scope);
  const record = (text: string | undefined, id = "x") => ({ id, taskId: id, at: 1, kind: "send_back" as const, member: true, ...(text === undefined ? {} : { signature: sig(text) }) });

  it("the same advice in other words is the same; opposite advice and unrelated advice are not", async () => {
    expect(await matcher.sameAsCorrection(record("Please use the shared retry helper for http calls"), record("use the shared retry helper for http calls"))).toBe(true);
    expect(await matcher.sameAsCorrection(record("use the shared retry helper for http calls"), record("never use the shared retry helper for http calls"))).toBe(false);
    expect(await matcher.sameAsCorrection(record("use the shared retry helper for http calls"), record("rename the billing flag in the pricing module"))).toBe(false);
  });
  it("a correction is compared with a lesson's words", async () => {
    const lesson = lessonRecord({ title: "Retries use the shared helper", description: "", body: "Use the shared retry helper for http calls in the api." });
    expect(await matcher.sameAsLesson(record("use the shared retry helper for http calls"), lesson)).toBe(true);
    expect(await matcher.sameAsLesson(record("rename the billing flag in the pricing module"), lesson)).toBe(false);
  });
  it("a correction with no signature cannot be compared: it throws (unjudged), it does not guess", async () => {
    await expect(matcher.sameAsCorrection(record("use the shared retry helper"), record(undefined))).rejects.toThrow();
    await expect(matcher.sameAsLesson(record(undefined), lessonRecord())).rejects.toThrow();
  });
  it("a signature made for another project's salt does not match (signatures say nothing across projects)", async () => {
    const foreign = { ...record("use the shared retry helper for http calls"), signature: [...signatureOf("use the shared retry helper for http calls", "another-salt")] };
    expect(await matcher.sameAsCorrection(foreign, record("use the shared retry helper for http calls"))).toBe(false);
  });
});

describe("the measure over the existing v1.2 records", () => {
  it("counts a repeat from the stored corrections and a loaded lesson, end to end, without writing", async () => {
    n = 1000;
    const text = "use the shared retry helper for http calls";
    put(text, { taskId: "T1" });
    put(text, { taskId: "T2" });
    for (let i = 0; i < 8; i += 1) put(`unrelated rule number ${i} about ${["billing", "caching", "logging", "pagination", "uploads", "search", "email", "webhooks"][i]} handlers`, { taskId: `P${i}` });
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_v12e2e01", workspaceId: orgId, project, type: "convention", title: "Retries use the shared helper", description: "", body: "Use the shared retry helper for http calls in the api.", createdAt: NOW_MS - 20 * DAY_MS, updatedAt: NOW_MS - 20 * DAY_MS, expiresAt: NOW_MS + 60 * DAY_MS }));
    const before = world.db.find(() => true).length;
    const result = await sameMistakeTwice({ corrections: v12CorrectionSource(world.deps, world.scope), matcher: signatureMatcher(world.scope), store }, key, { sinceMs: range.since, untilMs: range.until });
    expect(world.db.find(() => true).length).toBe(before);
    expect(result.repeats).toBeGreaterThanOrEqual(1);
    expect(result.split.lessonNotLoaded).toBeGreaterThanOrEqual(1);
    expect(result.split.lessonLoaded + result.split.lessonNotLoaded + result.split.noLesson).toBe(result.repeats);
    expect(result.unjudged).toBe(0);
  });
});
