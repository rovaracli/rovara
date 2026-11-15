// What the fake Code sends and what Cloud passes on must be READABLE by the web app: these tests parse them with the app's own reader schemas
// (@agentx/contracts/web). Found by running the thin app against the fake Code (UX audit 2026-11-15): the fake's task view lacked fields the app requires, so
// starting a task showed "Rovara returned an unreadable response", and `/v1/web/decisions` answered 404, so Home showed "Nothing needs you" over a waiting plan.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { DecisionCardsViewSchema, DecisionOutcomeSchema, DecisionEvidenceOpenedAnswerSchema } from "../../packages/contracts/src/decision-card-tabs.js";
import {
  DecisionCardsViewReaderSchema, HomeResponseReaderSchema, SessionEventPageReaderSchema, SessionResponseReaderSchema, TaskResponseReaderSchema,
} from "../../packages/contracts/src/web.js";
import { TASK_IDS, startFakeCode, type FakeCode } from "../support/fake-code.js";

let fake: FakeCode;
beforeAll(async () => { fake = await startFakeCode(); });
afterAll(async () => { await fake.close(); });

function cloudOn(url: string, options: { fetch?: typeof fetch } = {}) {
  const client = new CodeClient({ baseUrl: url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create", ...options });
  const handler = createCloudHandler({
    client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" },
    callbackPath: "/callback", secureCookies: false, log: () => undefined,
  });
  const call = async (method: string, target: string, o: { cookie?: string; csrf?: string; body?: unknown } = {}) => {
    const parsed = new URL(target, "http://127.0.0.1:8787");
    const request: CloseRequestShape = { method, path: parsed.pathname, query: parsed.searchParams, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { "x-rovara-csrf": o.csrf } : {}) }, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) };
    const answer = await handler(request);
    return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
  };
  return { call };
}
type CloseRequestShape = CloudRequest;

async function signedIn(cloud: ReturnType<typeof cloudOn>, codeUrl: string) {
  const start = await cloud.call("GET", "/v1/auth/browser/authorize?return_to=/app");
  const toCode = await fetch(start.headers["location"]!, { redirect: "manual" });
  const back = new URL(toCode.headers.get("location")!);
  void codeUrl;
  const finished = await cloud.call("GET", `${back.pathname}${back.search}`);
  const cookie = finished.headers["set-cookie"]!.split(";")[0]!;
  const me = (await cloud.call("GET", "/v1/web/me", { cookie })).body as { csrf: string };
  return { cookie, csrf: me.csrf };
}

