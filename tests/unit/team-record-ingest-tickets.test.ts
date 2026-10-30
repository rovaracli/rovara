import { describe, expect, it } from "vitest";
import { MAINTAINERS_GROUP } from "../../packages/broker/src/team-record/sources/ports.js";
import { createTicketRecorder, ticketAudience, type TicketItem } from "../../packages/broker/src/team-record/sources/tickets.js";
import { adfText, createTicketWebhookTap, ticketsOfWebhook } from "../../packages/broker/src/team-record/sources/ticket-webhooks.js";
import {
  checkReadOnlyTool, createJsonListAdapter, nextPollDelayMs, runMcpPoll, BACKFILL_MAX_ITEMS, type JsonListMapping, type McpPollSource, type PollConnection, type PollBudget, type PollState, type PollToolResult,
} from "../../packages/broker/src/team-record/sources/mcp-poller.js";
import { runExistenceSweep, type SweepRowsPort } from "../../packages/broker/src/team-record/sources/existence-sweep.js";
import { world, WS } from "../support/team-record-ingest-fakes.js";

const AWS_KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

function recorderWorld() {
  const w = world();
  w.actors.members.set("acc-1", "dev-1");
  const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config });
  return { w, recorder };
}

describe("ticket audience", () => {
  const item = { source: "mcp" as const, scope: "mcp:sim/folder" };
  const config = (audienceDefault: "project" | "maintainers") => ({ enabled: true, retention: "D" as const, exclude: [], audienceDefault });

  it("fails closed to maintainers only when the source gives no ACL and the admin has not widened it", () => {
    expect(ticketAudience(item, undefined, config("maintainers"), "t")).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
    expect(ticketAudience(item, undefined, config("project"), "t")).toEqual({ kind: "project" });
  });

  it("a server's own ACL always narrows, even when the admin widened the default", () => {
    const acl = { principals: ["u1", "u2"], strict: true };
    expect(ticketAudience(item, acl, config("project"), "t")).toMatchObject({ kind: "restricted", acl: { principals: ["u1", "u2"], scope: "mcp:sim/folder" } });
  });

  it("a derived team scope is the default, and the admin's say-so widens it", () => {
    const acl = { groups: ["team-1"], strict: false };
    expect(ticketAudience({ source: "linear", scope: "linear:team/team-1" }, acl, config("maintainers"), "t")).toMatchObject({ kind: "restricted", acl: { groups: ["team-1"] } });
    expect(ticketAudience({ source: "linear", scope: "linear:team/team-1" }, acl, config("project"), "t")).toEqual({ kind: "project" });
  });

  it("an empty server ACL is not 'everyone'", () => {
    expect(ticketAudience(item, { principals: [], groups: [], strict: true }, config("project"), "t")).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
  });
});

