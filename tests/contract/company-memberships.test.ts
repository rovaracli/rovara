// Company memberships (srv/company-memberships; briefs/company-memberships-api.md; DEFERRED COMPANIES-HEADER-REQUIREMENT-FOLLOWS-FLAG): the caller's own companies, the browser session's switch, the session's
// active company re-checked on every request, and the `x-rovara-company` header that only narrows. The real OrgStore, the real web boundary and the real dispatcher over FakeDynamoDb; one table plays the State
// table and the sign-in table. A second membership is seeded as the per-membership pointer the brief's step 2 will write (nothing writes one yet).
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_STALE_MESSAGE, COMPANY_SWITCH_MACHINE_MESSAGE, CompaniesAnswerSchema, CompanySwitchAnswerSchema, editionPolicy, orgBanKey, orgMemberKey, orgMetaKey, orgRemovedKey, orgUiFlagsKey, type EditionPolicy, type OrgRole } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { COMPANY_SWITCHES_PER_HOUR, SWITCH_NOT_ON_MESSAGE, routeCompanies } from "../../packages/broker/src/aws/developer-routes/companies.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { authenticateWebRequest, webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { SESSION_COOKIE } from "../../packages/broker/src/aws/web-session.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { AUDITOR_ALLOWED_ROUTES } from "../../packages/broker/src/org/auditor.js";
import { withCompanyEcho } from "../../packages/broker/src/org/companies/echo.js";
import { activeCompanyKey, clearCompanyReload, developerMembershipKey } from "../../packages/broker/src/org/companies/memberships.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const T = "state";
const ORIGIN = "https://cell.test";
const ISSUER = `${ORIGIN}/v1/auth`;
const START = Date.UTC(2026, 10, 12, 9, 0, 0);
const hex = (digit: string) => digit.repeat(64);
const OWNER_A = hex("1"), OWNER_B = hex("2"), OWNER_C = hex("3"), PAT = hex("4"), SOLO = hex("5"), AUDITOR = hex("6");
const ENTERPRISE = editionPolicy("enterprise");
const GHOST = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;

type Json = Record<string, unknown>;
interface Me { developer: { id: string; orgRole: string }; org: { orgId: string; name: string } }

