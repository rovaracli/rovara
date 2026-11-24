// L4-CLS: Cloud reads Code's lesson rows and views with forward readers: a field, a kind or a value a newer Code adds is never a parse failure that blanks a screen,
// while everything Cloud draws stays checked. The fixtures are the rows Code sends today (app-lessons views with trial, usedInTasks, a duplicate, a pause, the
// preset) and what its stored provenance carries (`sourceKinds` with plan_comment and design_comment, `other` for a kind a newer build wrote, a made-up future kind).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LessonApproveBodySchema, LessonFeedbackBodySchema, LessonSourcesReaderSchema, LessonsDigestReaderSchema, LessonsViewReaderSchema, LessonHistoryReaderSchema,
  LoadedLessonsReaderSchema, ModelSelectionPolicyResponseReaderSchema, SourceWriteBodySchema, SourcesAdminViewReaderSchema, forwardReader,
} from "@agentx/contracts/web";
import { readsAsUnknown } from "../../packages/contracts/src/forward-reader-unknown.js";
import { z } from "zod";

type Raw = Record<string, unknown>;
const SOURCE_KINDS = ["send_back", "plan_comment", "design_comment", "other", "made_up_future_kind"];
const lesson = (over: Raw = {}): Raw => ({
  id: "les_aaaa1111", version: 1, type: "convention", stages: ["IMPLEMENT"], title: "Use the shared retry helper", description: "", body: "Call withRetry.", scope: { repos: ["api"], paths: [], languages: [] },
  tier: 1, tierReasons: ["not_a_fact"], status: "active", counters: { loaded: 4, helpful: 3, harmful: 1 }, createdAt: 1, updatedAt: 2, expiresAt: 3,
  citations: [], from: [{ name: "Ann" }], measured: true, supportTasks: 2, approvals: [], canApprove: false, canReject: false, canRetire: true, ...over,
});
const view = (over: Raw = {}): Raw => ({
  project: "payments", mode: "Suggest", lockedByCompany: false, approval: { tier0: "one", tier1: "one", requiredGroups: [] }, canDecide: true,
  waiting: [], active: [lesson()], removed: [], queued: 0, hidden: 0, truncated: [], setVersion: 4, snapshots: [], ...over,
});
const source = (over: Raw = {}): Raw => ({ kind: "github", scope: "github:acme/payments", enabled: true, retention: "D", health: "ok", audience: "project", updatedAt: "2026-10-30T10:00:00.000Z", paused: false, ...over });
const loadedRow = (over: Raw = {}): Raw => ({ stage: "IMPLEMENT", round: 1, lessonId: "les_aaaa1111", version: 1, why: "scope", citation: "valid", visible: true, title: "T", type: "convention", helpful: 3, harmful: 1, canMark: true, ...over });
const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe("a lesson view as Code sends it today", () => {
  it("reads the fields Code added after Cloud's copy (trial, usedInTasks, a possible duplicate, the pause, the preset, the switch) and keeps them", () => {
    const code = view({
      paused: { code: "monthly_limit", at: 1, scope: "company" }, preset: "standard", presetLockedByCompany: false, lessonsSwitchedOff: true, legacyHeld: 2,
      active: [lesson({ trial: "trial", usedInTasks: 3, usedInTasksMore: true, possibleDuplicate: "les_bbbb2222", mergeBlocked: true, approvals: [{ by: { name: "Ann" }, at: 1, mode: "trial" }], tierReasons: ["capability_request", "matches_rejected"] })],
    });
    const read = LessonsViewReaderSchema.parse(code);
    expect(read["paused"]).toEqual({ code: "monthly_limit", at: 1, scope: "company" });
    expect(read.active[0]!["trial"]).toBe("trial");
    expect(read.active[0]!["usedInTasks"]).toBe(3);
    // Forward readers preserve unknown Code fields; the Cloud route/UI projection drops this retired field.
    expect(read.active[0]!["mergeBlocked"]).toBe(true);
    expect(read.active[0]!.approvals[0]!.mode).toBe("unknown");
  });
  it("keeps sourceKinds (plan_comment, design_comment, other and a made-up kind) as the plain strings Code sent, on the lesson and in its provenance", () => {
    const read = LessonsViewReaderSchema.parse(view({ active: [lesson({ sourceKinds: SOURCE_KINDS, provenance: { sourceKinds: SOURCE_KINDS, sourceEvents: ["task:1:plancomment:r1"], authors: ["d1"] } })] }));
    expect(read.active[0]!["sourceKinds"]).toEqual(SOURCE_KINDS);
    expect((read.active[0]!["provenance"] as Raw)["sourceKinds"]).toEqual(SOURCE_KINDS);
  });
  it("reads a status, type, stage, approval mode, citation check, learning mode, truncated list and citation kind it does not know as unknown, and keeps the row", () => {
    const read = LessonsViewReaderSchema.parse(view({
      mode: "Autopilot", truncated: ["paused"],
      active: [lesson({ status: "paused", type: "recipe", stages: ["VERIFY", "IMPLEMENT"], citations: [{ kind: "wiki", page: "p1" }, { kind: "code", repo: "r", path: "p", startLine: 1, endLine: 2, check: "rotten" }] })],
    }));
    expect(read.mode).toBe("unknown");
    expect(read.truncated).toEqual(["unknown"]);
    const row = read.active[0]!;
    expect([row.status, row.type, row.stages]).toEqual(["unknown", "unknown", ["unknown", "IMPLEMENT"]]);
    expect(row.citations.map(one => one.kind)).toEqual(["unknown", "code"]);
    expect((row.citations[1] as Raw)["check"]).toBe("unknown");
  });
  it("reads a tier or a count of people a newer Code added (a union of numbers) as unknown instead of failing the whole view", () => {
    const read = LessonsViewReaderSchema.parse(view({ waiting: [lesson({ tier: 3, needs: { required: 3, have: 1, groups: [] } })] }));
    expect(read.waiting[0]!.tier).toBe("unknown");
    expect(read.waiting[0]!.needs!.required).toBe("unknown");
    expect(LessonsViewReaderSchema.parse(view({ waiting: [lesson({ tier: 2, needs: { required: 2, have: 1, groups: [] } })] })).waiting[0]!.tier).toBe(2);
  });
  it("still checks what Cloud draws: a missing field, a wrong kind of value, a bad bound or a number where a word belongs is refused", () => {
    expect(ok(LessonsViewReaderSchema, view())).toBe(true);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ title: undefined })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ title: "x".repeat(81) })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ version: "1" })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ tier: "high" })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ needs: { required: undefined, have: 0, groups: [] } })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ status: 7 })] }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ canDecide: "yes" }))).toBe(false);
    expect(ok(LessonsViewReaderSchema, view({ active: [lesson({ counters: { loaded: -1, helpful: 0, harmful: 0 } })] }))).toBe(false);
  });
  it("reads the digest and a lesson's history with extra fields and a status it does not know", () => {
    expect(ok(LessonsDigestReaderSchema, { since: 1, top: [], needsReview: [], autoApplied: [], waiting: [], retired: [], staleOrRetireProposed: [], queued: 0, pausedSources: [], pausedSourcesHidden: 0, hidden: 0, newer: [1] })).toBe(true);
    const history = LessonHistoryReaderSchema.parse({ versions: [{ version: 1, at: 1, status: "paused", title: "t", body: "b", approvedBy: [], sourceKinds: SOURCE_KINDS }] });
    expect(history.versions[0]!.status).toBe("unknown");
  });
});

