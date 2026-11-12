// Lane K2 (DECISIONS 145, design option (f)): the keyword index of the Team record. Segments in the team-record table, a live tail, late rows, a manifest that is the lock; search ranks all hot rows by BM25 over the best passage.
import { describe, expect, it } from "vitest";
import { recordSearch, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import { bm25PassageScores, keywordTokens, PASSAGE_TOKENS } from "../../../packages/broker/src/team-record/search-fusion.js";
import { keywordDocumentOf } from "../../../packages/broker/src/team-record/keyword-document.js";
import { encodeSegment, SegmentReader } from "../../../packages/broker/src/team-record/keyword-index-segment.js";
import { LivePart, SegmentPart, rankParts } from "../../../packages/broker/src/team-record/keyword-index-score.js";
import { KEYWORD_LATE_MS, KWLATE_PREFIX } from "../../../packages/broker/src/team-record/keyword-late.js";
import { SEGMENT_DOCS, SegmentCache, maintainProject, openKeywordIndex } from "../../../packages/broker/src/team-record/keyword-index.js";
import { deterministicEventId, putRecordEvent } from "../../../packages/broker/src/team-record/store.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, caller, githubDraft, world, type World } from "../../support/team-record-core.js";
import { DAY, HOUR, buildIndex, depsOf, eventsInTable, indexHoldsWord, manifestOf, rowOf, seedRows, segmentsOf } from "../../support/keyword-index.js";
import type { ReadAudience } from "../../../packages/broker/src/team-record/types.js";

const NOW = (w: World): number => Math.floor(w.clock.ms / 1000);
const person = (extra = {}): ReadAudience => ({ kind: "caller", caller: caller(extra) });
const searchDeps = (w: World, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, log: (event, fields) => { w.logs.push({ event, fields: { ...fields } }); }, ...extra });
const ids = (hits: Array<{ id: string }>): string[] => hits.map((hit) => hit.id);

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];
/** A deterministic pseudo-random text of `count` words from a small vocabulary plus a few rarer words, so idf differs between words. */
function textOf(seed: number, count: number): string {
  let state = seed * 2654435761 % 4294967296;
  const next = (): number => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  return Array.from({ length: count }, () => (next() < 0.1 ? `rare${String(Math.floor(next() * 40))}` : (WORDS[Math.floor(next() * WORDS.length)] as string))).join(" ");
}

