import { describe, expect, it } from "vitest";
import { codeWritesSent } from "../../packages/cloud-server/src/code-client.js";
import { CodeClient, CodeError, LocalSessionStore, LocalWorkSessionStore, SignInEnded, StoreConflict, createCloudHandler, type CodeSession, type Route } from "../../packages/cloud-server/src/index.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const access: CodeSession["access"] = { developerId: "a".repeat(64), displayName: "Ada", administrator: false, companyId: COMPANY, companyRole: "owner", projects: [], notices: [] };
const session = (): CodeSession => ({ accessToken: "old", refreshToken: "refresh-old", csrf: "csrf", signedInAt: "2026-11-20T00:00:00.000Z", access });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const clientFor = (fetchImpl: typeof fetch) => new CodeClient({ baseUrl: "https://code.example.test", clientId: "test", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: fetchImpl });
const unknown = { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "The request's outcome is unknown. Check its status before trying again." } } };

function transport(options: { refresh?: "ok" | "ended" | "busy"; onFirst?: () => void } = {}) {
  const calls: Array<{ path: string; method: string; body: RequestInit["body"] }> = [];
  const client = clientFor(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path === "/v1/auth/token") {
      if (options.refresh === "ended") return json(400, { error: "invalid_grant" });
      if (options.refresh === "busy") return json(503, {});
      return json(200, { access_token: "fresh", refresh_token: "refresh-fresh" });
    }
    if (calls.filter(call => call.path === path).length === 1) { options.onFirst?.(); return json(401, {}); }
    return json(init?.method === "GET" || init?.method === "HEAD" || init?.method === undefined ? 200 : 403, { original: true });
  });
  return { client, calls };
}