describe("the Sources read and the lessons the agent loaded", () => {
  it("reads a source of a kind, health, audience and retention it does not know, with fields it does not have", () => {
    const read = LessonSourcesReaderSchema.parse({ sources: [source({ kind: "plan_comment", health: "degraded", audience: "team", retention: "E", sourceKinds: SOURCE_KINDS }), source()], otherPaused: 0, more: 1 });
    expect(read.sources.map(row => row.kind)).toEqual(["plan_comment", "github"]);
    expect(read.sources[0]!.health).toBe("unknown");
    expect(read.sources[0]!.audience).toBe("unknown");
  });
  it("still checks a source row: no kind, no flag or a kind that is not text is refused", () => {
    expect(ok(LessonSourcesReaderSchema, { sources: [source({ kind: undefined })], otherPaused: 0 })).toBe(false);
    expect(ok(LessonSourcesReaderSchema, { sources: [source({ enabled: "yes" })], otherPaused: 0 })).toBe(false);
    expect(ok(LessonSourcesReaderSchema, { sources: [source({ kind: 7 })], otherPaused: 0 })).toBe(false);
    expect(ok(LessonSourcesReaderSchema, { sources: [], otherPaused: -1 })).toBe(false);
  });
  it("reads loaded-lesson rows with a reason, citation state and type it does not know, the trial flag and a made-up source kind", () => {
    const read = LoadedLessonsReaderSchema.parse({ lessons: [loadedRow({ why: "future", citation: "future", type: "recipe", trial: "trial", stage: "PLAN_REVIEW", sourceKinds: SOURCE_KINDS })], canThumbsDown: true });
    const row = read.lessons[0]!;
    expect([row.why, row.citation, row.type, row.stage]).toEqual(["unknown", "unknown", "unknown", "PLAN_REVIEW"]);
    expect(row["sourceKinds"]).toEqual(SOURCE_KINDS);
    expect(read["canThumbsDown"]).toBe(true);
  });
  it("still checks a loaded-lesson row: no lesson id, a round that is text or no visible flag is refused", () => {
    expect(ok(LoadedLessonsReaderSchema, { lessons: [loadedRow({ lessonId: undefined })] })).toBe(false);
    expect(ok(LoadedLessonsReaderSchema, { lessons: [loadedRow({ round: "1" })] })).toBe(false);
    expect(ok(LoadedLessonsReaderSchema, { lessons: [loadedRow({ visible: undefined })] })).toBe(false);
  });
});

