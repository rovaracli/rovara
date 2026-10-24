// Plan 5 Task 10c: an agent remembers the task it was made from. `POST /v1/app/sessions/{id}/agent` makes an agent (with its draft) from a session; it needs `view` on the session AND the right to
// create agents in the session's project, both read live. The draft carries an immutable `origin` (set only here, copied unchanged into every version published from the draft), the agent kind
// (the agent the session ran, as the new agent's base), the project (its owner) and the redacted goal text (its instructions): never a secret or the workspace. Whoever may read the session now
// sees the origin with its title and link; everyone else, and everyone once the session is deleted or past retention, sees `{ kind: "session", visible: false }`. The session view says whether the
// caller may do this (`you.actions` holds `make_agent`), worked out by the same check as the route. Drafts and versions made before this still parse.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentOriginSchema,
  AgentOriginViewSchema,
  SESSION_ACTIONS,
  SESSION_RETENTION_DAYS,
  SessionMakeAgentBodySchema,
  SessionResponseSchema,
  agentSessionKey,
  agentKey,
  projectMemberKey,
  type AgentId,
  type OrgId,
} from "../../packages/contracts/src/index.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const GOAL = "Bump the Stripe SDK to v15 and fix what breaks in the checkout tests.";
type Body = Record<string, unknown>;

