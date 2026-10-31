// Wire lane D (MF-4): the intake loop guard no longer trusts the event's actor alone. A label or an assignment that Rovara wrote itself, through a member's own key, comes back from the tracker
// as that member's act. Rovara notes what it writes (before it sends it), and an event that matches a note is Rovara's own and starts nothing; an event on a ticket Rovara just changed in a way
// that can't be matched is not taken for a member's act (it waits for Start); an actor the tracker cannot confirm is the same.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentXError, intakeItemIdOf, type CodeIntentRequest, type OrgId, type WorkspaceInstance } from "@agentx/contracts";
import { CatalogCache } from "@agentx/gateway";
import { callConnector, discoverConnector, type ScopeDiscovery } from "../../packages/broker/src/aws/connector-routes.js";
import type { ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import {
  OWN_WRITE_DELIVERY_LAG_MS, OWN_WRITE_LABEL_WINDOW_MS, OWN_WRITE_SKEW_MS, OWN_WRITE_TOUCH_WINDOW_MS, noteOwnWrite, ownWriteNoteOf, ownWriteVerdictOf, recordOwnWriteOfCall, registerOwnWriteExtractor, registerOwnWriteRecorder,
  unregisterOwnWriteExtractor,
} from "../../packages/broker/src/intake/own-writes.js";
import { intakeCandidateOf } from "../../packages/broker/src/triggers/intake-dispatch.js";
import { readIntakeItem } from "../../packages/broker/src/intake/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "web";
const MEMBER = "a".repeat(64);
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const JIRA = { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
const GITHUB = { system: "github", id: "acme/web/7", url: "https://github.com/acme/web/issues/7" };

function world() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const started: Array<{ developerId: string; request: CodeIntentRequest }> = [];
  const links = new Map<string, string>([["jira:acct-member", MEMBER], ["github:1001", MEMBER]]);
  const ports: IntakePorts = {
    table: { documentClient: db, tableName: "state", now: () => clock.now },
    log: () => undefined,
    memberOfAccount: async (_org, system, accountId) => links.get(`${system}:${accountId}`),
    mayStart: async () => true,
    start: async (_org, developerId, request) => { started.push({ developerId, request }); return { task: { taskId: `task-${String(started.length)}` }, sessionId: `ses_${String(started.length).padStart(20, "0")}` }; },
    sessionOfTicket: async () => undefined,
  };
  return { db, clock, ports, started };
}
const jiraLabel = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "jira", externalRef: JIRA, title: "Refunds fail", body: "Fails.", actor: { kind: "person", accountId: "acct-member" },
  act: { kind: "label", value: "rovara" }, occurredAt: new Date(T0).toISOString(), eventId: "jira:issue:10042:labeled:rovara:10124", ...over,
});
const githubLabel = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: PROJECT, channel: "github_issue", externalRef: GITHUB, title: "Refunds fail", actor: { kind: "person", accountId: "1001" },
  act: { kind: "label", value: "Rovara" }, occurredAt: new Date(T0).toISOString(), eventId: "gh:issue:1:7:labeled:Rovara:t", ...over,
});

afterEach(() => { registerOwnWriteRecorder(undefined); unregisterOwnWriteExtractor("acme-tracker"); });

