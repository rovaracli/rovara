// The ingest lane's sink contract (sources/ports.ts `RecordSinkPort`), implemented by the core: versions ordered by source time, a newer version replaces the older text,
// sticky tombstones (items and places, with places covering the places under them), and the per-item lowest trust (`RecordHistoryPort`).
import { describe, expect, it } from "vitest";
import { recordScopeMarkerKey, scopeAndAncestors } from "@agentx/cloud-contracts";
import { createCaptureModePort, createRecordHistoryPort, createRecordSink, createSourceConfigPort } from "../../../packages/broker/src/team-record/sink.js";
import { createTicketRecorder } from "../../../packages/broker/src/team-record/sources/tickets.js";
import { createCodeHostTap } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { createTransientDistiller } from "../../../packages/broker/src/team-record/transient-distiller.js";
import { runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { listScopeWork } from "../../../packages/broker/src/team-record/store.js";
import { recordSearch } from "../../../packages/broker/src/team-record/query.js";
import { FakeActors, world as ingestWorld } from "../../support/team-record-ingest-fakes.js";
import { GITHUB_SCOPE, ORG_A, addSource, caller, get, githubDraft, rows, world, type World } from "../../support/team-record-core.js";
import { addFact, deleteDeps } from "../../support/team-record-delete.js";

const T1 = "2026-10-30T09:00:00.000Z";
const T2 = "2026-10-30T10:00:00.000Z";
const T3 = "2026-10-30T11:00:00.000Z";
const draft = (version: string, versionAt: string, extra: Record<string, unknown> = {}) => githubDraft({
  sourceRef: { system: "github.com", id: "c-1", version, versionAt }, occurredAt: T1, links: [], text: `text of ${version}`, ...extra,
});
const live = (w: World) => rows(w, "TEAM_RECORD_EVENT").filter((item) => item.tombstone === undefined);
const search = (w: World, query: string) => recordSearch({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms }, { kind: "caller", caller: caller() }, "web", { query });

describe("versions are ordered by source time, not arrival", () => {
  it("a version older than the stored one is a no-op, and its text never shows", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await w.sink.put(draft("v2", T2))).toEqual({ status: "stored" });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "duplicate" });
    expect(live(w).map((item) => item.text)).toEqual(["text of v2"]);
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
  });
  it("the same version again is a duplicate, and a newer one is stored", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "stored" });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "duplicate" });
    expect(await w.sink.put(draft("v2", T2))).toEqual({ status: "stored" });
  });
  it("falls back to occurredAt when the tap gives no versionAt", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const plain = (version: string, occurredAt: string) => githubDraft({ sourceRef: { system: "github.com", id: "c-2", version }, occurredAt, links: [] });
    await w.sink.put(plain("b", T2));
    expect(await w.sink.put(plain("a", T1))).toEqual({ status: "duplicate" });
  });
  it("two racing versions cannot both win: the older write loses to the newer head", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await Promise.all([w.sink.put(draft("v2", T2)), w.sink.put(draft("v1", T1))]);
    expect(live(w).map((item) => item.text)).toEqual(["text of v2"]);
  });
});