beforeEach(() => { vi.stubEnv("COMPANY_SWITCHER_ENABLED", "1"); vi.stubEnv("UI_FLAGS_FORCE_OFF", "none"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function world(options: { policy?: EditionPolicy; /** The three companies' `companies` flag on (the default: a switch needs it on both sides). */ flags?: boolean } = {}) {
  const clock = { now: START };
  const db = new FakeDynamoDb();
  /** Runs once, just before the next transaction is sent (a removal or another tab landing in between). */
  const before: { transaction?: () => void } = {};
  const client = { send: async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === "TransactWriteCommand" && before.transaction !== undefined) { const run = before.transaction;delete before.transaction;run(); }
    return db.send(command as never);
  } };
  const orgs = new OrgStore({ documentClient: client, tableName: T, now: () => clock.now });
  const person = (developerId: string, name: string) => db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider: "oidc", displayName: name, revoked: false });
  for (const [id, name] of [[OWNER_A, "Ann"], [OWNER_B, "Ben"], [OWNER_C, "Cat"], [PAT, "Pat"], [SOLO, "Sol"], [AUDITOR, "Aud"]] as const) person(id, name);
  const A = await orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER_A });
  const B = await orgs.createOrgWithOwner({ name: "Beta Ltd", developerId: OWNER_B });
  const C = await orgs.createOrgWithOwner({ name: "Gamma", developerId: OWNER_C });
  await orgs.addMember({ orgId: A, developerId: PAT, role: "owner" });
  await orgs.addMember({ orgId: A, developerId: SOLO, role: "member" });
  /** A second membership, as the brief's step 2 would write it: the company's member record and the person's per-membership pointer. */
  const second = (developerId: string, orgId: OrgId, role: OrgRole) => {
    const joinedAt = new Date(clock.now).toISOString();
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt });
    db.set({ ...developerMembershipKey(developerId, orgId), entityType: "DEVELOPER_ORG", orgId, role, joinedAt });
  };
  second(PAT, B, "member");
  /** What a removal from a second company leaves (the member record and the pointer gone, the removal recorded, maybe a ban). */
  const removeSecond = (developerId: string, orgId: OrgId, ban = false) => {
    db.delete(orgMemberKey(orgId, developerId));db.delete(developerMembershipKey(developerId, orgId));
    db.set({ ...orgRemovedKey(orgId, developerId), entityType: "ORG_REMOVED", orgId, developerId, removedAt: new Date(clock.now).toISOString() });
    if (ban) db.set({ ...orgBanKey(orgId, developerId), entityType: "ORG_BAN", orgId, developerId });
  };
  const session = (developerId: string) => {
    const id = randomUUID(), seconds = Math.floor(clock.now / 1000);
    db.set({ pk: `SESSION#${id}`, sk: "META", entityType: "SESSION", sessionId: id, developerId, amr: "oidc", startedAt: new Date(clock.now).toISOString(), endsAt: seconds + 86_400, reviewExpiresAt: seconds + 86_400 });
    return id;
  };
  const tokens = new Map<string, Json>();
  const deps = {
    documentClient: client, tableName: T, now: () => clock.now, orgs, editionPolicy: options.policy ?? ENTERPRISE,
    developer: { issuer: ISSUER, env: "test", methods: { oidc: true }, signInTableName: T, verifyAccessToken: async (header: string) => tokens.get(header) },
  } as unknown as DeveloperRouteDependencies;
  const browserRequest = (sid: string, method: string, path: string, options: { body?: unknown; company?: string } = {}): AdaptedHttpRequest => ({
    method, path, requestId: "r", ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: { cookie: `${SESSION_COOKIE}=${sid}`, "sec-fetch-site": "same-origin", origin: ORIGIN, [APP_CSRF_HEADER]: appCsrfTokenFor(sid), ...(options.company === undefined ? {} : { "x-rovara-company": options.company }) },
  });
  /** One browser request through the web boundary and the dispatcher, as the handler sends it. */
  const web = async <R = Json>(sid: string, method: string, path: string, options: { body?: unknown; company?: string } = {}): Promise<R> => {
    if (!webRouteAllowed(method, path)) throw Object.assign(new Error("route not found"), { code: "NOT_FOUND" });
    const request = browserRequest(sid, method, path, options);
    const caller = await authenticateWebRequest(deps, request);
    const url = new URL(ORIGIN + path);url.pathname = "/v1/app/" + url.pathname.slice("/v1/web/".length);
    return await routeDeveloperRequest(deps, request, url, { caller, csrf: appCsrfTokenFor(sid) }) as R;
  };
  /** A sign-in token's request (the CLI, MCP): bound to the company it was issued for. */
  const token = async <R = Json>(developerId: string, orgId: OrgId, role: OrgRole, method: string, path: string, body?: unknown): Promise<R> => {
    const sid = session(developerId), header = `Bearer t-${sid}`;
    tokens.set(header, { iss: ISSUER, aud: "agentx-developer", env: "test", sub: developerId, sid, amr: "oidc", org: orgId, org_role: role });
    const request: AdaptedHttpRequest = { method, path, requestId: "r", headers: { authorization: header }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return await routeDeveloperRequest(deps, request, new URL(ORIGIN + path)) as R;
  };
  /** The company the session is in now, read from the store (no request, so no reload marker is cleared). */
  const current = (sid: string): string => {
    const chosen = db.get(activeCompanyKey(sid)) as { orgId?: string } | undefined;
    if (chosen?.orgId !== undefined) return chosen.orgId;
    const developerId = (db.get({ pk: `SESSION#${sid}`, sk: "META" }) as { developerId: string }).developerId;
    return (db.get({ pk: `DEVELOPER_ORG#${developerId}`, sk: "ORG" }) as { orgId: string }).orgId;
  };
  /** A switch as the web app sends it: naming the page's company (the session's, unless a test says otherwise; `null` sends none). */
  const switchTo = (sid: string, companyId: string, options: { requestId?: string; company?: string | null } = {}) => {
    const company = options.company === undefined ? current(sid) : options.company;
    return web<Json>(sid, "POST", "/v1/web/companies", { body: { action: "switch", companyId, requestId: options.requestId ?? randomUUID() }, ...(company === null ? {} : { company }) });
  };
  const me = (sid: string, company?: string) => web<Me>(sid, "GET", "/v1/web/me", company === undefined ? {} : { company });
  const companiesFlag = (orgId: OrgId, state: "on" | "preview" | "off") => db.set({ ...orgUiFlagsKey(orgId), entityType: "UI_FLAGS", flags: { companies: state === "on" }, previews: state === "preview", revision: 1, changedAt: new Date(clock.now).toISOString() });
  const binding = (sid: string) => db.get(activeCompanyKey(sid));
  if (options.flags !== false) for (const orgId of [A, B, C]) companiesFlag(orgId, "on");
  /** The web boundary alone (no route): what a request is let through with. */
  const authenticate = (sid: string, method: string, path: string, company?: string) => authenticateWebRequest(deps, browserRequest(sid, method, path, company === undefined ? {} : { company }));
  const authenticateWrite = (sid: string, company?: string) => authenticate(sid, "PUT", "/v1/web/me/name", company);
  return { current, authenticate, authenticateWrite, db, clock, deps, orgs, A, B, C, second, removeSecond, session, web, token, switchTo, me, companiesFlag, binding, before, browserRequest };
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => { try { await promise;return undefined; } catch (error) { return (error as { code?: string }).code; } };
/** The sentence the caller is shown (the error's message without its code prefix). */
const messageOf = async (promise: Promise<unknown>): Promise<string | undefined> => { try { await promise;return undefined; } catch (error) { return (error as Error).message.replace(/^[A-Z_]+: /u, ""); } };

describe("with the server switch off (cw absent, the default)", () => {
  it("answers both methods as an unknown path, ignores a session's chosen company, and never reads the header", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    expect((await w.me(sid)).org.orgId).toBe(w.B);
    vi.stubEnv("COMPANY_SWITCHER_ENABLED", "0");
    for (const value of ["0", "", "true", " 1"]) {
      vi.stubEnv("COMPANY_SWITCHER_ENABLED", value);
      expect(await codeOf(w.web(sid, "GET", "/v1/web/companies"))).toBe("NOT_FOUND");
      expect(await codeOf(w.switchTo(sid, w.A))).toBe("NOT_FOUND");
      // The session is in its primary company, whatever its item says; a header naming any company is not read.
      expect((await w.me(sid)).org.orgId).toBe(w.A);
      expect((await w.me(sid, w.C)).org.orgId).toBe(w.A);
      expect((await w.me(sid, "not-a-company")).org.orgId).toBe(w.A);
    }
    // A token is refused nothing new either.
    expect(await codeOf(w.token(PAT, w.A, "owner", "POST", "/v1/app/companies", { action: "switch", companyId: w.B, requestId: randomUUID() }))).toBe("NOT_FOUND");
  });
});

