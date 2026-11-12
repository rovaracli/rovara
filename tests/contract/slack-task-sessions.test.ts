// R-SESSIONS (0.5.16): a task started from Slack has a session, so a person can message it from the web app, its task page shows the session and open pages hear about it.
//  - A Slack start on an install with agents writes the session in the start transaction (as an app start does); here it is read, messaged, refused to a non-member and to another company, and the realtime publisher hears it.
//  - A Slack-started coding-workflow task from before runs kept an agent snapshot has no agent, origin or starter on its record; it is given its session the first time its task page is read (no sweep, no data move) and then behaves the same.
//  - An app-started task is unchanged, and a task that is not such a workflow task (a chain step's, an automatic job's) is still not given a session by the fallback.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRecordSchema, agentSessionKey, type OrgId } from "@rovara-code/contracts";
import { sessionChannel } from "@agentx/cloud-contracts";
import { ensureTaskSession, lazySessionId } from "../../packages/broker/src/agent-sessions/create.js";
import { requireSessionLevel } from "../../packages/broker/src/agent-sessions/access.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { DEV_ISSUER, MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
/** Maya as Slack knows her: a Slack-started task belongs to the developer id "Sign in with Slack" gives her. */
const OWNER: Developer = { developerId: developerIdForSlackUser(MAYA.slackUserId!), name: "Maya Chen", provider: "slack", sessionId: "s-owner-slack", slackUserId: MAYA.slackUserId! };
const ZOE: Developer = { developerId: "5".repeat(64), name: "Zoe Park", provider: "oidc", sessionId: "s-zoe" };
const BOB: Developer = { developerId: "6".repeat(64), name: "Bob Other", provider: "oidc", sessionId: "s-bob" };
const ORIGIN = new URL(DEV_ISSUER).origin;
const ENDPOINT = "https://abcdefghijklmnopqrstuvwxyz.appsync-api.us-east-1.amazonaws.com/event";

type Item = Record<string, unknown>;

beforeAll(async () => { await loadSlackBroker(); }, 120_000);

