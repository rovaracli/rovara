// SRL-4 (owner decision 24b): a Rovara event in the Team record keeps the audience it was written with, but it is ALSO checked against the task's LIVE visibility (Plan 5 shares + People list) every time
// it is read. Narrowing the task hides its old rows; widening it does not widen them; a visibility that cannot be read shows nothing. Intersection: the recorded audience AND the live one.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Audience } from "@agentx/contracts";
import { filterVisible, type Visible } from "../../../packages/broker/src/team-record/acl.js";
import { callRecordTool } from "../../../packages/broker/src/team-record/agent-tools.js";
import { LIVE_TASKS_PER_REQUEST_MAX, createLiveAudienceReader, mayReadTask, rovaraTaskRefsOf, type TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import { pastWork, recordFacts, recordSearch, type PastWorkTask, type RecordQueryDependencies, type RecordVectorSearchPort } from "../../../packages/broker/src/team-record/query.js";
import { eventVectorRef } from "../../../packages/broker/src/team-record/ingest.js";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { audienceOfVisibility, type TaskVisibility } from "../../../packages/broker/src/team-record/sources/rovara.js";
import { eventFromItem, putRecordFact } from "../../../packages/broker/src/team-record/store.js";
import type { ReadAudience } from "../../../packages/broker/src/team-record/types.js";
import { ORG_A, ORG_B, addSource, caller, githubDraft, openAccess, rows, world, type World } from "../../support/team-record-core.js";

const AT = "2026-10-30T10:00:00.000Z";
const OWNER = "dev-owner";
const PEER = "dev-peer";
const OTHER = "dev-other";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SHARED: TaskVisibility = { kind: "shared" };
const PRIVATE: TaskVisibility = { kind: "private", ownerDeveloperId: OWNER };
const WITH_PEER: TaskVisibility = { kind: "shared_with", developerIds: [OWNER, PEER] };

afterEach(() => { vi.useRealTimers(); });

const person = (developerId: string): ReadAudience => ({ kind: "caller", caller: caller({ developerId, identities: { ids: { rovara: [developerId] }, groups: {} } }) });
const shared: ReadAudience = { kind: "shared", orgId: ORG_A };

type Live = Record<string, TaskVisibility | undefined | "throw">;
/** A fake visibility port: the answer is read when `read` is called (so a test narrows a task by changing the map), and every call is remembered. */
function port(live: Live): TaskVisibilityPort & { calls: string[][]; live: Live } {
  const calls: string[][] = [];
  return {
    calls, live,
    async read(_orgId, taskIds) {
      calls.push([...taskIds]);
      if (taskIds.some((id) => live[id] === "throw")) throw new Error("state table down");
      return new Map(taskIds.map((id) => [id, live[id] as TaskVisibility | undefined]));
    },
  };
}

const deps = (w: World, taskVisibility: TaskVisibilityPort | undefined, extra: Partial<RecordQueryDependencies> = {}): RecordQueryDependencies =>
  ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, ...(taskVisibility === undefined ? {} : { taskVisibility }), ...extra });

/** A Rovara note as the emitter writes it: the audience is the task's visibility AT WRITE TIME. */
async function note(w: World, taskId: string, visibility: TaskVisibility, text: string, noteId = "n1"): Promise<void> {
  const outcome = await w.sink.put(githubDraft({
    source: "rovara", kind: "rovara.remembered", repo: undefined, sourceRef: { system: "rovara", id: `task:${taskId}:note:${noteId}`, parentId: `task:${taskId}`, version: "1" },
    audience: audienceOfVisibility({ taskId, visibility, at: AT }), scope: "rovara:project/web", trust: "member", actor: { sourceId: OWNER, developerId: OWNER, trust: "member" },
    text, links: [], retention: "C", structured: { taskId },
  }));
  expect(outcome.status).toBe("stored");
}
/** A non-Rovara, project-wide row: the control that nothing else changes. */
async function ticket(w: World, text: string): Promise<void> {
  await addSource(w, { source: "linear", scope: "linear:team/ENG", audienceDefault: "project" });
  expect((await w.sink.put(githubDraft({
    source: "linear", kind: "ticket.created", repo: undefined, sourceRef: { system: "linear.app", id: "ENG-7", version: "1" }, audience: { kind: "project" }, scope: "linear:team/ENG",
    actor: { sourceId: "u9", trust: "member" }, trust: "member", text, links: [],
  }))).status).toBe("stored");
}
const kindsOf = async (d: RecordQueryDependencies, audience: ReadAudience, query = "retry"): Promise<string[]> => (await recordSearch(d, audience, "web", { query })).hits.map((hit) => hit.kind);

