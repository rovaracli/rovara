// L4-MF1: the project page's saved environment panel read and the start preview, through Cloud's handler.
// - GET /v1/app/projects/{p}/environment-image is forwarded to Code's own route of the same path as the signed-in person; Code decides who may read. Cloud forwards nothing of the browser's query,
//   refuses a name Code never takes before asking, keeps only the panel's own fields (anything off refuses the whole answer), words Code's "off" and "project not found" 404s in fixed words, and turns
//   "Code does not serve it yet" into 501 NOT_ON_CODE_YET.
// - POST /v1/app/projects/{p}/start-preview is answered here: `unknown`, for a project the person may use, with the company Code's access check names.
// The fake applies Code's rule: anyone who may not read the project, or another company's, gets the one 404.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { SAVED_ENV_ANSWERS, SAVED_ENV_FAILURES, SAVED_ENV_PANEL_FIELDS, SAVED_ENV_REBUILD_REASONS, savedEnvPanel } from "../../packages/cloud-server/src/saved-env-routes.js";
import { SAVED_ENV_PANEL_FAILURES, SAVED_ENV_PANEL_REBUILD_REASONS, SavedEnvPanelSchema } from "../../packages/contracts/src/app-saved-env.js";
import { TaskStopStartPreviewSchema } from "../../packages/contracts/src/task-stop-start-preview.js";
import { PRIYA, SAM, ZED, startFakeCode, type FakeCode, type Person } from "../support/fake-code.js";

interface Answer { status: number; body: Record<string, unknown> }
interface Session { read: (target: string) => Promise<Answer>; post: (target: string, body?: unknown) => Promise<Answer> }
let fake: FakeCode;
let signInAs: (person: Person) => Promise<Session>;
const mode = async (project: string, value: string) => { await fetch(`${fake.url}/__fake/saved-env`, { method: "POST", body: JSON.stringify({ project, mode: value }) }); };
const codeCalls = () => fake.log.filter((entry) => entry.path.endsWith("/environment-image"));
const NEVER = { health: "never_proved", canReset: false, enabled: true, canChangeSetting: false };

beforeAll(async () => {
  fake = await startFakeCode();
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const send = async (method: string, target: string, headers: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const answer = await handler(request);
    return { status: answer!.status, headers: answer!.headers, body: answer!.body === "" ? undefined : JSON.parse(answer!.body) as unknown };
  };
  signInAs = async (person) => {
    fake.setPerson(person);
    const start = await send("GET", "/v1/auth/browser/authorize?return_to=/app");
    const toCode = await fetch(start.headers["location"]!, { redirect: "manual" });
    const back = new URL(toCode.headers.get("location")!);
    const finished = await send("GET", `${back.pathname}${back.search}`);
    const cookie = finished.headers["set-cookie"]!.split(";")[0]!;
    const csrf = ((await send("GET", "/v1/web/me", { cookie })).body as { csrf: string }).csrf;
    return {
      read: async (target) => { const answer = await send("GET", `/v1/web${target}`, { cookie }); return { status: answer.status, body: answer.body as Record<string, unknown> }; },
      post: async (target, body = {}) => { const answer = await send("POST", `/v1/web${target}`, { cookie, "x-rovara-csrf": csrf, "content-type": "application/json" }, body); return { status: answer.status, body: answer.body as Record<string, unknown> }; },
    };
  };
});
afterAll(async () => { await fake.close(); });