describe("the browser route shape", () => {
  it("lets exactly GET and POST /v1/web/companies through the web boundary", () => {
    expect(webRouteAllowed("GET", "/v1/web/companies")).toBe(true);
    expect(webRouteAllowed("POST", "/v1/web/companies")).toBe(true);
    for (const [method, path] of [["DELETE", "/v1/web/companies"], ["PUT", "/v1/web/companies"], ["GET", "/v1/web/companies/org_aaaaaaaaaaaaaaaaaaaa"], ["POST", "/v1/web/companies/switch"], ["GET", "/v1/web/companiesx"]] as const) expect(webRouteAllowed(method, path), `${method} ${path}`).toBe(false);
  });
});

describe("GET /v1/app/companies: the caller's own memberships", () => {
  it("lists one company for a person with one membership, exactly as the UI's reader expects", async () => {
    const w = await world();
    const answer = await w.web(w.session(SOLO), "GET", "/v1/web/companies");
    const parsed = CompaniesAnswerSchema.parse(answer);
    expect(parsed).toEqual({ activeCompanyId: w.A, companies: [{ companyId: w.A, name: "Acme", role: "member", joinedAt: parsed.companies[0]!.joinedAt, active: true, status: "open" }], limits: { maxCompanies: 20 }, canCreate: false, canJoinByInvite: false });
    expect(Number.isFinite(Date.parse(parsed.companies[0]!.joinedAt))).toBe(true);
  });

  it("lists every live membership with the role in THAT company, the active one first, and nothing about anyone else", async () => {
    const w = await world();
    const answer = CompaniesAnswerSchema.parse(await w.web(w.session(PAT), "GET", "/v1/web/companies"));
    expect(answer.companies.map((company) => [company.companyId, company.name, company.role, company.active])).toEqual([[w.A, "Acme", "owner", true], [w.B, "Beta Ltd", "member", false]]);
    // No other person's id or name, and no company the person is not in.
    const text = JSON.stringify(answer);
    for (const other of [OWNER_A, OWNER_B, OWNER_C, "Ann", "Ben", w.C, "Gamma"]) expect(text).not.toContain(other);
  });

  it("leaves out a company that removed, banned or closed on the person, an unreadable role, and an Auditor seat the edition does not have", async () => {
    const w = await world();
    w.second(PAT, w.C, "admin");
    const listed = async () => CompaniesAnswerSchema.parse(await w.web(w.session(PAT), "GET", "/v1/web/companies")).companies.map((company) => company.companyId);
    expect(await listed()).toEqual([w.A, w.B, w.C]);
    w.db.set({ ...orgBanKey(w.C, PAT), entityType: "ORG_BAN" });
    expect(await listed()).toEqual([w.A, w.B]);
    w.db.delete(orgBanKey(w.C, PAT));
    w.db.set({ ...w.db.get(orgMetaKey(w.C))!, closedAt: new Date(START).toISOString() });
    expect(await listed()).toEqual([w.A, w.B]);
    w.db.set({ ...w.db.get(orgMemberKey(w.B, PAT))!, role: "superuser" });
    expect(await listed()).toEqual([w.A]);
    const pub = await world({ policy: { ...ENTERPRISE, features: { ...ENTERPRISE.features, auditorRole: false } } });
    pub.second(PAT, pub.C, "auditor");
    expect(CompaniesAnswerSchema.parse(await pub.web(pub.session(PAT), "GET", "/v1/web/companies")).companies.map((company) => company.companyId)).toEqual([pub.A, pub.B]);
  });

  it("marks a company whose last owner is leaving as closing", async () => {
    const w = await world();
    w.db.set({ ...w.db.get(orgMetaKey(w.B))!, closingAt: new Date(START).toISOString() });
    const answer = CompaniesAnswerSchema.parse(await w.web(w.session(PAT), "GET", "/v1/web/companies"));
    expect(answer.companies.find((company) => company.companyId === w.B)?.status).toBe("closing");
  });

  it("answers a token for the one company it is bound to, never the person's others", async () => {
    const w = await world();
    const answer = CompaniesAnswerSchema.parse(await w.token(PAT, w.A, "owner", "GET", "/v1/app/companies"));
    expect(answer.companies.map((company) => company.companyId)).toEqual([w.A]);
    expect(answer.activeCompanyId).toBe(w.A);
  });

  it("is on the Auditor's allow-list (both methods), and nothing else new is", async () => {
    expect(AUDITOR_ALLOWED_ROUTES.filter((route) => route.path.test("/v1/app/companies")).map((route) => route.method).sort()).toEqual(["GET", "POST"]);
    for (const path of ["/v1/app/companies/x", "/v1/app/companies/", "/v1/web/companies"]) expect(AUDITOR_ALLOWED_ROUTES.some((route) => route.path.test(path)), path).toBe(false);
  });
});

