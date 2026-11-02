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

function recorderWorld(options: { pollerChangesAttributed?: true } = {}) {
  const w = world();
  w.actors.members.set("acc-1", "dev-1");
  const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, ...options });
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

describe("per-editor rows: every change is its own row under the person who made it", () => {
  const base: TicketItem = { source: "jira", system: "jira:acme.atlassian.net", id: "issue:10001", kind: "ticket.created", scope: "jira:project/SHOP", title: "Cart total wrong", body: "line one by Priya", state: "Open", occurredAt: "2026-10-30T09:00:00.000Z", version: "created:1", authorId: "acc-1", updaterId: "acc-1", url: "https://acme.atlassian.net/browse/SHOP-1" };

  function twoMembers() {
    const { w, recorder } = recorderWorld();
    w.actors.members.set("acc-2", "dev-2");
    w.config.set("jira", "jira:project/SHOP", { retention: "C" });
    return { w, recorder };
  }

  it("a creation is its author's row; an edit is its EDITOR's row with only the lines they added; a status change carries no words", async () => {
    const { w, recorder } = twoMembers();
    expect(await recorder.record({ workspaceId: WS }, base)).toBe("stored");
    expect(await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", occurredAt: "2026-10-30T09:10:00.000Z", version: "updated:2", body: "line one by Priya\nline two by Sam", changed: { body: true }, previousBody: "line one by Priya" })).toBe("stored");
    expect(await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-1", occurredAt: "2026-10-30T09:20:00.000Z", version: "updated:3", state: "Done", changed: { state: true } })).toBe("stored");
    expect(w.sink.puts.map((draft) => [draft.actor?.sourceId, draft.actor?.developerId, draft.text, draft.structured?.state, draft.kind])).toStrictEqual([
      ["acc-1", "dev-1", "Cart total wrong\n\nline one by Priya", "Open", "ticket.created"],
      ["acc-2", "dev-2", "line two by Sam", undefined, "ticket.updated"],
      ["acc-1", "dev-1", undefined, "Done", "ticket.updated"],
    ]);
    // Each belongs to the item, in order, and none replaces another.
    expect(w.sink.puts.map((draft) => draft.sourceRef.id)).toStrictEqual(["issue:10001", "issue:10001", "issue:10001"]);
    expect(w.sink.puts.map((draft) => draft.sourceRef.order)).toStrictEqual([Date.parse("2026-10-30T09:00:00.000Z"), Date.parse("2026-10-30T09:10:00.000Z"), Date.parse("2026-10-30T09:20:00.000Z")]);
    expect(new Set(w.sink.puts.map((draft) => draft.sourceRef.version)).size).toBe(3);
  });

  it("nothing of the author's words is in the editor's row, nor the editor's in the author's; a title change is the words the editor added to the earlier title", async () => {
    const { w, recorder } = twoMembers();
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:2", title: "Cart total wrong off by a cent", previousTitle: "Cart total wrong", body: "line one by Priya", changed: { title: true, body: false } });
    expect(w.sink.puts).toHaveLength(1);
    expect(w.sink.puts[0]!.text).toBe("off by a cent");
    expect(JSON.stringify(w.sink.puts)).not.toContain("line one by Priya");
  });

  it("an edit whose earlier text is unknown keeps NO words (they may be someone else's); a rewrite with the earlier text known is the editor's own words", async () => {
    const { w, recorder } = twoMembers();
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:2", body: "line one by Priya\nline two by Sam", changed: { body: true } });
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:3", body: "h1. Wiki markup version", changed: { body: true }, previousBody: "line one by Priya" });
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:4", body: "all of it", occurredAt: "2026-10-30T09:40:00.000Z" });
    expect(w.sink.puts.map((draft) => draft.text)).toStrictEqual([undefined, "Wiki markup version", undefined]);
    expect(w.sink.puts.map((draft) => draft.structured?.changed)).toStrictEqual(["body", "body", "unknown"]);
  });

  it("B2: a one-word typo fix credits the editor with that word only, in the description and in the title; a title change with no earlier title keeps no words", async () => {
    const { w, recorder } = twoMembers();
    const paragraph = "The nightly export fails on Tuesday after the schema migration runs, so please rerun it by hand.";
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:2", title: "Cart total is wrong", previousTitle: "Cart total is wrnog", body: paragraph.replace("Tuesday", "Tuesdays"), previousBody: paragraph, changed: { title: true, body: true } });
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:3", title: "Totally new title", changed: { title: true } });
    expect(w.sink.puts.map((draft) => draft.text)).toStrictEqual(["wrong\n\nTuesdays", undefined]);
    expect(JSON.stringify(w.sink.puts)).not.toContain("nightly export");
  });

  it("a comment edited by its own author is that author's whole text only when nobody else edited it before (S2); edited by someone else with no earlier text it keeps none", async () => {
    const { w } = twoMembers();
    const others = { value: false };
    const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, priorEdits: { editedByOthers: async () => others.value } });
    const comment: TicketItem = { ...base, id: "comment:7", kind: "ticket.comment", edit: true, parentId: "issue:10001", body: "my comment, fixed", version: "comment_updated:1" };
    await recorder.record({ workspaceId: WS }, { ...comment, updaterId: "acc-1" });
    await recorder.record({ workspaceId: WS }, { ...comment, updaterId: "acc-2", version: "comment_updated:2" });
    await recorder.record({ workspaceId: WS }, { ...comment, updaterId: "acc-2", version: "comment_updated:3", previousBody: "my comment", body: "my comment\nSam added this" });
    others.value = true;
    await recorder.record({ workspaceId: WS }, { ...comment, updaterId: "acc-1", version: "comment_updated:4" });
    const failing = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, priorEdits: { editedByOthers: async () => { throw new Error("down"); } } });
    await failing.record({ workspaceId: WS }, { ...comment, updaterId: "acc-1", version: "comment_updated:5" });
    const none = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config });
    await none.record({ workspaceId: WS }, { ...comment, updaterId: "acc-1", version: "comment_updated:6" });
    expect(w.sink.puts.map((draft) => [draft.actor?.sourceId, draft.text])).toStrictEqual([["acc-1", "my comment, fixed"], ["acc-2", undefined], ["acc-2", "Sam added this"], ["acc-1", undefined], ["acc-1", undefined], ["acc-1", undefined]]);
  });

  it("S2: a comment edit skipped before anyone is looked at (no source row or capture off, an unproven parent, the poller's refusal) still marks the item, so the author's whole-comment credit stays withheld", async () => {
    const { w } = twoMembers();
    const marked: string[] = [];
    const priorEdits = { editedByOthers: async () => false, noteUnstored: async (input: { id: string }) => { marked.push(input.id); } };
    const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, priorEdits, parents: { isRecorded: async () => false } });
    const comment: TicketItem = { ...base, id: "comment:7", kind: "ticket.comment", edit: true, parentId: "issue:10001", body: "x", version: "comment_updated:1", updaterId: "acc-2" };
    // No source row for the scope (or capture off): the gate says no.
    expect(await recorder.record({ workspaceId: WS }, { ...comment, id: "comment:gate", scope: "jira:project/OTHER" })).toBe("skipped");
    // An unproven parent.
    expect(await recorder.record({ workspaceId: WS }, { ...comment, id: "comment:parent", needsParentProof: true })).toBe("skipped");
    // The poller's refusal.
    w.config.set("mcp", "mcp:sim/abc", { retention: "C" });
    expect(await recorder.record({ workspaceId: WS }, { ...comment, id: "comment:poller", source: "mcp", system: "sim", scope: "mcp:sim/abc" })).toBe("skipped");
    // A creation skipped for the same reasons marks nothing (there is no earlier edit to hide).
    expect(await recorder.record({ workspaceId: WS }, { ...comment, id: "comment:created", scope: "jira:project/OTHER", edit: false })).toBe("skipped");
    expect(marked).toStrictEqual(["comment:gate", "comment:parent", "comment:poller"]);
    expect(w.sink.puts).toStrictEqual([]);
  });

  it("the MCP poller's items are not stored until it can say who changed what", async () => {
    const { w } = twoMembers();
    w.config.set("mcp", "mcp:sim/abc", { retention: "C" });
    const item: TicketItem = { ...base, source: "mcp", system: "sim", scope: "mcp:sim/abc", kind: "ticket.updated", edit: true, updaterId: "acc-1", changed: { state: true } };
    const refusing = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config });
    expect(await refusing.record({ workspaceId: WS }, item)).toBe("skipped");
    expect(w.sink.puts).toStrictEqual([]);
    const attributed = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, pollerChangesAttributed: true });
    expect(await attributed.record({ workspaceId: WS }, item)).toBe("stored");
  });

  it("an unlinked editor's change is a draft with no developer (the sink refuses and counts it); an edit with no named editor has no actor at all", async () => {
    const { w, recorder } = twoMembers();
    await recorder.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-stranger", version: "updated:2", changed: { state: true } });
    const nobody: TicketItem = { ...base, kind: "ticket.updated", edit: true, version: "updated:3", changed: { state: true } };
    delete nobody.updaterId;
    await recorder.record({ workspaceId: WS }, nobody);
    expect(w.sink.puts.map((draft) => [draft.actor?.sourceId, draft.actor?.developerId, draft.trust])).toStrictEqual([["acc-stranger", undefined, "outsider"], [undefined, undefined, "outsider"]]);
  });

  it("a bot's change needs no linked person; an excluded editor's change is not recorded", async () => {
    const { w } = twoMembers();
    const bot = createTicketRecorder({ sink: w.sink, actors: { resolve: async (input) => (input.sourceId === "acc-bot" ? { trust: "system" } : w.actors.resolve(input)), resolveDeveloper: (input) => w.actors.resolveDeveloper(input) }, mode: w.mode, config: w.config });
    await bot.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-bot", version: "updated:2", changed: { state: true } });
    expect(w.sink.puts.map((draft) => draft.trust)).toStrictEqual(["system"]);
    w.config.set("jira", "jira:project/SHOP", { retention: "C", exclude: ["acc-2"] });
    expect(await bot.record({ workspaceId: WS }, { ...base, kind: "ticket.updated", edit: true, updaterId: "acc-2", version: "updated:3", changed: { state: true } })).toBe("skipped");
  });

  it("two people's changes at the same instant are two rows, and a redelivery of one is the same row", async () => {
    const { w, recorder } = twoMembers();
    const change = { ...base, kind: "ticket.updated" as const, edit: true, version: "updated:2", changed: { state: true } };
    await recorder.record({ workspaceId: WS }, { ...change, updaterId: "acc-1" });
    await recorder.record({ workspaceId: WS }, { ...change, updaterId: "acc-2" });
    expect(w.sink.puts).toHaveLength(2);
    expect(await recorder.record({ workspaceId: WS }, { ...change, updaterId: "acc-2" })).toBe("duplicate");
  });

  it("through the real webhook readers: Linear's updatedFrom and Jira's changelog give the changed fields and the old text; an update with neither keeps no words", async () => {
    const { w, recorder } = twoMembers();
    w.config.set("linear", "linear:team/t-1", { retention: "C" });
    w.actors.members.set("lin-priya", "dev-1");
    w.actors.members.set("lin-sam", "dev-2");
    const tap = createTicketWebhookTap({ recorder });
    const linearTenant = { organizationId: "11111111-1111-4111-8111-111111111111", teamId: "T-1" };
    const linearBody = (action: string, actor: string, description: string, at: string, extra: Record<string, unknown> = {}) => ({
      type: "Issue", action, organizationId: linearTenant.organizationId, actor: { id: actor }, ...extra,
      data: { id: "i1", title: "Cart", description, teamId: "T-1", creatorId: "lin-priya", updatedAt: at, state: { name: "Todo" } },
    });
    const send = (body: unknown) => tap({ source: "linear", orgId: WS, project: "shop", tenant: linearTenant, body });
    await send(linearBody("create", "lin-priya", "Priya wrote this", "2026-10-30T09:00:00.000Z"));
    await send(linearBody("update", "lin-sam", "Priya wrote this\nSam added that", "2026-10-30T09:10:00.000Z", { updatedFrom: { description: "Priya wrote this", updatedAt: "x" } }));
    await send(linearBody("update", "lin-priya", "Priya wrote this\nSam added that", "2026-10-30T09:20:00.000Z"));
    expect(w.sink.puts.map((draft) => [draft.actor?.sourceId, draft.text])).toStrictEqual([["lin-priya", "Cart\n\nPriya wrote this"], ["lin-sam", "Sam added that"], ["lin-priya", undefined]]);

    const jiraEvent = (user: string, at: number, kind: string, extra: Record<string, unknown> = {}) => ({
      webhookEvent: kind, timestamp: at, user: { accountId: user }, ...extra,
      issue: { id: "10001", key: "SHOP-1", self: "https://acme.atlassian.net/rest/api/3/issue/10001", fields: { summary: "Cart", description: "Priya line\nSam line", project: { key: "SHOP" }, creator: { accountId: "acc-1" }, status: { name: "In Progress" } } },
    });
    const sendJira = (body: unknown) => tap({ source: "jira", orgId: WS, project: "shop", tenant: { siteHost: "acme.atlassian.net", projectKey: "SHOP" }, body });
    await sendJira(jiraEvent("acc-2", 1_761_800_100_000, "jira:issue_updated", { changelog: { items: [{ field: "description", fromString: "Priya line", toString: "Priya line\nSam line" }, { field: "status", fromString: "Open", toString: "In Progress" }] } }));
    const row = w.sink.puts.filter((draft) => draft.source === "jira").map((draft) => [draft.actor?.sourceId, draft.text, draft.structured?.state, draft.structured?.changed]);
    expect(row).toStrictEqual([["acc-2", "Sam line", "In Progress", "body,state"]]);
  });

  it("B1: a Jira description edit compares the changelog's old and new text (both wiki markup), so the author's formatted lines are never credited to the editor", async () => {
    const { w, recorder } = twoMembers();
    const tap = createTicketWebhookTap({ recorder });
    const event = (user: string, at: number, kind: string, fields: Record<string, unknown>, changelog?: unknown) => ({
      webhookEvent: kind, timestamp: at, user: { accountId: user }, ...(changelog === undefined ? {} : { changelog }),
      issue: { id: "10001", key: "SHOP-1", self: "https://acme.atlassian.net/rest/api/3/issue/10001", fields: { summary: "Cart", project: { key: "SHOP" }, creator: { accountId: "acc-1" }, ...fields } },
    });
    const send = (body: unknown) => tap({ source: "jira", orgId: WS, project: "shop", tenant: { siteHost: "acme.atlassian.net", projectKey: "SHOP" }, body });
    const wiki = "h2. Context\n* Priya secret plan item\nplain line";
    // The fields carry Atlassian Document Format (flattened to plain text, no markup); the changelog carries wiki markup, both before and after.
    const adf = { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Context" }] }, { type: "paragraph", content: [{ type: "text", text: "Priya secret plan item" }] }, { type: "paragraph", content: [{ type: "text", text: "plain line" }] }, { type: "paragraph", content: [{ type: "text", text: "Sam line" }] }] };
    await send(event("acc-2", 1_761_800_100_000, "jira:issue_updated", { description: adf }, { items: [{ field: "description", fromString: wiki, toString: `${wiki}\nSam line` }] }));
    const row = w.sink.puts.filter((draft) => draft.source === "jira");
    expect(row.map((draft) => draft.text)).toStrictEqual(["Sam line"]);
    expect(JSON.stringify(row)).not.toContain("secret plan");
    // No `toString` in the changelog item: nothing to compare, so no words are kept (the plain-text field is never compared with the wiki text).
    await send(event("acc-2", 1_761_800_200_000, "jira:issue_updated", { description: adf }, { items: [{ field: "description", fromString: wiki }] }));
    expect(w.sink.puts.filter((draft) => draft.source === "jira").map((draft) => draft.text)).toStrictEqual(["Sam line", undefined]);
    // A summary change: the words added to the old summary, from the same changelog item.
    await send(event("acc-2", 1_761_800_300_000, "jira:issue_updated", { summary: "Cart total" }, { items: [{ field: "summary", fromString: "Cart", toString: "Cart total" }] }));
    expect(w.sink.puts.filter((draft) => draft.source === "jira").map((draft) => draft.text).at(-1)).toBe("total");
  });

  it("an MCP mapping credits the author field and the updater field", () => {
    const adapter = createJsonListAdapter({ ...mapping, authorField: "creator", updaterField: "modified_by" });
    const parsed = adapter.parseList(answer([{ id: "1", title: "t", creator: "acc-outsider", modified_by: "acc-1", updated: daysAgo(1) }]));
    expect(parsed!.items[0]).toMatchObject({ authorId: "acc-outsider", updaterId: "acc-1", nativeId: "1", edit: true });
  });
});

