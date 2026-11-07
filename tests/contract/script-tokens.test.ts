// UX5b: script tokens. A signed-in person makes a token from a live browser session (shown once, only its hash stored), with a short default life and a hard cap; the creator, or an
// owner or admin of the company, revokes it at once. The token acts as its creator, only while the creator keeps the role they made it with, only on its projects, only with its
// permissions (read, start), and only on the closed list of task routes: everything else (tokens, members, roles, settings, decisions) is refused. It is rate limited and audited.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE, AuditEventInputSchema, developerOrgKey, editionPolicy, orgScriptTokensKey, scriptTokenKey, type OrgId } from "@agentx/contracts";
import { appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { scriptTokenRoute } from "../../packages/broker/src/script-tokens/authenticate.js";
import { hashScriptToken, parseScriptTokenHeader, scriptTokenMatches } from "../../packages/broker/src/script-tokens/token-format.js";
import { ScriptTokenRecordSchema, noteScriptTokenUse } from "../../packages/broker/src/script-tokens/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";

type Reply = { status: number; body: Record<string, unknown> };
const ORIGIN = new URL(DEV_ISSUER).origin;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;

beforeEach(() => { vi.stubEnv("SCRIPT_TOKENS_ENABLED", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function world(options: { brokerExtra?: Record<string, unknown>; developerExtra?: Record<string, unknown>; orgResolver?: OrgResolver } = {}) {
  const audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit, ...(options.brokerExtra === undefined ? {} : { brokerExtra: options.brokerExtra }), ...(options.developerExtra === undefined ? {} : { developerExtra: options.developerExtra }), ...(options.orgResolver === undefined ? {} : { orgResolver: options.orgResolver }) });
  const browserSessions = new Map<string, string>();
  const sessionOf = (who: Developer) => {
    let sid = browserSessions.get(who.developerId);
    if (sid === undefined) {
      sid = randomUUID();
      browserSessions.set(who.developerId, sid);
      // A sign-in made a moment ago (`authTime`): making a token needs a fresh one (review I2).
      h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: who.developerId, amr: who.provider, identityKey: `id-${who.developerId.slice(0, 8)}`, authTime: new Date(Date.now() - 30_000).toISOString(), startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    }
    return sid;
  };
  const send = async (headers: Record<string, string>, method: string, path: string, body?: unknown, routeKey?: string): Promise<Reply> => {
    const response = await h.handler({
      version: "2.0", ...(routeKey === undefined ? {} : { routeKey }), rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  /** The settings routes, from the person's live browser session (cookie, Origin and CSRF token). */
  const web = (who: Developer, method: string, path: string, body?: unknown) => {
    const sid = sessionOf(who);
    return send({ cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin", origin: ORIGIN, "x-rovara-csrf": appCsrfTokenFor(sid) }, method, path.replace("/v1/app/", "/v1/web/"), body, "ANY /v1/web/{proxy+}");
  };
  const script = (token: string, method: string, path: string, body?: unknown) => send({ authorization: `Bearer ${token}` }, method, path, body);
  const create = async (who: Developer = MAYA, extra: Record<string, unknown> = {}) => {
    const reply = await web(who, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "CI deploy", projects: ["payments"], permissions: ["read", "start"], ...extra });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return reply.body as { token: { tokenId: string; expiresAt: string; createdAt: string; hint: string; status: string }; secret: string };
  };
  const start = (token: string, project = "payments") => script(token, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project, instructions: "Fix the retry bug", client: "ci-script" });
  const record = (tokenId: string, orgId: OrgId = TEST_ORG) => h.db.get(scriptTokenKey(orgId, tokenId)) as Record<string, unknown>;
  const session = (who: Developer) => h.db.get(`SESSION#${sessionOf(who)}`, "META")!;
  return { ...h, audit, web, script, create, start, record, session };
}


describe("making a token", () => {
  it("shows the token once and stores only its hash, nowhere the token itself", async () => {
    const w = await world();
    const made = await w.create();
    expect(made.secret).toMatch(/^rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}$/);
    expect(made.token.hint).toBe(`rvst_…${made.token.tokenId.slice(4, 12)}`);
    const stored = w.record(made.token.tokenId);
    // Positive control: the record is there and holds the hash of exactly this token.
    expect(stored.secretHash).toBe(createHash("sha256").update(made.secret).digest("hex"));
    const secretPart = made.secret.split("_").at(-1)!;
    const everything = JSON.stringify(w.db.find(() => true));
    expect(everything).toContain(made.token.tokenId);
    expect(everything).not.toContain(made.secret);
    expect(everything).not.toContain(secretPart);
    expect(everything).not.toContain(Buffer.from(secretPart, "base64url").toString("hex"));
    expect(JSON.stringify(w.audit.recorded())).not.toContain(secretPart);
    // The list never shows it either.
    const listed = await w.web(MAYA, "GET", "/v1/app/script-tokens");
    expect(JSON.stringify(listed.body)).not.toContain(secretPart);
    expect((listed.body.tokens as Array<{ tokenId: string; mine: boolean; status: string }>)).toEqual([expect.objectContaining({ tokenId: made.token.tokenId, mine: true, status: "active" })]);
  });

  it("refuses a repeat of the request instead of showing the token again", async () => {
    const w = await world();
    const body = { requestId: randomUUID(), name: "CI", projects: ["payments"], permissions: ["read"] };
    expect((await w.web(MAYA, "POST", "/v1/app/script-tokens", body)).status).toBe(201);
    const again = await w.web(MAYA, "POST", "/v1/app/script-tokens", body);
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).not.toMatch(/rvst_[0-9a-z]{20}_/);
  });

  it("lives 30 days by default, at most 90, and never longer", async () => {
    const w = await world();
    const made = await w.create();
    expect(Date.parse(made.token.expiresAt) - Date.parse(made.token.createdAt)).toBe(30 * 86_400_000);
    const longest = await w.create(MAYA, { days: 90 });
    expect(Date.parse(longest.token.expiresAt) - Date.parse(longest.token.createdAt)).toBe(90 * 86_400_000);
    const tooLong = await w.web(MAYA, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "CI", projects: ["payments"], permissions: ["read"], days: 91 });
    expect(tooLong.status).toBe(400);
  });

  it("is only for a live browser session: a sign-in token (the CLI) and a script token can't make, list or revoke one", async () => {
    const w = await world();
    const made = await w.create();
    expect((await w.dev(MAYA, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "CLI", projects: ["payments"], permissions: ["read"] })).status).toBe(403);
    expect((await w.dev(MAYA, "GET", "/v1/app/script-tokens")).status).toBe(403);
    expect((await w.dev(MAYA, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`)).status).toBe(403);
    for (const [method, path] of [["POST", "/v1/app/script-tokens"], ["GET", "/v1/app/script-tokens"], ["DELETE", `/v1/app/script-tokens/${made.token.tokenId}`]] as const) {
      expect((await w.script(made.secret, method, path, { requestId: randomUUID(), name: "x", projects: ["payments"], permissions: ["read"] })).status, path).toBe(403);
    }
    expect(w.record(made.token.tokenId).revokedAt).toBeUndefined();
  });

  it("refuses a project the creator can't reach", async () => {
    const w = await world();
    const refused = await w.web(OMAR, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "CI", projects: ["payments"], permissions: ["read"] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(w.db.find((item) => item.entityType === "SCRIPT_TOKEN")).toEqual([]);
  });

  it("audits the creation with counts and fixed words only", async () => {
    const w = await world();
    const made = await w.create();
    const [event] = w.audit.recordedBy("script_token.created");
    expect(AuditEventInputSchema.parse(event)).toMatchObject({ target: { kind: "script_token", id: made.token.tokenId }, actor: { kind: "member", id: MAYA.developerId }, facts: { days: 30, projects: 1, permissions: "read,start" } });
  });
});

describe("using a token", () => {
  it("starts and reads the creator's task on its project, as the creator, and audits the day's use once", async () => {
    const w = await world();
    const made = await w.create();
    const started = await w.start(made.secret);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).toMatchObject({ developerId: MAYA.developerId, project: "payments" });
    const read = await w.script(made.secret, "GET", `/v1/dev/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect((await w.script(made.secret, "GET", `/v1/dev/tasks/${taskId}/events`)).status).toBe(200);
    expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(200);
    // One daily summary (no task named) and one event for the start, which names the task.
    const used = w.audit.recordedBy("script_token.used");
    expect(used.filter((event) => event.related === undefined)).toEqual([expect.objectContaining({ facts: { day: new Date().toISOString().slice(0, 10), permission: "start" } })]);
    expect(used.filter((event) => event.related?.includes(taskId))).toHaveLength(1);
    expect(used).toHaveLength(2);
    expect(w.record(made.token.tokenId).lastUsedAt).toEqual(expect.any(String));
  });

  it("refuses a token that doesn't match its hash, a malformed one, and one moved to another company", async () => {
    const w = await world();
    const made = await w.create();
    const parsed = parseScriptTokenHeader(`Bearer ${made.secret}`)!;
    const wrongSecret = `rvst_${parsed.orgId.slice(4)}_${parsed.tokenId.slice(4)}_${randomBytes(32).toString("base64url")}`;
    expect(scriptTokenMatches(wrongSecret, w.record(made.token.tokenId).secretHash)).toBe(false);
    expect((await w.start(wrongSecret)).status).toBe(401);
    expect((await w.start(`${made.secret}x`)).status).toBe(401);
    // The same token id and secret under another company's id: looked up in that company only, where nothing is.
    const elsewhere = made.secret.replace(`rvst_${TEST_ORG.slice(4)}_`, `rvst_${OTHER_ORG.slice(4)}_`);
    expect((await w.start(elsewhere)).status).toBe(401);
    // Even a copy of the record in the other company (planted) does not let the other company's key pass for this one: its hash is of a different token.
    w.db.set({ ...w.record(made.token.tokenId), ...scriptTokenKey(OTHER_ORG, made.token.tokenId), orgId: OTHER_ORG });
    expect((await w.start(elsewhere)).status).toBe(401);
    expect(hashScriptToken(elsewhere)).not.toBe(w.record(made.token.tokenId).secretHash);
  });

  it("refuses an expired token, and one stored with a life over the cap", async () => {
    const w = await world();
    const made = await w.create();
    const stored = w.record(made.token.tokenId);
    w.db.set({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await w.start(made.secret);
    expect(expired.status).toBe(401);
    expect(JSON.stringify(expired.body)).toContain("expired");
    w.db.set({ ...stored, createdAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    expect((await w.start(made.secret)).status).toBe(401);
    w.db.set(stored);
    expect((await w.start(made.secret)).status).toBe(200);
  });

  it("holds the token to its permissions and projects", async () => {
    const w = await world();
    const reader = await w.create(MAYA, { permissions: ["read"] });
    const startedBySession = await w.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "test" });
    const taskId = (startedBySession.body.task as { taskId: string }).taskId;
    const refusedStart = await w.start(reader.secret);
    expect(refusedStart.status).toBe(403);
    expect(JSON.stringify(refusedStart.body)).toContain(SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE);
    expect((await w.script(reader.secret, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
    // A list must name one of the token's projects.
    expect((await w.script(reader.secret, "GET", "/v1/dev/tasks")).status).toBe(403);
    expect((await w.script(reader.secret, "GET", "/v1/dev/tasks?project=billing")).status).toBe(403);
    const starter = await w.create(MAYA, { permissions: ["start"] });
    expect((await w.start(starter.secret, "billing")).status).toBe(403);
    expect((await w.script(starter.secret, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(403);
    // A task on a project the token doesn't name reads as missing.
    w.db.set({ ...w.db.get(`DEVTASK#${taskId}`, "META")!, project: "billing" });
    expect((await w.script(reader.secret, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(404);
  });

  it("is refused everywhere outside its closed list, before any route runs", async () => {
    const w = await world();
    const made = await w.create();
    const started = await w.start(made.secret);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const forbidden: Array<[string, string]> = [
      ["GET", "/v1/app/me"], ["GET", "/v1/app/org/members"], ["PATCH", `/v1/app/org/members/${OMAR.developerId}/role`], ["DELETE", `/v1/app/org/members/${OMAR.developerId}`],
      ["POST", "/v1/app/org/invites"], ["PUT", "/v1/dev/org/budget"], ["PATCH", "/v1/app/org"], ["GET", "/v1/app/org/audit"], ["PUT", "/v1/app/org/model-selection-policy"],
      ["POST", `/v1/dev/tasks/${taskId}/workflow/decision`], ["POST", `/v1/dev/tasks/${taskId}/cancel`], ["POST", `/v1/dev/tasks/${taskId}/people/take-ownership`], ["POST", "/v1/app/decisions/approve_request/apr_00000000000000000000/approve"],
      ["GET", "/v1/app/projects"], ["POST", "/v1/app/projects"], ["GET", "/v1/app/connections"], ["POST", "/v1/app/devices"], ["GET", "/v1/dev/projects"], ["POST", "/v1/app/realtime/token"],
    ];
    for (const [method, path] of forbidden) {
      const reply = await w.script(made.secret, method, path, { requestId: randomUUID() });
      expect(reply.status, `${method} ${path}`).toBe(403);
      // Either the token's own refusal, or a browser-only route's, which runs even before authentication.
      expect(JSON.stringify(reply.body), path).toMatch(path.includes("model-selection-policy") ? /live browser session/u : new RegExp(SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE.replace(/[.]/gu, "\\."), "u"));
    }
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("cancelledAt");
    // The list the guard holds, pinned: two task reads, the list, and the start.
    expect(scriptTokenRoute("GET", `/v1/dev/tasks/${taskId}`)).toEqual({ permission: "read", project: "task", taskId });
    expect(scriptTokenRoute("GET", `/v1/dev/tasks/${taskId}/events`)).toEqual({ permission: "read", project: "task", taskId });
    expect(scriptTokenRoute("GET", "/v1/dev/tasks")).toEqual({ permission: "read", project: "query" });
    expect(scriptTokenRoute("POST", "/v1/dev/tasks")).toEqual({ permission: "start", project: "body" });
    for (const [method, path] of [["GET", `/v1/dev/tasks/${taskId}/plan`], ["GET", `/v1/dev/tasks/${taskId}/people`], ["POST", `/v1/dev/tasks/${taskId}/continue`], ["DELETE", "/v1/dev/tasks"], ["GET", `/v1/dev/tasks/${taskId}/../x`]] as const) {
      expect(scriptTokenRoute(method, path), path).toBeUndefined();
    }
  });

  it("stops for good when the creator's role changes, even if it changes back (review M3), and Rovara's revoke is audited", async () => {
    const w = await world();
    const made = await w.create();
    expect((await w.start(made.secret)).status).toBe(200);
    seedMembership(w.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await w.start(made.secret)).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
    expect(typeof w.record(made.token.tokenId).revokedAt).toBe("string");
    expect(w.audit.recordedBy("script_token.revoked")[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, facts: { by: "access_changed" }, related: [MAYA.developerId] });
    seedMembership(w.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
    const back = await w.start(made.secret);
    expect(back.status).toBe(401);
    expect(JSON.stringify(back.body)).toContain("revoked");
  });

  it("stops for good when the creator leaves, and stays dead after they rejoin", async () => {
    const w = await world();
    const made = await w.create();
    w.db.delete(developerOrgKey(MAYA.developerId));
    expect((await w.start(made.secret)).status).toBe(401);
    seedMembership(w.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
    expect((await w.start(made.secret)).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
  });

  it("stops when an admin ends the creator's sign-ins", async () => {
    const w = await world();
    const made = await w.create();
    w.db.set({ ...w.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!, sessionsEndedAt: new Date(Date.now() + 1000).toISOString() });
    expect((await w.start(made.secret)).status).toBe(401);
  });

  it("is rate limited per token, on a fixed clock (review M7)", async () => {
    // The clock stands in the middle of a minute, so the window can't roll over during the test.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-07T12:00:30.000Z") });
    try {
      const w = await world();
      const made = await w.create();
      const window = Math.floor(Date.now() / 60_000) * 60_000;
      w.db.set({ pk: `ORG#${TEST_ORG}#SCRIPT_TOKEN_RATE`, sk: made.token.tokenId, windowStart: window, count: 60 });
      expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(429);
      const other = await w.create();
      expect((await w.script(other.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(200);
      // Review M2: a revoked token is rate limited too, before anything else is read.
      await w.web(MAYA, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`);
      expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits requests and starts across all of one person's tokens (review M1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-07T12:20:00.000Z") });
    try {
      const w = await world();
      const first = await w.create();
      const second = await w.create();
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      w.db.set({ pk: `ORG#${TEST_ORG}#SCRIPT_TOKEN_CREATOR_START_RATE`, sk: MAYA.developerId, windowStart: hour, count: 20 });
      expect((await w.start(first.secret)).status).toBe(429);
      expect((await w.start(second.secret)).status).toBe(429);
      expect((await w.script(second.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(200);
      w.db.set({ pk: `ORG#${TEST_ORG}#SCRIPT_TOKEN_CREATOR_RATE`, sk: MAYA.developerId, windowStart: minute, count: 120 });
      expect((await w.script(second.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused while the switch is off, and the settings routes are not found", async () => {
    const w = await world();
    const made = await w.create();
    vi.stubEnv("SCRIPT_TOKENS_ENABLED", "0");
    expect((await w.start(made.secret)).status).toBe(401);
    expect((await w.web(MAYA, "GET", "/v1/app/script-tokens")).status).toBe(404);
  });
});

describe("revoking a token", () => {
  it("the creator revokes their own; it stops at once and is audited", async () => {
    const w = await world();
    const made = await w.create();
    const revoked = await w.web(MAYA, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`);
    expect(revoked.status).toBe(200);
    expect((revoked.body.token as { status: string }).status).toBe("revoked");
    expect((await w.start(made.secret)).status).toBe(401);
    expect(w.db.get(orgScriptTokensKey(TEST_ORG, made.token.tokenId))).toHaveProperty("revokedAt");
    expect(w.audit.recordedBy("script_token.revoked")[0]).toMatchObject({ facts: { by: "creator" } });
  });

  it("an owner or admin revokes anyone's token in the company; a member can't revoke another's, or see it", async () => {
    const w = await world();
    const made = await w.create();
    const asMember = await w.web(OMAR, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`);
    expect(asMember.status).toBe(404);
    expect(((await w.web(OMAR, "GET", "/v1/app/script-tokens")).body.tokens as unknown[])).toEqual([]);
    expect((await w.start(made.secret)).status).toBe(200);
    seedMembership(w.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
    const listed = (await w.web(OMAR, "GET", "/v1/app/script-tokens")).body.tokens as Array<{ tokenId: string; mine: boolean; createdBy?: string }>;
    expect(listed).toEqual([expect.objectContaining({ tokenId: made.token.tokenId, mine: false, createdBy: MAYA.name })]);
    expect((await w.web(OMAR, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`)).status).toBe(200);
    expect((await w.start(made.secret)).status).toBe(401);
    expect(w.audit.recordedBy("script_token.revoked")[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { by: "admin" }, related: [MAYA.developerId] });
  });

  it("an admin of another company can't reach it", async () => {
    const w = await world();
    const made = await w.create();
    seedMembership(w.db, OMAR.developerId, { orgId: OTHER_ORG, role: "owner" });
    const reply = await w.web(OMAR, "DELETE", `/v1/app/script-tokens/${made.token.tokenId}`);
    expect(reply.status).not.toBe(200);
    expect(w.record(made.token.tokenId).revokedAt).toBeUndefined();
  });
});

describe("review fixes (UX5B-SCRIPT-TOKENS-REVIEW)", () => {
  it("I2: making a token needs a fresh sign-in", async () => {
    const w = await world();
    w.db.set({ ...w.session(MAYA), authTime: new Date(Date.now() - 60 * 60_000).toISOString() });
    const refused = await w.web(MAYA, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "CI", projects: ["payments"], permissions: ["read"] });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("REAUTH_REQUIRED");
    expect(w.db.find((item) => item.entityType === "SCRIPT_TOKEN")).toEqual([]);
  });

  it("I1: the method turned off and on again after the token was made ends it for good", async () => {
    const since = Math.floor(Date.now() / 1000) - 600;
    const w = await world({ developerExtra: { since: { slack: since } } });
    const made = await w.create();
    expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(200);
    w.db.set({ ...w.record(made.token.tokenId), createdAt: new Date((since - 600) * 1000).toISOString() });
    expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
  });

  it("I1: unlinking the sign-in method or the identity the token was made from ends it", async () => {
    const w = await world();
    const byMethod = await w.create();
    const byIdentity = await w.create();
    expect(w.record(byIdentity.token.tokenId).identityKey).toBe(w.session(MAYA).identityKey);
    const developer = () => w.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    w.db.set({ ...developer(), [`identityUnlinked#${String(w.session(MAYA).identityKey)}`]: new Date().toISOString() });
    expect((await w.script(byIdentity.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(401);
    // A token from before tokens recorded their identity is ended by the method's mark.
    const { identityKey: _dropped, ...legacy } = w.record(byMethod.token.tokenId);
    void _dropped;
    w.db.set(legacy);
    w.db.set({ ...developer(), "sessionsEndedByMethod#slack": new Date(Date.now() + 1000).toISOString() });
    expect((await w.script(byMethod.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(401);
  });

  it("I1: under an edition's session cap a token lives no longer than a session, and is refused past it", async () => {
    const w = await world({ brokerExtra: { editionPolicy: editionPolicy("enterprise") } });
    grantProject(w.db, OMAR, "payments");
    const made = await w.create(OMAR, { permissions: ["read"] });
    const cap = editionPolicy("enterprise").sessionMaxSeconds!;
    expect(Date.parse(made.token.expiresAt) - Date.parse(made.token.createdAt)).toBe(cap * 1000);
    expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(200);
    w.db.set({ ...w.record(made.token.tokenId), createdAt: new Date(Date.now() - (cap + 60) * 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await w.script(made.secret, "GET", "/v1/dev/tasks?project=payments")).status).toBe(401);
  });

  it("I1: a SAML cut-off after the token was made ends it; SAML settings that can't be read refuse it", async () => {
    let validFrom: number | undefined = Math.floor(Date.now() / 1000) - 3600;
    let fail = false;
    const sso = { saml: { config: { get: async () => { if (fail) throw new Error("unreadable"); return validFrom === undefined ? undefined : { sessionsValidFrom: validFrom }; } } } };
    const w = await world({ brokerExtra: { editionPolicy: editionPolicy("enterprise"), sso }, developerExtra: { methods: { slack: true, oidc: true, saml: true } } });
    grantProject(w.db, OMAR, "payments");
    const made = await w.create(OMAR, { permissions: ["read"] });
    // The token as one made from a SAML session would be stored.
    w.db.set({ ...w.record(made.token.tokenId), amr: "saml", authTime: new Date(Date.now() - 60_000).toISOString() });
    const read = () => w.script(made.secret, "GET", "/v1/dev/tasks?project=payments");
    expect((await read()).status).toBe(200);
    fail = true;
    expect((await read()).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedAt).toBeUndefined();
    fail = false;
    validFrom = Math.floor(Date.now() / 1000) + 5;
    expect((await read()).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
  });

  it("I3: a token's start carries the token's client name whatever the body says, and is audited with the task", async () => {
    const w = await world();
    const made = await w.create();
    const started = await w.script(made.secret, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).toMatchObject({ client: "Script token CI deploy" });
    const perStart = w.audit.recordedBy("script_token.used").filter((event) => event.related?.includes(taskId));
    expect(perStart).toHaveLength(1);
    expect(perStart[0]).toMatchObject({ target: { kind: "script_token", id: made.token.tokenId }, facts: { permission: "start" } });
  });

  it("I3: a body with two `project` keys starts only where the scope check looked", async () => {
    const w = await world();
    const made = await w.create();
    const raw = (first: string, last: string) => `{"requestId":"${randomUUID()}","project":"${first}","project":"${last}","instructions":"Fix it","client":"ci"}`;
    const send = (body: string) => w.handler({ version: "2.0", rawPath: "/v1/dev/tasks", rawQueryString: "", headers: { authorization: `Bearer ${made.secret}` }, body, requestContext: { requestId: randomUUID(), http: { method: "POST" } } });
    expect((await send(raw("payments", "billing"))).statusCode).toBe(403);
    const ok = await send(raw("billing", "payments"));
    expect(ok.statusCode).toBe(200);
    const taskId = (JSON.parse(ok.body) as { task: { taskId: string } }).task.taskId;
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).toMatchObject({ project: "payments" });
  });

  it("I4: if the day's audited use can't be written the request is refused (503) and does not run; the retry goes through", async () => {
    const w = await world();
    const made = await w.create();
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("lastUsedDay"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "ThrottlingError" }] } });
    const refused = await w.start(made.secret);
    expect(refused.status).toBe(503);
    expect(w.db.find((item) => item.entityType === "DEVELOPER_TASK" || (typeof item.pk === "string" && item.pk.startsWith("DEVTASK#")))).toEqual([]);
    expect(w.audit.recordedBy("script_token.used")).toEqual([]);
    expect((await w.start(made.secret)).status).toBe(200);
    expect(w.audit.recordedBy("script_token.used").length).toBeGreaterThanOrEqual(1);
  });

  it("I4: a start whose own audit event can't be written answers 503, and the same request again returns the task and audits it once", async () => {
    const w = await world();
    const made = await w.create();
    w.db.set({ ...w.record(made.token.tokenId), lastUsedDay: new Date().toISOString().slice(0, 10), lastUsedAt: new Date().toISOString() });
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => { const items = (input as { TransactItems?: unknown[] }).TransactItems ?? []; return items.length === 1 && JSON.stringify(items).includes("script_token.used"); }, error: { name: "ServiceUnavailable" } });
    const body = { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "ci" };
    expect((await w.script(made.secret, "POST", "/v1/dev/tasks", body)).status).toBe(503);
    const again = await w.script(made.secret, "POST", "/v1/dev/tasks", body);
    expect(again.status).toBe(200);
    const taskId = (again.body.task as { taskId: string }).taskId;
    expect(w.audit.recordedBy("script_token.used").filter((event) => event.related?.includes(taskId))).toHaveLength(1);
  });

  it("I4: with no audit ledger a token's use is refused", async () => {
    const w = await world();
    const made = await w.create();
    const record = w.record(made.token.tokenId);
    const store = { documentClient: w.db, tableName: "state", now: Date.now, log: () => undefined };
    await expect(noteScriptTokenUse(store, ScriptTokenRecordSchema.parse(record), "read")).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
  });

  it("M5: a take-back over the per-person limit is audited as a revoke", async () => {
    const w = await world();
    const first = await w.create();
    const template = w.record(first.token.tokenId);
    const plant = (index: number) => {
      const tokenId = `stk_${String(index).padStart(20, "0")}`;
      w.db.set({ ...template, ...scriptTokenKey(TEST_ORG, tokenId), tokenId });
      w.db.set({ ...orgScriptTokensKey(TEST_ORG, tokenId), entityType: "SCRIPT_TOKEN_ROW", orgId: TEST_ORG, tokenId, developerId: MAYA.developerId, createdAt: template.createdAt });
    };
    for (let index = 1; index <= 8; index += 1) plant(index);
    // A second request makes the tenth token at the same moment: this one's own count then finds eleven.
    let raced = false;
    const stop = w.db.onWrite(({ after }) => { if (!raced && after?.entityType === "SCRIPT_TOKEN_ROW" && !String(after.tokenId).startsWith("stk_000")) { raced = true; plant(9); } });
    const refused = await w.web(MAYA, "POST", "/v1/app/script-tokens", { requestId: randomUUID(), name: "Race", projects: ["payments"], permissions: ["read"] });
    stop();
    expect(refused.status).toBe(400);
    const takenBack = w.db.find((item) => item.entityType === "SCRIPT_TOKEN" && item.name === "Race");
    expect(takenBack).toHaveLength(1);
    expect(takenBack[0]).toHaveProperty("revokedAt");
    expect(w.audit.recordedBy("script_token.revoked").filter((event) => event.target.kind === "script_token" && (event.target as { id: string }).id === takenBack[0]!.tokenId)).toEqual([expect.objectContaining({ facts: { by: "limit" } })]);
  });

  it("refuses every look-alike of the closed list through the real handler", async () => {
    const w = await world();
    const made = await w.create();
    const started = await w.start(made.secret);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const tasksBefore = w.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("DEVTASK#") && item.sk === "META").length;
    const cases: Array<[string, string]> = [
      ["POST", "/v1/dev/tasks/"], ["GET", "/v1/dev/tasks/"], ["POST", "/V1/dev/tasks"], ["POST", "//v1/dev/tasks"], ["GET", `/v1/dev/tasks/%2e%2e/${taskId}`], ["GET", `/v1/dev/tasks/${encodeURIComponent(taskId).replace("-", "%2D")}`],
      ["HEAD", `/v1/dev/tasks/${taskId}`], ["OPTIONS", "/v1/dev/tasks"], ["POST", "/v1/app/tasks"], ["GET", `/v1/app/tasks/${taskId}`], ["POST", "/v1/web/tasks"], ["GET", `/review/${taskId}/task`], ["POST", "/v1/service/tasks"],
    ];
    for (const [method, path] of cases) {
      const reply = await w.script(made.secret, method, path, { requestId: randomUUID(), project: "payments", instructions: "x", client: "ci" });
      expect(reply.status, `${method} ${path}`).toBeGreaterThanOrEqual(300);
    }
    expect(w.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(tasksBefore);
  });

  it("a token header beside a browser cookie never stands in for the cookie's CSRF token", async () => {
    const w = await world();
    const made = await w.create();
    const sid = String(w.session(MAYA).sessionId);
    const response = await w.handler({
      version: "2.0", routeKey: "ANY /v1/web/{proxy+}", rawPath: "/v1/web/script-tokens", rawQueryString: "",
      headers: { authorization: `Bearer ${made.secret}`, cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin", origin: ORIGIN },
      body: JSON.stringify({ requestId: randomUUID(), name: "x", projects: ["payments"], permissions: ["read"] }), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.db.find((item) => item.entityType === "SCRIPT_TOKEN")).toHaveLength(1);
  });

  it("the creator losing project access refuses a start; their own task still reads", async () => {
    const w = await world();
    const made = await w.create();
    const started = await w.start(made.secret);
    const taskId = (started.body.task as { taskId: string }).taskId;
    w.channelMembers.mockImplementation(async () => ({ ok: true, memberOf: [] }));
    expect((await w.start(made.secret)).status).toBe(403);
    expect((await w.script(made.secret, "GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
  });

  it("org close: the company's tokens stop at once, are revoked, and every route refuses them", async () => {
    // Maya is the company's only member (Omar is in another company), so her leaving closes it.
    const w = await world({ orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? OTHER_ORG : TEST_ORG), brokerExtra: { cloud: true } });
    await w.orgOf(MAYA);
    seedMembership(w.db, MAYA.developerId, { orgId: TEST_ORG, role: "owner" });
    const made = await w.create();
    const started = await w.start(made.secret);
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const left = await w.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    for (const [method, path, body] of [["POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x", client: "ci" }], ["GET", `/v1/dev/tasks/${taskId}`, undefined], ["GET", `/v1/dev/tasks/${taskId}/events`, undefined], ["GET", "/v1/dev/tasks?project=payments", undefined]] as const) {
      expect((await w.script(made.secret, method, path, body)).status, `${method} ${path}`).toBe(401);
    }
    // The first refusal revoked it (its creator is no longer a member), so it stays dead even if the company were reopened.
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
  });

  it("account merge: the merged-away account's tokens stop and are revoked; they never follow the surviving account", async () => {
    const w = await world();
    const made = await w.create();
    expect((await w.start(made.secret)).status).toBe(200);
    // What a merge writes on the duplicate's record (developer/store.ts mergeItems): mergedInto, and sessionsEndedAt at the merge, which ends every session of the duplicate.
    const at = new Date(Date.now() + 1000).toISOString();
    w.db.set({ ...w.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!, mergedInto: OMAR.developerId, mergedAt: at, sessionsEndedAt: at });
    expect((await w.start(made.secret)).status).toBe(401);
    expect(w.record(made.token.tokenId).revokedBy).toBe("rovara");
    // The token's record still names the old account: nothing moves it to the survivor, so the survivor gains no token from the merge.
    expect(w.record(made.token.tokenId).developerId).toBe(MAYA.developerId);
    expect((await w.web(OMAR, "GET", "/v1/app/script-tokens")).body.tokens).toEqual([]);
  });
});
