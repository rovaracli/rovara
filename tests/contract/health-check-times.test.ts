// 0.5.15: when each health check last ran, per company. Times are written when a check completes (the live Slack probe and the GitHub App check in the health route,
// a model source's check, and each model-governed step's main model or fallback) and read back, aged, only by a live owner or admin of that company, for the company
// of the session. A feature with no time reads "never checked". Company scoping is mutation-proved (see the lane's report).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { orgScoped, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey, orgSettingsKey, OrgHealthObservationsResponseSchema, OrgHealthObservationsReaderSchema } from "@agentx/cloud-contracts";
import { readOrgHealthObservations, recordHealthCheck, recordModelUse } from "../../packages/broker/src/org/health-observations.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { seedMembership, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { createAuditedSlackBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, call as slackCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const A = TEST_ORG, B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const NOW = Date.parse("2026-11-11T12:00:00Z"), minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const adminA = "a".repeat(64), adminB = "b".repeat(64);
const NEVER = { checked: false };

beforeAll(async () => { await loadSlackBroker(); }, 120_000);

// ---- the read, called directly with two companies in one table

function table() {
  const db = new FakeDynamoDb();
  for (const [org, id] of [[A, adminA], [B, adminB]] as const) {
    db.set({ ...orgMetaKey(org), orgId: org });
    db.set({ ...orgMemberKey(org, id), orgId: org, developerId: id, role: "admin" });
    db.set({ ...developerOrgKey(id), orgId: org, role: "admin" });
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", revoked: false });
  }
  const reads: string[] = [], send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
    const input = (command as { input: { Key?: { pk?: string } } }).input;
    if (input.Key?.pk !== undefined) reads.push(input.Key.pk);
    return send(command);
  };
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => NOW };
  const caller = (org: OrgId, id: string) => ({ orgId: org, developerId: id, browserSession: true as const });
  return { db, deps, reads, caller, writer: { documentClient: db, tableName: "state", now: () => NOW - 5 * 60_000 } };
}
const read = (t: ReturnType<typeof table>, org: OrgId, id: string, expected: unknown = org) => readOrgHealthObservations(t.deps, t.caller(org, id), { expectedOrgId: expected });

describe("recording a check", () => {
  it("overwrites one small item per feature in the company's own settings partition, holding a time and a result only", async () => {
    const t = table();
    await recordHealthCheck(t.writer, A, "slack", "failed");
    await recordHealthCheck({ ...t.writer, now: () => NOW - 60_000 }, A, "slack", "ok");
    const rows = t.db.find((item) => item.pk === orgSettingsKey(A, "HEALTH_SLACK_PROBE").pk && String(item.sk).startsWith("HEALTH_"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ...orgSettingsKey(A, "HEALTH_SLACK_PROBE"), entityType: "HEALTH_OBSERVATION", orgId: A, feature: "slack", checkedAt: minutesAgo(1), result: "ok" });
    expect(t.db.find((item) => String(item.pk).includes(B) && String(item.sk).startsWith("HEALTH_"))).toEqual([]);
  });

  it("never fails the check it describes when the write fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const broken = { documentClient: { send: async () => { throw Object.assign(new Error("secret table detail"), { name: "ProvisionedThroughputExceededException" }); } }, tableName: "state" };
    await expect(recordHealthCheck(broken, A, "github", "ok")).resolves.toBeUndefined();
    await expect(recordModelUse(broken, A, { kind: "main" })).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("secret table detail");
    log.mockRestore();
  });

  it("writes a main-model run at most once a minute, and every fallback with its fixed reason", async () => {
    const t = table();
    let now = NOW;
    const w = { documentClient: t.db, tableName: "state", now: () => now };
    await recordModelUse(w, A, { kind: "main" });
    now += 30_000; await recordModelUse(w, A, { kind: "main" });
    expect(t.db.get(orgSettingsKey(A, "HEALTH_MODEL_USE"))).toMatchObject({ lastMainAt: new Date(NOW).toISOString() });
    now += 31_000; await recordModelUse(w, A, { kind: "main" });
    expect(t.db.get(orgSettingsKey(A, "HEALTH_MODEL_USE"))).toMatchObject({ lastMainAt: new Date(NOW + 61_000).toISOString() });
    await recordModelUse(w, A, { kind: "fallback", reason: "MODEL_CALL_REFUSED" });
    expect(t.db.get(orgSettingsKey(A, "HEALTH_MODEL_USE"))).toMatchObject({ lastMainAt: new Date(NOW + 61_000).toISOString(), lastFallbackAt: new Date(now).toISOString(), lastFallbackReason: "MODEL_CALL_REFUSED", orgId: A });
  });
});

