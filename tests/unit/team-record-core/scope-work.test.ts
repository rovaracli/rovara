import { describe, expect, it } from "vitest";
import { recordFactKey, type RecordFact } from "@agentx/contracts";
import { eventFromItem, getRecordFact, pendingHidesOf, listScopeWork, putDerivationLinks, putRecordFact, queryRecordEvents, getSourceConfigByScope, putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { createRecordSink } from "../../../packages/broker/src/team-record/sink.js";
import { wasDeletedAtSource } from "../../../packages/broker/src/team-record/scope-work.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, caller, get, githubDraft, rows, setMode, world, type World, filterRows as filterVisible } from "../../support/team-record-core.js";

const FACT_ID = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001";
const slackScope = "slack:T1/C9";

async function seed(w: World, count = 3, scope = GITHUB_SCOPE, source: "github" | "slack" = "github") {
  await addSource(w, { source, scope });
  for (let i = 1; i <= count; i += 1) {
    await w.sink.put(githubDraft({
      source, kind: source === "slack" ? "slack.message" : "github.review_comment", repo: undefined, sourceRef: { system: source === "slack" ? "T1" : "github.com", id: `c-${String(i)}`, version: "1" },
      audience: { kind: "restricted", acl: { source, scope, principals: ["123", "456"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, links: [],
    }));
  }
}
async function seedFact(w: World, sources: Array<{ system: string; sourceId: string; scope?: string }>, audience: RecordFact["audience"]) {
  const fact: RecordFact = { id: FACT_ID, workspaceId: ORG_A, project: "web", kind: "decision", text: "We keep retries in withRetry.", links: [], derivedFrom: sources.map((s) => `${s.system}:${s.sourceId}`), trust: "member", audience, createdAt: "2026-10-30T11:00:00.000Z" };
  await putRecordFact(w.table, fact);
  await putDerivationLinks(w.table, { orgId: ORG_A, project: "web", factId: FACT_ID, sources, at: "2026-10-30T11:00:00.000Z" });
}
const eventRows = (w: World) => rows(w, "TEAM_RECORD_EVENT");

describe("tombstone: hidden at once", () => {
  it("hides a source item's row, removes its text, and the project read no longer returns it", async () => {
    const w = world();
    await seed(w);
    const result = await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-2"], cause: "source_deleted" });
    expect(result).toEqual({ hidden: 1 });
    const hidden = eventRows(w).find((item) => (item.sourceRef as { id: string }).id === "c-2")!;
    expect(hidden.tombstone).toMatchObject({ cause: "source_deleted" });
    expect(hidden.text).toBeUndefined();
    const events = await queryRecordEvents(w.table, ORG_A, "web", { limit: 10 });
    const { visible, withheld } = await filterVisible(events, { kind: "caller", caller: caller() });
    expect(visible.map((event) => event.sourceRef.id).sort()).toEqual(["c-1", "c-3"]);
    expect(withheld).toBe(0);
  });

  it("leaves a deleted-at-source marker, so a late retry of the create is refused", async () => {
    const w = world();
    await seed(w, 1);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    expect(await wasDeletedAtSource(w.table, ORG_A, "github.com", "c-1")).toBe(true);
    expect(await wasDeletedAtSource(w.table, ORG_A, "github.com", "c-2")).toBe(false);
    expect(await wasDeletedAtSource(w.table, ORG_B, "github.com", "c-1")).toBe(false);
    const again = await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-1", version: "9" }, links: [] }));
    expect(again).toEqual({ status: "refused", reason: "deleted_at_source" });
  });

  it("hides every row of a deleted scope and queues the delete", async () => {
    const w = world();
    await seed(w, 3);
    await seed(w, 1, "github:repo/10");
    const result = await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect(result.hidden).toBe(3);
    expect(eventRows(w).filter((item) => item.tombstone !== undefined)).toHaveLength(3);
    const queue = await listScopeWork(w.table, ORG_A, 10);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ type: "tombstone", scope: GITHUB_SCOPE, cause: "source_deleted", hidePending: false, hidden: 3 });
  });

  it("hides the facts distilled from the deleted item, even from a source that kept no row", async () => {
    const w = world();
    await seedFact(w, [{ system: "T1", sourceId: "T1/C9/1.1", scope: slackScope }, { system: "T1", sourceId: "T1/C9/1.2", scope: slackScope }], { kind: "project" });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "T1", sourceIds: ["T1/C9/1.2"], cause: "source_deleted" });
    const stored = await get(w, recordFactKey(ORG_A, "web", FACT_ID));
    expect(stored!.tombstone).toMatchObject({ cause: "source_deleted" });
    expect(await getRecordFact(w.table, ORG_A, "web", FACT_ID)).toBeUndefined();
  });

  it("never touches another workspace's rows with the same ids", async () => {
    const w = world();
    await seed(w, 1);
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ workspaceId: ORG_B, links: [] }));
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], scope: GITHUB_SCOPE, cause: "source_deleted" });
    const b = eventRows(w).filter((item) => (item.pk as string).includes(ORG_B));
    expect(b).toHaveLength(1);
    expect(b[0]!.tombstone).toBeUndefined();
    expect(await wasDeletedAtSource(w.table, ORG_B, "github.com", "c-1")).toBe(false);
  });

  it("a budget that runs out leaves the scope hidden from everyone until the work finishes", async () => {
    const w = world();
    await seed(w, 4);
    const tiny = createRecordSink(w.deps, { budget: { maxItems: 2, maxMs: 8_000 } });
    const result = await tiny.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect(result.hidden).toBe(2);
    const queue = await listScopeWork(w.table, ORG_A, 10);
    expect(queue[0]).toMatchObject({ hidePending: true });
    const pending = await pendingHidesOf(w.table, ORG_A);
    expect([...pending.scopes]).toEqual([GITHUB_SCOPE]);
    const events = await queryRecordEvents(w.table, ORG_A, "web", { limit: 10 });
    expect((await filterVisible(events, { kind: "caller", caller: caller() }, { pending })).visible).toHaveLength(0);
    // the other scope stays visible
    expect((await filterVisible(events, { kind: "caller", caller: caller() })).visible.length).toBe(2);
  });

  it("is idempotent: a second tombstone hides nothing new", async () => {
    const w = world();
    await seed(w, 2);
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect(await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "excluded" })).toEqual({ hidden: 0 });
    expect(eventRows(w).every((item) => (item.tombstone as { cause: string }).cause === "source_deleted")).toBe(true);
  });
});