describe("POST /v1/app/companies: switching the browser session's company", () => {
  it("moves the session to a company the person is a live member of, with that company's role, and answers the list and me for it", async () => {
    const w = await world();
    const sid = w.session(PAT);
    const pending = () => w.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING")).length;
    const ledgerBefore = pending();
    const answer = CompanySwitchAnswerSchema.parse(await w.switchTo(sid, w.B, { company: w.A }));
    expect(answer.activeCompanyId).toBe(w.B);
    expect(answer.companies.map((company) => [company.companyId, company.active])).toEqual([[w.B, true], [w.A, false]]);
    expect((answer.me as Me).org.orgId).toBe(w.B);
    expect((answer.me as Me).developer.orgRole).toBe("member");
    const now = await w.me(sid, w.B);
    expect([now.org.orgId, now.developer.orgRole]).toEqual([w.B, "member"]);
    // Recorded in the session's own record only (owner decision 91), never in a company's ledger.
    expect(w.binding(sid)).toMatchObject({ orgId: w.B, developerId: PAT, revision: 1, switches: 1 });
    expect(pending()).toBe(ledgerBefore);
    // Back again: the owner role of the first company returns with it.
    await w.switchTo(sid, w.A, { company: w.B });
    expect((await w.me(sid, w.A)).developer.orgRole).toBe("owner");
    expect(w.binding(sid)).toMatchObject({ orgId: w.A, revision: 2, switches: 2 });
  });

  it("changes only THIS session: another session of the same person stays where it was", async () => {
    const w = await world();
    const one = w.session(PAT), two = w.session(PAT);
    await w.switchTo(one, w.B);
    expect((await w.me(one)).org.orgId).toBe(w.B);
    expect((await w.me(two)).org.orgId).toBe(w.A);
  });

  it("keys the session's item by a hash of the session id, never the cookie value itself", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    expect(w.db.find((item) => JSON.stringify(item).includes(sid)).map((item) => item.pk)).toEqual([`SESSION#${sid}`]);
  });

  it("refuses a company the person is not in, and one that does not exist, with the same answer", async () => {
    const w = await world();
    const sid = w.session(PAT);
    const notMine = await messageOf(w.switchTo(sid, w.C)), ghost = await messageOf(w.switchTo(sid, GHOST));
    expect(await codeOf(w.switchTo(sid, w.C))).toBe("NOT_FOUND");
    expect(await codeOf(w.switchTo(sid, GHOST))).toBe("NOT_FOUND");
    expect(notMine).toBe(ghost);
    expect(notMine).not.toContain(w.C);
    expect(w.binding(sid)).toBeUndefined();
    // A member record without a pointer that names the company is not a membership (the pointer is part of it).
    w.db.set({ ...orgMemberKey(w.C, PAT), entityType: "ORG_MEMBER", orgId: w.C, developerId: PAT, role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" });
    expect(await codeOf(w.switchTo(sid, w.C))).toBe("NOT_FOUND");
  });

  it("refuses a company that removed or banned the person with REMOVED_FROM_ORG, and a closed one as not found", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.removeSecond(PAT, w.B);
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("REMOVED_FROM_ORG");
    const banned = await world();
    banned.removeSecond(PAT, banned.B, true);
    expect(await codeOf(banned.switchTo(banned.session(PAT), banned.B))).toBe("REMOVED_FROM_ORG");
    // A ban on its own (the member record still there) is refused too.
    const ban = await world();
    ban.db.set({ ...orgBanKey(ban.B, PAT), entityType: "ORG_BAN" });
    expect(await codeOf(ban.switchTo(ban.session(PAT), ban.B))).toBe("NOT_FOUND");
    const closed = await world();
    closed.db.set({ ...closed.db.get(orgMetaKey(closed.B))!, closedAt: new Date(START).toISOString() });
    expect(await codeOf(closed.switchTo(closed.session(PAT), closed.B))).toBe("NOT_FOUND");
  });

  it("is browser-only: a token is refused before anything is read or written", async () => {
    const w = await world();
    const before = w.db.commandNames().length, writes = w.db.transactions().length;
    expect(await codeOf(w.token(PAT, w.A, "owner", "POST", "/v1/app/companies", { action: "switch", companyId: w.B, requestId: randomUUID() }))).toBe("FORBIDDEN");
    expect(await messageOf(w.token(PAT, w.A, "owner", "POST", "/v1/app/companies", { action: "switch", companyId: w.B, requestId: randomUUID() }))).toBe(COMPANY_SWITCH_MACHINE_MESSAGE);
    expect(w.db.find((item) => String(item.pk).startsWith("WEB_ACTIVE_COMPANY#") || String(item.pk).startsWith("COMPANY_SWITCH"))).toEqual([]);
    expect(w.db.transactions().length).toBe(writes);
    // Nothing of the companies was read for the refused token: the refusal comes before any company read (only the token's own sign-in checks ran).
    expect(w.db.commandNames().slice(before).filter((name) => name === "QueryCommand" || name === "TransactWriteCommand")).toEqual([]);
  });

  it("refuses a token at each layer on its own: the dispatcher before the token is even checked, and the route itself", async () => {
    const w = await world();
    const request: AdaptedHttpRequest = { method: "POST", path: "/v1/app/companies", requestId: "r", headers: { authorization: "Bearer unknown" }, body: JSON.stringify({ action: "switch", companyId: w.B, requestId: randomUUID() }) };
    // A token that does not verify would be AUTH_REQUIRED; the dispatcher refuses the write first.
    expect(await codeOf(routeDeveloperRequest(w.deps, request, new URL(ORIGIN + "/v1/app/companies")))).toBe("FORBIDDEN");
    const tokenCaller = { developerId: PAT, sessionId: randomUUID(), amr: "oidc" as const, name: "Pat", orgId: w.A, orgRole: "owner" as const };
    expect(await codeOf(routeCompanies(w.deps, tokenCaller, request, "/v1/app/companies"))).toBe("FORBIDDEN");
  });

  it("refuses a body it does not take", async () => {
    const w = await world();
    const sid = w.session(PAT);
    for (const body of [{ action: "join", inviteToken: "x", requestId: randomUUID() }, { action: "switch", companyId: w.B }, { action: "switch", companyId: "org_X", requestId: randomUUID() }, { action: "switch", companyId: w.B, requestId: randomUUID(), extra: 1 }]) {
      expect(await codeOf(w.web(sid, "POST", "/v1/web/companies", { body, company: w.A })), JSON.stringify(body)).toBe("CONFIG_INVALID");
    }
  });

  it("is idempotent: a repeat writes nothing and answers the session as it is now; the same request id for another company is a conflict", async () => {
    const w = await world();
    const sid = w.session(PAT), requestId = randomUUID();
    await w.switchTo(sid, w.B, { requestId });
    const writes = w.db.transactions().length;
    const repeat = CompanySwitchAnswerSchema.parse(await w.switchTo(sid, w.B, { requestId }));
    expect(repeat.activeCompanyId).toBe(w.B);
    expect(w.db.transactions().length).toBe(writes);
    expect(w.binding(sid)).toMatchObject({ revision: 1 });
    expect(await codeOf(w.switchTo(sid, w.A, { requestId }))).toBe("IDEMPOTENCY_CONFLICT");
    // A late repeat after a switch back changes nothing: the session stays where the later switch put it.
    await w.switchTo(sid, w.A);
    expect(CompanySwitchAnswerSchema.parse(await w.switchTo(sid, w.B, { requestId })).activeCompanyId).toBe(w.A);
    expect((await w.me(sid)).org.orgId).toBe(w.A);
    // The same request id from another session of the same person is a different request body: a conflict, never that session's switch.
    expect(await codeOf(w.switchTo(w.session(PAT), w.B, { requestId }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it(`allows ${String(COMPANY_SWITCHES_PER_HOUR)} switches an hour per person, then refuses`, async () => {
    const w = await world();
    const sid = w.session(PAT);
    for (let index = 0; index < COMPANY_SWITCHES_PER_HOUR; index += 1) await w.switchTo(sid, index % 2 === 0 ? w.B : w.A);
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("TOO_MANY_REQUESTS");
    w.clock.now += 3_600_000;
    expect(await codeOf(w.switchTo(sid, w.B))).toBeUndefined();
  });

  it("holds what it read for the write: a removal landing between the check and the write refuses the switch and leaves the session where it was", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.before.transaction = () => { w.removeSecond(PAT, w.B); };
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("REMOVED_FROM_ORG");
    expect(w.binding(sid)).toBeUndefined();
    expect((await w.me(sid)).org.orgId).toBe(w.A);
    // A role change in between is refused too (the switch never carries a role it did not check).
    const r = await world();
    const rsid = r.session(PAT);
    r.before.transaction = () => { r.db.set({ ...r.db.get(orgMemberKey(r.B, PAT))!, role: "admin" }); };
    expect(await codeOf(r.switchTo(rsid, r.B))).toBe("NOT_FOUND");
    expect(r.binding(rsid)).toBeUndefined();
  });

  it.each([
    ["a ban", (w: Awaited<ReturnType<typeof world>>) => { w.db.set({ ...orgBanKey(w.B, PAT), entityType: "ORG_BAN" }); }],
    ["the pointer gone", (w: Awaited<ReturnType<typeof world>>) => { w.db.delete(developerMembershipKey(PAT, w.B)); }],
    ["the company closed", (w: Awaited<ReturnType<typeof world>>) => { w.db.set({ ...w.db.get(orgMetaKey(w.B))!, closedAt: new Date(START).toISOString() }); }],
  ] as const)("refuses the switch when %s lands between the check and the write", async (_label, lose) => {
    const w = await world();
    const sid = w.session(PAT);
    w.before.transaction = () => { lose(w); };
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("NOT_FOUND");
    expect(w.binding(sid)).toBeUndefined();
  });

  it("fences on the session's item: another tab's switch landing in between gives CHANGE_STALE, never a silent overwrite", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    w.before.transaction = () => { w.db.set({ ...w.binding(sid)!, orgId: w.A, revision: 2 }); };
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("CHANGE_STALE");
    expect(w.binding(sid)).toMatchObject({ orgId: w.A, revision: 2 });
  });

  it("lets the Auditor switch, and the Auditor's seat holds it to the audit log inside that company", async () => {
    const w = await world();
    w.second(PAT, w.C, "auditor");
    const sid = w.session(PAT);
    await w.switchTo(sid, w.C);
    expect(CompaniesAnswerSchema.parse(await w.web(sid, "GET", "/v1/web/companies", { company: w.C })).activeCompanyId).toBe(w.C);
    expect(await codeOf(w.web(sid, "GET", "/v1/web/projects", { company: w.C }))).toBe("FORBIDDEN");
    // And back to where the person is an owner.
    await w.switchTo(sid, w.A, { company: w.C });
    expect((await w.me(sid, w.A)).developer.orgRole).toBe("owner");
  });

  it("never carries a role across companies: an owner in one is a member in the other", async () => {
    const w = await world();
    const sid = w.session(PAT);
    expect(await codeOf(w.web(sid, "GET", "/v1/web/org/ui-flags", { company: w.A }))).toBeUndefined();
    await w.switchTo(sid, w.B);
    expect(await codeOf(w.web(sid, "GET", "/v1/web/org/ui-flags", { company: w.B }))).toBe("FORBIDDEN");
  });
});

describe("the session's active company, re-checked on every request", () => {
  it("drops a company the person was removed from at once: the next request is in the primary, the item names the primary, and a re-invite does not move the session back", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    w.removeSecond(PAT, w.B);
    // A page that still names the lost company is told to reload; the reload lands in the primary.
    expect(await codeOf(w.me(sid, w.B))).toBe("CSRF_STALE");
    expect(w.binding(sid)).toMatchObject({ orgId: w.A, reloadNeeded: true });
    expect((await w.me(sid)).org.orgId).toBe(w.A);
    expect(CompaniesAnswerSchema.parse(await w.web(sid, "GET", "/v1/web/companies")).companies.map((company) => company.companyId)).toEqual([w.A]);
    w.second(PAT, w.B, "member");
    expect((await w.me(sid)).org.orgId).toBe(w.A);
  });

  it("drops a company that banned the person, or closed, the same way", async () => {
    for (const lose of ["ban", "close"] as const) {
      const w = await world();
      const sid = w.session(PAT);
      await w.switchTo(sid, w.B);
      if (lose === "ban") w.db.set({ ...orgBanKey(w.B, PAT), entityType: "ORG_BAN" });
      else w.db.set({ ...w.db.get(orgMetaKey(w.B))!, closedAt: new Date(START).toISOString() });
      expect((await w.me(sid)).org.orgId, lose).toBe(w.A);
    }
  });

  it("re-reads the role: a demotion inside the active company applies on the next request", async () => {
    const w = await world();
    w.second(PAT, w.C, "admin");
    const sid = w.session(PAT);
    await w.switchTo(sid, w.C);
    expect((await w.me(sid)).developer.orgRole).toBe("admin");
    w.db.set({ ...w.db.get(orgMemberKey(w.C, PAT))!, role: "member" });
    expect((await w.me(sid)).developer.orgRole).toBe("member");
  });

  it("never follows an item to a company whose member record exists but no pointer of the person names it", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.db.set({ ...orgMemberKey(w.C, PAT), entityType: "ORG_MEMBER", orgId: w.C, developerId: PAT, role: "admin", joinedAt: "2026-11-01T00:00:00.000Z" });
    w.db.set({ ...activeCompanyKey(sid), entityType: "WEB_ACTIVE_COMPANY", orgId: w.C, developerId: PAT, revision: 1 });
    expect((await w.me(sid)).org.orgId).toBe(w.A);
  });

  it("signs the person in again rather than list companies without the one the request is in", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.db.set({ ...w.db.get(orgMemberKey(w.A, PAT))!, role: "superuser" });
    expect(await codeOf(w.web(sid, "GET", "/v1/web/companies"))).toBe("AUTH_REQUIRED");
  });

  it("refuses an item that belongs to another person, or does not read, instead of guessing a company", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.db.set({ ...activeCompanyKey(sid), entityType: "WEB_ACTIVE_COMPANY", orgId: w.B, developerId: SOLO, revision: 1 });
    expect(await codeOf(w.me(sid))).toBe("AUTH_REQUIRED");
    w.db.set({ ...activeCompanyKey(sid), entityType: "WEB_ACTIVE_COMPANY", orgId: "nope", developerId: PAT, revision: 1 });
    expect(await codeOf(w.me(sid))).toBe("AUTH_REQUIRED");
  });

  it("refuses with 503 when the item cannot be read (never a guess at the company)", async () => {
    const w = await world();
    const sid = w.session(PAT);
    w.db.injectFault({ command: "GetCommand", match: (input) => String((input.Key as Json | undefined)?.pk).startsWith("WEB_ACTIVE_COMPANY#"), error: { name: "InternalServerError" } });
    expect(await codeOf(w.me(sid))).toBe("RUNTIME_UNAVAILABLE");
  });

  it("keeps the old single-company path exactly: a person with one membership gets the same answers with the switch on as off, and no item is written by a read", async () => {
    const w = await world();
    const sid = w.session(SOLO);
    const on = await w.me(sid);
    vi.stubEnv("COMPANY_SWITCHER_ENABLED", "0");
    const off = await w.me(sid);
    expect(on).toEqual(off);
    expect(w.binding(sid)).toBeUndefined();
  });

  it("never changes a token's company: a token stays bound to the company it was issued for after a browser switch", async () => {
    const w = await world();
    await w.switchTo(w.session(PAT), w.B);
    expect((await w.token<Me>(PAT, w.A, "owner", "GET", "/v1/app/me")).org.orgId).toBe(w.A);
    // A token issued for the second company is not honoured: tokens are issued for the primary only in this release.
    expect(await codeOf(w.token(PAT, w.B, "member", "GET", "/v1/app/me"))).toBe("AUTH_REQUIRED");
  });
});

