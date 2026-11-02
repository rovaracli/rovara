// Lane cr-settings: the track record of a second-review model on a company. Built from the table's stream: a row per answered second opinion (fingerprints only), outcomes moved from `open` by the next round,
// the owner's accepted risks and the merge; read back as counts for the settings page and the verdict's shadow window.
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { SecondOpinionSchema, secondReviewModelKey, summarizeSecondReviewTrack, workflowFindingFingerprint, type SecondOpinion } from "../../packages/contracts/src/index.js";
import { applyTrackChange, indexSecondReviewTrack, readTrackRecord, readTrackRows, trackChangeOf, trackRowKey, trackStoreOf, type TrackStore } from "../../packages/broker/src/rovara-code/second-review-track.js";
import { indexTogether } from "../../packages/broker/src/aws/outbox-publisher.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { OMAR, MAYA } from "../support/developer-task-broker.js";
import { setupWizardBench } from "../support/setup-wizard-testenv.js";
import { seedTrackRow, sha } from "../support/second-review-evidence.js";
import { TEST_ORG } from "../support/orgs.js";

const MODEL = { provider: "openrouter", modelId: "openai/gpt-5.5" };
const KEY = secondReviewModelKey(MODEL);
const DIGEST = (n: number) => sha(`candidate-${String(n)}`);
const finding = (text: string) => ({ text, origin: "INTRODUCED" as const, severity: "HIGH" as const });
const fp = (text: string) => workflowFindingFingerprint("CRITIC", { text });
const opinion = (texts: string[], over: Partial<SecondOpinion> = {}): SecondOpinion => SecondOpinionSchema.parse({
  mode: "shadow", company: "openai", choice: "company", blockingCount: texts.length, blocked: false, wouldHaveBlocked: texts.length > 0, unavailable: false,
  report: { operationId: "00000000-0000-4000-8000-000000000001", candidateDigest: DIGEST(1), role: "CRITIC", provider: MODEL.provider, version: MODEL.modelId, status: texts.length === 0 ? "PASS" : "FINDINGS", findings: texts.map(finding), readOnly: true, recordedAt: "2026-10-05T00:00:00.000Z" },
  ...over,
});
const stored = (round: number, texts: string[], at: string) => ({ candidateDigest: DIGEST(round), recordedAt: at, opinion: { ...opinion(texts), report: { ...opinion(texts).report!, candidateDigest: DIGEST(round) } } });
const task = (over: Record<string, unknown> = {}) => ({ entityType: "DEVELOPER_TASK", taskId: "task-1", project: "web", orgId: TEST_ORG, workflow: { stage: "REVIEW", reviews: [], acceptedFindings: [] }, ...over });
const firstReview = (round: number, status: "PASS" | "FINDINGS") => ({ role: "CRITIC", candidateDigest: DIGEST(round), status, findings: status === "PASS" ? [] : [finding("first found this")], provider: "p", version: "v", operationId: "00000000-0000-4000-8000-000000000002", readOnly: true, recordedAt: "2026-10-05T00:00:00.000Z" });

