/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the tests read Cloud's JSON answers and break a plain JSON body at a path */
// The Cost and time actions (Feature A, lane L4-CR4): New feature, Rename, Merge into, Mark done or reopen, and Move to feature, through Cloud's handler against a pretend Rovara Code that
// follows Code's own rules (PR #913). Cloud is a pass-through: Code decides who may and which company; Cloud checks the body's shape, passes the person's own token and gives fixed words.
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../../packages/contracts/src/code-contract-v0.js";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest, type CodeSession } from "../../packages/cloud-server/src/index.js";
import { ACTION_WORDS } from "../../packages/cloud-server/src/report-action-routes.js";
import { CODE_REPORT_FEATURES_PATH, CODE_REPORT_TASKS_PATH, REPORT_WORDS } from "../../packages/cloud-server/src/report-routes.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), GRACE = "f".repeat(64), BOB = "b".repeat(64), NOCOMPANY = "c".repeat(64);
const ACME = "org_acme0000000000000000", GLOBEX = "org_globex00000000000000";
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const uuidOf = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F1 = FT("1"), F2 = FT("2"), FG = FT("b"), FDONE = FT("d");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Code's own fixed sentences (packages/contracts/src/cost-report.ts there).
const CODE_WORDS = {
  adminOnly: "Only an owner or admin of the company can change features.",
  notFound: "That feature does not exist.",
  taken: "A feature with that name already exists.",
  limit: "The company has as many features as it can hold. Merge or reuse one.",
  isDone: "That feature is done. Reopen it first.",
  cannotMerge: "A feature cannot be merged into itself or into one already merged away.",
  conflict: "The feature changed while you were saving. Try again.",
  taskNotFound: "task not found",
  needsMaintainer: "Only a project maintainer, owner or admin can move a task that already has a feature.",
};

interface CodeFeature { name: string; state: "open" | "done" }
interface CodeTask { starter: string; feature?: string | null; source?: string; project: string; title: string }
interface CodeCompany { features: Map<string, CodeFeature>; tasks: Map<string, CodeTask> }
interface Call { method: string; path: string; authorization: string | undefined; body: string | undefined }

const WHO: Record<string, { id: string; role?: string; company?: string }> = {
  "ada-token": { id: ADA, role: "admin", company: ACME }, "owner-token": { id: "d".repeat(64), role: "owner", company: ACME }, "grace-token": { id: GRACE, role: "member", company: ACME },
  "bob-token": { id: BOB, role: "admin", company: GLOBEX }, "nobody-token": { id: NOCOMPANY },
};

