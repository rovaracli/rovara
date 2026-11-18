// Lead 4 PCF: Cloud's three pass-throughs for the plan card (`/v1/web/tasks/{task}/feature-choices`, `/v1/web/tasks/{task}/feature`, `/v1/web/org/report/features`), answered by Rovara Code as the signed-in person. A pretend Code with
// two companies stands in: Code's own gate and refusals reach the app unchanged, nothing the browser sends picks a company, a task id or a Code path, bodies are rebuilt from the fields the page sends, and Code's answers are
// rebuilt from the fields the page reads. Making a feature is refused here, in fixed words, for anyone who is not a company owner or admin.
import { describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { PLAN_FEATURE_WORDS, projectChoices } from "../../packages/cloud-server/src/plan-feature-routes.js";
import { PlanFeatureChoicesResponseSchema } from "../../packages/contracts/src/app-plan-feature.js";

const CODE = "https://code.example.test";
const ADA = "a".repeat(64), CAL = "c".repeat(64), DEE = "d".repeat(64), BEA = "b".repeat(64);
const TASK_A = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", TASK_B = "7a9d0c1e-2b3a-4c5d-8e7f-001122334466";
const COMPANY_A = "org_aaaaaaaaaaaaaaaaaaaa", COMPANY_B = "org_bbbbbbbbbbbbbbbbbbbb";
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F_CHECKOUT = FT("1"), F_BILLING = FT("2"), F_SECRET = FT("9");

interface Who { developerId: string; name: string; company: "A" | "B"; role: "owner" | "admin" | "member"; token: string }
const WHO: Record<string, Who> = {
  "ada-code": { developerId: ADA, name: "Ada", company: "A", role: "member", token: "ada-access" },
  "cal-code": { developerId: CAL, name: "Cal", company: "A", role: "admin", token: "cal-access" },
  "dee-code": { developerId: DEE, name: "Dee", company: "A", role: "member", token: "dee-access" },
  "bea-code": { developerId: BEA, name: "Bea", company: "B", role: "admin", token: "bea-access" },
};
interface Call { method: string; path: string; token: string; body?: unknown }

/** A pretend Code: tasks of two companies (A's started by Ada, B's by Bea); the choices and the filing are for the task's person or a company admin; making a feature is for admins. */
function fakeCode() {
  const calls: Call[] = [];
  const flags = { choices: "ok" as "ok" | "garbage" | "huge" };
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (status: number, code: string, message: string) => respond(status, { error: { code, message } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    if (url.pathname === "/v1/auth/token") {
      const who = WHO[new URLSearchParams(bodyText).get("code") ?? ""];
      return who === undefined ? respond(400, { error: "invalid_grant" }) : respond(200, { access_token: who.token });
    }
    const me = Object.values(WHO).find((entry) => `Bearer ${entry.token}` === headers.authorization);
    if (me === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    if (url.pathname === "/v1/dev/access") return respond(200, { developerId: me.developerId, displayName: me.name, administrator: false, companyId: me.company === "A" ? COMPANY_A : COMPANY_B, companyRole: me.role, projects: [{ name: "payments", access: "developer" }], notices: [] });
    calls.push({ method, path: url.pathname + url.search, token: me.token, ...(bodyText === "" ? {} : { body: JSON.parse(bodyText) as unknown }) });
    const task = method === "GET" && /^\/v1\/app\/tasks\/([^/]+)\/feature-choices$/u.exec(url.pathname);
    if (task) {
      const taskId = task[1]!;
      const mine = (taskId === TASK_A && me.company === "A" && (me.developerId === ADA || me.role !== "member")) || (taskId === TASK_B && me.company === "B");
      if (!mine) return refuse(404, "NOT_FOUND", "task not found");
      if (flags.choices === "garbage") return respond(200, { features: "nope", canCreate: "yes" });
      if (flags.choices === "huge") return respond(200, { features: Array.from({ length: 51 }, (_, n) => ({ id: FT(String(n % 10)), name: "x" })), canCreate: false });
      return respond(200, { features: me.company === "A" ? [{ id: F_CHECKOUT, name: "Checkout v2", state: "open", secret: "x" }, { id: F_BILLING, name: "Billing\u0007\n team" }, { id: "not-an-id", name: "Bad id" }, { id: FT("3"), name: " " }] : [{ id: F_SECRET, name: "Other company secret" }], canCreate: me.role !== "member" });
    }
    return refuse(404, "NOT_FOUND", "route not found");
  }) as typeof fetch;
  return { fetchImpl, calls, flags };
}

function setUp() {
  const code = fakeCode();
  const store = new LocalSessionStore(undefined, { environment: {} });
  const work = new LocalWorkSessionStore();
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "tasks:read", fetch: code.fetchImpl });
  const handler = createCloudHandler({ client, store, work, origin: "https://cloud.example.test", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date("2026-11-17T12:00:00.000Z") });
  const call = async (method: string, target: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { "x-rovara-csrf": options.csrf } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) };
    return (await handler(request))!;
  };
  const signIn = async (who: keyof typeof WHO) => {
    const start = await call("GET", "/v1/auth/browser/authorize?return_to=/app/projects");
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const back = await call("GET", `/callback?code=${who}&state=${state}`);
    const cookie = back.headers["set-cookie"]!.split(";")[0]!;
    const me = JSON.parse((await call("GET", "/v1/web/me", { cookie })).body) as { csrf: string };
    return { cookie, csrf: me.csrf };
  };
  return { code, call, signIn };
}
const base = async () => {
  const context = setUp();
  return { ...context, ada: await context.signIn("ada-code"), cal: await context.signIn("cal-code"), dee: await context.signIn("dee-code"), bea: await context.signIn("bea-code") };
};
type Session = { cookie: string; csrf: string };
const send = (w: Awaited<ReturnType<typeof base>>, who: Session, method: string, path: string, body?: unknown, csrf: string | null = who.csrf) => w.call(method, path, { cookie: who.cookie, ...(csrf === null ? {} : { csrf }), ...(body === undefined ? {} : { body }) });
const parse = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const codeCalls = (w: Awaited<ReturnType<typeof base>>) => w.code.calls.filter((entry) => entry.path.startsWith("/v1/app/"));

