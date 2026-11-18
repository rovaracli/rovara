// Lessons phase 4 (L4-LP4G) on Cloud (packages/cloud-server/src/lessons-graduation-routes.ts), end to end on the fake Code: the week's "Make this permanent?" card, the tidy
// card and the draft tasks, Make permanent, Not now, "Both, in different places", tidy retire and the two draft task writes. Cloud forwards only what Code takes (fixed
// words, bounded plain paths, ids matched against Code's patterns), keeps Code's answers to the fields the screens draw and passes Code's refusals through in Code's words.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { lessonItem } from "../../packages/cloud-server/src/lessons-routes.js";
import { graduationView, plainGlob } from "../../packages/cloud-server/src/lessons-graduation-routes.js";
import { PRIYA, SAM, TASK_IDS, ZED, startFakeCode, type FakeCode } from "../support/fake-code.js";

interface Answer<T = Record<string, unknown>> { status: number; body: T }
interface View { project?: string; canDecide?: boolean; rules?: unknown[]; card?: Record<string, unknown>; tidy?: { period: number; lessons: Array<{ lessonId: string }> }; drafts?: unknown[] }
type Who = "priya" | "sam" | "zed";
let fake: FakeCode;
let as: (who: Who) => Promise<{ get: <T = Record<string, unknown>>(target: string) => Promise<Answer<T>>; send: <T = Record<string, unknown>>(method: string, target: string, body?: unknown) => Promise<Answer<T>> }>;

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
    fake.setPerson(who === "priya" ? PRIYA : who === "sam" ? SAM : ZED);
    const start = await raw("GET", "/v1/auth/browser/authorize?return_to=/app", {});
    const back = new URL((await fetch(start.headers["location"]!, { redirect: "manual" })).headers.get("location")!);
    const cookie = (await raw("GET", `${back.pathname}${back.search}`, {})).headers["set-cookie"]!.split(";")[0]!;
    const csrf = ((await raw("GET", "/v1/web/me", { cookie })).body as { csrf: string }).csrf;
    return {
      get: async <T = Record<string, unknown>>(target: string) => { const answer = await raw("GET", `/v1/web${target}`, { cookie });return { status: answer.status, body: answer.body as T }; },
      send: async <T = Record<string, unknown>>(method: string, target: string, body?: unknown) => { const answer = await raw(method, `/v1/web${target}`, { cookie, "x-rovara-csrf": csrf, "content-type": "application/json" }, body);return { status: answer.status, body: answer.body as T }; },
    };
  };
});
beforeEach(() => { fake.setLessons(true); fake.resetLessons(); fake.lessonCalls.length = 0; for (const id of ["lessons.graduation", "lessons.graduate", "lessons.graduateLater", "lessons.bothPlaces", "lessons.tidy.retire", "lessons.tidy.later", "lessons.checkDraft.started", "lessons.checkDraft.dismiss", "lessons.rules.retire"]) fake.overrideLessonAnswer(id, undefined); });
afterAll(async () => { await fake.close(); });

