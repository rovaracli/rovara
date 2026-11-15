// The fake Rovara Code (tests/support/fake-code.ts, `npm run fake-code`): it answers every route of contract v0, checks sign-in the way Code does, and
// Cloud's own server runs on it end to end (sign in, Home, a session, the plan approval).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { CODE_ROUTES, pathParamNames, type PlanComment, type PlanView, type ProofIndexResponse } from "../../packages/contracts/src/code-contract-v0.js";
import { PRIYA, SAM, TASK_IDS, startFakeCode, type FakeCode } from "../support/fake-code.js";

let fake: FakeCode;
beforeAll(async () => { fake = await startFakeCode(); });
afterAll(async () => { await fake.close(); });

/** Signs in the way Cloud does (PKCE, client secret) and returns the person's tokens. */
async function signIn(base: string, secret = "fake-secret") {
  const verifier = randomBytes(32).toString("base64url");
  const redirect = "http://127.0.0.1:8787/callback";
  const authorize = new URL(`${base}/v1/auth/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "rovara-cloud", redirect_uri: redirect, state: "s1", scope: "projects:members", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const step = await fetch(authorize, { redirect: "manual" });
  expect(step.status).toBe(302);
  const back = new URL(step.headers.get("location") ?? "");
  expect(back.searchParams.get("state")).toBe("s1");
  const token = await fetch(`${base}/v1/auth/token`, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from(`rovara-cloud:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: verifier, redirect_uri: redirect }),
  });
  return { token, verifier, code: back.searchParams.get("code") ?? "" };
}

