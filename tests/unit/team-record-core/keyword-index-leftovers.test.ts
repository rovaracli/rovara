// Review findings 7 and 8 of the keyword index (0.5.17 leftovers): the warm-container segment cache lets go of retired, rebuilt, damaged and unlisted segments; an orphan chunk is never searchable and a build cannot leave chunks behind
// an erase; a visible row ranked behind more than 100 rows the reader may not see is still found, and a hidden row is never returned.
import { describe, expect, it } from "vitest";
import { teamRecordPk } from "@rovara-code/contracts";
import { recordSearch, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import { KEYWORD_CANDIDATES, KEYWORD_CANDIDATES_MAX, SegmentCache, eraseKeywordIndexItems, maintainProject, markKeywordIndexDamaged, openKeywordIndex, removalGate } from "../../../packages/broker/src/team-record/keyword-index.js";
import { keywordTokens } from "../../../packages/broker/src/team-record/search-fusion.js";
import { encodeSegment } from "../../../packages/broker/src/team-record/keyword-index-segment.js";
import { tombstoneItem } from "../../../packages/broker/src/team-record/store.js";
import type { TeamRecordTable } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, addSource, caller, world, type World } from "../../support/team-record-core.js";
import { DAY, buildIndex, depsOf, isChunkWrite, manifestOf, rowOf, seedRows } from "../../support/keyword-index.js";

const NOW = (w: World): number => Math.floor(w.clock.ms / 1000);
const searchDeps = (w: World, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, log: (event, fields) => { w.logs.push({ event, fields: { ...fields } }); }, ...extra });
const search = (w: World, query: string, limit = 10) => recordSearch(searchDeps(w), { kind: "caller", caller: caller() }, "web", { query, limit });
const keyOf = (id: string): string => SegmentCache.key(ORG_A, "web", id);

