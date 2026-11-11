// Meta repo lane F (F1): the routes of intake. Contributors see and start the tickets that wait for a member; a maintainer sets the places work is asked for; a project the caller can't see answers 404.
import { describe, expect, it } from "vitest";
import { agentXError, intakeItemIdOf, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { INTAKE_PATH, routeIntakeRequest } from "../../packages/broker/src/intake/routes.js";
import { listIntakeSources, replaceIntakeSources, intakeSourceIdOf } from "../../packages/broker/src/intake/sources.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MEMBER = "a".repeat(64);
const REQUEST = "0b1c2d3e-4f50-4162-8374-8495a6b7c8d9";
const REF = { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };

function world() {
  const db = new FakeDynamoDb();
  const table = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00.000Z") };
  const started: string[] = [];
  const mayStart = new Set<string>([MEMBER]);
  const ports: IntakePorts = {
    table, log: () => undefined,
    memberOfAccount: async () => undefined,
    mayStart: async (_org, developerId) => mayStart.has(developerId),
    start: async (_org, developerId) => { started.push(developerId); return { task: { taskId: "task-1" }, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }; },
    sessionOfTicket: async () => undefined,
  };
  const roles = new Map<string, ProjectRole>([["web", "contributor"], ["api", "maintainer"], ["docs", "viewer"]]);
  const projectFor = async (caller: { orgId: OrgId }, raw: string): Promise<{ name: string; role: ProjectRole }> => {
    const role = caller.orgId === ORG ? roles.get(raw) : undefined;
    if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "no such project");
    return { name: raw, role };
  };
  const caller = (over: Record<string, unknown> = {}) => ({ developerId: MEMBER, orgId: ORG, orgRole: "member", name: "Maya", sessionId: "s", amr: "oidc", ...over }) as never;
  const call = async (path: string, method: string, body: unknown, who = caller()) => {
    const match = INTAKE_PATH.exec(path);
    if (match === null) throw new Error("not an intake path");
    return routeIntakeRequest({ ports, projectFor }, who, method, match, body);
  };
  const ticket = (project: string, id = "PAY-12"): IntakeCandidate => ({ orgId: ORG, project, channel: "jira", externalRef: { ...REF, id, url: `https://acme.atlassian.net/browse/${id}` }, title: "Refunds fail", body: "Details", reporter: { display: "Dana" } });
  return { db, table, ports, started, mayStart, call, ticket, caller };
}

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe("the intake path", () => {
  it("matches the list, the start of one ticket and the sources, and nothing else", () => {
    expect(INTAKE_PATH.test("/v1/app/projects/web/intake")).toBe(true);
    expect(INTAKE_PATH.test("/v1/app/projects/web/intake/sources")).toBe(true);
    expect(INTAKE_PATH.test(`/v1/app/projects/web/intake/${"a".repeat(32)}/start`)).toBe(true);
    expect(INTAKE_PATH.test("/v1/app/projects/web/intake/xyz/start")).toBe(false);
    expect(INTAKE_PATH.test("/v1/app/projects/web/intake/sources/x")).toBe(false);
  });
});