describe("reading the times", () => {
  it("reads a feature that was never checked as never checked, for all four", async () => {
    const t = table();
    const answer = await read(t, A, adminA);
    expect(answer).toEqual({ orgId: A, readAt: new Date(NOW).toISOString(), modelSource: NEVER, modelUse: NEVER, slack: NEVER, github: NEVER });
    expect(OrgHealthObservationsResponseSchema.safeParse(answer).success).toBe(true);
  });

  it("returns each time, result and age the checks wrote", async () => {
    const t = table();
    await recordHealthCheck(t.writer, A, "slack", "ok");
    await recordHealthCheck({ ...t.writer, now: () => NOW - 90_000 }, A, "github", "failed");
    await recordHealthCheck({ ...t.writer, now: () => NOW - 3 * 3600_000 }, A, "model_source", "unknown");
    await recordModelUse({ ...t.writer, now: () => NOW - 2 * 60_000 }, A, { kind: "main" });
    await recordModelUse({ ...t.writer, now: () => NOW - 26 * 3600_000 }, A, { kind: "fallback", reason: "DEFAULT_MODEL_UNAVAILABLE" });
    expect(await read(t, A, adminA)).toEqual({
      orgId: A, readAt: new Date(NOW).toISOString(),
      slack: { checked: true, checkedAt: minutesAgo(5), ageSeconds: 300, result: "ok" },
      github: { checked: true, checkedAt: new Date(NOW - 90_000).toISOString(), ageSeconds: 90, result: "failed" },
      modelSource: { checked: true, checkedAt: new Date(NOW - 3 * 3600_000).toISOString(), ageSeconds: 10_800, result: "unknown" },
      // The main model ran two minutes ago; the last fallback was 26 hours ago, outside the 24-hour window.
      modelUse: { checked: true, windowHours: 24, usedMain: true, usedFallback: false, lastMainAt: minutesAgo(2), lastMainAgeSeconds: 120, lastFallbackAt: new Date(NOW - 26 * 3600_000).toISOString(), lastFallbackAgeSeconds: 93_600, lastFallbackReason: "DEFAULT_MODEL_UNAVAILABLE" },
    });
  });

  it("says a fallback was used inside the window", async () => {
    const t = table();
    await recordModelUse({ ...t.writer, now: () => NOW - 3600_000 }, A, { kind: "fallback", reason: "CONFIGURED_FALLBACK" });
    expect((await read(t, A, adminA)).modelUse).toEqual({ checked: true, windowHours: 24, usedMain: false, usedFallback: true, lastFallbackAt: new Date(NOW - 3600_000).toISOString(), lastFallbackAgeSeconds: 3600, lastFallbackReason: "CONFIGURED_FALLBACK" });
  });

  it("reads a damaged item as never checked, never as a time", async () => {
    const t = table();
    t.db.set({ ...orgSettingsKey(A, "HEALTH_SLACK_PROBE"), orgId: A, checkedAt: "yesterday-ish", result: "ok" });
    t.db.set({ ...orgSettingsKey(A, "HEALTH_GITHUB_CHECK"), orgId: A, checkedAt: minutesAgo(1), result: "fine" });
    t.db.set({ ...orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"), orgId: B, checkedAt: minutesAgo(1), result: "ok" });
    const answer = await read(t, A, adminA);
    expect([answer.slack, answer.github, answer.modelSource]).toEqual([NEVER, NEVER, NEVER]);
  });

  it("keeps each company's times to itself", async () => {
    const t = table();
    await recordHealthCheck(t.writer, A, "slack", "ok");
    await recordHealthCheck({ ...t.writer, now: () => NOW - 3600_000 }, B, "slack", "failed");
    await recordModelUse(t.writer, B, { kind: "fallback", reason: "MODEL_CALL_REFUSED" });
    const a = await read(t, A, adminA), b = await read(t, B, adminB);
    expect(a.slack).toMatchObject({ result: "ok", ageSeconds: 300 });
    expect(a.modelUse).toEqual(NEVER);
    expect(b.slack).toMatchObject({ result: "failed", ageSeconds: 3600 });
    expect(b.modelUse).toMatchObject({ usedFallback: true });
  });

  it("refuses an admin of one company who names another, and reads nothing of the other company", async () => {
    const t = table();
    await recordHealthCheck(t.writer, B, "slack", "ok");
    t.reads.length = 0;
    await expect(read(t, A, adminA, B)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    // An admin of B asking for A's, with B's own session, is refused the same way.
    await expect(read(t, B, adminB, A)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(t.reads.filter((pk) => pk.includes(B) && pk.includes("SETTINGS"))).toEqual([]);
    expect(t.reads.filter((pk) => pk.includes(A) && pk.includes("SETTINGS"))).toEqual([]);
    for (const bad of [undefined, null, "", "org_x", 7]) await expect(readOrgHealthObservations(t.deps, t.caller(A, adminA), { expectedOrgId: bad })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });

  it("refuses a person who is an admin of no such company, and one whose role is not owner or admin, before reading any time", async () => {
    const t = table();
    await recordHealthCheck(t.writer, A, "slack", "ok");
    // adminB is not a member of A.
    await expect(read(t, A, adminB)).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const role of ["member", "auditor"]) {
      t.db.set({ ...orgMemberKey(A, adminA), orgId: A, developerId: adminA, role });
      t.db.set({ ...developerOrgKey(adminA), orgId: A, role });
      t.reads.length = 0;
      await expect(read(t, A, adminA), role).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(t.reads.filter((pk) => pk.includes("SETTINGS")), role).toEqual([]);
    }
  });

  it("refuses a token (no browser session) and a closing company", async () => {
    const t = table();
    await expect(readOrgHealthObservations(t.deps, { orgId: A, developerId: adminA }, { expectedOrgId: A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    t.db.set({ ...orgMetaKey(A), orgId: A, closingAt: new Date(NOW).toISOString() });
    await expect(read(t, A, adminA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads a damaged-future time as zero seconds old and lets an older page ignore a field it does not know", async () => {
    const t = table();
    t.db.set({ ...orgSettingsKey(A, "HEALTH_SLACK_PROBE"), orgId: A, checkedAt: new Date(NOW + 60_000).toISOString(), result: "ok" });
    const answer = await read(t, A, adminA);
    expect(answer.slack).toMatchObject({ checked: true, ageSeconds: 0 });
    expect(OrgHealthObservationsReaderSchema.parse({ ...answer, somethingNewer: 1 })).toEqual(answer);
  });
});

// ---- through the handler: the browser route, and who may reach it

const cell = "https://cell.example", sid = "11111111-1111-4111-8111-111111111111", person = "a".repeat(64);
async function handlerFixture(role: string) {
  const h = await createAdminBroker({ developer: { issuer: `${cell}/v1/auth`, env: "test", signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true }, verifyAccessToken: async () => ({}), channelMembers: async () => { throw new Error("No Slack calls"); } }, extra: { cloud: true } });
  seedMembership(h.db, person, { orgId: A, role: role as "owner" });
  h.db.set({ pk: `DEVELOPER#${person}`, sk: "META", developerId: person, provider: "cloud", revoked: false });
  h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: person, amr: "cloud", startedAt: new Date(NOW - 60000).toISOString(), endsAt: NOW / 1000 + 3600, reviewExpiresAt: NOW / 1000 + 3600 });
  await recordHealthCheck({ documentClient: h.db, tableName: "state", now: () => NOW - 120_000 }, A, "slack", "ok");
  await recordHealthCheck({ documentClient: h.db, tableName: "state", now: () => NOW - 120_000 }, B, "github", "ok");
  const get = async (route: "app" | "web", headers: Record<string, string>, query = `expectedOrgId=${A}`) => {
    const response = await h.handler({ version: "2.0", routeKey: `ANY /v1/${route}/{proxy+}`, rawPath: `/v1/${route}/org/health-observations`, rawQueryString: query, headers, requestContext: { requestId: "trace", http: { method: "GET" } } });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { ...h, get };
}
const cookie = { cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin" };
const withClock = async <T>(run: () => Promise<T>): Promise<T> => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); try { return await run(); } finally { vi.useRealTimers(); } };

describe("GET /v1/web/org/health-observations", () => {
  for (const role of ["owner", "admin"]) it(`answers a live ${role} of the company with its own aged times`, () => withClock(async () => {
    const f = await handlerFixture(role), result = await f.get("web", cookie);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ orgId: A, slack: { checked: true, ageSeconds: 120, result: "ok" }, github: NEVER, modelSource: NEVER, modelUse: NEVER });
  }));
  for (const role of ["member", "auditor"]) it(`refuses a ${role}`, () => withClock(async () => {
    const f = await handlerFixture(role), result = await f.get("web", cookie);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toMatch(/checkedAt|ageSeconds/);
  }));
  it("refuses a page that names another company, and a token on the /v1/app path", () => withClock(async () => {
    const f = await handlerFixture("owner");
    const other = await f.get("web", cookie, `expectedOrgId=${B}`);
    expect(other.status).toBe(409);
    expect(JSON.stringify(other.body)).not.toMatch(/checkedAt|ageSeconds/);
    expect((await f.get("web", cookie, "")).status).toBe(409);
    expect([401, 403]).toContain((await f.get("app", cookie)).status);
    expect((await f.get("web", {})).status).toBe(401);
  }));
  it("changes nothing in the table", () => withClock(async () => {
    const f = await handlerFixture("owner"), before = structuredClone(f.db.find(() => true));
    await f.get("web", cookie);
    expect(f.db.find(() => true)).toEqual(before);
  }));
});

// ---- the checks that write the times

describe("the health route leaves the Slack probe's and the GitHub check's times", () => {
  it("writes each after its probe completes, with its result, for the caller's company only", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: { slackAuthCheck: async () => ({ ok: false as const, error: "token_revoked" }), githubInstallations: async () => 2 } } } });
    const before = Date.now();
    expect((await admin("GET", "/v1/admin/health")).status).toBe(200);
    const slack = db.get(orgSettingsKey(A, "HEALTH_SLACK_PROBE")) as { checkedAt: string; result: string; orgId: string };
    const github = db.get(orgSettingsKey(A, "HEALTH_GITHUB_CHECK")) as { checkedAt: string; result: string };
    expect([slack.result, github.result]).toEqual(["failed", "ok"]);
    expect(Date.parse(slack.checkedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(github.checkedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(db.find((item) => String(item.pk).includes(B) && String(item.sk).startsWith("HEALTH_"))).toEqual([]);
  });

  it("writes unknown for a probe that could not answer, and nothing for a probe that is not set up", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: { slackAuthCheck: async () => { throw new Error("down"); } } } } });
    expect((await admin("GET", "/v1/admin/health")).status).toBe(200);
    expect(db.get(orgSettingsKey(A, "HEALTH_SLACK_PROBE"))).toMatchObject({ result: "unknown" });
    expect(db.get(orgSettingsKey(A, "HEALTH_GITHUB_CHECK"))).toBeUndefined();
  });
});

