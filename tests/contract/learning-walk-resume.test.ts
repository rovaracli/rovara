// v1.2 learning loop: cleanup walks resume on Cloud. A walk that stops at its budget (closeOrg, person erase) is finished by the broker's 5-minute settlement run, which reads a small
// index of open walks (one item per running `close` / `erase#` walk, written when the walk starts and removed when it finishes) and shares one budget across all the orgs it touches.
import { describe, expect, it } from "vitest";
import { clearOrgLearning, eraseLearningSubject, resumeOpenLearningWalks } from "../../packages/broker/src/learning/cleanup.js";
import { WALK_INDEX_PK, WALK_INDEX_STALE_MS, runLearningWalk, clearProjectPartitionJob } from "../../packages/broker/src/learning/walk.js";
import { learningWalkKey, projectLearningKey } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import { NOW_MS, ORG_B, PROJECT_CREATED, epochSeconds, iso, makeWorld, seedCorrection, seedItem, seedProject, type World } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_C = "org_cccccccccccccccccccc" as OrgId;
const partition = (world: World, project: string, org: OrgId = TEST_ORG) => world.db.find((item) => item.pk === projectLearningKey(org, project, "STATE").pk);
const walkOf = (world: World, kind: string, org: OrgId = TEST_ORG) => world.db.get(learningWalkKey(org, kind));
const indexItems = (world: World) => world.db.find((item) => item.pk === WALK_INDEX_PK);

/** A project holding `corrections` corrections (so `corrections + 1` items clear when the project is cleared). */
function seedBig(world: World, org: OrgId, project: string, corrections = 4): void {
  seedProject(world.db, org, project);
  seedItem(world.db, org, project, "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 0, liveCorrections: corrections, pendingRules: 0 });
  for (let n = 0; n < corrections; n += 1) seedCorrection(world.db, org, project, n);
}
const itemsLeft = (world: World, org: OrgId, projects: string[]) => projects.reduce((sum, name) => sum + partition(world, name, org).length, 0);

describe("the index of open walks", () => {
  it("is written when a close walk stops at its budget, and removed when the walk finishes", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3"]) seedBig(world, TEST_ORG, name);
    expect((await clearOrgLearning(world.deps, TEST_ORG, { writes: 4 })).status).toBe("running");
    expect(indexItems(world)).toEqual([expect.objectContaining({ orgId: TEST_ORG, kind: "close" })]);
    expect((await clearOrgLearning(world.deps, TEST_ORG)).status).toBe("done");
    expect(indexItems(world)).toEqual([]);
  });

  it("is not left behind by a walk that finishes in one run, and a sweep walk is never indexed", async () => {
    const world = makeWorld();
    seedBig(world, TEST_ORG, "p1");
    expect((await clearOrgLearning(world.deps, TEST_ORG)).status).toBe("done");
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "sweep", job: async () => "done", budget: { projects: 0 } });
    expect(indexItems(world)).toEqual([]);
  });

  it("is written for an erase walk too, and holds no text", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2"]) seedBig(world, TEST_ORG, name);
    expect((await eraseLearningSubject(world.deps, TEST_ORG, "dev7", { writes: 1 })).status).toBe("running");
    const [entry] = indexItems(world);
    expect(entry).toMatchObject({ orgId: TEST_ORG, kind: "erase#dev7" });
    expect(Object.keys(entry ?? {}).sort()).toEqual(["entityType", "kind", "orgId", "pk", "since", "sk"]);
  });
});

