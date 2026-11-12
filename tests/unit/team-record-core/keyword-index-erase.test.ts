// Lane K3 (DECISIONS 145): removals and erasures leave the keyword index within the hour; the delete worker waits for the rebuild; company erase removes every index item; racing writes cannot bring a removed row's words back.
import { describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk } from "@rovara-code/contracts";
import { DELETE_BACKLOG_SECONDS, runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { erasePerson, eraseProject, eraseWorkspace } from "../../../packages/broker/src/team-record/erase.js";
import { KWIDX_PREFIX, KWLATE_PREFIX, markKeywordIndexRemoved, maintainProject, removalGate } from "../../../packages/broker/src/team-record/keyword-index.js";
import { putRecordEvent, tombstoneItem } from "../../../packages/broker/src/team-record/store.js";
import { recordSearch, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import type { TeamRecordTable } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps, idsOf } from "../../support/team-record-delete.js";
import { DAY, HOUR, buildIndex, depsOf, indexHoldsWord, manifestOf, rowOf, seedRows } from "../../support/keyword-index.js";

const PUT = async (w: World, id: string, dev: "dev-1" | "dev-2", text: string): Promise<void> => {
  const outcome = await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, actor: { sourceId: dev === "dev-1" ? "123" : "456", developerId: dev, trust: "member" }, links: [], text, audience: { kind: "project" }, scope: GITHUB_SCOPE }));
  if (outcome.status !== "stored") throw new Error(JSON.stringify(outcome));
};
const searchDeps = (w: World): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms });
const searchIds = async (w: World, query: string): Promise<string[]> => (await recordSearch(searchDeps(w), { kind: "caller", caller: caller() }, "web", { query, limit: 10 })).hits.map((hit) => hit.id);
const commentsOf = (w: World): string[] => idsOf(w).filter((id) => id.startsWith("c-"));
const indexItems = (w: World, orgId = ORG_A) => w.db.find((item) => typeof item.pk === "string" && item.pk.startsWith(`WS#${orgId}#`) && typeof item.sk === "string" && (item.sk.startsWith(KWIDX_PREFIX) || item.sk.startsWith(KWLATE_PREFIX)));

