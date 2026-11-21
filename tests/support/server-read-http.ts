import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CodeSession } from "../../packages/cloud-server/src/index.js";
export const REQUEST = "11111111-1111-4111-8111-111111111111";
export const TIME = "2026-11-20T00:00:00.000Z";
export const confirmed = { requestId: REQUEST, operation: "start", checkedAt: TIME, outcome: "confirmed", task: { taskId: "22222222-2222-4222-8222-222222222222", project: "payments", createdAt: TIME } };
export const previewInput = { provider: "github", operation: "disconnect", target: { installationId: 7 } };
const unknown = { kind: "unknown", reason: "not_projected" };
export const preview = { ...previewInput, checkedAt: TIME, snapshot: "non_atomic", disconnectBlockers: { kind: "exact", count: 1, projects: ["payments"] }, repositories: unknown, runningTasks: unknown, queuedTasks: unknown };
export const codeResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
export const usingSession = (): CodeSession => ({ accessToken: "old", refreshToken: "refresh-old", csrf: "csrf", signedInAt: TIME, access: { developerId: "a".repeat(64), displayName: "Ada", administrator: false, companyId: "org_aaaaaaaaaaaaaaaaaaaa", companyRole: "owner", projects: [], notices: [] } });
export const clientFor = (transport: typeof fetch) => new CodeClient({ baseUrl: "https://code.example.test", clientId: "test", clientSecret: "synthetic", redirectUri: "https://cloud.example.test/callback", scopes: "", fetch: transport });
export async function httpWorld(body: unknown, status = 200, transport?: typeof fetch) {
  const calls: Array<{ path: string; method: string; init: RequestInit | undefined }> = [];
  const client = clientFor(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push({ path, method: init?.method ?? "GET", init });
    return transport === undefined ? codeResponse(status, body) : transport(input, init);
  });
  const store = new LocalSessionStore(undefined, { environment: {} });
  await store.create("cookie", usingSession());
  const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", callbackPath: "/callback", secureCookies: true, org: { orgId: "acme", name: "Acme", plan: "test" }, log: () => undefined });
  return { calls, client, store, handler, async call(path: string, method = "GET", input?: unknown, csrf = "csrf") {
    const url = new URL(path, "https://cloud.example.test");
    const result = await handler({ method, path: url.pathname, query: url.searchParams, headers: { cookie: "rovara_cloud_session=cookie", "x-rovara-csrf": csrf }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (result === undefined) throw new Error("route missing");
    return { status: result.status, headers: result.headers, body: JSON.parse(result.body) as unknown };
  } };
}
