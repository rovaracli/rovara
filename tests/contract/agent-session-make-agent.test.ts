// Plan 5 Task 10c: an agent remembers the task it was made from. `POST /v1/app/sessions/{id}/agent` makes an agent (with its draft) from a session; it needs `view` on the session AND the right to
// create agents in the session's project, both read live. The draft carries an immutable `origin` (set only here, copied unchanged into every version published from the draft), the agent kind
// (the agent the session ran, as the new agent's base), the project (its owner) and the redacted goal text (its instructions): never a secret or the workspace. Whoever may read the session now
// sees the origin with its title and link; everyone else, and everyone once the session is deleted or past retention, sees `{ kind: "session", visible: false }`. The session view says whether the
// caller may do this (`you.actions` holds `make_agent`), worked out by the same check as the route. Drafts and versions made before this still parse.
import { randomUUID } from "node:crypto";
import { fixtureActor } from "../support/money-authority.js";
import type { AgentRouteDependencies } from "../../packages/broker/src/agents/routes.js";
import { describe, expect, it } from "vitest";
import {
  AgentOriginSchema,
  DEFAULT_AGENT_GUARDRAILS,
  agentGuardrailsKey,
  AgentOriginViewSchema,
  SESSION_ACTIONS,
  SESSION_RETENTION_DAYS,
  SessionMakeAgentBodySchema,
  agentSessionKey,
  agentKey,
  agentRequestKey,
  projectMemberKey,
  type AgentId,
  type OrgId,
} from "../../packages/contracts/src/index.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const GOAL = "Move payments to the v15 client and fix what breaks in the checkout tests.";
type Body = Record<string, unknown>;

function world(options: { goal?: string | null; agent?: { agentId: string; name: string; version: number | "draft" } | null; orgRoles?: Record<string, "owner" | "admin" | "member"> } = {}) {
  const w = sessionWorld();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const agentDeps = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", now: () => w.clock.now, confirmOrigin: CELL, signInStore: w.signInStore, log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); },
  } as unknown as ApprovalDependencies & AgentRouteDependencies;
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
  /** What a route answers: the body (of a 201 as of a 200). */
  const bodyOf = (answer: unknown) => (answer instanceof StatusReply ? answer.body : answer) as Record<string, unknown>;
  const session = async (who: string, method: string, path: string, body?: unknown, orgId: OrgId = ORG_A) =>
    bodyOf(await routeAgentSessionRequest(deps, { ...w.caller(who, orgId), ...(who === OLA ? { orgRole: "admin" as const } : {}) }, request(method, path, body), new URL(`${CELL}${path}`)));
  const make = (who: string, body: Body = {}, id: string = sid, orgId: OrgId = ORG_A) => session(who, "POST", `/v1/app/sessions/${id}/agent`, { requestId: randomUUID(), ...body }, orgId);
  const agents = async (who: string, method: string, path: string, body?: unknown) =>
    bodyOf(await routeAgentRequest(agentDeps, agentCaller(who), request(method, path, body), new URL(`${CELL}${path}`)));
  const draftOf = async (who: string, agentId: string) => (await agents(who, "GET", `/v1/app/agents/${agentId}/draft`)).draft as Record<string, unknown>;
  const everything = () => JSON.stringify(w.db.find(() => true));
  const agentItems = () => w.db.find((item) => item.entityType === "AGENT" || item.entityType === "AGENT_DRAFT");
  return { w, logs, store, agentDeps, deps, made, sid, make, session, agents, draftOf, everything, agentItems, agentCaller };
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