describe("a label Rovara wrote through a member's key is Rovara's, not the member's", () => {
  it("starts nothing for the event that matches a note, and keeps no item for it", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, jiraLabel())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.started).toEqual([]);
    expect(await readIntakeItem(w.ports.table, ORG, PROJECT, intakeItemIdOf("jira", "PAY-12"))).toBeUndefined();
  });

  it("is still Rovara's when the vendor delivers the same event again (a note is not used up)", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    for (let i = 0; i < 3; i += 1) expect(await ingestIntake(w.ports, jiraLabel())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.started).toEqual([]);
  });

  it("matches the label whatever its case, and the ticket whatever the case of its id", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "github", ticket: "ACME/Web/7", labels: ["ROVARA"] });
    expect(await ingestIntake(w.ports, githubLabel())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("matches an assignment the same way", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", assignees: ["acct-rovara-bot"] });
    const outcome = await ingestIntake(w.ports, jiraLabel({ act: { kind: "assignee", value: "acct-rovara-bot" }, eventId: "jira:issue:10042:assigned:acct-rovara-bot:1" }));
    expect(outcome).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("does not match another label, another ticket, or another org", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    expect((await ingestIntake(w.ports, jiraLabel({ act: { kind: "label", value: "urgent" }, eventId: "e-urgent" }))).outcome).toBe("started");
    expect((await ingestIntake(w.ports, jiraLabel({ externalRef: { ...JIRA, id: "PAY-13", url: "https://acme.atlassian.net/browse/PAY-13" }, eventId: "e-13" }))).outcome).toBe("started");
    const other = world();
    await noteOwnWrite(other.ports.table, OTHER_ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    expect((await ingestIntake(other.ports, jiraLabel())).outcome).toBe("started");
  });

  it("does not take an event from before the write for its echo (a member who labelled first still starts the work)", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    const before = new Date(T0 - OWN_WRITE_SKEW_MS - 1_000).toISOString();
    // Received long after the write (outside the delivery lag), stamped before it: not its echo.
    w.clock.now = T0 + OWN_WRITE_DELIVERY_LAG_MS + 1_000;
    expect((await ingestIntake(w.ports, jiraLabel({ occurredAt: before }))).outcome).toBe("started");
  });

  it("stops matching after its window", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    const late = new Date(T0 + OWN_WRITE_LABEL_WINDOW_MS + 1_000).toISOString();
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS + 1_000;
    expect((await ingestIntake(w.ports, jiraLabel({ occurredAt: late }))).outcome).toBe("started");
  });

  it("a new write extends the window, and the first write still covers an early event", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS - 1_000;
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    const later = new Date(T0 + OWN_WRITE_LABEL_WINDOW_MS + 60_000).toISOString();
    w.clock.now = T0 + OWN_WRITE_LABEL_WINDOW_MS + 60_000;
    expect(await ingestIntake(w.ports, jiraLabel({ occurredAt: later }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(await ingestIntake(w.ports, jiraLabel({ occurredAt: new Date(T0).toISOString(), eventId: "e-early" }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("a note for a whole repository (a ticket Rovara was about to make) is never `own`: an issue in it waits for a member, so a member's label on another issue is not lost", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "github", scope: "acme/web", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, githubLabel())).toEqual({ outcome: "waiting", reason: "unverified" });
    const elsewhere = githubLabel({ externalRef: { ...GITHUB, id: "acme/other/7", url: "https://github.com/acme/other/issues/7" }, eventId: "e-other" });
    expect((await ingestIntake(w.ports, elsewhere)).outcome).toBe("started");
    expect(w.started).toHaveLength(1);
  });

  it("an event stamped by a vendor clock far behind ours is still Rovara's echo when we received it right after the write", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", labels: ["rovara"] });
    w.clock.now = T0 + 20_000;
    const behind = new Date(T0 - 30 * 60_000).toISOString();
    expect(await ingestIntake(w.ports, jiraLabel({ occurredAt: behind }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("Rovara labelled by Jira's numeric id and the event names the issue by its key: still Rovara's", async () => {
    const w = world();
    expect(ownWriteNoteOf("jira", "editJiraIssue", { issueIdOrKey: "10042", fields: { labels: ["rovara"] } })).toMatchObject({ ticket: "10042" });
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "10042", labels: ["rovara"] });
    expect(await ingestIntake(w.ports, jiraLabel({ alternateIds: ["10042"] }))).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect((await ingestIntake(w.ports, jiraLabel({ eventId: "other", externalRef: { ...JIRA, id: "PAY-13", url: "https://acme.atlassian.net/browse/PAY-13" }, alternateIds: ["10099"] }))).outcome).toBe("started");
  });
});

describe("a ticket Rovara just changed in a way a note can't match is not taken for a member's act", () => {
  it("waits for Start (unverified) instead of starting, and starts nothing", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", touch: true });
    expect(await ingestIntake(w.ports, jiraLabel())).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toEqual([]);
    expect(await readIntakeItem(w.ports.table, ORG, PROJECT, intakeItemIdOf("jira", "PAY-12"))).toMatchObject({ state: "waiting", reason: "unverified", requester: { standing: "outsider" } });
  });

  it("is only for a short while after the write", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "jira", ticket: "PAY-12", touch: true });
    const late = new Date(T0 + OWN_WRITE_TOUCH_WINDOW_MS + 1_000).toISOString();
    w.clock.now = T0 + OWN_WRITE_TOUCH_WINDOW_MS + 1_000;
    expect((await ingestIntake(w.ports, jiraLabel({ occurredAt: late }))).outcome).toBe("started");
  });
});