/** A project with one sealed segment of 20 rows, built with `cache`. */
async function oneSegment(cache: SegmentCache): Promise<{ w: World; old: string }> {
  const w = world();
  await addSource(w, { source: "github", scope: GITHUB_SCOPE });
  seedRows(w, Array.from({ length: 20 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} zzcache${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
  await buildIndex(w, "web", ORG_A, { cache });
  return { w, old: manifestOf(w)!.segments[0]!.id };
}

describe("finding 7a: the warm container's segment cache does not keep retired words", () => {
  it("a rebuild by this container drops the retired segment from its cache at once", async () => {
    const cache = new SegmentCache();
    const { w, old } = await oneSegment(cache);
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(cache.get(keyOf(old))).toBeDefined();
    const row = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]!;
    await tombstoneItem(w.table, { pk: row.pk as string, sk: row.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "person_erased" });
    const gate = await removalGate(depsOf(w, cache), ORG_A, [w.db.get({ pk: row.pk as string, sk: row.sk as string })!], { budgetMs: 30_000 });
    expect(gate.ready.size).toBe(1);
    expect(manifestOf(w)!.segments[0]!.id).not.toBe(old);
    expect(cache.get(keyOf(old))).toBeUndefined();
  });

  it("a search in ANOTHER warm container that reads the new manifest drops the segments it no longer lists", async () => {
    const builder = new SegmentCache();
    const other = new SegmentCache();
    const { w, old } = await oneSegment(builder);
    await openKeywordIndex(depsOf(w, other), ORG_A, "web", NOW(w));
    expect(other.get(keyOf(old))).toBeDefined();
    const row = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]!;
    await tombstoneItem(w.table, { pk: row.pk as string, sk: row.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "person_erased" });
    await removalGate(depsOf(w, builder), ORG_A, [w.db.get({ pk: row.pk as string, sk: row.sk as string })!], { budgetMs: 30_000 });
    expect(other.get(keyOf(old))).toBeDefined();                      // the other container has not heard of the rebuild yet
    await openKeywordIndex(depsOf(w, other), ORG_A, "web", NOW(w));
    expect(other.get(keyOf(old))).toBeUndefined();
    expect(other.size).toBe(manifestOf(w)!.segments.length);
  });

  it("another project's or company's cached segments are left alone by that pruning", async () => {
    const cache = new SegmentCache();
    const { w } = await oneSegment(cache);
    const reader = (await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w))) !== undefined ? cache.get(keyOf(manifestOf(w)!.segments[0]!.id))! : undefined;
    cache.set(SegmentCache.key(ORG_A, "api", "zzother"), reader!, { orgId: ORG_A, project: "api", segment: "zzother" });
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(cache.get(SegmentCache.key(ORG_A, "api", "zzother"))).toBeDefined();
  });

  it("marking a segment damaged drops it from the cache and marks it dirty", async () => {
    const cache = new SegmentCache();
    const { w, old } = await oneSegment(cache);
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(cache.get(keyOf(old))).toBeDefined();
    await markKeywordIndexDamaged(depsOf(w, cache), ORG_A, "web", old);
    expect(cache.get(keyOf(old))).toBeUndefined();
    expect(manifestOf(w)!.segments[0]!.dirty).toMatchObject({ reason: "damaged" });
  });

  it("a rebuild of a damaged segment (the next pass) leaves the old one out of the cache", async () => {
    const cache = new SegmentCache();
    const { w, old } = await oneSegment(cache);
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    await markKeywordIndexDamaged(depsOf(w, cache), ORG_A, "web", old);
    await maintainProject(depsOf(w, cache), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(cache.get(keyOf(old))).toBeUndefined();
    expect(cache.size).toBe(manifestOf(w)!.segments.length);
  });

  it("the container that erases a project's index (an archive) drops that project's cached segments at once", async () => {
    const cache = new SegmentCache();
    const { w, old } = await oneSegment(cache);
    await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w));
    expect(cache.get(keyOf(old))).toBeDefined();
    await eraseKeywordIndexItems(depsOf(w, cache), ORG_A, "web", 10_000);
    expect(cache.size).toBe(0);
  });

  it("deleting a retired segment's chunks (the clean-up of a manifest that still lists it as retired) drops it from the cache", async () => {
    const cache = new SegmentCache();
    const { w, old } = await oneSegment(cache);
    const reader = (await openKeywordIndex(depsOf(w, cache), ORG_A, "web", NOW(w))) !== undefined ? cache.get(keyOf(old))! : undefined;
    const retiredId = "zzretired01";
    cache.set(keyOf(retiredId), reader!, { orgId: ORG_A, project: "web", segment: retiredId });
    const manifest = manifestOf(w)!;
    w.db.set({ pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#M", entityType: "TEAM_RECORD_KWIDX_MANIFEST", ...manifest, retired: [retiredId] });
    await maintainProject(depsOf(w, cache), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(manifestOf(w)!.retired).toEqual([]);
    expect(cache.get(keyOf(retiredId))).toBeUndefined();
    expect(cache.get(keyOf(old))).toBeDefined();
  });

  it("an erased index (a project archive) leaves nothing of it in a container that searches afterwards", async () => {
    const builder = new SegmentCache();
    const other = new SegmentCache();
    const { w, old } = await oneSegment(builder);
    await openKeywordIndex(depsOf(w, other), ORG_A, "web", NOW(w));
    expect(other.get(keyOf(old))).toBeDefined();
    await eraseKeywordIndexItems(depsOf(w, builder), ORG_A, "web", 10_000);
    expect(await openKeywordIndex(depsOf(w, other), ORG_A, "web", NOW(w))).toBeUndefined();
    expect(other.size).toBe(0);
  });
});

describe("finding 7b: orphan chunks", () => {
  it("an orphan segment (chunks and an old intent the manifest does not list) is never searched: its words find nothing, and the next pass deletes it", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 20 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} plainword${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    await buildIndex(w);
    const victim = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]!;
    // a dead build that read the row before its tombstone: a segment holding a word the row does not have in the table, chunks and intent written, no manifest switch
    const encoded = encodeSegment([{ id: victim.id as string, occurredAtMs: Date.parse(String(victim.occurredAt)), kind: "github.review_comment", source: "github", restricted: false, hotExpiresAt: NOW(w) + 100 * 3600, tokens: keywordTokens("zzorphanword zzorphanword") }]);
    const pk = teamRecordPk(ORG_A, "web");
    w.db.set({ pk, sk: "KWIDX#B#deadorphan1", entityType: "TEAM_RECORD_KWIDX_BUILD", segment: "deadorphan1", at: new Date(w.clock.ms - 10 * 60_000).toISOString() });
    w.db.set({ pk, sk: "KWIDX#S#deadorphan1#00000", entityType: "TEAM_RECORD_KWIDX_CHUNK", segment: "deadorphan1", n: 0, data: new Uint8Array(encoded.bytes) });
    const hits = await search(w, "zzorphanword");
    expect(hits.hits).toEqual([]);
    expect(w.logs.some((log) => log.event === "record.keyword_index")).toBe(true);   // through the index, not around it
    const view = await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w));
    expect(view!.shape.segments).toBe(manifestOf(w)!.segments.length);
    expect(await view!.rank("zzorphanword", { facts: [], accept: () => true, top: 10, nowSeconds: NOW(w) })).toEqual([]);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#S#deadorphan1#"))).toEqual([]);
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#B#"))).toEqual([]);
  });

  it("a build that is still writing when the project's index is erased cannot leave chunks behind, even if its own clean-up then fails", async () => {
    const w = world();
    seedRows(w, Array.from({ length: 20 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} zzrace${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    const real = w.table.documentClient;
    let crashed = false;
    const racing: TeamRecordTable = { ...w.table, documentClient: { send: async (command: unknown) => {
      if (crashed && (command as { constructor: { name: string } }).constructor.name === "DeleteCommand") throw Object.assign(new Error("the build's process is gone"), { name: "ServiceUnavailable" });
      if (!crashed && isChunkWrite(command)) {
        crashed = true;                                              // the erase runs between the build's intent and its first chunk, and the build's own deletes can no longer run
        await eraseKeywordIndexItems(depsOf(w), ORG_A, "web", 10_000);
      }
      return real.send(command);
    } } };
    await expect(maintainProject({ ...depsOf(w), table: racing }, ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 })).rejects.toThrow();
    expect(crashed).toBe(true);
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#"))).toEqual([]);
  });
});

