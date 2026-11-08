// Fix round 11 (Opus final check): erasure walks the inventory, never code paths that happen to know. Each probe of the final review is a test, and the last one is the invariant:
// an erase that reports complete leaves no trace of the id, hot or in the lake, and no lesson derived from the person.
import { recordDeveloperHash } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { createAccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import { applyMemberEvents } from "../../../packages/broker/src/team-record/access.js";
import { toLakeEventRow } from "../../../packages/broker/src/team-record/archiver.js";
import { ERASE_SWEEP_DELAY_MS, erasePerson, runErasureSweeps } from "../../../packages/broker/src/team-record/erase.js";
import { admitTransient } from "../../../packages/broker/src/team-record/ingest.js";
import { ORG_A, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { readVisible } from "../../../packages/broker/src/lessons/read-visible.js";
import { allSharedTasks, lessonRecord } from "../lessons/lesson-helpers.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const acl = (scope: string, principals: string[], capturedAt = T1, source = "slack") => ({ kind: "restricted" as const, acl: { source, scope, principals, capturedAt, liveCheck: "none" as const } });
const slackRow = (id: string, scope: string, principals: string[], actor = "U-poster", at = T1) => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: at, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, principals, at), actor: { sourceId: actor, trust: "member" }, text: "layoff plan", links: [] });
const jiraRow = (id: string, principals: string[], extra: Record<string, unknown> = {}) => githubDraft({
  source: "jira", kind: "ticket.created", repo: undefined, sourceRef: { system: "jira.example", id, version: "1" }, audience: acl("jira:project/KEY", principals, T1, "jira") as never,
  scope: "jira:project/KEY", actor: { sourceId: "u-author", trust: "member" }, trust: "member", text: `Billing ${id}`, links: [], ...extra,
});
const everything = (w: World): string => JSON.stringify(w.db.find(() => true));
/** The erase's own second pass, due after its delay: until it has run the erase is complete but not final (the schedule holds the ids). */
const sweep = async (w: World, d: ReturnType<typeof deleteDeps>): Promise<void> => { w.clock.ms += ERASE_SWEEP_DELAY_MS + 1; await runErasureSweeps(d.deps, ORG_A, w.clock.ms); };

describe("F1 lessons from an erased person are hard-deleted, code citations or not", () => {
  it("the learning lane's erase runs per project, before the rows go, and the source-delete rule does not run over the same rows", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C9" });
    await w.sink.put(slackRow("m-x", "slack:T1/C9", ["UE", "U1"], "UE"));
    const rowId = String(rows(w, "TEAM_RECORD_EVENT")[0]?.id);
    const d = deleteDeps(w);
    d.lessons.list.push(
      { id: "les_code", version: 1, status: "active", citations: [{ kind: "code", repo: "api", path: "src/a.ts", commit: "a".repeat(40), lines: [1, 2] } as never], provenance: { sourceEvents: [rowId] }, counters: { citationStale: 0 }, lastValidatedAt: T1 },
      { id: "les_plain", version: 1, status: "active", citations: [], provenance: { sourceEvents: [rowId] }, counters: { citationStale: 0 } },
    );
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-ue", identities: [{ system: "slack:T1", sourceId: "UE" }], projects: ["web"] }, "e9");
    expect(result.complete).toBe(true);
    expect(d.lessons.erased).toEqual([{ project: "web", developerId: "dev-ue", purged: ["les_code", "les_plain"] }]);
    expect(d.lessons.withdrawn).toEqual([]); // not the soft withdrawal of a source delete
    expect(d.lessons.trimmed).toEqual([]);
    expect(d.lessons.list).toEqual([]);
  });
});

describe("F2 an actor id in a structured field is never stored", () => {
  it("a ticket's updater (structured.updatedBy) is not on the row, so erasing the updater finds nothing of them", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/KEY" });
    await w.sink.put(jiraRow("KEY-1", ["u-author", "u-x"], { structured: { state: "open", updatedBy: "u-x", revertedBy: "u-x" } }));
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT")[0]?.structured)).toBe('{"state":"open"}');
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "jira.example", sourceId: "u-x" }], projects: ["web"] }, "e6");
    expect(result.complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain("u-x");
  });
});

describe("F3 the lake keeps no list of people", () => {
  it("an archived restricted row carries its scope and groups but no principals, and no actor id in structured_json", () => {
    const event = { id: "a", workspaceId: ORG_A, occurredAt: T1, source: "jira", sourceRef: { system: "j", id: "K-1", version: "1" }, kind: "ticket.created", trust: "member", retention: "D", links: [], scope: "jira:project/KEY",
      audience: acl("jira:project/KEY", ["u-x", "u-y"], T1, "jira"), structured: { state: "open", updatedBy: "u-x" } };
    const lake = toLakeEventRow(event as never, T2);
    expect(JSON.stringify(lake)).not.toContain("u-x");
    expect(JSON.stringify(lake)).not.toContain("u-y");
    expect(JSON.parse(lake.acl_json as string)).toMatchObject({ scope: "jira:project/KEY", source: "jira" });
  });
});