const published: Array<{ channel: string; events: string[] }> = [];
const realEnv = { endpoint: process.env["REALTIME_HTTP_ENDPOINT"], key: process.env["AWS_ACCESS_KEY_ID"], secret: process.env["AWS_SECRET_ACCESS_KEY"] };
beforeEach(() => {
  published.length = 0;
  process.env["REALTIME_HTTP_ENDPOINT"] = ENDPOINT;
  process.env["AWS_ACCESS_KEY_ID"] = "AKIDEXAMPLE";
  process.env["AWS_SECRET_ACCESS_KEY"] = "secret-for-tests";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    published.push(JSON.parse(init.body) as { channel: string; events: string[] });
    return new Response("{}", { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["REALTIME_HTTP_ENDPOINT", realEnv.endpoint], ["AWS_ACCESS_KEY_ID", realEnv.key], ["AWS_SECRET_ACCESS_KEY", realEnv.secret]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function setup(options: { agents?: boolean } = {}) {
  const h = await createDeveloperTaskBroker({
    brokerExtra: options.agents === false ? {} : { agents: {} },
    orgResolver: async ({ developerId }) => (developerId === BOB.developerId ? ORG_B : TEST_ORG),
  });
  const known = (who: Developer, orgId: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId, role: "member" });
  };
  known(OWNER);
  known(ZOE);
  known(BOB, ORG_B);
  /** A Slack mention in a new thread: the workflow's own start. */
  const slackStart = async () => {
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: `1695500000.${String(Math.floor(Math.random() * 900_000) + 100_000)}` };
    const reply = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    expect(reply.statusCode ?? 200, reply.body).toBe(200);
    return String((JSON.parse(reply.body) as { taskId: string }).taskId);
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as (Item & { sessionId?: string }) | undefined;
  const sessionOf = (sessionId: string) => h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Item | undefined;
  const sessionItems = (sessionId: string) => h.db.find((item) => typeof item.pk === "string" && item.pk.includes(`AGENT_SESSION#${sessionId}`));
  const send = (who: Developer, sessionId: string, text = "Please also add a test.", kind: "comment" | "steer" = "steer") =>
    h.dev(who, "POST", `/v1/app/sessions/${sessionId}/messages`, { requestId: randomUUID(), kind, text });
  /** What a task from before runs kept an agent snapshot looked like: no agent, origin, starter, payer or session (and its session items gone). */
  const makeLegacy = (taskId: string) => {
    const record = meta(taskId)!;
    const sessionId = record.sessionId!;
    for (const item of sessionItems(sessionId)) h.db.delete(item.pk as string, item.sk as string);
    for (const item of h.db.find((entry) => typeof entry.pk === "string" && /MY_SESSIONS#|PROJECT_SESSIONS#|LIVE_SESSIONS|OPEN_AGENT_SESSIONS|SESSION_SURFACE|SESSION_BINDING/.test(entry.pk) && entry.sessionId === sessionId)) h.db.delete(item.pk as string, item.sk as string);
    const { sessionId: _s, agent: _a, origin: _o, startedBy: _b, payer: _p, place: _pl, ...rest } = record; // eslint-disable-line @typescript-eslint/no-unused-vars -- what the old record never had
    h.db.delete(`DEVTASK#${taskId}`, "META");
    h.db.set(rest);
    return sessionId;
  };
  return { ...h, known, slackStart, meta, sessionOf, sessionItems, send, makeLegacy };
}

describe("a Slack-started task has a session", () => {
  it("is given one in the start transaction: a Slack task, started by its owner as Rovara Code, bound to its thread", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    const sessionId = t.meta(taskId)!.sessionId!;
    expect(sessionId).toMatch(/^ses_[0-9a-z]{20}$/);
    const record = AgentSessionRecordSchema.parse(Object.fromEntries(Object.entries(t.sessionOf(sessionId)!).filter(([key]) => !["pk", "sk", "entityType"].includes(key))));
    expect(record).toMatchObject({ orgId: TEST_ORG, kind: "task", subject: { kind: "task", taskId }, origin: "slack", project: "payments", owner: { developerId: OWNER.developerId }, startedBy: { kind: "member", developerId: OWNER.developerId } });
    // The owner reads it as a session, and the task page's own read names it.
    const read = await t.dev(OWNER, "GET", `/v1/app/sessions/${sessionId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const page = await t.dev(OWNER, "GET", `/v1/dev/tasks/${taskId}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.task).toMatchObject({ sessionId, sessionUrl: `${ORIGIN}/app/sessions/${sessionId}` });
  });

  it("can be messaged from the web app by its owner, the message reaches the task and the session's channel hears of it", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    const sessionId = t.meta(taskId)!.sessionId!;
    const sent = await t.send(OWNER, sessionId);
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(t.sessionItems(sessionId).filter((item) => String(item.sk).startsWith("MESSAGE#") && item.text === "Please also add a test.")).toHaveLength(1);
    const heard = published.filter((call) => call.channel === sessionChannel(TEST_ORG, sessionId));
    expect(heard, JSON.stringify(published)).not.toHaveLength(0);
    expect(heard.flatMap((call) => call.events).some((event) => event.includes(sessionId))).toBe(true);
  });

  it("refuses a person who may not see the task, and another company, as a session that is not there", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    const sessionId = t.meta(taskId)!.sessionId!;
    const missing = await t.send(OWNER, `ses_${"z".repeat(20)}`);
    // Zoe is in the company but holds no grant on the project and was never added to the task: she reads and writes nothing.
    for (const who of [ZOE, BOB]) {
      for (const attempt of [() => t.dev(who, "GET", `/v1/app/sessions/${sessionId}`), () => t.send(who, sessionId), () => t.send(who, sessionId, "A comment.", "comment")]) {
        const reply = await attempt();
        expect(reply.status, `${who.name}: ${JSON.stringify(reply.body)}`).toBe(missing.status);
        expect(reply.body.error).toEqual(missing.body.error);
      }
    }
    expect(t.sessionItems(sessionId).filter((item) => String(item.sk).startsWith("MESSAGE#"))).toEqual([]);
    expect(published.filter((call) => call.channel === sessionChannel(TEST_ORG, sessionId))).toEqual([]);
    // The access check itself: a caller of another company and a caller who is no member at all.
    const deps = { documentClient: t.db, tableName: "state", now: () => Date.now(), projectMembers: { roleOf: async () => undefined, projectsOf: async () => [] } } as never;
    await expect(requireSessionLevel(deps, { orgId: ORG_B, developerId: OWNER.developerId }, sessionId, "view", "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requireSessionLevel(deps, { orgId: TEST_ORG, developerId: "9".repeat(64) }, sessionId, "view", "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("leaves an app-started task as it was: the agent the run pinned, the origin it asked from", async () => {
    const t = await setup();
    const started = await t.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = t.meta(taskId)!;
    expect(record.sessionId).toMatch(/^ses_/);
    expect(record.agent).toMatchObject({ agentId: "rovara-code" });
    expect(record.origin).toBe("cli");
    expect(t.sessionOf(record.sessionId!)).toMatchObject({ origin: "cli", startedBy: { kind: "member", developerId: MAYA.developerId }, agent: { agentId: "rovara-code" } });
  });
});

describe("a Slack-started task from before runs kept an agent snapshot", () => {
  it("is given its session the first time its task page is read, then is messaged like any other", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    t.makeLegacy(taskId);
    expect(t.meta(taskId)).toMatchObject({ client: "Slack" });
    expect(t.meta(taskId)!.workflow).toBeDefined();
    expect(t.meta(taskId)!.sessionId).toBeUndefined();
    expect(t.meta(taskId)!.agent).toBeUndefined();
    const page = await t.dev(OWNER, "GET", `/v1/dev/tasks/${taskId}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const sessionId = t.meta(taskId)!.sessionId!;
    expect(sessionId).toBe(lazySessionId(taskId));
    expect(page.body.task).toMatchObject({ sessionId, sessionUrl: `${ORIGIN}/app/sessions/${sessionId}` });
    expect(t.sessionOf(sessionId)).toMatchObject({ kind: "task", origin: "slack", agent: { agentId: "rovara-code", name: "Rovara Code" }, startedBy: { kind: "member", developerId: OWNER.developerId },
      owner: { developerId: OWNER.developerId }, payer: { kind: "member", developerId: OWNER.developerId }, createdAt: t.meta(taskId)!.createdAt });
    // A second read (or a racing one) finds the same session and writes no second.
    await t.dev(OWNER, "GET", `/v1/dev/tasks/${taskId}`);
    expect(t.meta(taskId)!.sessionId).toBe(sessionId);
    const sent = await t.send(OWNER, sessionId);
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(published.some((call) => call.channel === sessionChannel(TEST_ORG, sessionId))).toBe(true);
  });

  it("keeps the access rules for the repaired session: a person with no grant and another company are refused", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    t.makeLegacy(taskId);
    await t.dev(OWNER, "GET", `/v1/dev/tasks/${taskId}`);
    const sessionId = t.meta(taskId)!.sessionId!;
    const missing = await t.send(OWNER, `ses_${"z".repeat(20)}`);
    for (const who of [ZOE, BOB]) {
      const reply = await t.send(who, sessionId);
      expect([reply.status, reply.body.error], who.name).toEqual([missing.status, missing.body.error]);
      const read = await t.dev(who, "GET", `/v1/dev/tasks/${taskId}`);
      expect(read.status, who.name).toBeGreaterThanOrEqual(400);
    }
    expect(t.sessionItems(sessionId).filter((item) => String(item.sk).startsWith("MESSAGE#"))).toEqual([]);
  });

  it("is not made by a task of another company, nor for a task that is no workflow, a chain step or an automatic job", async () => {
    const t = await setup();
    const taskId = await t.slackStart();
    t.makeLegacy(taskId);
    const base = t.meta(taskId) as Item & { createdAt: string; developerId: string; project: string; orgId: OrgId };
    const table = { documentClient: t.db as never, tableName: "state", now: () => Date.now() };
    const lazy = (extra: Record<string, unknown>) => ensureTaskSession(table, { ...base, ...extra } as never, { ownerName: "Maya Chen", title: "Add a greeting" });
    const { workflow: _w, ...plainTask } = base; // eslint-disable-line @typescript-eslint/no-unused-vars -- a task that is no workflow
    expect(await lazy({ chain: { chainRunId: "chr_0123456789abcdefghij", stepId: "build" } })).toBeUndefined();
    expect(await lazy({ automatic: { kind: "nightly" } })).toBeUndefined();
    expect(await ensureTaskSession(table, plainTask as never, { ownerName: "Maya Chen", title: "Add a greeting" })).toBeUndefined();
    expect(await lazy({ orgId: undefined })).toBeUndefined();
    expect(t.meta(taskId)!.sessionId).toBeUndefined();
    // The task is recorded under another company: the session is not made and the task is not changed.
    expect(await lazy({ orgId: ORG_B })).toBeUndefined();
    expect(t.meta(taskId)!.sessionId).toBeUndefined();
  });
});

describe("an install without agents", () => {
  it("is unchanged: a Slack task has no session and no session routes to open it by", async () => {
    const t = await setup({ agents: false });
    const taskId = await t.slackStart();
    expect(t.meta(taskId)!.sessionId).toBeUndefined();
    const page = await t.dev(OWNER, "GET", `/v1/dev/tasks/${taskId}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(t.meta(taskId)!.sessionId).toBeUndefined();
  });
});
