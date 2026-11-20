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
