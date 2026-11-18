import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { modeOf } from "../../packages/cloud-server/src/lessons-routes.js";
import { PRIYA, startFakeCode, type FakeCode } from "../support/fake-code.js";

let fake: FakeCode;
let call: (method: string, target: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
beforeAll(async () => {
  fake = await startFakeCode();
  fake.setPerson(PRIYA);
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const raw = async (method: string, target: string, headers: Record<string, string>, body?: unknown) => { const url = new URL(target, "http://127.0.0.1:8787");const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };const answer = await handler(request);return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? {} : JSON.parse(answer!.body) as Record<string, unknown> }; };
  const start = await raw("GET", "/v1/auth/browser/authorize?return_to=/app", {});const back = new URL((await fetch(start.headers["location"]!, { redirect: "manual" })).headers.get("location")!);const callback = await raw("GET", `${back.pathname}${back.search}`, {});const cookie = callback.headers["set-cookie"]!.split(";")[0]!;const me = await raw("GET", "/v1/web/me", { cookie });const csrf = String(me.body["csrf"]);
  call = async (method, target, body) => raw(method, `/v1/web${target}`, { cookie, "x-rovara-csrf": csrf, "content-type": "application/json" }, body);
});
beforeEach(() => { fake.lessonCalls.length = 0; });
afterAll(async () => { await fake.close(); });

describe("lessons extras forwarders", () => {
  it("keeps only named fields from weekly summary, and sends only on on PUT", async () => {
    fake.overrideLessonAnswer("lessons.weeklySummary.get", { body: { on: true, source: "chosen", canChange: true, extra: "secret" } });
    const got = await call("GET", "/projects/web/lessons/weekly-summary");
    expect(got.body).toEqual({ project: "web", on: true, source: "chosen", canChange: true });
    await call("PUT", "/projects/web/lessons/weekly-summary", { on: false, extra: "drop" });
    expect(fake.lessonCalls.at(-1)).toMatchObject({ id: "lessons.weeklySummary.put" });
    expect(fake.lessonCalls.at(-1)?.body).toEqual({ on: false });
  });
  it("keeps only weekly list fields and only keep's empty request", async () => {
    fake.overrideLessonAnswer("lessons.weekly", { body: { weekly: { needLook: [{ id: "les_x", cause: "future", title: "x", secret: 1 }], picks: [], extra: 1 }, secret: 2 } });
    expect((await call("GET", "/projects/web/lessons/weekly")).body).toEqual({ project: "web", weekly: { needLook: [{ id: "les_x", cause: "future", title: "x" }], picks: [] } });
    await call("POST", "/projects/web/lessons/les_x/keep", { surprise: true });
    expect(fake.lessonCalls.at(-1)).toMatchObject({ id: "lessons.keep" });
    expect(fake.lessonCalls.at(-1)?.body).toEqual({});
  });
  it("accepts only the two trial decisions and bounds replay query before Code", async () => {
    expect((await call("POST", "/projects/web/lessons/mode/trial-offer", { decision: "accept", extra: 1 })).status).toBe(200);
    expect(fake.lessonCalls.at(-1)).toMatchObject({ id: "lessons.trialOffer" });
    expect(fake.lessonCalls.at(-1)?.body).toEqual({ decision: "accept" });
    const count = fake.lessonCalls.length;
    expect((await call("GET", "/projects/web/lessons/replay?tasks=0")).status).toBe(400);
    expect(fake.lessonCalls).toHaveLength(count);
  });
  it("passes Code's refusal through and returns calm 501 when Code has no route", async () => {
    fake.overrideLessonAnswer("lessons.tuning", { status: 403, body: { error: { code: "FORBIDDEN", message: "Code says no." } } });
    expect(await call("GET", "/projects/web/lessons/tuning")).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Code says no." } } });
    fake.overrideLessonAnswer("lessons.weeklySummary.get", { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    expect((await call("GET", "/projects/web/lessons/weekly-summary")).body).toMatchObject({ error: { code: "NOT_ON_CODE_YET" } });
  });
  it("keeps the tuning evidence numbers Code sends and drops what it does not name", async () => {
    const suggestion = { setting: "stepLessonCap", status: "keep", current: 5, suggested: 5, evidence: { have: 64, needed: 20, unit: "loads", secret: 1 }, message: "keep 5: fine", extra: "x" };
    fake.overrideLessonAnswer("lessons.tuning", { body: { project: "web", windowDays: 30, ready: true, message: "64 loads", evidence: { loads: 64, mergedTasks: 30, revertedTasks: 3, cleanMergeRate: 0.9, meanWordsCleanTasks: null, truncated: false, unreadable: 0, secret: "no" }, suggestions: [suggestion], note: "n", extra: 1 } });
    const body = (await call("GET", "/projects/web/lessons/tuning")).body;
    expect(body["evidence"]).toEqual({ loads: 64, mergedTasks: 30, revertedTasks: 3, cleanMergeRate: 0.9, truncated: false, unreadable: 0 });
    expect(body["suggestions"]).toEqual([{ setting: "stepLessonCap", status: "keep", current: 5, suggested: 5, evidence: { have: 64, needed: 20, unit: "loads" }, message: "keep 5: fine" }]);
    expect(body).not.toHaveProperty("extra");
  });
  it("answers the company's repeats with the counts only and passes a refusal through", async () => {
    const answer = (await call("GET", "/lessons/repeats?month=2026-11")).body;
    expect(answer).toMatchObject({ scope: "company", month: "2026-11" });
    expect((await call("GET", "/lessons/repeats?month=2026-13")).status).toBe(400);
  });
  it("keeps a trial offer only when its three counts are whole numbers", () => {
    expect(modeOf({ mode: "suggest", trialOffer: { approvals: 12, drops: 1, since: 123 } }, "web")).toHaveProperty("trialOffer", { approvals: 12, drops: 1, since: 123 });
    for (const trialOffer of [{ approvals: 1.5, drops: 0, since: 3 }, { approvals: -1, drops: 0, since: 3 }, { approvals: 1, drops: 0, since: "3" }]) expect(modeOf({ mode: "suggest", trialOffer }, "web")).not.toHaveProperty("trialOffer");
  });
});
