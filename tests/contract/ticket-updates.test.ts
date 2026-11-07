// Slice 5 "Outside tools" (owner decision 6): write-back to the ticket that started a task. Only that ticket, only the title, the moment, the status and the link; never a private task to a public
// tracker unless the project allows it; a missing scope is shown and skipped, never a failure; rate limited; sent once. And the tracker writers use the connection's access as it is.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, intakeItemIdOf, sessionBindingKey, ticketUpdatesSettingsKey, type CodeMilestone, type OrgId, type TicketTracker } from "@agentx/contracts";
import { claimIntakeItem, markIntakeStarted } from "../../packages/broker/src/intake/store.js";
import { TICKET_UPDATES_PER_TASK, inertTicketTitle, sendTicketUpdate, ticketUpdateText, type TicketUpdatesDependencies } from "../../packages/broker/src/ticket-updates/handler.js";
import { readWriteAccess } from "../../packages/broker/src/ticket-updates/settings.js";
import { ticketTrackersOf, type TicketTrackerPort } from "../../packages/broker/src/ticket-updates/trackers.js";
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
    await w.settings({ comments: true, changeStatus: true, statuses: { started: "Doing" }, privateSessions: false });
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(w.calls[0]).toMatchObject({ kind: "status", status: "Doing" });
    expect(w.calls[1]!.text).toContain("Status: Doing.");
    // A moment with no name moves nothing.
    await sendTicketUpdate(w.deps, w.milestone("closed"));
    expect(w.calls.filter((call) => call.kind === "status")).toHaveLength(1);
  });
});

describe("private tasks and public trackers", () => {
  it("asks for a private repository for a task only its owner sees, unless the project allows private tasks", async () => {
    const w = world({ system: "github" });
    await w.setup();
    await sendTicketUpdate(w.deps, w.milestone("started"));
    expect(w.calls[0]).toMatchObject({ tracker: "github", requirePrivate: true });
    await w.settings({ comments: true, changeStatus: false, statuses: {}, privateSessions: true });
    await sendTicketUpdate(w.deps, w.milestone("merged"));
    expect(w.calls[1]).toMatchObject({ tracker: "github", requirePrivate: false });
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

  it("Jira: a read and write connection posts only to its own site; a refusal is needs_write_access; a rate limit throws to be tried again", async () => {
    const deps = await connectionWorld([{ id: "con_jira0000000000000002", access: "read_write" }]);
    const seen: Array<{ url: string; body: unknown; redirect: unknown }> = [];
    let status = 201;
    const fetch = vi.fn(async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(typeof init.body === "string" ? init.body : "{}"), redirect: init.redirect }); return new Response("{}", { status }); });
    const trackers = ticketTrackersOf({ connections: deps, fetch: fetch as never });
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "line one\nline two", key: "k", requirePrivate: true })).toBe("posted");
    expect(seen[0]).toEqual({ url: "https://acme.atlassian.net/rest/api/3/issue/PAY-12/comment", redirect: "error", body: { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "line one" }] }, { type: "paragraph", content: [{ type: "text", text: "line two" }] }] } } });
    // A ticket on another site has no connection there: nothing is sent.
    expect(await trackers.jira.comment({ orgId: ORG, ticket: { ...jira, url: "https://other.atlassian.net/browse/PAY-12" }, text: "x", key: "k", requirePrivate: true })).toBe("not_connected");
    status = 403;
    expect(await trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k", requirePrivate: true })).toBe("needs_write_access");
    status = 429;
    await expect(trackers.jira.comment({ orgId: ORG, ticket: jira, text: "x", key: "k", requirePrivate: true })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(fetch).toHaveBeenCalledTimes(3);
    // The key never appears in what a caller sees.
    expect(JSON.stringify(seen)).not.toContain("tok-en-x");
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