describe("segment format and ranking (pure)", () => {
  const docs = (n: number) => Array.from({ length: n }, (_unused, i) => ({
    id: deterministicEventId(ORG_A, "github", "github.com", `p-${String(i)}`, "1"), occurredAtMs: 1_000_000 + i * 1_000, kind: "github.review_comment", source: "github", restricted: i % 7 === 0, hotExpiresAt: 2_000_000_000,
    tokens: keywordTokens(`${textOf(i, 10 + (i % 4) * 90)} {}`),
  }));

  it("round-trips: every row, its time, kind, source, restricted flag and passages come back", () => {
    const input = docs(30);
    const encoded = encodeSegment(input);
    const reader = new SegmentReader(encoded.bytes);
    expect(reader.docs).toBe(30);
    expect(reader.docId(0)).toBe(input[0]!.id);
    expect(reader.kindOf(3)).toBe("github.review_comment");
    expect(reader.sourceOf(3)).toBe("github");
    expect(Array.from(reader.restricted).filter((flag) => flag === 1)).toHaveLength(input.filter((doc) => doc.restricted).length);
    expect(reader.find(1_000_000 + 5_000, input[5]!.id)).toBe(5);
    expect(reader.find(1_000_000 + 5_000, input[6]!.id)).toBeUndefined();
    expect(reader.postings("alpha")).toBeDefined();
    expect(reader.postings("not-a-word-in-any-row")).toBeUndefined();
    // a segment holds words only: none of the original sentence, only its terms
    expect(reader.allTerms().every((term) => term.length >= 2)).toBe(true);
  });

  it("ranks exactly as the passage scorer does over the same rows (long rows included): the same numbers for the same rows", () => {
    const input = docs(120);
    const reader = new SegmentReader(encodeSegment(input).bytes);
    for (const query of ["alpha bravo", "rare3 oscar", "zulu", "delta rare7 whiskey november", "nothing-here"]) {
      const expected = bm25PassageScores(query, input.map((doc) => doc.tokens.join(" ")));
      const ranked = rankParts(query, [new SegmentPart(reader)], 0);
      const byId = new Map(ranked.map((hit) => [reader.docId(hit.doc), hit.score]));
      input.forEach((doc, at) => {
        expect(byId.get(doc.id) ?? 0, `${query} / row ${String(at)}`).toBeCloseTo(expected[at] as number, 10);
      });
    }
    // some rows are longer than one passage: the rule was really exercised
    expect(input.some((doc) => doc.tokens.length > PASSAGE_TOKENS)).toBe(true);
  });

  it("statistics are global: a segment and a live part together score like one corpus", () => {
    const input = docs(80);
    const left = new SegmentReader(encodeSegment(input.slice(0, 50)).bytes);
    const live = input.slice(50).map((doc) => ({ meta: { ms: doc.occurredAtMs, kind: doc.kind, source: doc.source, restricted: false, isFact: false }, tokens: doc.tokens }));
    const expected = bm25PassageScores("bravo rare12 papa", input.map((doc) => doc.tokens.join(" ")));
    const parts = [new SegmentPart(left), new LivePart(live)];
    const ranked = rankParts("bravo rare12 papa", parts, 0);
    const byId = new Map(ranked.map((hit) => [hit.part === 0 ? left.docId(hit.doc) : input[50 + hit.doc]!.id, hit.score]));
    input.forEach((doc, at) => expect(byId.get(doc.id) ?? 0).toBeCloseTo(expected[at] as number, 10));
  });

  it("a row's expired text stops counting at once: its structured words still do, its text words do not", () => {
    const row = { id: deterministicEventId(ORG_A, "github", "github.com", "e-1", "1"), occurredAtMs: 5_000, kind: "github.review_comment", source: "github", restricted: false, hotExpiresAt: 2_000_000_000, textExpiresAt: 1_000, tokens: keywordTokens(`quartzword ${JSON.stringify({ title: "gadgetname" })}`), structTokens: keywordTokens(` ${JSON.stringify({ title: "gadgetname" })}`) };
    const other = { ...row, id: deterministicEventId(ORG_A, "github", "github.com", "e-2", "1"), occurredAtMs: 6_000, textExpiresAt: undefined as number | undefined, structTokens: undefined as string[] | undefined, tokens: keywordTokens("plain filler {}") };
    const { textExpiresAt: _unused, structTokens: _none, ...plain } = other; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    const reader = new SegmentReader(encodeSegment([row, plain]).bytes);
    const before = rankParts("quartzword", [new SegmentPart(reader)], 999);
    const after = rankParts("quartzword", [new SegmentPart(reader)], 1_001);
    const structured = rankParts("gadgetname", [new SegmentPart(reader)], 1_001);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(0);
    expect(structured).toHaveLength(1);
  });
});