describe("a read of the notes that fails is not a guess", () => {
  it("throws, so the delivery is made again, and starts nothing", async () => {
    const w = world();
    w.db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    const outcome = await ingestIntake(w.ports, jiraLabel()).then(() => "no fault", (error: unknown) => (error instanceof Error ? error.name : "other"));
    expect(outcome).toBe("ProvisionedThroughputExceededException");
    expect(w.started).toEqual([]);
  });
});

describe("the tracker's own word on who did it (where the adapter has one)", () => {
  it("an act the tracker says was done through Rovara's app is Rovara's", async () => {
    const w = world();
    const outcome = await ingestIntake(w.ports, githubLabel(), { confirmActor: async () => "rovara" });
    expect(outcome).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.started).toEqual([]);
  });

  it("an act the tracker confirms is a person's starts the work as before", async () => {
    const w = world();
    expect((await ingestIntake(w.ports, githubLabel(), { confirmActor: async () => "person" })).outcome).toBe("started");
  });

  it("an act the tracker can't confirm (an error, or no answer) waits for Start", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, githubLabel(), { confirmActor: async () => { throw new Error("api down"); } })).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(await ingestIntake(w.ports, githubLabel({ eventId: "e2", externalRef: { ...GITHUB, id: "acme/web/8", url: "https://github.com/acme/web/issues/8" } }), { confirmActor: async () => "unverified" })).toEqual({ outcome: "waiting", reason: "unverified" });
    expect(w.started).toEqual([]);
  });

  it("is not asked for an act that already waits (an outsider, an automation) or Rovara's own", async () => {
    const w = world();
    let asked = 0;
    const confirmActor = async () => { asked += 1; return "person" as const; };
    await ingestIntake(w.ports, githubLabel({ actor: { kind: "rovara" } }), { confirmActor });
    await ingestIntake(w.ports, githubLabel({ eventId: "b", actor: { kind: "bot", accountId: "9" } }), { confirmActor });
    expect(asked).toBe(0);
  });
});