describe("a walk stopped at its budget completes on the next sweep tick", () => {
  it("finishes a close walk, with no request from the closed company", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3", "p4"]) seedBig(world, TEST_ORG, name);
    expect((await clearOrgLearning(world.deps, TEST_ORG, { writes: 6 })).status).toBe("running");
    expect(itemsLeft(world, TEST_ORG, ["p1", "p2", "p3", "p4"])).toBeGreaterThan(0);
    const report = await resumeOpenLearningWalks(world.deps);
    expect(report).toMatchObject({ walks: 1, done: 1, running: 0, failed: 0 });
    expect(itemsLeft(world, TEST_ORG, ["p1", "p2", "p3", "p4"])).toBe(0);
    expect(walkOf(world, "close")).toBeUndefined();
    expect(indexItems(world)).toEqual([]);
  });

  it("finishes an erase walk: the person's text is gone after the tick", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2"]) {
      seedBig(world, TEST_ORG, name, 1);
      seedItem(world.db, TEST_ORG, name, `CORRECTION#2026-10-30T09:00:00.000Z#mine-${name}`, {
        entityType: "LEARNING_CORRECTION", id: `mine-${name}`, stage: "build", source: "comment", sourceRef: { taskId: "t" }, taskId: "t", signature: ["h"], author: "dev7", standing: "member", text: "words",
        githubUserId: "9", createdAt: "2026-10-30T09:00:00.000Z", projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 1000,
      });
    }
    expect((await eraseLearningSubject(world.deps, TEST_ORG, "dev7", { writes: 1 })).status).toBe("running");
    expect(await resumeOpenLearningWalks(world.deps)).toMatchObject({ walks: 1, done: 1 });
    for (const name of ["p1", "p2"]) {
      expect(world.db.get(projectLearningKey(TEST_ORG, name, `CORRECTION#2026-10-30T09:00:00.000Z#mine-${name}`))).toMatchObject({ author: "erased" });
      expect(world.db.get(projectLearningKey(TEST_ORG, name, `CORRECTION#2026-10-30T09:00:00.000Z#mine-${name}`))?.["text"]).toBeUndefined();
    }
    expect(walkOf(world, "erase#dev7")).toBeUndefined();
    expect(indexItems(world)).toEqual([]);
  });

  it("does nothing, in one cheap read, when no walk is open", async () => {
    const world = makeWorld();
    expect(await resumeOpenLearningWalks(world.deps)).toMatchObject({ walks: 0, done: 0, failed: 0 });
    expect(world.db.commandNames()).toEqual(["QueryCommand"]);
  });

  it("leaves a sweep walk alone", async () => {
    const world = makeWorld();
    world.db.set({ ...learningWalkKey(TEST_ORG, "sweep"), entityType: "LEARNING_WALK", orgId: TEST_ORG, status: "running", startedAt: iso(NOW_MS), updatedAt: iso(NOW_MS), projectsDone: 0, version: 0 });
    expect(await resumeOpenLearningWalks(world.deps)).toMatchObject({ walks: 0 });
    expect(walkOf(world, "sweep")).toMatchObject({ status: "running", projectsDone: 0 });
  });
});

describe("one tick shares one budget across companies", () => {
  async function threeStoppedCompanies() {
    const world = makeWorld();
    const orgs = [TEST_ORG, ORG_B, ORG_C];
    for (const org of orgs) {
      for (const name of ["p1", "p2"]) seedBig(world, org, name, 9); // 10 items a project
      expect((await clearOrgLearning(world.deps, org, { writes: 1 })).status).toBe("running");
    }
    return { world, orgs };
  }

  it("spends no more writes than its budget, however many companies are waiting", async () => {
    const { world, orgs } = await threeStoppedCompanies();
    const before = orgs.map((org) => itemsLeft(world, org, ["p1", "p2"]));
    const report = await resumeOpenLearningWalks(world.deps, { writes: 15 });
    const after = orgs.map((org) => itemsLeft(world, org, ["p1", "p2"]));
    const deleted = before.reduce((sum, n, index) => sum + n - (after[index] ?? 0), 0);
    expect(deleted).toBeGreaterThan(0);
    // 15 writes include each walk's own cursor writes; a walk that stops on its budget may be one cursor write over it.
    expect(deleted).toBeLessThanOrEqual(15);
    expect(report.writes).toBeLessThanOrEqual(15 + 3);
    expect(report.running).toBeGreaterThan(0);
    expect(report.done).toBe(0);
    // Nothing was started for a company beyond what the budget reached: at least one company is untouched.
    expect(after.filter((left, index) => left === before[index]).length).toBeGreaterThanOrEqual(1);
  });

  it("stops at its time budget too", async () => {
    const { world } = await threeStoppedCompanies();
    // Every table call costs 100 ms of the clock.
    const ticking = { ...world.deps, documentClient: { send: async (command: unknown) => { world.clock.ms += 100; return world.db.send(command as never); } } };
    const started = world.clock.ms;
    const report = await resumeOpenLearningWalks(ticking, { millis: 1_000 });
    expect(report.running).toBeGreaterThan(0);
    expect(world.clock.ms - started).toBeLessThan(1_000 + 600);
  });

  it("finishes every company over successive ticks, and the index is empty at the end", async () => {
    const { world, orgs } = await threeStoppedCompanies();
    let reports = 0;
    for (; reports < 30 && indexItems(world).length > 0; reports += 1) await resumeOpenLearningWalks(world.deps, { writes: 15 });
    expect(indexItems(world)).toEqual([]);
    expect(reports).toBeGreaterThan(1);
    for (const org of orgs) {
      expect(itemsLeft(world, org, ["p1", "p2"])).toBe(0);
      expect(walkOf(world, "close", org)).toBeUndefined();
    }
  });

  it("does not let one company's failing walk stop the others", async () => {
    const { world, orgs } = await threeStoppedCompanies();
    let failing = true;
    world.db.injectFault({ command: "UpdateCommand", match: (input) => failing && JSON.stringify(input).includes(String(orgs[0])), error: { name: "ProvisionedThroughputExceededException" }, times: 100 });
    const report = await resumeOpenLearningWalks(world.deps);
    failing = false;
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(itemsLeft(world, orgs[1] as OrgId, ["p1", "p2"])).toBe(0);
    expect(itemsLeft(world, orgs[2] as OrgId, ["p1", "p2"])).toBe(0);
  });
});