describe("ticket recorder", () => {
  const base: TicketItem = { source: "jira", system: "jira:acme.atlassian.net", id: "issue:10001", kind: "ticket.created", scope: "jira:project/SHOP", title: "Cart total wrong", body: `Use ${AWS_KEY}`, occurredAt: daysAgo(1), version: "v1", authorId: "acc-1", url: "https://acme.atlassian.net/browse/SHOP-1" };

  it("records with trust from the linked author, redacted text and links only; an unknown or absent author is an outsider", async () => {
    const { w, recorder } = recorderWorld();
    w.config.set("jira", "jira:project/SHOP", { retention: "C" });
    expect(await recorder.record({ workspaceId: WS, project: "shop" }, base)).toBe("stored");
    await recorder.record({ workspaceId: WS, project: "shop" }, { ...base, id: "issue:2", authorId: "acc-9" });
    const noAuthor: TicketItem = { ...base };
    delete noAuthor.authorId;
    await recorder.record({ workspaceId: WS, project: "shop" }, { ...noAuthor, id: "issue:3" });
    expect(w.sink.puts.map((draft) => draft.trust)).toEqual(["member", "outsider", "outsider"]);
    expect(w.sink.puts[0]!.text).toContain("Cart total wrong");
    expect(w.sink.puts[0]!.text).not.toContain(AWS_KEY);
    expect(w.sink.puts[0]!.links).toEqual(["https://acme.atlassian.net/browse/SHOP-1"]);
    expect(w.sink.puts[0]!.retention).toBe("C");
  });

  it("skips with no source row, an excluded author or label, and never throws", async () => {
    const { w, recorder } = recorderWorld();
    expect(await recorder.record({ workspaceId: WS }, base)).toBe("skipped");
    w.config.set("jira", "jira:project/SHOP", { exclude: ["acc-1"] });
    expect(await recorder.record({ workspaceId: WS }, base)).toBe("skipped");
    w.config.set("jira", "jira:project/SHOP", { exclude: ["secret-project"] });
    expect(await recorder.record({ workspaceId: WS }, { ...base, labels: ["secret-project"] })).toBe("skipped");
    w.config.set("jira", "jira:project/SHOP");
    w.sink.failPut = true;
    expect(await recorder.record({ workspaceId: WS }, base)).toBe("failed");
  });
});

describe("Linear and Jira webhooks", () => {
  const linear = { organizationId: "11111111-1111-4111-8111-111111111111", teamId: "T-1" };
  const issue = (action: string, data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    type: "Issue", action, organizationId: linear.organizationId, webhookTimestamp: 1_761_800_000_000, actor: { id: "lin-user" },
    data: { id: "i1", identifier: "SHOP-1", title: "Cart total wrong", description: "Rounds badly", teamId: "T-1", state: { name: "In Progress" }, labels: [{ name: "bug" }], updatedAt: "2026-10-30T09:00:00.000Z", ...data }, ...over,
  });

  it("reads a Linear create, update, comment and removal", () => {
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create") })).toMatchObject({ changes: [{ id: "issue:i1", kind: "ticket.created", scope: "linear:team/t-1", state: "In Progress", labels: ["bug"], authorId: "lin-user", acl: { groups: ["t-1"], strict: false } }], removed: [] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("update") })).toMatchObject({ changes: [{ kind: "ticket.updated", version: "update:2026-10-30T09:00:00.000Z" }] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("remove") })).toEqual({ changes: [], removed: ["issue:i1"], system: "linear" });
    const comment = { type: "Comment", action: "create", organizationId: linear.organizationId, data: { id: "c1", body: "see PR", issueId: "i1", userId: "lin-2", updatedAt: "2026-10-30T09:30:00.000Z" } };
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: comment })).toMatchObject({ changes: [{ id: "comment:c1", kind: "ticket.comment", parentId: "issue:i1", authorId: "lin-2" }] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: { ...comment, action: "remove" } })).toMatchObject({ removed: ["comment:c1"] });
  });

  it("believes only the hook's own organization and team", () => {
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create", {}, { organizationId: "22222222-2222-4222-8222-222222222222" }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create", { teamId: "T-OTHER" }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: { nonsense: true } })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("archive") })).toEqual({ ignored: "action" });
  });

  const jira = { siteHost: "acme.atlassian.net", projectKey: "SHOP" };
  const jiraIssue = (event: string, fields: Record<string, unknown> = {}) => ({
    webhookEvent: event, timestamp: 1_761_800_000_000, user: { accountId: "acc-1" },
    issue: { id: "10001", key: "SHOP-1", self: "https://acme.atlassian.net/rest/api/3/issue/10001", fields: { summary: "Cart total wrong", project: { key: "SHOP" }, status: { name: "Open" }, labels: ["bug"], description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rounds " }, { type: "text", text: "badly" }] }] }, ...fields } },
  });

  it("reads Jira changes with ADF text, comments and deletions, for the hook's own site and project only", () => {
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated") })).toMatchObject({ system: "jira:acme.atlassian.net", changes: [{ id: "issue:10001", kind: "ticket.updated", scope: "jira:project/SHOP", body: "Rounds badly", url: "https://acme.atlassian.net/browse/SHOP-1", authorId: "acc-1" }] });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_deleted") })).toMatchObject({ removed: ["issue:10001"] });
    const comment = { ...jiraIssue("comment_created"), comment: { id: "55", body: "looks wrong", author: { accountId: "acc-2" }, updated: "2026-10-30T09:00:00.000Z", self: "https://acme.atlassian.net/rest/api/3/issue/10001/comment/55" } };
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: comment })).toMatchObject({ changes: [{ id: "comment:55", kind: "ticket.comment", parentId: "issue:10001", authorId: "acc-2", body: "looks wrong" }] });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: { ...comment, webhookEvent: "comment_deleted" } })).toMatchObject({ removed: ["comment:55"] });
    const foreign = jiraIssue("jira:issue_updated");
    foreign.issue.self = "https://evil.example.net/rest/api/3/issue/10001";
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: foreign })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated", { project: { key: "OTHER" } }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:worklog_updated") })).toEqual({ ignored: "event" });
  });

  it("reads ADF safely and bounded", () => {
    expect(adfText("plain")).toBe("plain");
    expect(adfText({ type: "doc", content: [] })).toBeUndefined();
    let deep: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 100; i += 1) deep = { type: "paragraph", content: [deep] };
    expect(adfText(deep)).toBeUndefined();
  });

  it("the tap records changes, removes deletions even with the row disabled, and never throws", async () => {
    const { w, recorder } = recorderWorld();
    const tap = createTicketWebhookTap({ recorder });
    w.config.set("linear", "linear:team/t-1", { retention: "C" });
    await tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("create") });
    expect(w.sink.puts).toHaveLength(1);
    expect(w.sink.puts[0]!.workspaceId).toBe(WS);
    w.config.set("linear", "linear:team/t-1", { enabled: false });
    await tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("remove") });
    expect(w.sink.tombstones).toMatchObject([{ system: "linear", sourceIds: ["issue:i1"], cause: "source_deleted" }]);
    w.sink.failPut = true;
    w.config.set("linear", "linear:team/t-1", {});
    await expect(tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("update") })).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------------------------------------------

