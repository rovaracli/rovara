// SRL-4: the statistics over Rovara's own rows (send-backs by stage, the merge rate) count only tasks the whole project can view RIGHT NOW. Aggregates are the one read that cannot be filtered row by row
// afterwards, so the tasks in the window are listed first (lake and recent side), each one's live visibility is read, and the tasks that are narrowed, gone or unreadable are left out of both sides.
import { describe, expect, it } from "vitest";
import { createLakeClient, type AthenaPort } from "../../../packages/broker/src/team-record/lake.js";
import { tableHotStatsSource } from "../../../packages/broker/src/team-record/hot-source.js";
import { type TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import { recordStats, type RecordQueryDependencies, type StatsPort } from "../../../packages/broker/src/team-record/query.js";
import { STATS_ROVARA_TASKS_MAX, buildStats, listRovaraTaskIds, runStats, type HotStatsSource } from "../../../packages/broker/src/team-record/stats-templates.js";
import type { TaskVisibility } from "../../../packages/broker/src/team-record/sources/rovara.js";
import { ORG_A, addSource, caller, githubDraft, world, type World, GITHUB_SCOPE } from "../../support/team-record-core.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const wsCaller = { workspaceId: "ws1", project: "p1" };
const SHARED: TaskVisibility = { kind: "shared" };
const PRIVATE: TaskVisibility = { kind: "private", ownerDeveloperId: "dev-owner" };
const person = { kind: "caller" as const, caller: caller() };

function visibility(live: Record<string, TaskVisibility | undefined | "throw">): TaskVisibilityPort {
  return { async read(_org, ids) { if (ids.some((id) => live[id] === "throw")) throw new Error("down"); return new Map(ids.map((id) => [id, live[id] as TaskVisibility | undefined])); } };
}

describe("recordStats over Rovara's rows", () => {
  function stats(listed: { taskIds: string[]; complete: boolean } | "throw" | "absent") {
    const runs: unknown[] = [];
    const port: StatsPort = {
      async run(input) { runs.push(input); return [{ group: "REVIEW", count: "2" }]; },
      ...(listed === "absent" ? {} : { async rovaraTasks() { if (listed === "throw") throw new Error("lake down"); return listed; } }),
    };
    return { port, runs };
  }
  const deps = (w: World, port: StatsPort, taskVisibility?: TaskVisibilityPort): RecordQueryDependencies => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms, stats: port, ...(taskVisibility === undefined ? {} : { taskVisibility }) });

  it("leaves out the tasks that are narrowed, gone or unreadable, and keeps the ones the project can still view", async () => {
    const w = world();
    const { port, runs } = stats({ taskIds: ["t-open", "t-narrow", "t-gone"], complete: true });
    const answer = await recordStats(deps(w, port, visibility({ "t-open": SHARED, "t-narrow": PRIVATE, "t-gone": undefined })), person, "web", { template: "send_backs_by_stage" });
    expect(answer).toEqual({ status: "ok", rows: [{ group: "REVIEW", count: "2" }] });
    expect(runs).toEqual([{ template: "send_backs_by_stage", workspaceId: ORG_A, project: "web", params: {}, excludeTaskIds: ["t-narrow", "t-gone"] }]);
    // the merge rate is the same
    await recordStats(deps(w, port, visibility({ "t-open": SHARED, "t-narrow": SHARED, "t-gone": SHARED })), person, "web", { template: "rovara_merge_rate" });
    expect(runs[1]).toMatchObject({ template: "rovara_merge_rate", excludeTaskIds: [] });
  });

  it("a list of people is not the project: a task shared with some people is left out of a total too", async () => {
    const w = world();
    const { port, runs } = stats({ taskIds: ["t1"], complete: true });
    await recordStats(deps(w, port, visibility({ t1: { kind: "shared_with", developerIds: ["dev-owner", "dev-1"] } })), person, "web", { template: "send_backs_by_stage" });
    expect(runs[0]).toMatchObject({ excludeTaskIds: ["t1"] });
  });

  it("a visibility that cannot be read leaves every task out; a list of tasks that cannot be had (or was cut) makes the statistic unavailable", async () => {
    const w = world();
    const one = stats({ taskIds: ["t1"], complete: true });
    await recordStats(deps(w, one.port, visibility({ t1: "throw" })), person, "web", { template: "send_backs_by_stage" });
    expect(one.runs[0]).toMatchObject({ excludeTaskIds: ["t1"] });
    const none = stats({ taskIds: ["t1"], complete: true });
    await recordStats(deps(w, none.port), person, "web", { template: "send_backs_by_stage" });
    expect(none.runs[0]).toMatchObject({ excludeTaskIds: ["t1"] });
    for (const listed of ["throw", "absent", { taskIds: [] as string[], complete: false }] as const) {
      const broken = stats(listed);
      expect(await recordStats(deps(w, broken.port, visibility({})), person, "web", { template: "send_backs_by_stage" })).toMatchObject({ status: "unavailable" });
      expect(broken.runs).toEqual([]);
    }
  });

  it("a statistic over other sources is not touched", async () => {
    const w = world();
    const listed = stats("throw");
    expect(await recordStats(deps(w, listed.port), person, "web", { template: "tickets_by_component" })).toEqual({ status: "ok", rows: [{ group: "REVIEW", count: "2" }] });
    expect(listed.runs).toEqual([{ template: "tickets_by_component", workspaceId: ORG_A, project: "web", params: {} }]);
  });
});

