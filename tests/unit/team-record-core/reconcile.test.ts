// Reconciliation of the record core with the landed storage and ingest lanes (cloud/next): the real Slack tap, the real core sink, the real storage distiller and the
// real storage lake/archiver types, wired together. Each test fails without the reconciling code.
import { describe, expect, it } from "vitest";
import { recordActorSourceHash, recordScopeHash, teamRecordSourceHash, type AuditEventInput } from "@agentx/contracts";
import { createSlackRecordTap, type SlackRecordTapDependencies } from "../../../packages/broker/src/team-record/sources/slack.js";
import type { CaptureModePort, RecordSinkPort, SourceConfigPort, TransientDistillerPort, RecordDraft as IngestDraft } from "../../../packages/broker/src/team-record/sources/ports.js";
import { createRovaraEmitter } from "../../../packages/broker/src/team-record/sources/rovara.js";
import { createCaptureModePort, createRecordSink, createSourceConfigPort, NOTES_OPT_IN_FROM_SOURCE_ROW } from "../../../packages/broker/src/team-record/sink.js";
import { createTransientDistiller } from "../../../packages/broker/src/team-record/transient-distiller.js";
import { createRedistilPort } from "../../../packages/broker/src/team-record/redistil.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { tableHotArchiveSource, tableHotStatsSource, type HotStatsSource } from "../../../packages/broker/src/team-record/hot-source.js";
import { tableLakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-queue.js";
import { admitTransient } from "../../../packages/broker/src/team-record/ingest.js";
import { buildLakeDeletes, type LakeDeleteQueue } from "../../../packages/broker/src/team-record/lake-delete.js";
import { runArchive, type HotArchiveSource } from "../../../packages/broker/src/team-record/archiver.js";
import { putDerivationLinks, putRecordFact } from "../../../packages/broker/src/team-record/store.js";
import type { HotStatsSource as StorageHotStats } from "../../../packages/broker/src/team-record/stats-templates.js";
import { FakeActors } from "../../support/team-record-ingest-fakes.js";
import { ORG_A, addSource, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const TEAM = "T0TEAM00001";
const CH = "C0123456789";
const USER = "U0ALICE0001";
const TS = "1758657600.000200";
const SCOPE = `slack:${TEAM}/${CH}`;

// Compile-time reconciliation: the core's objects ARE the ports the lanes declare (tsc fails here if a shape drifts).
export function typeChecks(w: World): void {
  const sink: RecordSinkPort = createRecordSink(w.deps);
  const config: SourceConfigPort = createSourceConfigPort(w.deps);
  const mode: CaptureModePort = createCaptureModePort(w.deps);
  const queue: LakeDeleteQueue = tableLakeDeleteQueue(w.table);
  const archive: HotArchiveSource = tableHotArchiveSource(w.table, { async projects() { return []; } }, queue);
  const stats: StorageHotStats = tableHotStatsSource(w.table);
  const stats2: HotStatsSource = stats;
  void [sink, config, mode, archive, stats2];
}

function publicSlack() {
  const w = world({ edition: "public", rovaraDefaultRetention: "D" });
  const actors = new FakeActors();
  actors.members.set(USER, "dev-alice");
  const calls: string[] = [];
  const model = async () => JSON.stringify({ facts: [{ kind: "decision", text: "The team pins the base image.", links: [] }] });
  let n = 0;
  const distiller = createTransientDistiller({
    ingest: w.deps,
    distill: { model, now: () => new Date(w.clock.ms).toISOString(), newId: () => `5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a${String(++n).padStart(4, "0")}` },
  });
  const guarded: TransientDistillerPort = { distillTransient: async (draft) => { calls.push(draft.sourceRef.id); return distiller.distillTransient(draft); } };
  const deps: SlackRecordTapDependencies = {
    edition: "public", sink: createRecordSink(w.deps), distiller: guarded, actors, mode: createCaptureModePort(w.deps), config: createSourceConfigPort(w.deps),
    resolveWorkspace: async (team) => (team === TEAM ? { workspaceId: ORG_A, project: "web" } : undefined),
    notesOptIn: NOTES_OPT_IN_FROM_SOURCE_ROW,
    directory: { channelInfo: async () => ({ kind: "public", extShared: false }) },
  };
  const tap = createSlackRecordTap(deps);
  const message = (over: Record<string, unknown> = {}) => ({ type: "event_callback", team_id: TEAM, api_app_id: "A0ROVARA001", event_id: "Ev1", event: { type: "message", channel: CH, user: USER, text: "we always pin the base image", ts: TS, ...over } });
  return { w, tap, message, calls, actors };
}

describe("W-1 Slack retention B goes through the record's checks before the distiller", () => {
  it("stores a note with its actor and place on the derivation link, item id system:sourceId, and no raw row", async () => {
    const { w, tap, message } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    expect(await tap(message())).toMatchObject({ outcome: "recorded", retention: "B", stored: false });
    expect(rows(w, "TEAM_RECORD_EVENT")).toEqual([]);
    const [fact] = rows(w, "TEAM_RECORD_FACT");
    expect(fact).toMatchObject({ text: "The team pins the base image.", trust: "member", derivedFrom: [`${TEAM}:${CH}/${TS}`], rowScopes: [SCOPE] });
    const [link] = rows(w, "TEAM_RECORD_DERIVATION");
    expect(link).toMatchObject({ actorDeveloperId: "dev-alice", actorSourceId: USER, scope: SCOPE, system: TEAM });
  });

  it("no opt-in on the source row means the tap sees live-only: nothing is distilled, whatever the tap's own flag says", async () => {
    const { w, tap, message, calls } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B" }); // refused by the edition rule at save: Public B needs the opt-in
    expect(rows(w, "TEAM_RECORD_SOURCE")).toEqual([]);
    expect(await tap(message())).toMatchObject({ outcome: "ignored" });
    expect(calls).toEqual([]);
  });

  it("a direct call to the distiller port (the queue's consumer) is refused for an erased person, an excluded person, a missing opt-in and a deleted item", async () => {
    const { w } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    const draft = (extra: Partial<IngestDraft> = {}): IngestDraft & { text: string } => ({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: "2026-10-30T10:00:00.000Z", sourceRef: { system: TEAM, id: `${CH}/${TS}`, version: "m:1" },
      actor: { sourceId: USER, developerId: "dev-alice", trust: "member" }, trust: "member", audience: { kind: "restricted", acl: { source: "slack", scope: SCOPE, groups: [TEAM], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } },
      links: [], retention: "B", text: "pin the base image", ...extra,
    });
    expect((await admitTransient(w.deps, draft())).admitted).toBe(true);
    // erased (given as the Slack tap's identity form)
    await erasePerson(deleteDeps(w).deps, ORG_A, { identities: [{ system: `slack:${TEAM}`, sourceId: USER }] }, "e1");
    expect(await admitTransient(w.deps, draft())).toEqual({ admitted: false, reason: "actor_erased" });
    // excluded
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true, exclude: ["U0OTHER0001"] });
    expect(await admitTransient(w.deps, draft({ actor: { sourceId: "U0OTHER0001", trust: "member" } }))).toEqual({ admitted: false, reason: "excluded" });
    // retention above the row's ceiling, and no row at all
    expect((await admitTransient(w.deps, draft({ retention: "B", audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T0TEAM00001/C9999999999", groups: [TEAM], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, actor: { sourceId: "U0NEW000001", trust: "member" } }))).admitted).toBe(false);
    // deleted at the source
    await w.sink.tombstone({ workspaceId: ORG_A, system: TEAM, sourceIds: [`${CH}/${TS}`], cause: "source_deleted" });
    expect(await admitTransient(w.deps, draft({ actor: { sourceId: "U0NEW000001", trust: "member" } }))).toEqual({ admitted: false, reason: "deleted_at_source" });
  });

  it("an unreadable erased marker makes the distiller port THROW (the queue redelivers) and distils nothing", async () => {
    const { w } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    let called = 0;
    const distiller = createTransientDistiller({ ingest: w.deps, distill: { model: async () => { called += 1; return "{}"; }, now: () => new Date(w.clock.ms).toISOString(), newId: () => "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001" } });
    w.db.injectFault({ command: "GetCommand", match: (input) => String((input.Key as { sk: string }).sk).startsWith("ERASED#"), error: { name: "InternalServerError" } });
    await expect(distiller.distillTransient({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: "2026-10-30T10:00:00.000Z", sourceRef: { system: TEAM, id: `${CH}/${TS}`, version: "m:1" },
      actor: { sourceId: USER, trust: "member" }, trust: "member", audience: { kind: "restricted", acl: { source: "slack", scope: SCOPE, groups: [TEAM], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, links: [], retention: "B", text: "x",
    })).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    expect(called).toBe(0);
  });

  it("a message with attachments gives a note of outsider trust (the tap sets hasAttachments)", async () => {
    const { w, tap, message } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    await tap(message({ attachments: [{ text: "forwarded words from elsewhere" }] }));
    expect(rows(w, "TEAM_RECORD_FACT")[0]).toMatchObject({ trust: "outsider" });
  });
});

describe("W-2 an erased person's next Slack message is not stored", () => {
  it("erase by the Slack tap's identity form blocks the next message (B and stored retention), and the lake gets the bare-team hash", async () => {
    const { w, tap, message } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    await tap(message());
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(1);
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-alice", identities: [{ system: `slack:${TEAM}`, sourceId: USER }] }, "e-w2");
    expect(result).toMatchObject({ facts: 1, complete: true });
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
    expect(d.lake.enqueued).toContainEqual({ kind: "actor_source", hash: recordActorSourceHash(TEAM, USER) });
    await tap(message({ ts: "1758657700.000100", event_id: "Ev2" }));
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
    expect(rows(w, "TEAM_RECORD_DERIVATION")).toHaveLength(0);
    // Enterprise stored retention through the same sink
    const ent = world({ edition: "enterprise" });
    await addSource(ent, { source: "slack", scope: SCOPE, retention: "C" });
    await erasePerson(deleteDeps(ent).deps, ORG_A, { identities: [{ system: `slack:${TEAM}`, sourceId: USER }] }, "e-w2b");
    expect(await createRecordSink(ent.deps).put({
      workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: "2026-10-30T10:00:00.000Z", sourceRef: { system: TEAM, id: `${CH}/${TS}`, version: "m:2" },
      actor: { sourceId: USER, trust: "member" }, trust: "member", audience: { kind: "restricted", acl: { source: "slack", scope: SCOPE, groups: [TEAM], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, links: [], retention: "C", text: "hi",
    })).toEqual({ status: "refused", reason: "actor_erased" });
  });
});

describe("W-3 / W-4 storage interfaces", () => {
  it("the storage archiver agrees with the core's markArchived (lost ids are counted and their vectors deleted) ", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: "github:repo/9" });
    const old = new Date(w.clock.ms - 120 * 86_400_000).toISOString();
    await w.sink.put({ workspaceId: ORG_A, project: "web", source: "github", kind: "github.review_comment", occurredAt: old, sourceRef: { system: "github.com", id: "r1", version: "1" }, actor: { sourceId: "1", trust: "member" }, trust: "member", audience: { kind: "project" }, scope: "github:repo/9", links: [], retention: "D", text: "t" });
    const source = tableHotArchiveSource(w.table, { async projects() { return ["web"]; } }, tableLakeDeleteQueue(w.table), () => w.clock.ms);
    // the row dies after the archiver's last liveness check: filterLive says live, markArchived says lost
    const racing: HotArchiveSource = { ...source, async filterLive(workspaceId, ids) { const live = await source.filterLive(workspaceId, ids); await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["r1"], cause: "source_deleted" }); return live; } };
    const executed: string[] = [];
    const lake = { now: () => w.clock.ms, execute: async (sql: string) => { executed.push(sql); }, query: async () => ({ rows: [], truncated: false }) };
    const summary = await runArchive({ source: racing, lake: lake, tableBucket: "tb", vectors: { dimension: 3, put: async () => ({ done: 0, failed: [] }), delete: async (keys: string[]) => { w.vectorDeletes.push(keys); return { done: keys.length, failed: [] }; }, query: async () => [], get: async () => [] }, lakeDeletes: tableLakeDeleteQueue(w.table) }, { workspaceId: ORG_A, budget: { maxRows: 100, maxMs: 10_000 } });
    expect(summary.archived).toBe(0);
    expect(summary.lateTombstoned).toBeGreaterThanOrEqual(1);
    expect((await tableLakeDeleteQueue(w.table).listPending(ORG_A, 10)).map((entry) => entry.target)).toContainEqual({ kind: "source", sourceHash: teamRecordSourceHash("github.com", "r1") });
  });

  it("the storage lake job builds a statement per table for the workspace target", () => {
    const statements = buildLakeDeletes("bucket", ORG_A, [{ id: "a".repeat(40), target: { kind: "workspace" } }]);
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement.sql).toMatch(/^DELETE FROM .* WHERE "workspace_id" = '/);
      expect(statement.sql).not.toContain("project");
    }
    expect(statements.map((statement) => statement.sql.match(/"(events|facts|outcomes|lessons_history)"/)?.[1]).sort()).toEqual(["events", "facts", "lessons_history", "outcomes"]);
    void recordScopeHash;
  });
});

describe("W-5 the draft fields, W-7 / W-8 distiller and re-distil", () => {
  it("a Rovara note made in Slack carries origin through the emitter, and Public keeps no text for it", async () => {
    const w = world({ edition: "public", rovaraDefaultRetention: "D" });
    const actors = new FakeActors();
    actors.members.set("dev-1", "dev-1");
    const emitter = createRovaraEmitter({ sink: createRecordSink(w.deps), actors, mode: createCaptureModePort(w.deps), config: { get: async () => ({ enabled: true, retention: "D", exclude: [], audienceDefault: "project" as const, project: "web" }) } });
    await emitter.remembered({ workspaceId: ORG_A, project: "web", taskId: "t1", visibility: { kind: "shared" }, at: "2026-10-30T10:00:00.000Z", noteId: "n1", text: "remember: layoffs are coming", actorDeveloperId: "dev-1", origin: "slack" });
    await emitter.remembered({ workspaceId: ORG_A, project: "web", taskId: "t1", visibility: { kind: "shared" }, at: "2026-10-30T10:00:00.000Z", noteId: "n2", text: "remember: use withRetry", actorDeveloperId: "dev-1" });
    const byNote = Object.fromEntries(rows(w, "TEAM_RECORD_EVENT").map((item) => [(item.sourceRef as { id: string }).id, item.text]));
    expect(byNote["task:t1:note:n1"]).toBeUndefined();
    expect(byNote["task:t1:note:n2"]).toBe("remember: use withRetry");
  });

  it("the re-distil port re-makes a note from the sources that are left (readable text only) and returns nothing when none can be read", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: "github:repo/9" });
    await w.sink.put({ workspaceId: ORG_A, project: "web", source: "github", kind: "github.review_comment", occurredAt: new Date(w.clock.ms - 86_400_000).toISOString(), sourceRef: { system: "github.com", id: "keep", version: "1" }, actor: { sourceId: "1", trust: "member" }, trust: "member", audience: { kind: "project" }, scope: "github:repo/9", links: ["https://github.com/a/b/pull/1#c"], retention: "D", text: "Use withRetry for timeouts." });
    const seen: string[] = [];
    const port = createRedistilPort({ table: w.table, now: () => w.clock.ms, distill: { model: async ({ user }) => { seen.push(user); return JSON.stringify({ facts: [{ kind: "decision", text: "Timeouts use withRetry.", links: [] }] }); }, now: () => new Date(w.clock.ms).toISOString(), newId: () => "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0009" } });
    const made = await port.redistil({ orgId: ORG_A, project: "web", remaining: [{ system: "github.com", sourceId: "keep" }, { system: "github.com", sourceId: "unreadable" }], kind: "decision", trust: "member", audience: { kind: "project" } });
    expect(made).toMatchObject({ text: "Timeouts use withRetry." });
    expect(seen[0]).toContain("github.com:keep");
    expect(seen[0]).not.toContain("unreadable");
    expect(await port.redistil({ orgId: ORG_A, project: "web", remaining: [{ system: "github.com", sourceId: "unreadable" }], kind: "decision", trust: "member", audience: { kind: "project" } })).toBeUndefined();
  });

  it("a fact stored by the distiller is found by a source delete through its link, and by the delete worker", async () => {
    const { w, tap, message } = publicSlack();
    await addSource(w, { source: "slack", scope: SCOPE, retention: "B", notesOptIn: true });
    await tap(message());
    await w.sink.tombstone({ workspaceId: ORG_A, system: TEAM, sourceIds: [`${CH}/${TS}`], cause: "source_deleted" });
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary).toMatchObject({ facts: 1, finished: 1 });
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(0);
    void putDerivationLinks; void putRecordFact; void (null as unknown as AuditEventInput);
  });
});