describe("x-rovara-company: the header only narrows", () => {
  it("passes a header that names the request's company, and refuses every other value with one fixed answer", async () => {
    const w = await world();
    w.second(PAT, w.C, "admin");
    const sid = w.session(PAT);
    expect((await w.me(sid, w.A)).org.orgId).toBe(w.A);
    const answers = new Set<string | undefined>();
    // Another company of the person's own (never selected by the header), another company they are not in, one that does not exist, a malformed value, two values.
    for (const value of [w.B, w.C, OWNER_B, GHOST, "org_short", w.A.toUpperCase(), `${w.A}, ${w.B}`, ""]) {
      expect(await codeOf(w.web(sid, "GET", "/v1/web/projects", { company: value })), value).toBe("CSRF_STALE");
      answers.add(await messageOf(w.web(sid, "GET", "/v1/web/projects", { company: value })));
    }
    expect([...answers]).toEqual([COMPANY_STALE_MESSAGE]);
    // A refused header changed nothing: the session is still in its company.
    expect(w.binding(sid)).toBeUndefined();
    expect((await w.me(sid)).org.orgId).toBe(w.A);
  });

  it("is checked on the exempt reads too, and on a switch: a stale tab cannot switch either", async () => {
    const w = await world();
    const sid = w.session(PAT);
    for (const path of ["/v1/web/nav", "/v1/web/me", "/v1/web/companies"]) expect(await codeOf(w.web(sid, "GET", path, { company: w.B })), path).toBe("CSRF_STALE");
    expect(await codeOf(w.switchTo(sid, w.B, { company: w.B }))).toBe("CSRF_STALE");
    expect(w.binding(sid)).toBeUndefined();
  });

  it("checks the Auditor and a banned person the same way", async () => {
    const w = await world();
    w.second(AUDITOR, w.A, "auditor");
    w.db.delete({ pk: `DEVELOPER_ORG#${AUDITOR}`, sk: `ORG#${w.A}` });
    w.db.set({ pk: `DEVELOPER_ORG#${AUDITOR}`, sk: "ORG", entityType: "DEVELOPER_ORG", orgId: w.A, role: "auditor", joinedAt: "2026-11-01T00:00:00.000Z" });
    const auditor = w.session(AUDITOR);
    expect(await codeOf(w.web(auditor, "GET", "/v1/web/companies", { company: w.A }))).toBeUndefined();
    expect(await codeOf(w.web(auditor, "GET", "/v1/web/companies", { company: w.B }))).toBe("CSRF_STALE");
    const sid = w.session(PAT);
    w.db.set({ ...orgBanKey(w.B, PAT), entityType: "ORG_BAN" });
    expect(await codeOf(w.web(sid, "GET", "/v1/web/projects", { company: w.B }))).toBe("CSRF_STALE");
  });
});