describe("the statements", () => {
  it("bind the tasks to leave out as parameters, in both Rovara statistics, and add nothing when there are none", () => {
    const events = buildStats("rovara-lake", wsCaller, "send_backs_by_stage", {}, NOW, undefined, ["a", "b' OR '1'='1"]);
    expect(events.sql).toContain(`NOT IN (?, ?)`);
    expect(events.sql).not.toContain("OR '1'='1");
    expect(events.parameters.slice(4)).toEqual(["'a'", "'b'' OR ''1''=''1'"]);
    expect(events.sql.match(/\?/g)).toHaveLength(events.parameters.length);
    const outcomes = buildStats("rovara-lake", wsCaller, "rovara_merge_rate", {}, NOW, undefined, ["a"]);
    expect(outcomes.sql).toContain(`"task_id" NOT IN (?)`);
    expect(outcomes.sql.match(/\?/g)).toHaveLength(outcomes.parameters.length);
    for (const name of ["send_backs_by_stage", "rovara_merge_rate"]) {
      expect(buildStats("rovara-lake", wsCaller, name, {}, NOW, undefined, []).sql).not.toContain("NOT IN");
      expect(buildStats("rovara-lake", wsCaller, name, {}, NOW).sql).not.toContain("NOT IN");
    }
    expect(() => buildStats("rovara-lake", wsCaller, "send_backs_by_stage", {}, NOW, undefined, Array.from({ length: STATS_ROVARA_TASKS_MAX + 1 }, (_, index) => `t${String(index)}`))).toThrow(/too many/);
  });

  const lakeSeeing = (seen: Array<{ sql: string; parameters: string[] }>, columns: string[], rows: Array<Array<string | null>>): ReturnType<typeof createLakeClient> => {
    const athena: AthenaPort = {
      startQuery: async (r) => { seen.push({ sql: r.sql, parameters: r.executionParameters }); return { queryExecutionId: "q" }; },
      getQueryState: async () => ({ state: "SUCCEEDED" }), getResults: async () => ({ columns, rows }), stopQuery: async () => undefined,
    };
    return createLakeClient({ athena, workGroup: "wg", now: () => NOW });
  };
  const hot = (over: Partial<HotStatsSource> = {}): HotStatsSource => ({
    groupedCounts: async () => [], mergeTotals: async () => ({ tasks: 0, merged: 0, reverted: 0, send_backs: 0 }), rovaraTaskIds: async () => ["h1"], ...over,
  });

  it("runStats passes the tasks to leave out to the lake statement and to the recent side", async () => {
    const seen: Array<{ sql: string; parameters: string[] }> = [];
    const hotSeen: unknown[] = [];
    await runStats({ lake: lakeSeeing(seen, ["group", "count"], []), tableBucket: "rovara-lake", hot: hot({ groupedCounts: async (r) => { hotSeen.push(r); return []; } }) }, wsCaller, "send_backs_by_stage", {}, { excludeTaskIds: ["t-narrow"] });
    expect(seen[0]!.sql).toContain("NOT IN (?)");
    expect(seen[0]!.parameters.at(-1)).toBe("'t-narrow'");
    expect(hotSeen[0]).toMatchObject({ excludeTaskIds: ["t-narrow"] });
  });

  it("listRovaraTaskIds joins the lake's tasks and the recent side's, and says when the list was cut or could not be had", async () => {
    const seen: Array<{ sql: string; parameters: string[] }> = [];
    const deps = { lake: lakeSeeing(seen, ["task"], [["l1"], ["l2"], [null], [""]]), tableBucket: "rovara-lake", hot: hot() };
    expect(await listRovaraTaskIds(deps, wsCaller, "send_backs_by_stage", {})).toEqual({ taskIds: ["h1", "l1", "l2"], complete: true });
    expect(seen[0]!.sql).toContain(`SELECT DISTINCT`);
    expect(seen[0]!.sql).toContain("rovara.send_back");
    expect((await listRovaraTaskIds(deps, wsCaller, "rovara_merge_rate", {})).taskIds).toEqual(["h1", "l1", "l2"]);
    expect(seen[1]!.sql).toContain(`"task_id" AS "task"`);
    expect(await listRovaraTaskIds(deps, wsCaller, "send_backs_by_stage", {}, 2)).toMatchObject({ complete: false });
    const withoutListing: HotStatsSource = { groupedCounts: async () => [], mergeTotals: async () => ({ tasks: 0, merged: 0, reverted: 0, send_backs: 0 }) };
    await expect(listRovaraTaskIds({ ...deps, hot: withoutListing }, wsCaller, "send_backs_by_stage", {})).rejects.toThrow();
    await expect(listRovaraTaskIds(deps, wsCaller, "tickets_by_component", {})).rejects.toThrow();
    await expect(listRovaraTaskIds({ ...deps, hot: hot({ rovaraTaskIds: async () => { throw new Error("x"); } }) }, wsCaller, "send_backs_by_stage", {})).rejects.toThrow();
  });
});

