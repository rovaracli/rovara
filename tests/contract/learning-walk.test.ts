// v1.2 learning loop, B1: the catalog walk (design §3.5), the resumable enumeration closeOrg and person erase run on.
import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { archiveOrgProjects } from "../../packages/broker/src/org/project-archive.js";
import { clearProjectPartitionJob, runLearningWalk, type ProjectJob } from "../../packages/broker/src/learning/walk.js";
import { learningWalkKey, projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { NOW_MS, ORG_B, makeWorld, seedCorrection, seedItem, seedProject, type World } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

const names = (count: number) => Array.from({ length: count }, (_, n) => `p${String(n).padStart(3, "0")}`);
function recordingJob(world: World, visited: string[], cost = 1): ProjectJob {
  return async ({ project, budget }) => {
    visited.push(project);
    budget.spend(cost);
    return "done";
  };
}
const walkOf = (world: World, kind: string) => world.db.get(learningWalkKey(TEST_ORG, kind));

describe("learning walk over the project catalog", () => {
  it("reads the catalog 25 projects at a time and visits every project once, in order", async () => {
    const world = makeWorld();
    for (const name of names(60)) seedProject(world.db, TEST_ORG, name);
    const queries: Array<Record<string, unknown>> = [];
    const spy = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => { if (command instanceof QueryCommand) queries.push(command.input); return world.db.send(command); } };
    const visited: string[] = [];
    const result = await runLearningWalk({ ...world.deps, documentClient: spy }, { orgId: TEST_ORG, kind: "close", job: recordingJob(world, visited), budget: { writes: 10_000 } });
    expect(result).toMatchObject({ status: "done", projectsThisRun: 60, projectsDone: 60 });
    expect(visited).toEqual(names(60));
    const catalogQueries = queries.filter((input) => String((input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]).endsWith("PROJECT_CATALOG"));
    expect(catalogQueries.length).toBeGreaterThanOrEqual(3);
    expect(catalogQueries.every((input) => input.Limit === 25)).toBe(true);
  });

  it("includes archived projects: archiving a project leaves its catalog entry", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedProject(world.db, TEST_ORG, "old");
    await archiveOrgProjects({ documentClient: world.db, tableName: "state", now: () => new Date(NOW_MS) } as never, TEST_ORG, { developerId: "dev1" });
    expect(world.db.find((item) => item.entityType === "PROJECT_META" && item.status === "archived")).toHaveLength(2);
    const visited: string[] = [];
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: recordingJob(world, visited) });
    expect(visited).toEqual(["old", "web"]);
  });

  it("stops when the write budget is spent, saves the cursor, and the next run resumes after it", async () => {
    const world = makeWorld();
    for (const name of names(10)) seedProject(world.db, TEST_ORG, name);
    const visited: string[] = [];
    const run = () => runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: recordingJob(world, visited), budget: { writes: 4 } });
    expect(await run()).toMatchObject({ status: "running", projectsThisRun: 4, projectsDone: 4 });
    expect(walkOf(world, "close")).toMatchObject({ status: "running", afterProject: "p003", projectsDone: 4 });
    expect(await run()).toMatchObject({ status: "running", projectsDone: 8 });
    expect(await run()).toMatchObject({ status: "done", projectsDone: 10 });
    expect(visited).toEqual(names(10));
    // A finished close walk leaves nothing behind.
    expect(walkOf(world, "close")).toBeUndefined();
  });

  it("stops at the project limit and at the time limit", async () => {
    const world = makeWorld();
    for (const name of names(10)) seedProject(world.db, TEST_ORG, name);
    const visited: string[] = [];
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "sweep", job: recordingJob(world, visited, 0), budget: { projects: 3 } })).toMatchObject({ status: "running", projectsThisRun: 3 });
    // The clock moves 8 seconds with each read: 20 seconds allow only a few projects.
    let ms = NOW_MS;
    const slow = { ...world.deps, now: () => (ms += 8000) };
    const result = await runLearningWalk(slow, { orgId: TEST_ORG, kind: "sweep", job: recordingJob(world, visited, 0) });
    expect(result.status).toBe("running");
    expect(result.projectsThisRun).toBeGreaterThan(0);
    expect(result.projectsThisRun).toBeLessThan(7);
  });

  it("does not move the cursor past a project whose job did not finish, and the repeat of it does no harm", async () => {
    const world = makeWorld();
    for (const name of names(3)) seedProject(world.db, TEST_ORG, name);
    const seen: string[] = [];
    let calls = 0;
    const job: ProjectJob = async ({ project }) => { seen.push(project); calls += 1; return project === "p001" && calls <= 2 ? "partial" : "done"; };
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "erase#dev1", job })).toMatchObject({ status: "running", projectsDone: 1 });
    expect(walkOf(world, "erase#dev1")).toMatchObject({ afterProject: "p000" });
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "erase#dev1", job })).toMatchObject({ status: "done", projectsDone: 3 });
    expect(seen).toEqual(["p000", "p001", "p001", "p002"]);
  });

  it("keeps a walk per kind, and per person for erase", async () => {
    const world = makeWorld();
    for (const name of names(4)) seedProject(world.db, TEST_ORG, name);
    const job = recordingJob(world, []);
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "erase#dev1", job, budget: { writes: 1 } });
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "erase#dev2", job, budget: { writes: 2 } });
    expect(walkOf(world, "erase#dev1")).toMatchObject({ projectsDone: 1 });
    expect(walkOf(world, "erase#dev2")).toMatchObject({ projectsDone: 2 });
  });

  it("lets only one of two overlapping runs advance the cursor", async () => {
    const world = makeWorld();
    for (const name of names(3)) seedProject(world.db, TEST_ORG, name);
    let nested: Awaited<ReturnType<typeof runLearningWalk>> | undefined;
    const inner = recordingJob(world, []);
    const outer: ProjectJob = async (input) => {
      if (input.project === "p000" && nested === undefined) nested = await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: inner });
      return "done";
    };
    const result = await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: outer });
    expect(nested).toMatchObject({ status: "done" });
    expect(result.status).toBe("busy");
  });

  it("keeps the walk item free of text and to this company (I9)", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedProject(world.db, ORG_B, "web");
    const visited: string[] = [];
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "sweep", job: recordingJob(world, visited) });
    expect(visited).toEqual(["web"]);
    expect(walkOf(world, "sweep")).toMatchObject({ status: "done", projectsDone: 1 });
    expect(Object.keys(walkOf(world, "sweep")!)).not.toContain("text");
    expect(world.db.get(learningWalkKey(ORG_B, "sweep"))).toBeUndefined();
  });
});

