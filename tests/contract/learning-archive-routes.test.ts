// v1.2 learning loop: the archive routes clear the project's learning data. Archiving does ONE bounded page inline (so the request answers quickly whatever the project holds); a project with
// more leaves an entry in the index of open walks, and the scheduled run (`resumeOpenLearningWalks`) finishes the clear without touching what a project created again has written since.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ARCHIVE_INLINE_WRITES, clearArchivedProjectLearning, resumeOpenLearningWalks } from "../../packages/broker/src/learning/cleanup.js";
import { WALK_INDEX_PK } from "../../packages/broker/src/learning/walk.js";
import { projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { OMAR, createSingleAnswerPlanBroker, seedMembership } from "../support/developer-task-broker.js";
import { PROJECT_CREATED, seedCorrection, seedItem } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const partition = (h: Harness, project = "payments") => h.db.find((item) => item.pk === projectLearningKey(TEST_ORG, project, "STATE").pk);
const indexed = (h: Harness) => h.db.find((item) => item.pk === WALK_INDEX_PK);
const deletes = (h: Harness) => h.db.commandNames().filter((name) => name === "DeleteCommand").length;

function seed(h: Harness, corrections: number, project = "payments"): void {
  seedItem(h.db, TEST_ORG, project, "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 0, liveCorrections: corrections, pendingRules: 0 });
  for (let n = 0; n < corrections; n += 1) seedCorrection(h.db, TEST_ORG, project, n);
}
async function install(corrections: number): Promise<Harness> {
  const h = await createSingleAnswerPlanBroker();
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  seed(h, corrections);
  return h;
}
const sweepDeps = (h: Harness) => ({ documentClient: h.db, tableName: "state", now: () => Date.now() });

describe("POST /v1/app/projects/{name}/archive clears the learning data", () => {
  it("deletes a small project's learning items, and leaves another project's alone", async () => {
    const h = await install(5);
    seed(h, 3, "ops");
    const answer = await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId: randomUUID() });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(partition(h)).toEqual([]);
    expect(partition(h, "ops")).toHaveLength(4);
    expect(indexed(h)).toEqual([]);
  });

  it("does one bounded page inline for a large project, answers, and the scheduled run finishes the rest", async () => {
    const h = await install(300);
    const before = deletes(h);
    const answer = await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId: randomUUID() });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.project).toMatchObject({ name: "payments", status: "archived" });
    // The request itself spent one page of deletes, not the whole partition.
    expect(deletes(h) - before).toBeLessThanOrEqual(ARCHIVE_INLINE_WRITES);
    const left = partition(h).length;
    expect(left).toBeGreaterThan(150);
    expect(indexed(h)).toEqual([expect.objectContaining({ orgId: TEST_ORG, kind: "clear#payments" })]);

    const tick = await resumeOpenLearningWalks(sweepDeps(h));
    expect(tick).toMatchObject({ walks: 1, done: 1, running: 0, failed: 0 });
    expect(partition(h)).toEqual([]);
    expect(indexed(h)).toEqual([]);
  });

  it("finishes over several ticks when one tick's budget is small", async () => {
    const h = await install(300);
    await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId: randomUUID() });
    let ticks = 0;
    while (indexed(h).length > 0 && ticks < 20) { await resumeOpenLearningWalks(sweepDeps(h), { writes: 60 }); ticks += 1; }
    expect(ticks).toBeGreaterThan(1);
    expect(partition(h)).toEqual([]);
  });

  it("never deletes what a project created again under the same name wrote after the archive", async () => {
    const h = await install(300);
    await h.dev(OMAR, "POST", "/v1/app/projects/payments/archive", { requestId: randomUUID() });
    expect(indexed(h)).toHaveLength(1);
    const recreated = new Date(Date.now() + 60_000).toISOString();
    seedItem(h.db, TEST_ORG, "payments", "STATE", { projectCreatedAt: recreated, revision: 1, openSuggestions: 0, liveCorrections: 0, pendingRules: 0 });
    seedItem(h.db, TEST_ORG, "payments", "RULE#new", { projectCreatedAt: recreated, id: "new", status: "active", text: "New project rule." });
    await resumeOpenLearningWalks(sweepDeps(h));
    expect(partition(h).map((item) => item.sk).sort()).toEqual(["RULE#new", "STATE"]);
    expect(indexed(h)).toEqual([]);
  });
});

describe("clearArchivedProjectLearning", () => {
  it("answers done and writes no index entry when the inline page is enough", async () => {
    const h = await install(10);
    expect(await clearArchivedProjectLearning(sweepDeps(h), TEST_ORG, "payments")).toBe("done");
    expect(indexed(h)).toEqual([]);
  });
});