describe("the recent side", () => {
  const PROJECT = { kind: "project" as const };
  const rovara = (w: World, kind: string, id: string, structured: Record<string, string | number | boolean>) =>
    w.sink.put(githubDraft({ source: "rovara", kind: kind as never, repo: undefined, sourceRef: { system: "rovara", id, version: "1" }, audience: PROJECT, trust: "rovara", actor: undefined, text: undefined, structured, occurredAt: new Date(w.clock.ms - 2 * 86_400_000).toISOString(), retention: "C", links: [], scope: "rovara:project/web" }));
  const window = (w: World) => ({ workspaceId: ORG_A, project: "web", since: new Date(w.clock.ms - 90 * 86_400_000).toISOString(), until: new Date(w.clock.ms).toISOString() });

  it("does not count the rows of tasks to leave out, nor a Rovara row that names no task, and lists the tasks it counts", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await rovara(w, "rovara.send_back", "sb1", { taskId: "t-open", stage: "REVIEW" });
    await rovara(w, "rovara.send_back", "sb2", { taskId: "t-narrow", stage: "REVIEW" });
    await rovara(w, "rovara.send_back", "sb3", { stage: "PLAN" });
    await rovara(w, "rovara.task", "end-open", { taskId: "t-open", outcome: "merged", sendBacks: 1 });
    await rovara(w, "rovara.task", "end-narrow", { taskId: "t-narrow", outcome: "merged", sendBacks: 3 });
    const source = tableHotStatsSource(w.table);
    // control: without a list everything is counted, as before
    expect(await source.groupedCounts({ ...window(w), template: "send_backs_by_stage" })).toEqual([{ group: "REVIEW", count: 2 }, { group: "PLAN", count: 1 }]);
    expect(await source.groupedCounts({ ...window(w), template: "send_backs_by_stage", excludeTaskIds: ["t-narrow"] })).toEqual([{ group: "REVIEW", count: 1 }]);
    expect(await source.mergeTotals({ ...window(w), excludeTaskIds: ["t-narrow"] })).toEqual({ tasks: 1, merged: 1, reverted: 0, send_backs: 1 });
    expect((await source.rovaraTaskIds!({ ...window(w), template: "send_backs_by_stage" })).sort()).toEqual(["t-narrow", "t-open"]);
    expect((await source.rovaraTaskIds!({ ...window(w), template: "rovara_merge_rate" })).sort()).toEqual(["t-narrow", "t-open"]);
    await expect(source.rovaraTaskIds!({ ...window(w), template: "tickets_by_component" })).rejects.toThrow();
  });
});
