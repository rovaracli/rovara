// The keyword index under the retrieval eval (lane K2, DECISIONS 145; environments/embedder/eval/run_index_eval.py). NOT a unit test: it is skipped unless KWIDX_EVAL_IN names the eval's input.
//
// The eval harness (Python) builds the synthetic corpus and the vector rankings of bge-small, and runs THIS file with vitest. Here the PRODUCTION code runs: the corpus is written as hot rows into a fake team-record table in time
// order (the corpus order), 97 % of them are sealed into index segments by the real maintenance job, the newest rows stay the live tail, and 3 % are written late (through the store, with their late markers) into ranges that are
// sealed already; then every query goes through `recordSearch` (the meaning list is the harness's bge-small ranking, fed through the vector port; the keyword list is the index; the blend, the top-30 cut, the reload and the permission
// filter are the real ones). The answers are written to KWIDX_EVAL_OUT for the harness to score.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { eventVectorRef } from "../../../packages/broker/src/team-record/ingest.js";
import { keywordDocumentOf } from "../../../packages/broker/src/team-record/keyword-document.js";
import { SegmentCache, openKeywordIndex } from "../../../packages/broker/src/team-record/keyword-index.js";
import { bm25PassageScores } from "../../../packages/broker/src/team-record/search-fusion.js";
import { putRecordEvent } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, addSource, caller, world, GITHUB_SCOPE } from "../../support/team-record-core.js";
import { buildIndex, depsOf, eventsInTable, manifestOf, rowOf, seedRows } from "../../support/keyword-index.js";

const input = process.env.KWIDX_EVAL_IN;

describe.skipIf(input === undefined)("keyword index eval runner", () => {
  it("answers every query of the harness's input through the production search", async () => {
    const data = JSON.parse(readFileSync(input as string, "utf8")) as { rows: Array<{ text: string }>; queries: Array<{ query: string }>; vector: number[][]; lateEvery?: number };
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const rows = data.rows.map((row, at) => rowOf(w, at, { text: row.text, at: start + at * 60_000 }));
    w.clock.ms = start + data.rows.length * 60_000 + 90 * 60_000; // the newest ~30 rows are younger than the two-hour margin: the live tail
    const lateEvery = data.lateEvery ?? Math.max(33, Math.ceil(data.rows.length / 300)); // at most ~300 late rows: more than LATE_MAX unfolded markers make the search use the window until a pass folds them
    const late = new Set(rows.map((_row, at) => at).filter((at) => at % lateEvery === lateEvery - 1 && at < rows.length - 400));
    seedRows(w, rows.filter((_row, at) => !late.has(at)));
    const cache = new SegmentCache();
    const buildStart = Date.now();
    await buildIndex(w, "web", ORG_A, { cache, rounds: 200 });
    const buildMs = Date.now() - buildStart;
    for (const at of late) await putRecordEvent(w.table, rows[at]!, { nowMs: w.clock.ms });
    const indexOf = new Map(rows.map((row, at) => [row.id, at]));
    const nowSeconds = Math.floor(w.clock.ms / 1000);

    const coldStart = Date.now();
    const view = await openKeywordIndex(depsOf(w, new SegmentCache()), ORG_A, "web", nowSeconds);
    const coldLoadMs = Date.now() - coldStart;
    expect(view).toBeDefined();
    const warmView = (await openKeywordIndex(depsOf(w, cache), ORG_A, "web", nowSeconds))!;

    const events = eventsInTable(w);
    const documents = events.map((event) => keywordDocumentOf(event, nowSeconds));
    const keyword: number[][] = [];
    const sameTop10: boolean[] = [];
    for (const query of data.queries) {
      const hits = await warmView.rank(query.query, { facts: [], accept: () => true, top: 100, nowSeconds });
      keyword.push(hits.map((hit) => indexOf.get(hit.event!.id) as number));
      // the oracle: the passage scorer over every row, read in full (what the index must equal): the same ten scores, in order
      const expected = bm25PassageScores(query.query, documents).filter((score) => score > 0).sort((left, right) => right - left).slice(0, 10);
      const got = hits.slice(0, 10).map((hit) => hit.score);
      sameTop10.push(expected.length === got.length && expected.every((score, at) => Math.abs(score - (got[at] as number)) < 1e-9));
    }

    const queryIndexOf = new Map(data.queries.map((query, at) => [query.query, at]));
    const deps = {
      table: w.table, modes: w.deps.modes, now: () => w.clock.ms, keywordIndex: { cache },
      embedder: { async embed(text: string) { return [queryIndexOf.get(text) ?? -1, 0, 0]; } },
      vectorSearch: {
        async query(request: { vector: number[] }) {
          return (data.vector[request.vector[0] as number] ?? []).map((at, rank) => {
            const row = rows[at]!;
            return { key: `event:${row.id}`, distance: rank / 1000, metadata: { ref: eventVectorRef(row), kind: row.kind, project: "web", trust: row.trust, audience_kind: "project" as const, scope: row.scope } };
          });
        },
      },
    };
    const blend: number[][] = [];
    const logs: string[] = [];
    for (const query of data.queries) {
      const answer = await recordSearch({ ...deps, log: (event) => { logs.push(event); } }, { kind: "caller", caller: caller() }, "web", { query: query.query, limit: 20 });
      blend.push(answer.hits.map((hit) => indexOf.get(hit.id) as number));
    }
    expect(logs).toContain("record.keyword_index");
    expect(logs).not.toContain("record.keyword_index_unavailable");
    const manifest = manifestOf(w)!;
    writeFileSync(process.env.KWIDX_EVAL_OUT as string, JSON.stringify({
      rows: rows.length, keyword, blend, sameTop10, buildMs, coldLoadMs, lateRows: late.size, shape: view!.shape,
      segments: manifest.segments.map((entry) => ({ docs: entry.docs, bytes: entry.bytes, chunks: entry.chunks })),
    }));
  }, 3_600_000);
});
