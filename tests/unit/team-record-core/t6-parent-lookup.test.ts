// Task 6 item 6: ParentLookupPort over the record's own rows. Fail closed everywhere.
import { describe, expect, it } from "vitest";
import { createRecordParentLookup } from "../../../packages/broker/src/team-record/sources/parent-lookup.js";
import { createTicketRecorder, type TicketItem } from "../../../packages/broker/src/team-record/sources/tickets.js";
import { ORG_A, ORG_B, addSource, rows, world } from "../../support/team-record-core.js";
import { world as fakes } from "../../support/team-record-ingest-fakes.js";

const SCOPE = "linear:team/t1";
const ticket = (over: Partial<TicketItem> = {}): TicketItem => ({ source: "linear", system: "linear", id: "issue:1", kind: "ticket.created", scope: SCOPE, title: "Fix login", authorId: "u1", occurredAt: "2026-10-30T10:00:00.000Z", version: "v1", ...over });

describe("TR-W1 ParentLookupPort.isOpen", () => {
  it("is false for a ticket nobody recorded, in a lookup that cannot read, and for a bad workspace id", async () => {
    const w = world();
    const parents = createRecordParentLookup(w.table);
    expect(await parents.isRecorded({ workspaceId: ORG_A, system: "linear", id: "issue:1", scope: SCOPE })).toBe(false);
    expect(await parents.isOpen!({ workspaceId: ORG_A, system: "linear", id: "issue:1", scope: SCOPE })).toBe(false);
    expect(await parents.isOpen!({ workspaceId: "not-an-org", system: "linear", id: "issue:1", scope: SCOPE })).toBe(false);
    const broken = createRecordParentLookup({ ...w.table, documentClient: { send: async () => { throw new Error("down"); } } });
    await expect(broken.isOpen!({ workspaceId: ORG_A, system: "linear", id: "issue:1", scope: SCOPE })).rejects.toThrow(); // callers catch and fail closed
  });
  it("reads a recorded ticket: open when every row says not restricted, restricted when any row says so; another place and another org see nothing", async () => {
    const w = world();
    await addSource(w, { source: "linear", scope: SCOPE });
    const base = { workspaceId: ORG_A, project: "web", source: "linear", kind: "ticket.created", occurredAt: "2026-10-30T10:00:00.000Z", trust: "member", retention: "D", links: [],
      actor: { sourceId: "u1", developerId: "dev-1", trust: "member" }, scope: SCOPE, audience: { kind: "project" } } as const;
    const put = (id: string, version: string, order: number, restricted: boolean) => w.sink.put({ ...base, sourceRef: { system: "linear", id, version, order }, structured: { restricted } } as never);
    expect((await put("issue:1", "v1", 1, false)).status).toBe("stored");
    expect((await put("issue:2", "v1", 1, false)).status).toBe("stored");
    expect((await put("issue:2", "v2", 2, true)).status).toBe("stored");
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(3); // positive control: rows exist
    const parents = createRecordParentLookup(w.table);
    const ask = (id: string, scope = SCOPE, workspaceId: string = ORG_A) => ({ workspaceId, system: "linear", id, scope });
    expect(await parents.isRecorded(ask("issue:1"))).toBe(true);
    expect(await parents.isOpen!(ask("issue:1"))).toBe(true);
    expect(await parents.isRecorded(ask("issue:2"))).toBe(true);
    expect(await parents.isOpen!(ask("issue:2"))).toBe(false);
    expect(await parents.isRecorded(ask("issue:1", "linear:team/other"))).toBe(false);
    expect(await parents.isRecorded(ask("issue:1", SCOPE, ORG_B))).toBe(false);
    expect(await parents.isOpen!(ask("issue:1", SCOPE, ORG_B))).toBe(false);
    // a deleted ticket is not recorded any more
    await w.sink.tombstone({ workspaceId: ORG_A, system: "linear", sourceIds: ["issue:1"], cause: "source_deleted" });
    expect(await parents.isRecorded(ask("issue:1"))).toBe(false);
    expect(await parents.isOpen!(ask("issue:1"))).toBe(false);
  });

  it("end to end: a Linear comment is recorded once its issue is, and a Jira comment on an open issue is not restricted while one on a restricted issue is", async () => {
    const w = world();
    await addSource(w, { source: "linear", scope: SCOPE });
    await addSource(w, { source: "jira", scope: "jira:site/acme/project/ENG" });
    const f = fakes();
    f.actors.members.set("u1", "dev-1");
    f.config.set("linear", SCOPE, { retention: "C" });
    f.config.set("jira", "jira:site/acme/project/ENG", { retention: "C", audienceDefault: "project" });
    const recorder = createTicketRecorder({ sink: w.sink, actors: f.actors, mode: f.mode, config: f.config, parents: createRecordParentLookup(w.table) });
    const comment = ticket({ id: "comment:9", kind: "ticket.comment", parentId: "issue:1", needsParentProof: true, body: "see this", version: "c1", occurredAt: "2026-10-30T11:00:00.000Z" });
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, comment)).toBe("skipped"); // the issue is not recorded yet
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, ticket())).toBe("stored");
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, comment)).toBe("stored");
    const JIRA = "jira:site/acme/project/ENG";
    const jira = (id: string, over: Partial<TicketItem>) => ticket({ source: "jira", system: "acme.atlassian.net", scope: JIRA, id, ...over });
    await recorder.record({ workspaceId: ORG_A, project: "web" }, jira("issue:5", {}));
    await recorder.record({ workspaceId: ORG_A, project: "web" }, jira("issue:6", { restricted: true }));
    const note = (id: string, parentId: string) => jira(id, { kind: "ticket.comment", parentId, inheritsRestriction: true, body: "note", version: "n1", occurredAt: "2026-10-30T11:00:00.000Z" });
    await recorder.record({ workspaceId: ORG_A, project: "web" }, note("comment:1", "issue:5"));
    await recorder.record({ workspaceId: ORG_A, project: "web" }, note("comment:2", "issue:6"));
    await recorder.record({ workspaceId: ORG_A, project: "web" }, note("comment:3", "issue:77"));
    const restrictedOf = (id: string) => (rows(w, "TEAM_RECORD_EVENT").find((row) => (row.sourceRef as { id: string }).id === id) as { structured: { restricted: boolean } }).structured.restricted;
    expect(restrictedOf("comment:1")).toBe(false);
    expect(restrictedOf("comment:2")).toBe(true);
    expect(restrictedOf("comment:3")).toBe(true); // an unknown parent
  });
});