describe("what Rovara's connector writes are noted as", () => {
  it("reads a GitHub issue's labels and assignees, and a Jira edit's labels and assignee", () => {
    expect(ownWriteNoteOf("github", "issue_write", { owner: "Acme", repo: "Web", issue_number: 7, labels: ["Rovara", "bug"], assignees: ["rovara-bot"] })).toEqual({
      system: "github", ticket: "Acme/Web/7", labels: ["Rovara", "bug"], assignees: ["rovara-bot"], touch: true,
    });
    expect(ownWriteNoteOf("jira", "editJiraIssue", { issueIdOrKey: "PAY-12", fields: { labels: ["rovara"], assignee: { accountId: "acct-x" } } })).toEqual({
      system: "jira", ticket: "PAY-12", labels: ["rovara"], assignees: ["acct-x"], touch: true,
    });
    expect(ownWriteNoteOf("jira", "editJiraIssue", { issueIdOrKey: "PAY-12", update: { labels: [{ add: "rovara" }, { remove: "old" }] } })).toMatchObject({ labels: ["rovara"] });
  });

  it("notes the repository for an issue made with labels, since it has no number yet", () => {
    expect(ownWriteNoteOf("github", "create_issue", { owner: "acme", repo: "web", title: "x", labels: ["rovara"] })).toEqual({ system: "github", scope: "acme/web", labels: ["rovara"], touch: true });
  });

  it("notes a comment as a touch of its ticket, and a read as nothing", () => {
    expect(ownWriteNoteOf("github", "add_issue_comment", { owner: "acme", repo: "web", issue_number: 7, body: "hi" })).toEqual({ system: "github", ticket: "acme/web/7", touch: true });
    expect(ownWriteNoteOf("github", "get_issue", { owner: "acme", repo: "web", issue_number: 7 })).toBeUndefined();
    expect(ownWriteNoteOf("github", "list_issues", { owner: "acme", repo: "web", labels: ["rovara"] })).toBeUndefined();
    expect(ownWriteNoteOf("sentry", "update_issue", { id: "1" })).toBeUndefined();
  });

  it("a tracker plug-in adds its own reader", () => {
    registerOwnWriteExtractor("acme-tracker", (call) => (call.tool === "label_ticket" && typeof call.args["ticket"] === "string" ? { system: "acme", ticket: call.args["ticket"], labels: [String(call.args["label"])], touch: true } : undefined));
    expect(ownWriteNoteOf("acme-tracker", "label_ticket", { ticket: "T-1", label: "rovara" })).toEqual({ system: "acme", ticket: "T-1", labels: ["rovara"], touch: true });
  });

  it("the connector call notes its write before it is sent, and a note that can't be made stops the call", async () => {
    const w = world();
    registerOwnWriteRecorder((orgId, note) => noteOwnWrite(w.ports.table, orgId, note));
    await recordOwnWriteOfCall({ orgId: ORG, connectorType: "jira", tool: "editJiraIssue", args: { issueIdOrKey: "PAY-12", fields: { labels: ["rovara"] } } });
    expect(await ownWriteVerdictOf(w.ports.table, jiraLabel())).toBe("own");
    registerOwnWriteRecorder(async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "no"); });
    await expect(recordOwnWriteOfCall({ orgId: ORG, connectorType: "jira", tool: "editJiraIssue", args: { issueIdOrKey: "PAY-12", fields: { labels: ["x"] } } })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("a read-only call, or a call nobody notes, does nothing", async () => {
    let calls = 0;
    registerOwnWriteRecorder(async () => { calls += 1; });
    await recordOwnWriteOfCall({ orgId: ORG, connectorType: "jira", tool: "getJiraIssue", args: { issueIdOrKey: "PAY-12" } });
    expect(calls).toBe(0);
  });
});

describe("the connector call path notes a write before it is sent", () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const atCall: { verdict?: string | undefined; table?: IntakePorts["table"] } = {};
  const jira = (): ResolvedConnector => {
    const connect = (async () => ({
      tools: [{ name: "editJiraIssue", description: "edit", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, fields: { type: "object" } }, required: ["issueIdOrKey"] } }],
      call: async (name: string, args: unknown) => { calls.push({ name, args }); if (atCall.table !== undefined) atCall.verdict = await ownWriteVerdictOf(atCall.table, jiraLabel()); return { content: [{ type: "text" as const, text: "{}" }] }; },
      close: async () => undefined,
    })) as unknown as ResolvedConnector["connect"];
    return {
      name: "jira", type: "jira", label: "Jira issues", vendor: "Jira", scopeNoun: "site", scopes: [{ alias: "site", scope: {} }],
      policy: { tools: [{ name: "editJiraIssue", access: "write" }] }, approvals: [{ name: "editJiraIssue" }], attribution: false, ledger: { prefix: "JIRA", entityType: "JIRA" },
      configured: async () => true,
      definition: async () => ({ label: "Jira", endpoint: new URL("https://mcp.jira.test/mcp"), permissionsHint: "x", credentials: { issue: async () => ({ token: "t", bindings: {} }) }, binder: { properties: [], bind: () => ({}) }, guards: [] }),
      ...(connect === undefined ? {} : { connect }),
    };
  };
  const workspace = { projectName: "web" } as WorkspaceInstance;
  const context = { orgId: ORG, workspaceId: "ws", ownerKey: "owner", settingsRevision: 1 };
  const run = async (catalogs: CatalogCache<ScopeDiscovery>) => {
    const found = await discoverConnector({ connector: jira(), workspace, context, catalogs });
    const scope = found.tools[0]!.scopes[0]!;
    return callConnector({
      connector: jira(), workspace, context, catalogs, ledger: { claim: async () => true, get: async () => undefined, finish: async () => undefined },
      request: { requestId: randomUUID(), scope: scope.alias, tool: "editJiraIssue", schemaHash: scope.schemaHash, arguments: { issueIdOrKey: "PAY-12", fields: { labels: ["rovara"] } } },
    });
  };

  it("the note is already there when the vendor is called, and the event that comes back is Rovara's", async () => {
    const w = world();
    calls.length = 0;
    registerOwnWriteRecorder((orgId, note) => noteOwnWrite(w.ports.table, orgId, note));
    atCall.verdict = undefined;
    atCall.table = w.ports.table;
    const result = await run(new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 4 }));
    expect(result.status).toBe("SUCCEEDED");
    expect(atCall.verdict).toBe("own");
    expect(await ingestIntake(w.ports, jiraLabel())).toEqual({ outcome: "skipped", reason: "caused_by_rovara" });
  });

  it("a note that can't be made stops the call: nothing is sent to the vendor", async () => {
    calls.length = 0;
    registerOwnWriteRecorder(async () => { throw new AgentXError("RUNTIME_UNAVAILABLE", "the note can't be written"); });
    const catalogs = new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 4 });
    await expect(run(catalogs)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });
});