function world(over: { respond?: (call: Call) => Response | undefined; access?: () => Response | undefined } = {}) {
  const companies: Record<string, CodeCompany> = {
    [ACME]: {
      features: new Map<string, CodeFeature>([[F1, { name: "Checkout v2", state: "open" }], [F2, { name: "Search", state: "open" }], [FDONE, { name: "Old work", state: "done" }]]),
      tasks: new Map<string, CodeTask>([
        [uuidOf(1), { starter: ADA, feature: F1, source: "chosen", project: "web", title: "Pay with card" }],
        [uuidOf(2), { starter: GRACE, project: "web", title: "Graces task" }],
        [uuidOf(3), { starter: ADA, project: "web", title: "No feature yet" }],
      ]),
    },
    [GLOBEX]: { features: new Map<string, CodeFeature>([[FG, { name: "Globex plan", state: "open" }]]), tasks: new Map<string, CodeTask>([[uuidOf(9), { starter: BOB, project: "api", title: "Globex secret task" }]]) },
  };
  const calls: Call[] = [];
  let counter = 0;
  const view = (id: string, f: CodeFeature) => ({ id, name: f.name, state: f.state, createdAt: iso(NOW), updatedAt: iso(NOW), requesterId: "leak" });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    const who = WHO[(authorization ?? "").replace("Bearer ", "")];
    if (url.pathname === "/v1/dev/access" && over.access?.() !== undefined) return over.access()!;
    if (url.pathname === "/v1/dev/access") {
      return who === undefined ? json(401, {}) : json(200, { developerId: who.id, displayName: "x", administrator: false, ...(who.company === undefined ? {} : { companyId: who.company, companyRole: who.role }), projects: [], notices: [] });
    }
    if (url.pathname === "/v1/auth/token") return json(400, { error: "invalid_grant" });
    if (who === undefined || who.company === undefined) return json(401, {});
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = { method, path: url.pathname, authorization, body };
    const company = companies[who.company]!;
    const admin = who.role === "owner" || who.role === "admin";
    const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
    if (method === "GET" && url.pathname === CODE_REPORT_FEATURES_PATH) { calls.push(call); return json(200, { features: [...company.features].map(([id, f]) => view(id, f)) }); }
    if (method === "GET" && url.pathname === CODE_REPORT_TASKS_PATH) {
      calls.push(call);
      const tasks = [...company.tasks].map(([taskId, t]) => ({
        taskId, project: t.project, title: t.title, origin: "web", state: "open", startedAt: iso(NOW - 86_400_000), prsOpened: 0, prsMerged: 0, prLinks: [], costMicros: 0, unpricedCalls: 0,
        ...(t.feature === undefined || t.feature === null ? {} : { feature: { id: t.feature, source: t.source ?? "moved" } }),
      }));
      return json(200, { tasks, next: String(tasks.length), hasMore: false, skipped: 0, unreadable: 0 });
    }
    if (method !== "POST") return err(404, "NOT_FOUND", "route not found");
    calls.push(call);
    const special = over.respond?.(call);
    if (special !== undefined) return special;
    const given = body === undefined ? {} : (JSON.parse(body) as Record<string, any>);
    if (url.pathname === CODE_REPORT_FEATURES_PATH) {
      if (!admin) return err(403, "FORBIDDEN", CODE_WORDS.adminOnly);
      if ([...company.features.values()].some((f) => f.name === given["name"])) return err(400, "CONFIG_INVALID", CODE_WORDS.taken);
      counter += 1;
      const id = `ft_${counter.toString(16).padStart(20, "0")}`;
      company.features.set(id, { name: given["name"], state: "open" });
      return json(201, { feature: view(id, company.features.get(id)!) });
    }
    const action = /^\/v1\/app\/org\/report\/features\/([^/]+)\/(rename|merge|state)$/u.exec(url.pathname);
    if (action !== null) {
      if (!admin) return err(403, "FORBIDDEN", CODE_WORDS.adminOnly);
      const feature = company.features.get(action[1]!);
      if (feature === undefined) return err(404, "NOT_FOUND", CODE_WORDS.notFound);
      if (action[2] === "rename") { feature.name = given["name"]; return json(200, { feature: view(action[1]!, feature) }); }
      if (action[2] === "state") { feature.state = given["state"]; return json(200, { feature: view(action[1]!, feature) }); }
      const into = company.features.get(given["into"]);
      if (into === undefined) return err(404, "NOT_FOUND", CODE_WORDS.notFound);
      if (given["into"] === action[1]) return err(400, "CONFIG_INVALID", CODE_WORDS.cannotMerge);
      for (const t of company.tasks.values()) if (t.feature === action[1]) t.feature = given["into"];
      company.features.delete(action[1]!);
      return json(200, { feature: view(given["into"], into) });
    }
    const move = /^\/v1\/app\/tasks\/([^/]+)\/feature$/u.exec(url.pathname);
    if (move !== null) {
      const task = company.tasks.get(move[1]!);
      if (task === undefined) return err(404, "NOT_FOUND", CODE_WORDS.taskNotFound);
      if (!admin && task.starter !== who.id) return err(404, "NOT_FOUND", CODE_WORDS.taskNotFound);
      if (!admin && task.feature !== undefined) return err(403, "FORBIDDEN", CODE_WORDS.needsMaintainer);
      const target = given["feature"] as string | null;
      if (target !== null && !company.features.has(target)) return err(404, "NOT_FOUND", CODE_WORDS.notFound);
      if (target !== null && company.features.get(target)!.state === "done") return err(400, "CONFIG_INVALID", CODE_WORDS.isDone);
      task.feature = target;
      task.source = admin ? "moved" : "chosen";
      return json(200, { task: { taskId: move[1], feature: target === null ? null : { id: target, source: task.source } } });
    }
    return err(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  const store = new LocalSessionStore(undefined, { environment: {} });
  const sessions = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
  const handler = createCloudHandler({ client, store, work: sessions, origin: "https://cloud.example.test", org: { orgId: "rovara", name: "Rovara", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(NOW) });
  const cookies = new Map<string, string>();
  const signIn = async (token: string) => {
    if (cookies.has(token)) return cookies.get(token)!;
    const session: CodeSession = { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: iso(NOW), access: { developerId: WHO[token]!.id, displayName: "x", administrator: false, projects: [], notices: [] } };
    await store.create(`cookie-${token}`, session);
    cookies.set(token, `rovara_cloud_session=cookie-${token}`);
    return cookies.get(token)!;
  };
  const send = async (method: "GET" | "POST", target: string, token?: string, body?: unknown, headers: Record<string, string> = {}, csrf = "csrf") => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const cookie = token === undefined ? undefined : await signIn(token);
    const request: CloudRequest = {
      method, path: url.pathname, query: url.searchParams, headers: { ...(cookie === undefined ? {} : { cookie }), ...(method === "POST" && cookie !== undefined ? { "x-rovara-csrf": csrf } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    };
    const answer = await handler(request);
    return { status: answer!.status, text: answer!.body, body: JSON.parse(answer!.body) as any };
  };
  const posts = () => calls.filter((call) => call.method === "POST");
  return { companies, calls, posts, get: (target: string, token?: string) => send("GET", target, token), post: (target: string, token: string | undefined, body?: unknown, headers?: Record<string, string>, csrf?: string) => send("POST", target, token, body, headers, csrf), sessions };
}

const NEW = "/v1/web/org/report/features";
const ACTION = (id: string, what: string) => `/v1/web/org/report/features/${id}/${what}`;
const MOVE = (taskId: string) => `/v1/web/tasks/${taskId}/feature`;
const CODE_ACTION = (id: string, what: string) => `/v1/app/org/report/features/${id}/${what}`;

describe("New feature", () => {
  it("asks Code to make it as the person, with the name and nothing else, and sends back only the feature's id, name and state", async () => {
    const w = world();
    const answer = await w.post(NEW, "ada-token", { name: "Billing v3" });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ feature: { id: "ft_00000000000000000001", name: "Billing v3", state: "open" } });
    expect(answer.text).not.toContain("leak");
    expect(w.posts()).toEqual([{ method: "POST", path: "/v1/app/org/report/features", authorization: "Bearer ada-token", body: JSON.stringify({ name: "Billing v3" }) }]);
    expect(w.companies[GLOBEX]!.features.size).toBe(1);
  });
  it("lets an owner do it too", async () => {
    const w = world();
    expect((await w.post(NEW, "owner-token", { name: "Owner feature" })).status).toBe(200);
  });
  it("needs a sign-in and the page's own CSRF header", async () => {
    const w = world();
    expect((await w.post(NEW, undefined, { name: "x" })).status).toBe(401);
    expect((await w.post(NEW, "ada-token", { name: "x" }, {}, "wrong")).status).toBe(403);
    expect(w.posts()).toHaveLength(0);
  });
  it("refuses a plain member in fixed words without asking Code", async () => {
    const w = world();
    const answer = await w.post(NEW, "grace-token", { name: "Mine" });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual(ACTION_WORDS.notAdmin.body);
    expect(w.posts()).toHaveLength(0);
  });
  it("refuses a person Code names no company for, without asking Code to change anything", async () => {
    const w = world();
    const answer = await w.post(NEW, "nobody-token", { name: "Mine" });
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe("NO_COMPANY");
    expect(w.posts()).toHaveLength(0);
  });
  it("refuses a body that is not exactly a name, in fixed words that echo nothing, and never reaches Code", async () => {
    const w = world();
    const bad: unknown[] = [{}, { name: "" }, { name: "   " }, { name: "\t" }, { name: "x".repeat(81) }, { name: "a\nb" }, { name: "a‮b" }, { name: 5 }, { name: "ok", companyId: ACME }, { name: "ok", trackerLink: { tracker: "linear", id: "x", url: "https://x.example" } }, { name: "ok", __proto__x: 1 }, [], "null", ""];
    for (const body of bad) {
      const answer = await w.post(NEW, "ada-token", body);
      expect([answer.status, answer.body]).toEqual([400, ACTION_WORDS.badBody.body]);
    }
    // Text that is not JSON is the handler's own 400 before any route runs.
    expect((await w.post(NEW, "ada-token", "not json {")).status).toBe(400);
    expect(w.posts()).toHaveLength(0);
  });
  it("accepts a name of exactly 80 characters, counting characters and not bytes", async () => {
    const w = world();
    expect((await w.post(NEW, "ada-token", { name: "é".repeat(80) })).status).toBe(200);
    expect((await w.post(NEW, "ada-token", { name: "é".repeat(81) })).status).toBe(400);
  });
});

describe("Rename, Merge into and Mark done", () => {
  it("passes each to Code's own route as the person with a body of exactly the named member", async () => {
    const w = world();
    expect((await w.post(ACTION(F1, "rename"), "ada-token", { name: "Checkout v3" })).body).toEqual({ feature: { id: F1, name: "Checkout v3", state: "open" } });
    expect((await w.post(ACTION(F1, "state"), "ada-token", { state: "done" })).body).toEqual({ feature: { id: F1, name: "Checkout v3", state: "done" } });
    expect((await w.post(ACTION(F2, "merge"), "ada-token", { into: F1 })).body).toEqual({ feature: { id: F1, name: "Checkout v3", state: "done" } });
    expect(w.posts()).toEqual([
      { method: "POST", path: CODE_ACTION(F1, "rename"), authorization: "Bearer ada-token", body: JSON.stringify({ name: "Checkout v3" }) },
      { method: "POST", path: CODE_ACTION(F1, "state"), authorization: "Bearer ada-token", body: JSON.stringify({ state: "done" }) },
      { method: "POST", path: CODE_ACTION(F2, "merge"), authorization: "Bearer ada-token", body: JSON.stringify({ into: F1 }) },
    ]);
    expect(w.companies[ACME]!.features.has(F2)).toBe(false);
  });
  it("refuses a member without asking Code, and a wrong shape without asking Code", async () => {
    const w = world();
    for (const [what, body] of [["rename", { name: "x" }], ["merge", { into: F2 }], ["state", { state: "done" }]] as const) {
      expect((await w.post(ACTION(F1, what), "grace-token", body)).body).toEqual(ACTION_WORDS.notAdmin.body);
    }
    const bad: Array<[string, unknown]> = [
      ["rename", {}], ["rename", { name: "" }], ["rename", { name: "x".repeat(81) }], ["rename", { name: "a\u0007b" }], ["rename", { name: "ok", state: "done" }],
      ["state", { state: "merged" }], ["state", { state: "" }], ["state", {}], ["state", { state: "done", name: "x" }],
      ["merge", { into: "none" }], ["merge", { into: "ft_short" }], ["merge", { into: null }], ["merge", {}], ["merge", { into: F2, company: ACME }],
    ];
    for (const [what, body] of bad) expect([what, (await w.post(ACTION(F1, what), "ada-token", body)).status]).toEqual([what, 400]);
    expect(w.posts()).toHaveLength(0);
  });
  it("has no route for a feature id that is not one of Code's, or for `none`", async () => {
    const w = world();
    for (const id of ["none", "ft_short", "x", "ft_" + "G".repeat(20)]) expect((await w.post(ACTION(id, "rename"), "ada-token", { name: "x" })).body).toEqual(REPORT_WORDS.notFound.body);
    // A path that is not even an id's characters has no route at all (the handler's own "not connected" answer).
    expect((await w.post(ACTION("..%2F..%2Fx", "rename"), "ada-token", { name: "x" })).status).toBe(501);
    expect(w.posts()).toHaveLength(0);
  });
  it("passes Code's fixed refusals on as Cloud's own fixed words, each in its own sentence", async () => {
    const table: Array<[string, { status: number; body: unknown }]> = [
      [CODE_WORDS.taken, ACTION_WORDS.nameTaken], [CODE_WORDS.limit, ACTION_WORDS.limit], [CODE_WORDS.isDone, ACTION_WORDS.isDone],
      [CODE_WORDS.cannotMerge, ACTION_WORDS.cannotMerge], [CODE_WORDS.conflict, ACTION_WORDS.conflict],
    ];
    for (const [codeSentence, words] of table) {
      const w = world({ respond: () => json(400, { error: { code: "CONFIG_INVALID", message: codeSentence } }) });
      const answer = await w.post(ACTION(F1, "rename"), "ada-token", { name: "Again" });
      expect([answer.status, answer.body]).toEqual([words.status, words.body]);
    }
  });
  it("words Code's other refusals in fixed words and never echoes what Code said", async () => {
    const leaky = "leaky detail about org_globex and a stack at /srv/code.js";
    const cases: Array<[Response, number, unknown]> = [
      [json(400, { error: { code: "CONFIG_INVALID", message: leaky } }), ACTION_WORDS.refused.status, ACTION_WORDS.refused.body],
      [json(403, { error: { code: "FORBIDDEN", message: leaky } }), 403, ACTION_WORDS.notAdmin.body],
      [json(404, { error: { code: "NOT_FOUND", message: CODE_WORDS.notFound } }), 404, REPORT_WORDS.notFound.body],
      [json(404, { error: { code: "NOT_FOUND", message: "route not found" } }), 501, ACTION_WORDS.notConnected.body],
      [json(501, { error: { code: "NOT_ON_CODE_YET", message: leaky } }), 501, ACTION_WORDS.notConnected.body],
      [json(500, { error: { code: "X", message: leaky } }), 503, ACTION_WORDS.unavailable.body],
      [json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: leaky } }), 503, ACTION_WORDS.unavailable.body],
      [json(429, { error: { code: "X", message: leaky } }), 503, ACTION_WORDS.unavailable.body],
    ];
    for (const [response, status, body] of cases) {
      const w = world({ respond: () => response.clone() });
      const answer = await w.post(ACTION(F1, "rename"), "ada-token", { name: "Again" });
      expect([answer.status, answer.body]).toEqual([status, body]);
      expect(answer.text).not.toMatch(/leaky|globex|srv/u);
    }
  });
  it("refuses a Code answer that is not a feature, and says nothing of it", async () => {
    for (const bad of [{ feature: { id: "nope", name: "x", state: "open" } }, { feature: { id: F1, name: "", state: "open" } }, { feature: "x" }, {}, "text"]) {
      const w = world({ respond: () => json(200, bad) });
      const answer = await w.post(ACTION(F1, "rename"), "ada-token", { name: "Again" });
      expect([answer.status, answer.body]).toEqual([ACTION_WORDS.unreadable.status, ACTION_WORDS.unreadable.body]);
    }
  });
  it("sends a person whose Code sign-in has ended to sign in again", async () => {
    const w = world({ respond: () => json(401, {}) });
    const answer = await w.post(ACTION(F1, "rename"), "ada-token", { name: "Again" });
    expect([answer.status, answer.body.error.code]).toEqual([401, "AUTH_REQUIRED"]);
  });
});