describe("a Jira comment inherits its issue's restriction (M-a)", () => {
  const jiraTenant = { siteHost: "acme.atlassian.net", projectKey: "SHOP" };
  const issueEvent = (id: string, security: unknown) => ({ webhookEvent: "jira:issue_created", timestamp: 1_761_800_000_000, user: { accountId: "acc-1" }, issue: { id, key: `SHOP-${id}`, self: `https://acme.atlassian.net/rest/api/3/issue/${id}`, fields: { summary: "s", project: { key: "SHOP" }, creator: { accountId: "acc-1" }, ...(security === undefined ? {} : { security }) } } });
  // The comment webhook's issue has the reduced fields Jira really sends: no security level.
  const commentEvent = (issueId: string, extra: Record<string, unknown> = {}) => ({
    webhookEvent: "comment_created", timestamp: 1_761_800_100_000, user: { accountId: "acc-1" },
    issue: { id: issueId, key: `SHOP-${issueId}`, self: `https://acme.atlassian.net/rest/api/3/issue/${issueId}`, fields: { project: { key: "SHOP" } } },
    comment: { id: `c${issueId}`, body: "internal detail", author: { accountId: "acc-1" }, self: `https://acme.atlassian.net/rest/api/3/issue/${issueId}/comment/c`, ...extra },
  });

  function parentWorld() {
    const { w } = recorderWorld();
    w.config.set("jira", "jira:project/SHOP", { retention: "C", audienceDefault: "project" });
    // The record's view of recorded parents: open only when stored with restricted === false.
    const parents = {
      isRecorded: async ({ id }: { id: string }) => w.sink.puts.some((draft) => draft.sourceRef.id === id),
      isOpen: async ({ id }: { id: string }) => w.sink.puts.some((draft) => draft.sourceRef.id === id && draft.structured?.restricted === false),
    };
    const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, parents });
    const tap = createTicketWebhookTap({ recorder });
    const send = (body: unknown) => tap({ source: "jira", orgId: WS, project: "shop", tenant: jiraTenant, body });
    return { w, send, recorder };
  }
  const commentRow = (w: ReturnType<typeof world>) => w.sink.puts.find((draft) => draft.kind === "ticket.comment")!;

  it("a comment on a restricted issue is maintainers-only, never project-wide, even under 'visible to all project members'", async () => {
    const { w, send } = parentWorld();
    await send(issueEvent("1", { id: "10", name: "Staff only" }));
    await send(commentEvent("1"));
    expect(w.sink.puts.find((draft) => draft.sourceRef.id === "issue:1")!.audience).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
    expect(commentRow(w).audience).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
    expect(commentRow(w).structured).toMatchObject({ restricted: true });
  });

  it("a comment on a known-open issue follows the project default", async () => {
    const { w, send } = parentWorld();
    await send(issueEvent("2", undefined));
    await send(commentEvent("2"));
    expect(commentRow(w).audience).toEqual({ kind: "project" });
    expect(commentRow(w).structured).toMatchObject({ restricted: false });
  });

  it("fails closed when the parent's level is unknown: parent not recorded, lookup failing, or no way to look it up", async () => {
    const unrecorded = parentWorld();
    await unrecorded.send(commentEvent("3"));
    expect(commentRow(unrecorded.w).audience).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
    const w = world();
    w.config.set("jira", "jira:project/SHOP", { retention: "C", audienceDefault: "project" });
    for (const parents of [undefined, { isRecorded: async () => true }, { isRecorded: async () => true, isOpen: async (): Promise<boolean> => { throw new Error("down"); } }]) {
      const recorder = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, ...(parents === undefined ? {} : { parents }) });
      await createTicketWebhookTap({ recorder })({ source: "jira", orgId: WS, project: "shop", tenant: jiraTenant, body: commentEvent(`9${String(w.sink.puts.length)}`) });
    }
    expect(w.sink.puts).toHaveLength(3);
    for (const draft of w.sink.puts) expect(draft.audience).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
  });

  it("a comment limited to a role or group is restricted even on an open issue", async () => {
    const { w, send } = parentWorld();
    await send(issueEvent("4", undefined));
    await send(commentEvent("4", { visibility: { type: "group", value: "jira-administrators" } }));
    expect(commentRow(w).audience).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
  });
});