describe("what a task update means for the track record", () => {
  it("a new answered opinion creates one row: the model, the mode, the blocking findings as fingerprints only, and whether the first review had cleared the code", () => {
    const next = task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "REVIEW", reviews: [firstReview(1, "PASS")], acceptedFindings: [] } });
    const change = trackChangeOf(undefined, next);
    expect(change.moves).toEqual([]);
    expect(change.create).toMatchObject({ model: KEY, mode: "shadow", taskId: "task-1", project: "web", candidateDigest: DIGEST(1), firstCleared: true, rev: 0 });
    expect(change.create!.findings).toEqual([{ fp: fp("a"), outcome: "open" }, { fp: fp("b"), outcome: "open" }]);
    expect(JSON.stringify(change)).not.toContain("first found this");
    // The first review had findings of its own: the second did not catch what it missed.
    expect(trackChangeOf(undefined, task({ secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "REVIEW", reviews: [firstReview(1, "FINDINGS")], acceptedFindings: [] } })).create!.firstCleared).toBe(false);
  });

  it("an opinion that gave no answer, a record with no opinion, and an update that does not change the opinion write nothing", () => {
    const unavailable = SecondOpinionSchema.parse({ mode: "on", unavailableReason: "no-answer", blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true });
    expect(trackChangeOf(undefined, task({ secondOpinion: { candidateDigest: DIGEST(1), recordedAt: "2026-10-05T00:00:00.000Z", opinion: unavailable } }))).toEqual({ moves: [] });
    expect(trackChangeOf(undefined, task())).toEqual({ moves: [] });
    const same = task({ secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z") });
    expect(trackChangeOf(same, { ...same, updatedAt: "later" })).toEqual({ moves: [] });
    expect(trackChangeOf(undefined, { entityType: "OPERATION", secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z") })).toEqual({ moves: [] });
  });

  it("the next round fixes the findings it no longer raises, and leaves the ones it still raises open", () => {
    const before = task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z") });
    const after = task({ secondOpinion: stored(2, ["b", "c"], "2026-10-06T00:00:00.000Z") });
    const change = trackChangeOf(before, after);
    expect(change.create).toMatchObject({ candidateDigest: DIGEST(2) });
    expect(change.moves).toHaveLength(1);
    expect(change.moves[0]).toMatchObject({ to: "fixed", ref: { candidateDigest: DIGEST(1) } });
    expect([...change.moves[0]!.except!].sort()).toEqual([fp("b"), fp("c")].sort());
  });

  it("a finding the owner accepted as a risk for the code the task holds is wrong; only that one", () => {
    const before = task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z") });
    const after = task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "REVIEW", reviews: [], acceptedFindings: [{ candidateDigest: DIGEST(1), role: "CRITIC", fingerprint: fp("a") }, { candidateDigest: DIGEST(9), role: "CRITIC", fingerprint: fp("b") }, { candidateDigest: DIGEST(1), role: "SECURITY", fingerprint: fp("b") }] } });
    const change = trackChangeOf(before, after);
    expect(change.moves).toEqual([{ ref: expect.objectContaining({ candidateDigest: DIGEST(1) }) as unknown, to: "wrong", only: new Set([fp("a")]) }]);
  });

  it("a merge with findings standing marks them wrong, once", () => {
    const before = task({ secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z") });
    const merged = task({ secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "MERGED", reviews: [], acceptedFindings: [] } });
    expect(trackChangeOf(before, merged).moves).toEqual([{ ref: expect.objectContaining({ candidateDigest: DIGEST(1) }) as unknown, to: "wrong" }]);
    expect(trackChangeOf(merged, { ...merged, updatedAt: "later" }).moves).toEqual([]);
  });
});

describe("applying it", () => {
  async function store() { const db = new FakeDynamoDb(); return { db, store: trackStoreOf({ documentClient: db, tableName: "state" }) }; }

  it("a row is created once (a replayed record writes nothing twice) and outcomes move only from open", async () => {
    const { db, store: s } = await store();
    const first = trackChangeOf(undefined, task({ secondOpinion: stored(1, ["a", "b", "c"], "2026-10-05T00:00:00.000Z") }));
    await applyTrackChange(s, TEST_ORG, first);
    await applyTrackChange(s, TEST_ORG, first);
    expect(await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY)).toHaveLength(1);
    // Round two fixes "a" only; a later merge must not turn the fixed one into a wrong one.
    await applyTrackChange(s, TEST_ORG, trackChangeOf(task({ secondOpinion: stored(1, ["a", "b", "c"], "2026-10-05T00:00:00.000Z") }), task({ secondOpinion: stored(2, ["b", "c"], "2026-10-06T00:00:00.000Z") })));
    // The first record delivered again (a stream replays) must not put the fixed finding back to open.
    await applyTrackChange(s, TEST_ORG, first);
    expect((await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY)).find((entry) => entry.candidateDigest === DIGEST(1))!.findings[0]!.outcome).toBe("fixed");
    await applyTrackChange(s, TEST_ORG, trackChangeOf(task({ secondOpinion: stored(1, ["a", "b", "c"], "2026-10-05T00:00:00.000Z") }), task({ secondOpinion: stored(1, ["a", "b", "c"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "MERGED" } })));
    const row = (await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY)).find((entry) => entry.candidateDigest === DIGEST(1))!;
    expect(row.findings.map((entry) => [entry.fp, entry.outcome])).toEqual([[fp("a"), "fixed"], [fp("b"), "wrong"], [fp("c"), "wrong"]].map(([f, o]) => [f, o]));
  });

  it("an accepted risk marks only that finding wrong when applied, and a finding of an opinion that gave no answer is never tracked", async () => {
    const { db, store: s } = await store();
    await applyTrackChange(s, TEST_ORG, trackChangeOf(undefined, task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z") })));
    const accepted = task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z"), workflow: { stage: "REVIEW", reviews: [], acceptedFindings: [{ candidateDigest: DIGEST(1), role: "CRITIC", fingerprint: fp("a") }] } });
    await applyTrackChange(s, TEST_ORG, trackChangeOf(task({ secondOpinion: stored(1, ["a", "b"], "2026-10-05T00:00:00.000Z") }), accepted));
    expect((await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY))[0]!.findings.map((entry) => entry.outcome)).toEqual(["wrong", "open"]);
    const unavailable = SecondOpinionSchema.parse({ mode: "on", unavailableReason: "no-answer", blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true });
    expect(trackChangeOf(undefined, task({ secondOpinion: { candidateDigest: DIGEST(3), recordedAt: "2026-10-07T00:00:00.000Z", opinion: { ...unavailable, report: stored(3, ["q"], "2026-10-07T00:00:00.000Z").opinion.report } } })).create).toBeUndefined();
  });

  it("a move that finds the row changed under it reads it again and tries once more", async () => {
    const { db, store: real } = await store();
    await applyTrackChange(real, TEST_ORG, trackChangeOf(undefined, task({ secondOpinion: stored(1, ["a"], "2026-10-05T00:00:00.000Z") })));
    let refused = 0;
    const racing: TrackStore = { ...real, async move(key, findings, rev) { if (refused === 0) { refused += 1; return false; } return real.move(key, findings, rev); } };
    const result = await applyTrackChange(racing, TEST_ORG, { moves: [{ ref: { model: KEY, recordedAt: "2026-10-05T00:00:00.000Z", taskId: "task-1", candidateDigest: DIGEST(1) }, to: "wrong" }] });
    expect(result.moved).toBe(1);
    expect((await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY))[0]!.findings[0]!.outcome).toBe("wrong");
  });
});

