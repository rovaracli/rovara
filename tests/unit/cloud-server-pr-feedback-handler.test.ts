// The three PR feedback forwarding routes through Cloud's real handler, against a fake Code that records every call and its bearer token
// (controller ruling 2026-11-23): each forwards the CALLER'S OWN token, checks the company's sessions FIRST, checks the body against Code's own schema,
// and adds no authority of its own (Cloud's session + CSRF check only; Code decides who may and answers its own words, which come back unchanged).
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type WorkSession } from "../../packages/cloud-server/src/index.js";

const CODE = "https://code.example.test", ORIGIN = "https://cloud.example.test";
const ADA = "a".repeat(64), SAM = "b".repeat(64), EVE = "c".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa", OTHER_COMPANY = "org_bbbbbbbbbbbbbbbbbbbb";
const TASK = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", SESSION = "ses_aaaaaaaaaaaaaaaaaaaa", DIGEST = "1".repeat(64);
const KEEP = { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: 7, reviewDigest: DIGEST, proposalDigest: "2".repeat(64), bundleDigests: ["3".repeat(64)], decision: "DISMISS", selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." };
const RETRY = { reviewDigest: DIGEST };
const TASK_VIEW = { taskId: TASK, title: "Add refunds endpoint", project: "payments", status: "SUCCEEDED", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 8, feedbackReview: { status: "PENDING" } } };
const REFUSAL = { error: { code: "CONFIG_INVALID", message: "The feedback changed since this card; a new review is starting." } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call { method: string; path: string; token: string | undefined; body: unknown }
const ROUTES = [
  { name: "feedback read", method: "GET", app: `/v1/web/sessions/${SESSION}/feedback`, code: `/v1/dev/tasks/${TASK}/workflow/feedback`, body: undefined, answer: { review: { taskId: TASK, revision: 7, status: "PENDING" } } },
  { name: "feedback decision", method: "POST", app: `/v1/web/sessions/${SESSION}/feedback-decision`, code: `/v1/dev/tasks/${TASK}/workflow/feedback-decision`, body: KEEP, answer: { task: TASK_VIEW } },
  { name: "feedback retry", method: "POST", app: `/v1/web/sessions/${SESSION}/feedback-retry`, code: `/v1/dev/tasks/${TASK}/workflow/feedback-retry`, body: RETRY, answer: { task: TASK_VIEW, started: true } },
] as const;

function world(codeAnswer: { status: number; body: unknown } | undefined = undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, token: headers.authorization?.replace(/^Bearer /u, ""), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (url.pathname.includes("/workflow/feedback")) {
      if (codeAnswer !== undefined) return json(codeAnswer.status, codeAnswer.body);
      return json(200, ROUTES.find(route => route.code === url.pathname)?.answer ?? {});
    }
    if (url.pathname === `/v1/dev/tasks/${TASK}`) return json(200, { task: TASK_VIEW });
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} }), work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({ client, store, work, origin: ORIGIN, org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(Date.UTC(2026, 10, 22)) });
  const record: WorkSession = { sessionId: SESSION, taskId: TASK, project: "payments", startedBy: { developerId: ADA, name: "Ada" }, owner: { developerId: ADA, name: "Ada" }, createdAt: "2026-11-22T00:00:00.000Z", revision: 1, companyId: COMPANY };
  const signIn = async (token: string, developerId: string, companyId: string) => {
    await work.put({ ...record });
    await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: "2026-11-22T00:00:00.000Z", access: { developerId, displayName: token, administrator: false, projects: [{ name: "payments", access: "developer" }], notices: [], companyId, companyRole: "member" } });
    return { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf", origin: ORIGIN } as Record<string, string>;
  };
  const send = async (route: (typeof ROUTES)[number], headers: Record<string, string>, body: unknown = route.body) => {
    const request: CloudRequest = { method: route.method, path: route.app, query: new URLSearchParams(), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answered = await handler(request);
    return { status: answered!.status, body: JSON.parse(answered!.body) as { error?: { code: string; message: string } } & Record<string, unknown> };
  };
  const feedbackCalls = () => calls.filter(call => call.path.includes("/workflow/feedback"));
  return { calls, feedbackCalls, signIn, send, ada: () => signIn("ada-token", ADA, COMPANY), sam: () => signIn("sam-token", SAM, COMPANY), eve: () => signIn("eve-token", EVE, OTHER_COMPANY) };
}