const person7 = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person7("1", "Dana");
describe("a model source's check leaves its time", () => {
  async function sourceFixture(check: () => Promise<{ ok: true; health?: string } | { ok: false; message: string }>) {
    const access = fakeModelAccess();
    access.checkSource.mockImplementation(check as never);
    const h = await createDeveloperTaskBroker({ register: false, brokerExtra: { agents: { modelSources: { launch: { kinds: ["anthropic"] } } }, modelAccess: { access, proxyUrl: "https://proxy.example.com" } } });
    h.db.set({ pk: `SESSION#${DANA.sessionId}`, sk: "META", sessionId: DANA.sessionId, developerId: DANA.developerId, amr: DANA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${DANA.developerId}`, sk: "META", developerId: DANA.developerId, provider: DANA.provider, displayName: DANA.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(DANA);
    seedMembership(h.db, DANA.developerId, { orgId: A, role: "admin" });
    const added = await h.dev(DANA, "POST", "/v1/app/org/model-sources", { requestId: randomUUID(), source: { kind: "anthropic", label: "Company Anthropic", models: [{ catalog: { provider: "anthropic", modelId: "claude-sonnet-4-5" } }] }, apiKey: "sk-ant-" + "x".repeat(30) });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    return { ...h, id: added.body.sourceId as string, runCheck: () => h.dev(DANA, "POST", `/v1/app/org/model-sources/${added.body.sourceId as string}/check`) };
  }

  it("writes ok after a check that passed, failed after one that did not, and unknown after one that threw", async () => {
    let answer: { ok: true } | { ok: false; message: string } | Error = { ok: true };
    const f = await sourceFixture(async () => { if (answer instanceof Error) throw answer; return answer; });
    expect(f.db.get(orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"))).toBeUndefined();
    expect((await f.runCheck()).body).toMatchObject({ ok: true });
    expect(f.db.get(orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"))).toMatchObject({ result: "ok", orgId: A });
    answer = { ok: false, message: "the key was refused" };
    expect((await f.runCheck()).body).toMatchObject({ ok: false });
    expect(f.db.get(orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"))).toMatchObject({ result: "failed" });
    answer = Object.assign(new Error("proxy down"), { name: "ProxyDown" });
    await f.runCheck();
    expect(f.db.get(orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"))).toMatchObject({ result: "unknown" });
    expect(f.db.find((item) => String(item.pk).includes(B) && String(item.sk).startsWith("HEALTH_"))).toEqual([]);
  });

  it("writes nothing for a source that does not exist", async () => {
    const f = await sourceFixture(async () => ({ ok: true }));
    const missing = await f.dev(DANA, "POST", "/v1/app/org/model-sources/src_aaaaaaaaaaaaaaaaaaaa/check");
    expect(missing.status).toBe(404);
    expect(f.db.get(orgSettingsKey(A, "HEALTH_MODEL_SOURCE_CHECK"))).toBeUndefined();
  });
});

// ---- the model that ran a step

async function turnFixture(extra: { locked?: boolean; unavailable?: boolean } = {}) {
  const { developerIdForSlackUser } = await import("../../packages/broker/src/aws/admin-actions.js");
  const { bedrockClaudeModelIds } = await import("@agentx/model-runtime/catalog");
  const developer = { issuer: "https://cell.example/v1/auth", env: "staging", signInTableName: "signin", methods: { slack: true, oidc: false, cloud: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true as const, memberOf: [] }) };
  const h = createAuditedSlackBroker({ developer }), actor = developerIdForSlackUser("U0123456789");
  seedMembership(h.db, actor, { orgId: A, role: "owner" });
  h.db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, provider: "slack", revoked: false });
  const ids = bedrockClaudeModelIds("us");
  const primary = extra.unavailable === true ? { provider: "openai", modelId: "gpt-6.1-sol", label: "Primary" } : { provider: "amazon-bedrock", modelId: ids[0]!, label: "Primary" };
  await registerSlackProject(h.handler, { models: { default: primary, approved: [...(extra.unavailable === true ? [primary] : []), ...ids.map((modelId, index) => ({ provider: "amazon-bedrock", modelId, label: `Model ${index}` }))] } });
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.00000${extra.unavailable === true ? 3 : 4}`, user = "U0123456789";
  const workspace = await ensureWorkspace(h.handler, thread, user), workspaceId = String(workspace.body.workspaceId);
  markReady(h.db, workspaceId);
  const conversation = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const start = () => serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "Fix the project." });
  return { ...h, ids, workspaceId, start };
}
const useRow = (db: FakeDynamoDb, org: OrgId = A) => db.get(orgSettingsKey(org, "HEALTH_MODEL_USE")) as Record<string, unknown> | undefined;

describe("the model that ran a step leaves its time", () => {
  it("records the main model when a governed step starts on the model the company's policy chose", async () => {
    const f = await turnFixture();
    const { bedrockClaudeModelIds } = await import("@agentx/model-runtime/catalog");
    const model = { provider: "amazon-bedrock", modelId: bedrockClaudeModelIds("us")[0]! };
    f.db.set({ pk: orgScoped(A, "SETTINGS"), sk: "MODEL_SELECTION_POLICY", entityType: "MODEL_SELECTION_POLICY", orgId: A, version: 1, revision: 1, rankingVersion: "g3-v1", stepOverrides: { build: { model, thinkingLevel: null, locked: true } } });
    expect(useRow(f.db)).toBeUndefined();
    const result = await f.start();
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(useRow(f.db)).toMatchObject({ orgId: A, lastMainAt: expect.any(String) as unknown });
    expect(useRow(f.db)?.lastFallbackAt).toBeUndefined();
    expect(useRow(f.db, B)).toBeUndefined();
  });

  it("records a fallback, with its reason, when a step starts on a fallback", async () => {
    const f = await turnFixture({ unavailable: true });
    const result = await f.start();
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(useRow(f.db)).toMatchObject({ orgId: A, lastFallbackAt: expect.any(String) as unknown, lastFallbackReason: "DEFAULT_MODEL_UNAVAILABLE" });
  });

  it("records a fallback chosen while the step runs (the signed model-fallback call)", async () => {
    const f = await turnFixture();
    const result = await f.start();
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const operationId = (result.body.operation as { id: string }).id;
    expect(useRow(f.db)?.lastFallbackAt).toBeUndefined();
    const outbox = f.db.find((row) => row.entityType === "OUTBOX" && row.operationId === operationId)[0]!;
    const invocation = outbox.invocation as { callbackCapability: string; payload: { model: unknown; modelPolicy: unknown } };
    const path = `/v1/internal/workspaces/${f.workspaceId}/operations/${operationId}/model-fallback`;
    const body = { version: 1, binding: invocation.payload.modelPolicy, reason: "missing_key", failedModel: invocation.payload.model, environmentFallback: { provider: "amazon-bedrock", modelId: f.ids[0]! } };
    const response = await slackCall(f.handler, { method: "POST", path, headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(useRow(f.db)).toMatchObject({ lastFallbackAt: expect.any(String) as unknown, lastFallbackReason: "MODEL_CALL_REFUSED" });
  });
});