describe("Code refresh never blindly re-sends writes", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS"])("%s returns typed unknown after refresh, even if a second attempt would refuse", async method => {
    const w = transport();
    const using = session();
    await expect(w.client.json(using, "/v1/app/change", { method, body: { value: "change" } })).rejects.toMatchObject(unknown);
    expect(w.calls.filter(call => call.path === "/v1/app/change")).toHaveLength(1);
    expect(w.calls.filter(call => call.path === "/v1/auth/token")).toHaveLength(1);
    expect(using.accessToken).toBe("fresh");
  });

  it.each(["/v1/dev/access", "/v1/dev/access?check=live"])("%s is a read-only POST that refreshes once and never counts as a write", async path => {
    const calls: string[] = [];
    const using = session();
    const client = clientFor(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.pathname + url.search);
      if (url.pathname === "/v1/auth/token") return json(200, { access_token: "fresh", refresh_token: "refresh-fresh" });
      expect(init?.method).toBe("POST");
      return (init?.headers as Record<string, string>).authorization === "Bearer old" ? json(401, {}) : json(200, access);
    });
    await expect(client.json(using, path, { method: "POST", body: {} })).resolves.toEqual(access);
    expect(calls).toEqual([path, "/v1/auth/token", path]);
    expect(codeWritesSent(using)).toBe(0);
  });

  it.each([
    ["POST", "/v1/dev/access/change"],
    ["POST", "/v1/dev/access-extra"],
    ["PUT", "/v1/dev/access"],
  ])("%s %s stays a write outside the exact read-only access exception", async (method, path) => {
    const w = transport();
    const using = session();
    await expect(w.client.json(using, path, { method })).rejects.toMatchObject(unknown);
    expect(w.calls.filter(call => call.path === path)).toHaveLength(1);
    expect(codeWritesSent(using)).toBe(1);
  });

  it.each(["archive", "restore"])("a same-id %s route does not qualify when permission precedes its receipt", async action => {
    const w = transport();
    const path = `/v1/dev/client/projects/payments/${action}`;
    await expect(w.client.json(session(), path, { method: "POST", body: { requestId: "11111111-1111-4111-8111-111111111111" } })).rejects.toMatchObject(unknown);
    expect(w.calls.filter(call => call.path === path)).toHaveLength(1);
  });

  it.each(["GET", "HEAD", undefined])("%s refreshes and retries exactly once", async method => {
    const w = transport();
    await expect(w.client.json(session(), "/v1/app/read", method === undefined ? {} : { method })).resolves.toEqual({ original: true });
    expect(w.calls.map(call => call.path)).toEqual(["/v1/app/read", "/v1/auth/token", "/v1/app/read"]);
  });

  it.each(["ended", "busy"] as const)("a %s refresh cannot settle a dispatched write", async refresh => {
    const w = transport({ refresh });
    await expect(w.client.json(session(), "/v1/app/change", { method: "POST" })).rejects.toMatchObject(unknown);
    expect(w.calls.filter(call => call.path === "/v1/app/change")).toHaveLength(1);
  });

  it("also fences a write when a parallel call already replaced the access token", async () => {
    const using = session();
    const w = transport({ onFirst: () => { using.accessToken = "fresh"; } });
    await expect(w.client.json(using, "/v1/app/change", { method: "POST" })).rejects.toMatchObject(unknown);
    expect(w.calls).toHaveLength(1);
  });

  it("uses CodeError for unknown and leaves a first definitive refusal alone", async () => {
    const w = transport();
    await expect(w.client.json(session(), "/v1/app/change", { method: "POST" })).rejects.toBeInstanceOf(CodeError);
    const client = clientFor(async () => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(client.json(session(), "/v1/app/change", { method: "POST" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("the handler cannot re-enter after a Code write", () => {
  it.each(["StoreConflict", "SignInEnded"])("%s after dispatch returns unknown without executing the route again", async kind => {
    let writes = 0;
    const store = new LocalSessionStore(undefined, { environment: {} });
    await store.create("cookie", session());
    const client = clientFor(async () => { writes += 1; return json(200, { committed: true }); });
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/change", { method: "POST" });
      if (kind === "StoreConflict") throw new StoreConflict("synthetic");
      const stored = (await store.get("cookie"))!;
      stored.refreshToken = `other-${String(writes)}`;
      await store.save("cookie", stored);
      throw new SignInEnded();
    } };
    const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), routes: [route], origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
    const answer = await handler({ method: "POST", path: "/v1/web/change", query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" } });
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toMatchObject(unknown.body);
    expect(writes).toBe(1);
    expect(await store.get("cookie")).toBeDefined();
  });

  it.each([["archive", false], ["restore", false], ["archive", true], ["restore", true]] as const)("real %s adapter (expired access: %s) answers unknown for commit -> 401 -> refresh, never the later 403", async (action, expiredAccess) => {
    let writes = 0;
    let refreshes = 0;
    const store = new LocalSessionStore(undefined, { environment: {} });
    await store.create("cookie", session());
    const client = clientFor(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === "/v1/dev/access") return expiredAccess && (init?.headers as Record<string, string>).authorization === "Bearer old" ? json(401, {}) : json(200, access);
      if (path === "/v1/auth/token") { refreshes += 1; return json(200, { access_token: "fresh", refresh_token: "refresh-fresh" }); }
      writes += 1;
      return writes === 1 ? json(401, {}) : json(403, { error: { code: "FORBIDDEN" } });
    });
    const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
    const answer = await handler({ method: "POST", path: `/v1/web/projects/payments/reviewed-${action}`, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" }, body: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", expectedOrgId: COMPANY, expectedRevision: 1, expectedProjectRevision: 3, [action === "archive" ? "acknowledgeNewWorkStops" : "acknowledgeNewWorkAllowed"]: true }) });
    expect(answer?.status).toBe(503);
    expect(JSON.parse(answer!.body)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
    expect(writes).toBe(1);
    expect(refreshes).toBe(expiredAccess ? 2 : 1);
    expect((await store.get("cookie"))?.accessToken).toBe("fresh");
  });
});

// Lead 4 DEC 285: only a refusal before apply may release a one-shot action.
describe("post-forward failures never masquerade as refusals", () => {
  async function world(route: Route | undefined, fetchImpl: typeof fetch, work = new LocalWorkSessionStore(), store = new LocalSessionStore(undefined, { environment: {} })) {
    await store.create("cookie", session());
    const handler = createCloudHandler({ client: clientFor(fetchImpl), store, work, ...(route === undefined ? {} : { routes: [route] }), origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
    return async (path = "/v1/web/change", body: unknown = {}) => {
      const answer = await handler({ method: "POST", path, query: new URLSearchParams(), headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": "csrf" }, body: JSON.stringify(body) });
      return { status: answer!.status, body: JSON.parse(answer!.body) as unknown };
    };
  }

  it.each([400, 401, 403, 404, 409, 429])("a returned %s after Code accepted becomes unknown, with one dispatch", async status => {
    let writes = 0;
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/change", { method: "POST" });
      return { status, body: { error: { code: "CONFLICT", message: "Local record could not be saved" } } };
    } };
    const send = await world(route, async () => { writes += 1; return json(200, { status: "COMMITTED" }); });
    expect(await send()).toEqual(unknown);
    expect(writes).toBe(1);
  });

  it.each([403, 404, 409])("a follow-up Code read's %s cannot refuse the applied action", async status => {
    let applied = 0;
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/change", { method: "POST" });
      return { status: 200, body: await context.client.json(context.session, "/v1/app/changed") };
    } };
    const send = await world(route, async (_input, init) => init?.method === "POST" ? (applied += 1, json(200, { applied: true })) : json(status, { error: { code: "FORBIDDEN", message: "Read refused" } }));
    expect(await send()).toEqual(unknown);
    expect(applied).toBe(1);
  });

  it("even an unreadable 2xx counts before decode or later local failure", async () => {
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/change", { method: "POST" });
      throw new CodeError(409, { error: { code: "CONFLICT", message: "Local conflict" } });
    } };
    const send = await world(route, async () => new Response("not JSON", { status: 202 }));
    expect(await send()).toEqual(unknown);
  });

  it.each(["plain", "CodeError"])("a %s failure in the final sign-in save stays unknown after Code applied", async kind => {
    const store = new LocalSessionStore(undefined, { environment: {} });
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/change", { method: "POST" });
      context.session.changed = true;
      store.save = async () => { throw kind === "plain" ? new Error("local save failed") : new CodeError(403, { error: { code: "FORBIDDEN", message: "local" } }); };
      return { status: 200, body: { done: true } };
    } };
    const send = await world(route, async () => json(200, { committed: true }), undefined, store);
    expect(await send()).toEqual(unknown);
  });

  it("real take-over: COMMITTED then task-read 404 is unknown; Code's owner changed once", async () => {
    const work = new LocalWorkSessionStore();
    const sessionId = "ses_aaaaaaaaaaaaaaaaaaaa", taskId = "11111111-1111-4111-8111-111111111111";
    await work.put({ sessionId, taskId, companyId: COMPANY, project: "alpha", startedBy: { developerId: "b".repeat(64), name: "Bea" }, owner: { developerId: "b".repeat(64), name: "Bea" }, revision: 1, createdAt: "2026-11-20T00:00:00.000Z" });
    let owner = "Bea", writes = 0;
    const send = await world(undefined, async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (init?.method === "POST") { owner = "Ada"; writes += 1; return json(200, { change: { status: "COMMITTED" } }); }
      return path.endsWith("/people") ? json(200, { view: { revision: 1 } }) : json(404, { error: { code: "TASK_NOT_FOUND", message: "Can't read task" } });
    }, work);
    expect(await send(`/v1/web/sessions/${sessionId}/take-over`, { requestId: "22222222-2222-4222-8222-222222222222" })).toEqual(unknown);
    expect(owner).toBe("Ada"); expect(writes).toBe(1);
  });

  it("a connector's pending-store failure after Code accepted is unknown too", async () => {
    const store = new LocalSessionStore(undefined, { environment: {} });
    store.putPending = async () => { throw new CodeError(409, { error: { code: "CONFLICT", message: "local pending conflict" } }); };
    const state = "a".repeat(43);
    const send = await world(undefined, async () => json(200, { state, authorizeUrl: `https://github.com/login/oauth/authorize?client_id=synthetic&state=${state}` }), undefined, store);
    expect(await send("/v1/web/me/github/link")).toEqual(unknown);
  });

  it.each([400, 403, 404, 409])("a first-call %s refusal keeps the server's own words", async status => {
    const refusal = { error: { code: "CONFIG_INVALID", message: "The server's own refusal" } };
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => ({ status: 200, body: await context.client.json(context.session, "/v1/app/change", { method: "POST" }) }) };
    const send = await world(route, async () => json(status, refusal));
    expect(await send()).toEqual({ status, body: refusal });
  });

  it("a successful preflight GET does not turn a local pre-dispatch conflict into unknown", async () => {
    const route: Route = { method: "POST", path: /^\/change$/u, answer: async context => {
      await context.client.json(context.session, "/v1/app/read");
      return { status: 409, body: { error: { code: "CONFLICT", message: "Nothing to retry" } } };
    } };
    const send = await world(route, async () => json(200, {}));
    expect(await send()).toEqual({ status: 409, body: { error: { code: "CONFLICT", message: "Nothing to retry" } } });
  });
});