describe("building, coverage and the search path", () => {
  async function corpus(w: World, count: number, project = "web"): Promise<void> {
    seedRows(w, Array.from({ length: count }, (_unused, i) => rowOf(w, i, { project, text: textOf(i, i % 9 === 0 ? 260 : 25), structured: { title: `Title ${String(i)}` } })));
  }

  it("a project with no index, or one still being built, is answered by the window (the fallback), and the answer is the same rows", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await corpus(w, 90);
    const before = await recordSearch(searchDeps(w), person(), "web", { query: "alpha bravo", limit: 10 });
    expect(w.logs.some((log) => log.event === "record.keyword_index")).toBe(false);
    expect(before.hits.length).toBeGreaterThan(0);
    // the first pass creates the manifest and builds: not complete until a seal reached the end
    const deps = depsOf(w);
    await maintainProject(deps, ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(manifestOf(w)?.coverage).toBe("complete");
    const after = await recordSearch(searchDeps(w), person(), "web", { query: "alpha bravo", limit: 10 });
    expect(w.logs.some((log) => log.event === "record.keyword_index")).toBe(true);
    expect(ids(after.hits).sort()).toEqual(ids(before.hits).sort());
  });

  it("the index is not used while the first build is unfinished, and the search falls back to the window meanwhile", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await corpus(w, SEGMENT_DOCS + 300);
    // a pass with no time: creates the manifest and seals nothing
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms - 1 });
    expect(manifestOf(w)?.coverage).toBe("building");
    const hits = await recordSearch(searchDeps(w), person(), "web", { query: "alpha bravo", limit: 10 });
    expect(w.logs.some((log) => log.event === "record.keyword_index")).toBe(false);
    expect(hits.hits.length).toBeGreaterThan(0);
    // one more pass seals one segment of SEGMENT_DOCS rows and is still building (rows are left)
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    await buildIndex(w);
    expect(manifestOf(w)?.coverage).toBe("complete");
    expect(manifestOf(w)!.segments.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("recall over the whole hot table equals full-corpus BM25 over the best passage (every row, not the newest window)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await corpus(w, 700);
    await buildIndex(w);
    const events = eventsInTable(w);
    expect(events).toHaveLength(700);
    const cache = new SegmentCache();
    const view = await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(view).toBeDefined();
    for (const query of ["alpha bravo", "rare7", "whiskey rare3 oscar", "zulu uniform", "Title 123"]) {
      const documents = events.map((event) => keywordDocumentOf(event, NOW(w)));
      const expected = bm25PassageScores(query, documents);
      const wanted = events.map((event, at) => ({ id: event.id, score: expected[at] as number })).filter((row) => row.score > 0).sort((left, right) => right.score - left.score);
      const hits = await view!.rank(query, { facts: [], accept: () => true, top: 100_000, nowSeconds: NOW(w) });
      expect(hits.length, query).toBe(wanted.length);
      const byId = new Map(hits.map((hit) => [hit.event!.id, hit.score]));
      for (const row of wanted) expect(byId.get(row.id), `${query} / ${row.id}`).toBeCloseTo(row.score, 10);
    }
  }, 120_000);

  it("rows older than the newest window are found (the point of the index): a rare word in the oldest row of 5,000", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 5_000 }, (_unused, i) => rowOf(w, i, { text: i === 0 ? "the oldest row mentions the zebracrossing incident" : textOf(i, 20) })));
    const oldest = rowOf(w, 0, { text: "x" }).id;
    const keywordWindowHits = await recordSearch(searchDeps(w, { keywordIndex: false }), person(), "web", { query: "zebracrossing", limit: 5 });
    expect(ids(keywordWindowHits.hits)).not.toContain(oldest); // the 400-row window cannot reach it
    await buildIndex(w);
    const hits = await recordSearch(searchDeps(w), person(), "web", { query: "zebracrossing", limit: 5 });
    expect(ids(hits.hits)).toContain(oldest);
  }, 240_000);

  it("rows newer than the watermark (the tail) and late rows are searched too, and a late row that a rebuild has folded in is not counted twice", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await corpus(w, 60);
    await buildIndex(w);
    const watermark = manifestOf(w)!.segments.at(-1)!.upTo;
    // a fresh row (newer than the watermark): the tail
    const fresh = rowOf(w, 1_000, { text: "freshtailword appears here", at: w.clock.ms - 5 * 60_000 });
    seedRows(w, [fresh]);
    // a late row: written through the store, with an old time (inside a sealed range), so it has a marker
    const late = rowOf(w, 1_001, { text: "latemarkerword appears here", at: Date.parse(watermark) - 10 * 60_000 });
    expect(await putRecordEvent(w.table, late, { nowMs: w.clock.ms })).toBe("stored");
    expect(w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX))).toHaveLength(1);
    const view = await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w));
    expect(view!.shape).toMatchObject({ tail: 1, late: 1 });
    expect(ids((await recordSearch(searchDeps(w), person(), "web", { query: "freshtailword", limit: 5 })).hits)).toEqual([fresh.id]);
    expect(ids((await recordSearch(searchDeps(w), person(), "web", { query: "latemarkerword", limit: 5 })).hits)).toEqual([late.id]);
    // a pass folds the late row into its segment and removes the marker; the row is then found through the segment, once
    await buildIndex(w);
    expect(w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX))).toHaveLength(0);
    const folded = await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w));
    expect(folded!.shape.late).toBe(0);
    const hits = await folded!.rank("latemarkerword", { facts: [], accept: () => true, top: 10, nowSeconds: NOW(w) });
    expect(hits.map((hit) => hit.event!.id)).toEqual([late.id]);
    expect(KEYWORD_LATE_MS).toBe(2 * HOUR);
  }, 120_000);
});

