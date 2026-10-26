// Task 24: adversarial ids travel through the same session router used by app, CLI and MCP.
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessionKey, liveSessionKey, mySessionsKey, projectSessionsKey, sharedSessionsKey, sessionChannel, projectChannel, userChannel, type OrgId } from "../../packages/contracts/src/index.js";
import { routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { bindSessionSurface, sessionForSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { routeDeviceRequest } from "../../packages/broker/src/devices/routes.js";
import { registerDevice } from "../../packages/broker/src/devices/store.js";
import { authorizeRealtime } from "../../packages/broker/src/realtime/authorizer.js";
import { issueRealtimeToken, verifyRealtimeToken } from "../../packages/broker/src/realtime/token.js";
import { projectSessions } from "../../packages/broker/src/agent-sessions/projector.js";
import { ARJUN, BO, CELL, MAX, MIA, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { chainRunViewOf } from "../support/chain-run-view.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "isolation-test", alg: "RS256" as const, use: "sig" as const } as { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" };
const signer = { publicJwk: async () => jwk, sign: async (input: Buffer) => sign("sha256", input, privateKey) };
const THREAD = { kind: "slack_thread" as const, teamId: "T0123456789", channelId: "C0123456789", threadTs: "1700000000.000100" };
const ISSUE = { kind: "linear_issue" as const, issueId: "ENG-142", url: "https://linear.app/acme/issue/ENG-142" };
const WRITE = /^(Put|Update|Delete|TransactWrite|BatchWrite).*Command$/;
afterEach(() => vi.restoreAllMocks());

async function world() {
  const w = sessionWorld();
  const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  const device = await registerDevice(table, w.caller(PRIYA), { requestId: randomUUID(), label: "Priya's Mac", platform: "mac" });
  const bDevice = await registerDevice(table, w.caller(BO, ORG_B), { requestId: randomUUID(), label: "Bo's Mac", platform: "mac" });
  const s1 = w.seedSession();
  const s2 = w.seedSession({ kind: "chain" });
  const s3 = w.seedSession({ kind: "local" });
  const s4 = w.seedSession({ kind: "local" });
  const own = w.seedSession({ orgId: ORG_B, owner: BO });
  for (const s of [s3, s4]) w.db.set({ ...w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!, subject: { kind: "local", deviceId: device.deviceId, tool: "claude-code" }, where: { kind: "mac", deviceId: device.deviceId, label: "Priya's Mac" } });
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
    chain: { runView: async (_actor, id) => chainRunViewOf(id, { status: "needs_person" }), stepTask: async () => taskView({ taskId: s2.taskId, project: "web" }) },
    projectPage: async () => ({ name: "web", status: "active", repositories: [], setup: { status: "ready" }, channels: [] }) as never,
    realtime: { endpoint: "https://example.appsync-api.us-east-1.amazonaws.com/event", projectsOf: async () => ["web"], mint: async (input) => issueRealtimeToken(signer, { ...input, now: w.clock.now }) },
  };
  const call = (who: string, orgId: OrgId, method: string, path: string, body?: unknown) => routeAgentSessionRequest(deps, w.caller(who, orgId), { method, path, headers: {}, requestId: "isolation", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, CELL));
  return { ...w, table, deps, call, taskView, s1, s2, s3, s4, own, device, bDevice };
}
type World = Awaited<ReturnType<typeof world>>;
const cases = (s: string, deviceId: string): Array<[string, string, unknown?]> => [
  ["GET", `/v1/app/sessions/${s}`], ["GET", `/v1/app/sessions/${s}/events`], ["GET", `/v1/app/sessions/${s}/messages`], ["GET", `/v1/app/sessions/${s}/shares`], ["GET", `/v1/app/sessions/${s}/sections/1/task`],
  ["GET", `/v1/app/sessions/${s}/diff?repository=demo&number=1`],
  ["POST", `/v1/app/sessions/${s}/follow`], ["DELETE", `/v1/app/sessions/${s}/follow`], ["POST", `/v1/app/sessions/${s}/presence`],
  ...(["comment", "steer"] as const).map((kind): [string, string, unknown] => ["POST", `/v1/app/sessions/${s}/messages`, { requestId: randomUUID(), kind, text: "Cross-org canary" }]),
  ["PATCH", `/v1/app/sessions/${s}/messages/msg_aaaaaaaaaaaaaaaaaaaa`, { rev: 1, text: "changed" }],
  ["DELETE", `/v1/app/sessions/${s}/messages/msg_aaaaaaaaaaaaaaaaaaaa`, { rev: 1 }],
  ...["take-over", "stop", "retry", "handoff", "agent"].map((action): [string, string, unknown] => ["POST", `/v1/app/sessions/${s}/${action}`, { requestId: randomUUID(), ...(action === "handoff" ? { to: "mac", deviceId } : {}) }]),
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
    const path = `/v1/app/devices/${w.device.deviceId}/commands`;
    expect(await routeDeviceRequest(w.table, w.caller(PRIYA), { method: "GET", path, headers: {}, requestId: "r" }, new URL(path, CELL))).toMatchObject({ commands: [] });
  });
  it("same-named project lists, all Live filters, Home and changes never reveal hidden ids", async () => {
    const w = await world();
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
      for (const channel of [sessionChannel(ORG_A, w.s1.sessionId), sessionChannel(ORG_A, w.s3.sessionId), projectChannel(ORG_A, "web"), userChannel(ORG_A, PRIYA), `/rovara/o-${ORG_A}/*`]) expect(await authorize(channel)).toEqual({ isAuthorized: false, ttlOverride: 0 });
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
