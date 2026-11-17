// The repository picker and the several-repository create on Cloud (packages/cloud-server/src/project-create-routes.ts; guided onboarding PR 10; DEC 254l item 1):
// end to end on the fake Code with two companies (A's picker never returns B's data, B's repositories can't be put in A's project), plus a stubbed Code for
// every refusal and for answers that don't read. The browser never names a company: the picker forwards only q, limit and after, and the create forwards only
// the repositories and a name.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { CODE_NOT_AVAILABLE, CODE_UNREACHABLE, PICKER_WORDS, REMEMBERED_CREATES_MAX, readCreateProjectsBody, readPickerQuery } from "../../packages/cloud-server/src/project-create-routes.js";
import { SETUP_RUNS_AT_ONCE_PER_COMPANY, setupRunsToStart } from "../../packages/contracts/src/onboarding.js";
import { OTHER_COMPANY_ID, PRIYA, SAM, ZED, startFakeCode, type FakeCode, type Person } from "../support/fake-code.js";

interface Answer<T = Record<string, unknown>> { status: number; body: T }
interface Choice { installationId: number; accountLogin: string; fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; projects: string[] }
interface Page { repositories: Choice[]; next?: string; incomplete: boolean }
const ID = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const REFUSED = (text: string) => ({ error: { code: expect.any(String) as string, message: text } });

let fake: FakeCode;
let codeCalls: Array<{ method: string; path: string; search: string; body: unknown; authorization: string | undefined }>;
let as: (who: Person) => Promise<{ get: <T>(target: string) => Promise<Answer<T>>; send: <T>(method: string, target: string, body?: unknown) => Promise<Answer<T>> }>;

beforeAll(async () => {
  fake = await startFakeCode();
  codeCalls = [];
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    codeCalls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    return fetch(input, init);
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create", fetch: recording });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const raw = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = await handler(request);
    return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
  };
  as = async (who) => {
    fake.setPerson(who);
    const start = await raw("GET", "/v1/auth/browser/authorize?return_to=/app", {});
    const back = new URL((await fetch(start.headers["location"]!, { redirect: "manual" })).headers.get("location")!);
    const cookie = (await raw("GET", `${back.pathname}${back.search}`, {})).headers["set-cookie"]!.split(";")[0]!;
    const csrf = ((await raw("GET", "/v1/web/me", { cookie })).body as { csrf: string }).csrf;
    return {
      get: async <T>(target: string) => { const answer = await raw("GET", `/v1/web${target}`, { cookie }); return { status: answer.status, body: answer.body as T }; },
      send: async <T>(method: string, target: string, body?: unknown) => { const answer = await raw(method, `/v1/web${target}`, { cookie, "x-rovara-csrf": csrf, "content-type": "application/json" }, body); return { status: answer.status, body: answer.body as T }; },
    };
  };
});
afterAll(async () => { await fake.close(); });
const toCode = (path: string) => codeCalls.filter((call) => call.path === path);