const mapping: JsonListMapping = {
  itemsPath: "items", idField: "id", kind: "ticket.updated", titleField: "title", bodyField: "body", stateField: "status", urlField: "url", authorField: "owner", updatedField: "updated",
  aclPrincipalsField: "viewers", cursorPath: "next", args: { cursor: "page", since: "updated_since", limit: "limit", extra: { folder: "abc" } }, exists: { tool: "same", idArg: "id" },
  source: "mcp", system: "sim", scope: "mcp:sim/abc",
};
const source: McpPollSource = { workspaceId: WS, project: "shop", serverId: "sim", source: "mcp", scope: "mcp:sim/abc", readOnlyTools: ["list_tickets", "get_ticket"], listTool: "list_tickets", existsTool: "get_ticket", adapterId: "json" };
const answer = (items: unknown[], next?: string): PollToolResult => ({ content: [{ type: "text", text: JSON.stringify({ items, ...(next === undefined ? {} : { next }) }) }] });

class FakeServer implements PollConnection {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;
  tools: PollConnection["tools"] = [{ name: "list_tickets", annotations: { readOnlyHint: true } }, { name: "get_ticket" }, { name: "delete_ticket", annotations: { destructiveHint: true } }];
  handler: (name: string, args: Record<string, unknown>) => PollToolResult | Promise<PollToolResult> = () => answer([]);
  async call(name: string, args: Record<string, unknown>) { this.calls.push({ name, args }); return this.handler(name, args); }
  async close() { this.closed = true; }
}

class FakeState {
  value: PollState = { failures: 0, health: "ok", backfilled: 0, backfillDone: false };
  saves = 0;
  async load() { return this.value; }
  async save(_w: string, _s: string, _c: string, state: PollState) { this.value = state; this.saves += 1; }
}