describe("the editors' Sources view", () => {
  const admin = (over: Raw = {}) => ({ sources: [{ ...source({ retention: "C" }), revision: 1, addedBy: "d1", exclude: [] }], otherPaused: 0, canEdit: true, offered: { github: ["A", "B", "C", "D"] }, ...over });
  it("reads a retention mode a newer Code offers (inside a list in a record) as unknown, and keeps the modes it knows", () => {
    const read = SourcesAdminViewReaderSchema.parse(admin({ offered: { github: ["A", "E", "D"], zendesk: ["A"] } }));
    expect(read.offered["github"]).toEqual(["A", "unknown", "D"]);
    expect(read.offered["zendesk"]).toEqual(["A"]);
  });
  it("reads a row of a kind Cloud has not heard of and a removed source of one", () => {
    const read = SourcesAdminViewReaderSchema.parse(admin({
      sources: [{ ...source({ kind: "zendesk", scope: "zendesk:1" }), revision: 1, addedBy: "d1", exclude: [] }],
      clearing: [{ source: "zendesk", scope: "zendesk:1", since: "2026-10-30T10:00:00.000Z" }], newer: true,
    }));
    expect(read.sources[0]!.kind).toBe("zendesk");
    expect(read.clearing![0]!.source).toBe("unknown");
  });
  it("still checks the editors' fields: a revision that is not a number, a missing exclusion list or a record value that is not a list is refused", () => {
    expect(ok(SourcesAdminViewReaderSchema, admin({ sources: [{ ...source(), revision: "1", addedBy: "d1", exclude: [] }] }))).toBe(false);
    expect(ok(SourcesAdminViewReaderSchema, admin({ sources: [{ ...source(), revision: 1, addedBy: "d1" }] }))).toBe(false);
    expect(ok(SourcesAdminViewReaderSchema, admin({ offered: { github: "A" } }))).toBe(false);
    expect(ok(SourcesAdminViewReaderSchema, admin({ canEdit: undefined }))).toBe(false);
  });
});

describe("what Cloud sends to Code stays strict", () => {
  it("refuses an unknown field or an unknown retention in a source write", () => {
    const base = { action: "add", requestId: "11111111-2222-4333-8444-555555555555", source: "github", scope: "github:repo/9", retention: "D", audienceDefault: "project", enabled: true };
    expect(ok(SourceWriteBodySchema, base)).toBe(true);
    expect(ok(SourceWriteBodySchema, { ...base, extra: 1 })).toBe(false);
    expect(ok(SourceWriteBodySchema, { ...base, retention: "E" })).toBe(false);
    expect(ok(SourceWriteBodySchema, { ...base, source: "zendesk" })).toBe(false);
  });
  it("refuses an unknown field in an approval or a mark", () => {
    expect(ok(LessonApproveBodySchema, { expectedVersion: 1 })).toBe(true);
    expect(ok(LessonApproveBodySchema, { expectedVersion: 1, tier: 0 })).toBe(false);
    expect(ok(LessonFeedbackBodySchema, { kind: "helpful" })).toBe(true);
    expect(ok(LessonFeedbackBodySchema, { kind: "plan_comment" })).toBe(false);
  });
});