describe("the stream indexer", () => {
  const record = (previous: Record<string, unknown> | undefined, next: Record<string, unknown>) => ({ eventName: previous === undefined ? "INSERT" : "MODIFY", dynamodb: { NewImage: marshall(next, { removeUndefinedValues: true }), ...(previous === undefined ? {} : { OldImage: marshall(previous, { removeUndefinedValues: true }) }) } });

  it("writes rows from task records only, counts them, and a failing write is logged by name and does not stop the batch", async () => {
    const db = new FakeDynamoDb();
    const logs: Array<Record<string, unknown>> = [];
    const real = trackStoreOf({ documentClient: db, tableName: "state" });
    let calls = 0;
    const flaky: TrackStore = { ...real, async create(item) { calls += 1; if (calls === 1) throw new Error("secret detail"); return real.create(item); } };
    const batch = [
      record(undefined, task({ taskId: "t-a", secondOpinion: stored(1, ["x"], "2026-10-05T00:00:00.000Z") })),
      record(undefined, task({ taskId: "t-b", secondOpinion: stored(1, ["y", "z"], "2026-10-06T00:00:00.000Z") })),
      record(undefined, { entityType: "OPERATION", id: "op" }),
    ];
    const result = await indexSecondReviewTrack(batch, flaky, (entry) => logs.push(entry), TEST_ORG);
    expect(result).toEqual({ created: 1, moved: 0, failed: 1 });
    expect(JSON.stringify(logs)).toContain("second_review_track.write_failed");
    expect(JSON.stringify(logs)).not.toContain("secret detail");
    expect(await readTrackRows({ documentClient: db, tableName: "state" }, TEST_ORG, KEY)).toHaveLength(1);
  });

  it("is one of the stream indexes and the others do not wait on it or hide its failure", async () => {
    const order: string[] = [];
    const logs = [] as string[];
    const spy = (message: unknown) => { logs.push(String(message)); };
    const original = console.log;
    console.log = spy;
    try {
      await indexTogether({
        activity: async () => { order.push("activity"); }, sessions: async () => { order.push("sessions"); },
        track: async () => { order.push("track"); throw new Error("down"); },
      })([]);
    } finally { console.log = original; }
    expect(order.sort()).toEqual(["activity", "sessions", "track"]);
    expect(logs.join("")).toContain("second_review_track.failed");
    // Without a track index nothing changes for the others.
    await indexTogether({ activity: async () => undefined, sessions: async () => undefined })([]);
  });
});

