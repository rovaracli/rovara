// Fix round 12 (Opus final check 2): an erased person is never written back (N1), a cleared place keeps the index an erase needs (N2), the settings step covers every project (N3),
// mentions of the person leave other people's words (N4), the erase schedules its own second pass (the race), and the developer id is hashed in the marker and the lake queue (G3).
import { describe, expect, it } from "vitest";
import { recordAccessPersonKey, recordDeveloperHash } from "@agentx/cloud-contracts";
import { applyAudienceEvent } from "../../../packages/broker/src/team-record/access.js";
import { toLakeEventRow } from "../../../packages/broker/src/team-record/archiver.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { ERASE_SWEEP_DELAY_MS, erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ERASED_DEVELOPER_ID } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, addSource, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const acl = (scope: string, principals: string[], capturedAt = T1) => ({ kind: "restricted" as const, acl: { source: "slack", scope, principals, capturedAt, liveCheck: "none" as const } });
const slackRow = (id: string, scope: string, principals: string[], actor = "U-poster", at = T1, text = "layoff plan") => githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: at, sourceRef: { system: "T1", id, version: "1" }, audience: acl(scope, principals, at), actor: { sourceId: actor, trust: "member" }, text, links: [] });
const everything = (w: World): string => JSON.stringify(w.db.find(() => true));
const sweep = async (w: World, d: ReturnType<typeof deleteDeps>): Promise<void> => { w.clock.ms += ERASE_SWEEP_DELAY_MS + 1; await runDeleteWorker(d.deps, ORG_A); };
const erase = (d: ReturnType<typeof deleteDeps>, id: string, extra: Record<string, unknown> = {}, occurrence = "r12") => erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: id }], projects: ["web"], ...extra }, occurrence);

describe("N1 an erased person is never written back through a row snapshot", () => {
  it("a new row by someone else whose list still names them is stored without their id (stored and transient paths, and an audience event)", async () => {
    const w = world();
    const SC = "slack:T1/C15";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U1", "UX"]));
    const d = deleteDeps(w);
    expect((await erase(d, "UX")).complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain("UX");
    expect(await w.sink.put(slackRow("m2", SC, ["U1", "UX"], "U1", T2))).toMatchObject({ status: "stored" });
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).not.toContain("UX"); // the new row: stored without the id
    await w.sink.replaceScopeAudience({ workspaceId: ORG_A, scope: SC, audience: acl(SC, ["U1", "UX"], T3), at: T3 });
    expect(everything(w)).not.toContain("UX");
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT").map((r) => (r.audience as { acl: { principals: string[] } }).acl.principals))).toBe('[["U1"],["U1"]]');
  });
});

describe("N2 a cleared place keeps the index an erase needs", () => {
  it("rows stored before an unreadable-list conversion still name the person; the erase visits the place and removes them", async () => {
    const w = world();
    const SC = "slack:T1/C11";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U1", "UX"]));
    await applyAudienceEvent(w.table, ORG_A, { scope: SC, audience: acl(SC, [], T2), at: T2 }); // the list could not be read: the unit is cleared
    expect(JSON.stringify(rows(w, "TEAM_RECORD_EVENT"))).toContain("UX");
    const d = deleteDeps(w);
    expect((await erase(d, "UX")).complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain("UX");
  });
});

describe("N3 the settings step covers every project of the org", () => {
  it("excluded ids and the developer who added a source leave every project, not only the ones passed in; with no way to list them it is not done", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/CW", project: "web", exclude: ["UX"] });
    await addSource(w, { source: "slack", scope: "slack:T1/CA", project: "api", exclude: ["UX"] });
    const d = deleteDeps(w, { projects: { projects: async () => ["web", "api"] } });
    const done = await erasePerson(d.deps, ORG_A, { developerId: "dev-1", identities: [{ system: "slack:T1", sourceId: "UX" }] }, "e10");
    expect(done).toMatchObject({ complete: true, steps: { config: true } });
    await sweep(w, d);
    expect(everything(w)).not.toContain('"UX"');
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE").map((item) => item.addedBy)).toEqual([ERASED_DEVELOPER_ID, ERASED_DEVELOPER_ID]);
    const blind = deleteDeps(w, { projects: undefined });
    expect(await erasePerson(blind.deps, ORG_A, { developerId: "dev-1", identities: [{ system: "slack:T1", sourceId: "UX" }] }, "e10b")).toMatchObject({ complete: false, steps: { config: false } });
  });
});