describe("the waiting tickets", () => {
  it("lists them for someone who can start tasks, as text and ids only", async () => {
    const w = world();
    await ingestIntake(w.ports, w.ticket("web"));
    const reply = await w.call("/v1/app/projects/web/intake", "GET", undefined);
    expect(reply.statusCode).toBe(200);
    const body = reply.body as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ itemId: intakeItemIdOf("jira", "PAY-12"), system: "jira", id: "PAY-12", title: "Refunds fail", reason: "outsider" });
    // The stored body is not sent to the list.
    expect(JSON.stringify(body)).not.toContain("Details");
  });

  it("does not list another project's tickets", async () => {
    const w = world();
    await ingestIntake(w.ports, w.ticket("api"));
    expect(((await w.call("/v1/app/projects/web/intake", "GET", undefined)).body as { items: unknown[] }).items).toEqual([]);
  });

  it("refuses a viewer, and answers 404 for a project the caller can't see or another org's", async () => {
    const w = world();
    expect(await code(w.call("/v1/app/projects/docs/intake", "GET", undefined))).toBe("FORBIDDEN");
    expect(await code(w.call("/v1/app/projects/ghost/intake", "GET", undefined))).toBe("PROJECT_NOT_FOUND");
    expect(await code(w.call("/v1/app/projects/web/intake", "GET", undefined, w.caller({ orgId: OTHER_ORG })))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("a member says Start", () => {
  it("starts the ticket as the member who pressed it, then answers a repeat without starting again", async () => {
    const w = world();
    await ingestIntake(w.ports, w.ticket("web"));
    const path = `/v1/app/projects/web/intake/${intakeItemIdOf("jira", "PAY-12")}/start`;
    const first = await w.call(path, "POST", { requestId: REQUEST });
    expect(first.statusCode).toBe(202);
    expect(first.body).toMatchObject({ started: true, taskId: "task-1" });
    const again = await w.call(path, "POST", { requestId: REQUEST });
    expect(again.body).toMatchObject({ started: false, state: "started" });
    expect(w.started).toEqual([MEMBER]);
  });

  it("refuses a viewer, a body that is not a request, and a ticket that is not there", async () => {
    const w = world();
    await ingestIntake(w.ports, w.ticket("web"));
    const path = `/v1/app/projects/web/intake/${intakeItemIdOf("jira", "PAY-12")}/start`;
    expect(await code(w.call(`/v1/app/projects/docs/intake/${intakeItemIdOf("jira", "PAY-12")}/start`, "POST", { requestId: REQUEST }))).toBe("FORBIDDEN");
    expect(await code(w.call(path, "POST", { requestId: "nope" }))).toBe("CONFIG_INVALID");
    expect(await code(w.call(path, "POST", { requestId: REQUEST, extra: 1 }))).toBe("CONFIG_INVALID");
    expect(await code(w.call(`/v1/app/projects/web/intake/${"b".repeat(32)}/start`, "POST", { requestId: REQUEST }))).toBe("NOT_FOUND");
    expect(await code(w.call(path, "GET", undefined))).toBe("NOT_FOUND");
    expect(w.started).toEqual([]);
  });

  it("refuses a member who can see the project but whose role no longer starts tasks", async () => {
    const w = world();
    await ingestIntake(w.ports, w.ticket("web"));
    w.mayStart.delete(MEMBER);
    expect(await code(w.call(`/v1/app/projects/web/intake/${intakeItemIdOf("jira", "PAY-12")}/start`, "POST", { requestId: REQUEST }))).toBe("FORBIDDEN");
    expect(w.started).toEqual([]);
  });
});

describe("the sources", () => {
  const SOURCE = { channel: "tracker", system: "sim", when: { label: "rovara" } };

  it("a maintainer sets them, a contributor can't, and the poll's state is kept when settings change", async () => {
    const w = world();
    expect(await code(w.call("/v1/app/projects/web/intake/sources", "PUT", { sources: [SOURCE] }))).toBe("FORBIDDEN");
    const saved = await w.call("/v1/app/projects/api/intake/sources", "PUT", { sources: [SOURCE] });
    expect(saved.statusCode).toBe(200);
    const [record] = await listIntakeSources(w.table, ORG, "api");
    expect(record).toMatchObject({ ref: SOURCE, failures: 0, setBy: MEMBER });
    // The poll noted a failure; a settings change does not forget it or make the source due at once.
    w.db.set({ ...w.db.get({ pk: "INTAKE_SOURCES", sk: `${ORG}#api#${record!.sourceId}` })!, failures: 3, nextPollAt: 99 });
    await w.call("/v1/app/projects/api/intake/sources", "PUT", { sources: [{ ...SOURCE, poll: { everyMinutes: 5 } }] });
    expect((await listIntakeSources(w.table, ORG, "api"))[0]).toMatchObject({ failures: 3, nextPollAt: 99, ref: { poll: { everyMinutes: 5 } } });
  });

  it("deletes a source that is no longer named, and keeps projects apart", async () => {
    const w = world();
    await w.call("/v1/app/projects/api/intake/sources", "PUT", { sources: [SOURCE, { channel: "jira", when: { label: "rovara" } }] });
    await replaceIntakeSources(w.table, { orgId: ORG, project: "other", refs: [{ channel: "tracker", system: "sim", when: { label: "x" } }], setBy: MEMBER });
    await w.call("/v1/app/projects/api/intake/sources", "PUT", { sources: [SOURCE] });
    expect((await listIntakeSources(w.table, ORG, "api")).map((record) => record.ref.channel)).toEqual(["tracker"]);
    expect(await listIntakeSources(w.table, ORG, "other")).toHaveLength(1);
    expect(await listIntakeSources(w.table, OTHER_ORG, "api")).toEqual([]);
  });

  it("refuses a source with an address for a connection, an unknown key, too many sources and the same place twice", async () => {
    const w = world();
    const put = (sources: unknown) => code(w.call("/v1/app/projects/api/intake/sources", "PUT", { sources }));
    expect(await put([{ ...SOURCE, connection: "https://evil.example" }])).toBe("CONFIG_INVALID");
    expect(await put([{ ...SOURCE, token: "x" }])).toBe("CONFIG_INVALID");
    expect(await put(Array.from({ length: 9 }, (_, index) => ({ ...SOURCE, system: `s${String(index)}` })))).toBe("CONFIG_INVALID");
    expect(await put([SOURCE, SOURCE])).toBe("CONFIG_INVALID");
    expect(intakeSourceIdOf(SOURCE as never)).toMatch(/^[a-f0-9]{24}$/);
  });
});
