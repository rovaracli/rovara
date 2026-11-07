// Slice 5 "Outside tools", intake: a Jira or Linear account counts as a member only through a link the company holds (never a guess); a ticket with no linked member waits and says why; a member
// can say "Not this one"; the project's ticket updates settings; failing watched sources say why; and the waiting tickets and failing sources are Home cards for the right people only.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { agentXError, intakeItemIdOf, intakeNoticeKey, intakeSourceKey, teamRecordPk, type OrgId, type ProjectRole } from "@agentx/contracts";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { jiraSiteOf } from "../../packages/broker/src/intake/identity.js";
import { intakeSourceHomeSource, waitingTicketHomeSource } from "../../packages/broker/src/intake/home-source.js";
import { INTAKE_PATH, routeIntakeRequest } from "../../packages/broker/src/intake/routes.js";
import { listIntakeSources, replaceIntakeSources } from "../../packages/broker/src/intake/sources.js";
import { readIntakeItem } from "../../packages/broker/src/intake/store.js";
import { intakePortsOf, type IntakeWiring } from "../../packages/broker/src/intake/wiring.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const DANA = "d".repeat(64);
const VIC = "v".repeat(64);
const NOW = Date.parse("2026-11-07T10:00:00.000Z");
const REQUEST = "0b1c2d3e-4f50-4162-8374-8495a6b7c8d9";
const REQUEST_2 = "1b1c2d3e-4f50-4162-8374-8495a6b7c8d9";

const ticket = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  orgId: ORG, project: "web", channel: "jira", externalRef: { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" },
  title: "Refunds fail", body: "Details", reporter: { display: "Dana" }, actor: { kind: "person", accountId: "acct-dana", display: "Dana" }, ...over,
});

async function link(db: FakeDynamoDb, system: string, sourceId: string, developerId: string, orgId: OrgId = ORG): Promise<void> {
  await db.send(new PutCommand({ TableName: "record", Item: { pk: teamRecordPk(orgId), sk: `TRLINK#${system}#${sourceId}`, entityType: "TEAM_RECORD_TRACKER_LINK", orgId, developerId, via: "admin", at: new Date(NOW).toISOString() } }));
}

function wired(options: { links?: boolean; removed?: Set<string> } = {}) {
  const db = new FakeDynamoDb();
  const started: string[] = [];
  const wiring: IntakeWiring = {
    documentClient: db, tableName: "state", now: () => NOW,
    starter: { callerFor: async (orgId: OrgId, developerId: string) => (orgId !== ORG || options.removed?.has(developerId) === true ? undefined : { developerId, orgId }) } as never,
    intentDependenciesFor: () => { throw new Error("not under test"); },
    ...(options.links === false ? {} : { trackerLinks: { documentClient: db, tableName: "record" } }),
  };
  const built = intakePortsOf(wiring);
  const ports: IntakePorts = {
    ...built,
    mayStart: async (_org, developerId) => developerId === DANA,
    start: async (_org, developerId) => { started.push(developerId); return { task: { taskId: "11111111-1111-4111-8111-111111111111" }, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }; },
    sessionOfTicket: async () => undefined,
  };
  delete (ports as { started?: unknown }).started;
  return { db, ports, started };
}

