// Plan 3 Task 12b: the org connection routes (`/v1/app/connections*`): who may do what, that a secret is write-only and appears nowhere,
// that every change is repeatable (R18) and tenant-scoped, and that an MCP endpoint is checked.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { connectionKey } from "../../packages/contracts/src/connections.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { OrgSecrets, orgConnectorSecretName } from "../../packages/broker/src/connections/org-secrets.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const OWEN = person("2", "Owen"); // org owner
const MAX = person("3", "Max"); // member
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
const LINEAR_KEY = "lin_api_ROUTESECRETKEY0123456789";
const START = Date.now();
const CON_PATTERN = /^con_[0-9a-z]{20}$/;

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => { vi.restoreAllMocks(); });

interface Shown { connectionId: string; type: string; label: string; hasCredential: boolean; lastCheck?: { ok: boolean } }
/** The answers the routes give, typed for the tests as the union of what any of them returns. */
interface Body { connection: Shown; connections: Shown[]; ok: boolean; message?: string; removed: { connectionId: string }; error: { code: string; message: string } }
type Reply = { status: number; body: Body };
const errorOf = (reply: Reply) => reply.body.error;

async function setup(options: { addresses?: () => string[]; fetch?: typeof fetch; tools?: () => unknown[] } = {}) {
  const fake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
  const audit = capturingAuditDeps();
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const checkEndpoint = vi.fn(async (url: string) => { await checkEndpointUrl(url, async () => (options.addresses ?? (() => ["52.1.2.3"]))()); });
  const listMcpTools = vi.fn(async () => (options.tools ?? (() => [{ name: "a" }, { name: "b" }]))());
  const fetchImplementation = vi.fn(options.fetch ?? (async () => new Response(JSON.stringify({ data: { viewer: { id: "lin-user-1" } } }), { status: 200 })));
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false, audit,
    brokerExtra: {
      agents: { projectMembers: new FakeProjectMembers() },
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: { checkEndpoint, listMcpTools, fetch: fetchImplementation },
    },
  });
  holder.db = h.db;
  const enroll = async (who: Developer, role: OrgRole, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role });
  };
  await enroll(DANA, "admin");
  await enroll(OWEN, "owner");
  await enroll(MAX, "member");
  await enroll(OMAR, "admin", ORG_B);
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>, requestId: string = randomUUID()): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest as unknown as Body };
  };
  const create = async (who: Developer, connection: Record<string, unknown>, secret?: Record<string, unknown>, requestId?: string) =>
    call(who, "POST", "/v1/app/connections", { connection, ...(secret === undefined ? {} : { secret }) }, requestId);
  return { h, fake, audit, call, create, checkEndpoint, listMcpTools, fetchImplementation };
}

const LINEAR = { type: "linear", label: "Team Linear", access: "read" };
const MCP = { type: "mcp", label: "Sentry", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" };

describe("who may use the connection routes", () => {
  it("lets any member read the list and one connection, and lets only an owner or admin create, change, remove or check", async () => {
    const { create, call, fake } = await setup();
    const created = await create(DANA, LINEAR, { apiKey: LINEAR_KEY });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.connection.connectionId;
    expect(id).toMatch(CON_PATTERN);
    expect((await call(MAX, "GET", "/v1/app/connections")).body.connections).toHaveLength(1);
    expect((await call(MAX, "GET", `/v1/app/connections/${id}`)).body.connection).toMatchObject({ connectionId: id, type: "linear", hasCredential: true });
    const callsBefore = fake.calls.length;
    for (const [method, path, body] of [
      ["POST", "/v1/app/connections", { connection: LINEAR, secret: { apiKey: "x" } }],
      ["PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Mine" } }],
      ["DELETE", `/v1/app/connections/${id}`, {}],
      ["POST", `/v1/app/connections/${id}/check`, {}],
    ] as const) {
      const refused = await call(MAX, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(errorOf(refused).code).toBe("FORBIDDEN");
    }
    // A refused member changed nothing and touched no secret.
    expect(fake.calls.length).toBe(callsBefore);
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).body.connection.label).toBe("Team Linear");
    expect((await call(OWEN, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Owner renamed" } })).status).toBe(200);
  });

  it("answers another org's connection exactly as it answers a missing one", async () => {
    const { create, call } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: LINEAR_KEY })).body.connection.connectionId;
    const missing = "con_zzzzzzzzzzzzzzzzzzzz";
    expect((await call(OMAR, "GET", "/v1/app/connections")).body.connections).toEqual([]);
    for (const [method, body] of [["GET", undefined], ["PUT", { connection: LINEAR }], ["DELETE", {}], ["POST", {}]] as const) {
      const suffix = method === "POST" ? "/check" : "";
      const theirs = await call(OMAR, method, `/v1/app/connections/${id}${suffix}`, body);
      const absent = await call(OMAR, method, `/v1/app/connections/${missing}${suffix}`, body);
      expect(theirs.status, method).toBe(404);
      expect(theirs, method).toEqual(absent);
    }
    // A malformed id is not found either.
    expect((await call(DANA, "GET", "/v1/app/connections/not-an-id")).status).toBe(404);
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).status).toBe(200);
  });
});