describe("Move to feature", () => {
  it("passes the move to Code's task route as the person, and sends back only the task and its feature", async () => {
    const w = world();
    const answer = await w.post(MOVE(uuidOf(3)), "ada-token", { feature: F2 });
    expect(answer.body).toEqual({ task: { taskId: uuidOf(3), feature: { id: F2, source: "moved" } } });
    expect((await w.post(MOVE(uuidOf(3)), "ada-token", { feature: null })).body).toEqual({ task: { taskId: uuidOf(3), feature: null } });
    expect(w.posts().map((call) => [call.path, call.body, call.authorization])).toEqual([
      [`/v1/app/tasks/${uuidOf(3)}/feature`, JSON.stringify({ feature: F2 }), "Bearer ada-token"],
      [`/v1/app/tasks/${uuidOf(3)}/feature`, JSON.stringify({ feature: null }), "Bearer ada-token"],
    ]);
  });
  it("leaves who may to Code: the starter files a task once, and moving it again is a maintainer's", async () => {
    const w = world();
    const first = await w.post(MOVE(uuidOf(2)), "grace-token", { feature: F1 });
    expect([first.status, first.body.task.feature.source]).toEqual([200, "chosen"]);
    const again = await w.post(MOVE(uuidOf(2)), "grace-token", { feature: F2 });
    expect([again.status, again.body]).toEqual([ACTION_WORDS.needsMaintainer.status, ACTION_WORDS.needsMaintainer.body]);
    // Not hers, so Code says it does not exist.
    const notHers = await w.post(MOVE(uuidOf(3)), "grace-token", { feature: F1 });
    expect([notHers.status, notHers.body]).toEqual([ACTION_WORDS.taskGone.status, ACTION_WORDS.taskGone.body]);
  });
  it("words a move into a done feature, and a feature that is gone, in fixed words", async () => {
    const w = world();
    expect((await w.post(MOVE(uuidOf(3)), "ada-token", { feature: FDONE })).body).toEqual(ACTION_WORDS.isDone.body);
    expect((await w.post(MOVE(uuidOf(3)), "ada-token", { feature: FT("9") })).body).toEqual(REPORT_WORDS.notFound.body);
  });
  it("refuses a body that is not exactly one feature id or null, and a path that is not a task id, without asking Code", async () => {
    const w = world();
    const bad: unknown[] = [{}, { feature: "none" }, { feature: "ft_short" }, { feature: 5 }, { feature: F1, project: "web" }, { feature: F1, taskId: uuidOf(1) }, "x", []];
    for (const body of bad) expect([(await w.post(MOVE(uuidOf(3)), "ada-token", body)).status]).toEqual([400]);
    for (const id of ["not-a-uuid", "..", `${uuidOf(3)}x`]) expect((await w.post(MOVE(id), "ada-token", { feature: F1 })).status).toBe(501);
    expect(w.posts()).toHaveLength(0);
  });
  it("refuses a person with no company and a sign-in that is missing", async () => {
    const w = world();
    expect((await w.post(MOVE(uuidOf(3)), "nobody-token", { feature: F1 })).body.error.code).toBe("NO_COMPANY");
    expect((await w.post(MOVE(uuidOf(3)), undefined, { feature: F1 })).status).toBe(401);
    expect(w.posts()).toHaveLength(0);
  });
});