describe("who a Jira or Linear account is (slice 5)", () => {
  it("is the member the company linked to that account on that Jira site, and starts the ticket as them", async () => {
    const w = wired();
    await link(w.db, "jira:acme.atlassian.net", "acct-dana", DANA);
    expect(await w.ports.memberOfAccount(ORG, "jira", "acct-dana", "https://acme.atlassian.net/browse/PAY-12")).toBe(DANA);
    expect(await ingestIntake(w.ports, ticket())).toMatchObject({ outcome: "started" });
    expect(w.started).toEqual([DANA]);
  });

  it("never guesses: the same account id on another site, a link outside Atlassian, another org, or a removed member is nobody", async () => {
    const w = wired({ removed: new Set([VIC]) });
    await link(w.db, "jira:acme.atlassian.net", "acct-dana", DANA);
    await link(w.db, "linear", "lin-vic", VIC);
    expect(await w.ports.memberOfAccount(ORG, "jira", "acct-dana", "https://other.atlassian.net/browse/PAY-12")).toBeUndefined();
    expect(await w.ports.memberOfAccount(ORG, "jira", "acct-dana", "https://acme.atlassian.net.evil.example/browse/PAY-12")).toBeUndefined();
    expect(await w.ports.memberOfAccount(ORG, "jira", "acct-dana")).toBeUndefined();
    expect(await w.ports.memberOfAccount(OTHER_ORG, "jira", "acct-dana", "https://acme.atlassian.net/browse/PAY-12")).toBeUndefined();
    expect(await w.ports.memberOfAccount(ORG, "linear", "lin-vic")).toBeUndefined();
    expect(jiraSiteOf("https://acme.atlassian.net/browse/X-1")).toBe("acme.atlassian.net");
    expect(jiraSiteOf("http://acme.atlassian.net/browse/X-1")).toBeUndefined();
  });

  it("resolves a Linear account through the company's Linear link", async () => {
    const w = wired();
    await link(w.db, "linear", "lin-dana", DANA);
    expect(await w.ports.memberOfAccount(ORG, "linear", "lin-dana")).toBe(DANA);
    expect(await w.ports.memberOfAccount(ORG, "linear", "lin-nobody")).toBeUndefined();
  });

  it("keeps a ticket from an unlinked person waiting with the reason `unlinked`, and starts nothing (no links at all: the same)", async () => {
    for (const links of [true, false]) {
      const w = wired({ links });
      expect(await ingestIntake(w.ports, ticket())).toEqual({ outcome: "waiting", reason: "unlinked" });
      expect(w.started).toEqual([]);
      expect(await readIntakeItem(w.ports.table, ORG, "web", intakeItemIdOf("jira", "PAY-12"))).toMatchObject({ state: "waiting", reason: "unlinked", requester: { standing: "outsider" } });
    }
  });
});

function routed() {
  const db = new FakeDynamoDb();
  const table = { documentClient: db, tableName: "state", now: () => NOW };
  const started: string[] = [];
  const ports: IntakePorts = {
    table, log: () => undefined, memberOfAccount: async () => undefined, mayStart: async () => true,
    start: async (_org, developerId) => { started.push(developerId); return { task: { taskId: "task-1" }, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }; },
    sessionOfTicket: async () => undefined,
  };
  const roles = new Map<string, ProjectRole>([["web", "contributor"], ["api", "maintainer"], ["docs", "viewer"]]);
  const projectFor = async (caller: { orgId: OrgId }, raw: string) => {
    const role = caller.orgId === ORG ? roles.get(raw) : undefined;
    if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "no such project");
    return { name: raw, role };
  };
  const caller = (over: Record<string, unknown> = {}) => ({ developerId: DANA, orgId: ORG, orgRole: "member", ...over }) as never;
  const call = async (path: string, method: string, body: unknown, who = caller()) => {
    const match = INTAKE_PATH.exec(path);
    if (match === null) throw new Error("not an intake path");
    return routeIntakeRequest({ ports, projectFor }, who, method, match, body);
  };
  return { db, table, ports, started, call, caller };
}
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe("Not this one", () => {
  it("takes the ticket off the waiting list for good: a poll that sees it again, a repeat and a Start all leave it", async () => {
    const w = routed();
    await ingestIntake(w.ports, ticket({ project: "web", actor: undefined }));
    const itemId = intakeItemIdOf("jira", "PAY-12");
    expect((await w.call(`/v1/app/projects/web/intake/${itemId}/dismiss`, "POST", { requestId: REQUEST })).body).toEqual({ dismissed: true });
    expect((await w.call(`/v1/app/projects/web/intake/${itemId}/dismiss`, "POST", { requestId: REQUEST_2 })).body).toEqual({ dismissed: true });
    expect((await w.call("/v1/app/projects/web/intake", "GET", undefined)).body).toMatchObject({ items: [] });
    // The poll sees the ticket again: it stays dismissed and nothing starts.
    expect(await ingestIntake(w.ports, ticket({ project: "web", actor: undefined }))).toEqual({ outcome: "duplicate", state: "dismissed" });
    expect((await w.call(`/v1/app/projects/web/intake/${itemId}/start`, "POST", { requestId: REQUEST })).body).toMatchObject({ started: false });
    expect(w.started).toEqual([]);
    // The ticket's words are gone from the stored item.
    expect(await readIntakeItem(w.table, ORG, "web", itemId)).toMatchObject({ state: "dismissed", title: "", dismissedBy: DANA });
  });

  it("is refused to a viewer and answers 404 for another org's project or a ticket that does not wait", async () => {
    const w = routed();
    await ingestIntake(w.ports, ticket({ project: "docs", actor: undefined }));
    const itemId = intakeItemIdOf("jira", "PAY-12");
    expect(await code(w.call(`/v1/app/projects/docs/intake/${itemId}/dismiss`, "POST", { requestId: REQUEST }))).toBe("FORBIDDEN");
    expect(await code(w.call(`/v1/app/projects/web/intake/${itemId}/dismiss`, "POST", { requestId: REQUEST }))).toBe("NOT_FOUND");
    expect(await code(w.call(`/v1/app/projects/docs/intake/${itemId}/dismiss`, "POST", { requestId: REQUEST }, w.caller({ orgId: OTHER_ORG })))).toBe("PROJECT_NOT_FOUND");
    expect(await code(w.call(`/v1/app/projects/web/intake/${itemId}/dismiss`, "POST", {}))).toBe("CONFIG_INVALID");
  });
});