// Code answers this when the choice COMMITTED but its own follow-up read failed: Cloud passes it through unchanged (the card treats it as unknown and keeps the lock).
const COMMITTED = { error: { code: "COMMITTED_REFRESH_NEEDED", message: "Your choice was recorded, but Rovara couldn't read it back." } };

describe.each(ROUTES)("$name route", route => {
  it("allowed: exactly one forward to Code's own route, with Code's exact envelope and the caller's own token", async () => {
    const w = world();
    const result = await w.send(route, await w.ada());
    expect(result.status).toBe(200);
    expect(w.feedbackCalls()).toEqual([{ method: route.method, path: route.code, token: "ada-token", body: route.body }]);
    // Cloud adds no service identity anywhere: every call it made to Code carried this person's token.
    expect(new Set(w.calls.filter(call => call.path !== "/v1/auth/token").map(call => call.token))).toEqual(new Set(["ada-token"]));
  });
  it("another person's request carries THAT person's token, and Cloud adds no authority: a same-company reader is forwarded and Code's refusal comes back unchanged", async () => {
    const w = world({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only the task owner can do that." } } });
    const result = await w.send(route, await w.sam());
    expect(w.feedbackCalls()).toEqual([{ method: route.method, path: route.code, token: "sam-token", body: route.body }]);
    expect(result).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only the task owner can do that." } } });
  });
  it("another company's session is absent before anything is asked of Code", async () => {
    const w = world();
    const result = await w.send(route, await w.eve());
    expect(result.status).toBe(404);expect(w.calls.filter(call => call.path !== "/v1/auth/token")).toEqual([]);
  });
  it("no sign-in, or a missing or wrong CSRF token, sends nothing to Code", async () => {
    const w = world();
    const headers = await w.ada();
    expect((await w.send(route, {})).status).toBe(401);
    if (route.method === "POST") {
      const withoutCsrf = { ...headers };
      delete withoutCsrf["x-rovara-csrf"];
      expect((await w.send(route, withoutCsrf)).status).toBe(403);
      expect((await w.send(route, { ...headers, "x-rovara-csrf": "wrong" })).status).toBe(403);
    }
    expect(w.calls.filter(call => call.path !== "/v1/auth/token")).toEqual([]);
  });
  it.each([[400, REFUSAL], [402, { error: { code: "TASK_BUDGET_EXCEEDED", message: "This task has reached its spending limit." } }], [404, { error: { code: "NOT_FOUND", message: "PR feedback review not found" } }], [409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "this request ID was already used" } }], [409, COMMITTED], [500, COMMITTED], [502, COMMITTED]] as const)("Code's %s refusal comes back with the same status and words", async (status, body) => {
    const w = world({ status, body });
    expect(await w.send(route, await w.ada())).toEqual({ status, body });
    expect(w.feedbackCalls()).toHaveLength(1);
  });
});

describe.each(ROUTES.filter(route => route.method === "POST"))("$name body", route => {
  const bad = route.name === "feedback retry"
    ? [{}, { reviewDigest: "x" }, { ...RETRY, requestId: "22222222-2222-4222-8222-222222222222" }, { ...RETRY, extra: 1 }]
    : [{}, { ...KEEP, extra: 1 }, { ...KEEP, ownerNote: undefined }, { ...KEEP, decision: "APPROVE" }, { ...KEEP, bundleDigests: [] }, { ...KEEP, reviewDigest: "x" }];
  it("a body that fails Code's own schema is refused and nothing is forwarded", async () => {
    const w = world();
    const headers = await w.ada();
    for (const body of bad) expect((await w.send(route, headers, body)).status).toBe(400);
    expect(w.calls.filter(call => call.path !== "/v1/auth/token")).toEqual([]);
  });
  it("another company's session with a bad body is still just absent (the company is checked before the body)", async () => {
    const w = world();
    expect((await w.send(route, await w.eve(), bad[0])).status).toBe(404);
  });
});

it("the decision forwarded is Code's own parsed envelope (its schema trims the note), never the raw request", async () => {
 const w = world();
 const route = ROUTES[1];
 expect((await w.send(route, await w.ada(), { ...KEEP, ownerNote: "  " + KEEP.ownerNote + "\n" })).status).toBe(200);
 expect(w.feedbackCalls().map(call => call.body)).toEqual([KEEP]);
});