describe("when Code's own access check fails", () => {
  const routes: Array<[string, unknown]> = [[NEW, { name: "Mine" }], [ACTION(F1, "rename"), { name: "x" }], [ACTION(F1, "merge"), { into: F2 }], [ACTION(F1, "state"), { state: "done" }], [MOVE(uuidOf(3)), { feature: F1 }]];
  const leaky = "leaky access detail about org_globex at /srv/code.js";
  it("words it in fixed sentences on every route, never what Code said, and changes nothing", async () => {
    for (const [status, words] of [[403, ACTION_WORDS.notAdmin], [500, ACTION_WORDS.unavailable], [503, ACTION_WORDS.unavailable], [404, ACTION_WORDS.notConnected]] as const) {
      const w = world({ access: () => json(status, { error: { code: "X", message: leaky } }) });
      for (const [path, body] of routes) {
        const answer = await w.post(path, "ada-token", body);
        expect([path, answer.status, answer.body]).toEqual([path, words.status, words.body]);
        expect(answer.text).not.toMatch(/leaky|globex|srv/u);
      }
      expect(w.posts()).toHaveLength(0);
    }
  });
});

describe("answers Code gives that Cloud cannot trust", () => {
  it("refuses a move answer that names another task or an unreadable feature, and says nothing of it", async () => {
    for (const bad of [{ task: { taskId: uuidOf(4), feature: null } }, { task: { taskId: uuidOf(3), feature: { id: "nope", source: "moved" } } }, { task: { taskId: uuidOf(3), feature: { id: F1, source: "magic" } } }, { task: { taskId: uuidOf(3) } }, {}]) {
      const w = world({ respond: () => json(200, bad) });
      const answer = await w.post(MOVE(uuidOf(3)), "ada-token", { feature: F1 });
      expect([answer.status, answer.body]).toEqual([ACTION_WORDS.unreadable.status, ACTION_WORDS.unreadable.body]);
    }
  });
  it("words Code's 409 as one fixed sentence", async () => {
    const w = world({ respond: () => json(409, { error: { code: "CONFIG_INVALID", message: CODE_WORDS.conflict } }) });
    const answer = await w.post(ACTION(F1, "rename"), "ada-token", { name: "Again" });
    expect([answer.status, answer.body]).toEqual([ACTION_WORDS.conflict.status, ACTION_WORDS.conflict.body]);
  });
});