describe("the track record", () => {
  it("counts days, reviews, findings, agreed, wrong, open and what the first review missed; only the model asked for; a window narrows it", () => {
    const db = new FakeDynamoDb();
    const other = { provider: "openrouter", modelId: "x/other" };
    seedTrackRow(db, MODEL, { at: "2026-10-02T12:00:00.000Z", task: "t1", fixed: 3, open: 1, firstCleared: true });
    seedTrackRow(db, MODEL, { at: "2026-10-09T12:00:00.000Z", task: "t2", fixed: 2, wrong: 4, firstCleared: false });
    seedTrackRow(db, MODEL, { at: "2026-10-12T12:00:00.000Z", task: "t3" });
    seedTrackRow(db, other, { at: "2026-10-03T12:00:00.000Z", task: "t4", fixed: 9 });
    const rows = [...db.find((item) => item.entityType === "SECOND_REVIEW_TRACK")] as never[];
    expect(summarizeSecondReviewTrack(KEY, rows)).toEqual({ model: KEY, days: 10, firstAt: "2026-10-02T12:00:00.000Z", lastAt: "2026-10-12T12:00:00.000Z", reviews: 3, findings: 10, agreed: 5, wrong: 4, open: 1, caughtMissedByFirst: 3 });
    expect(summarizeSecondReviewTrack(KEY, rows, { from: "2026-10-05T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" })).toMatchObject({ reviews: 2, findings: 6, agreed: 2, caughtMissedByFirst: 0 });
    expect(summarizeSecondReviewTrack(KEY, [])).toEqual({ model: KEY, days: 0, reviews: 0, findings: 0, agreed: 0, wrong: 0, open: 0, caughtMissedByFirst: 0 });
  });

  it("is read per company: another company's rows are never counted", async () => {
    const db = new FakeDynamoDb();
    seedTrackRow(db, MODEL, { at: "2026-10-02T12:00:00.000Z", task: "t1", fixed: 1 });
    seedTrackRow(db, MODEL, { at: "2026-10-03T12:00:00.000Z", task: "t2", fixed: 5 }, "org_bbbbbbbbbbbbbbbbbbbb");
    expect(await readTrackRecord({ documentClient: db, tableName: "state" }, TEST_ORG, KEY)).toMatchObject({ reviews: 1, agreed: 1 });
    expect(trackRowKey(TEST_ORG, { model: KEY, recordedAt: "2026-10-02T12:00:00.000Z", taskId: "t1", candidateDigest: DIGEST(1) }).sk).toContain(KEY);
  });
});

describe("on the settings page", () => {
  it("any member sees the chosen model's track record, and it is the record of that model on this company", async () => {
    process.env.SECOND_REVIEW_ENABLED = "1";
    try {
      const t = await setupWizardBench({ audit: capturingAuditDeps() });
      await t.person(MAYA, "member");
      const models = ((await t.web(OMAR, "GET", "/v1/app/org/second-review?builder=openai:gpt-5.5")).body as { models: Array<{ model: { provider: string; modelId: string } }> }).models.map((entry) => entry.model);
      await t.web(OMAR, "POST", "/v1/app/org/second-review", { action: "choose", primary: models[0] });
      seedTrackRow(t.db, models[0]!, { at: "2026-10-02T12:00:00.000Z", task: "t1", fixed: 2, wrong: 1, firstCleared: true });
      seedTrackRow(t.db, models[1]!, { at: "2026-10-03T12:00:00.000Z", task: "t2", fixed: 7 });
      const seen = (await t.web(MAYA, "GET", "/v1/app/org/second-review?builder=openai:gpt-5.5")).body as { trackRecord: Record<string, unknown> };
      expect(seen.trackRecord).toMatchObject({ model: secondReviewModelKey(models[0]!), reviews: 1, findings: 3, agreed: 2, wrong: 1, open: 0, caughtMissedByFirst: 2 });
    } finally { delete process.env.SECOND_REVIEW_ENABLED; }
  });
});
