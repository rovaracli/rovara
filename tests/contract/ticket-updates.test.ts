// Slice 5 "Outside tools" (owner decision 6): write-back to the ticket that started a task. Only that ticket, only the title, the moment, the status and the link; never a private task to a public
// tracker unless the project allows it; a missing scope is shown and skipped, never a failure; rate limited; sent once. And the tracker writers use the connection's access as it is.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, intakeItemIdOf, sessionBindingKey, ticketUpdatesSettingsKey, type CodeMilestone, type OrgId, type TicketTracker } from "@agentx/contracts";
import { claimIntakeItem, markIntakeStarted } from "../../packages/broker/src/intake/store.js";
import { TICKET_UPDATES_PER_TASK, inertTicketTitle, sendTicketUpdate, ticketUpdateText, type TicketUpdatesDependencies } from "../../packages/broker/src/ticket-updates/handler.js";
import { readWriteAccess } from "../../packages/broker/src/ticket-updates/settings.js";
import { MARKER_PROPERTY, ticketTrackersOf, type TicketTrackerPort } from "../../packages/broker/src/ticket-updates/trackers.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "11111111-1111-4111-8111-111111111111";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const OWNER = "o".repeat(64);
const NOW = Date.parse("2026-11-07T10:00:00.000Z");
const SECRET_PLAN = "PLAN-WORDS-THAT-MUST-NOT-LEAVE";

type Call = { kind: "comment" | "status"; tracker: TicketTracker; text?: string; status?: string; requirePrivate?: boolean; id: string };

function world(options: { system?: "jira" | "linear" | "github"; intakeStarted?: boolean; answer?: Partial<Record<"comment" | "status", string>>; title?: string } = {}) {
  const db = new FakeDynamoDb();
  const calls: Call[] = [];
  const port = (tracker: TicketTracker): TicketTrackerPort => ({
    comment: async (input) => { calls.push({ kind: "comment", tracker, text: input.text, requirePrivate: input.requirePrivate, id: input.ticket.id }); return (options.answer?.comment ?? "posted") as never; },
    setStatus: async (input) => { calls.push({ kind: "status", tracker, status: input.status, id: input.ticket.id }); return (options.answer?.status ?? "moved") as never; },
  });
  const deps: TicketUpdatesDependencies = { documentClient: db, tableName: "state", now: () => NOW, origin: "https://app.rovara.test/", trackers: { linear: port("linear"), jira: port("jira"), github: port("github") } };
  const system = options.system ?? "jira";
  const id = system === "jira" ? "PAY-12" : system === "linear" ? "ENG-7" : "acme/web/7";
  const url = system === "jira" ? "https://acme.atlassian.net/browse/PAY-12" : system === "linear" ? "https://linear.app/acme/issue/ENG-7/x" : "https://github.com/acme/web/issues/7";
  const setup = async () => {
    await db.send(new PutCommand({ TableName: "state", Item: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: ORG, project: "web", taskId: TASK, sessionId: SESSION, title: options.title ?? "Fix refunds", planContent: SECRET_PLAN, owner: { developerId: OWNER } } }));
    await db.send(new PutCommand({ TableName: "state", Item: { ...sessionBindingKey(ORG, SESSION, "tracker_item"), orgId: ORG, sessionId: SESSION, binding: { kind: "tracker_item", system, id, url } } }));
    if (options.intakeStarted !== false) {
      const table = { documentClient: db, tableName: "state", now: () => NOW };
      const itemId = intakeItemIdOf(system, id);
      await claimIntakeItem(table, { orgId: ORG, project: "web", itemId, channel: system === "github" ? "github_issue" : system === "jira" ? "jira" : "tracker", system, id, url, title: "t", requester: { display: "x", standing: "member", developerId: OWNER }, state: "starting", startedBy: OWNER });
      await markIntakeStarted(table, ORG, "web", itemId, { holder: OWNER, taskId: TASK, sessionId: SESSION, requester: { display: "x", standing: "member", developerId: OWNER } });
    }
  };
  const settings = (value: Record<string, unknown>) => db.send(new PutCommand({ TableName: "state", Item: { ...ticketUpdatesSettingsKey(ORG, "web"), orgId: ORG, project: "web", revision: 1, settings: value } }));
  const milestone = (kind: CodeMilestone["kind"], over: Partial<CodeMilestone> = {}): CodeMilestone => ({ kind, orgId: ORG, taskId: TASK, at: new Date(NOW).toISOString(), text: "x", ...over });
  return { db, deps, calls, setup, settings, milestone };
}

