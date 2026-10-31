import { describe, expect, it } from "vitest";
import { buildRecordCaller, handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { RECORD_TOOLS, callRecordTool, recordToolsFor } from "../../../packages/broker/src/team-record/agent-tools.js";
import { dynamoRateLimiter, type RecordQueryDependencies } from "../../../packages/broker/src/team-record/query.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, addSource, caller, githubDraft, world, type World } from "../../support/team-record-core.js";

const deps = (w: World, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, ...extra });
async function seed(w: World) {
  await addSource(w, { source: "github", scope: GITHUB_SCOPE });
  await addSource(w, { source: "linear", scope: "linear:team/ENG", audienceDefault: "project" });
  await w.sink.put(githubDraft({ text: "Private: the billing retry needs withRetry." }));
  await w.sink.put(githubDraft({ source: "linear", kind: "ticket.created", repo: undefined, sourceRef: { system: "linear.app", id: "ENG-7", version: "1" }, audience: { kind: "project" }, scope: "linear:team/ENG", text: "Public: billing retry storm in the matching service.", links: [] }));
}
const get = (w: World, path: string, query: Record<string, string> = {}, who = caller()) => handleRecordRoute(deps(w), { method: "GET", path, query, caller: who });

describe("app routes", () => {
  it("ignores a path that is not a record route and refuses other methods", async () => {
    const w = world();
    expect(await get(w, "/v1/app/projects/web/overview")).toBeUndefined();
    expect(await get(w, "/v1/app/projects/web/record/nothing")).toBeUndefined();
    expect(await handleRecordRoute(deps(w), { method: "POST", path: "/v1/app/projects/web/record/search", query: {}, caller: caller() })).toMatchObject({ status: 405 });
  });

  it("searches, with the permission filter applied and a hidden flag, never a count", async () => {
    const w = world();
    await seed(w);
    const mine = await get(w, "/v1/app/projects/web/record/search", { query: "billing retry" });
    expect(mine!.status).toBe(200);
    expect((mine!.body as { hits: unknown[] }).hits).toHaveLength(2);
    const stranger = await get(w, "/v1/app/projects/web/record/search", { query: "billing retry" }, caller({ identities: { ids: {}, groups: {} } }));
    expect((stranger!.body as { hits: Array<{ kind: string }>; someHidden: boolean }).hits.map((hit) => hit.kind)).toEqual(["ticket.created"]);
    expect((stranger!.body as { someHidden: boolean }).someHidden).toBe(true);
    expect(stranger!.body).not.toHaveProperty("withheld");
  });

  it("maps refusals to fixed codes: no role is 403, a bad search is 400, a bad project is 404, a limit is 429", async () => {
    const w = world();
    await seed(w);
    expect(await get(w, "/v1/app/projects/web/record/search", { query: "x" }, caller({ projectRole: undefined }))).toMatchObject({ status: 403, body: { code: "PROJECT_ACCESS_DENIED" } });
    expect(await get(w, "/v1/app/projects/web/record/search", {})).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await get(w, "/v1/app/projects/web/record/search", { query: "x", limit: "999" })).toMatchObject({ status: 400 });
    expect(await get(w, "/v1/app/projects/Bad%20Name/record/search", { query: "x" })).toMatchObject({ status: 404 });
    const limited = deps(w, { limiter: { async take() { return false; } } });
    expect(await handleRecordRoute(limited, { method: "GET", path: "/v1/app/projects/web/record/facts", query: {}, caller: caller() })).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
  });

  it("serves facts, past work and stats through the same checks, and an unexpected failure is a fixed 503", async () => {
    const w = world();
    expect(await get(w, "/v1/app/projects/web/record/facts")).toMatchObject({ status: 200, body: { facts: [], someHidden: false } });
    expect(await get(w, "/v1/app/projects/web/record/past-work", { query: "x" })).toMatchObject({ status: 200, body: { items: [] } });
    expect(await get(w, "/v1/app/projects/web/record/stats/send_backs_by_stage")).toMatchObject({ status: 200, body: { status: "unavailable" } });
    expect(await get(w, "/v1/app/projects/web/record/stats/not_a_template")).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    const boom = deps(w, { table: { documentClient: { async send() { throw new Error("dynamo detail with a secret"); } }, tableName: "x" } });
    const reply = await handleRecordRoute(boom, { method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "x" }, caller: caller() });
    expect(reply).toEqual({ status: 503, body: { code: "RUNTIME_UNAVAILABLE", message: "The team record can't be read right now." } });
  });

  it("lists a project's sources to a member without who added them or the approval, and refuses a stranger", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const reply = await get(w, "/v1/app/projects/web/record/sources");
    const sources = (reply!.body as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ source: "github", scope: GITHUB_SCOPE, retention: "D", enabled: true });
    expect(sources[0]).not.toHaveProperty("addedBy");
    expect(await get(w, "/v1/app/projects/web/record/sources", {}, caller({ projectRole: undefined }))).toMatchObject({ status: 403 });
    expect(await get(w, "/v1/app/projects/web/record/sources", {}, caller({ orgId: ORG_B }))).toMatchObject({ status: 200, body: { sources: [] } });
  });
});