describe("clearing a project's learning partition (the close job)", () => {
  it("deletes every item in the partition, expired or from an earlier project included, and nothing outside it", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    for (let n = 0; n < 130; n += 1) seedCorrection(world.db, TEST_ORG, "web", n, (n % 2 === 0 ? { projectCreatedAt: "2020-01-01T00:00:00.000Z" } : {}));
    seedItem(world.db, TEST_ORG, "web", "STATE", { revision: 1 });
    // A partition outside the company's catalog, and another company's: neither is this walk's.
    seedCorrection(world.db, TEST_ORG, "api", 1);
    seedProject(world.db, ORG_B, "web");
    seedCorrection(world.db, ORG_B, "web", 1);
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: clearProjectPartitionJob(world.deps) });
    expect(world.db.find((item) => item.pk === projectLearningKey(TEST_ORG, "web", "STATE").pk)).toEqual([]);
    expect(world.db.find((item) => item.pk === projectLearningKey(TEST_ORG, "api", "STATE").pk)).toHaveLength(1);
    expect(world.db.find((item) => item.pk === projectLearningKey(ORG_B, "web", "STATE").pk)).toHaveLength(1);
  });

  it("resumes across runs when the write budget ends inside a project", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    for (let n = 0; n < 250; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    const job = clearProjectPartitionJob(world.deps);
    const left = () => world.db.find((item) => item.pk === projectLearningKey(TEST_ORG, "web", "STATE").pk).length;
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job, budget: { writes: 100 } })).toMatchObject({ status: "running", writes: 100 });
    expect(left()).toBe(150);
    expect(walkOf(world, "close")).toMatchObject({ projectsDone: 0 });
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job, budget: { writes: 100 } })).toMatchObject({ status: "running" });
    expect(await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job, budget: { writes: 100 } })).toMatchObject({ status: "done" });
    expect(left()).toBe(0);
  });
});