describe("saying whether the session's agent was copied (Step 0 ruling)", () => {
  const copiedOf = (reply: Record<string, unknown>) => ({ copied: reply["copied"], reason: reply["reason"] });
  const keys = (reply: Record<string, unknown>) => Object.keys(reply).sort();

  it("answers copied true, and no reason, when the session's agent became the base", async () => {
    const t = world();
    const reply = await t.make(MAX, { name: "Copied" });
    expect(copiedOf(reply)).toEqual({ copied: true, reason: undefined });
    expect(keys(reply)).toEqual(["agent", "copied", "draft"]);
    expect((reply["draft"] as { extends?: { agentId: string } }).extends?.agentId).toBe("rovara-code");
  });

  it("answers copied false with the fixed reason AGENT_NOT_USABLE when the caller can't use the session's agent, and builds the empty draft as before", async () => {
    const t = world({ agent: { agentId: "agt_00000000000000000009", name: "Somebody's secret agent", version: 1 } });
    const reply = await t.make(MAX, { name: "From nothing" });
    expect(copiedOf(reply)).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    expect((reply["draft"] as Record<string, unknown>)["extends"]).toBeUndefined();
    // The reason is a code: nothing of the agent the person can't use (its id or its name) is in the answer.
    expect(JSON.stringify(reply)).not.toMatch(/agt_00000000000000000009|Somebody's secret agent/u);
  });

  it("says the same for a custom agent that is not published, not shared with the caller, or archived, and says copied true once it is usable", async () => {
    const t = world();
    const custom = await t.store.create({ orgId: ORG_A, name: "Priya's agent", owner: { kind: "member", developerId: PRIYA }, createdBy: PRIYA, overlay: { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] } });
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, agent: { agentId: custom.agentId, name: custom.name, version: 1 } });
    const state = async (name: string) => copiedOf(await t.make(MAX, { name }));
    expect(await state("A1")).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    await t.store.publish({ orgId: ORG_A, agentId: custom.agentId, expectedDraftRevision: 1, digest: "a".repeat(64), by: PRIYA });
    expect(await state("A2")).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    await t.agents(PRIYA, "PUT", `/v1/app/agents/${custom.agentId}/shares`, { requestId: randomUUID(), shares: [{ principal: { kind: "member", developerId: MAX }, level: "use" }] });
    expect(await state("A3")).toEqual({ copied: true, reason: undefined });
    fixtureActor(t.w.db, ORG_A, PRIYA); // archiving holds the person to their company access in its own transaction
    await t.agents(PRIYA, "POST", `/v1/app/agents/${custom.agentId}/archive`, { requestId: randomUUID() });
    expect(await state("A4")).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
  });

  it("says copied false for an agent that is shared with the caller but has no published version yet", async () => {
    const t = world();
    const draftOnly = await t.store.create({ orgId: ORG_A, name: "Unpublished", owner: { kind: "member", developerId: PRIYA }, createdBy: PRIYA });
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, agent: { agentId: draftOnly.agentId, name: draftOnly.name, version: 1 } });
    await t.agents(PRIYA, "PUT", `/v1/app/agents/${draftOnly.agentId}/shares`, { requestId: randomUUID(), shares: [{ principal: { kind: "member", developerId: MAX }, level: "use" }] });
    expect(copiedOf(await t.make(MAX, { name: "Not yet" }))).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
  });

  it("says copied false for a built-in agent the company's admins turned off", async () => {
    const t = world();
    t.w.db.set({ ...agentGuardrailsKey(ORG_A), entityType: "AGENT_GUARDRAILS", orgId: ORG_A, revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, disabledBuiltins: ["rovara-code"] } });
    const reply = await t.make(MAX, { name: "Disabled base" });
    expect(copiedOf(reply)).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    expect((reply["draft"] as Record<string, unknown>)["extends"]).toBeUndefined();
  });

  it("answers a session that ran no agent as copied true (there was nothing it could not give)", async () => {
    const t = world({ agent: null });
    expect(copiedOf(await t.make(MAX, { name: "No agent" }))).toEqual({ copied: true, reason: undefined });
  });

  it("answers a repeat of the same request with the same copied and reason, and writes nothing", async () => {
    const hidden = world({ agent: { agentId: "agt_00000000000000000009", name: "Somebody's agent", version: 1 } });
    const body = { requestId: randomUUID(), name: "Twice" };
    const first = await hidden.make(MAX, body);
    const before = hidden.w.db.transactions().length;
    const again = await hidden.make(MAX, body);
    expect(copiedOf(first)).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    expect(copiedOf(again)).toEqual(copiedOf(first));
    expect(hidden.w.db.transactions().length).toBe(before);
    const usable = world();
    const usableBody = { requestId: randomUUID(), name: "Twice" };
    await usable.make(MAX, usableBody);
    expect(copiedOf(await usable.make(MAX, usableBody))).toEqual({ copied: true, reason: undefined });
  });
});