describe("what the event says was put on the ticket reaches the engine", () => {
  const base = { source: "jira", eventKey: "k", occurredAt: new Date(T0).toISOString(), project: PROJECT, subject: { kind: "issue", id: "PAY-12", title: "t", url: JIRA.url }, actor: { kind: "external", id: "acct-member", accountId: "acct-member" } } as const;
  it("carries the label of a labeled event and the assignee of an assigned one", () => {
    expect(intakeCandidateOf(ORG, { ...base, type: "issue.labeled", fields: { label: ["rovara"] } })?.act).toEqual({ kind: "label", value: "rovara" });
    expect(intakeCandidateOf(ORG, { ...base, type: "issue.assigned", fields: { assignee: ["acct-x"] } })?.act).toEqual({ kind: "assignee", value: "acct-x" });
    expect(intakeCandidateOf(ORG, { ...base, type: "issue.labeled", fields: {} })?.act).toBeUndefined();
  });
});

describe("the guard fails closed (review round 1)", () => {
  it("only a tool named for a read is a read: any other name is a write", () => {
    for (const tool of ["get_issue", "list_issues", "search_issues", "getJiraIssue", "searchJiraIssuesUsingJql", "read_file", "fetch_page", "query_logs"]) {
      expect(ownWriteNoteOf("github", tool, { owner: "a", repo: "b", issue_number: 1 }), tool).toBeUndefined();
    }
    for (const tool of ["frobnicate_issue", "listing_labels", "triage", "labelize", "reopen_issue", "assign_copilot_to_issue"]) {
      expect(ownWriteNoteOf("github", tool, { owner: "a", repo: "b", issue_number: 1 }), tool).toMatchObject({ system: "github", ticket: "a/b/1", touch: true });
    }
  });

  it("a write that names no ticket makes a wide note for its system", () => {
    expect(ownWriteNoteOf("github", "frobnicate", { title: "x" })).toEqual({ system: "github", wide: true });
    expect(ownWriteNoteOf("jira", "createJiraIssue", { projectKey: "PAY", fields: { labels: ["rovara"] } })).toEqual({ system: "jira", wide: true });
  });

  it("a connector type with no reader (a generic MCP server pointed at a tracker) makes an org-wide note for a write, and none for a read", () => {
    expect(ownWriteNoteOf("mcp", "update_ticket", { id: "T-1", label: "rovara" })).toEqual({ system: "*", wide: true });
    expect(ownWriteNoteOf("mcp", "get_ticket", { id: "T-1" })).toBeUndefined();
    // The native connectors only read.
    expect(ownWriteNoteOf("sentry", "resolve_issue", { id: "1" })).toBeUndefined();
  });

  it("an event right after a wide note waits for a member (unverified), in that system or any system for an org-wide note, and not in another org", async () => {
    const w = world();
    await noteOwnWrite(w.ports.table, ORG, { system: "*", wide: true });
    expect(await ingestIntake(w.ports, jiraLabel())).toEqual({ outcome: "waiting", reason: "unverified" });
    const g = world();
    await noteOwnWrite(g.ports.table, ORG, { system: "github", wide: true });
    expect(await ingestIntake(g.ports, jiraLabel())).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(g.ports, githubLabel())).toEqual({ outcome: "waiting", reason: "unverified" });
    const other = world();
    await noteOwnWrite(other.ports.table, OTHER_ORG, { system: "*", wide: true });
    expect((await ingestIntake(other.ports, jiraLabel())).outcome).toBe("started");
  });

  it("a write with no recorder registered is refused and nothing is sent; a read is not", async () => {
    registerOwnWriteRecorder(undefined);
    await expect(recordOwnWriteOfCall({ orgId: ORG, connectorType: "jira", tool: "editJiraIssue", args: { issueIdOrKey: "PAY-12" } })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(recordOwnWriteOfCall({ orgId: ORG, connectorType: "mcp", tool: "post_message", args: {} })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(recordOwnWriteOfCall({ orgId: ORG, connectorType: "jira", tool: "getJiraIssue", args: { issueIdOrKey: "PAY-12" } })).resolves.toBeUndefined();
  });
});
