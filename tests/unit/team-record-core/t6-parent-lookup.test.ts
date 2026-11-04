// Task 6 item 6 (after fix round 1): ParentLookupPort over the record's own rows answers only "is the ticket recorded under this place" (Linear comments). It never says a ticket is OPEN:
// the record cannot know a restriction it never stored, so every Jira comment stays restricted, as before this task.
import { describe, expect, it } from "vitest";
import { createRecordParentLookup } from "../../../packages/broker/src/team-record/sources/parent-lookup.js";
import { createTicketRecorder, type TicketItem } from "../../../packages/broker/src/team-record/sources/tickets.js";
import { ORG_A, ORG_B, addSource, rows, world } from "../../support/team-record-core.js";
import { world as fakes } from "../../support/team-record-ingest-fakes.js";

const SCOPE = "linear:team/t1";
const JIRA = "jira:site/acme/project/ENG";
const ticket = (over: Partial<TicketItem> = {}): TicketItem => ({ source: "linear", system: "linear", id: "issue:1", kind: "ticket.created", scope: SCOPE, title: "Fix login", authorId: "u1", occurredAt: "2026-10-30T10:00:00.000Z", version: "v1", ...over });
const ctx = { workspaceId: ORG_A, project: "web" };

describe("TR-W1 ParentLookupPort", () => {
  it("has no isOpen: the record cannot say a ticket is open", () => {
    expect("isOpen" in createRecordParentLookup(world().table)).toBe(false);
  });

  it("isRecorded: false for a ticket nobody recorded and a bad workspace id, throws on a broken read (callers fail closed)", async () => {
    const w = world();
    const parents = createRecordParentLookup(w.table);
    expect(await parents.isRecorded({ workspaceId: ORG_A, system: "linear", id: "issue:1", scope: SCOPE })).toBe(false);
    expect(await parents.isRecorded({ workspaceId: "not-an-org", system: "linear", id: "issue:1", scope: SCOPE })).toBe(false);
    const broken = createRecordParentLookup({ ...w.table, documentClient: { send: async () => { throw new Error("down"); } } });
    await expect(broken.isRecorded({ workspaceId: ORG_A, system: "linear", id: "issue:1", scope: SCOPE })).rejects.toThrow();
  });

  it("isRecorded reads a recorded ticket; another place, another org and a deleted ticket read as not recorded", async () => {
    const w = world();
    await addSource(w, { source: "linear", scope: SCOPE });
    const base = { workspaceId: ORG_A, project: "web", source: "linear", kind: "ticket.created", occurredAt: "2026-10-30T10:00:00.000Z", trust: "member", retention: "D", links: [],
      actor: { sourceId: "u1", developerId: "dev-1", trust: "member" }, scope: SCOPE, audience: { kind: "project" } } as const;
    expect((await w.sink.put({ ...base, sourceRef: { system: "linear", id: "issue:1", version: "v1", order: 1 }, structured: { restricted: false } } as never)).status).toBe("stored");
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1); // positive control: the row exists
    const parents = createRecordParentLookup(w.table);
    const ask = (scope = SCOPE, workspaceId: string = ORG_A) => ({ workspaceId, system: "linear", id: "issue:1", scope });
    expect(await parents.isRecorded(ask())).toBe(true);
    expect(await parents.isRecorded(ask("linear:team/other"))).toBe(false);
    expect(await parents.isRecorded(ask(SCOPE, ORG_B))).toBe(false);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "linear", sourceIds: ["issue:1"], cause: "source_deleted" });
    expect(await parents.isRecorded(ask())).toBe(false);
  });

  it("end to end: a Linear comment is skipped until its issue is recorded, then stored", async () => {
    const w = world();
    await addSource(w, { source: "linear", scope: SCOPE });
    const f = fakes();
    f.actors.members.set("u1", "dev-1");
    f.config.set("linear", SCOPE, { retention: "C" });
    const recorder = createTicketRecorder({ sink: w.sink, actors: f.actors, mode: f.mode, config: f.config, parents: createRecordParentLookup(w.table) });
    const comment = ticket({ id: "comment:9", kind: "ticket.comment", parentId: "issue:1", needsParentProof: true, body: "see this", version: "c1", occurredAt: "2026-10-30T11:00:00.000Z" });
    expect(await recorder.record(ctx, comment)).toBe("skipped");
    expect(await recorder.record(ctx, ticket())).toBe("stored");
    expect(await recorder.record(ctx, comment)).toBe("stored");
  });

  it("a Jira issue recorded open, then given a security level by a person whose change is not stored, keeps its comments restricted (and so does one on an open or unknown issue)", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: JIRA });
    const f = fakes();
    f.actors.members.set("u1", "dev-1");
    // the admin who sets the security level is one whose change the record does not keep (here: excluded; in production also an unlinked person)
    f.config.set("jira", JIRA, { retention: "C", audienceDefault: "project", exclude: ["admin-unlinked"] });
    const recorder = createTicketRecorder({ sink: w.sink, actors: f.actors, mode: f.mode, config: f.config, parents: createRecordParentLookup(w.table) });
    const jira = (id: string, over: Partial<TicketItem>) => ticket({ source: "jira", system: "acme.atlassian.net", scope: JIRA, id, ...over });
    expect(await recorder.record(ctx, jira("issue:5", {}))).toBe("stored");
    // the security-level update (restricted) is not stored
    expect(await recorder.record(ctx, jira("issue:5", { authorId: "admin-unlinked", updaterId: "admin-unlinked", edit: true, changed: { state: true }, restricted: true, version: "u2", occurredAt: "2026-10-30T10:30:00.000Z" }))).toBe("skipped");
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1); // only the open row
    const note = (id: string, parentId: string) => jira(id, { kind: "ticket.comment", parentId, inheritsRestriction: true, body: "note", version: "n1", occurredAt: "2026-10-30T11:00:00.000Z" });
    expect(await recorder.record(ctx, note("comment:1", "issue:5"))).toBe("stored");
    expect(await recorder.record(ctx, note("comment:3", "issue:77"))).toBe("stored");
    const restrictedOf = (id: string) => (rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === id) as { structured: { restricted: boolean } }).structured.restricted;
    expect(restrictedOf("comment:1")).toBe(true);
    expect(restrictedOf("comment:3")).toBe(true);
  });
});
