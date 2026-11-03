// Plan 3 Task 12b: the org connection routes (`/v1/app/connections*`): who may do what, that a secret is write-only and appears nowhere,
// that every change is repeatable (R18) and tenant-scoped, and that an MCP endpoint is checked.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { connectionKey } from "../../packages/contracts/src/connections.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org-node.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { mcpEndpointGuard } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { BEING_REMOVED_MESSAGE, OrgSecrets, orgConnectorSecretName } from "../../packages/broker/src/connections/org-secrets.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
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
interface Body { connection: Shown; connections: Shown[]; ok: boolean; message?: string; removed: { connectionId: string }; warnings?: Array<{ code: string; message: string }>; error: { code: string; message: string } }
type Reply = { status: number; body: Body };
const errorOf = (reply: Reply) => reply.body.error;

async function setup(options: { addresses?: () => string[]; fetch?: typeof fetch; tools?: () => unknown[]; people?: Array<[Developer, OrgRole, OrgId?]>; cloud?: boolean; agents?: boolean } = {}) {
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
      ...(options.cloud === true ? { cloud: true } : {}),
      ...(options.agents === false ? {} : { agents: { projectMembers: new FakeProjectMembers() } }),
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: { checkEndpoint, listMcpTools, fetch: fetchImplementation, endpointGuard: mcpEndpointGuard({ resolveHost: async () => (options.addresses ?? (() => ["52.1.2.3"]))() }) },
    },
  });
  holder.db = h.db;
  const enroll = async (who: Developer, role: OrgRole, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role });
  };
  for (const [who, role, orgId] of options.people ?? [[DANA, "admin"], [OWEN, "owner"], [MAX, "member"], [OMAR, "admin", ORG_B]]) await enroll(who, role, orgId);
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>, requestId: string = randomUUID()): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest as unknown as Body };
  };
  const create = async (who: Developer, connection: Record<string, unknown>, secret?: Record<string, unknown>, requestId?: string) =>
    call(who, "POST", "/v1/app/connections", { connection, ...(secret === undefined ? {} : { secret }) }, requestId);
  return { h, fake, audit, call, create, checkEndpoint, listMcpTools, fetchImplementation, secrets };
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

  it("does not overwrite a connection when a request id is used again after its memory expired", async () => {
    const { create, call, h } = await setup();
    const requestId = randomUUID();
    const first = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    h.db.delete(agentRequestKey(TEST_ORG, DANA.developerId, requestId)); // the State table's TTL removed it
    const again = await create(DANA, { ...LINEAR, label: "Replaced" }, { apiKey: "k2" }, requestId);
    expect(again.status).toBe(400);
    expect(errorOf(again).code).toBe("CONFIG_INVALID");
    expect((await call(DANA, "GET", `/v1/app/connections/${first.body.connection.connectionId}`)).body.connection.label).toBe("Team Linear");
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

describe("closing an org", () => {
  it("schedules the deletion of each connection's secret when the last owner leaves, and takes only that org's", async () => {
    const { create, call, fake, h } = await setup({ cloud: true, people: [[MAYA, "owner"], [OMAR, "owner", ORG_B]] });
    const ids = [(await create(MAYA, LINEAR, { apiKey: "k1" })).body.connection.connectionId, (await create(MAYA, MCP, { token: "t1" })).body.connection.connectionId];
    const theirs = (await create(OMAR, LINEAR, { apiKey: "k-other" })).body.connection.connectionId;
    const left = await call(MAYA, "POST", "/v1/app/org/leave", {});
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    for (const id of ids) {
      expect(fake.stored(orgConnectorSecretName(ENV, TEST_ORG, id))!.deleteAt, id).toBeGreaterThan(START);
      expect(h.db.get(connectionKey(TEST_ORG, id))).toBeUndefined();
    }
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_B, theirs))!.deleteAt).toBeUndefined();
    expect(h.db.get(connectionKey(ORG_B, theirs))).toBeDefined();
  });
});