describe("the picker", () => {
  it("lists the company's repositories in order, each with the company's projects that hold it, a page at a time", async () => {
    const priya = await as(PRIYA);
    const first = await priya.get<Page>("/github/repository-choices?limit=5");
    expect(first.status).toBe(200);
    expect(first.body.repositories.map((row) => row.fullName)).toEqual(["example/api", "example/auth", "example/billing", "example/design", "example/docs"]);
    expect(first.body.repositories[0]).toEqual({ installationId: 1001, accountLogin: "example", fullName: "example/api", githubRepositoryId: 100, private: true, defaultBranch: "main", projects: ["api"] });
    expect(first.body.next).toBe("example/docs");
    expect(first.body.incomplete).toBe(false);
    const second = await priya.get<Page>(`/github/repository-choices?limit=5&after=${encodeURIComponent(first.body.next!)}`);
    expect(second.body.repositories.map((row) => row.fullName)).toEqual(["example/infra", "example/mobile", "example/notifier", "example/payments", "example/reports"]);
    const last = await priya.get<Page>(`/github/repository-choices?limit=5&after=${encodeURIComponent(second.body.next!)}`);
    expect(last.body.repositories.map((row) => row.fullName)).toEqual(["example/search", "example/web"]);
    expect(last.body.repositories[1]!.projects).toEqual(["web"]);
    expect(last.body.next).toBeUndefined();
    const found = await priya.get<Page>("/github/repository-choices?q=PAY");
    expect(found.body.repositories.map((row) => row.fullName)).toEqual(["example/payments"]);
  });

  it("two companies: A's picker never returns B's repositories, accounts or project names, and B's never returns A's", async () => {
    const priya = await as(PRIYA);
    const zed = await as(ZED);
    const a = (await priya.get<Page>("/github/repository-choices?limit=100")).body;
    const b = (await zed.get<Page>("/github/repository-choices?limit=100")).body;
    // Positive controls: each side really got its own rows.
    expect(a.repositories.length).toBe(12);
    expect(b.repositories.map((row) => row.fullName)).toEqual(["other-co/secret-ledger", "other-co/web"]);
    expect(b.repositories[0]!.projects).toEqual(["secret-ledger"]);
    expect(JSON.stringify(a)).not.toMatch(/other-co|secret-ledger|2002/u);
    expect(JSON.stringify(b)).not.toMatch(/example|"web"|1001/u);
    // B's own `web` repository isn't marked with A's project of that name.
    expect(b.repositories[1]!.projects).toEqual([]);
  });

  it("forwards only q, limit and after, as the person (their own token); a company, installation or any other key refuses the call before Code is asked", async () => {
    const priya = await as(PRIYA);
    const before = toCode("/v1/dev/client/repositories/available").length;
    await priya.get("/github/repository-choices?q=web&limit=7&after=example%2Fapi");
    const sent = toCode("/v1/dev/client/repositories/available").at(-1)!;
    expect(new URLSearchParams(sent.search).toString()).toBe("q=web&limit=7&after=example%2Fapi");
    expect(sent.authorization).toMatch(/^Bearer fake-access-/u);
    const refused = toCode("/v1/dev/client/repositories/available").length;
    for (const bad of [`company=${OTHER_COMPANY_ID}`, "companyId=org_bbbbbbbbbbbbbbbbbbbb", "installation=2002", "q=web&company=x", "q=a&q=b", "limit=0", "limit=101", "limit=abc", "q=a%20b", "after=nope", "after=a%2Fb%2Fc"]) {
      const answer = await priya.get<unknown>(`/github/repository-choices?${bad}`);
      expect(answer, bad).toEqual({ status: 400, body: REFUSED("That search isn't valid.") });
    }
    expect(toCode("/v1/dev/client/repositories/available").length).toBe(refused);
    expect(refused).toBe(before + 1);
  });

  it("a person who is not a company owner or admin reads Code's 403 as one fixed sentence", async () => {
    const sam = await as(SAM);
    expect(await sam.get("/github/repository-choices")).toEqual({ status: 403, body: REFUSED("Only company owners and admins can create projects.") });
  });

  it("reads query and body strictly", () => {
    expect(readPickerQuery(new URLSearchParams("q=&limit=50"))?.toString()).toBe("limit=50");
    expect(readPickerQuery(new URLSearchParams("limit=1e2"))).toBeUndefined();
    const body = { requestId: ID(1), repositories: ["a/b", "c/d"] };
    expect(readCreateProjectsBody(body)).toEqual({ requestId: ID(1), repositories: ["a/b", "c/d"], separate: false });
    for (const bad of [
      { ...body, company: "x" }, { ...body, repository: "a/b" }, { ...body, installationId: 1 }, { ...body, requestId: "nope" }, { ...body, repositories: [] }, { ...body, repositories: ["A/B", "a/b.git"] },
      { ...body, repositories: Array.from({ length: 33 }, (_, index) => `o/r${String(index)}`) }, { ...body, repositories: ["a/.git"] }, { ...body, repositories: ["a"] }, { ...body, separate: true, name: "x" },
      { ...body, name: "Bad Name" }, { ...body, separate: "yes" }, [], null, "text",
    ]) expect(readCreateProjectsBody(bad), JSON.stringify(bad)).toBeUndefined();
    expect(readCreateProjectsBody({ ...body, name: "shop" })?.name).toBe("shop");
    expect(readCreateProjectsBody({ ...body, repositories: Array.from({ length: 32 }, (_, index) => `o/r${String(index)}`) })?.repositories).toHaveLength(32);
  });
});