describe("an index item whose walk is gone", () => {
  const staleEntry = (world: World, since: number) => world.db.set({ pk: WALK_INDEX_PK, sk: `${TEST_ORG}#close`, entityType: "LEARNING_WALK_OPEN", orgId: TEST_ORG, kind: "close", since: iso(since) });

  it("is removed once it is old enough, and does not start a walk", async () => {
    const world = makeWorld();
    seedBig(world, TEST_ORG, "p1");
    staleEntry(world, NOW_MS - WALK_INDEX_STALE_MS - 1);
    const report = await resumeOpenLearningWalks(world.deps);
    expect(report).toMatchObject({ walks: 0, stale: 1 });
    expect(indexItems(world)).toEqual([]);
    expect(walkOf(world, "close")).toBeUndefined();
    expect(partition(world, "p1")).toHaveLength(5);
  });

  it("is kept while it is young, since the walk item may not be written yet", async () => {
    const world = makeWorld();
    staleEntry(world, NOW_MS - 1000);
    expect(await resumeOpenLearningWalks(world.deps)).toMatchObject({ walks: 0, stale: 0 });
    expect(indexItems(world)).toHaveLength(1);
  });
});

describe("the walk runner", () => {
  it("indexes only the close and erase kinds and removes the entry on completion for a custom job as well", async () => {
    const world = makeWorld();
    seedBig(world, TEST_ORG, "p1");
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: async () => "partial" });
    expect(indexItems(world)).toHaveLength(1);
    await runLearningWalk(world.deps, { orgId: TEST_ORG, kind: "close", job: clearProjectPartitionJob(world.deps) });
    expect(indexItems(world)).toEqual([]);
  });
});


// ---- B6 review fix: the index read rotates, so entries behind a pile of failing ones are reached.
describe("the index read rotates its starting point", () => {
  const entry = (world: World, project: string) => world.db.set({
    pk: WALK_INDEX_PK, sk: `${TEST_ORG}#clear#${project}`, entityType: "LEARNING_WALK_OPEN", orgId: TEST_ORG, kind: `clear#${project}`, project, before: iso(NOW_MS), since: iso(NOW_MS),
  });

  it("reaches entries behind more than 100 that keep failing, on the next tick", async () => {
    const world = makeWorld();
    for (let n = 0; n < 110; n += 1) entry(world, `bad-${String(n).padStart(3, "0")}`);
    entry(world, "good-1");
    entry(world, "good-2");
    world.db.injectFault({
      command: "QueryCommand", error: { name: "InternalServerError" }, times: 100_000,
      match: (input) => typeof (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] === "string" && String((input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]).includes("bad-"),
    });
    const first = await resumeOpenLearningWalks(world.deps);
    expect(first.failed).toBe(100);
    expect(indexItems(world).some((item) => String(item.sk).includes("good-"))).toBe(true);
    const second = await resumeOpenLearningWalks(world.deps);
    expect(indexItems(world).some((item) => String(item.sk).includes("good-"))).toBe(false);
    expect(second.done).toBe(2);
  });

  it("an idle tick is still one read", async () => {
    const world = makeWorld();
    await resumeOpenLearningWalks(world.deps);
    expect(world.db.commandNames()).toEqual(["QueryCommand"]);
  });
});