const ANY_NUMBER: unknown = expect.any(Number);
const ANY_TEXT: unknown = expect.stringContaining("request id");
const P = "/projects/web/lessons";
const REFUSED = { error: { code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide what becomes permanent." } };
const sent = (id: string) => fake.lessonCalls.filter((call) => call.id === id);

describe("the graduation read", () => {
  it("answers the week's card, the tidy card and the draft tasks to a person who decides, in the fields the screens draw", async () => {
    const priya = await as("priya");
    const { status, body } = await priya.get<View>(`${P}/graduation`);
    expect(status).toBe(200);
    expect(body.project).toBe("web");
    expect(body.canDecide).toBe(true);
    expect(body.card).toEqual({
      lessonId: "les_logs00001", version: 1, title: "Log request ids with every error", description: "Error logs carry the request id.", type: "convention", tier: 1,
      target: "rule", targets: ["rule", "check", "skill"], paths: ["src/logging/**"], tasks: 12, days: 41, needs: { required: 1, have: 0, you: false },
    });
    expect(body.tidy?.period).toBe(30);
    expect(body.tidy?.lessons.map((lesson) => lesson.lessonId)).toEqual(["les_readme001", "les_logs00001"]);
    expect(body.drafts).toEqual([{ id: "chk_0123456789abcdef", lessonId: "les_semis0001", title: "Check that scripts have no semicolons", request: "Add a check that fails when a file in scripts/legacy has a semicolon at the end of a line.", paths: ["scripts/legacy/**"], createdAt: ANY_NUMBER }]);
  });

  it("answers a person who may not decide with canDecide false and nothing else, as Code does", async () => {
    const sam = await as("sam");
    expect((await sam.get(`${P}/graduation`)).body).toEqual({ project: "web", canDecide: false, drafts: [], rules: [] });
  });

  it("never shows a card, a tidy card or a draft to someone Code did not mark as deciding, whatever Code sent", () => {
    const full = { canDecide: false, card: { lessonId: "les_aaaa", version: 1, title: "T", target: "rule", targets: ["rule"] }, tidy: { period: 30, lessons: [{ lessonId: "les_aaaa", version: 1, title: "T" }] }, drafts: [{ id: "chk_0123456789abcdef", lessonId: "les_aaaa", title: "T", request: "R" }], rules: [{ id: "rule_0123456789abcdef", text: "T" }] };
    expect(graduationView(full, "web")).toEqual({ project: "web", canDecide: false, drafts: [], rules: [] });
    expect(graduationView({ ...full, canDecide: "yes" }, "web")).toEqual({ project: "web", canDecide: false, drafts: [], rules: [] });
    expect(graduationView({ ...full, canDecide: true }, "web")).toMatchObject({ canDecide: true, card: { lessonId: "les_aaaa" }, tidy: { period: 30 } });
  });

  it("reads what a newer Code adds: unknown fields are dropped, an unknown target is left out, a larger count of people reads as two, an unknown tier as one", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("lessons.graduation", { body: {
      project: "web", canDecide: true, futureField: { deep: 1 },
      card: { lessonId: "les_logs00001", version: 3, title: "T".repeat(200), description: "D", type: "convention", tier: 9, target: "wiki_page", targets: ["skill", "wiki_page", "rule", "skill"], paths: ["src/**", "../etc/passwd", "/abs/path", "ok/*.ts"], tasks: 7.8, days: -3, needs: { required: 3, have: 1, you: true, extra: 1 }, secret: "kept out" },
      tidy: { period: 30, lessons: Array.from({ length: 14 }, (_, index) => ({ lessonId: `les_tidy${String(index).padStart(4, "0")}`, version: 1, title: `Lesson ${String(index)}`, type: "fact", tasks: index, days: 3, extra: true })) },
      drafts: [{ id: "chk_0123456789abcdef", lessonId: "les_aaaa", title: "A", request: "Do it", paths: ["a/**", "../b"], createdAt: 5, extra: 1 }, { id: "chk_nothex", lessonId: "les_aaaa", title: "B", request: "x" }, { id: "chk_0123456789abcde0", lessonId: "x", title: "C", request: "x" }, { id: "chk_0123456789abcde1", lessonId: "les_aaaa", title: "D", request: "" }],
    } });
    const body = (await priya.get<View>(`${P}/graduation`)).body;
    expect(body).not.toHaveProperty("futureField");
    expect(body.card).toEqual({ lessonId: "les_logs00001", version: 3, title: "T".repeat(80), description: "D", type: "convention", tier: 1, target: "skill", targets: ["skill", "rule"], paths: ["src/**", "ok/*.ts"], tasks: 7, days: 0, needs: { required: 2, have: 1, you: true } });
    expect(body.tidy?.lessons).toHaveLength(10);
    expect(body.tidy?.lessons[0]).toEqual({ lessonId: "les_tidy0000", version: 1, title: "Lesson 0", type: "fact", tasks: 0, days: 3 });
    expect(body.drafts).toEqual([{ id: "chk_0123456789abcdef", lessonId: "les_aaaa", title: "A", request: "Do it", paths: ["a/**"], createdAt: 5 }]);
  });

  it("offers the suggestion even when Code left it out of its list, and draws no card when no target is one this build knows", () => {
    const base = { lessonId: "les_aaaa", version: 1, title: "T" };
    expect(graduationView({ canDecide: true, card: { ...base, target: "check", targets: ["rule"] } }, "web")["card"]).toMatchObject({ target: "check", targets: ["check", "rule"] });
    expect(graduationView({ canDecide: true, card: { ...base, targets: ["rule", "skill"] } }, "web")["card"]).toMatchObject({ target: "rule", targets: ["rule", "skill"] });
    expect(graduationView({ canDecide: true, card: { ...base, target: "wiki", targets: ["wiki", 4] } }, "web")).not.toHaveProperty("card");
    for (const broken of [{ ...base, lessonId: "x" }, { ...base, version: 0 }, { ...base, title: "" }, { ...base, title: 3 }, "card", null]) expect(graduationView({ canDecide: true, card: { target: "rule", targets: ["rule"], ...(broken as object) } }, "web"), JSON.stringify(broken)).not.toHaveProperty("card");
  });

  it("leaves out a tidy card with no readable lesson and says nothing when Code answers something that is not an answer", () => {
    expect(graduationView({ canDecide: true, tidy: { period: 30, lessons: [{ lessonId: "x", version: 1, title: "T" }, { lessonId: "les_aaaa", version: 1 }] } }, "web")).not.toHaveProperty("tidy");
    expect(graduationView("nope", "web")).toEqual({ project: "web", canDecide: false, drafts: [], rules: [] });
  });
});

describe("Make permanent", () => {
  const graduate = (target: unknown, extra: Record<string, unknown> = {}) => as("priya").then((priya) => priya.send(`POST`, `${P}/les_logs00001/graduate`, { target, ...extra }));

  it("checks the target and each optional field before Code is asked, and sends nothing for a refused body", async () => {
    const priya = await as("priya");
    for (const body of [{}, { target: "wiki" }, { target: 3 }, { target: "rule", paths: [] }, { target: "rule", paths: "src/**" }, { target: "rule", paths: ["a", "a"] },
      { target: "rule", paths: Array.from({ length: 21 }, (_, index) => `p${String(index)}/**`) }, { target: "rule", paths: ["x".repeat(201)] }, { target: "rule", paths: ["/abs/**"] },
      { target: "rule", paths: ["a/../b"] }, { target: "rule", paths: ["a\\b"] }, { target: "rule", paths: [""] }, { target: "rule", paths: [7] }, { target: "rule", paths: ["a{b,c}"] }, { target: "rule", paths: ["a,b"] }, { target: "rule", paths: ["a b"] },
      { target: "check", paths: ["src/**"] }, { target: "skill", paths: ["src/**"] },
      { target: "skill", name: "Bad Name" }, { target: "skill", name: "-lead" }, { target: "skill", name: "a".repeat(65) }, { target: "skill", name: 4 }, { target: "skill", name: "" },
      { target: "rule", name: "retry-helper" }, { target: "check", name: "retry-helper" }]) {
      expect((await priya.send("POST", `${P}/les_logs00001/graduate`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(sent("lessons.graduate")).toEqual([]);
  });

  it("forwards a rule with its paths, a check, and a skill with its name, and nothing else the body carried", async () => {
    const rule = await graduate("rule", { paths: ["src/logging/**", "src/logging/http/*.ts"], evil: "dropped", requestId: "x" });
    expect(rule).toEqual({ status: 200, body: { project: "web", lessonId: "les_logs00001", target: "rule", state: "done", ref: "rule_0123456789abcdef", already: false } });
    expect(sent("lessons.graduate")[0]).toMatchObject({ params: { project: "web", lessonId: "les_logs00001" }, body: { target: "rule", paths: ["src/logging/**", "src/logging/http/*.ts"] } });
    expect(Object.keys(sent("lessons.graduate")[0]!.body as object).sort()).toEqual(["paths", "target"]);
  });

  it("forwards a check and a skill with only the fields each takes", async () => {
    const priya = await as("priya");
    const skill = await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "skill", name: "log-request-ids", paths: undefined, other: 1 });
    expect(skill.body).toEqual({ project: "web", lessonId: "les_logs00001", target: "skill", state: "drafted", name: "log-request-ids", version: 1 });
    expect(sent("lessons.graduate")[0]!.body).toEqual({ target: "skill", name: "log-request-ids" });
    fake.lessonCalls.length = 0;
    const check = await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "check" });
    expect(check.body).toMatchObject({ target: "check", state: "done", ref: "chk_fedcba9876543210" });
    expect(sent("lessons.graduate")[0]!.body).toEqual({ target: "check" });
  });

  it("answers what Code answered: waiting for a second person, a drafted skill, an already-done lesson and a state a newer Code added", async () => {
    const priya = await as("priya");
    const answers: Array<[unknown, unknown]> = [
      [{ project: "web", lessonId: "les_logs00001", target: "rule", state: "waiting", needs: "second_person", more: 1 }, { project: "web", lessonId: "les_logs00001", target: "rule", state: "waiting", needs: "second_person" }],
      [{ state: "done", target: "rule", ref: "r".repeat(300), already: true }, { project: "web", lessonId: "les_logs00001", target: "rule", state: "done", ref: "r".repeat(200), already: true }],
      [{ state: "drafted", target: "skill", name: "n".repeat(90), version: "x" }, { project: "web", lessonId: "les_logs00001", target: "skill", state: "drafted", name: "n".repeat(64), version: 1 }],
      [{ state: "queued_for_review", target: "rule", secret: "x" }, { project: "web", lessonId: "les_logs00001", target: "rule", state: "unknown" }],
      [{ state: "done", target: "wiki_page", ref: "r" }, { project: "web", lessonId: "les_logs00001", target: "rule", state: "done", ref: "r", already: false }],
      ["nonsense", { project: "web", lessonId: "les_logs00001", target: "rule", state: "unknown" }],
    ];
    for (const [code, expected] of answers) {
      fake.overrideLessonAnswer("lessons.graduate", { body: code });
      expect((await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" })).body, JSON.stringify(code)).toEqual(expected);
    }
  });

  it("passes Code's refusals through in Code's own sentences: a person who may not decide, a lesson that is gone, and Lessons are off", async () => {
    const sam = await as("sam");
    expect(await sam.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" })).toEqual({ status: 403, body: REFUSED });
    expect(await sam.send("POST", `${P}/les_logs00001/graduate-later`, {})).toEqual({ status: 403, body: REFUSED });
    const priya = await as("priya");
    expect(await priya.send("POST", `${P}/les_nothere01/graduate`, { target: "rule" })).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "That lesson is no longer there." } } });
    fake.overrideLessonAnswer("lessons.graduate", { status: 403, body: { error: { code: "SCRIPT_TOKEN_REFUSED", message: "A script token cannot decide lessons." } } });
    expect(await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" })).toEqual({ status: 403, body: { error: { code: "SCRIPT_TOKEN_REFUSED", message: "A script token cannot decide lessons." } } });
    fake.overrideLessonAnswer("lessons.graduate", undefined);
    fake.setLessons(false);
    expect(await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" })).toEqual({ status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } });
    expect((await priya.get(`${P}/graduation`)).status).toBe(404);
  });

  it("retires the lesson with a link to what it became, so it leaves Approved and stays in Retired", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule", paths: ["src/logging/**"] })).status).toBe(200);
    const approved = await priya.get<{ lessons: Array<{ id: string }> }>(P);
    expect(approved.body.lessons.map((lesson) => lesson.id)).not.toContain("les_logs00001");
    const retired = await priya.get<{ lessons: Array<{ id: string; became?: unknown }> }>(`${P}?list=retired`);
    expect(retired.body.lessons.find((lesson) => lesson.id === "les_logs00001")?.became).toEqual({ kind: "rule", ref: "rule_0123456789abcdef", at: ANY_NUMBER });
    expect(retired.body.lessons.find((lesson) => lesson.id === "les_semis0001")).not.toHaveProperty("became");
  });
});

describe("Not now", () => {
  it("sends an empty body to Code and answers that the lesson is on hold", async () => {
    const priya = await as("priya");
    expect(await priya.send("POST", `${P}/les_logs00001/graduate-later`, { extra: 1 })).toEqual({ status: 200, body: { project: "web", lessonId: "les_logs00001", later: true } });
    expect(sent("lessons.graduateLater")[0]!.body).toEqual({});
    expect((await priya.get<View>(`${P}/graduation`)).body).not.toHaveProperty("card");
  });
});

describe("Both, in different places", () => {
  const body = { version: 1, cardPaths: ["src/tests/**"], otherPaths: ["src/app/**"] };
  it("checks the version and both path lists before Code is asked", async () => {
    const priya = await as("priya");
    for (const bad of [{}, { ...body, version: 0 }, { ...body, version: 1.5 }, { ...body, version: "1" }, { ...body, cardPaths: [] }, { ...body, otherPaths: [] }, { ...body, cardPaths: undefined }, { ...body, otherPaths: undefined },
      { ...body, cardPaths: ["/abs"] }, { ...body, otherPaths: ["a/../b"] }, { ...body, cardPaths: Array.from({ length: 21 }, (_, index) => `p${String(index)}`) }, { ...body, otherPaths: ["x".repeat(201)] }, { ...body, cardPaths: ["a", "a"] }, { ...body, cardPaths: "src/**" }]) {
      expect((await priya.send("POST", `${P}/les_tests0001/both-places`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(sent("lessons.bothPlaces")).toEqual([]);
  });

  it("forwards exactly the version and the two lists, and answers what Code answered in the screens' fields", async () => {
    const priya = await as("priya");
    const answer = await priya.send("POST", `${P}/les_tests0001/both-places`, { ...body, extra: "dropped" });
    expect(answer).toEqual({ status: 200, body: { project: "web", lessonId: "les_tests0001", otherId: "les_readme001", cardPaths: ["src/tests/**"], otherPaths: ["src/app/**"], version: 1, status: "pending", needs: "second_person" } });
    expect(sent("lessons.bothPlaces")[0]).toMatchObject({ params: { project: "web", lessonId: "les_tests0001" }, body });
    expect(Object.keys(sent("lessons.bothPlaces")[0]!.body as object).sort()).toEqual(["cardPaths", "otherPaths", "version"]);
  });

  it("reads a status or a need a newer Code added as unknown, and drops an unreadable path", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("lessons.bothPlaces", { body: { otherId: "<b>x</b>", cardPaths: ["a/**", "../x"], otherPaths: "no", version: "x", status: "paused", needs: "a_committee", more: 1 } });
    expect((await priya.send("POST", `${P}/les_tests0001/both-places`, body)).body).toEqual({ project: "web", lessonId: "les_tests0001", otherId: "", cardPaths: ["a/**"], otherPaths: [], version: 1, status: "unknown", needs: "unknown" });
  });

  it("passes a stale version and a person who may not decide through in Code's words", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/les_tests0001/both-places`, { ...body, version: 7 })).body).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT", message: "This lesson changed since you read it. Read it again and decide again." } });
    const sam = await as("sam");
    expect(await sam.send("POST", `${P}/les_tests0001/both-places`, body)).toEqual({ status: 403, body: REFUSED });
  });
});

describe("the tidy card", () => {
  it("is not read as a lesson's retire: the literal path goes to the tidy route", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/tidy/retire`, { ids: ["les_readme001"] })).status).toBe(200);
    expect(fake.lessonCalls.map((call) => call.id)).toEqual(["lessons.tidy.retire"]);
  });

  it("takes 1 to 10 distinct lesson ids and refuses anything else before Code is asked", async () => {
    const priya = await as("priya");
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `les_tidy${String(index).padStart(4, "0")}`);
    for (const bad of [{}, { ids: [] }, { ids: ids(11) }, { ids: "les_readme001" }, { ids: ["les_readme001", "les_readme001"] }, { ids: ["x"] }, { ids: ["les_readme001", 4] }, { ids: ["../etc"] }, { ids: ["les readme"] }, { ids: [null] }]) {
      expect((await priya.send("POST", `${P}/tidy/retire`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(sent("lessons.tidy.retire")).toEqual([]);
    fake.overrideLessonAnswer("lessons.tidy.retire", { body: { retired: ids(10), skipped: 0 } });
    expect((await priya.send("POST", `${P}/tidy/retire`, { ids: ids(10) })).status).toBe(200);
    expect(sent("lessons.tidy.retire")[0]!.body).toEqual({ ids: ids(10) });
  });

  it("sends only the chosen ids, answers which were retired and how many were skipped, and never reports a lesson that was not asked for", async () => {
    const priya = await as("priya");
    const mark = fake.log.length;
    expect((await priya.send("POST", `${P}/tidy/retire`, { ids: ["les_readme001", "les_nothere01"], extra: 1 })).body).toEqual({ project: "web", retired: ["les_readme001"], skipped: 1 });
    expect(sent("lessons.tidy.retire")[0]!.body).toEqual({ ids: ["les_readme001", "les_nothere01"] });
    // Code names its own path for this one (not `…/lessons/tidy/retire`, which is a lesson id's retire row).
    expect(fake.log.slice(mark).filter((entry) => entry.method === "POST" && entry.path.includes("/lessons/tidy/")).map((entry) => entry.path)).toEqual(["/v1/dev/projects/web/lessons/tidy/retire-chosen"]);
    fake.overrideLessonAnswer("lessons.tidy.retire", { body: { retired: ["les_readme001", "les_other_one", "les_readme001", 5], skipped: -4 } });
    expect((await priya.send("POST", `${P}/tidy/retire`, { ids: ["les_readme001"] })).body).toEqual({ project: "web", retired: ["les_readme001"], skipped: 0 });
  });

  it("closes the card with Not now and refuses a person who may not decide in Code's words", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/tidy/later`, { extra: 1 })).body).toEqual({ project: "web", closed: true });
    expect(sent("lessons.tidy.later")[0]!.body).toEqual({});
    expect((await priya.get<View>(`${P}/graduation`)).body).not.toHaveProperty("tidy");
    const sam = await as("sam");
    expect(await sam.send("POST", `${P}/tidy/later`, {})).toEqual({ status: 403, body: REFUSED });
    expect(await sam.send("POST", `${P}/tidy/retire`, { ids: ["les_readme001"] })).toEqual({ status: 403, body: REFUSED });
  });
});

describe("draft tasks", () => {
  const DRAFT = "chk_0123456789abcdef";
  it("takes the id of one of the person's own tasks, a lowercase uuid, and nothing else", async () => {
    const priya = await as("priya");
    for (const bad of [{}, { taskId: "" }, { taskId: "not-a-task" }, { taskId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, { taskId: `${TASK_IDS.planReview} ` }, { taskId: 4 }, { taskId: `https://x/${TASK_IDS.planReview}` }]) {
      expect((await priya.send("POST", `${P}/check-drafts/${DRAFT}/started`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(sent("lessons.checkDraft.started")).toEqual([]);
    expect((await priya.send("POST", `${P}/check-drafts/chk_bad/started`, { taskId: TASK_IDS.planReview })).status).toBe(501);
    expect(sent("lessons.checkDraft.started")).toEqual([]);
  });

  it("forwards the task id and nothing else, and Code answers a task that is not the person's own, or another project's, in its own words", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/check-drafts/${DRAFT}/started`, { taskId: "99999999-9999-4999-8999-999999999999" })).body).toEqual({ error: { code: "NOT_FOUND", message: "No such task." } });
    // Priya's own task in another project (api) is not one she can start this project's draft from.
    expect((await priya.send("POST", `${P}/check-drafts/${DRAFT}/started`, { taskId: TASK_IDS.running })).body).toEqual({ error: { code: "NOT_FOUND", message: "No such task." } });
    const answer = await priya.send("POST", `${P}/check-drafts/${DRAFT}/started`, { taskId: TASK_IDS.planReview, extra: 1 });
    expect(answer).toEqual({ status: 200, body: { project: "web", draftId: DRAFT, status: "started" } });
    expect(sent("lessons.checkDraft.started").at(-1)!.body).toEqual({ taskId: TASK_IDS.planReview });
    expect((await priya.get<View>(`${P}/graduation`)).body.drafts).toEqual([]);
  });

  it("drops a draft with an empty body, and refuses a person who may not decide in Code's words", async () => {
    const sam = await as("sam");
    expect(await sam.send("POST", `${P}/check-drafts/chk_fedcba9876543210/dismiss`, {})).toEqual({ status: 403, body: REFUSED });
    expect(await sam.send("POST", `${P}/check-drafts/chk_fedcba9876543210/started`, { taskId: TASK_IDS.planReview })).toEqual({ status: 403, body: REFUSED });
    const priya = await as("priya");
    const made = await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "check" });
    expect(made.body).toMatchObject({ ref: "chk_fedcba9876543210" });
    expect((await priya.send("POST", `${P}/check-drafts/chk_fedcba9876543210/dismiss`, { extra: 1 })).body).toEqual({ project: "web", draftId: "chk_fedcba9876543210", status: "dismissed" });
    expect(sent("lessons.checkDraft.dismiss").at(-1)!.body).toEqual({});
  });
});

describe("two projects and two companies", () => {
  const ROUTES: Array<[string, string, unknown]> = [
    ["GET", "/graduation", undefined], ["POST", "/les_logs00001/graduate", { target: "rule" }], ["POST", "/les_logs00001/graduate-later", {}], ["POST", "/les_tests0001/both-places", { version: 1, cardPaths: ["a"], otherPaths: ["b"] }],
    ["POST", "/tidy/retire", { ids: ["les_readme001"] }], ["POST", "/tidy/later", {}], ["POST", "/rules/rule_0123456789abcdef/retire", {}], ["POST", "/check-drafts/chk_0123456789abcdef/started", { taskId: TASK_IDS.planReview }], ["POST", "/check-drafts/chk_0123456789abcdef/dismiss", {}],
  ];
  it("asks Code about the project in the path and no other, and answers with that project's name", async () => {
    const zed = await as("zed");
    for (const [method, suffix, payload] of ROUTES) {
      fake.lessonCalls.length = 0;
      const answer = await zed.send<View>(method, `/projects/secret-ledger/lessons${suffix}`, payload);
      for (const call of fake.lessonCalls) expect(call.params["project"], `${method} ${suffix}`).toBe("secret-ledger");
      if (answer.status === 200) expect(answer.body.project, `${method} ${suffix}`).toBe("secret-ledger");
    }
    const ledger = (await zed.get<View>("/projects/secret-ledger/lessons/graduation")).body;
    // Zed's own project has no lessons of project web's: nothing of web's card, tidy or drafts is there.
    expect(ledger).toEqual({ project: "secret-ledger", canDecide: true, drafts: [], rules: [] });
  });

  it("gives a person of another company none of the first company's rows through any of the nine routes: Code's own No such project", async () => {
    const zed = await as("zed");
    for (const [method, suffix, payload] of ROUTES) {
      const answer = method === "GET" ? await zed.get(`/projects/web/lessons${suffix}`) : await zed.send(method, `/projects/web/lessons${suffix}`, payload);
      expect(answer, `${method} ${suffix}`).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "No such project." } } });
    }
  });

  it("never carries a project or lesson id other than the one in the path into what Code is asked or what the screen is told", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("lessons.graduate", { body: { project: "secret-ledger", lessonId: "les_other0001", target: "rule", state: "done", ref: "r", already: false } });
    expect((await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" })).body).toMatchObject({ project: "web", lessonId: "les_logs00001" });
    fake.overrideLessonAnswer("lessons.graduateLater", { body: { project: "secret-ledger", lessonId: "les_other0001", later: true } });
    expect((await priya.send("POST", `${P}/les_logs00001/graduate-later`, {})).body).toEqual({ project: "web", lessonId: "les_logs00001", later: true });
    fake.overrideLessonAnswer("lessons.graduation", { body: { project: "secret-ledger", canDecide: true, drafts: [] } });
    expect((await priya.get(`${P}/graduation`)).body).toMatchObject({ project: "web" });
  });
});

describe("what review found", () => {
  it("lists a card's own paths once each, and leaves out a card whose paths Code sent but none can be drawn (never shown as the whole project)", () => {
    const base = { lessonId: "les_aaaa", version: 1, title: "T", target: "rule", targets: ["rule"] };
    expect(graduationView({ canDecide: true, card: { ...base, paths: ["src/**", "src/**", "lib/**"] } }, "web")["card"]).toMatchObject({ paths: ["src/**", "lib/**"] });
    expect(graduationView({ canDecide: true, card: { ...base, paths: ["../x", "/abs"] } }, "web")).not.toHaveProperty("card");
    expect(graduationView({ canDecide: true, card: { ...base, paths: [] } }, "web")["card"]).toMatchObject({ paths: [] });
    expect(graduationView({ canDecide: true, card: { ...base, paths: ["../x", "ok/**"] } }, "web")["card"]).toMatchObject({ paths: ["ok/**"] });
  });

  it("leaves out a draft with no title or with a request too long to show whole, and keeps one at exactly the limit", () => {
    const draft = { id: "chk_0123456789abcdef", lessonId: "les_aaaa", title: "T", request: "r".repeat(4000) };
    expect((graduationView({ canDecide: true, drafts: [draft] }, "web")["drafts"] as unknown[])).toHaveLength(1);
    expect(graduationView({ canDecide: true, drafts: [{ ...draft, request: "r".repeat(4001) }] }, "web")["drafts"]).toEqual([]);
    expect(graduationView({ canDecide: true, drafts: [{ ...draft, title: "" }] }, "web")["drafts"]).toEqual([]);
  });

  it("reads a time a date cannot hold as no time, so a screen never throws drawing it", () => {
    const row = { id: "les_aaaa", version: 1, expiresAt: 5, title: "T" };
    for (const at of [1e18, 8.64e15 + 1, -5, Number.NaN, "5"]) expect(lessonItem({ ...row, became: { kind: "rule", ref: "r", at } })?.["became"], String(at)).toMatchObject({ at: 0 });
    expect(lessonItem({ ...row, became: { kind: "rule", ref: "r", at: 8.64e15 } })?.["became"]).toMatchObject({ at: 8.64e15 });
  });
});

describe("live team rules", () => {
  const RULE = "rule_0123456789abcdef";
  it("lists the live team rules to a person who decides, after a lesson became one, in the fields the screens draw", async () => {
    const priya = await as("priya");
    expect((await priya.get<View>(`${P}/graduation`)).body.rules).toEqual([]);
    await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule", paths: ["src/logging/**"] });
    const rules = (await priya.get<View>(`${P}/graduation`)).body.rules;
    expect(rules).toEqual([{ id: RULE, text: ANY_TEXT, paths: ["src/logging/**"], repos: ["example/web"], fromLesson: "les_logs00001", createdAt: ANY_NUMBER }]);
  });

  it("keeps a rule to the fields drawn: a bad id, empty words or a path that is not plain is left out, text and lists are bounded, and at most 50 are listed", () => {
    const row = { id: RULE, text: "Use withRetry.", paths: ["src/**"], repos: ["a/b"], fromLesson: "les_aaaa", createdAt: 5 };
    const read = graduationView({ canDecide: true, rules: [{ ...row, secret: 1, text: "t".repeat(700), paths: ["src/**", "../x", "a b"], repos: Array.from({ length: 14 }, () => "r"), fromLesson: "x" }, { ...row, id: "rule_bad" }, { ...row, text: "" }, { ...row, id: 4 }, "nope", ...Array.from({ length: 60 }, () => row)] }, "web")["rules"] as Array<Record<string, unknown>>;
    // The first 50 entries are read; the 4 unreadable ones among them are left out.
    expect(read).toHaveLength(46);
    expect(read[0]).toEqual({ id: RULE, text: "t".repeat(600), paths: ["src/**"], repos: Array.from({ length: 10 }, () => "r"), fromLesson: "", createdAt: 5 });
    expect(graduationView({ canDecide: true, rules: "nope" }, "web")["rules"]).toEqual([]);
    expect(graduationView({ canDecide: true }, "web")["rules"]).toEqual([]);
  });

  it("retires a rule with an empty body and answers with the project and rule of the path; a bad rule id never reaches Code; Code's refusals come through in its words", async () => {
    const priya = await as("priya");
    await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule" });
    expect((await priya.send("POST", `${P}/rules/${RULE}/retire`, { extra: 1 })).body).toEqual({ project: "web", ruleId: RULE, status: "retired" });
    expect(sent("lessons.rules.retire")[0]!.body).toEqual({});
    expect((await priya.get<View>(`${P}/graduation`)).body.rules).toEqual([]);
    expect(await priya.send("POST", `${P}/rules/${RULE}/retire`, {})).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "That rule is no longer there." } } });
    for (const bad of ["rule_bad", "rule_0123456789ABCDEF", "les_logs00001", "rule_0123456789abcdef0"]) expect((await priya.send("POST", `${P}/rules/${bad}/retire`, {})).status, bad).toBe(501);
    expect(sent("lessons.rules.retire")).toHaveLength(2);
    const sam = await as("sam");
    expect(await sam.send("POST", `${P}/rules/${RULE}/retire`, {})).toEqual({ status: 403, body: REFUSED });
  });

  it("passes Code's refusal of paths that widen the lesson's own paths, and of a second person who chose something else, through in its words", async () => {
    const priya = await as("priya");
    expect((await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "rule", paths: ["src/other/**"] })).body).toEqual({ error: { code: "CONFIG_INVALID", message: "A rule's paths must lie inside the lesson's own paths." } });
    fake.overrideLessonAnswer("lessons.graduate", { status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "The first person asked for something else (another target or other paths)." } } });
    expect(await priya.send("POST", `${P}/les_logs00001/graduate`, { target: "check" })).toEqual({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "The first person asked for something else (another target or other paths)." } } });
  });
});

describe("the shapes Cloud keeps", () => {
  it("reads what a lesson became: a known kind, a kind a newer Code added as other (kept), a bounded ref and a finite time, and no link from a value that is not an object", () => {
    const row = { id: "les_aaaa", version: 1, expiresAt: 5, title: "T" };
    expect(lessonItem({ ...row, became: { kind: "rule", ref: "rule_1", at: 5, secret: "x" } })?.["became"]).toEqual({ kind: "rule", ref: "rule_1", at: 5 });
    expect(lessonItem({ ...row, became: { kind: "check", ref: "chk_0123456789abcdef", at: 6 } })?.["became"]).toMatchObject({ kind: "check" });
    expect(lessonItem({ ...row, became: { kind: "skill", ref: "s", at: 7 } })?.["became"]).toMatchObject({ kind: "skill" });
    expect(lessonItem({ ...row, became: { kind: "playbook", ref: "p", at: 8 } })?.["became"]).toEqual({ kind: "other", ref: "p", at: 8 });
    expect(lessonItem({ ...row, became: { kind: 5 } })?.["became"]).toEqual({ kind: "other", ref: "", at: 0 });
    expect(lessonItem({ ...row, became: { kind: "rule", ref: "r".repeat(500), at: Number.POSITIVE_INFINITY } })?.["became"]).toEqual({ kind: "rule", ref: "r".repeat(200), at: 0 });
    for (const value of ["rule", 4, null, ["rule"]]) expect(lessonItem({ ...row, became: value }), String(value)).not.toHaveProperty("became");
    expect(lessonItem(row)).not.toHaveProperty("became");
  });

  it("takes only plain relative globs", () => {
    for (const good of ["src/**", "src/*.ts", "a/b~/d?.ts", "~/x", "README.md", "packages/ui/src/screens/**/*.tsx", "x".repeat(200)]) expect(plainGlob(good), good).toBe(true);
    for (const bad of ["", "/abs", "a/../b", "..", "a\\b", "a{b,c}", "a,b", "a b", "x".repeat(201), "a\nb", "!neg", 4, null]) expect(plainGlob(bad), String(bad)).toBe(false);
  });
});
