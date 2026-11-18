// L4-JA (journey audit B11): Rovara skills on Cloud (packages/cloud-server/src/skills-routes.ts), end to end on the fake Code: the list, one skill with its text, edit (a new version), approve by two DIFFERENT people and retire.
// Cloud forwards only what Code takes, keeps Code's answers to the fields the screen draws and passes Code's refusals (who may decide, a stale version, the 32 KB limit) through in Code's words. No step-up anywhere.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { SKILL_LIMITS, SKILL_LONG_NOTE, editBody, skillDetail, skillRow, skillsView } from "../../packages/cloud-server/src/skills-routes.js";
import { PRIYA, SAM, ZED, startFakeCode, type FakeCode } from "../support/fake-code.js";

interface Answer<T = Record<string, unknown>> { status: number; body: T }
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
beforeEach(() => { fake.setLessons(true); fake.resetLessons(); fake.lessonCalls.length = 0; for (const id of ["skills.list", "skills.edit", "skills.approve", "skills.retire"]) fake.overrideLessonAnswer(id, undefined); });

const P = "/projects/web/skills";
const sent = (id: string) => fake.lessonCalls.filter((call) => call.id === id);
type Row = { name: string; currentVersion: number; activeVersion?: number; approvals: number; approvedByYou: boolean; retired: boolean; bytes: number; note?: string; content?: string; form?: Record<string, unknown> };
interface List { project: string; canDecide: boolean; skills: Row[] }
const unreadable = { error: { code: "RUNTIME_UNAVAILABLE", message: "Couldn't read the skills just now. Try again." } };