/** Three comments with a word of their own each (c-1 and c-2 by dev-1, c-3 by dev-2), fifty filler rows, and a built index. */
async function seeded(w: World): Promise<void> {
  await addSource(w, { source: "github", scope: GITHUB_SCOPE });
  await PUT(w, "c-1", "dev-1", "First comment mentions zzerasealpha and the retry queue");
  await PUT(w, "c-2", "dev-1", "Second comment mentions zzerasebravo and the retry queue");
  await PUT(w, "c-3", "dev-2", "Third comment mentions zzerasecharlie and the retry queue");
  seedRows(w, Array.from({ length: 50 }, (_unused, i) => rowOf(w, 10 + i, { text: `filler row number ${String(i)} about billing and queues`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
  await buildIndex(w);
}

/** The table, with every write of a chunk refused until `fail.on` is set to false. */
function failingChunks(w: World): { table: TeamRecordTable; fail: { on: boolean } } {
  const fail = { on: true };
  const real = w.table.documentClient;
  return {
    fail,
    table: { ...w.table, documentClient: { send: async (command: unknown) => {
      const input = (command as { input?: { Item?: { sk?: string } } }).input;
      if (fail.on && (command as { constructor: { name: string } }).constructor.name === "PutCommand" && String(input?.Item?.sk).startsWith("KWIDX#S#")) throw Object.assign(new Error("table unavailable"), { name: "ServiceUnavailable" });
      return real.send(command);
    } } },
  };
}

describe("K3: a removal leaves the index, and the delete worker waits for it", () => {
  it("a source removal (a tombstone): hidden at once, words out of every segment within the window, row deleted only then", async () => {
    const w = world();
    await seeded(w);
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(true); // positive control: the word is in the index before
    expect(await searchIds(w, "zzerasealpha")).toHaveLength(1);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    // hidden at once (the filter), though the words are still in the segment
    expect(await searchIds(w, "zzerasealpha")).toEqual([]);
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(true);
    // the worker runs 20 minutes later
    w.clock.ms += 20 * 60_000;
    const d = deleteDeps(w);
    const summary = await runDeleteWorker(d.deps, ORG_A);
    expect(summary).toMatchObject({ rows: 1, finished: 1, blocked: 0, backlog: false });
    expect(idsOf(w)).not.toContain("c-1");
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(false);
    expect(indexHoldsWord(w, "zzerasebravo")).toBe(true); // the others stay
    expect(indexHoldsWord(w, "zzerasecharlie")).toBe(true);
    const manifest = manifestOf(w)!;
    expect(manifest.segments.every((entry) => entry.dirty === undefined)).toBe(true);
    expect(manifest.retired).toEqual([]);
  });

  it("the delete worker waits: while the rebuild cannot be written the row, its request and the words all stay, and the request is counted; when the table works again they go", async () => {
    const w = world();
    await seeded(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    const broken = failingChunks(w);
    const d = deleteDeps(w, { table: broken.table });
    const first = await runDeleteWorker(d.deps, ORG_A);
    expect(first).toMatchObject({ rows: 0, finished: 0, blocked: 1, indexWaiting: 1 });
    expect(idsOf(w)).toContain("c-1");                       // not deleted
    expect(rows(w, "TEAM_RECORD_SCOPE_WORK")).toHaveLength(1); // the request stays
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(true);    // physically still there: that is why the row must stay
    expect(manifestOf(w)!.segments.some((entry) => entry.dirty !== undefined)).toBe(true);
    // an hour later it is still waiting: the alarm path (the backlog line carries it)
    w.clock.ms += (DELETE_BACKLOG_SECONDS + 60) * 1000;
    d.logs.length = 0;
    const late = await runDeleteWorker(d.deps, ORG_A);
    expect(late).toMatchObject({ finished: 0, backlog: true, indexWaiting: 1, indexOverdue: 1 });
    expect(d.logs).toEqual(expect.arrayContaining(["record.keyword_index_overdue", "record.delete_backlog"]));
    // the table works again: the rebuild runs, the row goes
    broken.fail.on = false;
    w.clock.ms += 5 * 60_000; // a failed build's intent is cleaned after ORPHAN_AFTER_MS
    const done = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(done).toMatchObject({ rows: 1, finished: 1, blocked: 0 });
    expect(idsOf(w)).not.toContain("c-1");
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(false);
  });

  it("the 15-minute job finishes the rebuild a worker that had no time for it left dirty, and the next worker run deletes the row", async () => {
    const w = world();
    await seeded(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-2"], cause: "source_deleted" });
    const first = await runDeleteWorker(deleteDeps(w, { keywordGateMs: 0 }).deps, ORG_A);
    expect(first).toMatchObject({ rows: 0, blocked: 1, indexWaiting: 1 });
    expect(indexHoldsWord(w, "zzerasebravo")).toBe(true);
    w.clock.ms += 15 * 60_000;
    const pass = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(pass.rebuilt).toBe(1);
    expect(indexHoldsWord(w, "zzerasebravo")).toBe(false);
    expect(idsOf(w)).toContain("c-2");                       // the row is still there: the worker has not run again
    w.clock.ms += 45 * 60_000;
    expect(await runDeleteWorker(deleteDeps(w).deps, ORG_A)).toMatchObject({ rows: 1, finished: 1, blocked: 0, backlog: false });
    expect(idsOf(w)).not.toContain("c-2");
  });

  it("a person erase: their rows' words leave every segment, another person's stay", async () => {
    const w = world();
    await seeded(w);
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "erase-1");
    expect(result).toMatchObject({ rows: 2, complete: true, blocked: 0 });
    expect(commentsOf(w)).toEqual(["c-3"]);
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(false);
    expect(indexHoldsWord(w, "zzerasebravo")).toBe(false);
    expect(indexHoldsWord(w, "zzerasecharlie")).toBe(true);
    expect(await searchIds(w, "zzerasealpha")).toEqual([]);
  });

  it("a person erase that cannot rebuild yet is not complete: the rows stay hidden and are removed on the repeat", async () => {
    const w = world();
    await seeded(w);
    const broken = failingChunks(w);
    const first = await erasePerson(deleteDeps(w, { table: broken.table }).deps, ORG_A, { developerId: "dev-1" }, "erase-1");
    expect(first.complete).toBe(false);
    expect(first.blocked).toBe(2);
    expect(first.indexWaiting).toBe(2);
    expect(commentsOf(w)).toEqual(["c-1", "c-2", "c-3"]);
    expect(await searchIds(w, "zzerasealpha")).toEqual([]); // hidden regardless
    broken.fail.on = false;
    w.clock.ms += 5 * 60_000;
    const again = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "erase-1");
    expect(again).toMatchObject({ complete: true, blocked: 0 });
    expect(commentsOf(w)).toEqual(["c-3"]);
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(false);
  });

  it("a removed place (a whole source): every row of it leaves the index", async () => {
    const w = world();
    await seeded(w);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary).toMatchObject({ blocked: 0 });
    expect(idsOf(w)).toEqual([]);
    for (const word of ["zzerasealpha", "zzerasebravo", "zzerasecharlie"]) expect(indexHoldsWord(w, word), word).toBe(false);
  });

  it("a row that is not tombstoned when it reaches the gate is hidden first, so a rebuild leaves it out", async () => {
    const w = world();
    await seeded(w);
    const item = rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === "c-3")!;
    const gate = await removalGate(depsOf(w), ORG_A, [item], { budgetMs: 30_000 });
    expect(gate.ready.has(`${item.pk as string}|${item.sk as string}`)).toBe(true);
    expect((await w.db.send(new GetCommand({ TableName: "TeamRecord", Key: { pk: item.pk, sk: item.sk } })) as { Item?: { tombstone?: unknown } }).Item?.tombstone).toBeDefined();
    expect(indexHoldsWord(w, "zzerasecharlie")).toBe(false);
  });
});

describe("K3: races with concurrent writes", () => {
  /** The table, running `hook` once just before the first write of the manifest by a build (not by the test). */
  function hookedManifest(w: World, hook: () => Promise<void>): { table: TeamRecordTable; armed: { on: boolean } } {
    const armed = { on: true };
    const real = w.table.documentClient;
    return {
      armed,
      table: { ...w.table, documentClient: { send: async (command: unknown) => {
        const input = (command as { input?: { Item?: { sk?: string }; ConditionExpression?: string } }).input;
        if (armed.on && (command as { constructor: { name: string } }).constructor.name === "PutCommand" && input?.Item?.sk === "KWIDX#M" && input.ConditionExpression === "#version = :expected") { armed.on = false; await hook(); }
        return real.send(command);
      } } },
    };
  }

  it("a removal that lands after a build read its rows makes the build's switch fail: the removed row's words do not come back", async () => {
    const w = world();
    await seeded(w);
    const victim = rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === "c-1")!;
    const other = rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === "c-3")!;
    // c-3 is removed first: its segment is dirty, so the next pass rebuilds it ...
    await tombstoneItem(w.table, { pk: other.pk as string, sk: other.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
    await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [(other.sk as string).split("#")[1]!]);
    // ... and while it builds (rows read, chunks written, not yet switched) c-1 is removed in the same segment
    const racing = hookedManifest(w, async () => {
      await tombstoneItem(w.table, { pk: victim.pk as string, sk: victim.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
      await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [(victim.sk as string).split("#")[1]!]);
    });
    const chunksBefore = w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length;
    const pass = await maintainProject({ ...depsOf(w), table: racing.table }, ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(pass.more).toBe(true);                  // a lost race: left for the next pass
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(true); // the old segment is still the one in use, so c-1's words are still in it ...
    expect(manifestOf(w)!.segments.some((entry) => entry.dirty !== undefined)).toBe(true); // ... marked dirty
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length).toBe(chunksBefore); // the thrown-away build left no orphan chunks
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#B#"))).toEqual([]);
    // the gate does not let the victim go yet while the segment is dirty ...
    const early = await removalGate({ ...depsOf(w), table: racing.table }, ORG_A, [victim], { budgetMs: 0 });
    expect(early.ready.size).toBe(0);
    // ... and the next pass rebuilds without both
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(indexHoldsWord(w, "zzerasealpha")).toBe(false);
    expect(indexHoldsWord(w, "zzerasecharlie")).toBe(false);
    expect(indexHoldsWord(w, "zzerasebravo")).toBe(true);
  });

  it("a removal of a row in the range that a seal is reading: the seal's switch fails, the row's words never reach a segment, and the row may go", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 30 }, (_unused, i) => rowOf(w, i, { text: `base row ${String(i)}`, at: w.clock.ms - 5 * DAY + i * 60_000 })));
    await buildIndex(w);
    const watermark = manifestOf(w)!.segments.at(-1)!.upTo;
    const rowsAfter = Array.from({ length: 600 }, (_unused, i) => rowOf(w, 100 + i, { text: i === 300 ? "unsealedvictimword in this row" : `fresh row ${String(i)}`, at: Date.parse(watermark) + (i + 1) * 60_000 }));
    seedRows(w, rowsAfter);
    w.clock.ms += 2 * DAY;
    const victim = rowsAfter[300]!;
    const victimItem = w.db.find((item) => item.id === victim.id)[0]!;
    const racing = hookedManifest(w, async () => {
      await tombstoneItem(w.table, { pk: victimItem.pk as string, sk: victimItem.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
      await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [victim.occurredAt]);
    });
    const chunksBefore = w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length;
    const pass = await maintainProject({ ...depsOf(w), table: racing.table }, ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(racing.armed.on).toBe(false);
    expect(pass.sealed).toBe(0);                                  // the seal that had read the row lost its switch
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length).toBe(chunksBefore);
    expect(indexHoldsWord(w, "unsealedvictimword")).toBe(false);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(manifestOf(w)!.segments.at(-1)!.upTo).not.toBe(watermark);  // the next pass sealed the rest, without the removed row
    expect(indexHoldsWord(w, "unsealedvictimword")).toBe(false);
    expect(indexHoldsWord(w, "fresh")).toBe(true);
    const gate = await removalGate(depsOf(w), ORG_A, [victimItem], { budgetMs: 30_000 });
    expect(gate.ready.has(`${victimItem.pk as string}|${victimItem.sk as string}`)).toBe(true);
  }, 120_000);

  it("a row written while the tail is being sealed (after the seal read its rows) is found through its late marker, then folded in by the next pass", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 30 }, (_unused, i) => rowOf(w, i, { text: `base row ${String(i)}`, at: w.clock.ms - 5 * DAY + i * 60_000 })));
    await buildIndex(w);
    const watermark = manifestOf(w)!.segments.at(-1)!.upTo;
    // a day of new rows to seal (older than 2 hours)
    seedRows(w, Array.from({ length: 600 }, (_unused, i) => rowOf(w, 100 + i, { text: `fresh row ${String(i)}`, at: Date.parse(watermark) + (i + 1) * 60_000 })));
    w.clock.ms += 2 * DAY;
    const newcomer = rowOf(w, 9_999, { text: "newcomerword", at: Date.parse(watermark) + 5 * 60_000 });
    const racing = hookedManifest(w, async () => { await putRecordEvent(w.table, newcomer, { nowMs: w.clock.ms }); });
    await maintainProject({ ...depsOf(w), table: racing.table }, ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(racing.armed.on).toBe(false);
    // the seal took the rows it had read; the newcomer was not among them, and its marker is still there
    expect(w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX)).map((item) => item.sk)).toEqual([expect.stringContaining(newcomer.id)]);
    expect(await searchIds(w, "newcomerword")).toEqual([newcomer.id]);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(w.db.find((item) => String(item.sk).startsWith(KWLATE_PREFIX))).toEqual([]);
    expect(await searchIds(w, "newcomerword")).toEqual([newcomer.id]);
  }, 120_000);
});