describe("the fake Code's task view reads in the web app", () => {
  it("reads every canned task with the app's strict task schema (Code's workflow stages, states and required fields)", async () => {
    const own = await startFakeCode();
    try {
      const cloud = cloudOn(own.url);
      const { cookie, csrf } = await signedIn(cloud, own.url);
      // Ask the fake directly, as the person, through a started session's task list: the list route returns every canned task.
      const started = await cloud.call("POST", "/v1/web/projects/web/code", { cookie, csrf, body: { requestId: randomUUID(), input: { text: "Add dark mode" } } });
      const task = (started.body as { task: unknown }).task;
      expect(DeveloperTaskViewSchema.safeParse(task).success).toBe(true);
    } finally { await own.close(); }
    // All five canned tasks, by address.
    for (const id of Object.values(TASK_IDS)) {
      const tokens = await tokensFor(fake.url);
      const answer = await fetch(`${fake.url}/v1/dev/tasks/${id}`, { headers: { authorization: `Bearer ${tokens}` } });
      const body: unknown = await answer.json();
      const parsed = DeveloperTaskViewSchema.safeParse((body as { task: unknown }).task);
      expect(parsed.success, `${id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 4))}`).toBe(true);
    }
  });

  it("answers the request box, the session page and Home in shapes the app reads", async () => {
    const own = await startFakeCode();
    try {
      const cloud = cloudOn(own.url);
      const { cookie, csrf } = await signedIn(cloud, own.url);
      const started = await cloud.call("POST", "/v1/web/projects/web/code", { cookie, csrf, body: { requestId: randomUUID(), input: { text: "Add dark mode" } } });
      expect(started.status).toBe(201);
      const read = TaskResponseReaderSchema.safeParse(started.body);
      expect(read.success, read.success ? "" : JSON.stringify(read.error.issues.slice(0, 4))).toBe(true);
      const sessionId = (started.body as { sessionId: string }).sessionId;
      const session = await cloud.call("GET", `/v1/web/sessions/${sessionId}`, { cookie });
      const sessionRead = SessionResponseReaderSchema.safeParse(session.body);
      expect(sessionRead.success, sessionRead.success ? "" : JSON.stringify(sessionRead.error.issues.slice(0, 4))).toBe(true);
      const home = await cloud.call("GET", "/v1/web/home", { cookie });
      expect(HomeResponseReaderSchema.safeParse(home.body).success).toBe(true);
      // The Conversation's timeline reads Code's task events (Code's own kinds: status, progress, ...).
      const events = await cloud.call("GET", `/v1/web/sessions/${sessionId}/events`, { cookie });
      const page = SessionEventPageReaderSchema.safeParse(events.body);
      expect(page.success, page.success ? "" : JSON.stringify(page.error.issues.slice(0, 4))).toBe(true);
      expect((events.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
    } finally { await own.close(); }
  });
});

async function tokensFor(base: string): Promise<string> {
  const { createHash, randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const redirect = "http://127.0.0.1:8787/callback";
  const authorize = new URL(`${base}/v1/auth/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "rovara-cloud", redirect_uri: redirect, state: "s", scope: "projects:members", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const code = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await fetch(`${base}/v1/auth/token`, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from("rovara-cloud:fake-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect }),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}

describe("decision cards: the contract, the fake Code and Cloud agree on /v1/app/decisions", () => {
  it("Cloud passes Code's cards through, and the app's strict card schema accepts them", async () => {
    const own = await startFakeCode();
    try {
      const cloud = cloudOn(own.url);
      const { cookie, csrf } = await signedIn(cloud, own.url);
      const decisions = await cloud.call("GET", "/v1/web/decisions", { cookie });
      expect(decisions.status).toBe(200);
      const strict = DecisionCardsViewSchema.safeParse(decisions.body);
      expect(strict.success, strict.success ? "" : JSON.stringify(strict.error.issues.slice(0, 4))).toBe(true);
      expect(DecisionCardsViewReaderSchema.safeParse(decisions.body).success).toBe(true);
      const view = decisions.body as { cards: Array<{ id: string; actions: Array<{ kind: string; href: string }> }>; digests: Record<string, string> };
      const plan = view.cards.find((card) => card.id === `approve_plan:${TASK_IDS.planReview}`);
      expect(plan, "a plan waits for approval, so Home has a decision card for it").toBeDefined();
      // The app follows only the exact address `/v1/app/decisions/<kind>/<subject>/approve`.
      expect(plan!.actions.find((action) => action.kind === "approve")?.href).toBe(`/v1/app/decisions/approve_plan/${TASK_IDS.planReview}/approve`);
      // Approving through Cloud: Code checks the shown digest, so a stale one is refused and the right one decides.
      const path = `/v1/web/decisions/approve_plan/${TASK_IDS.planReview}/approve`;
      const stale = await cloud.call("POST", path, { cookie, csrf, body: { requestId: randomUUID(), shownDigest: "0".repeat(64) } });
      expect(stale.status).toBe(409);
      const decided = await cloud.call("POST", path, { cookie, csrf, body: { requestId: randomUUID(), shownDigest: view.digests[plan!.id] } });
      expect(decided.status).toBe(200);
      expect(DecisionOutcomeSchema.safeParse(decided.body).success).toBe(true);
      expect(decided.body).toMatchObject({ outcome: "approved" });
      const merge = `merge/${TASK_IDS.pullRequest}`;
      const shownDigest = view.digests[`merge:${TASK_IDS.pullRequest}`];
      const opened = await cloud.call("POST", `/v1/web/decisions/${merge}/evidence-opened?tab=design`, { cookie, csrf, body: { requestId: randomUUID(), shownDigest } });
      expect(DecisionEvidenceOpenedAnswerSchema.safeParse(opened.body).success).toBe(true);
      // A body with no request id never reaches Code.
      expect((await cloud.call("POST", `/v1/web/decisions/${merge}/approve`, { cookie, csrf, body: { shownDigest } })).status).toBe(400);
      // After the decision the plan card is gone.
      const after = (await cloud.call("GET", "/v1/web/decisions", { cookie })).body as { cards: Array<{ id: string }> };
      expect(after.cards.map((card) => card.id)).not.toContain(plan!.id);
    } finally { await own.close(); }
  });

  it("forwards only ?merging=1 and ?tab=design|requirements to Code, and refuses an unknown action or a kind with a dot before Code is called", async () => {
    const own = await startFakeCode();
    try {
      const real = fetch;
      const seen: string[] = [];
      const recording: typeof fetch = async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(target).pathname.startsWith("/v1/dev/client/decisions")) seen.push(new URL(target).pathname + new URL(target).search);
        return real(input, init);
      };
      const cloud = cloudOn(own.url, { fetch: recording });
      const { cookie, csrf } = await signedIn(cloud, own.url);
      const body = { requestId: randomUUID(), shownDigest: "b".repeat(64) };
      await cloud.call("POST", `/v1/web/decisions/merge/${TASK_IDS.pullRequest}/evidence-opened?merging=1&tab=design&evil=1&tab2=x`, { cookie, csrf, body });
      await cloud.call("POST", `/v1/web/decisions/merge/${TASK_IDS.pullRequest}/approve?merging=1&tab=../x`, { cookie, csrf, body });
      expect(seen).toEqual([
        `/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/evidence-opened?merging=1&tab=design`,
        `/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/approve?merging=1`,
      ]);
      const before = seen.length;
      expect((await cloud.call("POST", `/v1/web/decisions/merge/${TASK_IDS.pullRequest}/delete`, { cookie, csrf, body })).status).toBe(501);
      expect((await cloud.call("POST", `/v1/web/decisions/me.rge/${TASK_IDS.pullRequest}/approve`, { cookie, csrf, body })).status).toBe(501);
      expect((await cloud.call("POST", `/v1/web/decisions/merge/${TASK_IDS.pullRequest}/approve`, { cookie, csrf, body: { shownDigest: body.shownDigest } })).status).toBe(400);
      expect(seen.length).toBe(before);
    } finally { await own.close(); }
  });

  it("answers the 404 the app reads as 'cards are switched off' when Code does not serve decisions (as it does today)", async () => {
    const own = await startFakeCode();
    try {
      const real = fetch;
      // Code today: no decisions route (404), as the deployed code/next answers an unknown path.
      const withoutDecisions: typeof fetch = async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(target).pathname.startsWith("/v1/dev/client/decisions")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such route" } }), { status: 404, headers: { "content-type": "application/json" } });
        return real(input, init);
      };
      const cloud = cloudOn(own.url, { fetch: withoutDecisions });
      const { cookie } = await signedIn(cloud, own.url);
      const decisions = await cloud.call("GET", "/v1/web/decisions", { cookie });
      expect(decisions.status).toBe(404);
      expect(decisions.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      // And a 501 from Code reads the same way.
      const notImplemented: typeof fetch = async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(target).pathname.startsWith("/v1/dev/client/decisions")) return new Response("{}", { status: 501, headers: { "content-type": "application/json" } });
        return real(input, init);
      };
      const cloud2 = cloudOn(own.url, { fetch: notImplemented });
      const { cookie: cookie2 } = await signedIn(cloud2, own.url);
      expect((await cloud2.call("GET", "/v1/web/decisions", { cookie: cookie2 })).status).toBe(404);
    } finally { await own.close(); }
  });
});