describe("N4 mentions of the person leave other people's words, hot and lake", () => {
  it("a Slack or Jira mention is stored as @member, so the id and the display name are not in the row or the lake text", async () => {
    const w = world();
    const SC = "slack:T1/C12";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U-poster"], "U-poster", T1, "ask <@UXMENTION> and <@UXMENTION|Xavier Mention> about billing, or [~accountid:abc123]"));
    const row = rows(w, "TEAM_RECORD_EVENT")[0] as { text: string };
    expect(row.text).toBe("ask @member and @member about billing, or @member");
    const lake = toLakeEventRow(row as never, T3);
    expect(JSON.stringify(lake)).not.toContain("UXMENTION");
    expect(JSON.stringify(lake)).not.toContain("Xavier");
    const d = deleteDeps(w);
    expect((await erase(d, "UXMENTION")).complete).toBe(true);
    await sweep(w, d);
    expect(everything(w)).not.toContain("UXMENTION");
  });
});

describe("the erase race: the erase schedules its own second pass, and complete is final only after it", () => {
  it("a late write that put the person back is removed by the delayed pass the delete worker runs", async () => {
    const w = world();
    const SC = "slack:T1/C13";
    await addSource(w, { source: "slack", scope: SC });
    await w.sink.put(slackRow("m1", SC, ["U1", "UX"]));
    const d = deleteDeps(w);
    const first = await erase(d, "UX");
    expect(first).toMatchObject({ complete: true, final: false });
    expect(first.sweepDueAt).toBeDefined();
    // a write that read the markers just before they existed lands after the pass (simulated: the row is put straight into the table)
    const late = rows(w, "TEAM_RECORD_EVENT")[0] as { pk: string; sk: string; audience: { acl: { principals: string[] } } };
    w.db.set({ ...late, audience: { ...late.audience, acl: { ...late.audience.acl, principals: ["U1", "UX"] } } });
    w.db.set({ ...recordAccessPersonKey(ORG_A, "UX", SC), entityType: "TEAM_RECORD_ACCESS_INDEX" }); // an in-flight ingest indexes before it writes the row
    expect(everything(w)).toContain("UX");
    // before the delay nothing runs; after it the delete worker (already scheduled in production) runs the second pass
    const early = await runDeleteWorker(d.deps, ORG_A);
    expect(early.erasureSweeps).toEqual({ ran: 0, final: 0 });
    w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
    const run = await runDeleteWorker(d.deps, ORG_A);
    expect(run.erasureSweeps).toEqual({ ran: 1, final: 1 });
    expect(everything(w)).not.toContain("UX"); // including the schedule itself, which held the id only until now
  });
});

describe("G3 the developer id is hashed in the marker and in the lake queue", () => {
  it("no plain developer id in the erased marker or the lake-delete target; the lake column holds the same hash", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: "slack:T1/C14" });
    await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "g1", version: "1" }, audience: acl("slack:T1/C14", ["U1"]), actor: { sourceId: "UD", developerId: "dev-secret-77", trust: "member" }, text: "hello", links: [] }));
    const lakeRow = toLakeEventRow(rows(w, "TEAM_RECORD_EVENT")[0] as never, T3);
    expect(lakeRow.actor_developer_id).toBe(recordDeveloperHash("dev-secret-77"));
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-secret-77", identities: [{ system: "slack:T1", sourceId: "UD" }], projects: ["web"] }, "g3");
    expect(result.complete).toBe(true);
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "actor", developerId: recordDeveloperHash("dev-secret-77") }]));
    w.clock.ms += ERASE_SWEEP_DELAY_MS + 1;
    await runDeleteWorker(d.deps, ORG_A);
    expect(everything(w)).not.toContain("dev-secret-77");
  });
});
