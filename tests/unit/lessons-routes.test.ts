// The lessons screens' routes on Cloud (packages/cloud-server/src/lessons-routes.ts), end to end on the fake Code: the inbox batch, the lists, Keep, Edit and Drop
// (one at a time and in a batch, with one result each), retire and retire requests, the mode, "Lessons used" and "not helpful", and Code's "Lessons are off."
// passed through so the screens can show their calm off state. Cloud forwards only what Code takes (fixed words for every reason).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { lessonItem, lessonsOff } from "../../packages/cloud-server/src/lessons-routes.js";
import { PRIYA, SAM, TASK_IDS, startFakeCode, type FakeCode } from "../support/fake-code.js";

interface Answer<T = Record<string, unknown>> { status: number; body: T }
interface Lesson { id: string; version: number; title: string; from: Array<{ name: string; you?: true }>; expiresAt: number; counters: Record<string, number>; canApprove: boolean; canRetire: boolean; status: string }
let fake: FakeCode;
let as: (who: "priya" | "sam") => Promise<{ get: <T>(target: string) => Promise<Answer<T>>; send: <T>(method: string, target: string, body?: unknown) => Promise<Answer<T>> }>;

beforeAll(async () => {
  fake = await startFakeCode();
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const raw = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = await handler(request);
    return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
  };
  as = async (who) => {
    fake.setPerson(who === "priya" ? PRIYA : SAM);
    const start = await raw("GET", "/v1/auth/browser/authorize?return_to=/app", {});
    const back = new URL((await fetch(start.headers["location"]!, { redirect: "manual" })).headers.get("location")!);
    const cookie = (await raw("GET", `${back.pathname}${back.search}`, {})).headers["set-cookie"]!.split(";")[0]!;
    const csrf = ((await raw("GET", "/v1/web/me", { cookie })).body as { csrf: string }).csrf;
    return {
      get: async <T>(target: string) => { const answer = await raw("GET", `/v1/web${target}`, { cookie });return { status: answer.status, body: answer.body as T }; },
      send: async <T>(method: string, target: string, body?: unknown) => { const answer = await raw(method, `/v1/web${target}`, { cookie, "x-rovara-csrf": csrf, "content-type": "application/json" }, body);return { status: answer.status, body: answer.body as T }; },
    };
  };
});
beforeEach(() => { fake.setLessons(true); });
afterAll(async () => { await fake.close(); });

describe("the lessons inbox", () => {
  it("answers one batch per project with the lessons the person may decide, theirs first", async () => {
    const priya = await as("priya");
    const { status, body } = await priya.get<{ state: string; batches: Array<{ project: string; fromYou: number; lessons: Lesson[] }>; unavailable: string[] }>("/lessons/inbox");
    expect(status).toBe(200);
    expect(body.state).toBe("on");
    expect(body.unavailable).toEqual([]);
    expect(body.batches.map((batch) => batch.project)).toEqual(["web"]);
    const [batch] = body.batches;
    expect(batch!.lessons).toHaveLength(3);
    expect(batch!.fromYou).toBe(2);
    // Priya's own corrections first, then the soonest to lapse.
    expect(batch!.lessons.slice(0, 2).every((lesson) => lesson.from.some((one) => one.you === true))).toBe(true);
    expect(batch!.lessons[2]!.id).toBe("les_tests0001");
  });

  it("has no batch for someone who cannot decide, and says off when every project's lessons are off", async () => {
    const sam = await as("sam");
    expect((await sam.get<{ batches: unknown[] }>("/lessons/inbox")).body.batches).toEqual([]);
    fake.setLessons(false);
    expect((await sam.get("/lessons/inbox")).body).toEqual({ state: "off", batches: [], unavailable: [] });
  });
});