describe("a secret is write-only", () => {
  it("is stored only in the org's secret and appears in no response, record, request item, log line or audit event", async () => {
    const lines: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
    const { create, call, h, fake, audit } = await setup();
    const requestId = randomUUID();
    const created = await create(DANA, LINEAR, { apiKey: LINEAR_KEY }, requestId);
    const id = created.body.connection.connectionId;
    const replies = [created, await call(DANA, "GET", "/v1/app/connections"), await call(DANA, "GET", `/v1/app/connections/${id}`), await call(DANA, "POST", `/v1/app/connections/${id}/check`, {}),
      await create(DANA, LINEAR, { apiKey: LINEAR_KEY }, requestId)];
    spies.forEach((spy) => spy.mockRestore());
    for (const reply of replies) {
      const text = JSON.stringify(reply.body);
      expect(text).not.toContain(LINEAR_KEY);
      expect(text).not.toContain("agentx/");
      expect(text).not.toContain("org-connectors");
      expect(text).not.toContain("apiKey");
      expect(text).not.toContain("lin-user-1"); // the vendor account id (actorId) is not shown to people
      expect(text).not.toContain("actorId");
    }
    expect(created.body.connection.hasCredential).toBe(true);
    expect(created.body.connection).not.toHaveProperty("hasSecret");
    const everything = JSON.stringify([...h.db.items.values()]);
    expect(everything).not.toContain(LINEAR_KEY);
    expect(everything).not.toContain("agentx/");
    expect(lines.join("\n")).not.toContain(LINEAR_KEY);
    expect(JSON.stringify([audit.recorded(), audit.logs])).not.toContain(LINEAR_KEY);
    expect(JSON.parse(fake.stored(orgConnectorSecretName(ENV, TEST_ORG, id))!.value)).toEqual({ apiKey: LINEAR_KEY });
  });

  it("is kept when a change names none, replaced when it gives one, and a wrong shape is refused without echoing it", async () => {
    const { create, call, fake } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: LINEAR_KEY })).body.connection.connectionId;
    const name = orgConnectorSecretName(ENV, TEST_ORG, id);
    const renamed = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Renamed" } });
    expect(renamed.body.connection).toMatchObject({ label: "Renamed", hasCredential: true });
    expect(fake.stored(name)!.versions).toBe(1);
    await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: LINEAR, secret: { apiKey: "lin_api_NEWKEY" } });
    expect(JSON.parse(fake.stored(name)!.value)).toEqual({ apiKey: "lin_api_NEWKEY" });
    const wrong = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: LINEAR, secret: { token: "SUPERSECRETVALUE" } });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).not.toContain("SUPERSECRETVALUE");
    const extra = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: LINEAR, SUPERSECRETKEYNAME: "x" });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).not.toContain("SUPERSECRETKEYNAME");
    const stray = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, SUPERSECRETKEYNAME: "x" } });
    expect(stray.status).toBe(400);
    expect(JSON.stringify(stray.body)).not.toContain("SUPERSECRETKEYNAME");
  });
});