describe("a newer version replaces the older text", () => {
  it("hides the old row and removes its text at once, then the delete worker removes the row and its vector", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1, { text: "the secret launch date is friday" }));
    expect(w.vectorItems).toHaveLength(1);
    await w.sink.put(draft("v2", T2, { text: "the launch is postponed" }));
    const old = rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { version: string }).version === "v1")!;
    expect(old.tombstone).toBeDefined();
    expect(old.text).toBeUndefined();
    expect(JSON.stringify(await search(w, "secret launch friday"))).not.toContain("friday");
    expect((await search(w, "launch postponed")).hits).toHaveLength(1);
    expect(await listScopeWork(w.table, ORG_A, 10)).toHaveLength(1);
    const summary = await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(summary).toMatchObject({ rows: 1, finished: 1 });
    expect(rows(w, "TEAM_RECORD_EVENT").map((item) => (item.sourceRef as { version: string }).version)).toEqual(["v2"]);
    expect(w.vectorDeletes.flat()).toHaveLength(1);
    expect(await listScopeWork(w.table, ORG_A, 10)).toEqual([]);
  });
  it("hides the notes made from the older words, and leaves the notes made from the newer ones", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1));
    await addFact(w, "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00a1", [{ system: "github.com", sourceId: "c-1", scope: GITHUB_SCOPE }]);
    w.clock.ms += 60_000;
    await w.sink.put(draft("v2", T2));
    expect(rows(w, "TEAM_RECORD_FACT")[0]!.tombstone).toBeDefined();
    w.clock.ms += 60_000;
    // a note made from the new words, after the replacement
    await addFact(w, "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00b2", [{ system: "github.com", sourceId: "c-1", scope: GITHUB_SCOPE }], { createdAt: new Date(w.clock.ms).toISOString() });
    const links = rows(w, "TEAM_RECORD_DERIVATION");
    w.db.set({ ...links.find((link) => link.factId === "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00b2")!, createdAt: new Date(w.clock.ms).toISOString() });
    await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(rows(w, "TEAM_RECORD_FACT").map((fact) => fact.id)).toEqual(["5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a00b2"]);
  });
  it("finishes the cleanup after a crash between the head and the replacement (the redelivery owes it)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1, { text: "old words" }));
    // the replacement step fails once
    w.db.injectFault({ command: "UpdateCommand", match: (input) => Object.values((input.ExpressionAttributeNames ?? {}) as Record<string, string>).includes("tombstone"), error: { name: "InternalServerError" } });
    await expect(w.sink.put(draft("v2", T2, { text: "new words" }))).rejects.toThrow();
    expect(await w.sink.put(draft("v2", T2, { text: "new words" }))).toEqual({ status: "duplicate" });
    const old = rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { version: string }).version === "v1")!;
    expect(old.tombstone).toBeDefined();
    expect(old.text).toBeUndefined();
  });
});

describe("sticky tombstones", () => {
  it("an item deleted at its source refuses every later put of it, whatever the version", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1));
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", sourceIds: ["c-1"], cause: "source_deleted" });
    for (const [version, at] of [["v1", T1], ["v2", T3]] as const) expect(await w.sink.put(draft(version, at))).toEqual({ status: "refused", reason: "deleted_at_source" });
    expect(live(w)).toEqual([]);
  });
  it("a deleted place refuses a later put under it, and a place above it covers the places under it", async () => {
    expect(scopeAndAncestors("slack:T1/C9")).toEqual(["slack:T1/C9", "slack:T1"]);
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1));
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "source_deleted" });
    expect(await w.sink.put(draft("v9", T3, { sourceRef: { system: "github.com", id: "brand-new", version: "v1" } }))).toEqual({ status: "refused", reason: "scope_closed" });
    const covered = world();
    await addSource(covered, { source: "slack", scope: "slack:T1/C9" });
    await covered.sink.tombstone({ workspaceId: ORG_A, system: "T1", scope: "slack:T1", cause: "source_deleted" });
    expect(await covered.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "C9/1.1", version: "1" }, audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T1/C9", groups: ["T1"], capturedAt: T1, liveCheck: "none" } }, links: [] }))).toEqual({ status: "refused", reason: "scope_closed" });
  });
  it("an excluded place (Slack Connect) stays closed, and saving a source row for the place opens it again", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: GITHUB_SCOPE, cause: "excluded" });
    expect(await get(w, recordScopeMarkerKey(ORG_A, GITHUB_SCOPE))).toMatchObject({ cause: "excluded" });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "refused", reason: "scope_closed" });
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "stored" });
  });
  it("a deleted place does not close another place, or another workspace", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.tombstone({ workspaceId: ORG_A, system: "github.com", scope: "github:repo/10", cause: "source_deleted" });
    expect(await w.sink.put(draft("v1", T1))).toEqual({ status: "stored" });
  });
  it("an unreadable marker throws (the queue redelivers), it is never read as open", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    w.db.injectFault({ command: "GetCommand", match: (input) => String((input.Key as { sk: string }).sk).startsWith("SCOPEDEL#"), error: { name: "InternalServerError" } });
    await expect(w.sink.put(draft("v1", T1))).rejects.toThrow();
  });
});

