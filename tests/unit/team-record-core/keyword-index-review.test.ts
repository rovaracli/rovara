// Review round of lanes K2/K3 (DECISIONS 145): the reviewer's attacks (project-less rows, the TTL window, a live segment's lost intent), the damaged-segment repair, the limits of a build and a search, the kill switch, and the tests
// the surviving mutations asked for (the job-level overdue line, the gate and retired segments, the tail bound, the tombstone in a rebuild, the late-marker bound).
import { describe, expect, it } from "vitest";
import { RecordEventSchema } from "@agentx/cloud-contracts";
import { teamRecordPk } from "@rovara-code/contracts";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { purgeItems } from "../../../packages/broker/src/team-record/purge.js";
import { recordSearch, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import { KEYWORD_LATE_MS } from "../../../packages/broker/src/team-record/keyword-late.js";
import { LATE_MAX, SAME_INSTANT_MAX_ROWS, SEARCH_INDEX_MAX_BYTES, SEGMENT_BYTES, SEGMENT_DOCS, TAIL_MAX_ROWS, maintainProject, markKeywordIndexRemoved, openKeywordIndex, passDeadline, removalGate, replaceSegments, runKeywordIndexJob, type BuildContext } from "../../../packages/broker/src/team-record/keyword-index.js";
import { deterministicEventId, eventItem, tombstoneItem } from "../../../packages/broker/src/team-record/store.js";
import type { TeamRecordTable } from "../../../packages/broker/src/team-record/types.js";
import { GITHUB_SCOPE, ORG_A, addSource, caller, githubDraft, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { DAY, HOUR, buildIndex, depsOf, indexHoldsWord, manifestOf, rowOf, seedRows } from "../../support/keyword-index.js";

const NOW = (w: World): number => Math.floor(w.clock.ms / 1000);
const searchDeps = (w: World, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, log: (event, fields) => { w.logs.push({ event, fields: { ...fields } }); }, ...extra });
const ids = async (w: World, query: string): Promise<string[]> => (await recordSearch(searchDeps(w), { kind: "caller", caller: caller() }, "web", { query, limit: 10 })).hits.map((hit) => hit.id);
const logged = (w: World, event: string): boolean => w.logs.some((entry) => entry.event === event);
const conflict = (): Error => Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });

/** The table, refusing every conditional write of the manifest (a perpetual lost race) when `on.refuse` is set. */
function refusingManifest(w: World): { table: TeamRecordTable; on: { refuse: boolean } } {
  const on = { refuse: true };
  const real = w.table.documentClient;
  return { on, table: { ...w.table, documentClient: { send: async (command: unknown) => {
    const input = (command as { input?: { Item?: { sk?: string }; ConditionExpression?: string } }).input;
    if (on.refuse && (command as { constructor: { name: string } }).constructor.name === "PutCommand" && input?.Item?.sk === "KWIDX#M" && input.ConditionExpression === "#version = :expected") throw conflict();
    return real.send(command);
  } } } };
}

const projectless = (w: World, id: string, text: string, at: number) => RecordEventSchema.parse({
  id: deterministicEventId(ORG_A, "github", "github.com", id, "1"), workspaceId: ORG_A, source: "github", sourceRef: { system: "github.com", id, version: "1" }, scope: GITHUB_SCOPE,
  kind: "github.review_comment", occurredAt: new Date(at).toISOString(), actor: { sourceId: "900", developerId: "dev-filler", trust: "member" }, trust: "member", audience: { kind: "project" }, text, links: [], retention: "D",
  hotExpiresAt: Math.floor((at + 90 * DAY) / 1000), indexExpiresAt: Math.floor((at + 120 * DAY) / 1000),
});