describe("F4 a place is found even when the person's join event was lost", () => {
  it("a principal in a row snapshot of an events-fed unit is indexed, so the erase visits the place", async () => {
    const w = world();
    const SC = "slack:T1/C7";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U1", "U2"]));
    await applyMemberEvents(w.table, ORG_A, { scope: SC, remove: ["U2"], at: T2 }); // the unit is fed by events now
    await w.sink.put(slackRow("m2", SC, ["U1", "UX"], "U1", T3)); // UX's join event was lost; the snapshot names UX
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).toContain("UX");
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "UX" }], projects: ["web"] }, "e7");
    expect(result.complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain("UX");
  });
});

describe("F5 the lessons step is done only when it covered every project", () => {
  it("with no projects passed and no project list, it is not done; with a list it is, and every project is covered", async () => {
    const w = world();
    const SC = "slack:T1/C8";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U1", "USILENT"]));
    const d = deleteDeps(w, { projects: undefined });
    const open = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "USILENT" }] }, "e8");
    expect(open).toMatchObject({ complete: false, steps: { lessons: false } });
    const listed = deleteDeps(w, { projects: { projects: async () => ["web", "api"] } });
    const done = await erasePerson(listed.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "USILENT" }] }, "e8");
    expect(done).toMatchObject({ complete: true, steps: { lessons: true } });
    expect(listed.lessons.audienceScrubs.map((entry) => entry.project).sort()).toEqual(["api", "web"]);
  });
});

describe("F6 place-scoped tracker data is never created, and never read as a limited list", () => {
  it("a retention-B Jira draft is admitted with the item's unit, not the place", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/KEY", retention: "B" });
    const out = await admitTransient(w.deps, { ...jiraRow("KEY-9", ["P1"]), retention: "B" } as never);
    expect((out as { admitted?: boolean }).admitted).toBe(true);
    expect((out as { item: { audience: { acl: { scope: string } } } }).item.audience.acl.scope).toMatch(/^jira:project\/KEY\/item:/u);
  });

  it("a place-scoped tracker lesson is denied even to a person its frozen list names", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/KEY" });
    await w.sink.put(jiraRow("KEY-1", ["PA", "PB"]));
    const access = createAccessCheckPort(w.table, { taskVisibility: allSharedTasks });
    const base = lessonRecord({ id: "les_legacy01", workspaceId: ORG_A });
    const legacy = { ...base, provenance: { ...base.provenance, audience: acl("jira:project/KEY", ["PA", "PB"], T1, "jira") } } as never;
    const seen = async (id: string) => (await readVisible({ access, key: { workspaceId: ORG_A, project: "web" }, viewer: { principals: [id], groups: [] }, lessons: [legacy], where: "test" })).map((l) => l.id);
    expect(await seen("PA")).toEqual([]);
    expect(await seen("PB")).toEqual([]);
  });
});

describe("the invariant: a complete erase leaves nothing of the person, hot or in the lake", () => {
  it("scans the table, the lake rows of everyone else, and the lessons", async () => {
    const w = world();
    const ID = "U-erase-me-9";
    await addSource(w, { source: "slack", scope: "slack:T1/CPOSTED" });
    await addSource(w, { source: "slack", scope: "slack:T1/CSILENT" });
    await addSource(w, { source: "jira", scope: "jira:project/KEY" });
    await w.sink.put(slackRow("a", "slack:T1/CPOSTED", [ID, "U-poster"], ID));
    await w.sink.put(slackRow("b", "slack:T1/CPOSTED", [ID, "U-poster"]));
    await w.sink.put(slackRow("c", "slack:T1/CSILENT", [ID, "U-poster"]));
    await w.sink.put(jiraRow("KEY-1", ["u-author", ID], { structured: { updatedBy: ID } }));
    // the lake as the archiver would have written it, for every hot row, before the erase
    const lakeBefore = rows(w, "TEAM_RECORD_EVENT").map((row) => toLakeEventRow(row as never, T3));
    const d = deleteDeps(w);
    const rowIds = rows(w, "TEAM_RECORD_EVENT").filter((row) => (row.actor as { sourceId?: string } | undefined)?.sourceId === ID).map((row) => String(row.id));
    d.lessons.list.push({ id: "les_from_person", version: 1, status: "active", citations: [], provenance: { sourceEvents: rowIds }, counters: { citationStale: 0 } });
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-erase", identities: [{ system: "slack:T1", sourceId: ID }, { system: "jira.example", sourceId: ID }], projects: ["web"] }, "final");
    expect(result.complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain(ID); // hot
    for (const row of lakeBefore.filter((lake) => lake.actor_source_hash !== null && !String(lake.id).includes("zzz"))) {
      // no lake row names the person in its list of people or its structured fields; the actor columns are erased by the queued lake targets
      expect(String(row.acl_json)).not.toContain(ID);
      expect(String(row.structured_json)).not.toContain(ID);
    }
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "actor", developerId: recordDeveloperHash("dev-erase") }]));
    expect(d.lessons.list.map((lesson) => lesson.id)).toEqual([]); // nothing derived from them remains
  });
});