describe("the Learned lists, the mode and retiring", () => {
  it("reads each list and passes Code's off refusal through unchanged", async () => {
    const priya = await as("priya");
    const approved = await priya.get<{ list: string; canDecide: boolean; lessons: Lesson[] }>("/projects/web/lessons");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ list: "approved", canDecide: true });
    expect(approved.body.lessons.find((lesson) => lesson.id === "les_logs00001")?.counters).toEqual({ loaded: 14, helpful: 3, harmful: 1 });
    expect((await priya.get<{ lessons: Lesson[] }>("/projects/web/lessons?list=retired")).body.lessons.map((lesson) => lesson.id)).toEqual(["les_semis0001"]);
    expect((await priya.get("/projects/web/lessons?list=everything")).status).toBe(400);
    expect((await priya.get("/projects/web/lessons?limit=500")).status).toBe(400);
    fake.setLessons(false);
    expect(await priya.get("/projects/web/lessons")).toEqual({ status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } });
    expect((await priya.get("/projects/web/lessons/mode")).status).toBe(404);
  });

  it("reads and sets the mode; Code refuses someone who may not", async () => {
    const priya = await as("priya");
    expect((await priya.get("/projects/web/lessons/mode")).body).toEqual({ project: "web", mode: "suggest", effective: "suggest", lockedByCompany: false, canChange: true });
    expect((await priya.send("PUT", "/projects/web/lessons/mode", { mode: "loud" })).status).toBe(400);
    expect((await priya.send("PUT", "/projects/web/lessons/mode", { mode: "auto" })).body).toMatchObject({ mode: "auto" });
    await priya.send("PUT", "/projects/web/lessons/mode", { mode: "suggest" });
    const sam = await as("sam");
    expect((await sam.get("/projects/web/lessons/mode")).body).toMatchObject({ canChange: false });
    expect((await sam.send("PUT", "/projects/web/lessons/mode", { mode: "off" })).status).toBe(403);
  });

  it("lets anyone on the project ask to retire, and the people who decide see and answer it with a fixed reason", async () => {
    const sam = await as("sam");
    expect((await sam.send("POST", "/projects/web/lessons/les_readme001/retire-request", { anything: "dropped" })).body).toEqual({ project: "web", lessonId: "les_readme001", requested: true });
    expect((await sam.get("/projects/web/lessons/retire-requests")).status).toBe(403);
    const priya = await as("priya");
    const requests = await priya.get<{ requests: Array<{ lessonId: string; by: string }> }>("/projects/web/lessons/retire-requests");
    expect(requests.body.requests).toEqual([expect.objectContaining({ lessonId: "les_readme001", by: "Sam" })]);
    expect((await priya.send("POST", "/projects/web/lessons/les_readme001/retire", { reason: "because I said so" })).status).toBe(400);
    expect((await priya.send("POST", "/projects/web/lessons/les_readme001/retire", { reason: "outdated" })).body).toEqual({ project: "web", lessonId: "les_readme001", status: "retired" });
    expect((await priya.get<{ requests: unknown[] }>("/projects/web/lessons/retire-requests")).body.requests).toEqual([]);
  });
});

describe("Keep, Edit and Drop", () => {
  it("sends a batch with one result each, and refuses a malformed one before it reaches Code", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", "/projects/web/lessons/decisions", { decisions: [] })).status).toBe(400);
    expect((await priya.send("POST", "/projects/web/lessons/decisions", { decisions: [{ lessonId: "les_retry0001", version: 1, decision: "drop", reason: "my own words" }] })).status).toBe(400);
    expect((await priya.send("POST", "/projects/web/lessons/decisions", { decisions: [{ lessonId: "les_retry0001", version: 1, decision: "keep" }, { lessonId: "les_retry0001", version: 1, decision: "keep" }] })).status).toBe(400);
    expect((await priya.send("POST", "/projects/web/lessons/decisions", { decisions: [{ lessonId: "les_retry0001", version: 1, decision: "keep", edit: { title: "", description: "", body: "x" } }] })).status).toBe(400);
    const answer = await priya.send<{ results: Array<Record<string, unknown>> }>("POST", "/projects/web/lessons/decisions", { decisions: [
      { lessonId: "les_retry0001", version: 1, decision: "keep", edit: { title: "Wrap every webhook call in withRetry", description: "", body: "Use withRetry(fn, { attempts: 3 })." } },
      { lessonId: "les_dates0001", version: 1, decision: "keep" },
      { lessonId: "les_tests0001", version: 9, decision: "drop", reason: "too_narrow" },
    ] });
    expect(answer.status).toBe(200);
    expect(answer.body.results).toEqual([
      { lessonId: "les_retry0001", ok: true, status: "active" },
      { lessonId: "les_dates0001", ok: true, status: "pending" },
      { lessonId: "les_tests0001", ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." },
    ]);
    const approved = await priya.get<{ lessons: Lesson[] }>("/projects/web/lessons");
    expect(approved.body.lessons.find((lesson) => lesson.id === "les_retry0001")).toMatchObject({ title: "Wrap every webhook call in withRetry", version: 2 });
    expect((await priya.send("POST", "/projects/web/lessons/les_tests0001/reject", { version: 1, reason: "duplicate" })).body).toEqual({ project: "web", lessonId: "les_tests0001", status: "rejected" });
    expect((await priya.send("POST", "/projects/web/lessons/les_dates0001/approve", { version: 1 })).body).toMatchObject({ status: "pending" });
    expect((await priya.send("POST", "/projects/web/lessons/les_dates0001/approve", {})).status).toBe(400);
  });
});