describe("review: a row with no project", () => {
  it("is ready at once (no index covers the company's own partition): source removal and person erase can finish", async () => {
    const w = world();
    const item = eventItem(projectless(w, "nop-1", "no project row zzprojectless", w.clock.ms - 3 * DAY));
    w.db.set(item);
    await tombstoneItem(w.table, { pk: item.pk as string, sk: item.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
    expect(item.pk).toBe(teamRecordPk(ORG_A));
    const stored = w.db.get({ pk: item.pk as string, sk: item.sk as string })!;
    const purged = await purgeItems(deleteDeps(w).deps, ORG_A, [stored]);
    expect(purged).toMatchObject({ rows: 1, blocked: 0 });
    expect(purged.indexWaiting).toBeUndefined();
    expect(w.db.get({ pk: item.pk as string, sk: item.sk as string })).toBeUndefined();
  });

  it("a mixed batch: the project-less row goes, the project's row waits for its segment", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "inproject zzmixedword", at: w.clock.ms - 3 * DAY })]);
    await buildIndex(w);
    const none = eventItem(projectless(w, "nop-2", "no project", w.clock.ms - 3 * DAY));
    w.db.set(none);
    const inProject = w.db.find((entry) => entry.entityType === "TEAM_RECORD_EVENT" && entry.project === "web")[0]!;
    const gate = await removalGate(depsOf(w), ORG_A, [none, inProject], { budgetMs: 30_000 });
    expect([...gate.ready].sort()).toEqual([`${none.pk as string}|${none.sk as string}`, `${inProject.pk as string}|${inProject.sk as string}`].sort());
    expect(indexHoldsWord(w, "zzmixedword")).toBe(false);
  });
});

describe("review: the TTL window and archived rows", () => {
  it("a row the TTL removed (hot + 7.5 days) has no words in the index (they went the night after its hot expiry)", async () => {
    const w = world();
    const at = w.clock.ms - 3 * DAY;
    const hot = NOW(w) + DAY / 1000;
    seedRows(w, [rowOf(w, 1, { text: "gone row zzttlgone", at, hotExpiresAt: hot }), rowOf(w, 2, { text: "kept row", at: at + 60_000 })]);
    await buildIndex(w);
    expect(indexHoldsWord(w, "zzttlgone")).toBe(true);
    // one day after the hot expiry the nightly pass (after the archiver) has run: the words are out, six days before the TTL
    w.clock.ms = hot * 1000 + DAY;
    await buildIndex(w, "web", ORG_A, { expiry: true });
    expect(indexHoldsWord(w, "zzttlgone")).toBe(false);
    // and a row that is already gone from the table at hot + 7.5 days changes nothing
    w.clock.ms = hot * 1000 + 7.5 * DAY;
    const gone = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && typeof item.text === "string" && item.text.includes("zzttlgone"))[0]!;
    w.db.delete({ pk: gone.pk as string, sk: gone.sk as string });
    await buildIndex(w, "web", ORG_A, { expiry: true });
    expect(indexHoldsWord(w, "zzttlgone")).toBe(false);
  });

  it("an archived row (archivedAt) is rebuilt out the same night, and never put back", async () => {
    const w = world();
    const at = w.clock.ms - 3 * DAY;
    const hot = NOW(w) + 3_600;
    seedRows(w, [rowOf(w, 1, { text: "archived zzarchword", at, hotExpiresAt: hot }), rowOf(w, 2, { text: "other", at: at + 60_000 })]);
    await buildIndex(w);
    expect(indexHoldsWord(w, "zzarchword")).toBe(true);
    w.clock.ms += 2 * HOUR;                                           // past the hot expiry; the archiver marks the row that night
    const item = w.db.find((entry) => entry.entityType === "TEAM_RECORD_EVENT" && typeof entry.text === "string" && entry.text.includes("zzarchword"))[0]!;
    w.db.set({ ...item, archivedAt: new Date(w.clock.ms).toISOString() });
    const quiet = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000 });
    expect(quiet.expired).toBe(0);                                    // the 15-minute job leaves it for the night
    const night = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000, expiry: true });
    expect(night.expired).toBe(1);
    expect(indexHoldsWord(w, "zzarchword")).toBe(false);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 30_000, expiry: true });
    expect(indexHoldsWord(w, "zzarchword")).toBe(false);
  });
});