describe("a replay answers the original copied and reason (coordinator ruling on 11b question 2)", () => {
  const copiedOf = (reply: Record<string, unknown>) => ({ copied: reply["copied"], reason: reply["reason"] });
  const sessionMeta = (t: ReturnType<typeof world>) => agentSessionKey(ORG_A, t.sid, "META");
  const OTHER_AGENT = { agentId: "agt_00000000000000000009", name: "Somebody's agent", version: 1 };

  it("keeps copied true after the session's agent changes to one the person can't use", async () => {
    const t = world();
    const body = { requestId: randomUUID(), name: "Kept true" };
    expect(copiedOf(await t.make(MAX, body))).toEqual({ copied: true, reason: undefined });
    t.w.db.set({ ...t.w.db.get(sessionMeta(t))!, agent: OTHER_AGENT });
    expect(copiedOf(await t.make(MAX, body))).toEqual({ copied: true, reason: undefined });
  });

  it("keeps copied false, with its reason, after the session's agent goes", async () => {
    const t = world({ agent: OTHER_AGENT });
    const body = { requestId: randomUUID(), name: "Kept false" };
    expect(copiedOf(await t.make(MAX, body))).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
    const { agent: _gone, ...withoutAgent } = t.w.db.get(sessionMeta(t))! as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars
    t.w.db.set(withoutAgent);
    expect(copiedOf(await t.make(MAX, body))).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
  });

  it("stores the report with the request item, never the agent's id or name", async () => {
    const t = world({ agent: OTHER_AGENT });
    const requestId = randomUUID();
    await t.make(MAX, { requestId, name: "Stored" });
    const stored = JSON.stringify(t.w.db.get(agentRequestKey(ORG_A, MAX, requestId)));
    expect(stored).toContain("AGENT_NOT_USABLE");
    expect(stored).not.toContain("Somebody's agent");
    expect(stored).not.toContain(OTHER_AGENT.agentId);
  });

  it("answers a request stored before this change (its result is the agent alone) as the draft shows it", async () => {
    const t = world();
    const requestId = randomUUID();
    const first = await t.make(MAX, { requestId, name: "Older" });
    const agentId = (first["agent"] as { agentId: string }).agentId;
    const requestKey = agentRequestKey(ORG_A, MAX, requestId);
    t.w.db.set({ ...t.w.db.get(requestKey)!, result: t.w.db.get(agentKey(ORG_A, agentId, "META")) });
    expect(copiedOf(await t.make(MAX, { requestId, name: "Older" }))).toEqual({ copied: true, reason: undefined });
    t.w.db.set({ ...t.w.db.get(sessionMeta(t))!, agent: OTHER_AGENT });
    expect(copiedOf(await t.make(MAX, { requestId, name: "Older" }))).toEqual({ copied: false, reason: "AGENT_NOT_USABLE" });
  });
});