function pollerWorld(over: { budget?: Partial<PollBudget> } = {}) {
  const { w, recorder } = recorderWorld();
  w.config.set("mcp", "mcp:sim/abc", { retention: "C" });
  const server = new FakeServer();
  const state = new FakeState();
  const deps = { mode: w.mode, config: w.config, recorder, state, connect: async () => server, adapters: { json: createJsonListAdapter(mapping) }, now: () => NOW, ...over };
  return { w, server, state, deps };
}
const row = (id: string, updated: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, body: "b", status: "open", url: `https://sim.example.com/${id}`, owner: "acc-1", updated, ...extra });

describe("MCP poller: read-only gate", () => {
  it("calls only allow-listed tools the server does not annotate against", () => {
    const server = new FakeServer();
    expect(checkReadOnlyTool(source, server, "list_tickets")).toEqual({ ok: true });
    expect(checkReadOnlyTool(source, server, "delete_ticket")).toEqual({ ok: false, reason: "not_allow_listed" });
    expect(checkReadOnlyTool({ readOnlyTools: ["delete_ticket"] }, server, "delete_ticket")).toEqual({ ok: false, reason: "annotated_not_read_only" });
    expect(checkReadOnlyTool({ readOnlyTools: ["ghost"] }, server, "ghost")).toEqual({ ok: false, reason: "not_listed_by_server" });
  });

  it("refuses a list tool that is not on the allow-list, makes no call, and counts a failure", async () => {
    const { server, state, deps } = pollerWorld();
    const outcome = await runMcpPoll(deps, { ...source, listTool: "delete_ticket" }, "poll");
    expect(outcome).toMatchObject({ status: "failed", reason: "not_allow_listed" });
    expect(server.calls).toEqual([]);
    expect(server.closed).toBe(true);
    expect(state.value.failures).toBe(1);
  });

  it("refuses a tool the server itself marks as not read-only even when the admin listed it", async () => {
    const { server, deps } = pollerWorld();
    server.tools = [{ name: "list_tickets", annotations: { readOnlyHint: false } }];
    expect(await runMcpPoll(deps, source, "poll")).toMatchObject({ status: "failed", reason: "annotated_not_read_only" });
    expect(server.calls).toEqual([]);
  });
});