describe("Lessons used", () => {
  it("lists the lessons a task was given, with no words for one the person cannot see, and records one not-helpful mark", async () => {
    const priya = await as("priya");
    const read = await priya.get<{ lessons: Array<Record<string, unknown>> }>(`/projects/web/tasks/${TASK_IDS.pullRequest}/lessons`);
    expect(read.status).toBe(200);
    expect(read.body.lessons).toHaveLength(3);
    expect(read.body.lessons[0]).toMatchObject({ lessonId: "les_logs00001", why: "scope", citation: "valid", helpful: 3, harmful: 1, canMark: true });
    expect(read.body.lessons[2]).toEqual({ stage: "REVIEW", round: 1, lessonId: "les_hidden001", version: 2, why: "similar", citation: "unchecked", visible: false, canMark: false });
    const path = `/projects/web/tasks/${TASK_IDS.pullRequest}/lessons/les_logs00001/not-helpful`;
    expect((await priya.send("POST", path, { extra: true })).body).toEqual({ project: "web", taskId: TASK_IDS.pullRequest, lessonId: "les_logs00001", marked: "not_helpful" });
    expect((await priya.send("POST", path)).status).toBe(409);
    expect((await priya.get(`/projects/web/tasks/not-a-task/lessons`)).status).toBe(501);
  });
});

describe("the shapes Cloud keeps", () => {
  it("keeps a lesson to the fields the screens draw and drops a citation that is not https", () => {
    const view = lessonItem({ id: "les_aaaa", version: 1, expiresAt: 5, title: "T", body: "B", secret: "kept out", citations: [{ kind: "pr", url: "http://insecure.example" }, { kind: "pr", url: "https://github.com/x/y/pull/1" }], from: [{ name: "Ann", you: true, email: "a@x" }], counters: { loaded: -3, helpful: 2.7 } });
    expect(view).not.toHaveProperty("secret");
    expect(view?.["citations"]).toEqual([{ kind: "pr", url: "https://github.com/x/y/pull/1" }]);
    expect(view?.["from"]).toEqual([{ name: "Ann", you: true }]);
    expect(view?.["counters"]).toEqual({ loaded: 0, helpful: 2, harmful: 0 });
    expect(lessonItem({ id: "x" })).toBeUndefined();
    // A duplicate or contradiction is named by id (never free text), and the distinct-task count passes through only when Code sends it.
    expect(lessonItem({ id: "les_cccc", version: 1, expiresAt: 5, title: "T", possibleDuplicate: "les_dddd", contradicts: "<b>no</b>", mergeBlocked: true, usedInTasks: 4 })).toMatchObject({ possibleDuplicate: "les_dddd", mergeBlocked: true, usedInTasks: 4 });
    expect(lessonItem({ id: "les_cccc", version: 1, expiresAt: 5, title: "T", contradicts: "<b>no</b>" })).not.toHaveProperty("contradicts");
    expect(lessonItem({ id: "les_cccc", version: 1, expiresAt: 5, title: "T" })).not.toHaveProperty("usedInTasks");
    // No lapse time: left out, never shown as "lapses now".
    expect(lessonItem({ id: "les_bbbb", version: 1, title: "T" })).toBeUndefined();
  });
  it("keeps a lesson whose citation kind, tier, count of people or source kinds Code added later: an unknown kind is an `other` reference, never dropped, never read as a known kind", () => {
    const row = { id: "les_aaaa", version: 1, expiresAt: 5, title: "T", sourceKinds: ["plan_comment", "design_comment", "other", "made_up_future_kind"], provenance: { sourceKinds: ["plan_comment"] }, newerField: { deep: 1 } };
    const view = lessonItem({ ...row, citations: [{ kind: "wiki", page: "p" }, { kind: "pr", url: "https://github.com/x/y/pull/1" }, { kind: "task", taskId: "t1" }, 7, { kind: "code", repo: "r" }], needs: { required: 3, have: 1, groups: [] } });
    expect(view).not.toHaveProperty("sourceKinds");
    expect(view).not.toHaveProperty("provenance");
    // A known kind with a bad body is still dropped; a non-object is dropped; only an unknown kind of an object becomes `other`.
    expect(view?.["citations"]).toEqual([{ kind: "other" }, { kind: "pr", url: "https://github.com/x/y/pull/1" }, { kind: "task", taskId: "t1" }]);
    expect(view?.["needs"]).toMatchObject({ required: 2, have: 1 });
    expect(lessonItem({ ...row, needs: { required: 1, have: 0 } })?.["needs"]).toMatchObject({ required: 1 });
    expect(lessonItem({ ...row, needs: { required: "many", have: 0 } })?.["needs"]).toMatchObject({ required: 1 });
  });
  it("tells Code's off refusal from any other 404", () => {
    expect(lessonsOff(new CodeError(404, { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } }))).toBe(true);
    expect(lessonsOff(new CodeError(404, { error: { code: "NOT_FOUND", message: "No such project." } }))).toBe(false);
  });
});