describe("two companies", () => {
  it("another company's feature is the same fixed 404 as a missing one, on every feature action, and changes nothing there", async () => {
    const w = world();
    for (const [what, body] of [["rename", { name: "Hijacked" }], ["state", { state: "done" }], ["merge", { into: FG }]] as const) {
      const other = await w.post(ACTION(F1, what), "bob-token", body);
      expect([other.status, other.body]).toEqual([404, REPORT_WORDS.notFound.body]);
    }
    const missing = await w.post(ACTION(FT("9"), "rename"), "bob-token", { name: "Hijacked" });
    expect(missing.body).toEqual(REPORT_WORDS.notFound.body);
    expect(w.companies[ACME]!.features.get(F1)).toEqual({ name: "Checkout v2", state: "open" });
    expect(w.companies[GLOBEX]!.features.get(FG)).toEqual({ name: "Globex plan", state: "open" });
    // Each call asked Code as Bob, whose token names his own company.
    expect(w.posts().every((call) => call.authorization === "Bearer bob-token")).toBe(true);
  });
  it("cannot merge into, or move a task to, a feature of another company, or move another company's task", async () => {
    const w = world();
    expect((await w.post(ACTION(FG, "merge"), "bob-token", { into: F1 })).body).toEqual(REPORT_WORDS.notFound.body);
    expect((await w.post(MOVE(uuidOf(9)), "bob-token", { feature: F1 })).body).toEqual(REPORT_WORDS.notFound.body);
    const taskOfAcme = await w.post(MOVE(uuidOf(3)), "bob-token", { feature: FG });
    expect([taskOfAcme.status, taskOfAcme.body]).toEqual([ACTION_WORDS.taskGone.status, ACTION_WORDS.taskGone.body]);
    expect(w.companies[ACME]!.tasks.get(uuidOf(3))!.feature).toBeUndefined();
    expect(w.companies[GLOBEX]!.tasks.get(uuidOf(9))!.feature).toBeUndefined();
  });
  it("takes the company from Code's access answer only: a company in the body, query, header or cookie is refused or ignored and never forwarded", async () => {
    const w = world();
    expect((await w.post(ACTION(F1, "rename"), "bob-token", { name: "Hijacked", companyId: ACME })).status).toBe(400);
    const viaHeader = await w.post(`${ACTION(FG, "rename")}?company=${ACME}&orgId=${ACME}`, "bob-token", { name: "Globex plan 2" }, { "x-rovara-company": ACME, "x-company-id": ACME });
    expect(viaHeader.status).toBe(200);
    for (const call of w.posts()) {
      expect(call.path).not.toContain("?");
      expect(`${call.path} ${call.body ?? ""}`).not.toContain(ACME);
    }
    expect(w.companies[ACME]!.features.get(F1)!.name).toBe("Checkout v2");
  });
  it("shows each company only its own features in the report's pickers", async () => {
    const w = world();
    const acme = await w.get("/v1/web/org/report", "ada-token"), globex = await w.get("/v1/web/org/report", "bob-token");
    expect(acme.body.features.map((f: any) => f.id).sort()).toEqual([F1, F2, FDONE].sort());
    expect(acme.text).not.toMatch(/Globex/u);
    expect(globex.body.features).toEqual([{ id: FG, name: "Globex plan", state: "open" }]);
    expect(globex.text).not.toMatch(/Checkout|Search/u);
  });
});