describe("MCP poller: runs", () => {
  it("records items with the server's ACL, redacted text and trust from the linked author; the arguments carry cursor, since and a capped limit", async () => {
    const { w, server, deps } = pollerWorld();
    server.handler = () => answer([row("1", daysAgo(1), { body: `token ${AWS_KEY}`, viewers: ["acc-1", "acc-2"] }), row("2", daysAgo(2), { owner: "acc-unknown" })]);
    const outcome = await runMcpPoll(deps, source, "poll");
    expect(outcome).toEqual({ status: "ok", fetched: 2, recorded: 2, done: true });
    expect(w.sink.puts[0]).toMatchObject({ source: "mcp", trust: "member", audience: { kind: "restricted", acl: { principals: ["acc-1", "acc-2"], scope: "mcp:sim/abc" } }, sourceRef: { system: "sim", id: "1" } });
    expect(w.sink.puts[0]!.text).not.toContain(AWS_KEY);
    // No ACL from the server and no admin say-so: maintainers only.
    expect(w.sink.puts[1]).toMatchObject({ trust: "outsider", audience: { kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } } });
    expect(server.calls[0]!.args).toMatchObject({ folder: "abc", limit: 100 });
    expect(typeof server.calls[0]!.args.updated_since).toBe("string");
    expect(server.closed).toBe(true);
  });

  it("stops at 500 items a run and resumes from the cursor", async () => {
    const { w, server, state, deps } = pollerWorld();
    const page = (start: number) => answer(Array.from({ length: 100 }, (_, i) => row(String(start + i), daysAgo(1))), `c${start + 100}`);
    server.handler = (_name, args) => page(Number((typeof args.page === "string" ? args.page : "c0").slice(1)));
    const first = await runMcpPoll(deps, source, "poll");
    expect(first).toMatchObject({ status: "ok", fetched: 500, recorded: 500, done: false });
    expect(state.value.cursor).toBe("c500");
    expect(server.calls).toHaveLength(5);
    const second = await runMcpPoll(deps, source, "poll");
    expect(second.fetched).toBe(500);
    expect(server.calls[5]!.args.page).toBe("c500");
    expect(w.sink.puts).toHaveLength(1000);
  });

  it("is 'failing' after three failed runs, and a good run heals it", async () => {
    const { server, state, deps } = pollerWorld();
    server.handler = () => ({ isError: true, content: [{ type: "text", text: "boom" }] });
    for (let i = 0; i < 3; i += 1) await runMcpPoll(deps, source, "poll");
    expect(state.value).toMatchObject({ failures: 3, health: "failing" });
    server.handler = () => answer([row("1", daysAgo(1))]);
    await runMcpPoll(deps, source, "poll");
    expect(state.value).toMatchObject({ failures: 0, health: "ok" });
    expect(state.value.lastError).toBeUndefined();
  });

  it("an unreadable answer or a failed connect is a failure with a fixed reason, never the server's words", async () => {
    const { server, state, deps } = pollerWorld();
    server.handler = () => ({ content: [{ type: "text", text: "not json ".repeat(10) }] });
    expect(await runMcpPoll(deps, source, "poll")).toMatchObject({ status: "failed", reason: "unreadable_answer" });
    const down = await runMcpPoll({ ...deps, connect: async () => { throw new Error("secret endpoint text"); } }, source, "poll");
    expect(down).toMatchObject({ status: "failed", reason: "connect_failed" });
    expect(JSON.stringify(state.value)).not.toContain("secret endpoint text");
  });

  it("does nothing without a source row, and with the mode off", async () => {
    const { w, server, deps } = pollerWorld();
    w.mode.on = false;
    expect(await runMcpPoll(deps, source, "poll")).toMatchObject({ status: "skipped" });
    w.mode.on = true;
    w.config.rows.clear();
    expect(await runMcpPoll(deps, source, "poll")).toMatchObject({ status: "skipped" });
    expect(server.calls).toEqual([]);
  });

  it("jitters the 15 minute interval by at most ten percent", () => {
    expect(nextPollDelayMs(() => 0)).toBe(810_000);
    expect(nextPollDelayMs(() => 1)).toBe(990_000);
    expect(nextPollDelayMs(() => 0.5)).toBe(900_000);
  });
});

describe("backfill", () => {
  it("never records an item older than 180 days, whatever the server returns", async () => {
    const { w, server, deps } = pollerWorld();
    server.handler = () => answer([row("new", daysAgo(10)), row("old", daysAgo(181))]);
    const outcome = await runMcpPoll(deps, source, "backfill");
    expect(outcome).toMatchObject({ status: "ok", fetched: 2, recorded: 1 });
    expect(w.sink.puts.map((draft) => draft.sourceRef.id)).toEqual(["new"]);
  });

  it("stops at 5,000 items in total across runs and then reports done", async () => {
    const { server, state, deps } = pollerWorld({ budget: { itemsPerRun: 500, pagesPerRun: 20 } });
    let n = 0;
    server.handler = () => answer(Array.from({ length: 100 }, () => row(String(n += 1), daysAgo(1))), "more");
    for (let run = 0; run < 10; run += 1) await runMcpPoll(deps, source, "backfill");
    expect(state.value.backfilled).toBe(BACKFILL_MAX_ITEMS);
    expect(state.value.backfillDone).toBe(true);
    const callsBefore = server.calls.length;
    expect(await runMcpPoll(deps, source, "backfill")).toMatchObject({ status: "skipped", reason: "backfill_done", done: true });
    expect(server.calls).toHaveLength(callsBefore);
  });
});