describe("closing an org when the agent routes are not set up", () => {
  it("still schedules the deletion of the connection secrets, because the connections do not depend on the agents", async () => {
    const { call, fake, h, secrets } = await setup({ cloud: true, agents: false, people: [[MAYA, "owner"]] });
    const store = new OrgConnectionStore({ documentClient: h.db, tableName: "state", env: ENV, secrets, now: Date.now });
    const id = "con_aaaaaaaaaaaaaaaaaaaa";
    await store.put({ orgId: TEST_ORG, connection: { connectionId: id, type: "linear", label: "L", access: "read" }, secret: { apiKey: "k1" }, by: MAYA.developerId });
    expect((await call(MAYA, "GET", "/v1/app/connections")).status).toBe(404); // the routes need the agents' dependencies
    const left = await call(MAYA, "POST", "/v1/app/org/leave", {});
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(fake.stored(orgConnectorSecretName(ENV, TEST_ORG, id))!.deleteAt).toBeGreaterThan(START);
    expect(h.db.get(connectionKey(TEST_ORG, id))).toBeUndefined();
  });
});

describe("a lookup that fails while a connection is checked", () => {
  it("answers a retryable 503, records no check and no request item, and the same request id runs the check once the lookup works", async () => {
    let failing = false;
    const { create, call, h } = await setup({ addresses: () => { if (failing) throw new Error("ETIMEOUT"); return ["52.1.2.3"]; } });
    const id = (await create(DANA, MCP, { token: "t1" })).body.connection.connectionId;
    failing = true;
    const requestId = randomUUID();
    const failed = await call(DANA, "POST", `/v1/app/connections/${id}/check`, {}, requestId);
    expect(failed.status).toBe(503);
    expect(errorOf(failed).code).toBe("RUNTIME_UNAVAILABLE");
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).body.connection.lastCheck).toBeUndefined();
    expect(h.db.get(agentRequestKey(TEST_ORG, DANA.developerId, requestId))).toBeUndefined();
    failing = false;
    expect((await call(DANA, "POST", `/v1/app/connections/${id}/check`, {}, requestId)).body).toEqual({ ok: true, message: "2 tools" });
  });
});

describe("a connection whose removal started and did not finish", () => {
  it("answers a save with a new key as a plain CONFIG_INVALID, not a 503, and finishing the removal lets a new connection be added", async () => {
    const { create, call, secrets } = await setup();
    const id = (await create(DANA, LINEAR, { apiKey: LINEAR_KEY })).body.connection.connectionId;
    // The removal scheduled the secret's deletion and stopped before the record was removed.
    await secrets.scheduleDelete(TEST_ORG, orgConnectorSecretName(ENV, TEST_ORG, id));
    const refused = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: LINEAR, secret: { apiKey: "lin_api_NEWKEY0123456789ABCDEF" } });
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toMatchObject({ code: "CONFIG_INVALID", message: BEING_REMOVED_MESSAGE });
    expect(JSON.stringify(refused.body)).not.toContain("NEWKEY");
    // Remove it again, as the message says; then a new connection can be added.
    expect((await call(DANA, "DELETE", `/v1/app/connections/${id}`, {})).status).toBe(200);
    expect((await call(DANA, "GET", `/v1/app/connections/${id}`)).status).toBe(404);
    const added = await create(DANA, LINEAR, { apiKey: "lin_api_NEWKEY0123456789ABCDEF" });
    expect(added.status).toBe(201);
    expect(added.body.connection.connectionId).not.toBe(id);
  });
});