describe("the header requirement follows the company's `companies` UI flag, never a separate switch", () => {
  const states = ["on", "preview", "off", "forced-off", "never-set"] as const;
  const cases = states.flatMap((flag) => (["match", "absent", "mismatch"] as const).flatMap((header) => (["on", "off"] as const).map((server) => ({ flag, header, server }))));
  it.each(cases)("server $server, flag $flag, header $header", async ({ flag, header, server }) => {
    const w = await world({ flags: false });
    const sid = w.session(PAT);
    if (flag === "on" || flag === "forced-off") w.companiesFlag(w.A, "on");
    else if (flag !== "never-set") w.companiesFlag(w.A, flag);
    if (flag === "forced-off") vi.stubEnv("UI_FLAGS_FORCE_OFF", "companies");
    if (server === "off") vi.stubEnv("COMPANY_SWITCHER_ENABLED", "0");
    const company = header === "match" ? w.A : header === "mismatch" ? w.B : undefined;
    const read = await codeOf(w.web(sid, "GET", "/v1/web/projects", company === undefined ? {} : { company }));
    const write = await codeOf(w.authenticateWrite(sid, company));
    const refused = server === "on" && (header === "mismatch" || (header === "absent" && flag === "on"));
    expect(read).toBe(refused ? "CSRF_STALE" : undefined);
    expect(write).toBe(refused ? "CSRF_STALE" : undefined);
  });

  it("never refuses the three reads a page makes before it knows its company, while a write without the header is refused", async () => {
    const w = await world();
    w.companiesFlag(w.A, "on");
    const sid = w.session(PAT);
    for (const path of ["/v1/web/nav", "/v1/web/me", "/v1/web/companies"]) expect(await codeOf(w.authenticate(sid, "GET", path)), path).toBeUndefined();
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBe("CSRF_STALE");
    expect(await codeOf(w.switchTo(sid, w.B, { company: null }))).toBe("CSRF_STALE");
    expect(await codeOf(w.switchTo(sid, w.B, { company: w.A }))).toBeUndefined();
  });

  it("reads the flag of the company the request is IN: after a switch, the requirement follows that company's flag", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBe("CSRF_STALE");
    w.companiesFlag(w.B, "off");
    // A read needs no header in a company whose flag is off (the reload marker only holds writes).
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBeUndefined();
    w.companiesFlag(w.A, "off");w.companiesFlag(w.B, "on");
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBe("CSRF_STALE");
  });

  it("treats a flag read that fails as off, exactly as the navigation answer does", async () => {
    const w = await world();
    w.companiesFlag(w.A, "on");
    const sid = w.session(PAT);
    w.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as Json | undefined)?.sk === "UI_FLAGS", error: { name: "InternalServerError" } });
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBeUndefined();
  });
});