describe("what is written, and where", () => {
  it("comments on the ticket that started the task with the moment, the title and the /app/sessions link, and nothing else of the task", async () => {
    const w = world({ title: "Fix @team refunds [x](https://evil.example)" });
    await w.setup();
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("posted");
    expect(w.calls).toEqual([{ kind: "comment", tracker: "jira", id: "PAY-12", requirePrivate: true, text: "Rovara started work on this ticket: \"Fix team refunds x https: evil.example\".\nFollow it in Rovara: https://app.rovara.test/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa" }]);
    // Positive control: the plan is on the task the handler read, and it never reached the ticket.
    expect(JSON.stringify((await w.db.send(new GetCommand({ TableName: "state", Key: { pk: `DEVTASK#${TASK}`, sk: "META" } })) as { Item: unknown }).Item)).toContain(SECRET_PLAN);
    expect(JSON.stringify(w.calls)).not.toContain(SECRET_PLAN);
  });

  it("maps each moment: plan ready, pull request opened, merged, closed; other milestones write nothing", async () => {
    const w = world({ system: "linear" });
    await w.setup();
    for (const kind of ["plan_ready", "pr_ready", "merged", "closed", "stuck", "approved"] as const) await sendTicketUpdate(w.deps, w.milestone(kind, kind === "pr_ready" ? { pullRequests: [{ repository: "acme/web", number: 3, url: "https://github.com/acme/web/pull/3" }] } : {}));
    expect(w.calls.map((call) => call.text?.split(":")[0])).toEqual([
      "Rovara's plan for this ticket is ready for review", "Rovara opened a pull request for this ticket", "Rovara's pull request for this ticket was merged", "Rovara's task for this ticket was closed",
    ]);
  });

  it("writes nothing to a ticket intake did not start this task from (a ticket bound by hand, or another task's)", async () => {
    const w = world({ intakeStarted: false });
    await w.setup();
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("no_ticket");
    expect(w.calls).toEqual([]);
  });

  it("writes nothing for a milestone of another org's task", async () => {
    const w = world();
    await w.setup();
    expect(await sendTicketUpdate(w.deps, { ...w.milestone("started"), orgId: OTHER })).toBe("no_task");
    expect(w.calls).toEqual([]);
  });
});

describe("the ticket's status", () => {
  it("is never changed while the switch is off (the default)", async () => {
    const w = world();
    await w.setup();
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(w.calls.filter((call) => call.kind === "status")).toEqual([]);
  });

  it("moves to the project's name for the moment when the switch is on, and the comment says so", async () => {
    const w = world();
    await w.setup();
    await w.settings({ comments: true, changeStatus: true, statuses: { started: "Doing" } });
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(w.calls[0]).toMatchObject({ kind: "status", status: "Doing" });
    expect(w.calls[1]!.text).toContain("Status: Doing.");
    // A moment with no name moves nothing.
    await sendTicketUpdate(w.deps, w.milestone("closed"));
    expect(w.calls.filter((call) => call.kind === "status")).toHaveLength(1);
  });
});

describe("private tasks and public trackers", () => {
  it("always asks for a private repository for a task only its owner sees, whatever the project's settings (no override, review I3)", async () => {
    const w = world({ system: "github" });
    await w.setup();
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(w.calls[0]).toMatchObject({ tracker: "github", requirePrivate: true });
    // Settings saved before the fix still carry the old switch: it is ignored, and the rest of the settings still apply.
    await w.settings({ comments: true, changeStatus: false, statuses: {}, privateSessions: true });
    await sendTicketUpdate(w.deps, w.milestone("merged"));
    expect(w.calls[1]).toMatchObject({ tracker: "github", requirePrivate: true });
    // A maintainer cannot save the switch any more.
    const { TicketUpdatesSettingsSchema } = await import("@agentx/contracts");
    expect(TicketUpdatesSettingsSchema.safeParse({ comments: true, changeStatus: false, statuses: {}, privateSessions: true }).success).toBe(false);
  });

});