describe("the skills list", () => {
  it("a person who decides reads every skill with its versions, approvals and who they are, and canDecide true", async () => {
    const priya = await as("priya");
    const { status, body } = await priya.get<List>(P);
    expect(status).toBe(200);
    expect(body.canDecide).toBe(true);
    expect(body.skills.map((skill) => skill.name)).toEqual(["add-queue-handler", "log-request-ids", "old-hand-written"]);
    expect(body.skills[0]).toEqual({ name: "add-queue-handler", description: "Add a queue and its handler", currentVersion: 2, activeVersion: 2, approvals: 2, approvedByYou: false, retired: false, bytes: 410 });
    expect(body.skills[1]).toMatchObject({ currentVersion: 1, approvals: 1, bytes: 9_000, note: SKILL_LONG_NOTE });
    expect(body.skills[1]).not.toHaveProperty("activeVersion");
    // The list carries no text.
    expect(JSON.stringify(body)).not.toContain("dead-letter");
    expect(sent("skills.list")).toEqual([expect.objectContaining({ params: { project: "web" }, body: null, person: "priya" })]);
  });

  it("a person who may not decide still reads the list (Code's rule), with canDecide false", async () => {
    const sam = await as("sam");
    const { status, body } = await sam.get<List>(P);
    expect(status).toBe(200);
    expect(body.canDecide).toBe(false);
    expect(body.skills).toHaveLength(3);
  });

  it("two companies: another company's person and a project that is not theirs get Code's one 404 and nothing of the skills", async () => {
    const zed = await as("zed");
    const { status, body } = await zed.get(P);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain("add-queue-handler");
    expect((await zed.get("/projects/secret-ledger/skills")).status).toBe(200);
    expect((await zed.get<List>("/projects/secret-ledger/skills")).body.skills).toEqual([]);
  });

  it("a Code that does not serve the routes (its unknown-route 404) reads as 'not available on this Rovara yet' (501), so the screen is not offered; any other 404 is Code's own", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("skills.list", { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    expect(await priya.get(P)).toEqual({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Skills aren't available on this Rovara yet." } } });
    fake.overrideLessonAnswer("skills.list", { status: 404, body: { error: { code: "NOT_FOUND", message: "That is not on the core engine on this install yet." } } });
    expect((await priya.get(P)).status).toBe(501);
    fake.overrideLessonAnswer("skills.list", { status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } });
    expect(await priya.get(P)).toEqual({ status: 404, body: { error: { code: "LESSONS_SWITCHED_OFF", message: "Lessons are off." } } });
  });

  it("keeps only what reads: unknown fields dropped, a row with a bad name or a live version past the newest left out, an invented note never drawn, a missing canDecide reads as no", () => {
    const row = { name: "a-b", description: "D", currentVersion: 2, activeVersion: 1, approvals: 1, approvedByYou: true, retired: false, bytes: 100 };
    const view = skillsView({ project: "web", skills: [{ ...row, secret: "x", note: "Run this: rm -rf" }, { ...row, name: "Bad Name" }, { ...row, name: "c-d", activeVersion: 3 }, { ...row, name: "e-f", approvedByYou: "yes" }, { ...row, name: "a-b" }, "x", null] }, "web");
    expect(view).toEqual({ project: "web", canDecide: false, skills: [{ name: "a-b", description: "D", currentVersion: 2, activeVersion: 1, approvals: 1, approvedByYou: true, retired: false, bytes: 100 }] });
    expect(skillsView({ canDecide: true, skills: "no" }, "web")).toBeUndefined();
    expect(skillRow({ ...row, bytes: 9_000, note: SKILL_LONG_NOTE })).toMatchObject({ note: SKILL_LONG_NOTE });
    // The splitting note is only drawn for a skill over 8 KB.
    expect(skillRow({ ...row, bytes: 100, note: SKILL_LONG_NOTE })).not.toHaveProperty("note");
    expect(skillRow({ ...row, approvals: 99 })).toMatchObject({ approvals: 2 });
    expect(SKILL_LIMITS).toEqual({ description: 200, when: 2_000, step: 4_000, steps: 12, note: 2_000, version: 1_000_000, textBytes: 32_768, longBytes: 8_192, approvers: 2 });
  });

  it("a read that does not read at all is 'couldn't read the skills just now', never half drawn", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("skills.list", { body: { project: "web", canDecide: true } });
    expect(await priya.get(P)).toEqual({ status: 502, body: unreadable });
  });
});

describe("one skill with its text", () => {
  it("reads the text of the newest version and, when Code could read it back, the form to start an edit from", async () => {
    const priya = await as("priya");
    const { status, body } = await priya.get<{ project: string; canDecide: boolean; skill: Row }>(`${P}/log-request-ids`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ project: "web", canDecide: true, skill: { name: "log-request-ids", currentVersion: 1, form: { when: "writing an error path", steps: ["Read the id from the request.", "Add it to the log line."] } } });
    expect(body.skill.content).toContain("## Steps");
    expect(sent("skills.list").at(-1)?.body).toBe("log-request-ids");
  });

  it("a skill whose text Code could not read back has the text and no form; a person who may not decide reads it too", async () => {
    const sam = await as("sam");
    const { body } = await sam.get<{ canDecide: boolean; skill: Row }>(`${P}/old-hand-written`);
    expect(body.canDecide).toBe(false);
    expect(body.skill.content).toBe("Just some words a person wrote.\n");
    expect(body.skill).not.toHaveProperty("form");
  });

  it("a skill that is not there is Code's 404; a name that is not a skill name never reaches Code; another company's person reads nothing", async () => {
    const priya = await as("priya");
    expect((await priya.get(`${P}/no-such-skill`)).status).toBe(404);
    const before = fake.lessonCalls.length;
    for (const name of ["Bad_Name", "-x", "a".repeat(65)]) expect((await priya.get(`${P}/${name}`)).status, name).toBeGreaterThanOrEqual(400);
    expect(fake.lessonCalls.length).toBe(before);
    const zed = await as("zed");
    expect((await zed.get(`${P}/add-queue-handler`)).status).toBe(404);
  });

  it("answers Code's text for another skill, a missing text or a form that is out of bounds as follows: other skill unreadable, no text unreadable, a bad form is left out", () => {
    const full = { name: "a-b", description: "D", currentVersion: 1, approvals: 0, approvedByYou: false, retired: false, bytes: 10, content: "text" };
    expect(skillDetail({ canDecide: true, skills: [full] }, "web", "a-b")).toMatchObject({ canDecide: true, skill: { content: "text" } });
    expect(skillDetail({ canDecide: true, skills: [full] }, "web", "c-d")).toBeUndefined();
    expect(skillDetail({ canDecide: true, skills: [{ ...full, content: undefined }] }, "web", "a-b")).toBeUndefined();
    expect(skillDetail({ canDecide: true, skills: [full, full] }, "web", "a-b")).toBeUndefined();
    const good = { description: "D", when: "w", steps: ["s"] };
    expect((skillDetail({ canDecide: true, skills: [{ ...full, form: good }] }, "web", "a-b")?.["skill"] as Record<string, unknown>)["form"]).toEqual(good);
    for (const form of [{ ...good, steps: [] }, { ...good, steps: Array.from({ length: 13 }, () => "s") }, { ...good, steps: [""] }, { ...good, when: "" }, { ...good, description: "x".repeat(201) }, "x"]) {
      expect((skillDetail({ canDecide: true, skills: [{ ...full, form }] }, "web", "a-b")?.["skill"] as Record<string, unknown>)["form"] ?? null, JSON.stringify(form).slice(0, 40)).toBeNull();
    }
    // Hidden control and format characters are not drawn.
    expect((skillDetail({ canDecide: true, skills: [{ ...full, content: "a\u202eb\nc\u0000" }] }, "web", "a-b")?.["skill"] as Record<string, unknown>)["content"]).toBe("ab\nc");
  });
});