describe("the plan card's choices (GET /v1/web/tasks/{task}/feature-choices)", () => {
  it("answers Code's list as the person, the names made one inert line, an entry that does not read left out, only the fields the page reads", async () => {
    const w = await base();
    const answer = await send(w, w.ada, "GET", `/v1/web/tasks/${TASK_A}/feature-choices`);
    expect(answer.status).toBe(200);
    const body = PlanFeatureChoicesResponseSchema.parse(parse(answer));
    expect(body).toEqual({ features: [{ id: F_CHECKOUT, name: "Checkout v2" }, { id: F_BILLING, name: "Billing team" }], canCreate: false });
    expect(answer.body).not.toMatch(/secret|state|not-an-id/u);
    expect(codeCalls(w)).toEqual([{ method: "GET", path: `/v1/app/tasks/${TASK_A}/feature-choices`, token: "ada-access" }]);
    expect(PlanFeatureChoicesResponseSchema.parse(parse(await send(w, w.cal, "GET", `/v1/web/tasks/${TASK_A}/feature-choices`))).canCreate).toBe(true);
  });

  it("Code's own gate decides: a company member who is not the task's person gets Code's 404 unchanged, and another company's task is a missing one with no name crossing", async () => {
    const w = await base();
    for (const [who, task] of [[w.dee, TASK_A], [w.bea, TASK_A], [w.ada, TASK_B]] as const) {
      const answer = await send(w, who, "GET", `/v1/web/tasks/${task}/feature-choices`);
      expect(answer.status).toBe(404);
      expect(parse(answer)).toEqual({ error: { code: "NOT_FOUND", message: "task not found" } });
      expect(answer.body).not.toMatch(/Checkout|secret/u);
    }
    const own = await send(w, w.bea, "GET", `/v1/web/tasks/${TASK_B}/feature-choices`);
    expect(own.body).toContain("Other company secret");
    expect(own.body).not.toContain("Checkout");
  });

  it("builds the Code address from a task id only: anything else is not a route and Code is not asked", async () => {
    const w = await base();
    for (const bad of ["x", "../../v1/dev/tasks", `${TASK_A}/../x`, `${TASK_A}%2f..`, "6f9d0c1e-2b3a-4c5d-8e7f-0011223344zz"]) {
      const answer = (await send(w, w.ada, "GET", `/v1/web/tasks/${bad}/feature-choices`)) as Awaited<ReturnType<typeof send>> | undefined;
      expect(answer === undefined || [404, 501].includes(answer.status), bad).toBe(true);
    }
    expect(codeCalls(w)).toEqual([]);
  });

  it("refuses a list that is not a list, or longer than the picker holds, in fixed words that echo nothing", async () => {
    const w = await base();
    for (const flag of ["garbage", "huge"] as const) {
      w.code.flags.choices = flag;
      const answer = await send(w, w.ada, "GET", `/v1/web/tasks/${TASK_A}/feature-choices`);
      expect(answer.status).toBe(502);
      expect(parse(answer)).toEqual(PLAN_FEATURE_WORDS.unreadable.body);
      expect(answer.body).not.toContain("nope");
    }
  });

  it("is answered for a signed-in person only", async () => {
    const w = await base();
    expect((await w.call("GET", `/v1/web/tasks/${TASK_A}/feature-choices`)).status).toBe(401);
    expect(codeCalls(w)).toEqual([]);
  });
});

describe("what Cloud reads of Code's choices", () => {
  it("keeps only readable feature choices and rejects a malformed list", () => {
    expect(projectChoices({ features: [{ id: F_BILLING, name: "Billing" }, { id: "bad", name: "Hidden" }], canCreate: true })).toEqual({ features: [{ id: F_BILLING, name: "Billing" }], canCreate: true });
    for (const bad of [null, [], {}, { features: [] }, { features: [], canCreate: "yes" }, { features: {}, canCreate: true }]) expect(projectChoices(bad), JSON.stringify(bad)).toBeUndefined();
  });
});
