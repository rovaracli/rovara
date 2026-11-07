// Plan 5 Task 18: local sessions. A person's Mac registers a session of a coding agent that runs there and shares it with named people; nothing about it reaches anyone else (not
// the project's maintainers, not the org's admins) until it is shared. Authority is checked live on every call: the device is the caller's own and not removed, the session is that
// device's and the caller's, the company's rule for local agents allows the tool and the project, and what the Mac may do through the session (a person's message, a stop) needs the
// level the session's shares give. A removed Mac ends its open sessions on both paths (the device route and the member's removal).
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_COMMAND_KEEP_DAYS,
  INDEX_EXPIRY_ATTRIBUTE,
  LOCAL_TURNS_MAX,
  LOCAL_UPDATE_TURNS_MAX,
  RealtimeNoticeSchema,
  agentSessionKey,
  deviceCommandCounterKey,
  deviceCommandKey,
  deviceKey,
  deviceSessionKey,
  liveSessionKey,
  openAgentSessionKey,
  orgSettingsKey,
  projectArchivedMessage,
  projectMetaKey,
  userChannel,
  LiveResponseReaderSchema,
  SessionResponseReaderSchema,
  SessionViewSchema,
  type LiveResponse,
  type OrgId,
  type OrgRole,
} from "../../packages/contracts/src/index.js";
import { registerDevice } from "../../packages/broker/src/devices/store.js";
import { endSessionsOfDevice, listDeviceCommands, recordLocalUpdate, registerLocalSession, type LocalSessionDependencies } from "../../packages/broker/src/devices/local-sessions.js";
import { routeDeviceRequest } from "../../packages/broker/src/devices/routes.js";
import { installRealtimeSink } from "../../packages/broker/src/realtime/sink.js";
import { registerSessionNoticeSink } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { onSessionMemberRemoved, stopOrgSessions } from "../../packages/broker/src/agent-sessions/lifecycle.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { sendSessionMessage } from "../../packages/broker/src/agent-sessions/messages.js";
import { stopSession } from "../../packages/broker/src/agent-sessions/stop.js";
import { sweepAgentSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;
const hex = (digit: string) => digit.repeat(64);
const SECRET = `ghp_${"a1".repeat(18)}`;
const REMOVED_TEXT = (label: string) => `${label} was removed, so this session stopped.`;
const NEEDS_SHARE = "Share a local session before it can appear in Rovara.";
const TOO_MANY = "Add up to 10 people when you share; add more afterwards.";
const FULL_TEXT = "This session's transcript is full; start a new one.";

/** A table whose first consistent read of `key` answers `stale` (what was there before a change that lands a moment later), as a race would: the write that follows must still refuse. */
function staleOnce(db: { send(command: unknown): Promise<unknown> }, key: { pk: string; sk: string }, stale: Item | undefined): { send(command: unknown): Promise<unknown> } {
  let served = false;
  return {
    send: async (command: unknown) => {
      const input = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input;
      if (!served && command instanceof GetCommand && input?.Key?.pk === key.pk && input.Key.sk === key.sk) {
        served = true;
        return { Item: stale };
      }
      return db.send(command);
    },
  };
}

function world() {
  const w = sessionWorld();
  const extras = ["1", "2", "3", "4", "5"].map((digit) => hex(digit));
  for (const id of extras) w.member(ORG_A, id, "member");
  const published: Array<{ channel: string; events: string[] }> = [];
  const log: Array<Record<string, unknown>> = [];
  const deviceDeps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, log: (entry: Record<string, unknown>) => { log.push(entry); } };
  const deps: LocalSessionDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, log: (entry) => { log.push(entry); },
    realtimePublish: {
      endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetch: (async (_url: unknown, init: { body: string }) => { published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); }) as never,
    },
  };
  const read: SessionReadDependencies = {
    ...deps, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never,
  };
  const as = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): DeveloperCaller => ({ ...w.caller(developerId, orgId), orgRole });
  const setPolicy = (policy: { allowed?: boolean; tools?: string[]; projects?: "all" | string[] }) => w.db.set({
    ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: policy.allowed ?? true,
    tools: policy.tools ?? ["rovara", "claude-code", "codex", "gemini-cli", "cursor-cli"], projects: policy.projects ?? "all", revision: 1,
  });
  const mac = async (who: string, label = "Priya's MacBook", orgId: OrgId = ORG_A): Promise<string> =>
    (await registerDevice(deviceDeps, as(who, "member", orgId), { requestId: randomUUID(), label, platform: "mac" })).deviceId;
  const body = (deviceId: string, extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(), deviceId, tool: "claude-code", title: "Fix the flaky checkout test", project: "web", startedAt: iso(T0 - 2 * MINUTE),
    shares: [{ principal: { kind: "member", developerId: ARJUN }, level: "view" }], ...extra,
  });
  const register = (who: string, deviceId: string, extra: Record<string, unknown> = {}, orgId: OrgId = ORG_A) => registerLocalSession(deps, as(who, "member", orgId), body(deviceId, extra));
  /** A session of Priya's Mac shared with Arjun (view). */
  const started = async (extra: Record<string, unknown> = {}, label = "Priya's MacBook") => {
    const deviceId = await mac(PRIYA, label);
    const { sessionId } = await register(PRIYA, deviceId, extra);
    return { deviceId, sessionId };
  };
  const update = (who: string, sessionId: string, deviceId: string, extra: Record<string, unknown> = {}, orgId: OrgId = ORG_A) =>
    recordLocalUpdate(deps, as(who, "member", orgId), sessionId, { requestId: randomUUID(), deviceId, status: "running", ...extra });
  const turns = (count: number, prefix = "turn", at = iso(T0)) => Array.from({ length: count }, (_, index) => ({ at, role: index % 2 === 0 ? "person" : "agent", text: `${prefix} ${String(index)}` }));
  const meta = (sessionId: string, orgId: OrgId = ORG_A) => w.db.get(agentSessionKey(orgId, sessionId, "META")) as Item | undefined;
  const local = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "LOCAL")) as Item | undefined;
  const under = (sessionId: string, prefix: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith(prefix));
  const events = (sessionId: string) => under(sessionId, "EVENT#");
  const commands = (deviceId: string) => w.db.find((item) => item.pk === deviceKey(ORG_A, deviceId).pk && String(item.sk).startsWith("COMMAND#"));
  const device = (deviceId: string) => w.db.get(deviceKey(ORG_A, deviceId)) as Item | undefined;
  const writes = () => w.db.transactions().length;
  /** Sets the level of a share the registration wrote (the session's access reads the share item itself). */
  const shareLevel = (sessionId: string, developerId: string, level: "view" | "use" | "edit") => w.db.set({ ...(w.db.get(agentSessionKey(ORG_A, sessionId, `SHARE#MEMBER#${developerId}`)) as Item), level });
  const liveFor = async (who: string, orgId: OrgId = ORG_A): Promise<LiveResponse> => {
    const path = "/v1/app/live";
    return routeAgentSessionRequest(read, w.caller(who, orgId), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)) as Promise<LiveResponse>;
  };
  const view = (who: string, sessionId: string, orgId: OrgId = ORG_A) => sessionView(read, as(who, "member", orgId), sessionId);
  const steer = (who: string, sessionId: string, text = "please use the staging key", orgId: OrgId = ORG_A) =>
    sendSessionMessage(read, { ...as(who, "member", orgId), name: w.caller(who).name }, sessionId, { requestId: randomUUID(), kind: "steer", text });
  const stop = (who: string, sessionId: string, requestId: string = randomUUID(), orgRole: OrgRole = "member") =>
    stopSession(read, { ...as(who, orgRole), name: w.caller(who).name }, sessionId, { requestId });
  const refresh = (sessionId: string) => refreshSessionSummary({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, ORG_A, sessionId);
  const commandPoll = (who: string, deviceId: string, after = 0, orgId: OrgId = ORG_A, orgRole: OrgRole = "member") => {
    const path = `/v1/app/devices/${deviceId}/commands?after=${String(after)}`;
    return routeDeviceRequest(deviceDeps, as(who, orgRole, orgId), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)) as Promise<{ commands: Array<Record<string, unknown>>; next: number }>;
  };
  const removeDevice = (who: string, deviceId: string, orgRole: OrgRole = "member") => {
    const path = `/v1/app/devices/${deviceId}`;
    return routeDeviceRequest(deviceDeps, as(who, orgRole), { method: "DELETE", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`));
  };
  return { ...w, extras, published, log, deviceDeps, deps, read, as, setPolicy, mac, body, register, started, update, turns, meta, local, under, events, commands, device, writes, shareLevel, liveFor, view, steer, stop, refresh, commandPoll, removeDevice };
}

describe("registering a local session", () => {
  it("creates a session on the device, shared with Arjun: it shows in Arjun's Live with the device's label, and not in Max's (maintainer of web, not shared) or Ola's (admin)", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    expect(w.meta(sessionId)).toMatchObject({
      orgId: ORG_A, sessionId, kind: "local", mode: "delegate", subject: { kind: "local", deviceId, tool: "claude-code" }, where: { kind: "mac", deviceId, label: "Priya's MacBook" },
      project: "web", title: "Fix the flaky checkout test", owner: { developerId: PRIYA, name: "Priya" }, startedBy: { kind: "local" }, origin: "local", followerCount: 0,
      summary: { status: "running", costUsd: 0 }, revision: 1, createdAt: iso(T0),
    });
    expect(w.meta(sessionId)).not.toHaveProperty("payer");
    expect(w.meta(sessionId)).not.toHaveProperty("endedAt");
    const arjun = (await w.liveFor(ARJUN)).tiles.find((tile) => tile.sessionId === sessionId);
    expect(arjun).toMatchObject({ kind: "local", where: { kind: "mac", label: "Priya's MacBook", offline: false }, status: "running" });
    for (const who of [MAX, MIA, ZED]) expect((await w.liveFor(who)).tiles.map((tile) => tile.sessionId)).not.toContain(sessionId);
    expect((await w.liveFor(OLA)).tiles.map((tile) => tile.sessionId)).not.toContain(sessionId);
    expect(await code(w.view(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.view(OLA, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    // Nor in the lists: the project's, "mine" and "shared with me".
    const listed = async (who: string, query: string, orgRole: OrgRole = "member") => {
      const path = `/v1/app/sessions${query}`;
      const reply = await routeAgentSessionRequest(w.read, { ...w.caller(who), orgRole }, { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)) as { sessions: Array<{ sessionId: string }> };
      return reply.sessions.map((entry) => entry.sessionId);
    };
    expect(await listed(MAX, "?project=web")).not.toContain(sessionId);
    expect(await listed(OLA, "?project=web", "admin")).not.toContain(sessionId);
    expect(await listed(ARJUN, "?shared=me")).toContain(sessionId);
    expect(await listed(PRIYA, "?owner=me")).toContain(sessionId);
    expect((await w.view(ARJUN, sessionId)).you).toMatchObject({ level: "view", owner: false });
    expect((await w.view(PRIYA, sessionId)).you).toMatchObject({ level: "edit", owner: true });
  });

  it("names the project for rules and budgets only: a project's maintainer or contributor is not given the session", async () => {
    const w = world();
    const { sessionId } = await w.started();
    expect(await code(w.view(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.view(ZED, sessionId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes the session, its leg, its event, its lists, its shares, its device entry and the request in ONE transaction of fewer than 100 items", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const before = w.writes();
    const shares = [ARJUN, MIA, MAX, OLA, ZED, ...w.extras].map((developerId) => ({ principal: { kind: "member", developerId }, level: "view" }));
    expect(shares).toHaveLength(10);
    const { sessionId } = await w.register(PRIYA, deviceId, { shares });
    expect(w.writes()).toBe(before + 1);
    const tx = w.db.transactions().at(-1)!;
    expect(tx.length).toBeLessThan(100);
    expect(w.under(sessionId, "SHARE#")).toHaveLength(10);
    expect(w.under(sessionId, "LEG#")).toHaveLength(1);
    expect(w.under(sessionId, "EVENT#")).toHaveLength(1);
    expect(w.local(sessionId)).toMatchObject({ orgId: ORG_A, sessionId, deviceId, status: "running", turnCount: 0 });
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toMatchObject({ sessionId, deviceId });
    expect(w.db.get(openAgentSessionKey(ORG_A, sessionId))).toBeDefined();
    expect(w.db.get(liveSessionKey(ORG_A, sessionId))).toMatchObject({ kind: "local", ownerId: PRIYA });
    expect(w.db.find((item) => String(item.pk).includes("AGENT_REQUEST#"))).toHaveLength(2); // the device's own and this one
    expect((await w.liveFor(ZED)).tiles.map((tile) => tile.sessionId)).toContain(sessionId);
  });

  it("refuses a session with no shares and one with eleven, writing nothing; ten commit", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const before = w.writes();
    expect(await code(w.register(PRIYA, deviceId, { shares: [] }))).toEqual({ code: "CONFIG_INVALID", message: NEEDS_SHARE });
    const eleven = [ARJUN, MIA, MAX, OLA, ZED, ...w.extras, hex("6")].map((developerId) => ({ principal: { kind: "member", developerId }, level: "view" }));
    expect(eleven).toHaveLength(11);
    expect(await code(w.register(PRIYA, deviceId, { shares: eleven }))).toEqual({ code: "CONFIG_INVALID", message: TOO_MANY });
    expect(w.writes()).toBe(before);
    await expect(w.register(PRIYA, deviceId, { shares: eleven.slice(0, 10) })).resolves.toMatchObject({ sessionId: expect.stringMatching(/^ses_/) as string });
  });

  it("refuses what is not a person or project of the company, the owner themself, a repeat, and the whole company (that needs the confirmation page), all before writing", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const before = w.writes();
    const one = (principal: Record<string, unknown>, level = "view") => [{ principal, level }];
    expect(await code(w.register(PRIYA, deviceId, { shares: one({ kind: "member", developerId: BO }) }))).toEqual({ code: "CONFIG_INVALID", message: "That person isn't in your company." });
    expect(await code(w.register(PRIYA, deviceId, { shares: one({ kind: "member", developerId: PRIYA }) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.register(PRIYA, deviceId, { shares: [...one({ kind: "member", developerId: ARJUN }), ...one({ kind: "member", developerId: ARJUN }, "edit")] }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.register(PRIYA, deviceId, { shares: one({ kind: "org" }) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.register(PRIYA, deviceId, { shares: one({ kind: "project", project: "nope" }) }))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // Mia only views web: a "use" share to her would be refused on a share route too.
    expect(await code(w.register(PRIYA, deviceId, { shares: one({ kind: "member", developerId: MIA }, "use") }))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(w.writes()).toBe(before);
    await expect(w.register(PRIYA, deviceId, { shares: one({ kind: "project", project: "web" }, "use") })).resolves.toBeDefined();
  });

  it("answers a repeat of the same request with the same session and writes nothing; other words under the same id are refused", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const first = w.body(deviceId);
    const a = await registerLocalSession(w.deps, w.as(PRIYA), first);
    const before = w.writes();
    const b = await registerLocalSession(w.deps, w.as(PRIYA), first);
    expect(b.sessionId).toBe(a.sessionId);
    expect(w.writes()).toBe(before);
    expect(await code(registerLocalSession(w.deps, w.as(PRIYA), { ...first, title: "Something else" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(1);
  });

  it("makes the title safe (redacted, one line) and stamps an honest start (never in the future)", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const { sessionId } = await w.register(PRIYA, deviceId, { title: `Use ${SECRET}‮ now\n please`, startedAt: iso(T0 + 3_600_000) });
    const record = w.meta(sessionId)!;
    expect(String(record.title)).not.toContain("ghp_");
    expect(String(record.title)).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect((record.legs as Array<{ startedAt: string }>)[0]!.startedAt <= iso(T0)).toBe(true);
  });

  it("is refused for a device that is not the caller's own, is removed, is another org's or is missing, writing nothing", async () => {
    const w = world();
    const hers = await w.mac(PRIYA);
    const his = await w.mac(ARJUN, "Arjun's Mac");
    const removed = await w.mac(PRIYA, "Old Mac");
    await w.removeDevice(PRIYA, removed);
    const theirs = await w.mac(BO, "Bo's Mac", ORG_B);
    const before = w.writes();
    for (const id of [his, removed, theirs, "dvc_zzzzzzzzzzzzzzzzzzzz"]) expect(await code(w.register(PRIYA, id))).toEqual({ code: "NOT_FOUND", message: "device not found" });
    expect(await code(w.register(BO, hers, {}, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(before);
  });

  it("applies the company's rule for local agents: a tool turned off gives the exact text, a project the rule doesn't list too, and a project-less session is held to a list", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    w.setPolicy({ tools: ["claude-code"], projects: "all" });
    const before = w.writes();
    expect(await code(w.register(PRIYA, deviceId, { tool: "codex" }))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "codex isn't allowed in your company. Ask an admin to allow it." });
    w.setPolicy({ projects: ["ops"] });
    w.grant(PRIYA, "ops", "contributor");
    expect(await code(w.register(PRIYA, deviceId))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "Local agents aren't allowed on web. Ask an admin to allow them." });
    expect(await code(w.register(PRIYA, deviceId, { project: undefined }))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "Local agents need a project your company allows. Ask an admin to allow them." });
    w.setPolicy({ allowed: false });
    expect(await code(w.register(PRIYA, deviceId))).toMatchObject({ code: "LOCAL_AGENT_NOT_ALLOWED" });
    expect(w.writes()).toBe(before);
    w.setPolicy({ projects: ["web"] });
    await expect(w.register(PRIYA, deviceId)).resolves.toBeDefined();
  });

  it("checks the person's role on the project BEFORE the rule, so a rule's text never names a project the person has no role on; and a policy that cannot be read refuses", async () => {
    const w = world();
    const zed = await w.mac(ZED, "Zed's Mac");
    w.setPolicy({ projects: ["ops"] });
    expect(await code(w.register(ZED, zed, { project: "web" }))).toEqual({ code: "PROJECT_NOT_FOUND", message: "project not found" });
    expect(await code(w.register(ZED, zed, { project: "ghost-project" }))).toEqual({ code: "PROJECT_NOT_FOUND", message: "project not found" });
    w.db.set({ ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: "yes", revision: 1 });
    const priya = await w.mac(PRIYA);
    expect(await code(w.register(PRIYA, priya))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(0);
  });

  it("refuses a body with a field the route does not take, a tool Rovara does not know, and a repeated field shape", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    expect(await code(w.register(PRIYA, deviceId, { payer: { kind: "member" } }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.register(PRIYA, deviceId, { tool: "emacs" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.register(PRIYA, deviceId, { shares: "all" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(registerLocalSession(w.deps, w.as(PRIYA), "nope"))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("registers through the route (201, the session view) and a second org's person cannot register on this org's device", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const path = "/v1/app/sessions/local";
    const reply = await routeAgentSessionRequest(w.read, w.caller(PRIYA), { method: "POST", path, headers: {}, requestId: "r", body: JSON.stringify(w.body(deviceId)) }, new URL(`${CELL}${path}`)) as { statusCode: number; body: { session: { sessionId: string; kind: string } } };
    expect(reply.statusCode).toBe(201);
    expect(reply.body.session).toMatchObject({ kind: "local", where: { kind: "mac", label: "Priya's MacBook" } });
    expect(await code(routeAgentSessionRequest(w.read, w.caller(BO, ORG_B), { method: "POST", path, headers: {}, requestId: "r", body: JSON.stringify(w.body(deviceId)) }, new URL(`${CELL}${path}`)))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(routeAgentSessionRequest(w.read, w.caller(PRIYA), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a change that lands between the read and the write", () => {
  it("does not register on a device that was removed a moment after it was read", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const live = { ...w.device(deviceId)! };
    w.db.set({ ...live, revokedAt: iso(T0) });
    const racing = { ...w.deps, documentClient: staleOnce(w.db, deviceKey(ORG_A, deviceId), live) };
    expect(await code(registerLocalSession(racing, w.as(PRIYA), w.body(deviceId)))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(0);
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION_LOCAL")).toHaveLength(0);
  });

  it("does not take an update from a device removed a moment after it was read, nor into a session that ended a moment after it was read", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const live = { ...w.device(deviceId)! };
    w.db.set({ ...live, revokedAt: iso(T0) });
    const gone = { ...w.deps, documentClient: staleOnce(w.db, deviceKey(ORG_A, deviceId), live) };
    expect(await code(recordLocalUpdate(gone, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", turns: w.turns(2) }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    w.db.set({ ...live });
    const openMeta = { ...w.meta(sessionId)! };
    w.db.set({ ...openMeta, endedAt: iso(T0), summary: { ...(openMeta.summary as Item), status: "cancelled" } });
    const ended = { ...w.deps, documentClient: staleOnce(w.db, agentSessionKey(ORG_A, sessionId, "META"), openMeta) };
    expect(await code(recordLocalUpdate(ended, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", turns: w.turns(2) }))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
  });

  it("does not move a session to another device or owner between the read and the write: the update refuses and writes nothing", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const openMeta = { ...w.meta(sessionId)! };
    w.db.set({ ...openMeta, subject: { kind: "task", taskId: randomUUID() }, kind: "task", where: { kind: "cloud" } });
    const moved = { ...w.deps, documentClient: staleOnce(w.db, agentSessionKey(ORG_A, sessionId, "META"), openMeta) };
    expect(await code(recordLocalUpdate(moved, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running", turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    expect(w.local(sessionId)).toMatchObject({ rev: 0, turnCount: 0 });
    w.db.set({ ...openMeta, owner: { developerId: ARJUN, name: "Arjun" } });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not hand a stop to a device removed a moment after it was read: nothing is written and the person is told the Mac is not there", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const live = { ...w.device(deviceId)! };
    w.db.set({ ...live, revokedAt: iso(T0) });
    const racing = { ...w.read, documentClient: staleOnce(w.db, deviceKey(ORG_A, deviceId), live) };
    expect(await code(stopSession(racing, { ...w.as(PRIYA), name: "Priya" }, sessionId, { requestId: randomUUID() }))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "This session's Mac isn't available right now." });
    expect(w.commands(deviceId)).toHaveLength(0);
    expect(w.events(sessionId).some((event) => event.type === "stopped")).toBe(false);
  });
});

describe("more authority and repair", () => {
  it("refuses an update for a session whose owner is someone else even when the device is the caller's own and the session names it", async () => {
    const w = world();
    const { sessionId } = await w.started();
    const arjunsMac = await w.mac(ARJUN, "Arjun's Mac");
    const meta = w.meta(sessionId)!;
    w.db.set({ ...meta, subject: { kind: "local", deviceId: arjunsMac, tool: "claude-code" }, where: { kind: "mac", deviceId: arjunsMac, label: "Arjun's Mac" } });
    expect(await code(w.update(ARJUN, sessionId, arjunsMac, { turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
  });

  it("refuses an update when the Mac's own state says the session ended although the session has not caught up yet", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.set({ ...w.local(sessionId)!, status: "succeeded", endedAt: iso(T0) });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
  });

  it("checks the state it read: a state that moved between the read and the write is read again, not written over", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const old = { ...w.local(sessionId)! };
    w.db.set({ ...old, rev: 1, step: "A newer step" });
    const racing = { ...w.deps, documentClient: staleOnce(w.db, agentSessionKey(ORG_A, sessionId, "LOCAL"), old) };
    await recordLocalUpdate(racing, w.as(PRIYA), sessionId, { requestId: randomUUID(), deviceId, status: "running" });
    expect(w.local(sessionId)).toMatchObject({ rev: 2 });
  });

  it("does not hand a command to a device that is not the session owner's (a stale or moved device): a steer is not delivered and a stop is refused", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.shareLevel(sessionId, ARJUN, "edit");
    w.db.set({ ...w.device(deviceId)!, developerId: ARJUN });
    expect((await w.steer(ARJUN, sessionId, "hello")).delivery).toMatchObject({ state: "not_delivered" });
    expect(await code(w.stop(ARJUN, sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.commands(deviceId)).toHaveLength(0);
  });

  it("gives a poll nothing that another org's command item claims", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.set({ ...deviceCommandKey(ORG_A, deviceId, 1), entityType: "DEVICE_COMMAND", orgId: ORG_B, deviceId, seq: 1, kind: "stop", sessionId, at: iso(T0), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(T0 / 1000) + 3600 });
    expect((await w.commandPoll(PRIYA, deviceId)).commands).toEqual([]);
  });

  it("says so, and finishes on the next removal, when a session could not be ended", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AGENT_SESSION_LOCAL") && JSON.stringify(input).includes("removed, so this session stopped"), error: { name: "InternalServerError" }, times: 1 });
    expect(await code(w.removeDevice(PRIYA, deviceId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.meta(sessionId)).not.toHaveProperty("endedAt");
    expect(w.device(deviceId)).toHaveProperty("revokedAt");
    await w.removeDevice(PRIYA, deviceId);
    expect(w.meta(sessionId)).toMatchObject({ summary: { status: "cancelled" } });
  });
});

describe("the state a Mac left", () => {
  it("is read only when it is the session's own: another device's item, another session's and another org's say nothing, and the summary stays", async () => {
    const w = world();
    const { sessionId } = await w.started();
    const item = w.local(sessionId)!;
    const summaryBefore = (w.meta(sessionId)!.summary as Item).digest;
    for (const wrong of [{ deviceId: "dvc_zzzzzzzzzzzzzzzzzzzz" }, { orgId: ORG_B }, { sessionId: "ses_zzzzzzzzzzzzzzzzzzzz" }]) {
      w.db.set({ ...item, ...wrong, status: "failed", step: "Planted by someone else", endedAt: iso(T0), updatedAt: iso(T0) });
      await w.refresh(sessionId);
      expect(w.meta(sessionId)).not.toHaveProperty("endedAt");
      expect((w.meta(sessionId)!.summary as Item).digest).toBe(summaryBefore);
    }
    // A state that does not read (an unknown status) says nothing either.
    w.db.set({ ...item, status: "exploded" });
    await w.refresh(sessionId);
    expect((w.meta(sessionId)!.summary as Item).digest).toBe(summaryBefore);
    // And the session's own state is what the summary shows.
    w.db.set({ ...item, step: "Reading the logs", status: "running", updatedAt: iso(T0) });
    await w.refresh(sessionId);
    expect((w.meta(sessionId)!.summary as Item).step).toBe("Reading the logs");
  });

  it("keeps the start of the work honest: a start in the future is today, and one older than a week is a week ago", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const { sessionId } = await w.register(PRIYA, deviceId, { startedAt: iso(T0 - 30 * 86_400_000) });
    expect((w.meta(sessionId)!.legs as Array<{ startedAt: string }>)[0]!.startedAt).toBe(iso(T0 - 7 * 86_400_000));
    const second = await w.register(PRIYA, deviceId, { startedAt: iso(T0 + 86_400_000) });
    expect((w.meta(second.sessionId)!.legs as Array<{ startedAt: string }>)[0]!.startedAt).toBe(iso(T0));
  });
});

describe("updates from the Mac", () => {
  it("adds one TURN# item and one local_turn event for each turn (a token redacted), refreshes the tile without the stream, and records the device's last sight", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.clock.now += 5 * MINUTE;
    const reply = await w.update(PRIYA, sessionId, deviceId, {
      status: "running", step: "Running the checkout tests", peek: `ran with ${SECRET}`,
      turns: [{ at: iso(T0), role: "person", text: "fix the flaky test" }, { at: iso(T0), role: "agent", text: `I will use ${SECRET} to log in` }, { at: iso(T0), role: "agent", text: "done reading" }],
    });
    expect(reply).toMatchObject({ sessionId, status: "running", accepted: 3 });
    const turns = w.under(sessionId, "TURN#");
    expect(turns).toHaveLength(3);
    expect(turns.map((turn) => turn.sk)).toEqual(["TURN#000001", "TURN#000002", "TURN#000003"]);
    expect(turns.map((turn) => turn.role)).toEqual(["person", "agent", "agent"]);
    expect(JSON.stringify(turns)).not.toContain("ghp_");
    expect(w.under(sessionId, "EVENT#").filter((event) => event.type === "local_turn")).toHaveLength(3);
    expect(JSON.stringify(w.events(sessionId))).not.toContain("ghp_");
    const tile = (await w.liveFor(ARJUN)).tiles.find((candidate) => candidate.sessionId === sessionId)!;
    expect(tile).toMatchObject({ status: "running", step: "Running the checkout tests" });
    expect(JSON.stringify(tile)).not.toContain("ghp_");
    expect(w.device(deviceId)).toMatchObject({ lastSeenAt: iso(T0 + 5 * MINUTE) });
    expect(w.local(sessionId)).toMatchObject({ turnCount: 3, updatedAt: iso(T0 + 5 * MINUTE) });
    for (const turn of turns) expect(typeof turn[INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
  });

  it("is refused with NOT_FOUND, writing nothing, for another member's device, a removed device, another org's device, another device of the owner, and someone who does not own the session", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const arjunsMac = await w.mac(ARJUN, "Arjun's Mac");
    const priyasSecond = await w.mac(PRIYA, "Priya's Mac mini");
    const orgB = await w.mac(BO, "Bo's Mac", ORG_B);
    const before = w.writes();
    const attempts: Array<[string, string, OrgId?]> = [[ARJUN, arjunsMac], [PRIYA, arjunsMac], [ARJUN, deviceId], [PRIYA, priyasSecond], [BO, orgB, ORG_B], [BO, deviceId, ORG_B]];
    for (const [who, id, orgId] of attempts) {
      expect(await code(w.update(who, sessionId, id, { turns: w.turns(1) }, orgId))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(w.writes()).toBe(before);
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    await w.removeDevice(PRIYA, deviceId);
    const afterRemoval = w.writes();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(afterRemoval);
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
  });

  it("refuses an update for a session that moved to the cloud (its subject is no longer local) with NOT_FOUND, so a late Mac update cannot touch the cloud session", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.set({ ...w.meta(sessionId)!, kind: "task", subject: { kind: "task", taskId: randomUUID() }, where: { kind: "cloud" } });
    const before = w.writes();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { status: "failed", turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(before);
  });

  it("ends the session when the Mac reports an end, and an ended session refuses with SESSION_ENDED", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const requestId = randomUUID();
    const ended = await recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, { requestId, deviceId, status: "succeeded", step: "All tests pass" });
    expect(ended).toMatchObject({ status: "succeeded" });
    expect(w.meta(sessionId)).toMatchObject({ endedAt: iso(T0), summary: { status: "succeeded" } });
    expect(w.db.get(openAgentSessionKey(ORG_A, sessionId))).toBeUndefined();
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))).toBeUndefined();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    // The ending request, repeated, answers what it answered.
    const before = w.writes();
    await expect(recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, { requestId, deviceId, status: "succeeded", step: "All tests pass" })).resolves.toMatchObject({ status: "succeeded" });
    expect(w.writes()).toBe(before);
  });

  it("keeps a failed end marked as a failed run, and treats a stopped report as open", async () => {
    const w = world();
    const a = await w.started();
    await w.update(PRIYA, a.sessionId, a.deviceId, { status: "stopped" });
    expect(w.meta(a.sessionId)).toMatchObject({ summary: { status: "stopped" } });
    expect(w.meta(a.sessionId)).not.toHaveProperty("endedAt");
    const b = await w.started();
    await w.update(PRIYA, b.sessionId, b.deviceId, { status: "failed" });
    expect(w.meta(b.sessionId)).toMatchObject({ endedAt: iso(T0), summary: { status: "failed", lastRunFailed: true } });
  });

  it("refuses a status the Mac may not report (paused), a field the route does not take, a turn that is too long, and more turns than one update may hold", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { status: "paused" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { costUsd: 5 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: [{ at: iso(T0), role: "agent", text: "x".repeat(4001) }] }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(LOCAL_UPDATE_TURNS_MAX + 1) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    await expect(w.update(PRIYA, sessionId, deviceId, { turns: [{ at: iso(T0), role: "agent", text: "é".repeat(4000) }] })).resolves.toMatchObject({ accepted: 1 });
  });

  it("holds at most LOCAL_TURNS_MAX turns: more are refused with the exact text and nothing is written, but a status-only update still goes through", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.set({ ...w.local(sessionId)!, turnCount: LOCAL_TURNS_MAX - 1 });
    await expect(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) })).resolves.toMatchObject({ accepted: 1 });
    const before = w.writes();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toEqual({ code: "CONFIG_INVALID", message: FULL_TEXT });
    expect(w.writes()).toBe(before);
    expect(w.local(sessionId)).toMatchObject({ turnCount: LOCAL_TURNS_MAX });
    await expect(w.update(PRIYA, sessionId, deviceId, { status: "succeeded" })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("takes a full update of 40 turns as ONE transaction with their events (all or nothing), and refuses 41 with a clear text, writing nothing", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    expect(LOCAL_UPDATE_TURNS_MAX).toBe(40);
    const before = w.writes();
    const all = w.turns(LOCAL_UPDATE_TURNS_MAX);
    await expect(w.update(PRIYA, sessionId, deviceId, { turns: all })).resolves.toMatchObject({ accepted: 40 });
    const updateTransactions = w.db.transactions().slice(before).filter((tx) => JSON.stringify(tx).includes("AGENT_SESSION_LOCAL_TURN"));
    expect(updateTransactions).toHaveLength(1);
    expect(updateTransactions[0]!.length).toBeLessThanOrEqual(100);
    const turns = w.under(sessionId, "TURN#").sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    expect(turns.map((turn) => turn.text)).toEqual(all.map((turn) => turn.text));
    expect(w.under(sessionId, "EVENT#").filter((event) => event.type === "local_turn")).toHaveLength(40);
    const afterWrites = w.writes();
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(41) }))).toEqual({ code: "CONFIG_INVALID", message: "turns: An update holds at most 40 turns; send the rest in the next update." });
    expect(w.writes()).toBe(afterWrites);
    expect(w.under(sessionId, "TURN#")).toHaveLength(40);
    expect(w.local(sessionId)).not.toHaveProperty("partial");
  });

  it("writes a failed update whole or not at all: nothing of it is left when its transaction fails, and the same request then writes it", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const requestId = randomUUID();
    const all = w.turns(LOCAL_UPDATE_TURNS_MAX);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AGENT_REQUEST"), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    await expect(recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, { requestId, deviceId, status: "running", turns: all })).rejects.toBeDefined();
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    expect(w.local(sessionId)).toMatchObject({ turnCount: 0 });
    await expect(recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, { requestId, deviceId, status: "running", turns: all })).resolves.toMatchObject({ accepted: 40 });
    expect(w.under(sessionId, "TURN#")).toHaveLength(40);
  });

  it("keeps every turn of two updates that arrive together (the count is checked, one retries)", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await Promise.all([w.update(PRIYA, sessionId, deviceId, { turns: w.turns(3, "a") }), w.update(PRIYA, sessionId, deviceId, { turns: w.turns(3, "b") })]);
    const turns = w.under(sessionId, "TURN#");
    expect(turns).toHaveLength(6);
    expect(new Set(turns.map((turn) => turn.sk)).size).toBe(6);
    expect(w.local(sessionId)).toMatchObject({ turnCount: 6 });
  });

  it("answers a repeat of an update with the same answer and writes nothing; other words under the same request id are refused", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const input = { requestId: randomUUID(), deviceId, status: "running", turns: w.turns(2) };
    const first = await recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, input);
    const before = w.writes();
    await expect(recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, input)).resolves.toEqual(first);
    expect(w.writes()).toBe(before);
    expect(w.under(sessionId, "TURN#")).toHaveLength(2);
    expect(await code(recordLocalUpdate(w.deps, w.as(PRIYA), sessionId, { ...input, turns: w.turns(3) }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("shows offline after 11 minutes without an update, and the next update clears it", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.clock.now += 11 * MINUTE;
    await w.refresh(sessionId);
    expect((await w.view(ARJUN, sessionId)).where).toEqual({ kind: "mac", label: "Priya's MacBook", offline: true });
    w.clock.now += MINUTE;
    await w.update(PRIYA, sessionId, deviceId, { status: "running" });
    expect((await w.view(ARJUN, sessionId)).where).toEqual({ kind: "mac", label: "Priya's MacBook", offline: false });
    // And the sweep finds a silent Mac on its own.
    w.clock.now += 11 * MINUTE;
    await sweepAgentSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, w.clock.now);
    expect((await w.view(ARJUN, sessionId)).where).toMatchObject({ offline: true });
  });

  it("goes through the route: 200 for the Mac's person, NOT_FOUND for anyone else, GET refused", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const path = `/v1/app/sessions/${sessionId}/local/updates`;
    const send = (who: string, method = "POST") => routeAgentSessionRequest(w.read, w.caller(who), { method, path, headers: {}, requestId: "r", body: JSON.stringify({ requestId: randomUUID(), deviceId, status: "running", turns: w.turns(1) }) }, new URL(`${CELL}${path}`));
    await expect(send(PRIYA)).resolves.toMatchObject({ sessionId, accepted: 1 });
    expect(await code(send(ARJUN))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(send(PRIYA, "GET"))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("messages and stops for a session on a Mac", () => {
  it("gives the Mac a steer and a stop in order on its poll, each announced on the owner's channel, and never to anyone else", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.shareLevel(sessionId, ARJUN, "edit");
    const message = await w.steer(ARJUN, sessionId, "use the staging database");
    expect(message.delivery).toMatchObject({ state: "queued" });
    await w.stop(ARJUN, sessionId);
    const poll = await w.commandPoll(PRIYA, deviceId);
    expect(poll.commands.map((command) => ({ seq: command.seq, kind: command.kind, sessionId: command.sessionId }))).toEqual([{ seq: 1, kind: "steer", sessionId }, { seq: 2, kind: "stop", sessionId }]);
    expect(poll.commands[0]).toMatchObject({ messageId: message.messageId, text: "use the staging database", from: "Arjun" });
    expect(poll.commands[1]).toMatchObject({ kind: "stop", from: "Arjun" });
    expect(poll.next).toBe(2);
    expect((await w.commandPoll(PRIYA, deviceId, 1)).commands.map((command) => command.seq)).toEqual([2]);
    expect((await w.commandPoll(PRIYA, deviceId, 2)).commands).toEqual([]);
    const notices = w.published.filter((entry) => entry.channel === userChannel(ORG_A, PRIYA)).flatMap((entry) => entry.events.map((event) => RealtimeNoticeSchema.parse(JSON.parse(event))));
    expect(notices.filter((notice) => notice.type === "device.command")).toEqual([{ type: "device.command", deviceId, seq: 1 }, { type: "device.command", deviceId, seq: 2 }]);
    expect(JSON.stringify(w.published)).not.toContain("staging database");
  });

  it("expires the commands with the table's TTL and keeps the sequence beside them", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await w.stop(PRIYA, sessionId);
    const [command] = w.commands(deviceId);
    expect(command).toMatchObject({ entityType: "DEVICE_COMMAND", orgId: ORG_A, deviceId, seq: 1, kind: "stop", sessionId });
    expect(command![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(T0 / 1000) + DEVICE_COMMAND_KEEP_DAYS * 86_400);
    expect(w.db.get(deviceCommandKey(ORG_A, deviceId, 1))).toBeDefined();
    expect(w.db.get(deviceCommandCounterKey(ORG_A, deviceId))).toMatchObject({ seq: 1 });
    // No expiry while the device lives (review M3: a lapsed counter would restart below the Mac's cursor).
    expect(w.db.get(deviceCommandCounterKey(ORG_A, deviceId))).not.toHaveProperty(INDEX_EXPIRY_ATTRIBUTE);
    // A command past its time is not given although the table has not deleted it yet.
    w.clock.now += (DEVICE_COMMAND_KEEP_DAYS + 1) * 86_400_000;
    expect((await w.commandPoll(PRIYA, deviceId)).commands).toEqual([]);
  });

  it("needs the level the shares give: a viewer cannot steer, a user cannot stop, people the session is not shared with find nothing, an org admin has no say", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    expect(await code(w.steer(ARJUN, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await code(w.stop(ARJUN, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await code(w.steer(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.stop(MAX, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.stop(OLA, sessionId, randomUUID(), "admin"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.steer(BO, sessionId, "hello", ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.commands(deviceId)).toHaveLength(0);
    w.shareLevel(sessionId, ARJUN, "use");
    await expect(w.steer(ARJUN, sessionId)).resolves.toMatchObject({ delivery: { state: "queued" } });
    expect(await code(w.stop(ARJUN, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(w.commands(deviceId)).toHaveLength(1);
  });

  it("stops by writing the command, the request, the stopped event in one transaction; a repeat of the request adds no second command; an ended session says so", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const requestId = randomUUID();
    const reply = await w.stop(PRIYA, sessionId, requestId);
    expect(reply.session.sessionId).toBe(sessionId);
    // The command, the request item and the stopped event are one transaction (the summary refresh after it is another).
    const together = w.db.transactions().filter((tx) => JSON.stringify(tx).includes('"DEVICE_COMMAND"'));
    expect(together).toHaveLength(1);
    expect(JSON.stringify(together[0])).toContain("AGENT_SESSION_REQUEST");
    expect(JSON.stringify(together[0])).toContain('"stopped"');
    expect(w.events(sessionId).some((event) => event.type === "stopped")).toBe(true);
    await w.stop(PRIYA, sessionId, requestId);
    expect(w.commands(deviceId)).toHaveLength(1);
    await w.update(PRIYA, sessionId, deviceId, { status: "cancelled" });
    expect(await code(w.stop(PRIYA, sessionId))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.commands(deviceId)).toHaveLength(1);
  });

  it("marks a steer delivered when the Mac's poll gives it, and not delivered when the session ends before the Mac asks", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.shareLevel(sessionId, ARJUN, "use");
    const first = await w.steer(ARJUN, sessionId, "one");
    const second = await w.steer(ARJUN, sessionId, "two");
    const messageState = (id: string) => (w.db.get(agentSessionKey(ORG_A, sessionId, `MESSAGE#${id}`)) as { delivery: { state: string; reason?: string } }).delivery;
    expect(messageState(first.messageId).state).toBe("queued");
    await w.commandPoll(PRIYA, deviceId, 0);
    expect(messageState(first.messageId).state).toBe("delivered");
    expect(messageState(second.messageId).state).toBe("delivered");
    const third = await w.steer(ARJUN, sessionId, "three");
    await w.update(PRIYA, sessionId, deviceId, { status: "succeeded" });
    await w.refresh(sessionId);
    expect(messageState(third.messageId)).toMatchObject({ state: "not_delivered", reason: "the session has ended" });
  });

  it("does not hand a steer to a device that was removed or is not the owner's: the message is kept as not delivered, and a stop is refused", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.shareLevel(sessionId, ARJUN, "edit");
    w.db.set({ ...w.device(deviceId)!, revokedAt: iso(T0) });
    const message = await w.steer(ARJUN, sessionId, "anyone there?");
    expect(message.delivery).toMatchObject({ state: "not_delivered" });
    expect(await code(w.stop(ARJUN, sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.commands(deviceId)).toHaveLength(0);
  });

  it("serves the poll only to the device's own person: another member, another org and a removed device get NOT_FOUND", async () => {
    const w = world();
    const { deviceId } = await w.started();
    expect(await code(w.commandPoll(ARJUN, deviceId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.commandPoll(BO, deviceId, 0, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.commandPoll(OLA, deviceId, 0, ORG_A, "admin"))).toMatchObject({ code: "NOT_FOUND" });
    await w.removeDevice(PRIYA, deviceId);
    expect(await code(w.commandPoll(PRIYA, deviceId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.commandPoll(PRIYA, "dvc_zzzzzzzzzzzzzzzzzzzz"))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives at most 100 commands to a poll, and a cursor that is not a number is refused", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    for (let seq = 1; seq <= 105; seq += 1) {
      w.db.set({ ...deviceCommandKey(ORG_A, deviceId, seq), entityType: "DEVICE_COMMAND", orgId: ORG_A, deviceId, seq, kind: "stop", sessionId, at: iso(T0), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(T0 / 1000) + 3600 });
    }
    const page = await w.commandPoll(PRIYA, deviceId, 0);
    expect(page.commands).toHaveLength(100);
    expect(page.next).toBe(100);
    expect((await w.commandPoll(PRIYA, deviceId, 100)).commands).toHaveLength(5);
    expect(await code(listDeviceCommands(w.deviceDeps, w.as(PRIYA), deviceId, "abc"))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("a removed Mac ends its open sessions", () => {
  it("ends them cancelled with the exact words when the device is removed, only those of that device, and takes the entry off the live and sweep lists", async () => {
    const w = world();
    const first = await w.started({}, "Priya's MacBook");
    const second = await w.register(PRIYA, first.deviceId, { title: "A second session" });
    const otherDevice = await w.mac(PRIYA, "Priya's Mac mini");
    const other = await w.register(PRIYA, otherDevice);
    const done = await w.register(PRIYA, first.deviceId, { title: "Already finished" });
    await w.update(PRIYA, done.sessionId, first.deviceId, { status: "succeeded" });
    w.clock.now += MINUTE;
    await w.removeDevice(PRIYA, first.deviceId);
    for (const id of [first.sessionId, second.sessionId]) {
      expect(w.meta(id)).toMatchObject({ endedAt: iso(T0 + MINUTE), summary: { status: "cancelled", step: REMOVED_TEXT("Priya's MacBook") } });
      expect(w.events(id).map((event) => event.text)).toContain(REMOVED_TEXT("Priya's MacBook"));
      expect(w.db.get(openAgentSessionKey(ORG_A, id))).toBeUndefined();
    }
    expect(w.meta(other.sessionId)).not.toHaveProperty("endedAt");
    expect(w.meta(done.sessionId)).toMatchObject({ endedAt: iso(T0), summary: { status: "succeeded" } });
    expect(w.events(done.sessionId).map((event) => event.text)).not.toContain(REMOVED_TEXT("Priya's MacBook"));
    // The late update of the removed Mac is refused.
    expect(await code(w.update(PRIYA, first.sessionId, first.deviceId, { turns: w.turns(1) }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("is done by an org admin removing someone's device too", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await w.removeDevice(OLA, deviceId, "admin");
    expect(w.meta(sessionId)).toMatchObject({ summary: { status: "cancelled" } });
    expect(w.meta(sessionId)).toHaveProperty("endedAt");
  });

  it("finishes an end that stopped part-way when the removal is asked again, and refuses to end the sessions of a device that is not removed", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    // A device that is live: nothing is ended.
    await expect(endSessionsOfDevice(w.deviceDeps, ORG_A, deviceId)).resolves.toBe(0);
    expect(w.meta(sessionId)).not.toHaveProperty("endedAt");
    // The device was marked removed, but the process died before the sessions were ended.
    w.db.set({ ...w.device(deviceId)!, revokedAt: iso(T0), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(T0 / 1000) + 365 * 86_400 });
    expect(w.meta(sessionId)).not.toHaveProperty("endedAt");
    await w.removeDevice(PRIYA, deviceId);
    expect(w.meta(sessionId)).toMatchObject({ summary: { status: "cancelled" } });
    await expect(endSessionsOfDevice(w.deviceDeps, ORG_A, deviceId)).resolves.toBe(0);
  });

  it("does not end a session that names a different device, even when the removed device's entry lists it, and never one of another org", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    const other = await w.mac(PRIYA, "Priya's Mac mini");
    // A stale entry on the removed device for a session that runs elsewhere.
    const elsewhere = await w.register(PRIYA, other);
    w.db.set({ ...deviceSessionKey(ORG_A, deviceId, elsewhere.sessionId), entityType: "DEVICE_SESSION", orgId: ORG_A, deviceId, sessionId: elsewhere.sessionId, createdAt: iso(T0) });
    await w.removeDevice(PRIYA, deviceId);
    expect(w.meta(sessionId)).toHaveProperty("endedAt");
    expect(w.meta(elsewhere.sessionId)).not.toHaveProperty("endedAt");
    await expect(endSessionsOfDevice(w.deviceDeps, ORG_B, deviceId)).resolves.toBe(0);
  });

  it("is done by the member's removal as well (the lifecycle path), for every device they had", async () => {
    const w = world();
    const first = await w.started({}, "Priya's MacBook");
    const otherDevice = await w.mac(PRIYA, "Priya's Mac mini");
    const second = await w.register(PRIYA, otherDevice);
    const arjunsDevice = await w.mac(ARJUN, "Arjun's Mac");
    const arjuns = await w.register(ARJUN, arjunsDevice, { shares: [{ principal: { kind: "member", developerId: MAX }, level: "view" }] });
    await onSessionMemberRemoved({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: PRIYA });
    expect(w.meta(first.sessionId)).toMatchObject({ summary: { status: "cancelled", step: REMOVED_TEXT("Priya's MacBook") } });
    expect(w.meta(second.sessionId)).toMatchObject({ summary: { status: "cancelled", step: REMOVED_TEXT("Priya's Mac mini") } });
    expect(w.meta(arjuns.sessionId)).not.toHaveProperty("endedAt");
    // Run again (a mover is repeatable): nothing more changes.
    const before = w.writes();
    await onSessionMemberRemoved({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: PRIYA });
    expect(w.writes()).toBe(before);
  });

  it("a removal run that finds the device already marked still ends its sessions", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.db.set({ ...w.device(deviceId)!, revokedAt: iso(T0 - MINUTE) });
    await onSessionMemberRemoved({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, developerId: PRIYA });
    expect(w.meta(sessionId)).toMatchObject({ summary: { status: "cancelled" } });
  });
});

afterEach(() => registerSessionNoticeSink(undefined));

describe("the company's rule and the person's role are read again on every update (review I1)", () => {
  const TIGHT = "codex isn't allowed in your company. Ask an admin to allow it.";

  it("refuses an update with turns after the tool is turned off, with the exact text and nothing written; an update that only ends the session still goes through", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started({ tool: "codex" });
    w.setPolicy({ tools: ["claude-code"] });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: TIGHT });
    expect(await code(w.update(PRIYA, sessionId, deviceId, { status: "running", step: "still going" }))).toMatchObject({ code: "LOCAL_AGENT_NOT_ALLOWED" });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    await expect(w.update(PRIYA, sessionId, deviceId, { status: "cancelled" })).resolves.toMatchObject({ status: "cancelled" });
    expect(w.meta(sessionId)).toHaveProperty("endedAt");
  });

  it("refuses when the rule narrows to other projects, when local agents are switched off, and when the rule cannot be read (503), but never an end", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.setPolicy({ projects: ["api"] });
    expect(await code(w.update(PRIYA, sessionId, deviceId))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: "Local agents aren't allowed on web. Ask an admin to allow them." });
    w.setPolicy({ allowed: false });
    expect(await code(w.update(PRIYA, sessionId, deviceId))).toMatchObject({ code: "LOCAL_AGENT_NOT_ALLOWED" });
    w.db.set({ ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: "yes", revision: 1 });
    expect(await code(w.update(PRIYA, sessionId, deviceId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(w.update(PRIYA, sessionId, deviceId, { status: "succeeded" })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("refuses an update from someone who lost their role on the session's project, with a clear reason, and still takes an end", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.members.revoke(ORG_A, "web", PRIYA);
    const refused = await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }));
    expect(refused).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(refused!.message).toContain("web");
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    await expect(w.update(PRIYA, sessionId, deviceId, { status: "failed" })).resolves.toMatchObject({ status: "failed" });
  });
});

describe("limits (review I2, M4)", () => {
  it("allows 30 updates a minute for one session, refuses the 31st with TOO_MANY_REQUESTS writing nothing, takes an end anyway, and gives the next minute its own count", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    for (let i = 0; i < 30; i += 1) await w.update(PRIYA, sessionId, deviceId, { step: `step ${String(i)}` });
    const before = w.local(sessionId)!;
    expect(await code(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) }))).toEqual({ code: "TOO_MANY_REQUESTS", message: "This Mac is sending updates too fast; it will send the rest shortly." });
    expect(w.under(sessionId, "TURN#")).toHaveLength(0);
    expect(w.local(sessionId)).toMatchObject({ rev: before.rev });
    w.clock.now += MINUTE;
    await expect(w.update(PRIYA, sessionId, deviceId, { turns: w.turns(1) })).resolves.toMatchObject({ accepted: 1 });
    for (let i = 0; i < 29; i += 1) await w.update(PRIYA, sessionId, deviceId);
    expect(await code(w.update(PRIYA, sessionId, deviceId))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(w.update(PRIYA, sessionId, deviceId, { status: "succeeded", turns: w.turns(2) })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("allows 120 updates a minute for one device across its sessions", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const sessions: string[] = [];
    for (let i = 0; i < 5; i += 1) sessions.push((await w.register(PRIYA, deviceId)).sessionId);
    for (const sessionId of sessions.slice(0, 4)) for (let i = 0; i < 30; i += 1) await w.update(PRIYA, sessionId, deviceId);
    expect(await code(w.update(PRIYA, sessions[4]!, deviceId))).toEqual({ code: "TOO_MANY_REQUESTS", message: "This Mac is sending updates too fast; it will send the rest shortly." });
    await expect(w.update(PRIYA, sessions[4]!, deviceId, { status: "cancelled" })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("tells followers of at most 12 status changes an hour: beyond that the status still saves and the session still shows it, but no follower is told; an end always tells", async () => {
    const w = world();
    installRealtimeSink({});
    const { sessionId, deviceId } = await w.started();
    w.follower(ORG_A, sessionId, ARJUN);
    const feed = () => w.db.find((item) => String(item.pk).includes(`CHANGES#${ARJUN}`)).length;
    for (let cycle = 0; cycle < 13; cycle += 1) {
      w.clock.now += MINUTE;
      await w.update(PRIYA, sessionId, deviceId, { status: "waiting" });
      expect(w.meta(sessionId)).toMatchObject({ summary: { status: "waiting" } });
      w.clock.now += MINUTE;
      await w.update(PRIYA, sessionId, deviceId, { status: "running" });
    }
    expect(feed()).toBe(12);
    w.clock.now += MINUTE;
    await w.update(PRIYA, sessionId, deviceId, { status: "succeeded" });
    expect(feed()).toBe(13);
    // And the owner is still told of the quiet changes: the session's own channel and the owner's feed are not silenced.
    expect(w.db.find((item) => String(item.pk).includes(`CHANGES#${PRIYA}`)).length).toBeGreaterThan(12);
  });

  it("counts only changes into a status that tells followers: repeating the same status does not use up the hour's places", async () => {
    const w = world();
    installRealtimeSink({});
    const { sessionId, deviceId } = await w.started();
    w.follower(ORG_A, sessionId, ARJUN);
    const feed = () => w.db.find((item) => String(item.pk).includes(`CHANGES#${ARJUN}`)).length;
    for (let i = 0; i < 14; i += 1) {
      if (i % 5 === 0) w.clock.now += MINUTE;
      await w.update(PRIYA, sessionId, deviceId, { status: "waiting", step: `again ${String(i)}` });
    }
    expect(feed()).toBe(1);
    w.clock.now += MINUTE;
    await w.update(PRIYA, sessionId, deviceId, { status: "running" });
    await w.update(PRIYA, sessionId, deviceId, { status: "waiting" });
    expect(feed()).toBe(2);
  });

  it("does not count the entry of a session that ended without taking it away against the device's 20", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const made: string[] = [];
    for (let i = 0; i < 20; i += 1) made.push((await w.register(PRIYA, deviceId)).sessionId);
    w.db.set({ ...w.meta(made[0]!)!, endedAt: iso(T0) });
    await expect(w.register(PRIYA, deviceId)).resolves.toBeDefined();
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, made[0]!))).toBeUndefined();
    expect(await code(w.register(PRIYA, deviceId))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("allows 20 open sessions on a device: the 21st is refused with a clear text, nothing written, and an end frees a place", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    const made: string[] = [];
    for (let i = 0; i < 20; i += 1) made.push((await w.register(PRIYA, deviceId)).sessionId);
    const before = w.writes();
    expect(await code(w.register(PRIYA, deviceId))).toEqual({ code: "CONFIG_INVALID", message: "This Mac already has 20 open sessions. End one first." });
    expect(w.writes()).toBe(before);
    await w.update(PRIYA, made[0]!, deviceId, { status: "succeeded" });
    await expect(w.register(PRIYA, deviceId)).resolves.toBeDefined();
  });

  it("allows 60 registrations an hour for one person: the 61st is TOO_MANY_REQUESTS, and the next hour has its own count", async () => {
    const w = world();
    const devices = [await w.mac(PRIYA, "a"), await w.mac(PRIYA, "b"), await w.mac(PRIYA, "c"), await w.mac(PRIYA, "d")];
    for (let i = 0; i < 60; i += 1) await w.register(PRIYA, devices[Math.floor(i / 20)]!);
    expect(await code(w.register(PRIYA, devices[3]!))).toEqual({ code: "TOO_MANY_REQUESTS", message: "You've started a lot of local sessions in the last hour. Try again later." });
    w.clock.now += 3_600_000;
    await expect(w.register(PRIYA, devices[3]!)).resolves.toBeDefined();
    // Another person has their own count.
    await expect(w.register(ARJUN, await w.mac(ARJUN, "Arjun's Mac"), { shares: [{ principal: { kind: "member", developerId: PRIYA }, level: "view" }] })).resolves.toBeDefined();
  });

  it("limits stops: 20 an hour for a session; the 21st (a new request id) is TOO_MANY_REQUESTS and adds no command", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    for (let i = 0; i < 20; i += 1) await w.stop(PRIYA, sessionId);
    expect(w.commands(deviceId)).toHaveLength(20);
    expect(await code(w.stop(PRIYA, sessionId))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(w.commands(deviceId)).toHaveLength(20);
    w.clock.now += 3_600_000;
    await expect(w.stop(PRIYA, sessionId)).resolves.toBeDefined();
  });
});

describe("review minors", () => {
  it("M1: refuses an archived project at registration, writing nothing", async () => {
    const w = world();
    const deviceId = await w.mac(PRIYA);
    w.db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "archived", createdAt: "2026-10-02T00:00:00.000Z", createdBy: OLA });
    expect(await code(w.register(PRIYA, deviceId))).toEqual({ code: "PROJECT_ARCHIVED", message: projectArchivedMessage("web") });
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(0);
  });

  it("M2: a Mac silent for 24 hours ends its session (the sweep finds it); 23 hours does not; a late update is SESSION_ENDED; a removal before the sweep still finds the session", async () => {
    const w = world();
    const a = await w.started();
    const b = await w.started({}, "Priya's Mac mini");
    const c = await w.started({}, "Priya's third");
    w.clock.now += 23 * 3_600_000;
    await sweepAgentSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, w.clock.now);
    expect(w.meta(a.sessionId)).not.toHaveProperty("endedAt");
    await w.update(PRIYA, c.sessionId, c.deviceId);
    w.clock.now += 2 * 3_600_000;
    await w.removeDevice(PRIYA, b.deviceId); // silent for 25 hours and not yet swept: the removal still finds it
    expect(w.meta(b.sessionId)).toMatchObject({ summary: { status: "cancelled", step: REMOVED_TEXT("Priya's Mac mini") } });
    await sweepAgentSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, w.clock.now);
    expect(w.meta(a.sessionId)).toMatchObject({ endedAt: iso(w.clock.now), summary: { status: "cancelled", step: "This Mac stopped responding, so this session ended." } });
    expect(w.meta(c.sessionId)).not.toHaveProperty("endedAt");
    expect(w.db.get(openAgentSessionKey(ORG_A, a.sessionId))).toBeUndefined();
    expect(await code(w.update(PRIYA, a.sessionId, a.deviceId))).toEqual({ code: "SESSION_ENDED", message: "This session has ended." });
  });

  it("M2: an update keeps the device's entry for the session from lapsing", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    w.clock.now += 100 * 86_400_000;
    await w.update(PRIYA, sessionId, deviceId);
    expect(w.db.get(deviceSessionKey(ORG_A, deviceId, sessionId))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(w.clock.now / 1000) + 365 * 86_400);
  });

  it("M3: the command counter has no expiry while the device lives, so it never restarts below the Mac's cursor; removing the device lets it go", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await w.stop(PRIYA, sessionId);
    expect(w.db.get(deviceCommandCounterKey(ORG_A, deviceId))).not.toHaveProperty(INDEX_EXPIRY_ATTRIBUTE);
    w.clock.now += 400 * 86_400_000;
    w.db.set({ ...w.db.get(deviceCommandCounterKey(ORG_A, deviceId))!, seq: 57 });
    await w.stop(PRIYA, sessionId);
    expect(w.commands(deviceId).map((command) => command.seq)).toContain(58);
    await w.removeDevice(PRIYA, deviceId);
    expect(w.db.get(deviceCommandCounterKey(ORG_A, deviceId))![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(w.clock.now / 1000) + 365 * 86_400);
  });

  it("M5: closing the company ends its open local sessions with a clear text and does not ask the stop of a cloud session for them", async () => {
    const w = world();
    const { sessionId } = await w.started();
    const cloud = w.seedSession();
    w.db.set({ ...openAgentSessionKey(ORG_A, cloud.sessionId), entityType: "OPEN_AGENT_SESSION", orgId: ORG_A, sessionId: cloud.sessionId });
    const stopped: string[] = [];
    await stopOrgSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined }, ORG_A, async (id) => { stopped.push(id); });
    expect(stopped).toEqual([cloud.sessionId]);
    expect(w.meta(sessionId)).toMatchObject({ endedAt: iso(T0), summary: { status: "cancelled", step: "Your company was closed, so this session stopped." } });
    expect(w.db.get(openAgentSessionKey(ORG_A, sessionId))).toBeUndefined();
  });

  it("M7: bidi and zero-width characters are not kept in a turn or its event", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await w.update(PRIYA, sessionId, deviceId, { turns: [{ at: iso(T0), role: "agent", text: "safe\u202etxt.exe\u200b done" }] });
    expect(String(w.under(sessionId, "TURN#")[0]!.text)).not.toMatch(/[\u202e\u200b]/u);
    expect(JSON.stringify(w.events(sessionId))).not.toMatch(/\\u202e|\\u200b|[\u202e\u200b]/u);
  });
});