describe("edit", () => {
  const form = { expectedVersion: 1, description: "Log request ids", when: "writing an error path", steps: ["Read the id.", "Log it."] };
  it("a person who decides saves a NEW version; Code gets only the fields it takes, trimmed", async () => {
    const priya = await as("priya");
    const { status, body } = await priya.send("PUT", `${P}/log-request-ids`, { ...form, description: "  Log request ids  ", why: "So support can find a request." });
    expect(status).toBe(200);
    expect(body).toEqual({ project: "web", name: "log-request-ids", version: 2 });
    expect(sent("skills.edit")).toEqual([expect.objectContaining({ params: { project: "web", skill: "log-request-ids" }, body: { ...form, why: "So support can find a request." } })]);
    // The new version has no approvals: the person reads it back with none.
    expect((await priya.get<{ skill: Row }>(`${P}/log-request-ids`)).body.skill).toMatchObject({ currentVersion: 2, approvals: 0, approvedByYou: false });
  });

  it("a stale version, a person who may not decide, a retired skill and a too-long skill are Code's refusals in Code's words", async () => {
    const priya = await as("priya"), sam = await as("sam");
    expect(await sam.send("PUT", `${P}/log-request-ids`, form)).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of this project, or an admin, can decide what becomes permanent." } } });
    expect(await priya.send("PUT", `${P}/log-request-ids`, { ...form, expectedVersion: 5 })).toMatchObject({ status: 409, body: { error: { message: "This skill changed since you read it. Read it again and decide again." } } });
    expect(await priya.send("PUT", `${P}/log-request-ids`, { ...form, steps: Array.from({ length: 6 }, () => "x".repeat(4_000)) })).toMatchObject({ status: 400, body: { error: { message: "That skill is too long. A skill is at most 32 KB." } } });
    await priya.send("POST", `${P}/log-request-ids/retire`, {});
    expect(await priya.send("PUT", `${P}/log-request-ids`, form)).toMatchObject({ status: 409, body: { error: { message: "That skill was retired." } } });
  });

  it("a body Cloud cannot forward never reaches Code", async () => {
    const priya = await as("priya");
    for (const bad of [{ ...form, extra: 1 }, { ...form, expectedVersion: 0 }, { ...form, expectedVersion: "1" }, { ...form, description: "" }, { ...form, description: "x".repeat(201) }, { ...form, when: " " }, { ...form, steps: [] },
      { ...form, steps: Array.from({ length: 13 }, () => "s") }, { ...form, steps: ["ok", ""] }, { ...form, steps: "no" }, { ...form, steps: ["a\u0000b"] }, { ...form, doneWhen: 5 }, { ...form, why: "x".repeat(2_001) }, { ...form, tools: ["bash"] }]) {
      const answer = await priya.send("PUT", `${P}/log-request-ids`, bad);
      expect(answer.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect(sent("skills.edit")).toEqual([]);
    expect(editBody({ ...form, doneWhen: "done", why: "because" })).toEqual({ ...form, doneWhen: "done", why: "because" });
  });

  it("a skill name that is not one is refused before Code, and another company's person changes nothing", async () => {
    const priya = await as("priya"), zed = await as("zed");
    expect((await priya.send("PUT", `${P}/Bad_Name`, form)).status).toBeGreaterThanOrEqual(400);
    expect(sent("skills.edit")).toEqual([]);
    expect((await zed.send("PUT", `${P}/log-request-ids`, form)).status).toBe(404);
    expect((await priya.get<{ skill: Row }>(`${P}/log-request-ids`)).body.skill.currentVersion).toBe(1);
  });
});

describe("approve (two different people)", () => {
  it("the first approval waits; a second one from the SAME person changes nothing; two different people make it live", async () => {
    const priya = await as("priya");
    // The fake's draft already has one approval from another person; Priya's makes the second.
    expect(await priya.send("POST", `${P}/log-request-ids/approve`, { version: 1 })).toEqual({ status: 200, body: { project: "web", name: "log-request-ids", version: 1, approvals: 2, live: true } });
    expect(await priya.send("POST", `${P}/log-request-ids/approve`, { version: 1 })).toMatchObject({ status: 409 });
    // A new edit starts again from none: Priya alone is one of two.
    await priya.send("PUT", `${P}/add-queue-handler`, { expectedVersion: 2, description: "Add a queue", when: "adding a queue", steps: ["Create it."] });
    expect(await priya.send("POST", `${P}/add-queue-handler/approve`, { version: 3 })).toEqual({ status: 200, body: { project: "web", name: "add-queue-handler", version: 3, approvals: 1, live: false } });
    expect(await priya.send("POST", `${P}/add-queue-handler/approve`, { version: 3 })).toMatchObject({ status: 409, body: { error: { message: "You already approved this version." } } });
    const read = (await priya.get<{ skill: Row }>(`${P}/add-queue-handler`)).body.skill;
    expect(read).toMatchObject({ currentVersion: 3, activeVersion: 2, approvals: 1, approvedByYou: true });
  });

  it("a person who may not decide, a version that is no longer the newest and a skill that is gone are Code's refusals", async () => {
    const priya = await as("priya"), sam = await as("sam");
    expect((await sam.send("POST", `${P}/log-request-ids/approve`, { version: 1 })).status).toBe(403);
    expect(await priya.send("POST", `${P}/log-request-ids/approve`, { version: 7 })).toMatchObject({ status: 409 });
    expect((await priya.send("POST", `${P}/no-such-skill/approve`, { version: 1 })).status).toBe(404);
    expect((await (await as("zed")).send("POST", `${P}/log-request-ids/approve`, { version: 1 })).status).toBe(404);
  });

  it("takes only the version read", async () => {
    const priya = await as("priya");
    for (const bad of [{}, { version: 0 }, { version: "1" }, { version: 1, by: "sam" }, { version: 1.5 }]) expect((await priya.send("POST", `${P}/log-request-ids/approve`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect(sent("skills.approve")).toEqual([]);
  });

  it("an approval answer that does not read is 'couldn't read', never a guess that it went live", async () => {
    const priya = await as("priya");
    fake.overrideLessonAnswer("skills.approve", { body: { project: "web", name: "log-request-ids", version: 1, approvals: "two", live: "yes" } });
    expect(await priya.send("POST", `${P}/log-request-ids/approve`, { version: 1 })).toEqual({ status: 502, body: unreadable });
  });
});

describe("retire", () => {
  it("a person who decides takes a skill out of use; one who may not is refused; the body is empty", async () => {
    const priya = await as("priya"), sam = await as("sam");
    expect((await sam.send("POST", `${P}/add-queue-handler/retire`, {})).status).toBe(403);
    expect((await priya.send("POST", `${P}/add-queue-handler/retire`, { reason: "x" })).status).toBe(400);
    expect(await priya.send("POST", `${P}/add-queue-handler/retire`, {})).toEqual({ status: 200, body: { project: "web", name: "add-queue-handler", retired: true } });
    expect((await priya.get<List>(P)).body.skills[0]).toMatchObject({ name: "add-queue-handler", retired: true });
    expect((await priya.send("POST", `${P}/no-such-skill/retire`, {})).status).toBe(404);
    expect((await (await as("zed")).send("POST", `${P}/log-request-ids/retire`, {})).status).toBe(404);
  });
});