describe("finding 8: the visibility check goes past the first 100 candidates", () => {
  const corpus = async (hidden: number, visible = 3): Promise<{ w: World; hiddenIds: string[]; visibleIds: string[] }> => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const base = w.clock.ms - 3 * DAY;
    // restricted rows (the reader is not on the list) that rank ABOVE the visible rows: a longer run of the query word in a short text
    const hiddenRows = Array.from({ length: hidden }, (_unused, i) => rowOf(w, i, { text: "needleword needleword needleword needleword needleword", restricted: true, at: base + i * 1_000 }));
    const visibleRows = Array.from({ length: visible }, (_unused, i) => rowOf(w, hidden + i, { text: `needleword alpha bravo charlie delta echo foxtrot golf ${String(i)}`, at: base + (hidden + i) * 1_000 }));
    seedRows(w, [...hiddenRows, ...visibleRows]);
    await buildIndex(w);
    return { w, hiddenIds: hiddenRows.map((row) => row.id), visibleIds: visibleRows.map((row) => row.id) };
  };

  it("a visible row ranked behind more than 100 rows the reader may not see is still returned", async () => {
    const { w, visibleIds } = await corpus(250);
    expect(250).toBeGreaterThan(KEYWORD_CANDIDATES);
    const answer = await search(w, "needleword", 10);
    expect(w.logs.some((log) => log.event === "record.keyword_index")).toBe(true);
    expect(answer.hits.map((hit) => hit.id).sort()).toEqual([...visibleIds].sort());
  }, 120_000);

  it("a hidden row is never in the result, with the visible ones behind 100+ of them or past the bound", async () => {
    for (const hidden of [KEYWORD_CANDIDATES + 20, KEYWORD_CANDIDATES_MAX + 20]) {
      const { w, hiddenIds, visibleIds } = await corpus(hidden);
      const answer = await search(w, "needleword", 50);
      const returned = answer.hits.map((hit) => hit.id);
      expect(returned.filter((id) => hiddenIds.includes(id)), `hidden rows in the answer (${String(hidden)} hidden)`).toEqual([]);
      for (const id of returned) expect(visibleIds, `${String(hidden)} hidden`).toContain(id);
      // within the bound the visible rows are all found (past it the search reads no further: the accepted bound, DEFERRED-CHECKS)
      if (hidden <= KEYWORD_CANDIDATES_MAX) expect(returned.sort()).toEqual([...visibleIds].sort());
      expect(answer.someHidden).toBe(true);
    }
  }, 240_000);

  it("a shared reader (an agent) is never shown a restricted row, and its visible rows are not pushed out either", async () => {
    const { w, hiddenIds, visibleIds } = await corpus(250);
    const answer = await recordSearch(searchDeps(w), { kind: "shared", orgId: ORG_A }, "web", { query: "needleword", limit: 10 });
    const returned = answer.hits.map((hit) => hit.id);
    expect(returned.filter((id) => hiddenIds.includes(id))).toEqual([]);
    expect(returned.sort()).toEqual([...visibleIds].sort());
  }, 120_000);
});