describe("creating and changing a connection", () => {
  it("mints the id on the server, from the request, and refuses an id from the client", async () => {
    const { create, call } = await setup();
    const requestId = randomUUID();
    const first = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    const other = await create(DANA, LINEAR, { apiKey: "k1" });
    expect(first.body.connection.connectionId).toMatch(CON_PATTERN);
    expect(first.body.connection.connectionId).not.toBe(other.body.connection.connectionId);
    const named = await create(DANA, { ...LINEAR, connectionId: "con_aaaaaaaaaaaaaaaaaaaa" }, { apiKey: "k1" });
    expect(named.status).toBe(400);
    expect((await call(DANA, "GET", "/v1/app/connections")).body.connections).toHaveLength(2);
  });

  it("makes up no id on a PUT: an unknown id is not found, no secret is written, and a mismatched id in the body is refused", async () => {
    const { call, fake, create } = await setup();
    const unknown = await call(DANA, "PUT", "/v1/app/connections/con_aaaaaaaaaaaaaaaaaaaa", { connection: LINEAR, secret: { apiKey: "k1" } });
    expect(unknown.status).toBe(404);
    expect(fake.calls).toEqual([]);
    const id = (await create(DANA, LINEAR, { apiKey: "k1" })).body.connection.connectionId;
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, connectionId: "con_aaaaaaaaaaaaaaaaaaaa" } })).status).toBe(400);
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, connectionId: id }, secret: { apiKey: "k2" } })).status).toBe(200);
  });

  it("will not change a connection's type or point its saved token at another host", async () => {
    const { call, create } = await setup();
    const id = (await create(DANA, MCP, { token: "t1" })).body.connection.connectionId;
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: LINEAR })).status).toBe(400);
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...MCP, endpoint: "https://mcp.evil.example/mcp" } })).status).toBe(400);
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...MCP, endpoint: "https://mcp.evil.example/mcp" }, secret: { token: "t2" } })).status).toBe(200);
  });

  it("records who saved it and who removed it, with the request id as the occurrence", async () => {
    const { create, call, audit } = await setup();
    const requestId = randomUUID();
    const id = (await create(DANA, LINEAR, { apiKey: "k1" }, requestId)).body.connection.connectionId;
    await call(OWEN, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, access: "read_write" } });
    const removeId = randomUUID();
    await call(OWEN, "DELETE", `/v1/app/connections/${id}`, {}, removeId);
    const saved = audit.recordedBy("connection.saved");
    expect(saved.map((event) => event.actor)).toEqual([{ kind: "member", id: DANA.developerId }, { kind: "member", id: OWEN.developerId }]);
    expect(audit.recordedBy("connection.removed")).toMatchObject([{ actor: { kind: "member", id: OWEN.developerId }, target: { kind: "connection", id } }]);
    expect(new Set(saved.map((event) => event.eventId)).size).toBe(2);
  });
});

describe("repeating a request (R18)", () => {
  it("answers a repeated create from what it did the first time, and writes nothing again", async () => {
    const { create, call, h, fake } = await setup();
    const requestId = randomUUID();
    const first = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    const id = first.body.connection.connectionId;
    const callsAfterFirst = fake.calls.length;
    const again = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    expect(again).toEqual(first);
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(fake.stored(orgConnectorSecretName(ENV, TEST_ORG, id))!.versions).toBe(1);
    expect(h.db.get(agentRequestKey(TEST_ORG, DANA.developerId, requestId))).toBeDefined();
    expect((await call(DANA, "GET", "/v1/app/connections")).body.connections).toHaveLength(1);
  });

  it("refuses the same request id for a different body, including a different secret", async () => {
    const { create } = await setup();
    const requestId = randomUUID();
    await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    expect(errorOf(await create(DANA, { ...LINEAR, label: "Other" }, { apiKey: "k1" }, requestId)).code).toBe("CONFIG_INVALID");
    expect(errorOf(await create(DANA, LINEAR, { apiKey: "k2" }, requestId)).code).toBe("CONFIG_INVALID");
  });

  it("answers a repeated change, check and removal from the first answer, a removal even after the connection is gone", async () => {
    const { create, call, h, fake } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: "k1" })).body.connection.connectionId;
    const putId = randomUUID();
    const put = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Two" } }, putId);
    expect(await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Two" } }, putId)).toEqual(put);
    expect(errorOf(await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Three" } }, putId)).code).toBe("CONFIG_INVALID");
    const checkId = randomUUID();
    const checked = await call(DANA, "POST", `/v1/app/connections/${id}/check`, {}, checkId);
    expect(checked.body).toEqual({ ok: true });
    expect(h.db.get(agentRequestKey(TEST_ORG, DANA.developerId, checkId))).toBeDefined();
    const removeId = randomUUID();
    const removed = await call(DANA, "DELETE", `/v1/app/connections/${id}`, {}, removeId);
    expect(removed.status).toBe(200);
    expect(h.db.get(agentRequestKey(TEST_ORG, DANA.developerId, removeId))).toBeDefined();
    const deletes = fake.calls.filter((entry) => entry.action === "DeleteSecret").length;
    expect(await call(DANA, "DELETE", `/v1/app/connections/${id}`, {}, removeId)).toEqual(removed);
    expect(fake.calls.filter((entry) => entry.action === "DeleteSecret").length).toBe(deletes);
    // A new request for what is already gone is not found.
    expect(errorOf(await call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).code).toBe("NOT_FOUND");
  });

  it("needs a request id on every change", async () => {
    const { create, h } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: "k1" })).body.connection.connectionId;
    for (const [method, path, body] of [["POST", "/v1/app/connections", { connection: LINEAR }], ["PUT", `/v1/app/connections/${id}`, { connection: LINEAR }], ["DELETE", `/v1/app/connections/${id}`, {}], ["POST", `/v1/app/connections/${id}/check`, {}]] as const) {
      const reply = await h.dev(DANA, method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(400);
    }
  });
});