describe("creating projects", () => {
  it("one project from several repositories: Code gets only the repositories and the name; a retried request answers the same project and writes nothing", async () => {
    const priya = await as(PRIYA);
    const asked = { requestId: ID(10), repositories: ["example/billing", "example/mobile"], name: "shop" };
    const first = await priya.send<{ duplicate: boolean; project: { definition: { name: string } } }>("POST", "/projects", asked);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ duplicate: false, project: { definition: { name: "shop" } } });
    const sent = toCode("/v1/dev/client/projects").filter((call) => call.method === "POST").at(-1)!;
    expect(sent.body).toEqual({ repositories: ["example/billing", "example/mobile"], name: "shop" });
    const creates = toCode("/v1/dev/client/projects").filter((call) => call.method === "POST").length;
    const again = await priya.send<{ duplicate: boolean; project: { definition: { name: string } } }>("POST", "/projects", asked);
    expect(again.body).toMatchObject({ duplicate: true, project: { definition: { name: "shop" } } });
    expect(toCode("/v1/dev/client/projects").filter((call) => call.method === "POST")).toHaveLength(creates);
    // The same id with another body is refused, and nothing is sent.
    expect(await priya.send("POST", "/projects", { ...asked, repositories: ["example/billing"] })).toEqual({ status: 400, body: REFUSED("This request was already used for something else. Reload and try again.") });
    expect(toCode("/v1/dev/client/projects").filter((call) => call.method === "POST")).toHaveLength(creates);
    // The new project holds both repositories, and the picker marks them.
    const marks = (await priya.get<Page>("/github/repository-choices?q=billing")).body.repositories[0]!.projects;
    expect(marks).toEqual(["shop"]);
  });

  it("a project name that is taken is refused in Code's own sentence, and the name is the only thing it echoes", async () => {
    const priya = await as(PRIYA);
    const answer = await priya.send<{ error: { message: string } }>("POST", "/projects", { requestId: ID(11), repositories: ["example/docs"], name: "web" });
    expect(answer).toEqual({ status: 400, body: REFUSED("a project named web already exists; choose another name") });
  });

  it("separate projects: one bulk call with only the repositories; each row says created or why not; a retry answers the stored rows", async () => {
    const priya = await as(PRIYA);
    const asked = { requestId: ID(12), repositories: ["example/search", "example/web", "other-co/web", "example/infra"], separate: true };
    const first = await priya.send<{ duplicate: boolean; results: Array<Record<string, string>> }>("POST", "/projects", asked);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.results).toEqual([
      { repository: "example/search", outcome: "created", project: "search" },
      { repository: "example/web", outcome: "refused", reason: "name_taken" },
      { repository: "other-co/web", outcome: "refused", reason: "not_available" },
      { repository: "example/infra", outcome: "created", project: "infra" },
    ]);
    const bulk = toCode("/v1/dev/client/projects/bulk");
    expect(bulk.at(-1)!.body).toEqual({ repositories: asked.repositories });
    const again = await priya.send<{ duplicate: boolean; results: unknown[] }>("POST", "/projects", asked);
    expect(again.body).toEqual({ duplicate: true, results: first.body.results });
    expect(toCode("/v1/dev/client/projects/bulk")).toHaveLength(bulk.length);
  });

  it("two companies: B's repositories can't go in A's project, and A's can't go in B's, in either form; nothing is created", async () => {
    const priya = await as(PRIYA);
    const zed = await as(ZED);
    const before = (await priya.get<Page>("/github/repository-choices?limit=100")).body.repositories.map((row) => row.projects.join());
    const one = await priya.send("POST", "/projects", { requestId: ID(13), repositories: ["example/reports", "other-co/secret-ledger"] });
    expect(one).toEqual({ status: 400, body: REFUSED(CODE_NOT_AVAILABLE) });
    const mine = await zed.send("POST", "/projects", { requestId: ID(14), repositories: ["other-co/web", "example/reports"] });
    expect(mine).toEqual({ status: 400, body: REFUSED(CODE_NOT_AVAILABLE) });
    const bulk = await zed.send<{ results: Array<Record<string, string>> }>("POST", "/projects", { requestId: ID(15), repositories: ["example/reports", "other-co/secret-ledger"], separate: true });
    expect(bulk.body.results).toEqual([{ repository: "example/reports", outcome: "refused", reason: "not_available" }, { repository: "other-co/secret-ledger", outcome: "refused", reason: "name_taken" }]);
    expect((await priya.get<Page>("/github/repository-choices?limit=100")).body.repositories.map((row) => row.projects.join())).toEqual(before);
    expect(JSON.stringify((await priya.get<Page>("/github/repository-choices?limit=100")).body)).not.toContain("other-co");
  });

  it("a body that names a company, an installation or anything else is refused before Code is asked", async () => {
    const priya = await as(PRIYA);
    const calls = codeCalls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/dev/client/projects")).length;
    for (const extra of [{ company: OTHER_COMPANY_ID }, { companyId: OTHER_COMPANY_ID }, { installationId: 2002 }, { repository: "example/web" }, { setupCommands: ["x"] }]) {
      const answer = await priya.send("POST", "/projects", { requestId: ID(16), repositories: ["example/reports"], ...extra });
      expect(answer.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await priya.send("POST", "/projects", { requestId: ID(16), repositories: ["example/reports", "EXAMPLE/reports.git"] })).status).toBe(400);
    expect((await priya.send("POST", "/projects", { requestId: ID(16), repositories: ["example/reports"], separate: true, name: "x" })).status).toBe(400);
    expect(codeCalls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/dev/client/projects")).length).toBe(calls);
  });

  it("a person who is not a company owner or admin reads Code's 403 as one fixed sentence, in both forms", async () => {
    const sam = await as(SAM);
    const words = { status: 403, body: REFUSED("Only company owners and admins can create projects.") };
    expect(await sam.send("POST", "/projects", { requestId: ID(17), repositories: ["example/reports"] })).toEqual(words);
    expect(await sam.send("POST", "/projects", { requestId: ID(18), repositories: ["example/reports", "example/auth"], separate: true })).toEqual(words);
  });

  it("the one-repository body is still the old create, unchanged", async () => {
    const priya = await as(PRIYA);
    const answer = await priya.send<{ duplicate: boolean; project: { definition: { name: string } } }>("POST", "/projects", { requestId: ID(19), repository: "example/notifier", setupCommand: "npm ci" });
    expect(answer.status).toBe(201);
    expect(toCode("/v1/dev/client/projects").filter((call) => call.method === "POST").at(-1)!.body).toEqual({ repository: "example/notifier", setupCommands: ["npm ci"] });
  });
});

