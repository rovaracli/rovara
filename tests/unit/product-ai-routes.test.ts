// B7: the project's product AI settings in Cloud (product-ai-routes.ts) over the gateway's write-only key store, through the real
// handler (CSRF) and a fake Code that issues access tokens with step-up claims. Write-only key (never answered, logged or
// audited), project admin or company admin only, a fresh step-up on every write, audited, company from Code (two companies never
// meet), and the records the gateway's eval hold reads (eval-approvals.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodeClient, LocalCloudAuditStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type ProductAiStore } from "../../packages/cloud-server/src/index.js";
import { storedEvalApprovals, storedEvalBudget } from "../../packages/model-gateway/src/eval-approvals.js";
import { InMemoryProductKeyTable, ProductKeyStore } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";

const CODE = "https://code.example.test";
const ISS = `${CODE}/v1/auth`;
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-15T12:00:00.000Z");
const aiKey = () => ["AI", "za"].join("") + randomBytes(24).toString("base64url").slice(0, 35);

interface Person { developerId: string; name: string; administrator: boolean; companyId: string; /** Code's company role; default admin when `administrator`, else member. */ companyRole?: string; projects: Array<{ name: string; access: string }> }
const PEOPLE: Record<string, Person> = {
  pam: { developerId: "a".repeat(64), name: "Pam", administrator: false, companyId: A, projects: [{ name: "web", access: "administrator" }] },
  cal: { developerId: "c".repeat(64), name: "Cal", administrator: false, companyId: A, projects: [{ name: "web", access: "developer" }] },
  ada: { developerId: "d".repeat(64), name: "Ada", administrator: true, companyId: A, projects: [] },
  bob: { developerId: "b".repeat(64), name: "Bob", administrator: false, companyId: B, projects: [{ name: "web", access: "administrator" }] },
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
type Body = Record<string, unknown> & { error?: { code: string; message: string } };

function world() {
  let clock = START; let tokens = 0;
  const nowS = () => Math.floor(clock / 1000);
  const byToken = new Map<string, Person>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const person = byToken.get(((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, ""));
    if (person === undefined) return new Response("{}", { status: 401 });
    if (url.pathname === "/v1/dev/access") return new Response(JSON.stringify({ developerId: person.developerId, displayName: person.name, administrator: person.administrator, companyId: person.companyId, companyRole: person.companyRole ?? (person.administrator ? "admin" : "member"), projects: person.projects, notices: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  const table = new InMemoryProductKeyTable();
  const store = new ProductKeyStore({ table, sealer: new ProductKeySealer(localProductKeyService(randomBytes(32))), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => clock });
  const typed: ProductAiStore = store;
  const audit = new LocalCloudAuditStore(undefined, {});
  const logs: string[] = [];
  const handler = createCloudHandler({
    client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN,
    now: () => new Date(clock), log: (event) => { logs.push(JSON.stringify(event)); }, audit, productAi: { store: typed, issuer: ISS },
  });
  const signIn = async (who: string, stepUpAge?: number) => {
    const person = PEOPLE[who]!; tokens += 1;
    const token = `${b64({ alg: "RS256", typ: "JWT", kid: "code" })}.${b64({ sub: person.developerId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens), ...(stepUpAge === undefined ? {} : { step_up_at: nowS() - stepUpAge, step_up_amr: "passkey" }) })}.c2ln`;
    byToken.set(token, person);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.developerId, displayName: person.name, administrator: person.administrator, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock).toISOString() });
    return cookie;
  };
  const call = async (cookie: string, method: string, path: string, body?: unknown, csrf = `csrf-${cookie}`) => {
    const request: CloudRequest = { method, path: `/v1/web${path}`, query: new URLSearchParams(), headers: { cookie: `rovara_cloud_session=${cookie}`, "x-rovara-csrf": csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = (await handler(request))!;
    return { status: answer.status, body: JSON.parse(answer.body) as Body, raw: answer.body };
  };
  return { store, table, audit, logs, signIn, call, advance: (ms: number) => { clock += ms; } };
}
const write = (expectedRevision: number, more: Record<string, unknown> = {}) => ({ requestId: randomUUID(), expectedRevision, ...more });
const KEY_PATH = "/projects/web/product-ai/key";

describe("product AI key: write-only, project admin, fresh step-up, audited", () => {
  it("a project admin connects, rotates and removes the key; the key is never answered, logged or audited", async () => {
    const w = world();
    const pam = await w.signIn("pam", 30);
    const key = aiKey();
    const connected = await w.call(pam, "PUT", KEY_PATH, write(0, { key }));
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ project: "web", revision: 1, key: { connected: true } });
    expect(connected.raw).not.toContain(key);
    const resolved = (await w.store.resolve(ISS, A, "web", "gemini"))!;
    expect(await w.store.useKey(ISS, A, resolved)).toBe(key);
    const key2 = aiKey();
    expect((await w.call(pam, "PUT", KEY_PATH, write(1, { key: key2 }))).status).toBe(200);
    expect(await w.store.useKey(ISS, A, (await w.store.resolve(ISS, A, "web", "gemini"))!)).toBe(key2);
    const read = await w.call(pam, "GET", "/projects/web/product-ai");
    expect(read.body).toMatchObject({ key: { connected: true }, evalBudget: { calls: 400, costMicros: 4_000_000 }, evalApproval: null });
    expect(read.raw).not.toContain(key2);
    const removed = await w.call(pam, "DELETE", KEY_PATH, write(2));
    expect(removed.body).toMatchObject({ key: { connected: false } });
    expect(await w.store.resolve(ISS, A, "web", "gemini")).toBeUndefined();
    const records = (await w.audit.read(A, { max: 50 })).rows.map((r) => [r.action, r.subject, r.actor.developerId]);
    expect(records).toEqual(expect.arrayContaining([["product_ai.key.connected", "project:web", PEOPLE.pam!.developerId], ["product_ai.key.rotated", "project:web", PEOPLE.pam!.developerId], ["product_ai.key.removed", "project:web", PEOPLE.pam!.developerId]]));
    for (const text of [JSON.stringify(await w.audit.read(A, { max: 50 })), ...w.logs]) { expect(text).not.toContain(key); expect(text).not.toContain(key2); }
  });

  it("needs a fresh step-up for every write, and writes nothing without one", async () => {
    const w = world();
    for (const age of [undefined, 601]) {
      const pam = await w.signIn("pam", age);
      const refused = await w.call(pam, "PUT", KEY_PATH, write(0, { key: aiKey() }));
      expect([refused.status, refused.body.error?.code]).toEqual([403, "STEP_UP_REQUIRED"]);
      // Reading needs none.
      expect((await w.call(pam, "GET", "/projects/web/product-ai")).status).toBe(200);
    }
    expect(w.table.rows.size).toBe(0);
  });

  it("refuses a contributor, hides a project the person can't see, and needs the CSRF token", async () => {
    const w = world();
    const cal = await w.signIn("cal", 10);
    expect((await w.call(cal, "PUT", KEY_PATH, write(0, { key: aiKey() }))).body.error?.code).toBe("FORBIDDEN");
    expect((await w.call(cal, "PUT", "/projects/api/product-ai/key", write(0, { key: aiKey() }))).body.error?.code).toBe("PROJECT_NOT_FOUND");
    const pam = await w.signIn("pam", 10);
    expect((await w.call(pam, "PUT", KEY_PATH, write(0, { key: aiKey() }), "wrong")).status).toBe(403);
    expect(w.table.rows.size).toBe(0);
    // A company admin may, for any project of the company.
    const ada = await w.signIn("ada", 10);
    expect((await w.call(ada, "PUT", KEY_PATH, write(0, { key: aiKey() }))).status).toBe(200);
  });

  it("refuses a body that does not read, in fixed words that never echo it", async () => {
    const w = world();
    const pam = await w.signIn("pam", 10);
    const secret = aiKey();
    for (const body of [{ key: secret }, write(0, { key: secret, extra: 1 }), write(0, { key: `${secret} with spaces` }), { ...write(0, { key: secret }), requestId: "nope" }, write(0, { key: 12 })]) {
      const answer = await w.call(pam, "PUT", KEY_PATH, body);
      expect([answer.status, answer.body.error?.code]).toEqual([400, "CONFIG_INVALID"]);
      expect(answer.raw).not.toContain(secret.slice(4));
    }
    expect((await w.call(pam, "PUT", KEY_PATH, write(5, { key: secret }))).body.error?.code).toBe("CONFLICT");
    expect(w.table.rows.size).toBe(0);
  });

  it("two companies: the same project name in another company is another record, and the company comes from Code only", async () => {
    const w = world();
    const pam = await w.signIn("pam", 10); const bob = await w.signIn("bob", 10);
    const keyA = aiKey(); const keyB = aiKey();
    await w.call(pam, "PUT", KEY_PATH, write(0, { key: keyA }));
    expect((await w.call(bob, "GET", "/projects/web/product-ai")).body).toMatchObject({ revision: 0, key: { connected: false } });
    await w.call(bob, "PUT", KEY_PATH, write(0, { key: keyB }));
    expect(await w.store.useKey(ISS, A, (await w.store.resolve(ISS, A, "web", "gemini"))!)).toBe(keyA);
    expect(await w.store.useKey(ISS, B, (await w.store.resolve(ISS, B, "web", "gemini"))!)).toBe(keyB);
    // B's admin removing "web" removes B's only.
    await w.call(bob, "DELETE", KEY_PATH, write(1));
    expect(await w.store.resolve(ISS, A, "web", "gemini")).toBeDefined();
    expect((await w.audit.read(B, { max: 50 })).rows.every((r) => r.companyId === B)).toBe(true);
  });
});

describe("eval budget and approval (what the gateway's stage hold reads)", () => {
  it("records the project's budget and the approval with the approver as the signed-in person; the gateway reads both", async () => {
    const w = world();
    const pam = await w.signIn("pam", 10);
    expect((await w.call(pam, "PUT", "/projects/web/product-ai/eval-budget", write(0, { calls: 50, costMicros: 500_000 }))).body).toMatchObject({ evalBudget: { calls: 50, costMicros: 500_000 } });
    const approval = { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 40, maxCostMicros: 400_000, model: "gemini-2.5-flash" };
    const recorded = await w.call(pam, "PUT", "/projects/web/product-ai/eval-approval", write(1, { approval }));
    expect(recorded.body).toMatchObject({ evalApproval: { ...approval, approvedByYou: true } });
    expect(await storedEvalBudget(w.store)(ISS, A, "web")).toEqual({ calls: 50, costMicros: 500_000 });
    const source = storedEvalApprovals(w.store, () => START);
    expect(await source.current(ISS, A, "web")).toEqual({ ...approval, approver: { personId: PEOPLE.pam!.developerId, provider: "rovara-code" } });
    expect(await source.roleOf(ISS, A, "web", { personId: PEOPLE.pam!.developerId, provider: "rovara-code" })).toBe("maintainer");
    expect(await source.current(ISS, B, "web")).toBeUndefined();
    // Withdrawn: the next hold finds none.
    await w.call(pam, "PUT", "/projects/web/product-ai/eval-approval", write(2, { approval: null }));
    expect(await source.current(ISS, A, "web")).toBeUndefined();
    const actions = (await w.audit.read(A, { max: 50 })).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["product_ai.eval_budget.changed", "product_ai.eval_approval.recorded", "product_ai.eval_approval.withdrawn"]));
  });
  it("refuses bad budgets and approvals, and a contributor", async () => {
    const w = world();
    const pam = await w.signIn("pam", 10);
    for (const body of [write(0, { calls: 0, costMicros: 1 }), write(0, { calls: 1, costMicros: -1 }), write(0, { calls: 1 })]) expect((await w.call(pam, "PUT", "/projects/web/product-ai/eval-budget", body)).status).toBe(400);
    for (const approval of [{ selection: "s" }, { selection: "s", inputsDigest: "short", maxCalls: 1, maxCostMicros: 1 }, { selection: "s", inputsDigest: "d".repeat(64), maxCalls: 1, maxCostMicros: 1, extra: true }]) {
      expect((await w.call(pam, "PUT", "/projects/web/product-ai/eval-approval", write(0, { approval }))).status).toBe(400);
    }
    const cal = await w.signIn("cal", 10);
    expect((await w.call(cal, "PUT", "/projects/web/product-ai/eval-budget", write(0, { calls: 5, costMicros: 5 }))).body.error?.code).toBe("FORBIDDEN");
    expect(w.table.rows.size).toBe(0);
  });
});