describe("K3: project archive and company erase remove every index item", () => {
  it("company erase: no manifest, chunk, build intent or late marker of the company is left, and another company's index is untouched", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { project: "api", source: "github", scope: "github:repo/10" });
    seedRows(w, [
      ...Array.from({ length: 40 }, (_unused, i) => rowOf(w, i, { text: `web row ${String(i)} companyerasea`, at: w.clock.ms - 3 * DAY + i * 60_000 })),
      ...Array.from({ length: 40 }, (_unused, i) => rowOf(w, 100 + i, { project: "api", text: `api row ${String(i)} companyerasea`, at: w.clock.ms - 3 * DAY + i * 60_000 })),
      ...Array.from({ length: 40 }, (_unused, i) => rowOf(w, 200 + i, { org: ORG_B, text: `b row ${String(i)} companyerasea`, at: w.clock.ms - 3 * DAY + i * 60_000 })),
    ]);
    await buildIndex(w, "web", ORG_A);
    await buildIndex(w, "api", ORG_A);
    await buildIndex(w, "web", ORG_B);
    // a late marker and a stray build intent too
    await putRecordEvent(w.table, rowOf(w, 300, { text: "late one", at: w.clock.ms - 4 * DAY }), { nowMs: w.clock.ms });
    w.db.set({ pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#B#strayintent", entityType: "TEAM_RECORD_KWIDX_BUILD", segment: "strayintent", at: new Date(w.clock.ms).toISOString() });
    // and one stray item in the company's own (project-less) partition, which no project erase is about: the workspace prefixes remove it too
    w.db.set({ pk: teamRecordPk(ORG_A), sk: "KWIDX#M", entityType: "TEAM_RECORD_KWIDX_MANIFEST" });
    expect(indexItems(w, ORG_A).length).toBeGreaterThan(4);
    expect(indexItems(w, ORG_B).length).toBeGreaterThan(1);
    const keptB = indexItems(w, ORG_B).length;
    const result = await eraseWorkspace(deleteDeps(w, { projects: { projects: async () => ["web", "api"] } }).deps, ORG_A, ["web", "api"], "close-1");
    expect(result.complete).toBe(true);
    expect(indexItems(w, ORG_A)).toEqual([]);
    expect(indexItems(w, ORG_B)).toHaveLength(keptB);
    expect(indexHoldsWord(w, "companyerasea", ORG_A)).toBe(false);
    expect(indexHoldsWord(w, "companyerasea", ORG_B)).toBe(true);
  });

  it("a project archive removes that project's index and nothing of its neighbour's", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { project: "api", source: "github", scope: "github:repo/10" });
    seedRows(w, [
      ...Array.from({ length: 30 }, (_unused, i) => rowOf(w, i, { text: `web row ${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })),
      ...Array.from({ length: 30 }, (_unused, i) => rowOf(w, 100 + i, { project: "api", text: `api row ${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })),
    ]);
    await buildIndex(w, "web");
    await buildIndex(w, "api");
    const result = await eraseProject(deleteDeps(w).deps, ORG_A, "web", "project_archived", "arch-1");
    expect(result.complete).toBe(true);
    expect(w.db.find((item) => item.pk === teamRecordPk(ORG_A, "web") && (String(item.sk).startsWith(KWIDX_PREFIX) || String(item.sk).startsWith(KWLATE_PREFIX)))).toEqual([]);
    expect(manifestOf(w, ORG_A, "api")).toBeDefined();
  });
});