describe("existence sweep", () => {
  function sweepWorld(ids: string[], verdicts: (id: string) => PollToolResult | Error) {
    const w = world();
    const server = new FakeServer();
    server.handler = (_name, args) => {
      const result = verdicts(String(args.id));
      if (result instanceof Error) throw result;
      return result;
    };
    let cursor: string | undefined;
    const rows: SweepRowsPort = {
      listSourceIds: async ({ after, limit }) => {
        const start = after === undefined ? 0 : ids.indexOf(after) + 1;
        const slice = ids.slice(start, start + limit);
        return { ids: slice, ...(start + slice.length < ids.length ? { next: slice[slice.length - 1]! } : {}) };
      },
      loadCursor: async () => cursor,
      saveCursor: async (_w, _s, next) => { cursor = next; },
    };
    const deps = { rows, sink: w.sink, connect: async () => server, adapters: { json: createJsonListAdapter(mapping) } };
    return { w, server, deps, cursor: () => cursor };
  }
  const found: PollToolResult = { content: [{ type: "text", text: JSON.stringify({ id: "x" }) }] };
  const gone: PollToolResult = { isError: true, content: [{ type: "text", text: "Ticket not found (404)" }] };

  it("tombstones what the server says is gone, and nothing else", async () => {
    const ids = ["issue:1", "issue:2", "issue:3", "issue:4"];
    const { w, server, deps } = sweepWorld(ids, (id) => (id === "2" || id === "4" ? gone : found));
    const outcome = await runExistenceSweep(deps, source);
    expect(outcome).toEqual({ status: "ok", checked: 4, tombstoned: 2 });
    expect(w.sink.tombstones).toEqual([{ workspaceId: WS, system: "sim", sourceIds: ["issue:2", "issue:4"], cause: "source_deleted" }]);
    expect(server.calls.map((call) => call.name)).toEqual(Array(4).fill("get_ticket"));
    expect(server.calls[0]!.args).toEqual({ folder: "abc", id: "1" });
  });

  it("an error, a timeout or an unclear answer is never a deletion, and ten unclear answers stop the run", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `issue:${i}`);
    const { w, deps } = sweepWorld(ids, (id) => (Number(id) % 2 === 0 ? new Error("timeout") : { isError: true, content: [{ type: "text", text: "500 internal" }] }));
    const outcome = await runExistenceSweep(deps, source);
    expect(outcome).toMatchObject({ status: "aborted", reason: "server_unclear", tombstoned: 0 });
    expect(outcome.checked).toBe(10);
    expect(w.sink.tombstones).toEqual([]);
  });

  it("is bounded at 2,000 checks a run and resumes next week from where it stopped", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `issue:${String(i).padStart(5, "0")}`);
    const { server, deps, cursor } = sweepWorld(ids, () => found);
    const first = await runExistenceSweep(deps, source);
    expect(first.checked).toBe(2000);
    expect(cursor()).toBe("issue:01999");
    const second = await runExistenceSweep(deps, source);
    expect(second.checked).toBe(500);
    expect(cursor()).toBeUndefined();
    expect(server.calls).toHaveLength(2500);
  });

  it("refuses an exists tool that is not on the allow-list, or no exists tool at all", async () => {
    const { server, deps } = sweepWorld(["issue:1"], () => found);
    expect(await runExistenceSweep(deps, { ...source, existsTool: "delete_ticket" })).toMatchObject({ status: "refused", reason: "not_allow_listed" });
    expect((await runExistenceSweep(deps, { ...source, readOnlyTools: ["list_tickets"] })).reason).toBe("not_allow_listed");
    const without: McpPollSource = { ...source };
    delete without.existsTool;
    expect(await runExistenceSweep(deps, without)).toMatchObject({ status: "refused", reason: "no_exists_tool" });
    expect(server.calls).toEqual([]);
  });
});