describe("what the report answers say the person may do", () => {
  it("says canChange for a company admin or owner, with the company's features (names and states, no dates or people) for the pickers", async () => {
    const w = world();
    for (const token of ["ada-token", "owner-token"]) {
      const report = await w.get("/v1/web/org/report", token);
      expect(report.body.canChange).toBe(true);
      expect(report.body.features).toEqual([{ id: F1, name: "Checkout v2", state: "open" }, { id: FDONE, name: "Old work", state: "done" }, { id: F2, name: "Search", state: "open" }].sort((a, b) => a.name.localeCompare(b.name)));
      const detail = await w.get(`/v1/web/org/report/features/${F1}`, token);
      expect(detail.body.canChange).toBe(true);
      expect(detail.body.features).toHaveLength(3);
    }
    const none = await w.get("/v1/web/org/report/features/none", "ada-token");
    expect(none.body.canChange).toBe(true);
  });
  it("gives an empty picker list when Code lists no features, and still says canChange", async () => {
    const w = world();
    w.companies[ACME]!.features.clear();
    const report = await w.get("/v1/web/org/report", "ada-token");
    expect(report.body.canChange).toBe(true);
    expect(report.body.features).toEqual([]);
  });
});

describe("task links", () => {
  const started = async (w: ReturnType<typeof world>, token: string, taskId: string, sessionId: string, companyId: string) => {
    await w.sessions.put({ sessionId, taskId, project: "web", startedBy: { developerId: WHO[token]!.id, name: "x" }, owner: { developerId: WHO[token]!.id, name: "x" }, createdAt: iso(NOW), companyId, revision: 1 });
  };
  it("gives the session's address only for a task the signed-in person started in Cloud, in their own company", async () => {
    const w = world();
    await started(w, "ada-token", uuidOf(1), "ses_aaaaaaaaaaaaaaaaaaaa", ACME);
    // Another person's session for another task of the same company, and a session of the same person for a task that is not in the page.
    await started(w, "grace-token", uuidOf(2), "ses_bbbbbbbbbbbbbbbbbbbb", ACME);
    w.companies[ACME]!.tasks.set(uuidOf(5), { starter: ADA, feature: F1, project: "web", title: "Fifth" });
    const detail = await w.get(`/v1/web/org/report/features/${F1}`, "ada-token");
    const byId = Object.fromEntries(detail.body.tasks.map((t: any) => [t.taskId, t.sessionId]));
    expect(byId).toEqual({ [uuidOf(1)]: "ses_aaaaaaaaaaaaaaaaaaaa", [uuidOf(5)]: undefined });
    expect(detail.text).not.toContain("ses_bbbbbbbbbbbbbbbbbbbb");
  });
  it("never gives an address from another company's session, even for the same task id and person", async () => {
    const w = world();
    await started(w, "ada-token", uuidOf(1), "ses_cccccccccccccccccccc", GLOBEX);
    const detail = await w.get(`/v1/web/org/report/features/${F1}`, "ada-token");
    expect(detail.body.tasks[0].sessionId).toBeUndefined();
    expect(detail.text).not.toContain("ses_cccccccccccccccccccc");
  });
  it("still answers the page when the session store fails", async () => {
    const w = world();
    w.sessions.startedBy = () => Promise.reject(new Error("store down"));
    const detail = await w.get(`/v1/web/org/report/features/${F1}`, "ada-token");
    expect(detail.status).toBe(200);
    expect(detail.body.tasks[0].sessionId).toBeUndefined();
  });
});

describe("the contract table", () => {
  it("has a row, answered by cloud-server, for each of the five actions", () => {
    const wanted = [
      "POST /v1/app/org/report/features", "POST /v1/app/org/report/features/{featureId}/rename", "POST /v1/app/org/report/features/{featureId}/merge",
      "POST /v1/app/org/report/features/{featureId}/state", "POST /v1/app/tasks/{taskId}/feature",
    ];
    for (const key of wanted) {
      const row = APP_ROUTES.find((route) => `${route.method} ${route.path}` === key);
      expect(row, key).toMatchObject({ owner: "cloud", cloudServerToday: true, codeCoreLocal: false });
    }
  });
});