describe("ticket scope proof and security levels (I8)", () => {
  it("a comment that names no team is recorded only when its ticket is already recorded under the scope", async () => {
    const { w, recorder } = recorderWorld();
    w.config.set("linear", "linear:team/t-1", { retention: "C" });
    const known = new Set<string>();
    const withParents = createTicketRecorder({ sink: w.sink, actors: w.actors, mode: w.mode, config: w.config, parents: { isRecorded: async ({ id, scope }) => scope === "linear:team/t-1" && known.has(id) } });
    const comment: TicketItem = { source: "linear", system: "linear", id: "comment:c1", kind: "ticket.comment", scope: "linear:team/t-1", parentId: "issue:i1", body: "hi", occurredAt: daysAgo(1), version: "create:1", authorId: "acc-1", needsParentProof: true };
    expect(await withParents.record({ workspaceId: WS }, comment)).toBe("skipped");
    expect(await recorder.record({ workspaceId: WS }, comment)).toBe("skipped");
    known.add("issue:i1");
    expect(await withParents.record({ workspaceId: WS }, comment)).toBe("stored");
    expect(w.sink.puts).toHaveLength(1);
  });

  it("a restricted item gets the maintainers audience even when the admin widened the project default", () => {
    const config = { enabled: true, retention: "D" as const, exclude: [], audienceDefault: "project" as const };
    expect(ticketAudience({ source: "jira", scope: "jira:project/SHOP", restricted: true }, { groups: ["SHOP"], strict: false }, config, "t")).toMatchObject({ kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } });
    expect(ticketAudience({ source: "jira", scope: "jira:project/SHOP" }, { groups: ["SHOP"], strict: false }, config, "t")).toEqual({ kind: "project" });
  });

  it("end to end: a Jira issue with a security level is recorded for maintainers only under 'visible to all project members'", async () => {
    const { w, recorder } = recorderWorld();
    w.config.set("jira", "jira:project/SHOP", { retention: "C", audienceDefault: "project" });
    const tap = createTicketWebhookTap({ recorder });
    const issue = (security: unknown) => ({ webhookEvent: "jira:issue_created", timestamp: 1_761_800_000_000, user: { accountId: "acc-1" }, issue: { id: security === null ? "1" : "2", key: "SHOP-1", self: "https://acme.atlassian.net/rest/api/3/issue/1", fields: { summary: "s", project: { key: "SHOP" }, creator: { accountId: "acc-1" }, security } } });
    await tap({ source: "jira", orgId: WS, project: "shop", tenant: { siteHost: "acme.atlassian.net", projectKey: "SHOP" }, body: issue(null) });
    await tap({ source: "jira", orgId: WS, project: "shop", tenant: { siteHost: "acme.atlassian.net", projectKey: "SHOP" }, body: issue({ id: "10", name: "Staff" }) });
    expect(w.sink.puts.map((draft) => draft.audience)).toMatchObject([{ kind: "project" }, { kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } }]);
  });
});