describe("a narrowed task hides the rows recorded earlier", () => {
  it("a project-wide row whose task is later shared with a list: only the list reads it, a shared task's model context does not", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    const live = port({ [T1]: SHARED });
    // positive control: while the task is still the project's, everybody reads it
    expect(await kindsOf(deps(w, live), person(OTHER))).toEqual(["rovara.remembered"]);
    expect(await kindsOf(deps(w, live), shared)).toEqual(["rovara.remembered"]);
    live.live[T1] = { kind: "shared_with", developerIds: [OWNER, PEER] };
    expect(await kindsOf(deps(w, live), person(OTHER))).toEqual([]);
    expect(await kindsOf(deps(w, live), shared)).toEqual([]);
    expect(await kindsOf(deps(w, live), person(PEER))).toEqual(["rovara.remembered"]);
    expect(await kindsOf(deps(w, live), person(OWNER))).toEqual(["rovara.remembered"]);
    live.live[T1] = PRIVATE;
    expect(await kindsOf(deps(w, live), person(PEER))).toEqual([]);
    expect(await kindsOf(deps(w, live), person(OWNER))).toEqual(["rovara.remembered"]);
  });

  it("a person removed from the People list loses the rows that named them, and the row is still there for the owner", async () => {
    const w = world();
    await note(w, T1, WITH_PEER, "retry the billing job with jitter");
    const live = port({ [T1]: WITH_PEER });
    expect(await kindsOf(deps(w, live), person(PEER))).toEqual(["rovara.remembered"]);
    live.live[T1] = PRIVATE;
    expect(await kindsOf(deps(w, live), person(PEER))).toEqual([]);
    expect((await recordSearch(deps(w, live), person(PEER), "web", { query: "retry" })).someHidden).toBe(true);
    expect(await kindsOf(deps(w, live), person(OWNER))).toEqual(["rovara.remembered"]);
  });

  it("a task shared MORE widely later does not widen old rows beyond the audience they were recorded with", async () => {
    const w = world();
    await note(w, T1, PRIVATE, "retry the billing job with jitter");
    const live = port({ [T1]: SHARED });
    expect(await kindsOf(deps(w, live), person(OTHER))).toEqual([]);
    expect(await kindsOf(deps(w, live), shared)).toEqual([]);
    expect(await kindsOf(deps(w, live), person(OWNER))).toEqual(["rovara.remembered"]);
    // the owner is checked against the live list too: a list the owner is not on shows them nothing
    live.live[T1] = { kind: "private", ownerDeveloperId: PEER };
    expect(await kindsOf(deps(w, live), person(OWNER))).toEqual([]);
  });

  it("only the narrowed task's rows go: another task and a non-Rovara row are untouched, and the other task is not even asked about twice", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    await note(w, T2, SHARED, "retry the nightly export with backoff");
    await ticket(w, "retry storm in the matching service");
    const live = port({ [T1]: PRIVATE, [T2]: SHARED });
    const kinds = await recordSearch(deps(w, live), person(OTHER), "web", { query: "retry" });
    expect(kinds.hits.map((hit) => hit.snippet).sort()).toEqual(["retry storm in the matching service", "retry the nightly export with backoff"]);
    // each distinct task is read once for the whole request, however many times the rows are filtered
    expect(live.calls.flat().sort()).toEqual([T1, T2]);
  });
});