describe("the echo", () => {
  it("names the company the request was answered in on the reply, keeping the reply's own headers", () => {
    const reply = withCompanyEcho({ statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" }, "org_aaaaaaaaaaaaaaaaaaaa");
    expect(reply.headers).toEqual({ "content-type": "application/json", "x-rovara-company": "org_aaaaaaaaaaaaaaaaaaaa" });
  });
});

describe("review M1: an old tab never acts in the company the session moved to", () => {
  it.each([["the source", "A"], ["the target", "B"]] as const)("refuses the switch while %s company's companies flag is not on, and writes nothing", async (_side, which) => {
    for (const state of ["off", "preview", "forced-off"] as const) {
      const w = await world();
      const orgId = which === "A" ? w.A : w.B;
      if (state !== "forced-off") w.companiesFlag(orgId, state);
      vi.stubEnv("UI_FLAGS_FORCE_OFF", state === "forced-off" ? "companies" : "none");
      const sid = w.session(PAT);
      const switching = w.switchTo(sid, w.B, { company: w.A });
      expect(await codeOf(switching), state).toBe("FORBIDDEN");
      expect(await messageOf(w.switchTo(sid, w.B, { company: w.A }))).toBe(SWITCH_NOT_ON_MESSAGE);
      expect(w.binding(sid)).toBeUndefined();
      expect(w.db.find((item) => String(item.pk).startsWith("COMPANY_SWITCH_REQUEST#"))).toEqual([]);
    }
  });

  it("refuses an old tab's headerless write after a switch, even once the flags are off, until a page read clears the marker; reads are not held", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    expect(w.binding(sid)).toMatchObject({ orgId: w.B, reloadNeeded: true });
    w.companiesFlag(w.A, "off");w.companiesFlag(w.B, "off");
    expect(await codeOf(w.authenticateWrite(sid))).toBe("CSRF_STALE");
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBeUndefined();
    // A write that names the session's company knows where it is.
    expect(await codeOf(w.authenticateWrite(sid, w.B))).toBeUndefined();
    expect(w.binding(sid)).toMatchObject({ reloadNeeded: true });
    // The page loads: its first read clears the marker.
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/nav"))).toBeUndefined();
    expect(w.binding(sid)?.reloadNeeded).toBeUndefined();
    expect(await codeOf(w.authenticateWrite(sid))).toBeUndefined();
  });

  it("clears the marker on each exempt read, with or without a matching header, and on no other read", async () => {
    for (const [path, company, clears] of [["/v1/web/me", undefined, true], ["/v1/web/companies", "B", true], ["/v1/web/nav", "B", true], ["/v1/web/home", "B", false], ["/v1/web/projects", undefined, false]] as const) {
      const w = await world();
      const sid = w.session(PAT);
      await w.switchTo(sid, w.B);
      w.companiesFlag(w.B, "off");
      await w.authenticate(sid, "GET", path, company === undefined ? undefined : w.B);
      expect(w.binding(sid)?.reloadNeeded, path).toBe(clears ? undefined : true);
    }
  });

  it("refuses an old tab's headerless write after the chosen company is lost, until a page read clears the marker", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    await w.me(sid);
    w.companiesFlag(w.A, "off");w.companiesFlag(w.B, "off");
    expect(await codeOf(w.authenticateWrite(sid))).toBeUndefined();
    w.removeSecond(PAT, w.B);
    expect(await codeOf(w.authenticateWrite(sid))).toBe("CSRF_STALE");
    expect(w.binding(sid)).toMatchObject({ orgId: w.A, reloadNeeded: true });
    expect(await codeOf(w.authenticate(sid, "GET", "/v1/web/home"))).toBeUndefined();
    expect(await codeOf(w.authenticateWrite(sid))).toBe("CSRF_STALE");
    expect((await w.me(sid)).org.orgId).toBe(w.A);
    expect(await codeOf(w.authenticateWrite(sid))).toBeUndefined();
  });

  it("never clears a newer marker: the clear is fenced on the revision the request saw", async () => {
    const w = await world();
    const sid = w.session(PAT);
    await w.switchTo(sid, w.B);
    await clearCompanyReload({ documentClient: w.db, tableName: T }, sid, { revision: 99 });
    expect(w.binding(sid)).toMatchObject({ reloadNeeded: true });
    await clearCompanyReload({ documentClient: w.db, tableName: T }, sid, { revision: 1 });
    expect(w.binding(sid)?.reloadNeeded).toBeUndefined();
  });
});