describe("the saved environment panel through Cloud", () => {
  it("hosted Code today (saved environments off): Code's honest 404 reaches the app as the same 404 in fixed words, never data", async () => {
    const priya = await signInAs(PRIYA);
    const answer = await priya.read("/projects/web/environment-image");
    expect(answer).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "Saved environments are off for this install" } } });
    expect(answer.body).toEqual(SAVED_ENV_ANSWERS.off.body);
  });

  it("forwards to Code's own route as the person, with none of the browser's query, and keeps only the panel's own fields", async () => {
    await mode("web", "healthy");
    const priya = await signInAs(PRIYA);
    const before = codeCalls().length;
    const answer = await priya.read("/projects/web/environment-image?company=org_bbbbbbbbbbbbbbbbbbbb&project=secret-ledger&reset=1");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ health: "healthy", image: { builtAt: "2026-11-16T10:00:00.000Z", ageDays: 1, status: "ready" }, canReset: false, enabled: true, canChangeSetting: false });
    expect(SavedEnvPanelSchema.safeParse(answer.body).success).toBe(true);
    expect(codeCalls().slice(before).map((entry) => `${entry.method} ${entry.path}${entry.query}`)).toEqual(["GET /v1/app/projects/web/environment-image"]);
    await mode("web", "off");
  });

  it("never started saved environments on: never_proved with no image", async () => {
    await mode("web", "never");
    const answer = await (await signInAs(PRIYA)).read("/projects/web/environment-image");
    expect(answer).toEqual({ status: 200, body: NEVER });
    await mode("web", "off");
  });

  it("answers Code's 404 for a project the person may not read, and for another company's project, the same for both (even while the switch is off)", async () => {
    const sam = await signInAs(SAM);
    await mode("web", "never");
    expect((await sam.read("/projects/web/environment-image")).status).toBe(200);
    const noGrant = await sam.read("/projects/api/environment-image");
    expect(noGrant).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    const priya = await signInAs(PRIYA);
    expect(await priya.read("/projects/secret-ledger/environment-image")).toEqual(noGrant);
    const zed = await signInAs(ZED);
    expect(await zed.read("/projects/web/environment-image")).toEqual(noGrant);
    // the other company's own person reads their own project (Code's answer for it, here: off) and never the first company's rows
    expect((await zed.read("/projects/secret-ledger/environment-image")).body).toEqual(SAVED_ENV_ANSWERS.off.body);
    await mode("web", "off");
  });

  it.each(["route-missing", "core-off", "501"])("answers 501 NOT_ON_CODE_YET in fixed words while Code does not serve the route (%s)", async (value) => {
    await mode("api", value);
    const priya = await signInAs(PRIYA);
    const answer = await priya.read("/projects/api/environment-image");
    expect(answer).toEqual({ status: SAVED_ENV_ANSWERS.notYet.status, body: SAVED_ENV_ANSWERS.notYet.body });
    expect(JSON.stringify(answer.body)).not.toContain("/v1/");
    await mode("api", "off");
  });

  it("refuses an answer that does not read, or carries a field this file does not know, whole", async () => {
    const priya = await signInAs(PRIYA);
    for (const value of ["broken", "extra-field"]) {
      await mode("web", value);
      expect(await priya.read("/projects/web/environment-image")).toEqual({ status: 502, body: SAVED_ENV_ANSWERS.unreadable.body });
    }
    await mode("web", "off");
  });

  it("refuses a name Code never takes without asking Code, and never echoes it", async () => {
    const priya = await signInAs(PRIYA);
    const before = codeCalls().length;
    for (const name of ["-web", "we%20b", "a".repeat(101), "web%2Fapi"]) {
      const answer = await priya.read(`/projects/${name}/environment-image`);
      expect(answer).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    }
    expect(codeCalls().length).toBe(before);
  });

  it("serves only the read: no Reset and no setting through Cloud (501, never sent to Code)", async () => {
    const priya = await signInAs(PRIYA);
    const before = codeCalls().length;
    expect((await priya.post("/projects/web/environment-image", { action: "reset", requestId: "abcdefgh12" })).status).toBe(501);
    expect(codeCalls().length).toBe(before);
  });
});

