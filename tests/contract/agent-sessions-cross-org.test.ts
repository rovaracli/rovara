// Task 24: adversarial ids travel through the same session router used by app, CLI and MCP.
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentSessionKey, liveSessionKey, mySessionsKey, projectSessionsKey, sharedSessionsKey, sessionChannel, projectChannel, userChannel, type AgentSessionRecord, type OrgId } from "../../packages/contracts/src/index.js";
import { routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { bindSessionSurface, sessionForSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { resolveSlackThreadKey } from "../../packages/broker/src/aws/slack-thread-key.js";
import { slackThreadKey } from "../../packages/broker/src/aws/failed-preparation.js";
import { createRealtimeSink } from "../../packages/broker/src/realtime/sink.js";
import { routeAuditRequest } from "../../packages/broker/src/audit/routes.js";
import { world as auditWorld } from "../support/audit-routes-bench.js";
import { routeDeviceRequest } from "../../packages/broker/src/devices/routes.js";
import { registerDevice } from "../../packages/broker/src/devices/store.js";
import { authorizeRealtime } from "../../packages/broker/src/realtime/authorizer.js";
import { issueRealtimeToken, verifyRealtimeToken } from "../../packages/broker/src/realtime/token.js";
import { projectSessions } from "../../packages/broker/src/agent-sessions/projector.js";
import { ARJUN, BO, CELL, MAX, MIA, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { createDeveloperTaskBroker, DEV_ISSUER, type Developer } from "../support/developer-task-broker.js";
import { agentsCli, cleanHarnessDirs, type Answer } from "../support/agents-cli-harness.js";
import { httpControlPlaneClient, createAgentXMcpServer } from "../../packages/mcp/src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { projectorWorld } from "../support/agent-session-projector-world.js";
import { chainRunViewOf } from "../support/chain-run-view.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "isolation-test", alg: "RS256" as const, use: "sig" as const } as { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" };
const signer = { publicJwk: async () => jwk, sign: async (input: Buffer) => sign("sha256", input, privateKey) };
const THREAD = { kind: "slack_thread" as const, teamId: "T0123456789", channelId: "C0123456789", threadTs: "1700000000.000100" };
const ISSUE = { kind: "linear_issue" as const, issueId: "ENG-142", url: "https://linear.app/acme/issue/ENG-142" };
const WRITE = /^(Put|Update|Delete|TransactWrite|BatchWrite).*Command$/;
afterEach(async () => { vi.restoreAllMocks(); await cleanHarnessDirs(); });
beforeAll(loadSlackBroker);

async function world() {
  const w = sessionWorld();
  const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  const device = await registerDevice(table, w.caller(PRIYA), { requestId: randomUUID(), label: "Priya's Mac", platform: "mac" });
  const bDevice = await registerDevice(table, w.caller(BO, ORG_B), { requestId: randomUUID(), label: "Bo's Mac", platform: "mac" });
  const s1 = w.seedSession();
  const s2 = w.seedSession({ kind: "chain" });
  const s3 = w.seedSession({ kind: "local" });
  const s4 = w.seedSession({ people: [{ developerId: PRIYA, role: "owner" }, { developerId: ARJUN, role: "denied" }, { developerId: MAX, role: "denied" }] });
  const own = w.seedSession({ orgId: ORG_B, owner: BO });
  for (const s of [s3]) w.db.set({ ...w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!, subject: { kind: "local", deviceId: device.deviceId, tool: "claude-code" }, where: { kind: "mac", deviceId: device.deviceId, label: "Priya's Mac" } });
  w.seedShare(ORG_A, s3.sessionId, { kind: "member", developerId: ARJUN }, "view");
  w.seedShare(ORG_A, s4.sessionId, { kind: "member", developerId: MIA }, "view");
  for (const [s, orgId, owner] of [[s1, ORG_A, PRIYA], [s2, ORG_A, PRIYA], [s3, ORG_A, PRIYA], [s4, ORG_A, PRIYA], [own, ORG_B, BO]] as const) {
    const createdAt = s.record.createdAt;
    w.db.set({ ...liveSessionKey(orgId, s.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: s.sessionId, kind: s.record.kind, createdAt, updatedAt: createdAt, status: "running" });
    w.db.set({ ...mySessionsKey(orgId, owner, createdAt, s.sessionId), entityType: "MY_SESSION", orgId, sessionId: s.sessionId, developerId: owner, createdAt });
    w.db.set({ ...projectSessionsKey(orgId, "web", createdAt, s.sessionId), entityType: "PROJECT_SESSION", orgId, sessionId: s.sessionId, project: "web", createdAt });
  }
  for (const [s, who] of [[s3, ARJUN], [s4, MIA]] as const) w.db.set({ ...sharedSessionsKey(ORG_A, { kind: "member", developerId: who }, s.sessionId), entityType: "SHARED_SESSION", orgId: ORG_A, sessionId: s.sessionId, principal: { kind: "member", developerId: who }, level: "view", sharedAt: s.record.createdAt });
  await bindSessionSurface(table, { orgId: ORG_A, sessionId: s1.sessionId, binding: THREAD });
  await bindSessionSurface(table, { orgId: ORG_A, sessionId: s2.sessionId, binding: ISSUE });
  const taskView = vi.fn(async (task: { taskId: string; project: string }) => ({ taskId: task.taskId, title: "Isolation canary", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: s1.record.createdAt, updatedAt: s1.record.createdAt, events: [] }) as never);
  const deps: SessionRouteDependencies = {
    ...table, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64), taskView,
    chainReadAccess: async (who) => who.orgId === ORG_A && who.developerId === PRIYA,
    chain: { runView: async (_actor, id) => chainRunViewOf(id, { status: "waiting" }), stepTask: async () => taskView({ taskId: s2.taskId, project: "web" }) },
    projectPage: async () => ({ name: "web", status: "active", repositories: [], setup: { status: "ready" }, channels: [] }) as never,
    realtime: { endpoint: "https://example.appsync-api.us-east-1.amazonaws.com/event", projectsOf: async () => ["web"], mint: async (input) => issueRealtimeToken(signer, { ...input, now: w.clock.now }) },
  };
  // Merge answers RUNTIME_UNAVAILABLE without a merge host, before any session is looked at; the host given for it must never be asked for a task.
  const mergeHost = { codeMerge: { loadTask: async () => { throw new Error("the merge host must not be asked for another org's task"); } } } as never;
  const call = (who: string, orgId: OrgId, method: string, path: string, body?: unknown) => routeAgentSessionRequest(path.endsWith("/merge") ? { ...deps, approvals: mergeHost } : deps, w.caller(who, orgId), { method, path, headers: {}, requestId: "isolation", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, CELL));
  return { ...w, table, deps, call, taskView, s1, s2, s3, s4, own, device, bDevice };
}
type World = Awaited<ReturnType<typeof world>>;
// `withMerge`: the router-level tests give Merge a host; the test broker has none, and answers 503 to Merge whatever the session.
const cases = (s: string, deviceId: string, withMerge = true): Array<[string, string, unknown?]> => [
  ["GET", `/v1/app/sessions/${s}`], ["GET", `/v1/app/sessions/${s}/events`], ["GET", `/v1/app/sessions/${s}/messages`], ["GET", `/v1/app/sessions/${s}/shares`], ["GET", `/v1/app/sessions/${s}/sections/1/task`],
  ["GET", `/v1/app/sessions/${s}/diff?repository=demo&number=1`],
  ["POST", `/v1/app/sessions/${s}/follow`], ["DELETE", `/v1/app/sessions/${s}/follow`], ["POST", `/v1/app/sessions/${s}/presence`],
  ...(["comment", "steer"] as const).map((kind): [string, string, unknown] => ["POST", `/v1/app/sessions/${s}/messages`, { requestId: randomUUID(), kind, text: "Cross-org canary" }]),
  ["PATCH", `/v1/app/sessions/${s}/messages/msg_aaaaaaaaaaaaaaaaaaaa`, { rev: 1, text: "changed" }],
  ["DELETE", `/v1/app/sessions/${s}/messages/msg_aaaaaaaaaaaaaaaaaaaa`, { rev: 1 }],
  ...["take-over", "stop", "retry", "close", "handoff", "agent"].map((action): [string, string, unknown] => ["POST", `/v1/app/sessions/${s}/${action}`, { requestId: randomUUID(), ...(action === "handoff" ? { to: "mac", deviceId } : {}) }]),
  // Plan 6: Understand's answers, "change it anyway" after an Answered task, and the Linear binding (link and unlink) are session routes like the rest: an id from another org, or a private one, is no session.
  ["POST", `/v1/app/sessions/${s}/answers`, { requestId: randomUUID(), round: 1, answers: [{ questionId: "q1", text: "Cross-org canary" }] }],
  ["POST", `/v1/app/sessions/${s}/change-anyway`, { requestId: randomUUID() }],
  ...(withMerge ? [["POST", `/v1/app/sessions/${s}/merge`, { requestId: randomUUID() }] as [string, string, unknown]] : []),
  ["POST", `/v1/app/sessions/${s}/bindings`, { linear: "ENG-142" }],
  ["POST", `/v1/app/sessions/${s}/bindings`, { linear: "ENG-142", replace: true }],
  ["DELETE", `/v1/app/sessions/${s}/bindings/linear`],
  ["PUT", `/v1/app/sessions/${s}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: BO }, level: "edit" }],
  ["DELETE", `/v1/app/sessions/${s}/shares/MEMBER%23${MIA}`],
  ["POST", `/v1/app/sessions/${s}/local/updates`, { requestId: randomUUID(), deviceId, status: "running" }],
];
async function unchanged(w: World, run: () => Promise<unknown>) {
  const data = structuredClone(w.db.find(() => true));
  const offset = w.db.commandNames().length;
  await run();
  expect(w.db.commandNames().slice(offset).filter((name) => WRITE.test(name))).toEqual([]);
  expect(w.db.find(() => true)).toEqual(data);
}

describe("Task 24: ids never confer authority", () => {
  for (const subject of ["s1", "s2", "s3", "s4", "missing"] as const) {
    it(`refuses every session-family read/write for org B against ${subject}, without writes or detail reads`, async () => {
      const w = await world();
      const id = subject === "missing" ? "ses_zzzzzzzzzzzzzzzzzzzz" : w[subject].sessionId;
      await unchanged(w, async () => {
        for (const [method, path, body] of cases(id, w.bDevice.deviceId)) await expect(w.call(BO, ORG_B, method, path, body), `${method} ${path}`).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
      expect(w.taskView).not.toHaveBeenCalled();
      expect(await w.call(BO, ORG_B, "GET", `/v1/app/sessions/${w.own.sessionId}`)).toMatchObject({ session: { sessionId: w.own.sessionId } });
      expect(w.taskView).toHaveBeenCalledOnce();
    });
  }
  for (const [who, subject] of [[ARJUN, "s4"], [MAX, "s3"]] as const) it(`keeps ${subject} private inside its org for ${who.slice(0, 4)}`, async () => {
    const w = await world();
    await unchanged(w, async () => {
      for (const [method, path, body] of cases(w[subject].sessionId, w.device.deviceId)) await expect(w.call(who, ORG_A, method, path, body), `${method} ${path}`).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    expect(await w.call(subject === "s4" ? MIA : ARJUN, ORG_A, "GET", `/v1/app/sessions/${w[subject].sessionId}`)).toMatchObject({ session: { sessionId: w[subject].sessionId } });
  });
  it("device commands, removal and local registration never accept the other org's device", async () => {
    const w = await world();
    await unchanged(w, async () => {
      for (const [method, suffix] of [["GET", "/commands"], ["DELETE", ""]]) {
        const path = `/v1/app/devices/${w.device.deviceId}${suffix}`;
        await expect(routeDeviceRequest(w.table, w.caller(BO, ORG_B), { method: method!, path, headers: {}, requestId: "r" }, new URL(path, CELL))).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      await expect(w.call(BO, ORG_B, "POST", "/v1/app/sessions/local", { requestId: randomUUID(), deviceId: w.device.deviceId, tool: "claude-code", title: "Canary", startedAt: new Date(w.clock.now).toISOString(), project: "web", shares: [{ principal: { kind: "member", developerId: BO }, level: "view" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    const listPath = "/v1/app/devices";
    const listed = await routeDeviceRequest(w.table, w.caller(BO, ORG_B), { method: "GET", path: listPath, headers: {}, requestId: "r" }, new URL(listPath, CELL));
    expect(JSON.stringify(listed)).toContain(w.bDevice.deviceId);
    expect(JSON.stringify(listed)).not.toContain(w.device.deviceId);
    const path = `/v1/app/devices/${w.device.deviceId}/commands`;
    expect(await routeDeviceRequest(w.table, w.caller(PRIYA), { method: "GET", path, headers: {}, requestId: "r" }, new URL(path, CELL))).toMatchObject({ commands: [] });
  });
  it("same-named project lists, all Live filters, Home and changes never reveal hidden ids", async () => {
    const w = await world();
    const meta = w.db.get(agentSessionKey(ORG_A, w.s1.sessionId, "META"))!;
    w.db.set({ ...meta, summaryRevision: 2, summary: { ...w.s1.record.summary, status: "needs_person" } });
    const task = w.db.find((row) => row.taskId === w.s1.taskId && row.sk === "META")[0]!;
    w.db.set({ ...task, workflow: { stage: "PLAN_REVIEW", state: "WAITING", revision: 1, path: "QUICK", artifacts: [], decisions: [] } });
    expect(JSON.stringify(await w.call(PRIYA, ORG_A, "GET", "/v1/app/home"))).toContain(w.s1.sessionId);
    const paths = ["/v1/app/sessions?owner=me", "/v1/app/sessions?shared=me", "/v1/app/sessions?project=web", "/v1/app/home", "/v1/app/changes", "/v1/app/projects/web/overview", ...["all", "mine", "failed", "needs_me", "team"].map((filter) => `/v1/app/live?filter=${filter}`)];
    for (const [who, org, hidden] of [[BO, ORG_B, [w.s1, w.s2, w.s3, w.s4]], [ARJUN, ORG_A, [w.s4]], [MAX, ORG_A, [w.s3]]] as const) {
      for (const path of paths) {
        const text = JSON.stringify(await w.call(who, org, "GET", path));
        for (const s of hidden) expect(text, `${who.slice(0, 4)} ${path}`).not.toContain(s.sessionId);
      }
    }
    expect(JSON.stringify(await w.call(BO, ORG_B, "GET", "/v1/app/sessions?project=web"))).toContain(w.own.sessionId);
    expect(JSON.stringify(await w.call(PRIYA, ORG_A, "GET", "/v1/app/sessions?project=web"))).toContain(w.s1.sessionId);
  });
  it("surface mappings and binding writes use the caller's org, for Slack and Linear", async () => {
    const w = await world();
    for (const [binding, s] of [[THREAD, w.s1], [ISSUE, w.s2]] as const) {
      await unchanged(w, async () => {
        expect(await sessionForSurface(w.table, ORG_B, binding)).toBeUndefined();
        await expect(bindSessionSurface(w.table, { orgId: ORG_B, sessionId: s.sessionId, binding })).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
      expect(await sessionForSurface(w.table, ORG_A, binding)).toMatchObject({ sessionId: s.sessionId });
    }
  });
  it("B's realtime token cannot subscribe to A's sessions, project, person or wildcard", async () => {
    const w = await world();
    const response = await w.call(BO, ORG_B, "POST", "/v1/app/realtime/token") as { token: string };
    expect(await verifyRealtimeToken(async () => jwk, response.token, w.clock.now)).toMatchObject({ org: ORG_B, sub: BO });
    const authorize = (channel: string) => authorizeRealtime({ authorizationToken: response.token, requestContext: { operation: "EVENT_SUBSCRIBE", channel } }, { ...w.table, publicKey: async () => jwk, log: () => undefined });
    await unchanged(w, async () => {
      for (const channel of [sessionChannel(ORG_A, w.s1.sessionId), sessionChannel(ORG_A, w.s3.sessionId), projectChannel(ORG_A, "web"), userChannel(ORG_A, PRIYA), userChannel(ORG_A, BO), `/rovara/o-${ORG_A}/*`]) expect(await authorize(channel)).toEqual({ isAuthorized: false, ttlOverride: 0 });
    });
    expect(await authorize(projectChannel(ORG_B, "web"))).toEqual({ isAuthorized: true, ttlOverride: 0 });
    expect(await authorize(userChannel(ORG_B, BO))).toEqual({ isAuthorized: true, ttlOverride: 0 });
  });
  it("a forged stream image claiming B beneath A's key causes no refresh or write", async () => {
    const w = await world();
    const refresh = vi.fn(async () => "updated" as const);
    await unchanged(w, async () => {
      expect(await projectSessions([{ eventName: "MODIFY", dynamodb: { NewImage: marshall({ pk: `ORG#${ORG_A}#TASK_SPENT#${w.s1.taskId}`, sk: "META", orgId: ORG_B, settledUsd: 3 }) } }], { ...w.table, refresh, log: () => undefined }, { deadline: w.clock.now + 1000 })).toMatchObject({ refreshed: 0 });
    });
    expect(refresh).not.toHaveBeenCalled();
    await projectSessions([{ eventName: "MODIFY", dynamodb: { NewImage: marshall({ pk: `ORG#${ORG_A}#TASK_SPENT#${w.s1.taskId}`, sk: "META", orgId: ORG_A, settledUsd: 3 }) } }], { ...w.table, refresh, log: () => undefined }, { deadline: w.clock.now + 1000 });
    expect(refresh).toHaveBeenCalledWith(expect.anything(), ORG_A, w.s1.sessionId);
  });
});

describe("Slack thread storage tenancy (C24)", () => {
  it("different orgs cannot alias the same Slack owner key", () => {
    const key = slackThreadKey;
    expect(key(ORG_A, "same-thread")).toEqual({ pk: `ORG#${ORG_A}#SLACK_THREAD#same-thread`, sk: "META" });
    expect(key(ORG_A, "same-thread")).not.toEqual(key(ORG_B, "same-thread"));
  });
});

describe("pre-scoping Slack rows", () => {
  it("uses a legacy row only for its checked workspace's org and owner, without writing", async () => {
    const w = await world();
    const owner = "legacy-thread";
    const legacy = { pk: `SLACK_THREAD#${owner}`, sk: "META" };
    w.db.set({ ...legacy, workspaceId: "old-workspace", starterUserId: "U0123456789" });
    w.db.set({ pk: "WORKSPACE#old-workspace", sk: "META", orgId: ORG_A, ownerKey: owner });
    await unchanged(w, async () => {
      expect(await resolveSlackThreadKey(w.table, ORG_A, owner)).toEqual(legacy);
      expect(await resolveSlackThreadKey(w.table, ORG_B, owner)).toEqual(slackThreadKey(ORG_B, owner));
    });
    w.db.set({ ...legacy, workspaceId: "old-workspace", orgId: ORG_B });
    expect(await resolveSlackThreadKey(w.table, ORG_A, owner)).toEqual(slackThreadKey(ORG_A, owner));
    w.db.set({ ...legacy, workspaceId: "old-workspace" });
    w.db.set({ pk: "WORKSPACE#old-workspace", sk: "META", orgId: ORG_A, ownerKey: "someone-else" });
    expect(await resolveSlackThreadKey(w.table, ORG_A, owner)).toEqual(slackThreadKey(ORG_A, owner));
    w.db.set({ ...slackThreadKey(ORG_A, owner), orgId: ORG_A, workspaceId: "new-workspace" });
    expect(await resolveSlackThreadKey(w.table, ORG_A, owner)).toEqual(slackThreadKey(ORG_A, owner));
  });
});

async function brokerWorld() {
  const w = await world();
  const h = await createDeveloperTaskBroker({ register: false, orgResolver: async ({ developerId }) => developerId === BO ? ORG_B : ORG_A, brokerExtra: { agents: { projectMembers: w.members } } });
  for (const row of w.db.find(() => true)) h.db.set(structuredClone(row));
  const a: Developer = { developerId: PRIYA, name: "Priya", provider: "oidc", sessionId: randomUUID() };
  const b: Developer = { developerId: BO, name: "Bo", provider: "oidc", sessionId: randomUUID() };
  for (const who of [a, b]) {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: "oidc", startedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
  }
  const send = async (method: string, path: string, body?: unknown) => {
    const reply = await h.dev(b, method, path, body);
    return Response.json(reply.body, { status: reply.status });
  };
  return { w, h, a, b, send };
}

describe("the broker and its real CLI/MCP clients", () => {
  it("every session endpoint returns an empty 404 envelope for B, with no write", async () => {
    const { w, h, a, b } = await brokerWorld();
    for (const subject of [w.s1, w.s2, w.s3, w.s4]) for (const [method, path, body] of cases(subject.sessionId, w.bDevice.deviceId, false)) {
      const before = h.db.commandNames().length;
      const data = structuredClone(h.db.find(() => true));
      const reply = await h.dev(b, method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(404);
      expect(reply.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(Object.keys(reply.body).sort()).toEqual(["error", "requestId"]);
      expect(JSON.stringify(reply.body)).not.toContain(subject.sessionId);
      expect(h.db.commandNames().slice(before).filter((name) => WRITE.test(name))).toEqual([]);
      expect(h.db.find(() => true)).toEqual(data);
    }
    expect((await h.dev(a, "GET", `/v1/app/sessions/${w.s1.sessionId}/events`)).status).toBe(200);
  });
  it("the retired /s broker route returns 404 without local-session facts for either org", async () => {
    const { w, h, a, b } = await brokerWorld();
    const browser = (who: Developer) => h.handler({ version: "2.0", routeKey: "ANY /s/{proxy+}", rawPath: `/s/${w.s3.sessionId}`, rawQueryString: "", headers: { host: new URL(DEV_ISSUER).host, cookie: `__Host-agentx_review_session=${who.sessionId}` }, requestContext: { requestId: randomUUID(), http: { method: "GET" } } });
    const reply = await browser(b);
    expect(reply.statusCode).toBe(404);
    expect(reply.body).not.toContain(w.s3.sessionId);
    expect((await browser(a)).statusCode).toBe(404);
    expect((await h.dev(a, "GET", `/v1/app/sessions/${w.s3.sessionId}`)).status).toBe(200);
  });
  it("CLI show/follow/comment/tell/stop/retry/take-over/share reach the broker as B", async () => {
    const { w, h, send } = await brokerWorld();
    const id = w.s1.sessionId;
    const routes: Record<string, Answer> = {};
    for (const [method, path] of cases(id, w.bDevice.deviceId)) routes[`${method} ${path}`] = ((body: unknown) => send(method, path, body)) as unknown as Answer;
    const cli = await agentsCli(routes);
    const before = h.db.commandNames().length;
    for (const args of [["show"], ["follow"], ["unfollow"], ["comment", "Canary"], ["tell", "Canary"], ["stop"], ["retry"], ["take-over"], ["share", "--with", BO, "--level", "view"]]) {
      const [action, ...rest] = args;
      expect(await cli.run(["session", action!, id, ...rest]), String(action)).not.toBe(0);
    }
    expect(cli.calls).toHaveLength(9);
    expect(cli.stderr()).toContain("session not found");
    expect(cli.stdout()).not.toContain("Bump the Stripe SDK");
    expect(h.db.commandNames().slice(before).filter((name) => WRITE.test(name))).toEqual([]);
  });
  it("MCP get/comment/tell/stop and list use B's authority through the HTTP client", async () => {
    const { w, h, send } = await brokerWorld();
    const client = httpControlPlaneClient({ session: async () => ({ baseUrl: CELL, accessToken: "synthetic-test", signInCommand: "test login" }), fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return send(init?.method ?? "GET", url.pathname + url.search, typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    }), tries: 1, sleep: async () => undefined });
    const server = createAgentXMcpServer({ version: "0.4.0", context: () => ({ client, clientName: "codex", serverVersion: "0.4.0", adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: Date.now, sleep: async () => undefined, newRequestId: randomUUID }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "codex", version: "1.0.0" });
    await mcp.connect(clientSide);
    try {
      const before = h.db.commandNames().length;
      for (const name of ["agentx_get_session", "agentx_comment_on_session", "agentx_tell_session_agent", "agentx_stop_session"]) {
        const reply = await mcp.callTool({ name, arguments: { session_id: w.s1.sessionId, ...(/comment|tell/.test(name) ? { text: "Canary" } : {}) } });
        expect(reply.isError, name).toBe(true);
        expect(JSON.stringify(reply)).toContain("SESSION_NOT_FOUND");
        expect(JSON.stringify(reply)).not.toContain("Bump the Stripe SDK");
      }
      const listed = await mcp.callTool({ name: "agentx_list_sessions", arguments: { project: "web" } });
      expect(listed.isError).not.toBe(true);
      expect(JSON.stringify(listed)).toContain(w.own.sessionId);
      expect(JSON.stringify(listed)).not.toContain(w.s1.sessionId);
      expect(h.db.commandNames().slice(before).filter((name) => WRITE.test(name))).toEqual([]);
    } finally { await mcp.close(); await server.close(); }
  });
});

describe("notices and audit cannot bypass session isolation", () => {
  it("drops unauthorized followers of a private task session from notices and catch-up feeds", async () => {
    const w = await world();
    for (const who of [MIA, ARJUN, MAX, BO]) w.follower(ORG_A, w.s4.sessionId, who);
    const published: Array<{ channel: string; events: string[] }> = [];
    const sink = createRealtimeSink({ realtime: { endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic" }), fetch: (async (_url: unknown, init: { body: string }) => { published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return Response.json({}); }) as never } });
    const session = w.db.get(agentSessionKey(ORG_A, w.s4.sessionId, "META")) as unknown as AgentSessionRecord;
    const summary = { ...session.summary, status: "needs_person" as const };
    await sink(w.table, { orgId: ORG_A, sessionId: session.sessionId, session: { ...session, summary }, previous: session.summary, summary, summaryRevision: 2, statusChanged: true, stepChanged: false, ended: false, at: new Date(w.clock.now).toISOString() });
    expect(published.map((entry) => entry.channel)).toContain(userChannel(ORG_A, MIA));
    expect(published.map((entry) => entry.channel)).not.toContain(projectChannel(ORG_A, "web"));
    for (const who of [ARJUN, MAX, BO]) expect(published.map((entry) => entry.channel)).not.toContain(userChannel(ORG_A, who));
    expect(published.every((entry) => !entry.channel.includes(ORG_B))).toBe(true);
    w.clock.now += 3000;
    expect(JSON.stringify(await w.call(MIA, ORG_A, "GET", "/v1/app/changes"))).toContain(session.sessionId);
    for (const [who, org] of [[ARJUN, ORG_A], [MAX, ORG_A], [BO, ORG_B]] as const) expect(JSON.stringify(await w.call(who, org, "GET", "/v1/app/changes"))).not.toContain(session.sessionId);
  });
  it("audit reads stay in the checked org and a member cannot read session audit data", async () => {
    const b = await auditWorld();
    const url = new URL("/v1/app/org/audit/records", CELL);
    const before = b.h.db.commandNames().length;
    await expect(routeAuditRequest(b.deps, { orgId: ORG_B, developerId: BO, orgRole: "member" }, { method: "GET", body: undefined, requestId: randomUUID() }, url)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(b.h.db.commandNames().slice(before).filter((name) => WRITE.test(name))).toEqual([]);
    const reply = await routeAuditRequest(b.deps, { orgId: ORG_B, developerId: BO, orgRole: "admin" }, { method: "GET", body: undefined, requestId: randomUUID() }, url);
    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).toContain(ORG_B);
    expect(JSON.stringify(reply.body)).not.toContain(ORG_A);
  });
});

describe("answers and foreign underlying task references", () => {
  it("a foreign owner answer cannot change a workflow or reveal its plan", async () => {
    const { w, h, b } = await brokerWorld();
    const before = h.db.commandNames().length;
    const data = structuredClone(h.db.find(() => true));
    const body = { requestId: randomUUID(), expectedRevision: 1, artifactDigest: "a".repeat(64), decision: "APPROVE", reason: "Synthetic answer", answers: [{ decisionId: "d1", optionId: "yes", opened: true }], includedCommentIds: [] };
    const reply = await h.dev(b, "POST", `/v1/dev/tasks/${w.s1.taskId}/workflow/decision`, body);
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
    expect(JSON.stringify(reply.body)).not.toContain(w.s1.taskId);
    expect(h.db.commandNames().slice(before).filter((name) => WRITE.test(name))).toEqual([]);
    expect(h.db.find(() => true)).toEqual(data);
  });
  it("rechecks the task org when a same-org session points at another org's task", async () => {
    const w = await world();
    const key = agentSessionKey(ORG_B, w.own.sessionId, "META");
    w.db.set({ ...w.db.get(key)!, subject: { kind: "task", taskId: w.s1.taskId } });
    await unchanged(w, async () => {
      await expect(w.call(BO, ORG_B, "GET", `/v1/app/sessions/${w.own.sessionId}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    expect(w.taskView).not.toHaveBeenCalled();
  });
});

it("M1 refuses inside-org subscriptions to private task and unshared local sessions", async () => {
  const w = await world();
  await unchanged(w, async () => {
    for (const [who, sessionId] of [[ARJUN, w.s4.sessionId], [MAX, w.s3.sessionId]] as const) {
      const token = (await w.call(who, ORG_A, "POST", "/v1/app/realtime/token") as { token: string }).token;
      const reply = await authorizeRealtime({ authorizationToken: token, requestContext: { operation: "EVENT_SUBSCRIBE", channel: sessionChannel(ORG_A, sessionId) } }, { ...w.table, publicKey: async () => jwk, log: () => undefined });
      expect(reply).toEqual({ isAuthorized: false, ttlOverride: 0 });
    }
    const token = (await w.call(MIA, ORG_A, "POST", "/v1/app/realtime/token") as { token: string }).token;
    expect(await authorizeRealtime({ authorizationToken: token, requestContext: { operation: "EVENT_SUBSCRIBE", channel: sessionChannel(ORG_A, w.s4.sessionId) } }, { ...w.table, publicKey: async () => jwk, log: () => undefined })).toEqual({ isAuthorized: true, ttlOverride: 0 });
  });
});

it("M3 rejects forged images through the real projector and refresh write path", async () => {
  const p = projectorWorld();
  const a = p.open();
  p.open({ orgId: ORG_B, owner: BO });
  p.operation(a.workspaceId, "task", "RUNNING");
  const image = { pk: `ORG#${ORG_A}#TASK_SPENT#${a.taskId}`, sk: "META", orgId: ORG_B, settledUsd: 3 };
  const before = structuredClone(p.w.db.find(() => true));
  const offset = p.w.db.commandNames().length;
  expect(await projectSessions([p.stream(image)], p.deps, { deadline: p.w.clock.now + 1000 })).toMatchObject({ refreshed: 0, unchanged: 0 });
  expect(p.w.db.commandNames().slice(offset).filter((name) => WRITE.test(name))).toEqual([]);
  expect(p.w.db.find(() => true)).toEqual(before);
  const isB = (row: Record<string, unknown>) => row.orgId === ORG_B || String(row.pk).includes(ORG_B);
  const beforeB = before.filter(isB);
  const transactions = p.w.db.transactions().length;
  p.spent(a.taskId, 3);
  expect(await p.project([{ ...image, orgId: ORG_A }])).toMatchObject({ refreshed: 1 });
  expect(p.w.db.transactions().length).toBeGreaterThan(transactions);
  expect(p.sessionOf(a.sessionId).summary.costUsd).toBe(3);
  expect(p.w.db.find(isB)).toEqual(beforeB);
});