describe("permission snapshot changes", () => {
  it("adds and removes principals on every row of a private scope, and a removed member sees nothing at once", async () => {
    const w = world();
    await seed(w, 2, slackScope, "slack");
    await w.sink.changePrincipals({ workspaceId: ORG_A, scope: slackScope, add: ["789"], remove: ["123"], at: "2026-10-30T13:00:00.000Z" });
    for (const item of eventRows(w)) {
      const acl = (item.audience as { acl: { principals: string[]; capturedAt: string } }).acl;
      expect(acl.principals).toEqual(["456", "789"]);
      expect(acl.capturedAt).toBe("2026-10-30T13:00:00.000Z");
    }
    const events = (await queryRecordEvents(w.table, ORG_A, "web", { limit: 10 }));
    const removed = caller({ identities: { ids: { slack: ["123"] }, groups: {} } });
    expect((await filterVisible(events, { kind: "caller", caller: removed })).visible).toHaveLength(0);
    const added = caller({ identities: { ids: { slack: ["789"] }, groups: {} } });
    expect((await filterVisible(events, { kind: "caller", caller: added })).visible).toHaveLength(2);
  });

  it("is idempotent, and caps principals at 500 (fewer people see the rows, never more)", async () => {
    const w = world();
    await seed(w, 1, slackScope, "slack");
    await w.sink.changePrincipals({ workspaceId: ORG_A, scope: slackScope, add: Array.from({ length: 600 }, (_, i) => `u${String(i)}`), at: "2026-10-30T13:00:00.000Z" });
    const principals = (eventRows(w)[0]!.audience as { acl: { principals: string[] } }).acl.principals;
    expect(principals).toHaveLength(500);
    expect(principals.slice(0, 2)).toEqual(["123", "456"]);
    const before = JSON.stringify(eventRows(w)[0]);
    await w.sink.changePrincipals({ workspaceId: ORG_A, scope: slackScope, add: ["123"], remove: ["nobody"], at: "2026-10-30T14:00:00.000Z" });
    expect(JSON.stringify(eventRows(w)[0])).toBe(before);
  });

  it("updates the snapshot of the facts distilled from the scope, and not of a fact on another scope", async () => {
    const w = world();
    await seed(w, 1, slackScope, "slack");
    const own = { kind: "restricted" as const, acl: { source: "slack" as const, scope: slackScope, principals: ["123", "456"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" as const } };
    await seedFact(w, [{ system: "T1", sourceId: "T1/C9/c-1", scope: slackScope }], own);
    await w.sink.changePrincipals({ workspaceId: ORG_A, scope: slackScope, remove: ["123"], at: "2026-10-30T13:00:00.000Z" });
    const fact = await getRecordFact(w.table, ORG_A, "web", FACT_ID);
    expect((fact!.audience as { acl: { principals: string[] } }).acl.principals).toEqual(["456"]);

    const other = world();
    await seed(other, 1, slackScope, "slack");
    const mixed = { ...own, acl: { ...own.acl, scope: "slack:T1/C1" } };
    await seedFact(other, [{ system: "T1", sourceId: "T1/C9/c-1", scope: slackScope }], mixed);
    await other.sink.changePrincipals({ workspaceId: ORG_A, scope: slackScope, remove: ["123"], at: "2026-10-30T13:00:00.000Z" });
    expect((await getRecordFact(other.table, ORG_A, "web", FACT_ID))!.audience).toEqual(mixed);
  });

  it("a scope that turns private narrows its rows and facts; one that turns public widens rows but never facts", async () => {
    const w = world();
    await addSource(w, { source: "slack", scope: slackScope });
    await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "T1/C9/1.1", version: "1" }, links: [], audience: { kind: "restricted", acl: { source: "slack", scope: slackScope, groups: ["T1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } }));
    await seedFact(w, [{ system: "T1", sourceId: "T1/C9/1.1", scope: slackScope }], { kind: "project" });
    const priv = { kind: "restricted" as const, acl: { source: "slack" as const, scope: slackScope, principals: ["123"], capturedAt: "2026-10-30T13:00:00.000Z", liveCheck: "none" as const } };
    await w.sink.replaceScopeAudience({ workspaceId: ORG_A, scope: slackScope, audience: priv, at: "2026-10-30T13:00:00.000Z" });
    expect(eventRows(w)[0]!.audience).toEqual(priv);
    expect((await getRecordFact(w.table, ORG_A, "web", FACT_ID))!.audience).toEqual(priv);
    await w.sink.replaceScopeAudience({ workspaceId: ORG_A, scope: slackScope, audience: { kind: "project" }, at: "2026-10-30T14:00:00.000Z" });
    expect(eventRows(w)[0]!.audience).toEqual({ kind: "project" });
    expect((await getRecordFact(w.table, ORG_A, "web", FACT_ID))!.audience).toEqual(priv);
  });

  it("when the work cannot finish in budget, the scope is hidden from everyone and queued", async () => {
    const w = world();
    await seed(w, 3, slackScope, "slack");
    const tiny = createRecordSink(w.deps, { budget: { maxItems: 1, maxMs: 8_000 } });
    await tiny.changePrincipals({ workspaceId: ORG_A, scope: slackScope, remove: ["123"], at: "2026-10-30T13:00:00.000Z" });
    const queue = await listScopeWork(w.table, ORG_A, 10);
    expect(queue[0]).toMatchObject({ type: "principals", scope: slackScope, remove: ["123"], hidePending: true });
    expect([...(await pendingHidesOf(w.table, ORG_A)).scopes]).toEqual([slackScope]);
  });

  it("an event whose workspace is not an org is refused by the sink (throws), not guessed", async () => {
    const w = world();
    await expect(w.sink.tombstone({ workspaceId: "ws-1", system: "x", sourceIds: ["a"], cause: "source_deleted" })).rejects.toThrow();
  });
});

describe("source settings", () => {
  it("one scope belongs to one project: a second project's row for it is refused, a replacement in the same project is allowed", async () => {
    const w = world();
    expect(await addSource(w, { source: "github", scope: GITHUB_SCOPE, project: "web" })).toEqual({ status: "saved" });
    expect(await addSource(w, { source: "github", scope: GITHUB_SCOPE, project: "api" })).toEqual({ status: "refused", reason: "scope_in_other_project" });
    expect(await addSource(w, { source: "github", scope: GITHUB_SCOPE, project: "web", retention: "C" })).toEqual({ status: "saved" });
    expect((await getSourceConfigByScope(w.table, ORG_A, "github", GITHUB_SCOPE))!.retention).toBe("C");
    // another workspace may use the same scope string
    expect(await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE, project: "api" })).toEqual({ status: "saved" });
    expect((await getSourceConfigByScope(w.table, ORG_B, "github", GITHUB_SCOPE))!.project).toBe("api");
  });

  it("reads a scope found in two rows as no row (fail closed), and refuses an invalid row", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, project: "web" });
    const [first] = w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");
    w.db.set({ ...first!, pk: (first!.pk as string).replace("#P#web", "#P#api"), project: "api" });
    expect(await getSourceConfigByScope(w.table, ORG_A, "github", GITHUB_SCOPE)).toBeUndefined();
    expect(await putSourceConfig(w.table, { workspaceId: ORG_A, project: "web", source: "github", scope: "", enabled: true, retention: "D", exclude: [], audienceDefault: "project", health: "ok", addedBy: "d", updatedAt: "2026-10-30T10:00:00.000Z" })).toEqual({ status: "refused", reason: "invalid" });
  });

  it("the sink's source port and capture port speak the ingest lane's shapes", async () => {
    const { createCaptureModePort, createSourceConfigPort } = await import("../../../packages/broker/src/team-record/sink.js");
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, audienceDefault: "project", exclude: ["x"] });
    expect(await createSourceConfigPort(w.deps).get(ORG_A, "github", GITHUB_SCOPE)).toEqual({ enabled: true, retention: "D", exclude: ["x"], audienceDefault: "project", project: "web" });
    expect(await createSourceConfigPort(w.deps).get("ws-1", "github", GITHUB_SCOPE)).toBeUndefined();
    expect(await createSourceConfigPort(w.deps).get(ORG_A, "github", "github:repo/none")).toBeUndefined();
    const capture = createCaptureModePort(w.deps);
    expect(await capture.captureOn(ORG_A, "web")).toBe(true);
    setMode(w, ORG_A, "web", "off");
    expect(await capture.captureOn(ORG_A, "web")).toBe(false);
    expect(await capture.captureOn("ws-1", "web")).toBe(false);
  });
});

void eventFromItem;