describe("the ticket updates settings", () => {
  it("reads the safe defaults (comments on, status changes OFF, never a private task to a public tracker) and lets only a maintainer change them", async () => {
    const w = routed();
    const read = await w.call("/v1/app/projects/web/intake/updates", "GET", undefined);
    expect(read.body).toMatchObject({ settings: { comments: true, changeStatus: false, privateSessions: false, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } }, canEdit: false });
    const settings = { comments: true, changeStatus: true, statuses: { started: "Doing" }, privateSessions: false };
    expect(await code(w.call("/v1/app/projects/web/intake/updates", "PUT", { requestId: REQUEST, settings }))).toBe("FORBIDDEN");
    expect((await w.call("/v1/app/projects/api/intake/updates", "PUT", { requestId: REQUEST, settings })).body).toMatchObject({ settings, canEdit: true });
    // The same request again answers the same and writes nothing more; the same id with other settings is refused; a fresh id over a stale read is a clear conflict path (revision moves).
    expect((await w.call("/v1/app/projects/api/intake/updates", "PUT", { requestId: REQUEST, settings })).body).toMatchObject({ settings });
    expect(await code(w.call("/v1/app/projects/api/intake/updates", "PUT", { requestId: REQUEST, settings: { ...settings, comments: false } }))).toBe("CONFIG_INVALID");
    expect((await w.call("/v1/app/projects/api/intake/updates", "GET", undefined)).body).toMatchObject({ settings });
    // Another org reads nothing of it.
    expect(await code(w.call("/v1/app/projects/api/intake/updates", "GET", undefined, w.caller({ orgId: OTHER_ORG })))).toBe("PROJECT_NOT_FOUND");
    expect(await code(w.call("/v1/app/projects/api/intake/updates", "PUT", { requestId: REQUEST_2, settings: { ...settings, statuses: { started: "x\u0000" } } }))).toBe("CONFIG_INVALID");
  });
});

describe("a failing watched source says why", () => {
  it("shows since when and the code of its last failure, never the tracker's words", async () => {
    const w = routed();
    const [source] = await replaceIntakeSources(w.table, { orgId: ORG, project: "api", refs: [{ channel: "tracker", system: "linear", when: { label: "rovara" } }], setBy: DANA });
    const key = intakeSourceKey(ORG, "api", source!.sourceId);
    const record = (await listIntakeSources(w.table, ORG, "api"))[0]!;
    await w.db.send(new PutCommand({ TableName: "state", Item: { ...key, entityType: "INTAKE_SOURCE", ...record, failures: 3, failingSince: NOW - 2 * 3_600_000, lastError: "CONNECTION_MISSING" } }));
    const reply = await w.call("/v1/app/projects/api/intake", "GET", undefined);
    expect((reply.body as { sources: unknown[] }).sources).toEqual([{ sourceId: source!.sourceId, ref: source!.ref, failing: true, failingSince: new Date(NOW - 2 * 3_600_000).toISOString(), lastError: "CONNECTION_MISSING" }]);
  });
});