describe("an existing session on a Mac after the Mac move was hidden (owner decision 14)", () => {
  it("still reads on the session page and in Live and the lists, as a session on that Mac, but is not offered a move", async () => {
    const w = world();
    const { sessionId, deviceId } = await w.started();
    await w.update(PRIYA, sessionId, deviceId, { step: "Reading the logs" });
    // The session page: the same view the web app and the CLI read, with its Mac named.
    const owner = await w.view(PRIYA, sessionId);
    expect(SessionViewSchema.parse(owner)).toEqual(owner);
    expect(SessionResponseReaderSchema.safeParse({ session: owner }).success).toBe(true);
    expect(owner).toMatchObject({ sessionId, kind: "local", where: { kind: "mac", label: "Priya's MacBook" }, title: "Fix the flaky checkout test", owner: { developerId: PRIYA }, you: { level: "edit", owner: true } });
    expect(owner.you.actions).toEqual(expect.arrayContaining(["watch", "comment", "steer", "stop"]));
    expect(owner.you.actions).not.toContain("handoff");
    // The person it is shared with reads it too, without the owner's actions.
    const shared = await w.view(ARJUN, sessionId);
    expect(shared).toMatchObject({ kind: "local", you: { level: "view", owner: false } });
    expect(shared.you.actions).not.toContain("handoff");
    // Live: the tile for the owner and for the person shared with, parsed with the reader the web app uses.
    for (const who of [PRIYA, ARJUN]) {
      const live = await w.liveFor(who);
      expect(LiveResponseReaderSchema.safeParse(live).success, who).toBe(true);
      const tile = live.tiles.find((entry) => entry.sessionId === sessionId);
      expect(tile, who).toMatchObject({ kind: "local", where: { kind: "mac", label: "Priya's MacBook" }, status: "running" });
      expect(tile!.actions, who).not.toContain("handoff");
    }
    // The lists.
    const path = "/v1/app/sessions?owner=me";
    const mine = await routeAgentSessionRequest(w.read, w.caller(PRIYA), { method: "GET", path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`)) as { sessions: Array<{ sessionId: string; kind: string }> };
    expect(mine.sessions.find((entry) => entry.sessionId === sessionId)).toMatchObject({ kind: "local" });
  });

  it("keeps the move route itself: the owner's request still reaches it (it answers a refusal, not 404), so nothing that exists is removed", async () => {
    const w = world();
    const { sessionId } = await w.started();
    const path = `/v1/app/sessions/${sessionId}/handoff`;
    const reply = await code(Promise.resolve(routeAgentSessionRequest(w.read, w.caller(PRIYA), { method: "POST", path, headers: {}, requestId: "r", body: JSON.stringify({ requestId: randomUUID(), to: "moon" }) }, new URL(`${CELL}${path}`))));
    expect(reply).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
