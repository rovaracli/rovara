// v1.2 learning loop, B7: cleanup (design 3.5). closeOrg, project archive and person erase clear learning data through B1's catalog walk; a project created again sees nothing old.
import { describe, expect, it } from "vitest";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { clearOrgLearning, clearProjectLearning, eraseLearningSubject, learningEraseHook, resumeLearningWalks } from "../../packages/broker/src/learning/cleanup.js";
import { captureCorrection, getLearningItem, readLearningPartition, readLearningState } from "../../packages/broker/src/learning/store.js";
import { learningWalkKey, projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { LearningCorrectionSchema } from "../../packages/contracts/src/project-learning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { NOW_MS, ORG_B, PROJECT_CREATED, epochSeconds, iso, makeWorld, seedCorrection, seedItem, seedProject, type World } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

const partition = (world: World, project: string, org = TEST_ORG) => world.db.find((item) => item.pk === projectLearningKey(org, project, "STATE").pk);
const walkOf = (world: World, kind: string) => world.db.get(learningWalkKey(TEST_ORG, kind));

/** A project with a little of everything the store keeps. */
function seedFullProject(world: World, project: string, org = TEST_ORG, options: { corrections?: number } = {}): void {
  seedProject(world.db, org, project);
  seedItem(world.db, org, project, "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 3, openSuggestions: 1, liveCorrections: options.corrections ?? 4, pendingRules: 0 });
  seedItem(world.db, org, project, "SETTINGS", { projectCreatedAt: PROJECT_CREATED, revision: 1, prComments: "off", changedBy: "dev1", changedAt: iso(NOW_MS) });
  for (let n = 0; n < (options.corrections ?? 4); n += 1) seedCorrection(world.db, org, project, n);
  seedItem(world.db, org, project, "SUGGESTION#s1", { projectCreatedAt: PROJECT_CREATED, id: "s1", status: "open", proposedText: "Use the shared retry helper." });
  seedItem(world.db, org, project, "RULE#r1", { projectCreatedAt: PROJECT_CREATED, id: "r1", status: "active", text: "Use the shared retry helper." });
  seedItem(world.db, org, project, "METRIC#2026-10", { projectCreatedAt: PROJECT_CREATED, repeats: 2 });
  seedItem(world.db, org, project, "DISMISSED#h1", { projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 1000 });
}

describe("closeOrg clears every learning partition of the company", () => {
  it("deletes every item of every project, archived ones included, and nothing of another company", async () => {
    const world = makeWorld();
    for (const name of ["alpha", "beta", "gamma"]) seedFullProject(world, name);
    seedFullProject(world, "alpha", ORG_B);
    const result = await clearOrgLearning(world.deps, TEST_ORG);
    expect(result).toMatchObject({ status: "done", projectsDone: 3 });
    for (const name of ["alpha", "beta", "gamma"]) expect(partition(world, name)).toEqual([]);
    expect(partition(world, "alpha", ORG_B)).toHaveLength(10);
    expect(walkOf(world, "close")).toBeUndefined();
  });

  it("stops at its write budget, leaves the walk running, and the next calls finish it without repeating work", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3", "p4"]) seedFullProject(world, name);
    const first = await clearOrgLearning(world.deps, TEST_ORG, { writes: 12 });
    expect(first.status).toBe("running");
    expect(walkOf(world, "close")).toMatchObject({ status: "running" });
    let last = first;
    for (let run = 0; run < 20 && last.status !== "done"; run += 1) last = await clearOrgLearning(world.deps, TEST_ORG, { writes: 12 });
    expect(last.status).toBe("done");
    for (const name of ["p1", "p2", "p3", "p4"]) expect(partition(world, name)).toEqual([]);
    expect(walkOf(world, "close")).toBeUndefined();
  });

  it("clears expired items and items of an earlier project of the same name as well", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 10 });
    seedCorrection(world.db, TEST_ORG, "web", 2, { projectCreatedAt: "2026-01-01T00:00:00.000Z" });
    seedItem(world.db, TEST_ORG, "web", "UNKNOWN#thing", {});
    await clearOrgLearning(world.deps, TEST_ORG);
    expect(partition(world, "web")).toEqual([]);
  });

  it("resumeLearningWalks finishes a close walk and an erase walk that were left running, and ignores the sweep", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3"]) seedFullProject(world, name);
    seedItem(world.db, TEST_ORG, "p3", "CORRECTION#2026-10-30T09:00:00.000Z#cx", {
      entityType: "LEARNING_CORRECTION", id: "cx", stage: "build", source: "comment", sourceRef: { taskId: "tx" }, taskId: "tx", signature: ["h"], author: "dev7", standing: "member", text: "words",
      createdAt: "2026-10-30T09:00:00.000Z", projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 1000,
    });
    expect((await clearOrgLearning(world.deps, TEST_ORG, { writes: 5 })).status).toBe("running");
    expect((await eraseLearningSubject(world.deps, TEST_ORG, "dev7", { writes: 1 })).status).toBe("running");
    world.db.set({ ...learningWalkKey(TEST_ORG, "sweep"), entityType: "LEARNING_WALK", orgId: TEST_ORG, status: "running", startedAt: iso(NOW_MS), updatedAt: iso(NOW_MS), projectsDone: 0, version: 0 });
    await resumeLearningWalks(world.deps, TEST_ORG);
    expect(walkOf(world, "close")).toBeUndefined();
    expect(walkOf(world, "erase#dev7")).toBeUndefined();
    expect(walkOf(world, "sweep")).toMatchObject({ status: "running", projectsDone: 0 });
    for (const name of ["p1", "p2", "p3"]) expect(partition(world, name)).toEqual([]);
  });
});