describe("a secret never reaches the logs when a request fails", () => {
  it("keeps the secret out of every log line and response when an unexpected error ends the request", async () => {
    const lines: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
    const { h, create } = await setup();
    const real = h.db.send.bind(h.db);
    vi.spyOn(h.db, "send").mockImplementation(((command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") return Promise.reject(new Error("the table failed"));
      return real(command as never);
    }));
    const failed = await create(DANA, LINEAR, { apiKey: LINEAR_KEY });
    spies.forEach((spy) => spy.mockRestore());
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(failed.body)).not.toContain(LINEAR_KEY);
    expect(lines.join("\n")).toContain("request.unexpected_error");
    expect(lines.join("\n")).not.toContain(LINEAR_KEY);
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

describe("who a Linear or Jira key belongs to (controller ruling, Task 22 review)", () => {
  const JIRA = { type: "jira", label: "Team Jira", access: "read", siteUrl: "https://acme.atlassian.net" };
  const JIRA_SECRET = { email: "bot@acme.com", apiToken: "jira-token-ROUTE1234567890" };
  const warned = (reply: Reply) => reply.body.warnings?.map((warning) => warning.code);

  it("warns, with a fixed code, when a Linear or Jira connection is made with a personal key or with none marked, and not for a service identity", async () => {
    const { create } = await setup();
    const personal = await create(DANA, { ...LINEAR, identity: "personal" }, { apiKey: "k1" });
    expect(personal.status).toBe(201);
    expect(warned(personal)).toEqual(["PERSONAL_KEY_LOOP_GUARD_LIMITED"]);
    expect(personal.body.warnings![0]!.message).toMatch(/service account/i);
    expect(personal.body.connection).toMatchObject({ identity: "personal" });
    expect(warned(await create(DANA, LINEAR, { apiKey: "k1" }))).toEqual(["PERSONAL_KEY_LOOP_GUARD_LIMITED"]);
    expect(warned(await create(DANA, JIRA, JIRA_SECRET))).toEqual(["PERSONAL_KEY_LOOP_GUARD_LIMITED"]);
    const service = await create(DANA, { ...LINEAR, identity: "service" }, { apiKey: "k1" });
    expect(service.status).toBe(201);
    expect(service.body).not.toHaveProperty("warnings");
    expect(service.body.connection).toMatchObject({ identity: "service" });
    const serviceJira = await create(DANA, { ...JIRA, identity: "service" }, JIRA_SECRET);
    expect(serviceJira.body).not.toHaveProperty("warnings");
  });

  it("warns on a change and on a repeat of the request the same way, and drops the warning when the connection is marked a service identity", async () => {
    const { create, call } = await setup();
    const requestId = randomUUID();
    const first = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    const again = await create(DANA, LINEAR, { apiKey: "k1" }, requestId);
    expect(warned(again)).toEqual(["PERSONAL_KEY_LOOP_GUARD_LIMITED"]);
    const id = first.body.connection.connectionId;
    expect(warned(await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, label: "Renamed" } }))).toEqual(["PERSONAL_KEY_LOOP_GUARD_LIMITED"]);
    const marked = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: { ...LINEAR, identity: "service" } });
    expect(marked.status).toBe(200);
    expect(marked.body).not.toHaveProperty("warnings");
  });

  it("has no warning for the types that carry no actor guard, and refuses an identity that is not service or personal, or on a type that has none", async () => {
    const { create } = await setup();
    const mcp = await create(DANA, MCP, { token: "t1" });
    expect(mcp.status).toBe(201);
    expect(mcp.body).not.toHaveProperty("warnings");
    expect((await create(DANA, { ...LINEAR, identity: "bot" }, { apiKey: "k1" })).status).toBe(400);
    expect((await create(DANA, { ...MCP, identity: "service" }, { token: "t1" })).status).toBe(400);
  });
});

describe("the Jira organization admin key is not set through this route (DV-1)", () => {
  const JIRA = { type: "jira", label: "Team Jira", access: "read", siteUrl: "https://acme.atlassian.net", identity: "service" };
  const JIRA_SECRET = { email: "bot@acme.com", apiToken: "jira-token-ROUTE1234567890" };
  const ADMIN_KEY = "ATAdminKey-ROUTE0123456789";
  const bad: Array<Record<string, unknown>> = [
    { ...JIRA_SECRET, orgAdminKey: ADMIN_KEY, atlassianOrgId: "org-id-1234" },
    { ...JIRA_SECRET, orgAdminKey: ADMIN_KEY },
    { ...JIRA_SECRET, atlassianOrgId: "org-id-1234" },
    { ...JIRA_SECRET, clearOrgAdmin: true },
  ];

  it("a create or a save that names the key, the organization id or the clear flag is a 400 that points to the Connections screen, and nothing is written", async () => {
    const { create, call, audit, fake } = await setup();
    const made = await create(DANA, JIRA, JIRA_SECRET);
    expect(made.status).toBe(201);
    const id = made.body.connection.connectionId;
    const callsBefore = fake.calls.length;
    for (const secret of bad) {
      const refusedCreate = await create(DANA, JIRA, secret);
      const refusedSave = await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: JIRA, secret });
      for (const reply of [refusedCreate, refusedSave]) {
        expect(reply.status, JSON.stringify(secret)).toBe(400);
        expect(JSON.stringify(reply.body)).toContain("Connections screen");
        expect(JSON.stringify(reply.body)).not.toContain(ADMIN_KEY);
      }
    }
    expect(fake.calls.length).toBe(callsBefore);
    expect(audit.recordedBy("connection.saved")).toHaveLength(1);
    // The ordinary save (email and token only) still works.
    expect((await call(DANA, "PUT", `/v1/app/connections/${id}`, { connection: JIRA, secret: { ...JIRA_SECRET, apiToken: "rotated-token-0123456789" } })).status).toBe(200);
  });
});