describe("the lowest trust an item ever had (RecordHistoryPort)", () => {
  const history = (w: World) => createRecordHistoryPort(w.deps);
  const ask = (w: World) => history(w).lowestTrust({ workspaceId: ORG_A, source: "github", system: "github.com", id: "c-1" });
  it("is unknown for an item never seen, and the lowest of every version afterwards, including a late older one", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await ask(w)).toBeUndefined();
    await w.sink.put(draft("v1", T1, { trust: "outsider", actor: { sourceId: "9", trust: "outsider" } }));
    await w.sink.put(draft("v2", T2, { trust: "member" }));
    expect(await ask(w)).toBe("outsider");
    const late = world();
    await addSource(late, { source: "github", scope: GITHUB_SCOPE });
    await late.sink.put(draft("v2", T2, { trust: "member" }));
    await late.sink.put(draft("v1", T1, { trust: "outsider", actor: { sourceId: "9", trust: "outsider" } })); // a late older version, refused as stale
    expect(await ask(late)).toBe("outsider");
  });
  it("keeps a later innocent touch of an outsider's item from relabelling it member, in the stored row", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1, { trust: "outsider", actor: { sourceId: "9", trust: "outsider" } }));
    await w.sink.put(draft("v2", T2, { trust: "member", actor: { sourceId: "1", developerId: "dev-1", trust: "member" } }));
    expect(live(w)[0]!.trust).toBe("outsider");
  });
  it("is only for the workspace asked, and a bad workspace id is 'unknown'", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(draft("v1", T1, { trust: "outsider", actor: { sourceId: "9", trust: "outsider" } }));
    expect(await history(w).lowestTrust({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb", source: "github", system: "github.com", id: "c-1" })).toBeUndefined();
    expect(await history(w).lowestTrust({ workspaceId: "ws-1", source: "github", system: "github.com", id: "c-1" })).toBeUndefined();
  });
  it("feeds the real ticket tap (per-editor rows): each change is its own row under its own editor, none replaces another, and the lowest-trust history is not needed", async () => {
    const w = world();
    await addSource(w, { source: "jira", scope: "jira:project/SHOP", audienceDefault: "project" });
    const actors = new FakeActors();
    actors.members.set("acc-1", "dev-1");
    actors.members.set("acc-2", "dev-2");
    const recorder = createTicketRecorder({ sink: createRecordSink(w.deps), actors, mode: createCaptureModePort(w.deps), config: createSourceConfigPort(w.deps) });
    const item = { source: "jira" as const, system: "jira:acme", id: "issue:1", kind: "ticket.created" as const, scope: "jira:project/SHOP", title: "Cart total", body: "wrong", occurredAt: T1, version: "v1", authorId: "acc-1", updaterId: "acc-1" };
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, item)).toBe("stored");
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, { ...item, kind: "ticket.updated", edit: true, version: "v2", occurredAt: T2, updaterId: "acc-2", body: "wrong\nsam: only on Tuesdays", changed: { body: true }, previousBody: "wrong" })).toBe("stored");
    expect(await recorder.record({ workspaceId: ORG_A, project: "web" }, { ...item, kind: "ticket.updated", edit: true, version: "v3", occurredAt: T3, updaterId: "acc-1", state: "Done", changed: { state: true } })).toBe("stored");
    const live = rows(w, "TEAM_RECORD_EVENT").filter((row) => row.tombstone === undefined);
    expect(live.map((row) => [(row.actor as { developerId?: string }).developerId, row.text, row.trust])).toEqual([["dev-1", "Cart total\n\nwrong", "member"], ["dev-2", "sam: only on Tuesdays", "member"], ["dev-1", undefined, "member"]]);
    // No item head is kept for a change row (nothing is replaced, so there is no head to advance).
    expect(rows(w, "TEAM_RECORD_ITEM_HEAD")).toEqual([]);
  });
});

