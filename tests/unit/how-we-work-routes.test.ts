// The project page's How we work tab through Cloud's handler (staging walkthrough 2026-11-17, item 4): Cloud forwards GET /v1/app/projects/{p}/how-we-work to
// Code's own route of the same path, as the signed-in person. Code decides who may read (the fake applies its rule: a grant on THAT project in the project's own
// company, a company administrator reads every project of their company). Cloud must forward nothing of the browser's query, refuse a name Code never takes
// before asking, keep only the view's own fields for THIS project, and turn "Code does not serve it yet" into 501 NOT_ON_CODE_YET in fixed words.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { HOW_WE_WORK_ANSWERS, HOW_WE_WORK_FIELDS, codeNotYet, howWeWorkView } from "../../packages/cloud-server/src/how-we-work-routes.js";
import { HowWeWorkViewSchema } from "../../packages/contracts/src/how-we-work.js";
import { PRIYA, SAM, ZED, startFakeCode, type FakeCode, type Person } from "../support/fake-code.js";

interface Answer { status: number; body: Record<string, unknown> }
let fake: FakeCode;
let signInAs: (person: Person) => Promise<(target: string) => Promise<Answer>>;
const mode = async (project: string, value: string) => { await fetch(`${fake.url}/__fake/how-we-work`, { method: "POST", body: JSON.stringify({ project, mode: value }) }); };
const codeCalls = () => fake.log.filter((entry) => entry.path.endsWith("/how-we-work"));

beforeAll(async () => {
  fake = await startFakeCode();
  const client = new CodeClient({ baseUrl: fake.url, clientId: "rovara-cloud", clientSecret: "fake-secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members projects:create" });
  const handler = createCloudHandler({ client, store: new LocalSessionStore(), work: new LocalWorkSessionStore(), origin: "http://127.0.0.1:8787", org: { orgId: "acme", name: "Acme", plan: "test" }, callbackPath: "/callback", secureCookies: false, log: () => undefined });
  const send = async (method: string, target: string, cookie?: string) => {
    const url = new URL(target, "http://127.0.0.1:8787");
    const request: CloudRequest = { method, path: url.pathname, query: url.searchParams, headers: cookie === undefined ? {} : { cookie } };
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
    return async (target: string) => { const answer = await send("GET", `/v1/web${target}`, cookie);return { status: answer.status, body: answer.body as Record<string, unknown> }; };
  };
});
afterAll(async () => { await fake.close(); });

describe("How we work through Cloud", () => {
  it("forwards to Code's own route as the person, with none of the browser's query, and keeps only the view's own fields", async () => {
    const priya = await signInAs(PRIYA);
    const before = codeCalls().length;
    const answer = await priya("/projects/web/how-we-work?company=org_bbbbbbbbbbbbbbbbbbbb&project=secret-ledger&draft=1");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ project: "web", playbookRevision: 3, process: { kind: "builtin", agentId: "rovara-standard" }, stages: [], rules: [], modelsEditable: false });
    expect(HowWeWorkViewSchema.safeParse(answer.body).success).toBe(true);
    expect(codeCalls().slice(before).map((entry) => `${entry.method} ${entry.path}${entry.query}`)).toEqual(["GET /v1/app/projects/web/how-we-work"]);
  });

  it("answers Code's 404 for a project the person has no grant on, and for another company's project, the same for both", async () => {
    const sam = await signInAs(SAM);
    expect((await sam("/projects/web/how-we-work")).status).toBe(200);
    const noGrant = await sam("/projects/api/how-we-work");
    expect(noGrant).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    const priya = await signInAs(PRIYA);
    expect(await priya("/projects/secret-ledger/how-we-work")).toEqual(noGrant);
    const zed = await signInAs(ZED);
    expect(await zed("/projects/web/how-we-work")).toEqual(noGrant);
    expect((await zed("/projects/secret-ledger/how-we-work")).status).toBe(200);
  });

  it.each(["off", "core-off"])("answers 501 NOT_ON_CODE_YET in fixed words while Code does not serve the route (%s)", async (value) => {
    await mode("api", value);
    const priya = await signInAs(PRIYA);
    const answer = await priya("/projects/api/how-we-work");
    expect(answer).toEqual({ status: HOW_WE_WORK_ANSWERS.notYet.status, body: HOW_WE_WORK_ANSWERS.notYet.body });
    expect(JSON.stringify(answer.body)).not.toContain("/v1/");
    await mode("api", "on");
  });

  it("refuses an answer that names another project", async () => {
    await mode("web", "broken");
    const priya = await signInAs(PRIYA);
    expect(await priya("/projects/web/how-we-work")).toEqual({ status: 502, body: HOW_WE_WORK_ANSWERS.unreadable.body });
    await mode("web", "on");
  });

  it("refuses a name Code never takes without asking Code, and never echoes it", async () => {
    const priya = await signInAs(PRIYA);
    const before = codeCalls().length;
    for (const name of ["-web", "we%20b", "a".repeat(101), "web%2Fapi"]) {
      const answer = await priya(`/projects/${name}/how-we-work`);
      expect(answer).toEqual({ status: 404, body: { error: { code: "NOT_FOUND", message: "project not found" } } });
    }
    expect(codeCalls().length).toBe(before);
  });
});

describe("the parts", () => {
  it("names exactly the contract view's top-level fields", () => {
    expect([...HOW_WE_WORK_FIELDS].sort()).toEqual(Object.keys(HowWeWorkViewSchema.shape).sort());
  });
  it("reads only Code's two not-served 404s and a 501 as not yet; every other refusal stays Code's", () => {
    const of = (status: number, message: string) => new CodeError(status, { error: { code: "NOT_FOUND", message } });
    expect(codeNotYet(of(404, "route not found"))).toBe(true);
    expect(codeNotYet(of(404, "That is not on the core engine on this install yet."))).toBe(true);
    expect(codeNotYet(of(501, "anything"))).toBe(true);
    expect(codeNotYet(of(404, "project not found"))).toBe(false);
    expect(codeNotYet(of(403, "route not found"))).toBe(false);
    expect(codeNotYet(new CodeError(404, { error: { code: "FORBIDDEN", message: "route not found" } }))).toBe(false);
    expect(codeNotYet(new CodeError(404, undefined))).toBe(false);
  });
  it("keeps a view only when it names this project", () => {
    expect(howWeWorkView({ project: "web", stages: [], extra: 1 }, "web")).toEqual({ project: "web", stages: [] });
    expect(howWeWorkView({ project: "api" }, "web")).toBeUndefined();
    expect(howWeWorkView([], "web")).toBeUndefined();
    expect(howWeWorkView("web", "web")).toBeUndefined();
  });
});