describe("a missing scope", () => {
  it("is noted for the company and skipped; the update never throws and the task goes on", async () => {
    const w = world({ answer: { comment: "needs_write_access" } });
    await w.setup();
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("needs_write_access");
    expect(await readWriteAccess(w.deps, ORG)).toEqual(expect.arrayContaining([{ tracker: "jira", state: "needs_write_access", at: new Date(NOW).toISOString() }]));
    // Another org sees nothing of it.
    expect((await readWriteAccess(w.deps, OTHER)).every((entry) => entry.state === "ok")).toBe(true);
  });
});

describe("once, and rate limited", () => {
  it("sends each moment once, however often it is delivered", async () => {
    const w = world();
    await w.setup();
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("posted");
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("already_sent");
    expect(w.calls).toHaveLength(1);
  });

  it("stops at the per-task limit and skips the rest without throwing", async () => {
    const w = world();
    await w.setup();
    const outcomes: string[] = [];
    for (let n = 1; n <= TICKET_UPDATES_PER_TASK + 2; n += 1) outcomes.push(await sendTicketUpdate(w.deps, w.milestone("pr_ready", { pullRequests: [{ repository: "acme/web", number: n, url: `https://github.com/acme/web/pull/${String(n)}` }] })));
    expect(outcomes.filter((outcome) => outcome === "posted")).toHaveLength(TICKET_UPDATES_PER_TASK);
    expect(outcomes.slice(-2)).toEqual(["rate_limited", "rate_limited"]);
    expect(w.calls).toHaveLength(TICKET_UPDATES_PER_TASK);
  });

  it("stops at the per-company hourly cap for one tracker; another tracker and another org are not touched (and the per-task count is not spent by a cap)", async () => {
    const { TICKET_UPDATES_PER_HOUR } = await import("../../packages/broker/src/ticket-updates/handler.js");
    const { ticketUpdateCallsKey } = await import("@agentx/contracts");
    const w = world();
    await w.setup();
    const hour = new Date(NOW).toISOString().slice(0, 13);
    await w.db.send(new PutCommand({ TableName: "state", Item: { ...ticketUpdateCallsKey(ORG, "jira", hour), count: TICKET_UPDATES_PER_HOUR } }));
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("rate_limited");
    expect(w.calls).toEqual([]);
    const count = async (key: { pk: string; sk: string }) => ((await w.db.send(new GetCommand({ TableName: "state", Key: key }))) as { Item?: { count?: number } }).Item?.count ?? 0;
    // Review M3: the cap's "no" gave the per-task count back.
    expect(await count({ pk: `DEVTASK#${TASK}`, sk: "TICKET_UPDATE_COUNT" })).toBe(0);
    expect(await count(ticketUpdateCallsKey(ORG, "linear", hour))).toBe(0);
    expect(await count(ticketUpdateCallsKey(OTHER, "jira", hour))).toBe(0);
    // Another tracker of the same org still writes.
    const linear = world({ system: "linear" });
    await linear.setup();
    expect(await sendTicketUpdate(linear.deps, linear.milestone("started"))).toBe("posted");
  });

  it("spends no count on an update that wrote nothing, or that failed and will be tried again (review M3)", async () => {
    const w = world({ answer: { comment: "needs_write_access" } });
    await w.setup();
    const count = async () => ((await w.db.send(new GetCommand({ TableName: "state", Key: { pk: `DEVTASK#${TASK}`, sk: "TICKET_UPDATE_COUNT" } }))) as { Item?: { count?: number } }).Item?.count ?? 0;
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(await count()).toBe(0);
    const failing = world();
    await failing.setup();
    failing.deps.trackers.jira = { ...failing.deps.trackers.jira, comment: async () => { throw new Error("tracker away"); } };
    await expect(sendTicketUpdate(failing.deps, failing.milestone("started"))).rejects.toThrow("tracker away");
    expect(((await failing.db.send(new GetCommand({ TableName: "state", Key: { pk: `DEVTASK#${TASK}`, sk: "TICKET_UPDATE_COUNT" } }))) as { Item?: { count?: number } }).Item?.count ?? 0).toBe(0);
    // A write that did reach the tracker spends one.
    const ok = world();
    await ok.setup();
    await sendTicketUpdate(ok.deps, ok.milestone("started"));
    expect(((await ok.db.send(new GetCommand({ TableName: "state", Key: { pk: `DEVTASK#${TASK}`, sk: "TICKET_UPDATE_COUNT" } }))) as { Item?: { count?: number } }).Item?.count).toBe(1);
  });

  it("gives the claim back on a fault that may pass, so the next delivery sends it", async () => {
    const w = world();
    await w.setup();
    const failing = vi.fn().mockRejectedValueOnce(Object.assign(new Error("busy"), { name: "AgentXError" }));
    const original = w.deps.trackers.jira;
    w.deps.trackers.jira = { ...original, comment: async (input) => { await failing(); return original.comment(input); } };
    await expect(sendTicketUpdate(w.deps, w.milestone("started"))).rejects.toThrow("busy");
    expect(await sendTicketUpdate(w.deps, w.milestone("started"))).toBe("posted");
  });
});