describe("the forward reader's rules for literal unions and records", () => {
  const schema = z.object({ tier: z.union([z.literal(0), z.literal(1)]), word: z.union([z.literal("a"), z.literal("b")]), by: z.record(z.string(), z.enum(["x", "y"])), one: z.literal(1) }).strict();
  const reader = forwardReader(schema);
  const base = { tier: 1, word: "a", by: { k: "x" }, one: 1 };
  it("reads a number or a word that no literal names as unknown, and a known one as itself", () => {
    expect(reader.parse({ ...base, tier: 9, word: "zzz" })).toMatchObject({ tier: "unknown", word: "unknown" });
    expect(reader.parse(base)).toMatchObject({ tier: 1, word: "a" });
  });
  it("does not read a value of another kind, or a missing one, as unknown", () => {
    expect(reader.safeParse({ ...base, tier: "1" }).success).toBe(false);
    expect(reader.safeParse({ ...base, word: 3 }).success).toBe(false);
    expect(reader.safeParse({ ...base, tier: undefined }).success).toBe(false);
  });
  it("leaves a single literal strict", () => {
    expect(reader.safeParse({ ...base, one: 2 }).success).toBe(false);
  });
  it("reads the enum values of a record as open and keeps its keys", () => {
    expect(reader.parse({ ...base, by: { k: "x", j: "future" } }).by).toEqual({ k: "x", j: "unknown" });
    expect(reader.safeParse({ ...base, by: { k: 5 } }).success).toBe(false);
  });
  it("tells readsAsUnknown about the marker a literal union gives, and not about a real value", () => {
    const union = z.union([z.literal(0), z.literal(1)]);
    expect(readsAsUnknown(union, "unknown")).toBe(true);
    expect(readsAsUnknown(union, 1)).toBe(false);
    expect(readsAsUnknown(z.object({ tier: union }), { tier: "unknown" })).toBe(true);
  });
  it("keeps unknown fields on the object", () => {
    expect(reader.parse({ ...base, more: 1 })).toMatchObject({ more: 1 });
  });
  it("leaves a partial record, an enum-keyed record and a record with its own refinement as the schema has them", () => {
    const strict = z.object({
      partial: z.partialRecord(z.enum(["a", "b"]), z.object({ x: z.number() })),
      checked: z.record(z.string(), z.number()).superRefine((value, context) => { if (Object.keys(value).length > 1) context.addIssue({ code: "custom", message: "one" }); }),
    });
    const read = forwardReader(strict);
    expect(read.safeParse({ partial: {}, checked: {} }).success).toBe(true);
    expect(read.safeParse({ partial: { a: { x: 1 } }, checked: { k: 1 } }).success).toBe(true);
    expect(read.safeParse({ partial: { c: { x: 1 } }, checked: {} }).success).toBe(false);
    expect(read.safeParse({ partial: {}, checked: { k: 1, j: 2 } }).success).toBe(false);
  });
  it("still reads a policy-shaped answer with empty maps (company model policy)", () => {
    expect(ModelSelectionPolicyResponseReaderSchema.safeParse({ version: 1, revision: 1, rankingVersion: "g3-v1", stepOverrides: {}, candidates: {}, reviewDefaults: {} }).success).toBe(true);
  });
});

describe("no Cloud read path parses a lesson row with the strict stored-lesson contract", () => {
  const roots = ["packages/ui/src", "packages/cloud-server/src"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/u.test(name) ? [path] : []; });
  it("never imports LessonSchema or LessonProvenanceSchema in the web app or the Cloud server: rows from Code go through a forward reader or a field-by-field rebuild", () => {
    const hits = roots.flatMap(walk).filter(file => /\b(LessonSchema|LessonProvenanceSchema|LessonCandidateSchema)\b/u.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