describe("the taps say whose words they are (pieceTrusts)", () => {
  it("the ticket tap lists the person who made the change (the creator on a creation, the editor on an edit)", async () => {
    const w = ingestWorld();
    w.actors.members.set("acc-1", "dev-1");
    const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config });
    w.config.set("jira", "jira:project/SHOP", { retention: "C" });
    await recorder.record({ workspaceId: "ws-1", project: "shop" }, { source: "jira", system: "jira:acme", id: "issue:1", kind: "ticket.created", scope: "jira:project/SHOP", title: "t", occurredAt: T1, version: "v2", authorId: "acc-1" });
    await recorder.record({ workspaceId: "ws-1", project: "shop" }, { source: "jira", system: "jira:acme", id: "issue:1", kind: "ticket.updated", edit: true, scope: "jira:project/SHOP", title: "t", occurredAt: T2, version: "v3", authorId: "acc-1", updaterId: "acc-stranger", changed: { state: true } });
    expect(w.sink.puts[0]).toMatchObject({ trust: "member", pieceTrusts: ["member"] });
    expect(w.sink.puts[1]).toMatchObject({ trust: "outsider", pieceTrusts: ["outsider"] });
  });
  it("the code host tap lists the author of each pull request, review and comment, and names the repository's place on every draft (a public repository has a project-wide audience)", async () => {
    const w = ingestWorld();
    const repo = { host: "github", id: "77", fullName: "acme/shop", isPrivate: false, defaultBranch: "main", workspaceId: "ws-1", project: "shop" };
    w.config.set("github", "github:repo/77", { retention: "D" });
    w.actors.members.set("1001", "dev-alice");
    const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config });
    await tap.handle({ type: "pr", repo, number: 5, url: "https://github.com/acme/shop/pull/5", action: "opened", merged: false, title: "t", body: "b", author: { id: "1001", login: "al", isBot: false }, headSha: "a".repeat(40), baseRef: "main", at: T1, version: "opened:1" });
    await tap.handle({ type: "pr", repo, number: 6, url: "https://github.com/acme/shop/pull/6", action: "opened", merged: false, title: "t", body: "b", author: { id: "9999", login: "mal", isBot: false }, headSha: "b".repeat(40), baseRef: "main", at: T1, version: "opened:1" });
    expect(w.sink.puts).toHaveLength(2);
    for (const put of w.sink.puts) {
      expect(put.pieceTrusts).toEqual([put.trust]);
      expect(put.scope).toBe("github:repo/77");
    }
    expect(w.sink.puts.map((put) => put.pieceTrusts)).toEqual([["member"], ["outsider"]]);
  });
});

describe("retention B follows the same version rules", () => {
  it("a late older message is refused, and an edit clears the notes made from the older words before the new ones are written", async () => {
    const w = world({ edition: "public" });
    await addSource(w, { source: "slack", scope: "slack:T1/C9", retention: "B", notesOptIn: true });
    let n = 0;
    const model = async ({ user }: { user: string }) => JSON.stringify({ facts: [{ kind: "note", text: user.includes("edited") ? "The edited decision." : "The first decision.", links: [] }] });
    const distiller = createTransientDistiller({ ingest: w.deps, distill: { model, now: () => new Date(w.clock.ms).toISOString(), newId: () => `5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a${String(++n).padStart(4, "0")}` } });
    const message = (version: string, versionAt: string, text: string) => ({
      workspaceId: ORG_A, project: "web", source: "slack" as const, kind: "slack.message" as const, occurredAt: T1, sourceRef: { system: "T1", id: "C9/1.1", version, versionAt, url: "https://acme.slack.com/archives/C9/p11" },
      actor: { sourceId: "U1", developerId: "dev-1", trust: "member" as const }, trust: "member" as const, audience: { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T1/C9", groups: ["T1"], capturedAt: T1, liveCheck: "none" as const } },
      links: ["https://acme.slack.com/archives/C9/p11"], retention: "B" as const, text,
    });
    expect(await distiller.distillTransient(message("m:1", T1, "we will ship friday"))).toEqual({ accepted: true });
    expect(rows(w, "TEAM_RECORD_FACT").map((fact) => fact.text)).toEqual(["The first decision."]);
    w.clock.ms += 60_000;
    expect(await distiller.distillTransient(message("m:2", T2, "edited: we will ship monday"))).toEqual({ accepted: true });
    const facts = rows(w, "TEAM_RECORD_FACT");
    const first = facts.find((fact) => String(fact.id).endsWith("0001"))!;
    const second = facts.find((fact) => String(fact.id).endsWith("0002"))!;
    expect(first.tombstone).toBeDefined();
    expect(first.text).toBeUndefined();
    expect(second.tombstone).toBeUndefined();
    // the late older one changes nothing
    expect(await distiller.distillTransient(message("m:1", T1, "we will ship friday"))).toEqual({ accepted: false });
    expect(rows(w, "TEAM_RECORD_FACT")).toHaveLength(2);
    await runDeleteWorker(deleteDeps(w).deps, ORG_A);
    expect(rows(w, "TEAM_RECORD_FACT").map((fact) => fact.text)).toEqual(["The edited decision."]);
  });
});