describe("K3: expiry", () => {
  it("expired raw text stops matching at once (before any rebuild), its structured words still match, and the nightly pass takes the words out", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const expiresAt = Math.floor(w.clock.ms / 1000) + 6 * 3_600; // in six hours
    const expiring = rowOf(w, 1, { text: "the incident was a quartzexpiry problem", structured: { title: "gadgettitle" }, textExpiresAt: expiresAt, at: w.clock.ms - 10 * DAY });
    const staying = rowOf(w, 2, { text: "another quartzexpiry note that stays", at: w.clock.ms - 10 * DAY + 60_000 });
    seedRows(w, [expiring, staying, ...Array.from({ length: 20 }, (_unused, i) => rowOf(w, 10 + i, { text: `filler ${String(i)}`, at: w.clock.ms - 9 * DAY + i * 60_000 }))]);
    await buildIndex(w);
    expect((await searchIds(w, "quartzexpiry")).sort()).toEqual([expiring.id, staying.id].sort());
    w.clock.ms += 7 * 3_600_000;
    // before any rebuild: the text word finds only the row whose text stands, the title word still finds the expired one
    expect(indexHoldsWord(w, "quartzexpiry")).toBe(true);
    expect(await searchIds(w, "quartzexpiry")).toEqual([staying.id]);
    expect(await searchIds(w, "gadgettitle")).toEqual([expiring.id]);
    // the 15-minute job leaves it for the night ...
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(manifestOf(w)!.segments.some((entry) => entry.textExpiresMin !== undefined && entry.textExpiresMin <= Math.floor(w.clock.ms / 1000))).toBe(true);
    // ... the nightly pass rebuilds the segment
    const night = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000, expiry: true });
    expect(night.expired).toBeGreaterThan(0);
    expect(await searchIds(w, "quartzexpiry")).toEqual([staying.id]);
    expect(await searchIds(w, "gadgettitle")).toEqual([expiring.id]);
    // the rebuilt segment holds no word of the expired text, but still the row's structured words and the other row's text
    expect(indexHoldsWord(w, "quartzexpiry")).toBe(true); // `staying` still has it: positive control for the proof below
    const onlyExpiring = world();
    await addSource(onlyExpiring, { source: "github", scope: GITHUB_SCOPE });
    const solo = rowOf(onlyExpiring, 1, { text: "unique quartzsolo words", structured: { title: "stays" }, textExpiresAt: expiresAt, at: onlyExpiring.clock.ms - 10 * DAY });
    seedRows(onlyExpiring, [solo]);
    await buildIndex(onlyExpiring);
    expect(indexHoldsWord(onlyExpiring, "quartzsolo")).toBe(true);
    onlyExpiring.clock.ms += 7 * 3_600_000;
    await maintainProject(depsOf(onlyExpiring), ORG_A, "web", { deadlineAt: onlyExpiring.clock.ms + 30_000, expiry: true });
    expect(indexHoldsWord(onlyExpiring, "quartzsolo")).toBe(false);
    expect(HOUR).toBe(3_600_000);
  });

  it("a row that left the hot table (archived, then removed by the TTL) leaves the index in the nightly pass, not before", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const leaving = rowOf(w, 1, { text: "an archivedword row", hotExpiresAt: Math.floor(w.clock.ms / 1000) + 86_400, at: w.clock.ms - 80 * DAY });
    seedRows(w, [leaving, ...Array.from({ length: 20 }, (_unused, i) => rowOf(w, 10 + i, { text: `filler ${String(i)}`, at: w.clock.ms - 79 * DAY + i * 60_000 }))]);
    await buildIndex(w);
    expect(indexHoldsWord(w, "archivedword")).toBe(true);
    // ten days later the table no longer has the row (the archiver and the TTL took it)
    w.clock.ms += 10 * DAY;
    const item = w.db.find((entry) => entry.id === leaving.id)[0]!;
    w.db.delete({ pk: item.pk as string, sk: item.sk as string });
    expect(await searchIds(w, "archivedword")).toEqual([]);          // the reload finds nothing: never returned
    expect(indexHoldsWord(w, "archivedword")).toBe(true);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(indexHoldsWord(w, "archivedword")).toBe(true);            // the 15-minute job leaves it for the night
    const night = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000, expiry: true });
    expect(night.expired).toBeGreaterThan(0);
    expect(indexHoldsWord(w, "archivedword")).toBe(false);
  });
});