describe("segments and the day: sealing, merging, the rest of the tail", () => {
  it("rows come in day by day: the tail is sealed once it is a day old or large, small neighbours merge, and every row stays findable", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const start = w.clock.ms;
    const all: string[] = [];
    for (let day = 0; day < 5; day += 1) {
      const rows = Array.from({ length: 40 }, (_unused, i) => rowOf(w, day * 100 + i, { text: `day${String(day)} item${String(i)} ${textOf(day * 100 + i, 15)}`, at: start - (5 - day) * DAY + i * 60_000 }));
      seedRows(w, rows);
      all.push(...rows.map((row) => row.id));
      w.clock.ms = start - (4 - day) * DAY;
      await buildIndex(w);
    }
    w.clock.ms = start;
    await buildIndex(w);
    const manifest = manifestOf(w)!;
    expect(manifest.coverage).toBe("complete");
    // 200 rows, none dirty, merged into one segment (200 <= SEGMENT_DOCS)
    expect(manifest.segments.reduce((sum, entry) => sum + entry.docs, 0)).toBeGreaterThanOrEqual(150);
    for (let day = 0; day < 5; day += 1) {
      const view = await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w));
      const hits = await view!.rank(`day${String(day)}`, { facts: [], accept: () => true, top: 1_000, nowSeconds: NOW(w) });
      expect(hits.length).toBeGreaterThanOrEqual(30);
    }
    expect(segmentsOf(w).length).toBe(manifest.segments.length);
  }, 120_000);
});

describe("per company, and the reader's right", () => {
  it("two companies with a project of the same name and the same words never see each other's rows, and every index key starts with its own company", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    const a = Array.from({ length: 40 }, (_unused, i) => rowOf(w, i, { text: `shared sharedword ${textOf(i, 20)}` }));
    const b = Array.from({ length: 40 }, (_unused, i) => rowOf(w, i, { org: ORG_B, text: `shared sharedword onlyinb ${textOf(i + 500, 20)}` }));
    seedRows(w, [...a, ...b]);
    const cache = new SegmentCache();
    await buildIndex(w, "web", ORG_A, { cache });
    await buildIndex(w, "web", ORG_B, { cache });
    for (const item of w.db.find((entry) => String(entry.sk).startsWith("KWIDX#") || String(entry.sk).startsWith("KWLATE#"))) {
      expect(String(item.pk)).toMatch(/^WS#org_(aaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbb)#P#web$/);
    }
    const inA = await recordSearch(searchDeps(w, { keywordIndex: { cache } }), person(), "web", { query: "sharedword", limit: 20 });
    expect(inA.hits.length).toBeGreaterThan(0);
    expect(ids(inA.hits).every((id) => a.some((row) => row.id === id))).toBe(true);
    expect((await recordSearch(searchDeps(w, { keywordIndex: { cache } }), person(), "web", { query: "onlyinb", limit: 20 })).hits).toEqual([]);
    const inB = await recordSearch(searchDeps(w, { keywordIndex: { cache } }), person({ orgId: ORG_B }), "web", { query: "onlyinb", limit: 20 });
    expect(ids(inB.hits).every((id) => b.some((row) => row.id === id))).toBe(true);
    expect(inB.hits.length).toBeGreaterThan(0);
    // the cache is keyed by company: B's segments are not A's
    expect(manifestOf(w, ORG_A)!.segments[0]!.id).not.toBe(manifestOf(w, ORG_B)!.segments[0]!.id);
  });

  it("a row the reader may not see is never returned, and its presence cannot be told from the answer", async () => {
    // two worlds with the same visible rows; one also holds a restricted row, a row the reader may not see, that carries the word the visible rows have and one of its own
    const build = async (withHidden: boolean): Promise<{ w: World; hidden: string }> => {
      const w = world();
      await addSource(w, { source: "github", scope: GITHUB_SCOPE });
      const hidden = rowOf(w, 100, { text: "hiddenonlyword visibleword visibleword visibleword", restricted: true });
      seedRows(w, [...Array.from({ length: 30 }, (_unused, i) => rowOf(w, i, { text: `visibleword ${textOf(i, 20)}` })), ...(withHidden ? [hidden] : [])]);
      await buildIndex(w);
      return { w, hidden: hidden.id };
    };
    const without = await build(false);
    const withRow = await build(true);
    // the hidden row IS in the index (it is a segment's row), so the test goes through the index path, not around it
    expect(indexHoldsWord(withRow.w, "hiddenonlyword")).toBe(true);
    expect(indexHoldsWord(without.w, "hiddenonlyword")).toBe(false);
    const asked = async (w: World, query: string, extra: Partial<RecordQueryDependencies> = {}) => recordSearch(searchDeps(w, extra), person(), "web", { query, limit: 20 });
    // a word only the hidden row has: nothing is returned in either world, and the flag the API has always had (never a count) is what the old window path gives too
    const onlyHidden = await asked(withRow.w, "hiddenonlyword");
    expect(onlyHidden.hits).toEqual([]);
    expect(onlyHidden.someHidden).toBe((await asked(withRow.w, "hiddenonlyword", { keywordIndex: false })).someHidden);
    expect((await asked(without.w, "hiddenonlyword")).hits).toEqual([]);
    // a word the hidden row shares with visible rows: it is not among the hits and the visible rows keep their order (the hidden row holds no place)
    const shared = await asked(withRow.w, "visibleword");
    const base = await asked(without.w, "visibleword");
    expect(ids(shared.hits)).not.toContain(withRow.hidden);
    expect(ids(shared.hits)).toEqual(ids(base.hits));
    expect(shared.hits.length).toBeGreaterThan(0);
    // and a shared reader (an agent) never sees a restricted row either
    const shared2 = await recordSearch(searchDeps(withRow.w), { kind: "shared", orgId: ORG_A }, "web", { query: "hiddenonlyword visibleword", limit: 20 });
    expect(ids(shared2.hits)).not.toContain(withRow.hidden);
  }, 120_000);
});