describe("closeOrg runs the clearLearning dependency", () => {
  async function fixture() {
    const db = new FakeDynamoDb();
    const store = new OrgStore({ documentClient: db, tableName: "state", now: () => NOW_MS });
    const orgId = await store.createOrgWithOwner({ name: "Closing", developerId: "owner" });
    return { db, store, orgId };
  }

  it("calls it with the company once, after the projects are archived and before the company is closed", async () => {
    const f = await fixture();
    const order: string[] = [];
    await f.store.closeOrg(f.orgId, {
      archiveProjects: async () => { order.push("archive"); }, clearEgress: async () => undefined,
      clearLearning: async (orgId) => { order.push(`learning:${orgId}`); expect(f.db.find((item) => item.sk === "META" && item.closedAt !== undefined)).toEqual([]); },
    });
    expect(order).toEqual(["archive", `learning:${f.orgId}`]);
    expect(f.db.find((item) => item.closedAt !== undefined).length).toBeGreaterThan(0);
  });

  it("does not wait for a walk that could not finish: a failing hook is logged and the company still closes", async () => {
    const f = await fixture();
    await f.store.closeOrg(f.orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined, clearLearning: async () => { throw new Error("TextInError: SECRET-CORRECTION-WORDS"); } });
    expect(f.db.find((item) => item.closedAt !== undefined).length).toBeGreaterThan(0);
  });
});

describe("project archive clears the project's partition", () => {
  it("clears that project alone, and a project created again under the name sees nothing old", async () => {
    const world = makeWorld();
    seedFullProject(world, "web");
    seedFullProject(world, "ops");
    seedFullProject(world, "web", ORG_B);
    expect(await clearProjectLearning(world.deps, TEST_ORG, "web")).toBe("done");
    expect(partition(world, "web")).toEqual([]);
    expect(partition(world, "ops")).toHaveLength(10);
    expect(partition(world, "web", ORG_B)).toHaveLength(10);
    const again = { orgId: TEST_ORG, project: "web", projectCreatedAt: "2026-11-01T00:00:00.000Z" };
    expect(await readLearningState(world.deps, again)).toBeUndefined();
    expect((await readLearningPartition(world.deps, again)).items).toEqual([]);
  });

  it("a project created again sees nothing old even where the clear never ran", async () => {
    const world = makeWorld();
    seedFullProject(world, "web");
    const again = { orgId: TEST_ORG, project: "web", projectCreatedAt: "2026-11-01T00:00:00.000Z" };
    expect((await readLearningPartition(world.deps, again)).items).toEqual([]);
    expect(await getLearningItem(world.deps, again, "RULE#r1")).toBeUndefined();
    const first = await captureCorrection(world.deps, again, { id: "n1", stage: "build", source: "comment", sourceKey: "k1", sourceRef: { taskId: "t1" }, taskId: "t1", text: "x y z", signature: ["h"], author: "dev1", standing: "member", limit: "automatic" });
    expect(first).toMatchObject({ ok: true });
    expect(await readLearningState(world.deps, again)).toMatchObject({ liveCorrections: 1, openSuggestions: 0 });
  });

  it("works through a long partition in several steps when its budget is small, and finishes", async () => {
    const world = makeWorld();
    seedFullProject(world, "web", TEST_ORG, { corrections: 300 });
    expect(await clearProjectLearning(world.deps, TEST_ORG, "web", { writes: 100 })).toBe("partial");
    expect(partition(world, "web").length).toBeLessThan(310);
    expect(await clearProjectLearning(world.deps, TEST_ORG, "web", { writes: 1000 })).toBe("done");
    expect(partition(world, "web")).toEqual([]);
  });
});