describe("review: a segment the manifest lists is never taken for an orphan, and a damaged one is rebuilt", () => {
  it("a live segment's build intent that outlived its switch: only the intent is deleted, the chunks stay and the index keeps working", async () => {
    const w = world();
    seedRows(w, Array.from({ length: 20 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} zzlive${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    await buildIndex(w);
    const live = manifestOf(w)!.segments[0]!;
    w.db.set({ pk: teamRecordPk(ORG_A, "web"), sk: `KWIDX#B#${live.id}`, entityType: "TEAM_RECORD_KWIDX_BUILD", segment: live.id, at: new Date(w.clock.ms).toISOString() });
    w.clock.ms += 5 * 60_000;
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#B#"))).toEqual([]);
    expect(w.db.find((item) => String(item.sk).startsWith(`KWIDX#S#${live.id}#`))).toHaveLength(live.chunks);
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeDefined();
    expect(indexHoldsWord(w, "zzlive3")).toBe(true);
  });

  it("a search that finds a chunk missing falls back to the window, marks the segment dirty, and the next pass rebuilds it", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 20 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} zzdamaged${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    await buildIndex(w);
    const seg = manifestOf(w)!.segments[0]!;
    w.db.delete({ pk: teamRecordPk(ORG_A, "web"), sk: `KWIDX#S#${seg.id}#00000` });
    const hits = await ids(w, "zzdamaged3");
    expect(hits).toHaveLength(1);                                     // the window answered
    expect(logged(w, "record.keyword_index_damaged")).toBe(true);
    expect(logged(w, "record.keyword_index")).toBe(false);
    expect(manifestOf(w)!.segments[0]!.dirty).toMatchObject({ reason: "damaged" });
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(manifestOf(w)!.segments.every((entry) => entry.dirty === undefined)).toBe(true);
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeDefined();
    expect(await ids(w, "zzdamaged3")).toHaveLength(1);
    expect(logged(w, "record.keyword_index")).toBe(true);
  });
});

describe("review: the limits of a build and a search", () => {
  it("a build stops at SEGMENT_BYTES of text, not only at SEGMENT_DOCS rows, and a merge does not put the pieces back together", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const filler = "billing retry queue consumer ".repeat(280); // about 8,000 characters
    const count = Math.ceil((SEGMENT_BYTES * 1.6) / 8_400);
    expect(count).toBeLessThan(SEGMENT_DOCS);
    seedRows(w, Array.from({ length: count }, (_unused, i) => rowOf(w, i, { text: `${filler} marker${String(i)}`, at: w.clock.ms - 4 * DAY + i * 1_000 })));
    await buildIndex(w, "web", ORG_A, { rounds: 12 });
    const manifest = manifestOf(w)!;
    expect(manifest.coverage).toBe("complete");
    expect(manifest.segments.length).toBeGreaterThanOrEqual(2);
    expect(manifest.segments.reduce((sum, entry) => sum + entry.docs, 0)).toBe(count);
    expect(Math.max(...manifest.segments.map((entry) => entry.srcBytes ?? 0))).toBeLessThan(SEGMENT_BYTES + 300 * 8_400);
    // a pass that has nothing to do really has nothing: no merge undoes the byte cut
    const again = await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(again).toMatchObject({ merged: 0, sealed: 0, rebuilt: 0 });
  }, 300_000);

  it("more rows at one instant than SAME_INSTANT_MAX_ROWS cannot be cut into segments: the pass fails closed and the project is searched by the window", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const at = w.clock.ms - 3 * DAY;
    seedRows(w, Array.from({ length: SAME_INSTANT_MAX_ROWS + 300 }, (_unused, i) => rowOf(w, i, { text: `dense ${String(i)}`, at })));
    await expect(maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 120_000 })).rejects.toThrow("too many rows at one instant");
    expect(manifestOf(w)!.coverage).toBe("building");
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#S#"))).toEqual([]);
    expect((await ids(w, "dense")).length).toBeGreaterThan(0);
    expect(logged(w, "record.keyword_index")).toBe(false);
  }, 300_000);

  it("rows between SEGMENT_DOCS and the cap at one instant are read to the end of the instant, whole", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const at = w.clock.ms - 3 * DAY;
    seedRows(w, Array.from({ length: SEGMENT_DOCS + 200 }, (_unused, i) => rowOf(w, i, { text: `same instant ${String(i)}`, at })));
    await buildIndex(w);
    expect(manifestOf(w)!.segments.reduce((sum, entry) => sum + entry.docs, 0)).toBe(SEGMENT_DOCS + 200);
  }, 300_000);

  it("a search opens no index whose segments are over SEARCH_INDEX_MAX_BYTES together: the window answers", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, Array.from({ length: 30 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)} zzcapword`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    await buildIndex(w);
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeDefined();
    const item = w.db.get({ pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#M" })!;
    const segments = (item.segments as Array<{ bytes: number }>).map((entry, at) => (at === 0 ? { ...entry, bytes: SEARCH_INDEX_MAX_BYTES + 1 } : entry));
    w.db.set({ ...item, segments });
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeUndefined();
    expect(logged(w, "record.keyword_index_too_large")).toBe(true);
    expect((await ids(w, "zzcapword")).length).toBeGreaterThan(0);
  });

  it("a rebuild whose time is up before its first piece writes nothing", async () => {
    const w = world();
    seedRows(w, Array.from({ length: 10 }, (_unused, i) => rowOf(w, i, { text: `row ${String(i)}`, at: w.clock.ms - 3 * DAY + i * 60_000 })));
    await buildIndex(w);
    const manifest = manifestOf(w)!;
    const ctx: BuildContext = { ...depsOf(w), orgId: ORG_A, project: "web", deadlineAt: w.clock.ms - 1 };
    const chunks = w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length;
    expect(await replaceSegments(ctx, manifest, 0, 0)).toEqual({ status: "deadline" });
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#S#")).length).toBe(chunks);
    expect(w.db.find((item) => String(item.sk).startsWith("KWIDX#B#"))).toEqual([]);
  });

  it("a project's pass never runs past its share of the run, and never past the run's end", () => {
    expect(passDeadline(1_000, 1_000, 6_000, 3)).toBe(3_000);          // 6 s, three to serve: 2 s each
    expect(passDeadline(5_000, 1_000, 6_000, 1)).toBe(7_000);          // the last one has all that is left
    expect(passDeadline(6_900, 1_000, 6_000, 2)).toBe(6_950);      // 100 ms left, two to serve: 50 ms, not a fixed 2 s
    expect(passDeadline(8_000, 1_000, 6_000, 1)).toBeLessThanOrEqual(8_000);
  });
});

describe("review: the kill switch and the gate", () => {
  it("with the index off the maintenance builds nothing, but still rebuilds what a removal marked, and a project with no index gets none", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "first zzoffalpha", at: w.clock.ms - 3 * DAY }), rowOf(w, 2, { text: "second zzoffbravo", at: w.clock.ms - 3 * DAY + 60_000 })]);
    await buildIndex(w);
    // nothing built while off: a new project gets no manifest, new old rows are not sealed or folded
    const off = (): { deadlineAt: number; build: false } => ({ deadlineAt: w.clock.ms + 60_000, build: false });
    expect(await maintainProject(depsOf(w), ORG_A, "api", off())).toMatchObject({ sealed: 0, rebuilt: 0 });
    expect(manifestOf(w, ORG_A, "api")).toBeUndefined();
    const before = manifestOf(w)!.segments.map((entry) => entry.id);
    seedRows(w, [rowOf(w, 3, { text: "third zzoffcharlie", at: w.clock.ms - 2 * DAY })]);
    w.clock.ms += 3 * DAY;
    expect(await maintainProject(depsOf(w), ORG_A, "web", off())).toMatchObject({ sealed: 0, merged: 0, rebuilt: 0 });
    expect(manifestOf(w)!.segments.map((entry) => entry.id)).toEqual(before);
    expect(indexHoldsWord(w, "zzoffcharlie")).toBe(false);
    // a removal's mark is still rebuilt, and the gate still runs
    const victim = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && typeof item.text === "string" && item.text.includes("zzoffalpha"))[0]!;
    await tombstoneItem(w.table, { pk: victim.pk as string, sk: victim.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
    await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [(victim.sk as string).split("#")[1]!]);
    expect(await maintainProject(depsOf(w), ORG_A, "web", off())).toMatchObject({ rebuilt: 1, sealed: 0 });
    expect(indexHoldsWord(w, "zzoffalpha")).toBe(false);
    expect(indexHoldsWord(w, "zzoffbravo")).toBe(true);
  });

  it("the gate counts and logs a failure instead of swallowing it, and the delete worker reports it", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const out = await (async () => {
      await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "g-1", version: "1" }, links: [], text: "gate failure zzgatefail", audience: { kind: "project" }, scope: GITHUB_SCOPE }));
      await buildIndex(w);
      await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["g-1"], cause: "source_deleted" });
      const real = w.table.documentClient;
      const broken: TeamRecordTable = { ...w.table, documentClient: { send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === "PutCommand" && String((command as { input?: { Item?: { sk?: string } } }).input?.Item?.sk).startsWith("KWIDX#S#")) throw Object.assign(new Error("down"), { name: "ServiceUnavailable" });
        return real.send(command);
      } } };
      const d = deleteDeps(w, { table: broken });
      return { summary: await runDeleteWorker(d.deps, ORG_A), logs: d.logs };
    })();
    expect(out.summary).toMatchObject({ indexGateFailed: 1, indexWaiting: 1, blocked: 1 });
    expect(logged(w, "record.keyword_index_gate_failed") || out.logs.includes("record.keyword_index_gate_failed")).toBe(true);
  });
});

describe("review: gaps the mutations found", () => {
  it("the job reports and logs a segment that has waited over an hour for its rebuild (record.keyword_index_overdue)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "overdue zzoverdue", at: w.clock.ms - 3 * DAY })]);
    await buildIndex(w);
    const victim = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT")[0]!;
    await tombstoneItem(w.table, { pk: victim.pk as string, sk: victim.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
    await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [(victim.sk as string).split("#")[1]!]);
    w.clock.ms += 2 * HOUR;
    const refusing = refusingManifest(w);
    const lines: string[] = [];
    const summary = await runKeywordIndexJob({ ...depsOf(w), table: refusing.table, log: (event) => { lines.push(event); }, orgs: async () => [ORG_A], projects: async () => ["web"] }, w.clock.ms, 20_000);
    expect(summary.overdue).toBe(1);
    expect(lines).toContain("record.keyword_index_overdue");
    // a young mark is not overdue
    refusing.on.refuse = false;
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    const quiet: string[] = [];
    const fine = await runKeywordIndexJob({ ...depsOf(w), log: (event) => { quiet.push(event); }, orgs: async () => [ORG_A], projects: async () => ["web"] }, w.clock.ms, 20_000);
    expect(fine.overdue).toBe(0);
    expect(quiet).not.toContain("record.keyword_index_overdue");
  });

  it("the gate does not let a row go while a retired segment is still listed, even when the manifest could not be cleaned", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "retired zzretired", at: w.clock.ms - 3 * DAY }), rowOf(w, 2, { text: "other", at: w.clock.ms - 3 * DAY + 60_000 })]);
    await buildIndex(w);
    const manifestItem = w.db.get({ pk: teamRecordPk(ORG_A, "web"), sk: "KWIDX#M" })!;
    w.db.set({ ...manifestItem, retired: ["deadbeef0001"] });
    const row = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && typeof item.text === "string" && item.text.includes("zzretired"))[0]!;
    const real = w.table.documentClient;
    // the clean-up of the manifest's retired list always loses its race (the conditional update fails and is shrugged off)
    const stuck: TeamRecordTable = { ...w.table, documentClient: { send: async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "UpdateCommand" && String((command as { input?: { UpdateExpression?: string } }).input?.UpdateExpression).includes("retired")) throw conflict();
      return real.send(command);
    } } };
    const blocked = await removalGate({ ...depsOf(w), table: stuck }, ORG_A, [row], { budgetMs: 30_000 });
    expect(blocked.ready.size).toBe(0);
    expect(blocked.waiting).toBe(1);
    const free = await removalGate(depsOf(w), ORG_A, [row], { budgetMs: 30_000 });
    expect(free.ready.size).toBe(1);
  });

  it("a tail longer than TAIL_MAX_ROWS is not searched through the index: the window answers", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "old zztailword", at: w.clock.ms - 3 * DAY })]);
    await buildIndex(w);
    seedRows(w, Array.from({ length: TAIL_MAX_ROWS + 100 }, (_unused, i) => rowOf(w, 100 + i, { text: `young row ${String(i)}`, at: w.clock.ms - HOUR + i * 1_000 })));
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeUndefined();
    expect((await ids(w, "young")).length).toBeGreaterThan(0);        // the newest rows are what the window reads
    expect(logged(w, "record.keyword_index")).toBe(false);
  }, 120_000);

  it("more than LATE_MAX unfolded late markers: the window answers", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "old zzlateword", at: w.clock.ms - 3 * DAY })]);
    await buildIndex(w);
    for (let i = 0; i < LATE_MAX + 1; i += 1) {
      const at = new Date(w.clock.ms - 3 * DAY + i * 1_000).toISOString();
      w.db.set({ pk: teamRecordPk(ORG_A, "web"), sk: `KWLATE#${at}#${deterministicEventId(ORG_A, "github", "github.com", `m-${String(i)}`, "1")}`, entityType: "TEAM_RECORD_KWLATE" });
    }
    expect(await openKeywordIndex(depsOf(w), ORG_A, "web", NOW(w))).toBeUndefined();
    expect((await ids(w, "zzlateword")).length).toBe(1);
    expect(KEYWORD_LATE_MS).toBe(2 * HOUR);
  });

  it("a rebuild leaves out a tombstoned row even when its words are in its structured fields (a tombstone removes the text, not the fields)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    seedRows(w, [rowOf(w, 1, { text: "plain", structured: { title: "zzstructword" }, at: w.clock.ms - 3 * DAY }), rowOf(w, 2, { text: "other row", at: w.clock.ms - 3 * DAY + 60_000 })]);
    await buildIndex(w);
    expect(indexHoldsWord(w, "zzstructword")).toBe(true);
    const victim = w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT" && (item.structured as { title?: string } | undefined)?.title === "zzstructword")[0]!;
    await tombstoneItem(w.table, { pk: victim.pk as string, sk: victim.sk as string }, { at: new Date(w.clock.ms).toISOString(), cause: "source_deleted" });
    expect((w.db.get({ pk: victim.pk as string, sk: victim.sk as string }) as { structured?: unknown }).structured).toBeDefined();
    await markKeywordIndexRemoved(depsOf(w), ORG_A, "web", [(victim.sk as string).split("#")[1]!]);
    await maintainProject(depsOf(w), ORG_A, "web", { deadlineAt: w.clock.ms + 60_000 });
    expect(indexHoldsWord(w, "zzstructword")).toBe(false);
  });
});