describe("the words", () => {
  it("keep a title inert and short, and carry no mention", () => {
    expect(inertTicketTitle("a\u0000b‮ @x <script>")).toBe("a b x script");
    expect([...inertTicketTitle("y".repeat(500))]).toHaveLength(120);
    expect(ticketUpdateText({ moment: "merged", title: "T", link: "https://a.test/app/sessions/s", status: "Done" })).toBe("Rovara's pull request for this ticket was merged: \"T\".\nStatus: Done.\nFollow it in Rovara: https://a.test/app/sessions/s");
  });
});

describe("the tracker writers use the connection's access as it is", () => {
  const connectionWorld = async (connections: Array<{ id: string; access: "read" | "read_write" }>) => {
    const fake = new FakeOrgSecrets({ env: "staging", now: () => NOW });
    const db = new FakeDynamoDb();
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => NOW });
    const deps = { documentClient: db, tableName: "T", env: "staging", secrets, now: () => NOW };
    for (const connection of connections) {
      await new OrgConnectionStore(deps).put({ orgId: ORG, by: "dev-admin", connection: { connectionId: connection.id, type: "jira", label: `Jira ${connection.id.slice(-1)}`, access: connection.access, siteUrl: "https://acme.atlassian.net" }, secret: { email: "rovara@acme.test", apiToken: ["tok", "en", "x"].join("-") } });
    }
    return deps;
  };
  const jira = { tracker: "jira" as const, id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };

  it("Jira: a read-only connection is not used and says it needs write access; no request is made", async () => {
    const fetch = vi.fn();
    const trackers = ticketTrackersOf({ connections: await connectionWorld([{ id: "con_jira0000000000000001", access: "read" }]), fetch: fetch as never });
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k", requirePrivate: true })).toBe("needs_write_access");
    expect(await trackers.jira.setStatus({ orgId: ORG, ticket: jira, status: "Done" })).toBe("needs_write_access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Jira: a read and write connection posts only to its own site, marked, internal for an owner-only task; a refusal is needs_write_access; a rate limit throws", async () => {
    const deps = await connectionWorld([{ id: "con_jira0000000000000002", access: "read_write" }]);
    const seen: Array<{ url: string; method: string; body: unknown; redirect: unknown }> = [];
    let status = 201;
    let existing: unknown[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, redirect: init.redirect });
      if (url.endsWith("/myself")) return Response.json({ accountId: "acct-rovara" });
      if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ comments: existing }), { status: status === 201 ? 200 : status });
      return new Response("{}", { status });
    });
    const trackers = ticketTrackersOf({ connections: deps, fetch: fetch as never });
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "line one\nline two", key: "k1", requirePrivate: true })).toBe("posted");
    expect(seen[0]).toMatchObject({ method: "GET", url: "https://acme.atlassian.net/rest/api/3/issue/PAY-12/comment?orderBy=-created&maxResults=50&expand=properties", redirect: "error" });
    const post = () => seen.find((call) => call.method === "POST")!;
    const marker = (post().body as { properties: Array<{ key: string; value: { id: string } }> }).properties[0]!.value.id;
    expect(post()).toEqual({ method: "POST", url: "https://acme.atlassian.net/rest/api/3/issue/PAY-12/comment", redirect: "error", body: {
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "line one" }] }, { type: "paragraph", content: [{ type: "text", text: "line two" }] }] },
      properties: [{ key: MARKER_PROPERTY, value: { id: marker } }, { key: "sd.public.comment", value: { internal: true } }],
    } });
    // A task shared with the project: the comment is not made internal.
    seen.length = 0;
    await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k2", requirePrivate: false });
    expect((post().body as { properties: unknown[] }).properties).toHaveLength(1);
    // Review M4: a retry after a lost answer finds its marker on the ticket and does not post again.
    seen.length = 0;
    existing = [{ id: "1", author: { accountId: "acct-rovara" }, properties: [{ key: MARKER_PROPERTY, value: { id: marker } }] }];
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "line one\nline two", key: "k1", requirePrivate: true })).toBe("posted");
    expect(seen.map((call) => call.method)).toEqual(["GET", "GET"]);
    // Review M4-R: the same marker on someone else's comment does not hold ours back.
    seen.length = 0;
    existing = [{ id: "2", author: { accountId: "acct-mallory" }, properties: [{ key: MARKER_PROPERTY, value: { id: marker } }] }];
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "line one\nline two", key: "k1", requirePrivate: true })).toBe("posted");
    expect(seen.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
    existing = [];
    // A ticket on another site has no connection there: nothing is sent.
    seen.length = 0;
    expect(await trackers.jira.comment({ orgId: ORG, ticket: { ...jira, url: "https://other.atlassian.net/browse/PAY-12" }, text: "x", key: "k", requirePrivate: true })).toBe("not_connected");
    expect(seen).toEqual([]);
    status = 403;
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k3", requirePrivate: true })).toBe("needs_write_access");
    status = 429;
    await expect(trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k4", requirePrivate: true })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // The key never appears in what a caller sees.
    expect(JSON.stringify(seen)).not.toContain("tok-en-x");
  });

  it("Linear: with two workspaces, the comment and the status go only to the ticket's own workspace (review I2)", async () => {
    const fake = new FakeOrgSecrets({ env: "staging", now: () => NOW });
    const db = new FakeDynamoDb();
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => NOW });
    const deps = { documentClient: db, tableName: "T", env: "staging", secrets, now: () => NOW };
    const keys: Record<string, string> = { [["key", "alpha"].join("_")]: "alpha", [["key", "beta"].join("_")]: "beta" };
    const calls: Array<{ workspace: string; query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const workspace = keys[(init.headers as Record<string, string>)["authorization"] ?? ""] ?? "none";
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { query: string };
      calls.push({ workspace, query: body.query });
      if (/viewer/u.test(body.query)) return Response.json({ data: { viewer: { id: `rovara-${workspace}`, organization: { urlKey: workspace } } } });
      if (/issue\(id/u.test(body.query)) return Response.json({ data: { issue: { id: `uuid-${workspace}`, url: `https://linear.app/${workspace}/issue/ENG-12/x`, state: { name: "Todo" }, team: { states: { nodes: [{ id: `done-${workspace}`, name: "Done" }] } } } } });
      if (/issueUpdate/u.test(body.query)) return Response.json({ data: { issueUpdate: { success: true } } });
      return Response.json({ data: null, errors: [{ message: "unknown" }] });
    });
    const store = new OrgConnectionStore({ ...deps, fetch: fetch as never });
    // The service identity of workspace alpha sorts first: before the fix every write went through it.
    await store.put({ orgId: ORG, by: "dev-admin", connection: { connectionId: "con_lin00000000000000001", type: "linear", label: "Alpha", access: "read_write", identity: "service" }, secret: { apiKey: ["key", "alpha"].join("_") } });
    await store.put({ orgId: ORG, by: "dev-admin", connection: { connectionId: "con_lin00000000000000002", type: "linear", label: "Beta", access: "read_write" }, secret: { apiKey: ["key", "beta"].join("_") } });
    await store.check(ORG, "con_lin00000000000000001");
    await store.check(ORG, "con_lin00000000000000002");
    const replies: Array<{ workspace?: string; issueKey: string }> = [];
    const reply = { reply: vi.fn(async (input: { workspace?: string; issueKey: string }) => { replies.push({ workspace: input.workspace, issueKey: input.issueKey }); return { commentId: "c1" }; }) };
    const trackers = ticketTrackersOf({ connections: deps, linearReply: reply as never, fetch: fetch as never });
    const beta = { tracker: "linear" as const, id: "ENG-12", url: "https://linear.app/beta/issue/ENG-12/refunds" };
    calls.length = 0;
    expect(await trackers.linear.comment({ orgId: ORG, ticket: beta, text: "x", key: "k", requirePrivate: true })).toBe("posted");
    expect(replies).toEqual([{ workspace: "beta", issueKey: "ENG-12" }]);
    expect(await trackers.linear.setStatus({ orgId: ORG, ticket: beta, status: "Done" })).toBe("moved");
    expect(calls.map((call) => call.workspace)).toEqual(["beta", "beta"]);
    // A ticket link that names no workspace, or a workspace no connection was checked in, writes nothing.
    calls.length = 0;
    expect(await trackers.linear.comment({ orgId: ORG, ticket: { ...beta, url: "https://linear.app/gamma/issue/ENG-12/x" }, text: "x", key: "k", requirePrivate: true })).toBe("not_connected");
    expect(await trackers.linear.setStatus({ orgId: ORG, ticket: { ...beta, url: "https://example.com/ENG-12" }, status: "Done" })).toBe("not_connected");
    expect(calls).toEqual([]);
    expect(replies).toHaveLength(1);
  });

  it("Linear: a workspace whose only connection reads says it needs write access, and the issue the key finds must be in the ticket's workspace", async () => {
    const fake = new FakeOrgSecrets({ env: "staging", now: () => NOW });
    const db = new FakeDynamoDb();
    const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => NOW });
    const deps = { documentClient: db, tableName: "T", env: "staging", secrets, now: () => NOW };
    let issueWorkspace = "alpha";
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { query: string };
      if (/viewer/u.test(body.query)) return Response.json({ data: { viewer: { id: "rovara", organization: { urlKey: "alpha" } } } });
      if (/issue\(id/u.test(body.query)) return Response.json({ data: { issue: { id: "u", url: `https://linear.app/${issueWorkspace}/issue/ENG-12/x`, state: { name: "Todo" }, team: { states: { nodes: [{ id: "d", name: "Done" }] } } } } });
      return Response.json({ data: { issueUpdate: { success: true } } });
    });
    const store = new OrgConnectionStore({ ...deps, fetch: fetch as never });
    await store.put({ orgId: ORG, by: "dev-admin", connection: { connectionId: "con_lin00000000000000003", type: "linear", label: "Alpha", access: "read" }, secret: { apiKey: ["key", "r"].join("_") } });
    await store.check(ORG, "con_lin00000000000000003");
    const ticket = { tracker: "linear" as const, id: "ENG-12", url: "https://linear.app/alpha/issue/ENG-12/x" };
    expect(await ticketTrackersOf({ connections: deps, fetch: fetch as never }).linear.comment({ orgId: ORG, ticket, text: "x", key: "k", requirePrivate: true })).toBe("needs_write_access");
    await store.put({ orgId: ORG, by: "dev-admin", connection: { connectionId: "con_lin00000000000000004", type: "linear", label: "Alpha 2", access: "read_write" }, secret: { apiKey: ["key", "w"].join("_") } });
    await store.check(ORG, "con_lin00000000000000004");
    issueWorkspace = "other";
    expect(await ticketTrackersOf({ connections: deps, fetch: fetch as never }).linear.setStatus({ orgId: ORG, ticket, status: "Done" })).toBe("not_found");
    expect(fetch.mock.calls.some(([, init]) => typeof (init).body === "string" && /issueUpdate/u.test((init).body))).toBe(false);
  });

  it("with no connections at all every tracker answers not_connected, and GitHub without the App too", async () => {
    const trackers = ticketTrackersOf({});
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k", requirePrivate: true })).toBe("not_connected");
    expect(await trackers.linear.setStatus({ orgId: ORG, ticket: { tracker: "linear", id: "ENG-1", url: "https://linear.app/a/issue/ENG-1" }, status: "Done" })).toBe("not_connected");
    expect(await trackers.github.comment({ orgId: ORG, ticket: { tracker: "github", id: "acme/web/7", url: "https://github.com/acme/web/issues/7" }, text: "x", key: "k", requirePrivate: true })).toBe("not_connected");
  });

  it("GitHub: an App that may not write issues is needs_write_access; a public repository for a private task posts nothing", async () => {
    const refused = { commentOnIssue: vi.fn(async () => { throw Object.assign(new Error("no"), { code: "GITHUB_NOT_CONNECTED" }); }) };
    const ticket = { tracker: "github" as const, id: "acme/web/7", url: "https://github.com/acme/web/issues/7" };
    expect(await ticketTrackersOf({ github: refused }).github.comment({ orgId: ORG, ticket, text: "x", key: "k", requirePrivate: true })).toBe("needs_write_access");
    const publicRepo = { commentOnIssue: vi.fn(async () => "public" as const) };
    expect(await ticketTrackersOf({ github: publicRepo }).github.comment({ orgId: ORG, ticket, text: "x", key: "k", requirePrivate: true })).toBe("public");
    expect(publicRepo.commentOnIssue).toHaveBeenCalledWith("https://github.com/acme/web", 7, "x", { orgId: ORG }, { requirePrivate: true });
    expect(await ticketTrackersOf({ github: publicRepo }).github.setStatus({ orgId: ORG, ticket, status: "Done" })).toBe("no_such_status");
  });
});