describe("a visibility that cannot be read shows nothing from those rows (fail closed)", () => {
  it("a read that throws, a task that is gone, and a missing port all hide the Rovara rows and nothing else", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    await ticket(w, "retry storm in the matching service");
    for (const live of [port({ [T1]: "throw" }), port({ [T1]: undefined }), undefined]) {
      expect(await kindsOf(deps(w, live), person(OWNER))).toEqual(["ticket.created"]);
      expect(await kindsOf(deps(w, live), shared)).toEqual(["ticket.created"]);
    }
  });

  it("a read that never answers is cut off at the timeout, and the rows stay hidden", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    await ticket(w, "retry storm in the matching service");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging: TaskVisibilityPort = { read: () => new Promise(() => undefined) };
    const pending = recordSearch(deps(w, hanging, { taskVisibilityTimeoutMs: 50 }), person(OWNER), "web", { query: "retry" });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).hits.map((hit) => hit.kind)).toEqual(["ticket.created"]);
  });

  it("a row that says it is Rovara's but names no task is hidden; a lookup past the bound hides the tasks beyond it", async () => {
    const lookups = port({});
    const reader = createLiveAudienceReader(ORG_A, lookups);
    const orphan: Visible = { audience: { kind: "project" }, sourceRef: { system: "rovara", id: "ask:1" } };
    expect((await filterVisible([orphan], person(OWNER), { access: openAccess, liveTasks: reader })).visible).toEqual([]);
    const many = Array.from({ length: LIVE_TASKS_PER_REQUEST_MAX + 5 }, (_, index): Visible & { n: number } => ({ n: index, audience: { kind: "project" }, sourceRef: { system: "rovara", id: `task:t${String(index)}:note:1` } }));
    for (const row of many) lookups.live[`t${String(row.n)}`] = SHARED;
    const result = await filterVisible(many, person(OWNER), { access: openAccess, liveTasks: createLiveAudienceReader(ORG_A, lookups) });
    expect(result.visible).toHaveLength(LIVE_TASKS_PER_REQUEST_MAX);
    expect(result.visible.map((row) => row.n)).toEqual(many.slice(0, LIVE_TASKS_PER_REQUEST_MAX).map((row) => row.n));
  });
});

describe("an unreadable visibility is counted, and an empty task list is never an answer", () => {
  it("logs counts only (no ids) when rows are hidden because a visibility could not be read: a timeout, an error, a missing answer, the bound and no port", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields: { ...fields } }); };
    await createLiveAudienceReader(ORG_A, port({ [T1]: "throw" }), { log }).load([T1]);
    await createLiveAudienceReader(ORG_A, port({ [T1]: undefined }), { log }).load([T1, T2]);
    await createLiveAudienceReader(ORG_A, undefined, { log }).load([T1]);
    await createLiveAudienceReader(ORG_A, port({}), { log, maxTasks: 1 }).load([T1, T2, "t3"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = createLiveAudienceReader(ORG_A, { read: () => new Promise(() => undefined) }, { log, timeoutMs: 20 }).load([T1]);
    await vi.advanceTimersByTimeAsync(50);
    await slow;
    expect(new Set(logs.map((entry) => entry.fields.reason))).toEqual(new Set(["bound", "error", "missing", "no_port", "timeout"]));
    for (const entry of logs) {
      expect(entry.event).toBe("record.live_audience_unreadable");
      expect(Object.keys(entry.fields).sort()).toEqual(["reason", "tasks"]);
      expect(JSON.stringify(entry)).not.toContain(T1);
    }
    expect(logs.find((entry) => entry.fields.reason === "bound")!.fields.tasks).toBe(2);
  });

  it("an empty list of tasks is unreadable, never allow", () => {
    expect(createLiveAudienceReader(ORG_A, port({})).verdictOf(person(OWNER), [])).toBe("unreadable");
  });
});

describe("what counts as a row about a task", () => {
  const refs = (row: Partial<Visible> & { source?: string; structured?: Record<string, string | number | boolean> }) => rovaraTaskRefsOf({ audience: { kind: "project" }, ...row });
  it("reads the task from the Rovara source id, the structured field, a fact's derivedFrom and a task place", () => {
    expect(refs({ sourceRef: { system: "rovara", id: `task:${T1}:note:n1` } })).toEqual({ taskIds: [T1], unreadable: false });
    expect(refs({ source: "rovara", sourceRef: { system: "rovara", id: "sb1" }, structured: { taskId: "t1" } })).toEqual({ taskIds: ["t1"], unreadable: false });
    expect(refs({ derivedFrom: [`rovara:task:${T1}:note:n1`, "github.com:acme/api:revert:x", `rovara:task:${T2}`] })).toEqual({ taskIds: [T1, T2], unreadable: false });
    expect(refs({ scopes: [`rovara:task/${T1}`, "slack:T1/C1"], restrictedScopes: [`rovara:task/${T2}`] })).toEqual({ taskIds: [T1, T2], unreadable: false });
    expect(refs({ audience: { kind: "restricted", acl: { source: "rovara", scope: `rovara:task/${T1}`, principals: [OWNER], capturedAt: AT, liveCheck: "none" } } })).toEqual({ taskIds: [T1], unreadable: false });
  });
  it("is nothing for other sources, and unreadable for a Rovara row with no task", () => {
    expect(refs({ sourceRef: { system: "github.com", id: `task:${T1}` } })).toBeUndefined();
    expect(refs({})).toBeUndefined();
    expect(refs({ source: "rovara", sourceRef: { system: "rovara", id: "ask:1" } })).toEqual({ taskIds: [], unreadable: true });
    expect(refs({ sourceRef: { system: "rovara", id: "task:" } })).toEqual({ taskIds: [], unreadable: true });
  });
  it("the live rule: the project, the listed people, the owner", () => {
    expect(mayReadTask(person(OTHER), SHARED)).toBe(true);
    expect(mayReadTask(shared, SHARED)).toBe(true);
    expect(mayReadTask(shared, WITH_PEER)).toBe(false);
    expect(mayReadTask(person(PEER), WITH_PEER)).toBe(true);
    expect(mayReadTask(person(OTHER), WITH_PEER)).toBe(false);
    expect(mayReadTask(person(OWNER), PRIVATE)).toBe(true);
    expect(mayReadTask(person(PEER), PRIVATE)).toBe(false);
  });
});