describe("intake on Home", () => {
  function home(db: FakeDynamoDb, roles: Record<string, ProjectRole>) {
    const deps = {
      documentClient: db, tableName: "state", now: () => NOW, origin: "https://app.rovara.test",
      approvals: { projectMembers: { projectsOf: async (orgId: OrgId) => (orgId === ORG ? Object.entries(roles).map(([project, role]) => ({ project, role })) : []) } },
    } as never;
    return deps;
  }
  const caller = { orgId: ORG, developerId: DANA, orgRole: "member" } as never;

  it("shows a waiting ticket, with why it waits and Start / Not this one, only to someone who can start tasks in its project", async () => {
    const w = routed();
    await ingestIntake(w.ports, ticket({ project: "web", actor: { kind: "person", accountId: "acct-x" } }));
    await ingestIntake(w.ports, ticket({ project: "docs", actor: undefined }));
    const cards = await waitingTicketHomeSource.list(home(w.db, { web: "contributor", docs: "viewer" }), caller, {} as never);
    expect(cards).toHaveLength(1);
    const itemId = intakeItemIdOf("jira", "PAY-12");
    expect(cards[0]).toMatchObject({ kind: "waiting_ticket", title: "Jira PAY-12: Refunds fail" });
    expect(cards[0]!.reason).toContain("Nobody in your company is linked");
    expect(cards[0]!.buttons).toEqual([
      { label: "Start", action: "start", href: `https://app.rovara.test/v1/app/projects/web/intake/${itemId}/start`, method: "POST" },
      { label: "Not this one", action: "dismiss", href: `https://app.rovara.test/v1/app/projects/web/intake/${itemId}/dismiss`, method: "POST" },
    ]);
    // Another org's caller sees none of it.
    expect(await waitingTicketHomeSource.list(home(w.db, { web: "contributor" }), { orgId: OTHER_ORG, developerId: DANA, orgRole: "member" } as never, {} as never)).toEqual([]);
  });

  it("shows a failing watched source to the project's maintainers once it was noticed or failed for an hour, and not once it works again", async () => {
    const w = routed();
    const [source] = await replaceIntakeSources(w.table, { orgId: ORG, project: "api", refs: [{ channel: "tracker", system: "linear", when: { label: "rovara" } }], setBy: DANA });
    const key = intakeSourceKey(ORG, "api", source!.sourceId);
    const record = (await listIntakeSources(w.table, ORG, "api"))[0]!;
    const put = (fields: Record<string, unknown>) => w.db.send(new PutCommand({ TableName: "state", Item: { ...key, entityType: "INTAKE_SOURCE", ...record, ...fields } }));
    await put({ failures: 1, failingSince: NOW - 5 * 60_000, lastError: "TIMEOUT" });
    expect(await intakeSourceHomeSource.list(home(w.db, { api: "maintainer" }), caller, {} as never)).toEqual([]);
    // The poll's notice to this maintainer (their own partition) makes it a card at once.
    await w.db.send(new PutCommand({ TableName: "state", Item: { ...intakeNoticeKey(ORG, DANA, new Date(NOW).toISOString(), source!.sourceId), entityType: "INTAKE_NOTICE", orgId: ORG, project: "api", sourceId: source!.sourceId, developerId: DANA } }));
    const cards = await intakeSourceHomeSource.list(home(w.db, { api: "maintainer" }), caller, {} as never);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "intake_source", title: "Rovara can't read the Linear tickets for \"api\"", buttons: [{ action: "open", href: "https://app.rovara.test/app/projects/api#tickets" }] });
    expect(cards[0]!.reason).toContain("took too long");
    // A contributor is not told; a source that works again has no card.
    expect(await intakeSourceHomeSource.list(home(w.db, { api: "contributor" }), caller, {} as never)).toEqual([]);
    await put({ failures: 0 });
    expect(await intakeSourceHomeSource.list(home(w.db, { api: "maintainer" }), caller, {} as never)).toEqual([]);
  });
});