describe("review minors on making an agent", () => {
  const day = 24 * 60 * 60 * 1000;

  it("refuses with NOT_FOUND a session past its retention, as the origin view hides it, though its record is still there; just inside the retention it is still made", async () => {
    const t = world();
    const meta = agentSessionKey(ORG_A, t.sid, "META");
    const record = t.w.db.get(meta)!;
    t.w.db.set({ ...record, endedAt: new Date(T0 - (SESSION_RETENTION_DAYS + 1) * day).toISOString() });
    const before = t.agentItems().length;
    expect(await code(t.make(MAX, { name: "Too late" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(t.agentItems().length).toBe(before);
    // A repeat of an earlier request is refused too: a session past retention is not a source.
    t.w.db.set({ ...record, endedAt: new Date(T0 - (SESSION_RETENTION_DAYS - 1) * day).toISOString() });
    const body = { requestId: randomUUID(), name: "Just in time" };
    expect((await t.make(MAX, body))["agent"]).toMatchObject({ name: "Just in time" });
    t.w.db.set({ ...record, endedAt: new Date(T0 - (SESSION_RETENTION_DAYS + 1) * day).toISOString() });
    expect(await code(t.make(MAX, body))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("cuts off at exactly the retention: a session that ended that long ago to the millisecond is still a source, one millisecond later it is not", async () => {
    const t = world();
    const meta = agentSessionKey(ORG_A, t.sid, "META");
    const record = t.w.db.get(meta)!;
    t.w.db.set({ ...record, endedAt: new Date(T0 - SESSION_RETENTION_DAYS * day).toISOString() });
    expect((await t.make(MAX, { name: "On the line" }))["agent"]).toMatchObject({ name: "On the line" });
    t.w.db.set({ ...record, endedAt: new Date(T0 - SESSION_RETENTION_DAYS * day - 1).toISOString() });
    expect(await code(t.make(MAX, { name: "A millisecond late" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("trims the default name", async () => {
    const t = world();
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, title: "  Padded title  " });
    expect(((await t.make(MAX))["agent"] as { name: string }).name).toBe("Padded title");
  });

  it("makes the default name from the title through the same clean-and-redact path as the goal: no secret and no mention", async () => {
    const t = world();
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, title: `Rotate ${TOKEN} <@U0PRIYA01> now` });
    const name = ((await t.make(MAX))["agent"] as { name: string }).name;
    expect(name).toContain("[REDACTED]");
    expect(name).not.toContain(TOKEN.slice(0, 8));
    expect(name).not.toMatch(/<[@!#]/u);
    expect(name).toMatch(/^Rotate \[REDACTED\]/u);
    expect(JSON.stringify(t.agentItems())).not.toContain(TOKEN.slice(0, 8));
  });

  it("falls back to a fixed name when nothing of the title is left after cleaning", async () => {
    const t = world();
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, title: "   " });
    expect(((await t.make(MAX))["agent"] as { name: string }).name).toBe("Agent from a session");
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

  it("cuts a long title to a name that fits, at exactly the limit", async () => {
    const t = world();
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, title: `${"n".repeat(59)}😀${"z".repeat(40)}` });
    const name = ((await t.make(MAX))["agent"] as { name: string }).name;
    // 59 letters and a two-unit emoji would be 61: the emoji is left out whole.
    expect(name).toBe("n".repeat(59));
    const exact = world();
    exact.w.db.set({ ...exact.w.db.get(agentSessionKey(ORG_A, exact.sid, "META"))!, title: "m".repeat(100) });
    expect(((await exact.make(MAX))["agent"] as { name: string }).name).toBe("m".repeat(60));
  });

  it("takes only the redacted goal, the agent kind and the project: no secret and nothing of the workspace", async () => {
    const t = world({ goal: `Rotate ${TOKEN} and then <@U0PRIYA01> redeploy\u200b ${TOKEN.slice(0, 8)}\u2060${TOKEN.slice(8)}` });
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
    // Exactly what instructions may hold: 4,096 two-byte characters.
    expect(new TextEncoder().encode(instructions).length).toBe(8192);
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

  it("builds on a custom session agent the person may use and that is published and active, and on no other", async () => {
    const t = world();
    const custom = await t.store.create({ orgId: ORG_A, name: "Priya's agent", owner: { kind: "member", developerId: PRIYA }, createdBy: PRIYA, overlay: { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] } });
    const session = () => t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, agent: { agentId: custom.agentId, name: custom.name, version: 1 } });
    session();
    const extendsOf = async (name: string) => ((await t.make(MAX, { name }))["draft"] as { extends?: { agentId: string } }).extends?.agentId;
    // Not published yet, then published but not shared with him, then shared, then archived.
    expect(await extendsOf("A1")).toBeUndefined();
    await t.store.publish({ orgId: ORG_A, agentId: custom.agentId, expectedDraftRevision: 1, digest: "a".repeat(64), by: PRIYA });
    expect(await extendsOf("A2")).toBeUndefined();
    await t.agents(PRIYA, "PUT", `/v1/app/agents/${custom.agentId}/shares`, { requestId: randomUUID(), shares: [{ principal: { kind: "member", developerId: MAX }, level: "use" }] });
    expect(await extendsOf("A3")).toBe(custom.agentId);
    fixtureActor(t.w.db, ORG_A, PRIYA); // archiving holds the person to their company access in its own transaction
    await t.agents(PRIYA, "POST", `/v1/app/agents/${custom.agentId}/archive`, { requestId: randomUUID() });
    expect(await extendsOf("A4")).toBeUndefined();
  });

  it("builds on a published agent it may use, but not one that has no published version yet, even when it is shared", async () => {
    const t = world();
    const draftOnly = await t.store.create({ orgId: ORG_A, name: "Unpublished", owner: { kind: "member", developerId: PRIYA }, createdBy: PRIYA });
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, agent: { agentId: draftOnly.agentId, name: draftOnly.name, version: 1 } });
    await t.agents(PRIYA, "PUT", `/v1/app/agents/${draftOnly.agentId}/shares`, { requestId: randomUUID(), shares: [{ principal: { kind: "member", developerId: MAX }, level: "use" }] });
    expect((await t.make(MAX, { name: "Not yet" }))["agent"]).toBeDefined();
    expect(((await t.store.getDraft(ORG_A, (await t.store.list(ORG_A)).find((a) => a.name === "Not yet")!.agentId))?.extends)).toBeUndefined();
  });

  it("uses the task's request only when the task is this org's and has some: otherwise the title, and nothing at all when what is left is empty", async () => {
    const foreign = world();
    foreign.w.db.set({ ...foreign.w.db.get(taskKey(foreign.made.taskId))!, orgId: ORG_B });
    expect(((await foreign.make(MAX, { name: "F" }))["draft"] as { overlay: { instructions?: string } }).overlay.instructions).toBe("Bump the Stripe SDK");
    const blank = world({ goal: "   \n " });
    expect(((await blank.make(MAX, { name: "B" }))["draft"] as { overlay: { instructions?: string } }).overlay.instructions).toBe("Bump the Stripe SDK");
    const invisible = world({ goal: "\u200b\u2060" });
    expect(((await invisible.make(MAX, { name: "I" }))["draft"] as { overlay: Record<string, unknown> }).overlay).toEqual({});
    const ascii = world({ goal: "a".repeat(9000) });
    expect(((await ascii.make(MAX, { name: "A" }))["draft"] as { overlay: { instructions: string } }).overlay.instructions).toHaveLength(8192);
  });

  it("refuses to guess when the right can't be checked: a failing lookup is not a refusal for the route and not a right for the view", async () => {
    const t = world();
    const roleOf = t.w.members.roleOf;
    t.w.members.roleOf = () => Promise.reject(new Error("the members service is down"));
    const failed = await code(t.make(MAX, { name: "Down" }));
    expect(failed).toMatchObject({ code: undefined });
    expect(failed?.message).toBe("the members service is down");
    expect(t.agentItems()).toHaveLength(0);
    expect(await code(t.session(MAX, "GET", `/v1/app/sessions/${t.sid}`))).toBeUndefined();
    expect((await t.session(MAX, "GET", `/v1/app/sessions/${t.sid}`) as { session: { you: { actions: string[] } } }).session.you.actions).not.toContain("make_agent");
    t.w.members.roleOf = roleOf;
    expect((await t.make(MAX, { name: "Up" }))["agent"]).toBeDefined();
  });

  it("refuses an origin the store can't read, whoever passes it", async () => {
    const t = world();
    expect(await code(t.store.create({ orgId: ORG_A, name: "Bad origin", owner: { kind: "member", developerId: PRIYA }, createdBy: PRIYA, origin: { kind: "session", sessionId: "nope", createdBy: PRIYA, createdAt: "x" } as never }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.agentItems()).toHaveLength(0);
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
    expect((await t.store.getDraft(ORG_A, made.agentId))?.origin).toEqual({ kind: "session", sessionId: t.sid, taskId: t.made.taskId, createdBy: MAX, createdAt: new Date(T0).toISOString() });
    const cleared = (await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 2, overlay: {}, extends: null }))["draft"] as Record<string, unknown>;
    expect(originOf(cleared)).toMatchObject({ visible: true });
    expect((await t.store.getDraft(ORG_A, made.agentId))?.origin?.sessionId).toBe(t.sid);
  });

  it("shows the origin, as the caller may read it, on the answer to a moved base and on a replay of a save and of a publish", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Replayed" }))["agent"] as { agentId: string };
    const moved = await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/update-base`, { requestId: randomUUID(), expectedRevision: 1 });
    expect(originOf(moved["draft"] as Record<string, unknown>)).toMatchObject({ visible: true, sessionId: t.sid });
    const save = { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "Again." } };
    const first = await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, save);
    const again = await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, save);
    expect(again).toEqual(first);
    expect(originOf(again["draft"] as Record<string, unknown>)).toMatchObject({ visible: true });
    const publish = { requestId: randomUUID(), expectedRevision: 2 };
    const published = await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, publish);
    const repeated = await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, publish);
    expect(originOf(repeated["version"] as Record<string, unknown>)).toMatchObject({ visible: true, sessionId: t.sid });
    expect(repeated["version"]).toEqual(published["version"]);
  });

  it("hides the origin, and reports only ids and the error's name, when the session can't be read for a reason other than access", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Unreadable" }))["agent"] as { agentId: string };
    t.w.db.set({ ...t.w.db.get(agentSessionKey(ORG_A, t.sid, "META"))!, kind: "not-a-kind" });
    expect(originOf(await t.draftOf(MAX, made.agentId))).toEqual({ kind: "session", visible: false });
    expect(t.logs).toContainEqual({ event: "agent.origin_unreadable", fields: { orgId: ORG_A, sessionId: t.sid, error: "AgentXError" } });
    expect(JSON.stringify(t.logs)).not.toContain("Bump the Stripe SDK");
    // A session that is simply not there is not worth a line.
    t.logs.length = 0;
    t.w.db.delete(agentSessionKey(ORG_A, t.sid, "META"));
    expect(originOf(await t.draftOf(MAX, made.agentId))).toEqual({ kind: "session", visible: false });
    expect(t.logs).toEqual([]);
  });

  it("reads the session once for all the versions made from it", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Many" }))["agent"] as { agentId: string };
    await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 1 });
    for (const revision of [2, 3]) {
      await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: revision - 1, overlay: { instructions: `Take ${String(revision)}.` } });
      await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: revision });
    }
    const meta = agentSessionKey(ORG_A, t.sid, "META");
    const send = t.w.db.send.bind(t.w.db);
    let reads = 0;
    t.w.db.send = ((command: { constructor: { name: string }; input?: { Key?: { pk?: string; sk?: string } } }) => {
      if (command.constructor.name === "GetCommand" && command.input?.Key?.pk === meta.pk && command.input.Key.sk === meta.sk) reads += 1;
      return send(command as never);
    });
    const listed = (await t.agents(MAX, "GET", `/v1/app/agents/${made.agentId}/versions`))["versions"] as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(3);
    expect(listed.every((entry) => originOf(entry)?.["visible"] === true)).toBe(true);
    expect(reads).toBe(1);
  });

  it("is copied unchanged into each version published from the draft, and shown with the version", async () => {
    const t = world();
    const made = (await t.make(MAX, { name: "Versioned" }))["agent"] as { agentId: string };
    const stored = (await t.store.getDraft(ORG_A, made.agentId))!.origin!;
    const published = await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 1 });
    expect((published["version"] as Record<string, unknown>)["version"], JSON.stringify(published)).toBe(1);
    expect((await t.store.getVersion(ORG_A, made.agentId, 1))?.origin).toEqual(stored);
    expect(originOf(published["version"] as Record<string, unknown>)).toMatchObject({ visible: true, sessionId: t.sid });
    // A later version made from an edited draft carries the same origin; the first stays as it was.
    await t.agents(MAX, "PUT", `/v1/app/agents/${made.agentId}/draft`, { requestId: randomUUID(), expectedRevision: 1, overlay: { instructions: "Second take." } });
    await t.agents(MAX, "POST", `/v1/app/agents/${made.agentId}/publish`, { requestId: randomUUID(), expectedRevision: 2 });
    expect((await t.store.getVersion(ORG_A, made.agentId, 2))?.origin).toEqual(stored);
    expect((await t.store.getVersion(ORG_A, made.agentId, 1))?.origin).toEqual(stored);
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
    const draftItem = t.w.db.get(agentKey(ORG_A, id, "DRAFT"))!;
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: "not-a-session", createdBy: MAX, createdAt: "x" } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: t.sid, createdBy: MAX, createdAt: new Date(T0).toISOString(), extra: "field" } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
  });

  it("reads the session of the agent's own org only: an origin naming a session of another org is hidden", async () => {
    const t = world();
    const id = await made(t);
    const other = t.w.seedSession({ orgId: ORG_B, owner: "9".repeat(64), project: "web" });
    const draftItem = t.w.db.get(agentKey(ORG_A, id, "DRAFT"))!;
    t.w.db.set({ ...draftItem, origin: { kind: "session", sessionId: other.sessionId, createdBy: MAX, createdAt: new Date(T0).toISOString() } });
    expect(originOf(await t.draftOf(MAX, id))).toEqual(hidden);
  });

  it("leaves drafts and versions made before there was an origin exactly as they were", async () => {
    const t = world();
    const plain = (await t.agents(MAX, "POST", "/v1/app/agents", { requestId: randomUUID(), name: "Old", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, overlay: { instructions: "Old.", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] } }))["agent"] as { agentId: string };
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
    expect(await t.store.getDraft(ORG_A, plain.agentId)).not.toHaveProperty("origin");
  });
});

describe("the make_agent capability in the session view", () => {
  const youOf = (answer: unknown) => ((answer as { session: { you: { actions: string[] } } }).session.you);
  const actions = async (t: ReturnType<typeof world>, who: string, sid: string = t.sid) => youOf(await t.session(who, "GET", `/v1/app/sessions/${sid}`)).actions;

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
    // Max keeps a view of the session through a share, so what changes is only his right to create agents.
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: MAX }, "view");
    expect(await actions(t, MAX)).toContain("make_agent");
    t.w.members.revoke(ORG_A, "web", MAX);
    t.w.db.delete(projectMemberKey(ORG_A, MAX, "web"));
    expect(await actions(t, MAX)).not.toContain("make_agent");
    expect(await code(t.make(MAX, { name: "No" }))).toMatchObject({ code: "FORBIDDEN" });
    t.w.members.grant(ORG_A, "web", MAX, "maintainer");
    expect(await actions(t, MAX)).toContain("make_agent");
    expect((await t.make(MAX, { name: "Yes" }))["agent"]).toBeDefined();
  });

  it("is never inferred from an org role the record does not hold, and is absent for a session with no project, or without the agent routes wired", async () => {
    const t = world();
    t.w.seedShare(ORG_A, t.sid, { kind: "member", developerId: ZED }, "view");
    const liar = { ...t.w.caller(ZED), orgRole: "admin" as const };
    const view = await routeAgentSessionRequest(t.deps, liar, { method: "GET", path: `/v1/app/sessions/${t.sid}`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/sessions/${t.sid}`));
    expect(youOf(view).actions).not.toContain("make_agent");
    const loose = t.w.seedSession({ project: null, owner: MAX });
    expect(await actions(t, MAX, loose.sessionId)).not.toContain("make_agent");
    const bare = { ...t.deps } as Record<string, unknown>;
    delete bare["approvals"];
    const unwired = await routeAgentSessionRequest(bare as never, t.w.caller(MAX), { method: "GET", path: `/v1/app/sessions/${t.sid}`, headers: {}, requestId: "r" }, new URL(`${CELL}/v1/app/sessions/${t.sid}`));
    expect(youOf(unwired).actions).not.toContain("make_agent");
  });
});
