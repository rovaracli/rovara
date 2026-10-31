import { expect, it, vi } from "vitest";
import { ADMIN_INDEX_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, WEB_API_RUNTIME_PROFILE_ID, orgMetaKey, orgScoped } from "@agentx/contracts";
import { createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
const person = "a".repeat(64), sid = "11111111-1111-4111-8111-111111111111", cell = "https://cell.example", catalog = "private-catalog", NOW = Date.parse("2026-10-30T14:30:30Z");
const bucketPerson = orgScoped(TEST_ORG, "SERVICE_STATUS_PERSON_RATE"), bucketOrg = orgScoped(TEST_ORG, "SERVICE_STATUS_ORG_RATE");
async function fixture(options: { bearer?: Record<string, unknown> } = {}) {
 const h = await createAdminBroker({ developer: { issuer: `${cell}/v1/auth`, env: "test", signInTableName: "signin", methods: { slack: false, oidc: false, cloud: true }, verifyAccessToken: async (authorization?: string) => authorization === "Bearer fixture" ? { iss: `${cell}/v1/auth`, aud: "agentx-developer", sub: person, sid, amr: "cloud", env: "test", org: TEST_ORG, org_role: "owner", ...options.bearer } : {}, channelMembers: async () => { throw new Error("No Slack calls"); } }, extra: { cloud: true, e2eFeatureRuntimeCatalogId: catalog } });
 seedMembership(h.db, person, { orgId: TEST_ORG, role: "owner" });h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Company", plan: "team" });h.db.set({ pk: `DEVELOPER#${person}`, sk: "META", developerId: person, provider: "cloud", revoked: false });h.db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: person, amr: "cloud", startedAt: new Date(NOW - 60000).toISOString(), endsAt: NOW / 1000 + 3600, reviewExpiresAt: NOW / 1000 + 3600 });
 for (const kind of ["web", "api"] as const) h.db.set({ ...e2eRegisteredRuntimeKey(catalog, WEB_API_RUNTIME_PROFILE_ID, kind), state: "READY", qualifiedAt: new Date(NOW - 86400000).toISOString(), expiresAt: new Date(NOW + 72 * 3600000).toISOString(), endpoint: "https://secret.invalid" });
 const sent: { type: string; key?: { pk?: string; sk?: string } }[] = [], send = h.db.send.bind(h.db);
 h.db.send = (async (command: { constructor: { name: string }; input: { Key?: { pk?: string; sk?: string }; TransactItems?: unknown[] } }) => { sent.push({ type: command.constructor.name, ...(command.input.Key === undefined ? {} : { key: command.input.Key }) });return send(command); });
 const call = async (route: "app" | "web", headers: Record<string, string>, query = `expectedOrgId=${TEST_ORG}`, method = "GET") => {
  const rawPath = `/v1/${route}/org/service-status`, response = await h.handler({ version: "2.0", routeKey: `ANY /v1/${route}/{proxy+}`, rawPath, rawQueryString: query, headers, requestContext: { requestId: "trace", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
 };
 const rows = () => h.db.find(item => String(item.pk).includes("SERVICE_STATUS_"));
 return { ...h, call, sent, rows, snapshot: () => structuredClone(h.db.find(() => true)) };
}
const cookie = { cookie: `__Host-agentx_review_session=${sid}`, "sec-fetch-site": "same-origin" };
async function withClock<T>(run: () => Promise<T>): Promise<T> { vi.useFakeTimers({ toFake: ["Date"] });vi.setSystemTime(NOW);try { return await run(); } finally { vi.useRealTimers(); } }

it("B35 a bearer token on the real /v1/app handler is refused without touching rate rows or runtime evidence", () => withClock(async () => {
 const f = await fixture(), before = f.snapshot(), result = await f.call("app", { authorization: "Bearer fixture" });
 expect(result.status, JSON.stringify(result.body)).toBe(403);expect(result.body).toMatchObject({ error: { code: "FORBIDDEN" } });
 expect(JSON.stringify(result.body)).not.toMatch(/private-catalog|secret.invalid|qualifiedAt|checks/);
 expect(f.snapshot()).toEqual(before);expect(f.rows()).toEqual([]);
 expect(f.sent.some(row => row.type !== "GetCommand" || row.key?.pk?.includes("E2E") === true || row.key?.sk?.includes(catalog) === true)).toBe(false);
 // Positive control: the same person reaches the data through the real browser-session route, so the refusal above is the bearer rule.
 const cookieRead = await f.call("web", cookie);expect(cookieRead.status, JSON.stringify(cookieRead.body)).toBe(200);expect(f.rows()).toHaveLength(2);
}));
it("B35 the real /v1/app handler gives 401 with no credential or a bad bearer, and never reads or writes", () => withClock(async () => {
 const f = await fixture(), before = f.snapshot();
 for (const headers of [{}, { authorization: "Bearer wrong" }]) expect((await f.call("app", headers)).status).toBe(401);
 expect(f.snapshot()).toEqual(before);expect(f.rows()).toEqual([]);
}));
it("B35 a browser cookie reaching the /v1/app path is not accepted as a browser session", () => withClock(async () => {
 const f = await fixture(), result = await f.call("app", cookie);
 expect([401, 403]).toContain(result.status);expect(f.rows()).toEqual([]);expect(result.body).not.toHaveProperty("checks");
}));
for (const method of ["POST", "PUT", "DELETE", "PATCH"]) it(`B35 ${method} never reaches the service status handler`, () => withClock(async () => {
 const f = await fixture(), before = f.snapshot(), result = await f.call("web", { ...cookie, origin: cell }, `expectedOrgId=${TEST_ORG}`, method);
 expect(result.status).not.toBe(200);expect(result.body).not.toHaveProperty("checks");expect(f.snapshot()).toEqual(before);expect(f.rows()).toEqual([]);
}));

it("B35 a successful read changes nothing except the two throttle rows, written only by updates on their own keys", () => withClock(async () => {
 const f = await fixture(), before = f.snapshot(), result = await f.call("web", cookie);
 expect(result.status, JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({ checks: [{ kind: "web", observation: "qualified" }, { kind: "api", observation: "qualified" }] });
 const after = f.snapshot(), id = (item: { pk?: unknown; sk?: unknown }) => JSON.stringify([item.pk, item.sk]), beforeKeys = new Set(before.map(id)), added = after.filter(item => !beforeKeys.has(id(item)));
 expect(before.every(item => JSON.stringify(after.find(row => row.pk === item.pk && row.sk === item.sk)) === JSON.stringify(item))).toBe(true);
 expect(added.map(item => [item.pk, item.sk, item.entityType, item.count]).sort()).toEqual([[bucketOrg, "ALL", "TASK_RATE", 1], [bucketPerson, person, "TASK_RATE", 1]].sort());
 const writes = f.sent.filter(row => row.type !== "GetCommand" && row.type !== "QueryCommand");
 expect(writes.length).toBeGreaterThan(0);expect(new Set(writes.map(row => row.type))).toEqual(new Set(["UpdateCommand"]));
 expect(writes.every(row => (row.key?.pk === bucketPerson && row.key.sk === person) || (row.key?.pk === bucketOrg && row.key.sk === "ALL"))).toBe(true);
}));
it("B35 a refused read (throttled) still writes nothing beyond the same two throttle rows", () => withClock(async () => {
 const f = await fixture();for (let n = 0; n < 30; n++) expect((await f.call("web", cookie)).status).toBe(200);
 const settled = f.snapshot(), before = f.sent.length, denied = await f.call("web", cookie);
 expect(denied.status).toBe(429);expect(f.snapshot().filter(item => !String(item.pk).includes("SERVICE_STATUS_"))).toEqual(settled.filter(item => !String(item.pk).includes("SERVICE_STATUS_")));
 expect(f.sent.slice(before).filter(row => row.type !== "GetCommand").every(row => row.type === "UpdateCommand" && String(row.key?.pk).includes("SERVICE_STATUS_"))).toBe(true);
 expect(f.rows().find(item => item.pk === bucketPerson)).toMatchObject({ count: 30 });
}));
it("B35 throttle rows carry a TTL in epoch seconds that outlives their window and stays within retention", () => withClock(async () => {
 const f = await fixture();expect((await f.call("web", cookie)).status).toBe(200);
 const rows = f.rows(), windowEnd = (Math.floor(NOW / 60000) + 1) * 60000;
 expect(rows).toHaveLength(2);
 for (const row of rows) {
  const expiry = row[INDEX_EXPIRY_ATTRIBUTE];
  expect(typeof expiry, `${String(row.pk)} has no ${INDEX_EXPIRY_ATTRIBUTE}`).toBe("number");
  expect(Number.isInteger(expiry)).toBe(true);expect(expiry as number).toBeGreaterThanOrEqual(windowEnd / 1000);expect(expiry as number).toBeLessThanOrEqual(NOW / 1000 + ADMIN_INDEX_RETENTION_DAYS * 86400);
 }
}));
it("B35 a new window refreshes each throttle row's TTL", () => withClock(async () => {
 const f = await fixture();expect((await f.call("web", cookie)).status).toBe(200);const first = f.rows().map(row => row[INDEX_EXPIRY_ATTRIBUTE] as number);
 vi.setSystemTime(NOW + 120000);expect((await f.call("web", cookie)).status).toBe(200);
 const second = f.rows();expect(second.every(row => row.count === 1)).toBe(true);
 second.forEach((row, index) => expect(row[INDEX_EXPIRY_ATTRIBUTE] as number).toBeGreaterThanOrEqual(first[index]! + 120));
}));