describe("the start preview through Cloud", () => {
  it("answers unknown, for a project the person may use, with the company Code names", async () => {
    const priya = await signInAs(PRIYA);
    const answer = await priya.post("/projects/web/start-preview", {});
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ project: "web", kind: "unknown" });
    expect(Object.keys(answer.body).sort()).toEqual(["kind", "orgId", "project", "requestId"].sort().filter((key) => key in answer.body));
    expect(TaskStopStartPreviewSchema.safeParse({ orgId: answer.body["orgId"], project: "web", kind: "unknown" }).success).toBe(true);
    // the company is Code's, per person
    const zed = await signInAs(ZED);
    const other = await zed.post("/projects/secret-ledger/start-preview", {});
    expect(other.status).toBe(200);
    expect(other.body["orgId"]).not.toBe(answer.body["orgId"]);
    expect(other.body["project"]).toBe("secret-ledger");
  });

  it("answers the one 404 for a project the person cannot use, another company's included, and calls Code only for the access check", async () => {
    const sam = await signInAs(SAM);
    const missing = { status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "That project doesn't exist, or you can't use it." } } };
    expect(await sam.post("/projects/api/start-preview", {})).toEqual(missing);
    expect(await sam.post("/projects/secret-ledger/start-preview", {})).toEqual(missing);
    expect(await sam.post("/projects/nothere/start-preview", {})).toEqual(missing);
    const zed = await signInAs(ZED);
    expect(await zed.post("/projects/web/start-preview", {})).toEqual(missing);
  });

  it("takes {} (and a request id or a path word), refuses any other body and a name Cloud never takes, and says nothing of the browser's input", async () => {
    const priya = await signInAs(PRIYA);
    const ok = await priya.post("/projects/web/start-preview", { requestId: "11111111-1111-4111-8111-111111111111", path: "QUICK" });
    expect(ok.status).toBe(200);
    for (const body of [{ company: "org_bbbbbbbbbbbbbbbbbbbb" }, { requestId: "not-a-uuid" }, { path: "SLOW" }, [], "x"]) {
      const refused = await priya.post("/projects/web/start-preview", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain("org_bbbb");
    }
    expect((await priya.post("/projects/Web/start-preview", {})).status).toBe(404);
  });
});

describe("the parts", () => {
  it("names exactly the contract panel's top-level fields, reasons and failure words", () => {
    expect([...SAVED_ENV_PANEL_FIELDS].sort()).toEqual(Object.keys(SavedEnvPanelSchema.shape).sort());
    expect([...SAVED_ENV_REBUILD_REASONS]).toEqual([...SAVED_ENV_PANEL_REBUILD_REASONS]);
    expect([...SAVED_ENV_FAILURES]).toEqual([...SAVED_ENV_PANEL_FAILURES]);
  });

  it("keeps a panel only when every field reads", () => {
    const good = { health: "needs_repair", image: { builtAt: "2026-11-16T10:00:00.000Z", ageDays: 2, status: "stale" }, rebuild: { state: "queued", reason: "reset" }, lastRebuildReason: "max_age", lastFailure: { at: "2026-11-16T11:00:00Z", reason: "build_failed" }, canReset: false, enabled: false, canChangeSetting: false };
    expect(savedEnvPanel(good)).toEqual(good);
    expect(savedEnvPanel({ health: "healthy", canReset: true })).toEqual({ health: "healthy", canReset: true });
    for (const broken of [
      { health: "great" }, { canReset: "no" }, { canReset: undefined }, { enabled: 1 }, { canChangeSetting: "x" }, { digest: "sha256:abc" },
      { image: { builtAt: "yesterday", ageDays: 2, status: "ready" } }, { image: { builtAt: "2026-11-16T10:00:00Z", ageDays: -1, status: "ready" } }, { image: { builtAt: "2026-11-16T10:00:00Z", ageDays: 1.5, status: "ready" } },
      { image: { builtAt: "2026-11-16T10:00:00Z", ageDays: 1, status: "gone" } }, { image: { builtAt: "2026-11-16T10:00:00Z", ageDays: 1, status: "ready", tag: "k" } },
      { rebuild: { state: "done", reason: "reset" } }, { rebuild: { state: "queued", reason: "because" } }, { lastRebuildReason: "free text" },
      { lastFailure: { at: "2026-11-16T11:00:00Z", reason: "the build log said /secret/path" } }, { lastFailure: { at: "now", reason: "failed" } },
    ]) expect(savedEnvPanel({ health: "healthy", canReset: false, ...broken }), JSON.stringify(broken)).toBeUndefined();
    for (const notAnObject of [undefined, null, [], "healthy", 3]) expect(savedEnvPanel(notAnObject)).toBeUndefined();
  });

});