describe("person erase", () => {
  const correction = (world: World, project: string, n: number, fields: Record<string, unknown>) => {
    const createdAt = iso(NOW_MS - n * 1000);
    const id = `c${String(n)}`;
    seedItem(world.db, TEST_ORG, project, `CORRECTION#${createdAt}#${id}`, {
      entityType: "LEARNING_CORRECTION", id, stage: "build", source: "comment", sourceRef: { taskId: `t${String(n)}` }, taskId: `t${String(n)}`, signature: ["h"], author: "dev1", standing: "member", text: `words ${String(n)}`,
      createdAt, projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 100_000, ...fields,
    });
    return `CORRECTION#${createdAt}#${id}`;
  };
  const suggestion = (world: World, project: string, id: string, status: string, ids: string[], extra: Record<string, unknown> = {}) => seedItem(world.db, TEST_ORG, project, `SUGGESTION#${id}`, {
    entityType: "LEARNING_SUGGESTION", id, stage: "build", status, correctionIds: ids, allFromOnePerson: false, proposedText: "Use the shared retry helper.", signature: ["h"], lessSafe: false, kinds: [], overlaps: [], revision: 0,
    createdAt: iso(NOW_MS), projectCreatedAt: PROJECT_CREATED, ...extra,
  });

  function seedErasure(world: World) {
    for (const project of ["web", "ops"]) {
      seedProject(world.db, TEST_ORG, project);
      seedItem(world.db, TEST_ORG, project, "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 5, openSuggestions: 2, liveCorrections: 5, pendingRules: 0 });
    }
    correction(world, "web", 1, { author: "dev1", githubUserId: "777", source: "pr_comment" });
    correction(world, "web", 2, { author: "dev2", rememberedBy: "dev1" });
    correction(world, "web", 3, { author: "dev2" });
    correction(world, "web", 4, { author: "dev3" });
    correction(world, "ops", 5, { author: "dev1" });
    suggestion(world, "web", "mine", "open", ["c1", "c4"]);
    suggestion(world, "web", "theirs", "open", ["c3", "c4"]);
    suggestion(world, "web", "waiting", "awaiting_approval", ["c1", "c3"]);
    suggestion(world, "web", "accepting3", "accepting", ["c1", "c3", "c4"]);
    seedItem(world.db, TEST_ORG, "web", "RATE#dev1#2976#1", { projectCreatedAt: PROJECT_CREATED, rememberCount: 3, indexExpiresAt: epochSeconds(NOW_MS) + 100 });
    seedItem(world.db, TEST_ORG, "web", "RATE#dev2#2976#1", { projectCreatedAt: PROJECT_CREATED, rememberCount: 1, indexExpiresAt: epochSeconds(NOW_MS) + 100 });
    seedItem(world.db, TEST_ORG, "web", "METRIC#2026-10", { projectCreatedAt: PROJECT_CREATED, memberCorrections: 4, repeats: 2 });
    seedProject(world.db, ORG_B, "web");
    seedItem(world.db, ORG_B, "web", "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 0, liveCorrections: 1, pendingRules: 0 });
    seedItem(world.db, ORG_B, "web", "CORRECTION#2026-10-30T09:59:00.000Z#o1", { author: "dev1", text: "other company words", githubUserId: "9", projectCreatedAt: PROJECT_CREATED, indexExpiresAt: epochSeconds(NOW_MS) + 1000 });
  }
  const find = (world: World, project: string, sk: string) => partition(world, project).find((item) => String(item.sk).includes(sk));

  it("removes the person's correction text and GitHub id and sets their author to erased, in every project, leaving other people's alone", async () => {
    const world = makeWorld();
    seedErasure(world);
    const result = await eraseLearningSubject(world.deps, TEST_ORG, "dev1");
    expect(result).toMatchObject({ status: "done", projectsDone: 2 });
    for (const [project, sk] of [["web", "#c1"], ["ops", "#c5"]] as const) {
      const erased = find(world, project, sk)!;
      expect(erased).toMatchObject({ author: "erased" });
      expect(erased).not.toHaveProperty("text");
      expect(erased).not.toHaveProperty("githubUserId");
      expect(LearningCorrectionSchema.safeParse(erased).success).toBe(true);
    }
    expect(find(world, "web", "#c3")).toMatchObject({ author: "dev2", text: "words 3" });
    expect(find(world, "web", "#c4")).toMatchObject({ author: "dev3", text: "words 4" });
    expect(find(world, "web", "#c2")).toMatchObject({ author: "dev2", text: "words 2" });
    expect(find(world, "web", "#c2")).not.toHaveProperty("rememberedBy");
    expect(JSON.stringify(world.db.find((item) => String(item.pk).includes(TEST_ORG)))).not.toContain("777");
  });

  it("withdraws an open suggestion that holds one of their corrections, clearing its text; others stay, and counts stay", async () => {
    const world = makeWorld();
    seedErasure(world);
    await eraseLearningSubject(world.deps, TEST_ORG, "dev1");
    const mine = find(world, "web", "SUGGESTION#mine")!;
    expect(mine).toMatchObject({ status: "withdrawn", terminalAt: iso(NOW_MS) });
    expect(mine).not.toHaveProperty("proposedText");
    expect(find(world, "web", "SUGGESTION#theirs")).toMatchObject({ status: "open", proposedText: "Use the shared retry helper." });
    // Privacy comes before "open only": a suggestion being accepted or waiting for a second person is withdrawn when fewer than 2 sources from 2 tasks are left without this person...
    expect(find(world, "web", "SUGGESTION#waiting")).toMatchObject({ status: "withdrawn" });
    expect(find(world, "web", "SUGGESTION#waiting")).not.toHaveProperty("proposedText");
    // ...and kept when 2 sources from 2 tasks remain; the person's own correction text is gone either way.
    expect(find(world, "web", "SUGGESTION#accepting3")).toMatchObject({ status: "accepting" });
    expect(find(world, "web", "#c1")).not.toHaveProperty("text");
    expect(find(world, "web", "STATE")).toMatchObject({ openSuggestions: 0, liveCorrections: 5 });
    expect(find(world, "web", "METRIC#2026-10")).toMatchObject({ memberCorrections: 4, repeats: 2 });
  });

  it("deletes the person's own rate items and no one else's, and leaves another company alone", async () => {
    const world = makeWorld();
    seedErasure(world);
    await eraseLearningSubject(world.deps, TEST_ORG, "dev1");
    expect(find(world, "web", "RATE#dev1")).toBeUndefined();
    expect(find(world, "web", "RATE#dev2")).toBeDefined();
    expect(partition(world, "web", ORG_B).find((item) => String(item.sk).includes("#o1"))).toMatchObject({ author: "dev1", text: "other company words", githubUserId: "9" });
  });

  it("stops at its budget, resumes, and a repeat of the whole request changes nothing more", async () => {
    const world = makeWorld();
    seedErasure(world);
    const first = await eraseLearningSubject(world.deps, TEST_ORG, "dev1", { writes: 3 });
    expect(first.status).toBe("running");
    expect(walkOf(world, "erase#dev1")).toMatchObject({ status: "running" });
    let last = first;
    for (let run = 0; run < 20 && last.status !== "done"; run += 1) last = await eraseLearningSubject(world.deps, TEST_ORG, "dev1", { writes: 3 });
    expect(last.status).toBe("done");
    expect(walkOf(world, "erase#dev1")).toBeUndefined();
    const snapshot = JSON.stringify(partition(world, "web").sort((a, b) => (a.sk < b.sk ? -1 : 1)));
    const repeat = await eraseLearningSubject(world.deps, TEST_ORG, "dev1");
    expect(repeat.status).toBe("done");
    expect(JSON.stringify(partition(world, "web").sort((a, b) => (a.sk < b.sk ? -1 : 1)))).toBe(snapshot);
  });

  it("holds no text in the walk item", async () => {
    const world = makeWorld();
    seedErasure(world);
    await eraseLearningSubject(world.deps, TEST_ORG, "dev1", { writes: 2 });
    expect(JSON.stringify(walkOf(world, "erase#dev1"))).not.toContain("words");
  });

  it("the erase hook answers only when the walk finished: an unfinished walk is an error, and a repeat resumes it", async () => {
    const world = makeWorld();
    seedErasure(world);
    const hook = learningEraseHook(world.deps, { writes: 3 });
    await expect(hook(TEST_ORG, "dev1")).rejects.toMatchObject({ name: "LearningEraseUnfinished" });
    let finished = false;
    for (let run = 0; run < 20 && !finished; run += 1) finished = await hook(TEST_ORG, "dev1").then(() => true, () => false);
    expect(finished).toBe(true);
    expect(find(world, "web", "#c1")).toMatchObject({ author: "erased" });
  });
});