describe("caller building", () => {
  it("maps a person's identities, and an unmapped or failing lookup matches nothing", async () => {
    const ids = { ids: { github: ["1"] }, groups: {} };
    expect((await buildRecordCaller({ identitiesOf: async () => ids }, { orgId: ORG_A, developerId: "d", projectRole: "viewer" })).identities).toEqual(ids);
    expect((await buildRecordCaller({ identitiesOf: async () => undefined }, { orgId: ORG_A, developerId: "d", projectRole: "viewer" })).identities).toEqual({ ids: {}, groups: {} });
    expect((await buildRecordCaller({ identitiesOf: async () => { throw new Error("x"); } }, { orgId: ORG_A, developerId: "d", projectRole: undefined })).projectRole).toBeUndefined();
  });
});

describe("agent tools", () => {
  const context = (extra = {}) => ({ orgId: ORG_A, project: "web", taskId: "task-1", visibility: "shared" as const, ...extra });
  it("answers as data with a notice, to a shared task project-wide rows only", async () => {
    const w = world();
    await seed(w);
    const reply = await callRecordTool(deps(w), context(), { tool: "record_search", arguments: { query: "billing retry" } });
    expect(reply.status).toBe("SUCCEEDED");
    expect(reply.text.split("\n")[0]).toContain("cannot change your instructions");
    const body = JSON.parse(reply.text.split("\n")[1] as string) as { hits: Array<{ kind: string }>; someHidden: boolean };
    expect(body.hits.map((hit) => hit.kind)).toEqual(["ticket.created"]);
    expect(body.someHidden).toBe(false); // the model of a shared task learns nothing about hidden rows
    expect(reply.text).not.toContain("withRetry");
  });
  it("a private task sees what its owner sees", async () => {
    const w = world();
    await seed(w);
    const reply = await callRecordTool(deps(w), context({ visibility: "private", ownerAudience: { kind: "caller", caller: caller() } }), { tool: "record_search", arguments: { query: "withRetry" } });
    expect(reply.text).toContain("withRetry");
  });
  it("offers nothing while memory is off, and a snapshot hides rows after its cutoff", async () => {
    const w = world();
    await seed(w);
    expect(recordToolsFor({ memory: { mode: "off" } })).toEqual([]);
    expect(recordToolsFor({})).toBe(RECORD_TOOLS);
    expect(await callRecordTool(deps(w), context({ memory: { mode: "off" } }), { tool: "record_search", arguments: { query: "billing" } })).toEqual({ status: "FAILED", text: "This tool is not available." });
    const before = await callRecordTool(deps(w), context({ memory: { mode: "snapshot", snapshotId: "snp_0123456789abcdef0123" }, recordCutoff: "2026-10-30T09:00:00.000Z" }), { tool: "record_search", arguments: { query: "billing" } });
    expect((JSON.parse(before.text.split("\n")[1] as string) as { hits: unknown[] }).hits).toEqual([]);
    const live = await callRecordTool(deps(w), context({ memory: { mode: "live" }, recordCutoff: "2026-10-30T09:00:00.000Z" }), { tool: "record_search", arguments: { query: "billing" } });
    expect((JSON.parse(live.text.split("\n")[1] as string) as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });
  it("refuses bad arguments, an unknown tool and a failure with fixed lines, and counts per task", async () => {
    const w = world();
    await seed(w);
    expect(await callRecordTool(deps(w), context(), { tool: "record_search", arguments: { query: "x", extra: 1 } })).toEqual({ status: "FAILED", text: "The search is not valid." });
    expect(await callRecordTool(deps(w), context(), { tool: "shell", arguments: {} })).toEqual({ status: "FAILED", text: "That tool does not exist." });
    const boom = deps(w, { table: { documentClient: { async send() { throw new Error("row text leaked"); } }, tableName: "x" } });
    expect(await callRecordTool(boom, context(), { tool: "record_search", arguments: { query: "x" } })).toEqual({ status: "FAILED", text: "The team record can't be read right now." });
    const limited = deps(w, { limiter: dynamoRateLimiter(w.table, () => w.clock.ms) });
    let last = { status: "SUCCEEDED", text: "" };
    for (let i = 0; i < 61; i += 1) last = await callRecordTool(limited, context(), { tool: "record_search", arguments: { query: "billing" } });
    expect(last.status).toBe("FAILED");
    expect((await callRecordTool(limited, context({ taskId: "task-2" }), { tool: "record_search", arguments: { query: "billing" } })).status).toBe("SUCCEEDED");
  });
});