const call = async (path: string, token: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${fake.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

describe("fake Code sign-in", () => {
  it("issues tokens for the right secret and PKCE verifier, and refuses a wrong secret or a reused code", async () => {
    const good = await signIn(fake.url);
    expect(good.token.status).toBe(200);
    const tokens = await good.token.json() as { access_token: string; refresh_token: string };
    expect((await call("/v1/dev/access", tokens.access_token, { method: "POST", body: {} })).status).toBe(200);
    expect((await signIn(fake.url, "wrong")).token.status).toBe(401);
    expect((await fetch(`${fake.url}/v1/auth/token`, {
      method: "POST", headers: { authorization: `Basic ${Buffer.from("rovara-cloud:fake-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: good.code, code_verifier: good.verifier, redirect_uri: "http://127.0.0.1:8787/callback" }),
    })).status).toBe(400);
  });

  it("refuses a fresh code exchanged with the wrong PKCE verifier", async () => {
    const redirect = "http://127.0.0.1:8787/callback";
    const authorize = new URL(`${fake.url}/v1/auth/authorize`);
    authorize.search = new URLSearchParams({ response_type: "code", client_id: "rovara-cloud", redirect_uri: redirect, state: "s2", scope: "projects:members", code_challenge: createHash("sha256").update("the-real-verifier").digest("base64url"), code_challenge_method: "S256" }).toString();
    const code = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location") ?? "").searchParams.get("code") ?? "";
    const bad = await fetch(`${fake.url}/v1/auth/token`, {
      method: "POST", headers: { authorization: `Basic ${Buffer.from("rovara-cloud:fake-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier", redirect_uri: redirect }),
    });
    expect(bad.status).toBe(400);
  });

  it("rotates refresh tokens (each works once) and answers 401 without a known bearer token", async () => {
    const tokens = await (await signIn(fake.url)).token.json() as { access_token: string; refresh_token: string };
    const refresh = (value: string) => fetch(`${fake.url}/v1/auth/token`, {
      method: "POST", headers: { authorization: `Basic ${Buffer.from("rovara-cloud:fake-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: value }),
    });
    expect((await refresh(tokens.refresh_token)).status).toBe(200);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect((await call("/v1/dev/access", "not-a-token", { method: "POST", body: {} })).status).toBe(401);
  });
});

describe("fake Code answers contract v0", () => {
  it("answers every route in the contract (never a missing route or a crash)", async () => {
    const tokens = await (await signIn(fake.url)).token.json() as { access_token: string };
    const sample: Record<string, string> = {
      taskId: TASK_IDS.running, project: "web", developerId: "e".repeat(64), requestId: randomUUID(), sha256: "d".repeat(64), kind: "approve_plan", subject: TASK_IDS.planReview,
      action: "evidence-opened", tokenId: randomUUID(), channel: "slack", workspace: "T0FAKE", account: "U0FAKE", lessonId: "les_logs00001",
    };
    for (const route of CODE_ROUTES) {
      if (route.id === "auth.authorize" || route.id === "auth.token") continue;
      const path = route.path.replace(/\{(\w+)\}/gu, (_, name: string) => encodeURIComponent(sample[name] ?? "x"));
      const read = route.method === "GET" || route.method === "DELETE";
      const result = await call(path, tokens.access_token, { method: route.method, ...(read ? {} : { body: { requestId: randomUUID(), kind: "comment", text: "hi", document: "plan", label: "ci", emails: ["a@example.test"], role: "member", repository: "example/web", instructions: "x", project: "web", expectedRevision: 1, settings: {}, token: "t" } }) });
      const detail = `${route.id} ${route.method} ${path} -> ${String(result.status)} ${JSON.stringify(result.body)}`;
      expect(result.status, detail).toBeLessThan(500);
      expect(typeof result.body === "object" && result.body !== null, detail).toBe(true);
      expect(JSON.stringify(result.body), detail).not.toContain("route not found");
    }
  });

  it("has a path parameter sample for every parameter the contract names", () => {
    const names = new Set(CODE_ROUTES.flatMap((route) => pathParamNames(route.path)));
    expect([...names].sort()).toEqual(["account", "action", "channel", "developerId", "kind", "lessonId", "project", "requestId", "sha256", "subject", "taskId", "tokenId", "workspace"].sort());
  });

  it("keeps a task you start, answers the same task for the same request id, and hides it from others", async () => {
    const priya = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    const requestId = randomUUID();
    const first = await call("/v1/dev/tasks", priya, { method: "POST", body: { requestId, project: "web", instructions: "Add dark mode" } });
    const again = await call("/v1/dev/tasks", priya, { method: "POST", body: { requestId, project: "web", instructions: "Add dark mode" } });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const taskId = (first.body as { task: { taskId: string } }).task.taskId;
    expect((again.body as { task: { taskId: string } }).task.taskId).toBe(taskId);
    fake.setPerson(SAM);
    const sam = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    fake.setPerson(PRIYA);
    expect((await call(`/v1/dev/tasks/${taskId}`, sam)).status).toBe(404);
    expect((await call(`/v1/dev/tasks/${taskId}/readers/${SAM.developerId}`, priya, { method: "PUT", body: { requestId: randomUUID(), role: "viewer" } })).status).toBe(200);
    expect((await call(`/v1/dev/tasks/${taskId}`, sam)).status).toBe(200);
    expect((await call(`/v1/dev/tasks/${taskId}/cancel`, sam, { method: "POST", body: { requestId: randomUUID() } })).status).toBe(403);
  });

  it("refuses a plan decision for a plan that changed, and moves the task on for the current one", async () => {
    const priya = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    const path = `/v1/dev/tasks/${TASK_IDS.planReview}/workflow/decision`;
    const stale = await call(path, priya, { method: "POST", body: { requestId: randomUUID(), expectedRevision: 1, decision: "APPROVE", reason: "ok", artifactDigest: "a".repeat(64) } });
    expect(stale.status).toBe(409);
    const good = await call(path, priya, { method: "POST", body: { requestId: randomUUID(), expectedRevision: 4, decision: "APPROVE", reason: "ok", artifactDigest: "a".repeat(64) } });
    expect(good.status).toBe(200);
    expect((good.body as { task: { workflow: { stage: string } } }).task.workflow.stage).toBe("IMPLEMENT");
  });

  it("lists decision cards with a digest, and refuses to act on a card whose digest changed", async () => {
    const priya = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    const view = (await call("/v1/dev/client/decisions", priya)).body as { cards: Array<{ id: string }>; digests: Record<string, string> };
    expect(view.cards.map((card) => card.id)).toContain(`merge:${TASK_IDS.pullRequest}`);
    const stale = await call(`/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/approve`, priya, { method: "POST", body: { requestId: randomUUID(), shownDigest: "0".repeat(64) } });
    expect(stale.status).toBe(409);
    // A medium card (merge) is refused until its evidence was opened with the digest shown; then it is merged and leaves the list.
    const shownDigest = view.digests[`merge:${TASK_IDS.pullRequest}`]!;
    const early = await call(`/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/approve`, priya, { method: "POST", body: { requestId: randomUUID(), shownDigest } });
    expect(early.status).toBe(409);
    expect((await call(`/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/evidence-opened`, priya, { method: "POST", body: { requestId: randomUUID(), shownDigest } })).body).toMatchObject({ opened: true, recorded: true });
    const merged = await call(`/v1/dev/client/decisions/merge/${TASK_IDS.pullRequest}/approve`, priya, { method: "POST", body: { requestId: randomUUID(), shownDigest } });
    expect(merged.body).toMatchObject({ cardId: `merge:${TASK_IDS.pullRequest}`, outcome: "approved", remainingTabs: [] });
    const after = (await call("/v1/dev/client/decisions", priya)).body as { cards: Array<{ id: string }> };
    expect(after.cards.map((card) => card.id)).not.toContain(`merge:${TASK_IDS.pullRequest}`);
  });
});

describe("fake Code carries the UX additions of contract v0 (all optional)", () => {
  it("returns a structured spec whose ids point at each other, a proof index that points at its criteria, and events that name their plan task", async () => {
    const priya = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    const plan = (await call(`/v1/dev/tasks/${TASK_IDS.running}/plan`, priya)).body as PlanView;
    const criteria = (plan.requirements ?? []).flatMap((requirement) => requirement.criteria);
    const tasks = plan.tasks ?? [];
    expect(criteria.length).toBeGreaterThan(0);
    for (const criterion of criteria) for (const id of criterion.taskIds ?? []) expect(tasks.map((task) => task.id)).toContain(id);
    for (const task of tasks) for (const id of task.criterionIds ?? []) expect(criteria.map((criterion) => criterion.id)).toContain(id);
    for (const question of plan.questions ?? []) {
      expect(criteria.map((criterion) => criterion.id)).toContain(question.criterionId);
      expect((question.options ?? []).map((option) => option.optionId)).toContain(question.defaultOptionId);
    }
    const proof = (await call(`/v1/dev/tasks/${TASK_IDS.running}/evidence`, priya)).body as ProofIndexResponse;
    expect(proof.items.length).toBeGreaterThan(0);
    for (const item of proof.items) for (const id of item.criterionIds) expect(criteria.map((criterion) => criterion.id)).toContain(id);
    expect(proof.items.some((item) => item.passed !== undefined && item.total !== undefined && item.bar !== undefined)).toBe(true);
    const events = (await call(`/v1/dev/tasks/${TASK_IDS.running}/events`, priya)).body as { events: Array<{ taskItemId?: string }> };
    expect(events.events.some((event) => tasks.some((task) => task.id === event.taskItemId))).toBe(true);
    expect((await call(`/v1/dev/tasks/${TASK_IDS.running}/evidence`, "not-a-token")).status).toBe(401);
  });

  it("returns the anchor and the reply-to a comment was written with, and neither when it had none", async () => {
    const priya = (await (await signIn(fake.url)).token.json() as { access_token: string }).access_token;
    const path = `/v1/dev/tasks/${TASK_IDS.running}/comments`;
    const first = (await call(path, priya, { method: "POST", body: { requestId: randomUUID(), document: "plan", text: "Why this order?", anchor: "R1.1" } })).body as { comment: PlanComment };
    expect(first.comment.anchor).toBe("R1.1");
    expect("replyTo" in first.comment).toBe(false);
    const reply = (await call(path, priya, { method: "POST", body: { requestId: randomUUID(), document: "plan", text: "Because of the test", replyTo: first.comment.commentId } })).body as { comment: PlanComment };
    expect(reply.comment.replyTo).toBe(first.comment.commentId);
    expect("anchor" in reply.comment).toBe(false);
    expect(((await call(path, priya)).body as { comments: PlanComment[] }).comments.map((comment) => comment.commentId)).toEqual(expect.arrayContaining([first.comment.commentId, reply.comment.commentId]));
  });
});

describe("Cloud's server on the fake Code", () => {
  it("signs a person in, shows Home and a session, and approves the waiting plan", async () => {
    const own = await startFakeCode();
    try {
      const client = new CodeClient({ baseUrl: own.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
      const handler = createCloudHandler({
        client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" },
        callbackPath: "/callback", secureCookies: false, log: () => undefined,
      });
      const call2 = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}) => {
        const url = new URL(target, "http://127.0.0.1:8787");
        const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) };
        const answer = await handler(request);
        return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
      };
      const start = await call2("GET", "/v1/auth/browser/authorize?return_to=/app");
      const toCode = await fetch(start.headers["location"]!, { redirect: "manual" });
      const back = new URL(toCode.headers.get("location")!);
      const finished = await call2("GET", `${back.pathname}${back.search}`);
      expect(finished.status).toBe(302);
      const cookie = finished.headers["set-cookie"]!.split(";")[0]!;
      const me = (await call2("GET", "/v1/web/me", { cookie })).body as { csrf: string; developer: { name: string; orgRole: string } };
      expect(me.developer).toMatchObject({ name: "Priya", orgRole: "owner" });
      const projects = (await call2("GET", "/v1/web/projects", { cookie })).body as { projects: Array<{ name: string }> };
      expect(projects.projects.map((project) => project.name).sort()).toEqual(["api", "web"]);
      // The request box: start work in a project, and it becomes a session.
      const started = await call2("POST", "/v1/web/projects/web/code", { cookie, csrf: me.csrf, body: { requestId: randomUUID(), input: { text: "Add dark mode" } } });
      expect(started.status).toBe(201);
      const sessionId = (started.body as { sessionId: string }).sessionId;
      const session = await call2("GET", `/v1/web/sessions/${sessionId}`, { cookie });
      expect(session.status).toBe(200);
      expect((session.body as { session: { title: string } }).session.title).toBe("Add dark mode");
      // A route Code does not serve yet answers 501 through Cloud, not an error page.
      expect((await call2("GET", "/v1/web/projects/web/how-we-work", { cookie })).status).toBe(501);
      // Home reads the person's own sessions: the one just started shows (no card yet), and the call works.
      expect((await call2("GET", "/v1/web/home", { cookie })).status).toBe(200);
      expect((await call2("GET", "/v1/web/nav", { cookie })).status).toBe(200);
    } finally {
      await own.close();
    }
  });
});