describe("the moments the hook did not have (started, plan ready, closed)", () => {
  const milestones = async (db: FakeDynamoDb) => {
    const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const page = await db.send(new QueryCommand({ TableName: "state", KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVTASK#${TASK}`, ":prefix": "CODE_MILESTONE#" } })) as { Items?: Array<Record<string, unknown>> };
    return (page.Items ?? []).map((item) => item["kind"]);
  };

  it("are written only for a task whose session follows a ticket, and add no line to the session", async () => {
    const { noteTicketTaskStarted, noteTicketPlanReady, ticketTaskEndHandler } = await import("../../packages/broker/src/ticket-updates/moments.js");
    const w = world();
    const table = { documentClient: w.db, tableName: "state", now: () => NOW, log: () => undefined };
    // No binding yet: nothing.
    await noteTicketTaskStarted(table, { orgId: ORG, taskId: TASK, sessionId: SESSION });
    expect(await milestones(w.db)).toEqual([]);
    await w.setup();
    await noteTicketTaskStarted(table, { orgId: ORG, taskId: TASK, sessionId: SESSION });
    await noteTicketTaskStarted(table, { orgId: ORG, taskId: TASK, sessionId: SESSION });
    expect(await milestones(w.db)).toEqual(["started"]);
    await w.db.send(new PutCommand({ TableName: "state", Item: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: ORG, project: "web", sessionId: SESSION, workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 4, definitionVersion: "1.1.0" } } }));
    await noteTicketPlanReady(table, TASK);
    await noteTicketPlanReady(table, TASK);
    expect((await milestones(w.db)).sort()).toEqual(["plan_ready", "started"]);
    const end = ticketTaskEndHandler(() => table);
    const binding = { kind: "tracker_item" as const, system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
    await end({} as never, { orgId: ORG, taskId: TASK, outcome: "merged", bindings: [binding], runLimitUsd: 1, spentUsd: 0 });
    expect(await milestones(w.db)).not.toContain("closed");
    await end({} as never, { orgId: ORG, taskId: TASK, outcome: "cancelled", bindings: [binding], runLimitUsd: 1, spentUsd: 0 });
    expect(await milestones(w.db)).toContain("closed");
    // No session line was written for any of them.
    const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
    const partition = await w.db.send(new QueryCommand({ TableName: "state", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": agentSessionKey(ORG, SESSION, "META").pk } })) as { Items?: Array<Record<string, unknown>> };
    expect((partition.Items ?? []).filter((item) => item["entityType"] === "AGENT_SESSION_EVENT")).toEqual([]);
    // Positive control: a milestone that names the session does write a line in that partition.
    const { codeMilestoneItems } = await import("../../packages/broker/src/rovara-code/milestones.js");
    const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
    await w.db.send(new TransactWriteCommand({ TransactItems: codeMilestoneItems({ tableName: "state" }, { kind: "stuck", orgId: ORG, taskId: TASK, sessionId: SESSION, at: new Date(NOW).toISOString(), text: "x" }, 1) }));
    const after = await w.db.send(new QueryCommand({ TableName: "state", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": agentSessionKey(ORG, SESSION, "META").pk } })) as { Items?: Array<Record<string, unknown>> };
    expect((after.Items ?? []).filter((item) => item["entityType"] === "AGENT_SESSION_EVENT")).toHaveLength(1);
  });

  it("a plan that is not waiting for review, or a version 1 task, writes no plan_ready", async () => {
    const { noteTicketPlanReady } = await import("../../packages/broker/src/ticket-updates/moments.js");
    const w = world();
    await w.setup();
    const table = { documentClient: w.db, tableName: "state", now: () => NOW, log: () => undefined };
    for (const workflow of [{ stage: "PLAN", state: "RUNNING", revision: 1, definitionVersion: "1.1.0" }, { stage: "PLAN_REVIEW", state: "WAITING", revision: 2, definitionVersion: "1.0.0" }]) {
      await w.db.send(new PutCommand({ TableName: "state", Item: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: ORG, project: "web", sessionId: SESSION, workflow } }));
      await noteTicketPlanReady(table, TASK);
    }
    expect(await milestones(w.db)).toEqual([]);
  });
});

describe("the broker registers the handler once", () => {
  it("installs the milestone handler (named ticket_updates) and the end handler at start, once per process, and nothing without developer sign-in", async () => {
    const { installTicketUpdates, uninstallTicketUpdates } = await import("../../packages/broker/src/aws/broker/ticket-updates-wiring.js");
    const { registerCodeMilestoneHandler } = await import("../../packages/broker/src/rovara-code/milestones.js");
    const { hasTaskEndHandlers } = await import("../../packages/broker/src/agents/task-end.js");
    const before = hasTaskEndHandlers();
    installTicketUpdates({ documentClient: new FakeDynamoDb(), tableName: "state", githubPullRequests: {} } as never);
    expect(hasTaskEndHandlers()).toBe(before);
    const deps = { documentClient: new FakeDynamoDb(), tableName: "state", githubPullRequests: {}, developer: { issuer: "https://app.rovara.test/oidc" } } as never;
    installTicketUpdates(deps);
    installTicketUpdates(deps);
    expect(hasTaskEndHandlers()).toBe(true);
    // The name is taken: a second registration under it is refused.
    expect(() => registerCodeMilestoneHandler({ name: "ticket_updates", on: async () => undefined })).toThrow("already registered");
    uninstallTicketUpdates();
    const remove = registerCodeMilestoneHandler({ name: "ticket_updates", on: async () => undefined });
    remove();
  });
});