describe("review L3: the switch is recorded in the sign-in history", () => {
  it("logs the company switched to and from and a hash of the session, never the session id itself", async () => {
    const w = await world();
    const sid = w.session(PAT);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
    try { await w.switchTo(sid, w.B); } finally { spy.mockRestore(); }
    const entries = lines.map((line) => { try { return JSON.parse(line) as Json; } catch { return {}; } }).filter((entry) => entry.event === "developer.company_switched");
    expect(entries).toEqual([{ component: "broker", event: "developer.company_switched", companyId: w.B, fromCompanyId: w.A, session: createHash("sha256").update(sid, "utf8").digest("hex") }]);
    for (const line of lines) {
      expect(line).not.toContain(sid);
      expect(line).not.toContain(sid.replace(/-/gu, ""));
    }
  });
});

describe("review L4: refused attempts count against the switch rate", () => {
  it(`refuses the ${String(COMPANY_SWITCHES_PER_HOUR + 1)}th attempt even when the earlier ones were all refused`, async () => {
    const w = await world();
    const sid = w.session(PAT);
    for (let index = 0; index < COMPANY_SWITCHES_PER_HOUR; index += 1) expect(await codeOf(w.switchTo(sid, w.C))).toBe("NOT_FOUND");
    expect(await codeOf(w.switchTo(sid, w.B))).toBe("TOO_MANY_REQUESTS");
    expect(await codeOf(w.switchTo(sid, GHOST))).toBe("TOO_MANY_REQUESTS");
    expect(w.binding(sid)).toBeUndefined();
  });
});