describe("every read path of the record applies the live check", () => {
  const FACT = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0002";
  const projectAudience: Audience = { kind: "project" };

  it("the facts route and the search over facts: a note distilled from a task that was narrowed is hidden", async () => {
    const w = world();
    await putRecordFact(w.table, { id: FACT, workspaceId: ORG_A, project: "web", kind: "decision", text: "We always retry with jitter.", links: [], derivedFrom: [`rovara:task:${T1}:note:n1`], trust: "member", audience: projectAudience, createdAt: AT });
    await putRecordFact(w.table, { id: "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0009", workspaceId: ORG_A, project: "web", kind: "note", text: "Retry notes from a ticket.", links: [], derivedFrom: ["linear.app:ENG-7"], trust: "member", audience: projectAudience, createdAt: AT });
    const live = port({ [T1]: SHARED });
    expect((await recordFacts(deps(w, live), person(OTHER), "web", {})).facts).toHaveLength(2);
    live.live[T1] = PRIVATE;
    const after = await recordFacts(deps(w, live), person(OTHER), "web", {});
    expect(after.facts.map((fact) => fact.text)).toEqual(["Retry notes from a ticket."]);
    expect(after.someHidden).toBe(true);
    expect((await recordSearch(deps(w, live), person(OTHER), "web", { query: "retry jitter" })).hits.map((hit) => hit.snippet)).toEqual(["Retry notes from a ticket."]);
    expect((await recordFacts(deps(w, live), shared, "web", {})).facts).toHaveLength(1);
  });

  it("the search route and the agent tool", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    const live = port({ [T1]: SHARED });
    const route = async (who = caller({ developerId: OTHER })) => (await handleRecordRoute(deps(w, live), { method: "GET", path: "/v1/app/projects/web/record/search", query: { query: "retry" }, caller: who }))!.body as { hits: unknown[] };
    const tool = async (visibility: "shared" | "private" = "shared") => callRecordTool(deps(w, live), { orgId: ORG_A, project: "web", taskId: "task-x", visibility, stage: "PLAN", ...(visibility === "private" ? { ownerAudience: person(OWNER) as Extract<ReadAudience, { kind: "caller" }> } : {}) }, { tool: "record_search", arguments: { query: "retry" } });
    expect((await route()).hits).toHaveLength(1);
    expect((await tool()).text).toContain("jitter");
    live.live[T1] = WITH_PEER;
    expect((await route()).hits).toHaveLength(0);
    expect((await tool()).text).not.toContain("jitter");
    expect((await tool("private")).text).toContain("jitter");
    live.live[T1] = "throw";
    expect((await route()).hits).toHaveLength(0);
    const failed = await tool("private");
    expect(failed.text).not.toContain("jitter");
  });

  it("vector hits are fetched and then checked like any other row", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    const event = eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!;
    const vectorSearch: RecordVectorSearchPort = { async query() { return [{ key: `event:${event.id}`, distance: 0.1, metadata: { ref: eventVectorRef(event), kind: "event", project: "web", trust: event.trust, audience_kind: event.audience.kind, scope: "x" } }]; } };
    const live = port({ [T1]: SHARED });
    const d = deps(w, live, { embedder: w.embedder, vectorSearch });
    expect((await recordSearch(d, person(OTHER), "web", { query: "anything" })).hits).toHaveLength(1);
    live.live[T1] = PRIVATE;
    expect((await recordSearch(d, person(OTHER), "web", { query: "anything" })).hits).toHaveLength(0);
  });

  async function outcomesOf(w: World, taskId: string): Promise<void> {
    for (const [kind, id, structured] of [["rovara.send_back", "sb1", { taskId }], ["rovara.task", "end", { taskId, outcome: "merged" }]] as const) {
      expect((await w.sink.put(githubDraft({ source: "rovara", kind, repo: undefined, sourceRef: { system: "rovara", id: `task:${taskId}:${id}`, version: "1" }, audience: { kind: "project" }, scope: "rovara:project/web", trust: "rovara", actor: undefined, text: undefined, structured, retention: "C" }))).status).toBe("stored");
    }
  }
  const taskOf = (taskId: string): PastWorkTask => ({ taskId, title: "Task", status: "merged", pullRequests: [], planSummary: "x", audience: { kind: "project" } });

  it("past work: a task that was narrowed is not shown with an outcome nobody could judge, and a lesson learned at a task place needs the live list too", async () => {
    const w = world();
    await outcomesOf(w, T1);
    const lesson = { title: "Retry with jitter", audience: projectAudience, scopes: [`rovara:task/${T1}`], restrictedScopes: [] };
    const live = port({ [T1]: SHARED });
    const d = deps(w, live, { tasks: { async search() { return [taskOf(T1)]; } }, lessonsOfTask: async () => [lesson] });
    const before = await pastWork(d, person(OTHER), "shared", "web", { query: "x" });
    expect(before.items[0]).toMatchObject({ outcome: { merged: true, sendBacks: 1 }, lessonsLearned: ["Retry with jitter"] });
    live.live[T1] = PRIVATE;
    // not an all-false outcome: the task is not in the answer at all, and the reader is told something is hidden
    const after = await pastWork(d, person(OTHER), "shared", "web", { query: "x" });
    expect(after.items).toEqual([]);
    expect((await pastWork(d, person(OTHER), "private", "web", { query: "x" })).someHidden).toBe(true);
    expect((await pastWork(d, person(OWNER), "private", "web", { query: "x" })).items[0]).toMatchObject({ outcome: { merged: true, sendBacks: 1 } });
    // unreadable: also not shown
    live.live[T1] = "throw";
    expect((await pastWork(d, person(OWNER), "private", "web", { query: "x" })).items).toEqual([]);
  });

  it("past work: only the shown tasks are looked up, so a long scan of other tasks never spends the per-request bound or turns a real outcome into an empty one", async () => {
    const w = world();
    const others = Array.from({ length: LIVE_TASKS_PER_REQUEST_MAX + 20 }, (_, index) => `other-${String(index)}`);
    for (const id of others) {
      await w.sink.put(githubDraft({ source: "rovara", kind: "rovara.send_back", repo: undefined, sourceRef: { system: "rovara", id: `task:${id}:sb`, version: "1" }, audience: { kind: "project" }, scope: "rovara:project/web", trust: "rovara", actor: undefined, text: undefined, structured: { taskId: id }, retention: "C" }));
    }
    await outcomesOf(w, T1);
    const live = port({ [T1]: SHARED });
    const d = deps(w, live, { tasks: { async search() { return [taskOf(T1)]; } } });
    const result = await pastWork(d, person(OTHER), "shared", "web", { query: "x" });
    expect(result.items[0]).toMatchObject({ outcome: { merged: true, sendBacks: 1 } });
    expect(live.calls.flat()).toEqual([T1]);
  });

  it("another workspace is never asked about: the port gets the caller's org", async () => {
    const w = world();
    await note(w, T1, SHARED, "retry the billing job with jitter");
    const asked: string[] = [];
    const spy: TaskVisibilityPort = { async read(orgId, ids) { asked.push(orgId); return new Map(ids.map((id) => [id, SHARED])); } };
    await recordSearch(deps(w, spy), { kind: "caller", caller: caller({ orgId: ORG_B }) }, "web", { query: "retry" });
    await recordSearch(deps(w, spy), person(OTHER), "web", { query: "retry" });
    expect(new Set(asked)).toEqual(new Set([ORG_A]));
  });
});