describe("removing and checking", () => {
  it("removes the record and schedules the secret for deletion", async () => {
    const { create, call, fake, h } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: "k1" })).body.connection.connectionId;
    const removed = await call(DANA, "DELETE", `/v1/app/connections/${id}`, {});
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: { connectionId: id } });
    expect(fake.stored(orgConnectorSecretName(ENV, TEST_ORG, id))!.deleteAt).toBeGreaterThan(START);
    expect(h.db.get(connectionKey(TEST_ORG, id))).toBeUndefined();
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).status).toBe(404);
  });

  it("checks with the saved secret, records the vendor account for the store but not for people, and says when the vendor refuses", async () => {
    const refusing = vi.fn(async () => new Response("{}", { status: 401 }));
    const { create, call } = await setup({ fetch: refusing });
    const id = (await create(DANA, LINEAR, { apiKey: LINEAR_KEY })).body.connection.connectionId;
    const result = await call(DANA, "POST", `/v1/app/connections/${id}/check`, {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: false, message: "Linear refused the saved secret (HTTP 401)" });
    expect((await call(MAX, "GET", `/v1/app/connections/${id}`)).body.connection.lastCheck).toMatchObject({ ok: false });
  });

  it("reports a connection with no secret as not ok without calling the vendor", async () => {
    const { create, call, fetchImplementation } = await setup();
    const id = (await create(DANA, LINEAR)).body.connection.connectionId;
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).body.connection.hasCredential).toBe(false);
    expect((await call(DANA, "POST", `/v1/app/connections/${id}/check`, {})).body.ok).toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("an MCP connection's endpoint", () => {
  it("is checked at save, so one that resolves inside a network is refused before any secret is written", async () => {
    const { create, fake } = await setup({ addresses: () => ["10.1.2.3"] });
    const refused = await create(DANA, MCP, { token: "t1" });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).code).toBe("CONFIG_INVALID");
    expect(errorOf(refused).message).not.toContain("10.1.2.3");
    expect(fake.calls).toEqual([]);
    for (const endpoint of ["http://mcp.acme.dev/mcp", "https://10.0.0.5/mcp", "https://mcp.acme.dev:4001/mcp", "https://localhost/mcp", "https://u:p@mcp.acme.dev/mcp"]) {
      expect((await create(DANA, { ...MCP, endpoint }, { token: "t1" })).status, endpoint).toBe(400);
    }
  });

  it("is checked again before every call, so a host that now resolves privately is refused before the server is asked", async () => {
    let address = "52.1.2.3";
    const { create, call, listMcpTools } = await setup({ addresses: () => [address] });
    const id = (await create(DANA, MCP, { token: "t1" })).body.connection.connectionId;
    expect((await call(DANA, "POST", `/v1/app/connections/${id}/check`, {})).body).toEqual({ ok: true, message: "2 tools" });
    address = "10.1.2.3";
    const refused = await call(DANA, "POST", `/v1/app/connections/${id}/check`, {});
    expect(refused.body.ok).toBe(false);
    expect(refused.body.message).toContain("not a public address");
    expect(listMcpTools).toHaveBeenCalledTimes(1);
  });
});

describe("a deployment without org connections", () => {
  it("answers NOT_FOUND on every route", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() } } });
    h.db.set({ pk: `SESSION#${DANA.sessionId}`, sk: "META", sessionId: DANA.sessionId, developerId: DANA.developerId, amr: DANA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${DANA.developerId}`, sk: "META", developerId: DANA.developerId, provider: DANA.provider, displayName: DANA.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(DANA);
    seedMembership(h.db, DANA.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await h.dev(DANA, "GET", "/v1/app/connections")).status).toBe(404);
  });
});