function world(options: { goal?: string | null; agent?: { agentId: string; name: string; version: number | "draft" } | null; orgRoles?: Record<string, "owner" | "admin" | "member"> } = {}) {
  const w = sessionWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const agentDeps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", now: () => w.clock.now, confirmOrigin: CELL, signInStore: w.signInStore, log: () => undefined,
  } as unknown as ApprovalDependencies;
  const deps = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, approvals: agentDeps,
    taskView: async () => ({ status: "RUNNING" }) as never,
  };
  const made = w.seedSession({ ended: true });
  const sid = made.sessionId;
  const agent = options.agent === undefined ? { agentId: "rovara-code", name: "Rovara Code", version: 1 } : options.agent;
  if (agent !== null) w.db.set({ ...w.db.get(agentSessionKey(ORG_A, sid, "META"))!, agent });
  const goal = options.goal === undefined ? GOAL : options.goal;
  w.db.set({ ...w.db.get(taskKey(made.taskId))!, ...(goal === null ? {} : { requestText: goal }), workspaceId: "workspace-secret-id", planContent: "PLAN: the secret migration plan" });
  const agentCaller = (who: string, orgId: OrgId = ORG_A) => ({ orgId, developerId: who, orgRole: who === OLA ? ("admin" as const) : ("member" as const) });
  const request = (method: string, path: string, body?: unknown) => ({ method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const session = (who: string, method: string, path: string, body?: unknown, orgId: OrgId = ORG_A) =>
    routeAgentSessionRequest(deps as never, { ...w.caller(who, orgId), ...(who === OLA ? { orgRole: "admin" as const } : {}) }, request(method, path, body), new URL(`${CELL}${path}`)) as Promise<Record<string, unknown>>;
  const make = (who: string, body: Body = {}, id: string = sid, orgId: OrgId = ORG_A) => session(who, "POST", `/v1/app/sessions/${id}/agent`, { requestId: randomUUID(), ...body }, orgId);
  const agents = (who: string, method: string, path: string, body?: unknown) =>
    routeAgentRequest(agentDeps as never, agentCaller(who), request(method, path, body), new URL(`${CELL}${path}`)) as Promise<Record<string, unknown>>;
  const draftOf = async (who: string, agentId: string) => (await agents(who, "GET", `/v1/app/agents/${agentId}/draft`)).draft as Record<string, unknown>;
  const everything = () => JSON.stringify(w.db.find(() => true));
  const agentItems = () => w.db.find((item) => item.entityType === "AGENT" || item.entityType === "AGENT_DRAFT");
  return { w, store, agentDeps, deps, made, sid, make, session, agents, draftOf, everything, agentItems, agentCaller };
}

const originOf = (draft: Record<string, unknown>) => draft["origin"] as Record<string, unknown> | undefined;

describe("the contract", () => {
  it("names the make_agent capability and the body, strictly", () => {
    expect(SESSION_ACTIONS).toContain("make_agent");
    const body = { requestId: randomUUID(), name: "Stripe bumper" };
    expect(SessionMakeAgentBodySchema.parse(body)).toEqual(body);
    expect(SessionMakeAgentBodySchema.parse({ requestId: body.requestId })).toEqual({ requestId: body.requestId });
    for (const bad of [{ ...body, origin: {} }, { ...body, project: "web" }, { name: "x" }, { ...body, requestId: "nope" }]) expect(SessionMakeAgentBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("reads an origin strictly, and a view as visible (with its session) or hidden (with nothing else)", () => {
    const origin = { kind: "session", sessionId: "ses_00000000000000000001", taskId: randomUUID(), createdBy: PRIYA, createdAt: "2026-10-22T09:00:00.000Z" };
    expect(AgentOriginSchema.parse(origin)).toEqual(origin);
    expect(AgentOriginSchema.parse({ ...origin, taskId: undefined })).toEqual({ ...origin, taskId: undefined });
    for (const bad of [{ ...origin, extra: 1 }, { ...origin, kind: "chain" }, { ...origin, sessionId: "agt_00000000000000000001" }, { ...origin, createdBy: "x" }, { kind: "session", visible: false }]) {
      expect(AgentOriginSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const visible = { ...origin, visible: true, title: "Bump the Stripe SDK", link: `${CELL}/s/ses_00000000000000000001` };
    expect(AgentOriginViewSchema.parse(visible)).toEqual(visible);
    expect(AgentOriginViewSchema.parse({ kind: "session", visible: false })).toEqual({ kind: "session", visible: false });
    for (const bad of [{ kind: "session", visible: false, sessionId: origin.sessionId }, { kind: "session", visible: false, title: "x" }, { ...visible, visible: false }, { kind: "session" }]) {
      expect(AgentOriginViewSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("making an agent from a session", () => {
  it("creates the agent and its draft in the session's project, with the session's agent as its base, the redacted goal as its instructions, and the origin", async () => {
    const t = world();
    const reply = await t.make(MAX, { name: "Stripe bumper" });
    const agent = reply["agent"] as Record<string, unknown>;
    expect(agent).toMatchObject({ name: "Stripe bumper", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, builtin: false, draftRevision: 1 });
    const draft = reply["draft"] as Record<string, unknown>;
    expect(draft).toMatchObject({ extends: { agentId: "rovara-code" }, revision: 1, overlay: { instructions: GOAL } });
    expect(originOf(draft)).toEqual({ kind: "session", visible: true, sessionId: t.sid, taskId: t.made.taskId, createdBy: MAX, createdAt: new Date(T0).toISOString(), title: "Bump the Stripe SDK", link: `${CELL}/s/${t.sid}` });
    // As stored: the origin without the view's words, on the draft, written in the transaction that makes the agent.
    const stored = await t.store.getDraft(ORG_A, agent["agentId"] as AgentId);
    expect(stored?.origin).toEqual({ kind: "session", sessionId: t.sid, taskId: t.made.taskId, createdBy: MAX, createdAt: new Date(T0).toISOString() });
    const writes = t.w.db.transactions().at(-1)!.flatMap((entry) => ((entry["Put"] as { Item?: Record<string, unknown> } | undefined)?.Item === undefined ? [] : [(entry["Put"] as { Item: Record<string, unknown> }).Item]));
    expect(writes.find((item) => item["entityType"] === "AGENT_DRAFT")?.["origin"]).toMatchObject({ sessionId: t.sid });
    expect(writes.find((item) => item["entityType"] === "AGENT")).toBeDefined();
    // The agent as the agent routes show it.
    expect((await t.agents(MAX, "GET", `/v1/app/agents/${String(agent["agentId"])}`))["agent"]).toMatchObject({ name: "Stripe bumper" });
  });

  it("names the agent after the session's title when no name is given, and refuses a name that is taken", async () => {
    const t = world();
    const first = (await t.make(MAX))["agent"] as Record<string, unknown>;
    expect(first["name"]).toBe("Bump the Stripe SDK");
    expect(await code(t.make(MAX))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(t.make(MAX, { name: "x".repeat(61) }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("takes only the redacted goal, the agent kind and the project: no secret and nothing of the workspace", async () => {
    const t = world({ goal: `Rotate ${TOKEN} and then <@U0PRIYA01> redeploy​ ${TOKEN.slice(0, 8)}⁠${TOKEN.slice(8)}` });
    const reply = await t.make(MAX, { name: "Rotator" });
    const instructions = ((reply["draft"] as { overlay: { instructions: string } }).overlay).instructions;
    expect(instructions).toContain("[REDACTED]");
    expect(instructions).not.toContain(TOKEN.slice(0, 8));
    expect(instructions).not.toMatch(/<[@!#]/u);
    const stored = JSON.stringify(t.agentItems());
    expect(stored).not.toContain(TOKEN.slice(0, 8));
    expect(stored).not.toMatch(/workspace-secret-id|secret migration plan/u);
    expect(JSON.stringify(reply)).not.toMatch(/workspace-secret-id|secret migration plan/u);
  });

  it("cuts a long goal to what instructions may hold, after redaction", async () => {
    const t = world({ goal: `${"é".repeat(5000)} ${TOKEN}` });
    const instructions = ((await t.make(MAX, { name: "Long" }))["draft"] as { overlay: { instructions: string } }).overlay.instructions;
    expect(new TextEncoder().encode(instructions).length).toBeLessThanOrEqual(8192);
    expect(instructions).not.toContain(TOKEN);
  });

  it("falls back to the session's title when the task kept no request text, and to no instructions when that is empty too", async () => {
    const t = world({ goal: null });
    expect(((await t.make(MAX, { name: "Titled" }))["draft"] as { overlay: { instructions?: string } }).overlay.instructions).toBe("Bump the Stripe SDK");
  });

  it("builds on the session's agent only when the person may use it: a custom agent they can't see, or one with no published version, leaves the draft built from nothing", async () => {
    const hidden = world({ agent: { agentId: "agt_00000000000000000009", name: "Somebody's agent", version: 1 } });
    expect(((await hidden.make(MAX, { name: "From nothing" }))["draft"] as Record<string, unknown>)["extends"]).toBeUndefined();
    const none = world({ agent: null });
    const draft = (await none.make(MAX, { name: "No agent" }))["draft"] as Record<string, unknown>;
    expect(draft["extends"]).toBeUndefined();
    expect(originOf(draft)).toMatchObject({ visible: true });
  });

  it("answers a repeat of the same request with the same agent and writes nothing more; the same id for another request is a mistake", async () => {
    const t = world();
    const requestId = randomUUID();
    const first = await t.make(MAX, { requestId, name: "Once" });
    const writes = t.w.db.transactions().length;
    const again = await t.make(MAX, { requestId, name: "Once" });
    expect((again["agent"] as Record<string, unknown>)["agentId"]).toBe((first["agent"] as Record<string, unknown>)["agentId"]);
    expect(t.w.db.transactions().length).toBe(writes);
    expect(originOf(again["draft"] as Record<string, unknown>)).toMatchObject({ visible: true, sessionId: t.sid });
    expect(await code(t.make(MAX, { requestId, name: "Twice" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("takes no origin, project, owner or session from the body", async () => {
    const t = world();
    for (const extra of [{ origin: { kind: "session", sessionId: t.sid } }, { project: "ops" }, { owner: { kind: "member", developerId: MAX } }, { sessionId: t.sid }]) {
      expect(await code(t.make(MAX, { name: "X", ...extra })), JSON.stringify(extra)).toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.agentItems()).toHaveLength(0);
  });
});

describe("who may make an agent from a session", () => {
  it("needs the right to create agents in the project: a maintainer or an org admin may; the owner of the session as a contributor, a viewer of the session and a project viewer may not", async () => {
    const t = world();
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: ARJUN }, "view");
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: MIA }, "view");
    for (const who of [PRIYA, ARJUN, MIA]) {
      expect(await code(t.make(who, { name: `By ${who.slice(0, 2)}` })), who).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(t.agentItems()).toHaveLength(0);
    expect((await t.make(MAX, { name: "By Max" }))["agent"]).toMatchObject({ owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    // An org owner or admin is a maintainer of every project, as for any agent.
    expect((await t.make(OLA, { name: "By Ola" }))["agent"]).toMatchObject({ accountable: { developerId: OLA } });
  });

  it("needs view on the session first: no level, another org and a session that is not there are the same NOT_FOUND, and nothing is written", async () => {
    const t = world();
    expect(await code(t.make(ZED, { name: "Z" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.make("9".repeat(64), { name: "B" }, t.sid, ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.make(MAX, { name: "G" }, "ses_00000000000099999999"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(t.make(MAX, { name: "G" }, "nonsense"))).toMatchObject({ code: "NOT_FOUND" });
    const hidden = world({});
    hidden.w.db.set({ pk: `DEVTASK#${hidden.made.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: MAX, slackUserId: "U0PERSON00", name: "Max", role: "denied" }] });
    expect(await code(hidden.make(MAX, { name: "D" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(t.agentItems()).toHaveLength(0);
    expect(hidden.agentItems()).toHaveLength(0);
  });

  it("reads both rights live: a maintainer whose grant is gone, or whose view of the session is gone, is refused at once", async () => {
    const t = world();
    t.w.members.revoke(ORG_A, "web", MAX);
    expect(await code(t.make(MAX, { name: "Late" }))).toMatchObject({ code: "FORBIDDEN" });
    t.w.members.grant(ORG_A, "web", MAX, "maintainer");
    expect((await t.make(MAX, { name: "Back" }))["agent"]).toBeDefined();
  });

  it("refuses a session that is not a task in a project: a chain, a Mac, or a task with no project", async () => {
    const t = world();
    for (const kind of ["chain", "local"] as const) {
      const other = t.w.seedSession({ kind, owner: MAX });
      expect(await code(t.make(MAX, { name: kind }, other.sessionId)), kind).toMatchObject({ code: "CONFIG_INVALID" });
    }
    const loose = t.w.seedSession({ project: null, owner: MAX });
    expect(await code(t.make(MAX, { name: "loose" }, loose.sessionId))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.agentItems()).toHaveLength(0);
  });

  it("takes the org role from the member record, never from the caller: a caller that says admin, whose record says member, may not", async () => {
    const t = world();
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: ZED }, "view");
    const liar = { ...t.w.caller(ZED), orgRole: "admin" as const };
    expect(await code(routeAgentSessionRequest(t.deps as never, liar, { method: "POST", path: `/v1/app/sessions/${t.sid}/agent`, headers: {}, requestId: "r", body: JSON.stringify({ requestId: randomUUID(), name: "Liar" }) }, new URL(`${CELL}/v1/app/sessions/${t.sid}/agent`)))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers only POST on the route", async () => {
    const t = world();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) expect(await code(t.session(MAX, method, `/v1/app/sessions/${t.sid}/agent`)), method).toMatchObject({ code: "NOT_FOUND" });
  });

  it("without the agent routes wired, says so and writes nothing", async () => {
    const t = world();
    const bare = { ...t.deps } as Record<string, unknown>;
    delete bare["approvals"];
    expect(await code(routeAgentSessionRequest(bare as never, t.w.caller(MAX), { method: "POST", path: `/v1/app/sessions/${t.sid}/agent`, headers: {}, requestId: "r", body: JSON.stringify({ requestId: randomUUID() }) }, new URL(`${CELL}/v1/app/sessions/${t.sid}/agent`)))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the origin is set once, here, and never changes", () => {
  it("is set by no other route: a plain create, and a create or draft save that names one, have none", async () => {
    const t = world();
    const plain = (await t.agents(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Plain", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } }))["agent"] as { agentId: string };
    expect(await t.draftOf(MAX, plain.agentId)).not.toHaveProperty("origin");
    const sneaky = { kind: "session", sessionId: t.sid, createdBy: MAX, createdAt: new Date(T0).toISOString() };
    expect(await code(t.agents(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Sneaky", origin: sneaky }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(t.agents(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Sneaky", fromSession: t.sid }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(t.agents(MAX, "PUT", `/v1/app/agents/${plain.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "x" }, origin: sneaky }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await t.draftOf(MAX, plain.agentId)).not.toHaveProperty("origin");
  });

  it("survives every change of the draft: a save, a move of the base, and a replay of either; a save cannot clear it", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Keeper" }))["agent"] as { agentId: string };
    const saved = (await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "Something else entirely." } }))["draft"] as Record<string, unknown>;
    expect(saved).toMatchObject({ revision: 2, overlay: { instructions: "Something else entirely." } });
    expect(originOf(saved)).toMatchObject({ visible: true, sessionId: t.sid, createdBy: MAX });
    expect((await t.store.getDraft(ORG_A, made.agentId as AgentId))?.origin).toEqual({ kind: "session", sessionId: t.sid, taskId: t.made.taskId, createdBy: MAX, createdAt: new Date(T0).toISOString() });
    const cleared = (await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 2, overlay: {}, extends: null }))["draft"] as Record<string, unknown>;
    expect(originOf(cleared)).toMatchObject({ visible: true });
    expect((await t.store.getDraft(ORG_A, made.agentId as AgentId))?.origin?.sessionId).toBe(t.sid);
  });

  it("is copied unchanged into each version published from the draft, and shown with the version", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Versioned" }))["agent"] as { agentId: string };
    const stored = (await t.store.getDraft(ORG_A, made.agentId as AgentId))!.origin!;
    const published = await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 1 });
    expect((published["version"] as Record<string, unknown>)["version"], JSON.stringify(published)).toBe(1);
    expect((await t.store.getVersion(ORG_A, made.agentId as AgentId, 1))?.origin).toEqual(stored);
    expect(originOf(published["version"] as Record<string, unknown>)).toMatchObject({ visible: true, sessionId: t.sid });
    // A later version made from an edited draft carries the same origin; the first stays as it was.
    await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "Second take." } });
    await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 2 });
    expect((await t.store.getVersion(ORG_A, made.agentId as AgentId, 2))?.origin).toEqual(stored);
    expect((await t.store.getVersion(ORG_A, made.agentId as AgentId, 1))?.origin).toEqual(stored);
    const one = (await t.agents(MAX, "GET", `/v1/app/agents/${made.agentId}/versions/1`))["version"] as Record<string, unknown>;
    expect(originOf(one)).toMatchObject({ visible: true, sessionId: t.sid, title: "Bump the Stripe SDK" });
    const listed = (await t.agents(MAX, "GET", `/v1/app/agents/${made.agentId}/versions`))["versions"] as Array<Record<string, unknown>>;
    expect(listed.map((entry) => originOf(entry)?.["sessionId"])).toEqual([t.sid, t.sid]);
  });
});

describe("who sees the origin", () => {
  const made = async (t: ReturnType<typeof world>) => {
    const agent = (await t.make(MAX, { name: "Seen" }))["agent"] as { agentId: string };
    await t.agents(MAX, "POST", `/v1/app/agents/${agent.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 1 });
    return agent.agentId;
  };
  const hidden = { kind: "session", visible: false };

  it("shows the session, its title and its link to a person who may read the session now, and nothing but `visible: false` to anyone else", async () => {
    const t = world();
    const id = await made(t);
    // Max can edit the agent but loses his view of the session (the task's people list denies him): the origin goes dark for him alone.
    t.w.db.set({ pk: `DEVTASK#${t.made.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: MAX, slackUserId: "U0PERSON00", name: "Max", role: "denied" }] });
    const draft = await t.draftOf(MAX, id);
    expect(originOf(draft)).toEqual(hidden);
    const version = (await t.agents(MAX, "GET", `/v1/app/agents/${id}/versions/1`))["version"] as Record<string, unknown>;
    expect(originOf(version)).toEqual(hidden);
    const listed = (await t.agents(MAX, "GET", `/v1/app/agents/${id}/versions`))["versions"] as Array<Record<string, unknown>>;
    expect(listed.map((entry) => entry["origin"])).toEqual([hidden]);
    // No id, no title, no person, no time anywhere in what he was sent.
    const sent = JSON.stringify([draft, version, listed]);
    expect(sent).not.toContain(t.sid);
    expect(sent).not.toContain("Bump the Stripe SDK");
    expect(sent).not.toContain(t.made.taskId);
    expect(sent).not.toContain(`/s/`);
    // Ola, an org admin, may read the session (view) and so sees it.
    expect(originOf(await t.draftOf(OLA, id))).toMatchObject({ visible: true, sessionId: t.sid });
  });

  it("is hidden once the session is deleted, and once it is past its retention, though its record is still there", async () => {
    const t = world();
    const id = await made(t);
    expect(originOf(await t.draftOf(MAX, id))).toMatchObject({ visible: true });
    const meta = agentSessionKey(ORG_A, t.sid, "META");
    const record = t.w.db.get(meta)!;
    // Ended just inside the retention: still visible. Ended just outside it: hidden.
    const day = 24 * 60 * 60 * 1000;
    t.w.db.set({ ...record, endedAt: new Date(T0 - (SESSION_RETENTION_DAYS - 1) * day).toISOString() });
    expect(originOf(await t.draftOf(MAX, id))).toMatchObject({ visible: true });
    t.w.db.set({ ...record, endedAt: new Date(T0 - (SESSION_RETENTION_DAYS + 1) * day).toISOString() });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
    t.w.db.set(record);
    expect(originOf(await t.draftOf(MAX, id))).toMatchObject({ visible: true });
    t.w.db.delete(meta);
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
    expect(originOf((await t.agents(MAX, "GET", `/v1/app/agents/${id}/versions/1`))["version"] as Record<string, unknown>)).toEqual(hidden);
    // The agent itself is untouched: it still runs and is still found.
    expect((await t.agents(MAX, "GET", `/v1/app/agents/${id}`))["agent"]).toMatchObject({ name: "Seen" });
  });

  it("reads the session's access live on every read, and a stored origin that does not parse is hidden, never shown", async () => {
    const t = world();
    const id = await made(t);
    expect(originOf(await t.draftOf(MAX, id))).toMatchObject({ visible: true });
    t.w.db.set({ pk: `DEVTASK#${t.made.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: MAX, slackUserId: "U0PERSON00", name: "Max", role: "denied" }] });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
    t.w.db.delete({ pk: `DEVTASK#${t.made.taskId}`, sk: "PEOPLE" });
    expect(originOf(await t.draftOf(MAX, id))).toMatchObject({ visible: true });
    const draftItem = t.w.db.get(agentKey(ORG_A, id as AgentId, "DRAFT"))!;
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: "not-a-session", createdBy: MAX, createdAt: "x" } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: t.sid, createdBy: MAX, createdAt: new Date(T0).toISOString(), extra: "field" } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
  });

  it("reads the session of the agent's own org only: an origin naming a session of another org is hidden", async () => {
    const t = world();
    const id = await made(t);
    const other = t.w.seedSession({ orgId: ORG_B, owner: "9".repeat(64), project: "web" });
    const draftItem = t.w.db.get(agentKey(ORG_A, id as AgentId, "DRAFT"))!;
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: other.sessionId, createdBy: MAX, createdAt: new Date(T0).toISOString() } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
  });

  it("leaves drafts and versions made before there was an origin exactly as they were", async () => {
    const t = world();
    const plain = (await t.agents(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Old", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } }))["agent"] as { agentId: string };
    await t.agents(MAX, "POST", `/v1/app/agents/${plain.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 1 });
    const draft = await t.draftOf(MAX, plain.agentId);
    expect(draft).not.toHaveProperty("origin");
    const version = (await t.agents(MAX, "GET", `/v1/app/agents/${plain.agentId}/versions/1`))["version"] as Record<string, unknown>;
    expect(version).not.toHaveProperty("origin");
    const listed = (await t.agents(MAX, "GET", `/v1/app/agents/${plain.agentId}/versions`))["versions"] as Array<Record<string, unknown>>;
    expect(listed[0]).not.toHaveProperty("origin");
    // A draft saved from one still has none.
    const saved = (await t.agents(MAX, "PUT", `/v1/app/agents/${plain.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "More." } }))["draft"] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("origin");
    expect(await t.store.getDraft(ORG_A, plain.agentId as AgentId)).not.toHaveProperty("origin");
  });
});

describe("the make_agent capability in the session view", () => {
  const actions = async (t: ReturnType<typeof world>, who: string, sid: string = t.sid) => SessionResponseSchema.parse(await t.session(who, "GET", `/v1/app/sessions/${sid}`)).session.you.actions;

  it("is there for a person who may create agents in the session's project, and for no one else", async () => {
    const t = world();
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: ARJUN }, "edit");
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: MIA }, "view");
    expect(await actions(t, MAX)).toContain("make_agent");
    expect(await actions(t, OLA)).toContain("make_agent");
    // The owner as a contributor, a person with an edit share, a project viewer.
    for (const who of [PRIYA, ARJUN, MIA]) expect(await actions(t, who), who).not.toContain("make_agent");
    // The rest of the list is as it was.
    expect(await actions(t, MIA)).toEqual(["watch"]);
  });

  it("is worked out by the check the route makes, read live: gone with the grant, back with it", async () => {
    const t = world();
    expect(await actions(t, MAX)).toContain("make_agent");
    t.w.members.revoke(ORG_A, "web", MAX);
    t.w.db.delete(projectMemberKey(ORG_A, MAX, "web"));
    expect(await actions(t, MAX)).not.toContain("make_agent");
    expect(await code(t.make(MAX, { name: "No" }))).toMatchObject({ code: "FORBIDDEN" });
    t.w.members.grant(ORG_A, "web", MAX, "maintainer");
    expect(await actions(t, MAX)).toContain("make_agent");
    expect((await t.make(MAX, { name: "Yes" }))["agent"]).toBeDefined();
  });

  it("is never inferred from an org role the record does not hold, and is absent for a session with no project, a chain, a Mac, or without the agent routes wired", async () => {
    const t = world();
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: ZED }, "view");
    const liar = { ...t.w.caller(ZED), orgRole: "admin" as const };
    const view = SessionResponseSchema.parse(await routeAgentSessionRequest(t.deps as never, liar, { method: "GET", path: `/v1/app/sessions/${t.sid}`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/sessions/${t.sid}`)));
    expect(view.session.you.actions).not.toContain("make_agent");
    for (const kind of ["chain", "local"] as const) {
      const other = t.w.seedSession({ kind, owner: MAX });
      expect(await actions(t, MAX, other.sessionId), kind).not.toContain("make_agent");
    }
    const loose = t.w.seedSession({ project: null, owner: MAX });
    expect(await actions(t, MAX, loose.sessionId)).not.toContain("make_agent");
    const bare = { ...t.deps } as Record<string, unknown>;
    delete bare["approvals"];
    const unwired = SessionResponseSchema.parse(await routeAgentSessionRequest(bare as never, t.w.caller(MAX), { method: "GET", path: `/v1/app/sessions/${t.sid}`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/sessions/${t.sid}`)));
    expect(unwired.session.you.actions).not.toContain("make_agent");
  });
});