describe("answers Cloud does not trust", () => {
  const A = "org_aaaaaaaaaaaaaaaaaaaa";
  const PERSON = "a".repeat(64);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function stub(answer: (path: string) => Response) {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.pathname);
      if (url.pathname === "/v1/dev/access") return json(200, { developerId: PERSON, displayName: "Ada", administrator: false, companyId: A, companyRole: "admin", projects: [], notices: [] });
      return answer(url.pathname);
    }) as typeof fetch;
    const store = new LocalSessionStore(undefined, { environment: {} });
    const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "", fetch: fetchImpl });
    const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
    const id = "cookie-stub";
    let signedIn = false;
    return {
      calls, store, id,
      send: async (method: string, target: string, body?: unknown) => {
        if (!signedIn) await store.create(id, { accessToken: "t", refreshToken: "r", csrf: "csrf", signedInAt: "2026-11-17T00:00:00.000Z", access: { developerId: PERSON, displayName: "Ada", administrator: false, companyId: A, companyRole: "admin", projects: [], notices: [] } });
        signedIn = true;
        const url = new URL(`/v1/web${target}`, "http://127.0.0.1:8787");
        const answer = (await handler({ method, path: url.pathname, query: url.searchParams, headers: { cookie: `rovara_cloud_session=${id}`, "x-rovara-csrf": "csrf" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))!;
        return { status: answer.status, body: JSON.parse(answer.body) as unknown };
      },
    };
  }
  const create = { requestId: ID(30), repositories: ["a/one", "a/two"] };

  it("Code's other words never reach the person: a 400 or 500 with anything else in it, or a stack, is one fixed sentence", async () => {
    const leak = "Error at s3://secret-bucket/key arn:aws:iam::123456789012:role/x";
    for (const [status, expected] of [[400, PICKER_WORDS.refused], [409, PICKER_WORDS.refused], [500, PICKER_WORDS.unavailable], [502, PICKER_WORDS.unavailable]] as const) {
      const w = stub(() => json(status, { error: { code: "X", message: leak } }));
      const answer = await w.send("POST", "/projects", create);
      expect(answer, String(status)).toEqual({ status: expected.status, body: expected.body });
      expect(JSON.stringify(answer)).not.toContain("secret-bucket");
    }
    const w = stub(() => json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: CODE_UNREACHABLE } }));
    expect(await w.send("POST", "/projects", create)).toEqual({ status: 503, body: REFUSED(CODE_UNREACHABLE) });
    // A "name taken" sentence is passed on only in exactly Code's shape.
    const odd = stub(() => json(400, { error: { code: "CONFIG_INVALID", message: "a project named Bad Name! already exists; choose another name" } }));
    expect((await odd.send("POST", "/projects", create)).body).toEqual(PICKER_WORDS.refused.body);
  });

  it("a bulk answer with a missing, repeated, reordered or unknown row is refused whole", async () => {
    const asked = { requestId: ID(31), repositories: ["a/one", "a/two"], separate: true };
    const rows = (...entries: unknown[]) => stub((path) => (path === "/v1/dev/client/projects/bulk" ? json(200, { results: entries }) : json(404, {})));
    const one = { repository: "a/one", outcome: "created", project: "one" }, two = { repository: "a/two", outcome: "refused", reason: "not_available" };
    expect((await rows(one, two).send("POST", "/projects", asked)).status).toBe(200);
    for (const bad of [[one], [two, one], [one, one], [one, { ...two, reason: "because" }], [one, { repository: "a/two", outcome: "created", project: "../x" }], [one, { repository: "a/two", outcome: "weird" }], [one, { repository: "b/three", outcome: "created", project: "three" }]]) {
      const answer = await rows(...bad).send("POST", "/projects", asked);
      expect(answer, JSON.stringify(bad)).toEqual({ status: 503, body: PICKER_WORDS.unavailable.body });
    }
  });

  it("a picker page with any row that doesn't read is refused whole, and only the known fields reach the browser", async () => {
    const row = { installationId: 7, accountLogin: "acme", fullName: "acme/web", githubRepositoryId: 9, private: false, defaultBranch: "main", projects: ["web"] };
    const page = (repositories: unknown[], extra: Record<string, unknown> = {}) => stub(() => json(200, { repositories, incomplete: false, ...extra }));
    const good = await page([{ ...row, token: "ghs_secret" }], { debug: "x" }).send("GET", "/github/repository-choices");
    expect(good).toEqual({ status: 200, body: { repositories: [row], incomplete: false } });
    for (const bad of [{ ...row, fullName: "not a repo" }, { ...row, installationId: 0 }, { ...row, projects: ["Bad Name"] }, { ...row, accountLogin: "a‮b" }, { ...row, private: "no" }, "text", null]) {
      expect((await page([row, bad]).send("GET", "/github/repository-choices")).status, JSON.stringify(bad)).toBe(503);
    }
    expect((await page([row], { next: "not-a-repo" }).send("GET", "/github/repository-choices")).status).toBe(503);
    expect((await page(Array.from({ length: 101 }, () => row)).send("GET", "/github/repository-choices")).status).toBe(503);
    const failing = stub(() => json(500, { error: { message: "boom arn:aws:s3:::x" } }));
    expect(await failing.send("GET", "/github/repository-choices")).toEqual({ status: 503, body: PICKER_WORDS.listUnavailable.body });
  });

  it("remembers at most the newest creations for replays", async () => {
    const w = stub((path) => (path === "/v1/dev/client/projects" ? json(200, { name: "made" }) : json(404, {})));
    for (let n = 0; n < REMEMBERED_CREATES_MAX + 5; n += 1) expect((await w.send("POST", "/projects", { requestId: ID(100 + n), repositories: ["a/one"] })).status).toBe(201);
    const kept = Object.keys((await w.store.get(w.id))!.created ?? {});
    expect(kept).toHaveLength(REMEMBERED_CREATES_MAX);
    // The newest are the ones kept (the clock is the real one, so only the count and the latest are checked).
    expect(kept).toContain(ID(100 + REMEMBERED_CREATES_MAX + 4));
  });
});

describe("the setup-run cap", () => {
  it("is three per company, in one place, and a runner may start only what the cap leaves room for", () => {
    expect(SETUP_RUNS_AT_ONCE_PER_COMPANY).toBe(3);
    expect(setupRunsToStart(0, 10)).toBe(3);
    expect(setupRunsToStart(2, 10)).toBe(1);
    expect(setupRunsToStart(3, 10)).toBe(0);
    expect(setupRunsToStart(7, 10)).toBe(0);
    expect(setupRunsToStart(0, 2)).toBe(2);
    expect(setupRunsToStart(0, 0)).toBe(0);
    expect(setupRunsToStart(-1, 5)).toBe(0);
    expect(setupRunsToStart(1.5, 5)).toBe(0);
  });
});