describe("Linear and Jira webhooks", () => {
  const linear = { organizationId: "11111111-1111-4111-8111-111111111111", teamId: "T-1" };
  const issue = (action: string, data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    type: "Issue", action, organizationId: linear.organizationId, webhookTimestamp: 1_761_800_000_000, actor: { id: "lin-user" },
    data: { id: "i1", identifier: "SHOP-1", title: "Cart total wrong", description: "Rounds badly", teamId: "T-1", creatorId: "lin-creator", state: { name: "In Progress" }, labels: [{ name: "bug" }], updatedAt: "2026-10-30T09:00:00.000Z", ...data }, ...over,
  });

  it("reads a Linear create, update, comment and removal", () => {
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create") })).toMatchObject({ changes: [{ id: "issue:i1", kind: "ticket.created", scope: "linear:team/t-1", state: "In Progress", labels: ["bug"], authorId: "lin-creator", updaterId: "lin-user", nativeId: "i1", acl: { groups: ["t-1"], strict: false } }], removed: [] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("update") })).toMatchObject({ changes: [{ kind: "ticket.updated", version: "update:2026-10-30T09:00:00.000Z" }] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("remove") })).toEqual({ changes: [], removed: ["issue:i1"], system: "linear" });
    const comment = { type: "Comment", action: "create", organizationId: linear.organizationId, data: { id: "c1", body: "see PR", issueId: "i1", userId: "lin-2", updatedAt: "2026-10-30T09:30:00.000Z" } };
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: comment })).toMatchObject({ changes: [{ id: "comment:c1", kind: "ticket.comment", parentId: "issue:i1", authorId: "lin-2", needsParentProof: true }] });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: { ...comment, action: "remove" } })).toMatchObject({ removed: ["comment:c1"] });
  });

  it("believes only the hook's own organization and team", () => {
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create", {}, { organizationId: "22222222-2222-4222-8222-222222222222" }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("create", { teamId: "T-OTHER" }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: { nonsense: true } })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: issue("archive") })).toEqual({ ignored: "action" });
    // An issue that names no team proves nothing about its team (an org-wide hook carries other teams' issues): not recorded.
    const teamless = issue("create");
    delete (teamless.data as Record<string, unknown>).teamId;
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: teamless })).toEqual({ ignored: "tenant_unproven" });
    // A comment that names another team through its issue is not ours either.
    const foreign = { type: "Comment", action: "create", organizationId: linear.organizationId, data: { id: "c9", body: "x", issue: { id: "i9", teamId: "T-OTHER" }, userId: "u" } };
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: foreign })).toEqual({ ignored: "tenant" });
    const proven = { ...foreign, data: { ...foreign.data, issue: { id: "i9", teamId: "T-1" } } };
    expect(ticketsOfWebhook({ source: "linear", tenant: linear, body: proven })).toMatchObject({ changes: [{ id: "comment:c9" }] });
    expect((ticketsOfWebhook({ source: "linear", tenant: linear, body: proven }) as { changes: Array<{ needsParentProof?: boolean }> }).changes[0]!.needsParentProof).toBeUndefined();
  });

  const jira = { siteHost: "acme.atlassian.net", projectKey: "SHOP" };
  const jiraIssue = (event: string, fields: Record<string, unknown> = {}) => ({
    webhookEvent: event, timestamp: 1_761_800_000_000, user: { accountId: "acc-1" },
    issue: { id: "10001", key: "SHOP-1", self: "https://acme.atlassian.net/rest/api/3/issue/10001", fields: { summary: "Cart total wrong", creator: { accountId: "acc-creator" }, project: { key: "SHOP" }, status: { name: "Open" }, labels: ["bug"], description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rounds " }, { type: "text", text: "badly" }] }] }, ...fields } },
  });

  it("reads Jira changes with ADF text, comments and deletions, for the hook's own site and project only", () => {
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated") })).toMatchObject({ system: "jira:acme.atlassian.net", changes: [{ id: "issue:10001", kind: "ticket.updated", scope: "jira:project/SHOP", url: "https://acme.atlassian.net/browse/SHOP-1", authorId: "acc-creator", updaterId: "acc-1", nativeId: "10001" }] });
    // An update keeps no description of its own unless the changelog gives the new text in the format of the old (B1).
    expect((ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated") }) as { changes: Array<{ body?: string }> }).changes[0]!.body).toBeUndefined();
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_deleted") })).toMatchObject({ removed: ["issue:10001"] });
    const comment = { ...jiraIssue("comment_created"), comment: { id: "55", body: "looks wrong", author: { accountId: "acc-2" }, updated: "2026-10-30T09:00:00.000Z", self: "https://acme.atlassian.net/rest/api/3/issue/10001/comment/55" } };
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: comment })).toMatchObject({ changes: [{ id: "comment:55", kind: "ticket.comment", parentId: "issue:10001", authorId: "acc-2", body: "looks wrong" }] });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: { ...comment, webhookEvent: "comment_deleted" } })).toMatchObject({ removed: ["comment:55"] });
    const foreign = jiraIssue("jira:issue_updated");
    foreign.issue.self = "https://evil.example.net/rest/api/3/issue/10001";
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: foreign })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated", { project: { key: "OTHER" } }) })).toEqual({ ignored: "tenant" });
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:worklog_updated") })).toEqual({ ignored: "event" });
    // A project-scoped hook believes only a body that names that project: a comment event without its issue proves nothing.
    const bare: Record<string, unknown> = { ...comment };
    delete bare.issue;
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: bare })).toEqual({ ignored: "tenant" });
  });

  it("marks an issue with a security level as restricted, and one whose fields are unknown", () => {
    const open = ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated") }) as { changes: Array<{ restricted?: boolean }> };
    expect(open.changes[0]!.restricted).toBeUndefined();
    const secret = ticketsOfWebhook({ source: "jira", tenant: jira, body: jiraIssue("jira:issue_updated", { security: { id: "10", name: "Staff only" } }) }) as { changes: Array<{ restricted?: boolean }> };
    expect(secret.changes[0]!.restricted).toBe(true);
    const noFields = { ...jiraIssue("comment_created"), comment: { id: "55", body: "x", author: { accountId: "a" }, self: "https://acme.atlassian.net/c" } };
    (noFields.issue as Record<string, unknown>).fields = undefined;
    // A comment's reduced issue fields prove nothing either way: it inherits its parent's restriction at the recorder.
    expect(ticketsOfWebhook({ source: "jira", tenant: { siteHost: "acme.atlassian.net" }, body: noFields })).toMatchObject({ changes: [{ inheritsRestriction: true }] });
    const limited = { ...jiraIssue("comment_created"), comment: { id: "56", body: "x", author: { accountId: "a" }, visibility: { type: "role", value: "Developers" }, self: "https://acme.atlassian.net/c" } };
    expect(ticketsOfWebhook({ source: "jira", tenant: jira, body: limited })).toMatchObject({ changes: [{ restricted: true, inheritsRestriction: true }] });
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
    await tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("create", {}, { actor: { id: "lin-creator" } }) });
    expect(w.sink.puts).toHaveLength(1);
    expect(w.sink.puts[0]!.workspaceId).toBe(WS);
    w.config.set("linear", "linear:team/t-1", { enabled: false });
    await tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("remove") });
    expect(w.sink.tombstones).toMatchObject([{ system: "linear", sourceIds: ["issue:i1"], cause: "source_deleted" }]);
    w.sink.failPut = true;
    w.config.set("linear", "linear:team/t-1", {});
    await expect(tap({ source: "linear", orgId: WS, project: "shop", tenant: linear, body: issue("update", {}, { actor: { id: "lin-creator" } }) })).resolves.toBeUndefined();
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
  // The poller's plumbing is tested with a recorder that accepts its items; a production recorder does not (it cannot yet say who changed what).
  const { w, recorder } = recorderWorld({ pollerChangesAttributed: true });
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
    // A poll sees the item as it is now, not who changed what: with no "modified by" field the change has no person, so it is an outsider's draft (the sink stores nothing without a linked person).
    expect(w.sink.puts[0]).toMatchObject({ source: "mcp", trust: "outsider", audience: { kind: "restricted", acl: { principals: ["acc-1", "acc-2"], scope: "mcp:sim/abc" } }, sourceRef: { system: "sim", id: "1" } });
    expect(JSON.stringify(w.sink.puts[0])).not.toContain(AWS_KEY);
    // No ACL from the server and no admin say-so: maintainers only.
    expect(w.sink.puts[1]).toMatchObject({ trust: "outsider", audience: { kind: "restricted", acl: { groups: [MAINTAINERS_GROUP] } } });
    expect(server.calls[0]!.args).toMatchObject({ folder: "abc", limit: 100 });
    // A first poll starts at "now": history is the backfill's job, never a poll's.
    expect(server.calls[0]!.args.updated_since).toBe(new Date(NOW).toISOString());
    expect(server.closed).toBe(true);
  });

  it("stops at 500 items a run and resumes from the cursor", async () => {
    const { w, server, state, deps } = pollerWorld();
    const page = (start: number) => answer(Array.from({ length: 100 }, (_, i) => row(String(start + i), daysAgo(1))), `c${start + 100}`);
    server.handler = (_name, args) => page(Number((typeof args.page === "string" ? args.page : "c0").slice(1)));
    const first = await runMcpPoll(deps, source, "poll");
    expect(first).toMatchObject({ status: "ok", fetched: 500, recorded: 500, done: false });
    expect(state.value.pollCursor).toBe("c500");
    expect(state.value.backfillCursor).toBeUndefined();
    expect(server.calls).toHaveLength(5);
    const second = await runMcpPoll(deps, source, "poll");
    expect(second.fetched).toBe(500);
    expect(server.calls[5]!.args.page).toBe("c500");
    expect(w.sink.puts).toHaveLength(1000);
  });

  it("keeps the poll's cursor and the backfill's apart, and the poll resumes from the watermark of a finished run", async () => {
    const { server, state, deps } = pollerWorld();
    server.handler = () => answer([row("1", daysAgo(0.5))], "more");
    await runMcpPoll(deps, source, "backfill");
    expect(state.value).toMatchObject({ backfillCursor: "more" });
    expect(state.value.pollCursor).toBeUndefined();
    server.handler = () => answer([row("2", daysAgo(0.25))]);
    await runMcpPoll(deps, source, "poll");
    expect(state.value.backfillCursor).toBe("more");
    expect(state.value.watermark).toBe(daysAgo(0.25));
    await runMcpPoll(deps, source, "poll");
    expect(server.calls[server.calls.length - 1]!.args.updated_since).toBe(daysAgo(0.25));
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

describe("existence answers", () => {
  const adapter = createJsonListAdapter(mapping);
  const err = (text: string): PollToolResult => ({ isError: true, content: [{ type: "text", text }] });
  it("tells a refusal from a real not-found, and checks the refusal first", () => {
    expect(adapter.classifyExists(err("Ticket not found (404)"))).toBe("missing");
    expect(adapter.classifyExists(err("403 Forbidden"))).toBe("forbidden");
    expect(adapter.classifyExists(err("You do not have permission to view this item"))).toBe("forbidden");
    expect(adapter.classifyExists(err("403: ticket not found for this user"))).toBe("forbidden");
    expect(adapter.classifyExists(err("internal error"))).toBe("unknown");
    // An id that merely contains 403 is not a refusal.
    expect(adapter.classifyExists(err("Ticket SIM-4031 not found"))).toBe("missing");
    expect(adapter.classifyExists({ content: [{ type: "text", text: "{}" }] })).toBe("exists");
  });
  it("an admin-supplied phrase is plain text, never a pattern", () => {
    const custom = createJsonListAdapter({ ...mapping, exists: { tool: "same", idArg: "id", notFoundText: ["(a+)+$"] } });
    expect(custom.classifyExists(err("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"))).toBe("unknown");
    expect(custom.classifyExists(err("the thing (a+)+$ happened"))).toBe("missing");
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
  interface Row { id: string; nativeId: string; kind: string }
  const ticket = (n: number | string, nativeId?: string): Row => ({ id: `issue:${String(n)}`, nativeId: nativeId ?? String(n), kind: "ticket.updated" });
  function sweepWorld(rows: Row[], verdicts: (nativeId: string) => PollToolResult | Error) {
    const w = world();
    const server = new FakeServer();
    server.handler = (_name, args) => {
      const result = verdicts(String(args.id));
      if (result instanceof Error) throw result;
      return result;
    };
    let cursor: string | undefined;
    const rowsPort: SweepRowsPort = {
      listRows: async ({ after, limit }) => {
        const start = after === undefined ? 0 : Number(after);
        const slice = rows.slice(start, start + limit);
        return { rows: slice, ...(start + slice.length < rows.length ? { next: String(start + slice.length) } : {}) };
      },
      recentRow: async (_w, _s, kinds) => [...rows].reverse().find((row) => kinds.includes(row.kind)),
      loadCursor: async () => cursor,
      saveCursor: async (_w, _s, next) => { cursor = next; },
    };
    const deps = { rows: rowsPort, sink: w.sink, connect: async () => server, adapters: { json: createJsonListAdapter(mapping) } };
    return { w, server, deps, cursor: () => cursor };
  }
  const found: PollToolResult = { content: [{ type: "text", text: JSON.stringify({ id: "x" }) }] };
  const gone: PollToolResult = { isError: true, content: [{ type: "text", text: "Ticket not found (404)" }] };

  it("tombstones what the server says is gone, by our record id, asking with the source's own id", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ticket(i + 1));
    const { w, server, deps } = sweepWorld(rows, (id) => (id === "2" ? gone : found));
    const outcome = await runExistenceSweep(deps, source);
    expect(outcome).toEqual({ status: "ok", checked: 12, tombstoned: 1 });
    expect(w.sink.tombstones).toEqual([{ workspaceId: WS, system: "sim", sourceIds: ["issue:2"], cause: "source_deleted" }]);
    expect(server.calls[server.calls.length - 1]!.name).toBe("get_ticket");
    expect(server.calls.map((call) => call.args.id)).toContain("2");
  });

  it("asks with ids that contain colons exactly as the source gave them", async () => {
    const rows = [ticket("urn-1", "urn:sim:ticket:123"), ...Array.from({ length: 9 }, (_, i) => ticket(i + 2))];
    const { w, server, deps } = sweepWorld(rows, (id) => (id.startsWith("urn:sim:ticket:") || /^\d+$/.test(id) ? found : gone));
    expect(await runExistenceSweep(deps, source)).toMatchObject({ status: "ok", tombstoned: 0 });
    expect(server.calls.map((call) => call.args.id)).toContain("urn:sim:ticket:123");
    expect(w.sink.tombstones).toEqual([]);
  });

  it("checks only the kinds the exists tool can fetch, never a comment", async () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => ticket(i + 1)), { id: "comment:9", nativeId: "9", kind: "ticket.comment" }];
    const { server, deps } = sweepWorld(rows, () => found);
    expect((await runExistenceSweep(deps, source)).checked).toBe(6);
    expect(server.calls.map((call) => call.args.id)).not.toContain("9");
  });

  it("a refused credential never erases history: the canary, a refusal mid-run and 'everything is gone' all stop the run with nothing deleted", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ticket(i + 1));
    // The canary (the newest row) is refused: the credential was narrowed.
    const narrowed = sweepWorld(rows, () => gone);
    expect(await runExistenceSweep(narrowed.deps, source)).toMatchObject({ status: "aborted", reason: "canary_failed", tombstoned: 0 });
    expect(narrowed.w.sink.tombstones).toEqual([]);
    // The server answers 'not found' for the whole page but still finds the canary: more than 20% gone is not believed.
    const mass = sweepWorld(rows, (id) => (id === "40" ? found : gone));
    expect(await runExistenceSweep(mass.deps, source)).toMatchObject({ status: "aborted", reason: "mass_missing", tombstoned: 0 });
    expect(mass.w.sink.tombstones).toEqual([]);
    // A refusal in the middle stops the run at once.
    const refusedMid = sweepWorld(rows, (id) => (id === "40" ? found : id === "3" ? { isError: true, content: [{ type: "text", text: "403 Forbidden" }] } : found));
    expect(await runExistenceSweep(refusedMid.deps, source)).toMatchObject({ status: "aborted", reason: "credential_refused", tombstoned: 0 });
  });

  it("a narrowed credential cannot erase a small source: comment-first rows, 4 of 4 'not found' (the review's probe)", async () => {
    const rows = [...Array.from({ length: 4 }, (_, i) => ticket(i + 1)), { id: "comment:9", nativeId: "9", kind: "ticket.comment" }];
    const { w, deps } = sweepWorld(rows, () => gone);
    // The newest row is a comment: the canary is the newest TICKET, and it is refused, so nothing is deleted.
    expect(await runExistenceSweep(deps, source)).toMatchObject({ status: "aborted", reason: "canary_failed", tombstoned: 0 });
    expect(w.sink.tombstones).toEqual([]);
  });

  it("a row port that hands back a comment as the canary is not believed", async () => {
    const rows = [...Array.from({ length: 4 }, (_, i) => ticket(i + 1)), { id: "comment:9", nativeId: "9", kind: "ticket.comment" }];
    const { w, deps } = sweepWorld(rows, () => gone);
    const careless = { ...deps, rows: { ...deps.rows, recentRow: async () => rows[rows.length - 1] } };
    expect(await runExistenceSweep(careless, source)).toMatchObject({ status: "aborted", reason: "no_canary" });
    expect(w.sink.tombstones).toEqual([]);
  });

  it("no ticket row at all is no canary and no sweep", async () => {
    const { w, server, deps } = sweepWorld([{ id: "comment:9", nativeId: "9", kind: "ticket.comment" }], () => gone);
    expect(await runExistenceSweep(deps, source)).toMatchObject({ status: "aborted", reason: "no_canary" });
    expect(server.calls).toEqual([]);
    expect(w.sink.tombstones).toEqual([]);
  });

  it("even with a passing canary, a small run tombstones at most one item and a big one at most 20%, counted over the whole run", async () => {
    const small = Array.from({ length: 4 }, (_, i) => ticket(i + 1));
    const a = sweepWorld(small, (id) => (id === "4" ? found : gone));
    expect(await runExistenceSweep(a.deps, source)).toMatchObject({ status: "aborted", reason: "mass_missing", tombstoned: 0 });
    const oneGone = sweepWorld(small, (id) => (id === "1" ? gone : found));
    expect(await runExistenceSweep(oneGone.deps, source)).toMatchObject({ status: "ok", tombstoned: 1 });
    // Pages of 100: 30 gone, all on the first page (30% of that page), is 12% of the 250-row run and passes; 60 of 250 is 24% and fails.
    const big = Array.from({ length: 250 }, (_, i) => ticket(i + 1));
    const ok = sweepWorld(big, (id) => (Number(id) <= 30 ? gone : found));
    expect(await runExistenceSweep(ok.deps, source)).toMatchObject({ status: "ok", tombstoned: 30 });
    const bad = sweepWorld(big, (id) => (Number(id) <= 60 ? gone : found));
    expect(await runExistenceSweep(bad.deps, source)).toMatchObject({ status: "aborted", reason: "mass_missing", tombstoned: 0 });
    expect(bad.w.sink.tombstones).toEqual([]);
  });

  it("nothing is tombstoned before the whole run is read: an abort later in the run leaves earlier 'gone' answers untouched", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ticket(i + 1));
    const { w, deps } = sweepWorld(rows, (id) => (id === "3" ? gone : id === "200" ? { isError: true, content: [{ type: "text", text: "403 Forbidden" }] } : found));
    expect(await runExistenceSweep(deps, source)).toMatchObject({ status: "aborted", reason: "credential_refused", tombstoned: 0 });
    expect(w.sink.tombstones).toEqual([]);
  });

  it("an error, a timeout or an unclear answer is never a deletion, and ten unclear answers stop the run", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ticket(i));
    const { w, deps } = sweepWorld(rows, (id) => (id === "29" ? found : Number(id) % 2 === 0 ? new Error("timeout") : { isError: true, content: [{ type: "text", text: "500 internal" }] }));
    const outcome = await runExistenceSweep(deps, source);
    expect(outcome).toMatchObject({ status: "aborted", reason: "server_unclear", tombstoned: 0 });
    expect(w.sink.tombstones).toEqual([]);
  });

  it("is bounded at 2,000 checks a run and resumes next week from where it stopped", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ticket(String(i).padStart(5, "0")));
    const { server, deps, cursor } = sweepWorld(rows, () => found);
    const first = await runExistenceSweep(deps, source);
    expect(first.checked).toBe(2000);
    expect(cursor()).toBe("2000");
    const second = await runExistenceSweep(deps, source);
    expect(second.checked).toBe(500);
    expect(cursor()).toBeUndefined();
    expect(server.calls.length).toBe(2500 + 2);
  });

  it("refuses an exists tool that is not on the allow-list, or no exists tool at all", async () => {
    const { server, deps } = sweepWorld([ticket(1)], () => found);
    expect(await runExistenceSweep(deps, { ...source, existsTool: "delete_ticket" })).toMatchObject({ status: "refused", reason: "not_allow_listed" });
    expect((await runExistenceSweep(deps, { ...source, readOnlyTools: ["list_tickets"] })).reason).toBe("not_allow_listed");
    const without: McpPollSource = { ...source };
    delete without.existsTool;
    expect(await runExistenceSweep(deps, without)).toMatchObject({ status: "refused", reason: "no_exists_tool" });
    expect(server.calls).toEqual([]);
  });
});