describe("a row written through ingest, and a cold start", () => {
  it("a late row gets its marker in the row's own transaction; a fresh row and a redelivery get none; the marker holds no words", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const draft = (id: string, occurredAt: string) => githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, occurredAt, links: [], text: "markerword inside", audience: { kind: "project" }, scope: GITHUB_SCOPE });
    const old = new Date(w.clock.ms - 3 * HOUR).toISOString();
    const fresh = new Date(w.clock.ms - 20 * 60_000).toISOString();
    expect(await w.sink.put(draft("old-1", old))).toMatchObject({ status: "stored" });
    expect(await w.sink.put(draft("new-1", fresh))).toMatchObject({ status: "stored" });
    const markers = w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ pk: `WS#${ORG_A}#P#web`, entityType: "TEAM_RECORD_KWLATE" });
    expect(String(markers[0]!.sk)).toContain(old);
    expect(Object.keys(markers[0]!).sort()).toEqual(["entityType", "indexExpiresAt", "pk", "sk"]);
    // the row and its marker were one transaction
    expect(w.db.transactions().some((entry) => entry.length === 2 && entry.every((action) => (action as { Put?: unknown }).Put !== undefined))).toBe(true);
    expect(await w.sink.put(draft("old-1", old))).toMatchObject({ status: "duplicate" });
    expect(w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX))).toHaveLength(1);
  });

  it("a cold start loads a 20,000-row project's index within the budget (the segments are read in parallel and parsed lazily)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 20_000 }, (_unused, i) => rowOf(w, i, { text: `${textOf(i, 25)} unit${String(i % 500)}`, structured: { title: `Item ${String(i)}` } })));
    await buildIndex(w, "web", ORG_A, { rounds: 100 });
    const manifest = manifestOf(w)!;
    expect(manifest.coverage).toBe("complete");
    expect(manifest.segments.length).toBeGreaterThanOrEqual(5);
    const started = Date.now();
    const view = await openKeywordIndex(depsOf(w, new SegmentCache()), ORG_A, "web", NOW(w));
    const loadMs = Date.now() - started;
    expect(view!.shape.docs).toBe(20_000);
    const query = Date.now();
    const hits = await view!.rank("alpha unit42", { facts: [], accept: () => true, top: 100, nowSeconds: NOW(w) });
    const rankMs = Date.now() - query;
    expect(hits.length).toBe(100);
    // the design's budget is +100-300 ms for a cold load; a test machine under load gets a wide margin, the figures are in the report
    expect(loadMs).toBeLessThan(3_000);
    expect(rankMs).toBeLessThan(3_000);
    // the index is small: well under a megabyte per thousand rows
    const bytes = manifest.segments.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(bytes / 20).toBeLessThan(1_000_000);
    console.info(`keyword index, 20,000 rows: ${String(manifest.segments.length)} segments, ${String(bytes)} bytes, cold load ${String(loadMs)} ms, one ranking ${String(rankMs)} ms`);
  }, 300_000);
});
