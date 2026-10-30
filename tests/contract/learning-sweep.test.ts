// v1.2 learning loop, B1: the learning sweep (design §3.2), for tables without a TTL. It deletes learning items whose indexExpiresAt has passed, within a budget, and resumes.
import { describe, expect, it, vi } from "vitest";
import { expireLearningItems } from "../../packages/broker/src/learning/sweep.js";
import { learningWalkKey, projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { indexSweepWanted } from "../../packages/broker/src/aws/index-expiry.js";
import { DAY_MS, NOW_MS, ORG_B, PROJECT_CREATED, epochSeconds, iso, makeWorld, seedCorrection, seedItem, seedProject } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

const DAY180 = 180 * 86_400;
const sweep = (world: ReturnType<typeof makeWorld>, limits?: Parameters<typeof expireLearningItems>[5]) => expireLearningItems(world.db, "state", TEST_ORG, new Date(world.clock.ms), () => undefined, limits);
const sks = (world: ReturnType<typeof makeWorld>, project = "web") => world.db.find((item) => item.pk === projectLearningKey(TEST_ORG, project, "STATE").pk).map((item) => String(item.sk)).sort();

describe("learning sweep", () => {
  it("deletes items past 180 days of every expiring kind, and keeps the ones inside it and the kinds that never expire", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    const created = NOW_MS - 181 * DAY_MS; // 181 days old: expired one day ago
    const expired = epochSeconds(created) + DAY180;
    const projectCreatedAt = iso(created - DAY_MS);
    const inside = (sk: string, extra: Record<string, unknown> = {}) => seedItem(world.db, TEST_ORG, "web", sk, { projectCreatedAt, indexExpiresAt: epochSeconds(NOW_MS) + 5 * 86400, ...extra });
    const old = (sk: string, extra: Record<string, unknown> = {}) => seedItem(world.db, TEST_ORG, "web", sk, { projectCreatedAt, indexExpiresAt: expired, ...extra });
    old("CORRECTION#a#1", { text: "old text" }); old("SOURCE#k1"); old("DISMISSED#h1"); old("DAILY#2026-04-01#1"); old("RATE#dev#1#1");
    old("SUGGESTION#done", { status: "dismissed", terminalAt: iso(created) });
    inside("CORRECTION#b#2", { text: "fresh text" });
    seedItem(world.db, TEST_ORG, "web", "STATE", { projectCreatedAt, revision: 1, openSuggestions: 0, liveCorrections: 1, pendingRules: 0 });
    seedItem(world.db, TEST_ORG, "web", "SETTINGS", { projectCreatedAt, revision: 1, prComments: "on" });
    seedItem(world.db, TEST_ORG, "web", "RULE#r1", { projectCreatedAt, status: "active", text: "rule text" });
    seedItem(world.db, TEST_ORG, "web", "METRIC#2026-04", { projectCreatedAt, repeats: 1 });
    const result = await sweep(world);
    expect(result).toMatchObject({ deleted: 6, done: true });
    expect(sks(world)).toEqual(["CORRECTION#b#2", "METRIC#2026-04", "RULE#r1", "SETTINGS", "STATE"]);
  });

  it("deletes a 180-day-old correction the day after its expiry, and not on the day before", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    const sk = seedCorrection(world.db, TEST_ORG, "web", 1, { createdAtMs: NOW_MS });
    world.clock.ms = NOW_MS + 179 * DAY_MS;
    await sweep(world);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", sk))).toBeDefined();
    world.clock.ms = NOW_MS + 181 * DAY_MS;
    await sweep(world);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", sk))).toBeUndefined();
  });

  it("leaves no correction text behind once the items expired", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    for (let n = 0; n < 5; n += 1) seedCorrection(world.db, TEST_ORG, "web", n, { expiresAtSeconds: epochSeconds(NOW_MS) - 1, text: `secret wording ${n}` });
    await sweep(world);
    expect(JSON.stringify(world.db.find(() => true))).not.toContain("secret wording");
  });

  it("deletes at most 500 items a run, and the next run goes on from where the walk stopped", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    for (let n = 0; n < 520; n += 1) seedCorrection(world.db, TEST_ORG, "web", n, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    const keep = seedCorrection(world.db, TEST_ORG, "web", 9999);
    const first = await sweep(world);
    expect(first).toMatchObject({ deleted: 500, done: false });
    expect(world.db.get(learningWalkKey(TEST_ORG, "sweep"))).toMatchObject({ status: "running" });
    const second = await sweep(world);
    expect(second).toMatchObject({ deleted: 20, done: true });
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", keep))).toBeDefined();
    expect(world.db.find((item) => String(item.sk).startsWith("CORRECTION#"))).toHaveLength(1);
  });

  it("visits at most 50 projects a run, resumes from the cursor in the walk item, and starts over when it has finished", async () => {
    const world = makeWorld();
    const names = Array.from({ length: 60 }, (_, n) => `p${String(n).padStart(2, "0")}`);
    for (const name of names) {
      seedProject(world.db, TEST_ORG, name);
      seedCorrection(world.db, TEST_ORG, name, 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    }
    const first = await sweep(world);
    expect(first).toMatchObject({ deleted: 50, projectsDone: 50, done: false });
    expect(world.db.get(learningWalkKey(TEST_ORG, "sweep"))).toMatchObject({ status: "running", afterProject: "p49", projectsDone: 50 });
    const second = await sweep(world);
    expect(second).toMatchObject({ deleted: 10, done: true });
    expect(world.db.get(learningWalkKey(TEST_ORG, "sweep"))).toMatchObject({ status: "done" });
    // Items that expire later are found by the next lap.
    seedCorrection(world.db, TEST_ORG, "p00", 2, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    expect(await sweep(world)).toMatchObject({ deleted: 1, done: false });
    expect(await sweep(world)).toMatchObject({ deleted: 0, done: true });
  });

  it("takes the 20-second budget from the clock", async () => {
    const world = makeWorld();
    for (let n = 0; n < 6; n += 1) { seedProject(world.db, TEST_ORG, `p${n}`); seedCorrection(world.db, TEST_ORG, `p${n}`, 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 }); }
    // Each read of the clock moves it 4 seconds.
    const ticking = { ...world.deps, now: () => (world.clock.ms += 4000) };
    const result = await expireLearningItems(ticking.documentClient, "state", TEST_ORG, new Date(world.clock.ms), () => undefined, { now: ticking.now });
    expect(result.done).toBe(false);
    expect(result.projectsDone).toBeGreaterThan(0);
    expect(result.projectsDone).toBeLessThan(6);
  });

  it("brings the live counter down for the corrections it deletes", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedItem(world.db, TEST_ORG, "web", "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 0, liveCorrections: 5, pendingRules: 0 });
    for (let n = 0; n < 3; n += 1) seedCorrection(world.db, TEST_ORG, "web", n, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    for (let n = 3; n < 5; n += 1) seedCorrection(world.db, TEST_ORG, "web", n);
    await sweep(world);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", "STATE"))).toMatchObject({ liveCorrections: 2 });
  });

  it("expires an open suggestion whose sources fell below two, clearing its text, and keeps one that still has two", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedItem(world.db, TEST_ORG, "web", "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 2, liveCorrections: 4, pendingRules: 0 });
    const a = seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    seedCorrection(world.db, TEST_ORG, "web", 2); seedCorrection(world.db, TEST_ORG, "web", 3); seedCorrection(world.db, TEST_ORG, "web", 4);
    const suggestion = (id: string, ids: string[]) => seedItem(world.db, TEST_ORG, "web", `SUGGESTION#${id}`, {
      id, stage: "build", status: "open", correctionIds: ids, allFromOnePerson: false, proposedText: "Use the shared retry helper.", signature: ["h"], lessSafe: false, kinds: [], overlaps: [], revision: 0, createdAt: iso(NOW_MS), projectCreatedAt: PROJECT_CREATED,
    });
    suggestion("weak", ["c00001", "c00002"]);
    suggestion("strong", ["c00003", "c00004"]);
    expect(a).toContain("c00001");
    const result = await sweep(world);
    expect(result).toMatchObject({ expiredSuggestions: 1 });
    const weak = world.db.get(projectLearningKey(TEST_ORG, "web", "SUGGESTION#weak"))!;
    expect(weak).toMatchObject({ status: "expired", terminalAt: iso(NOW_MS), indexExpiresAt: epochSeconds(NOW_MS) + DAY180 });
    expect(weak).not.toHaveProperty("proposedText");
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", "SUGGESTION#strong"))).toMatchObject({ status: "open", proposedText: "Use the shared retry helper." });
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", "STATE"))).toMatchObject({ openSuggestions: 1 });
  });

  it("walks only this company's projects (I9)", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedProject(world.db, ORG_B, "web");
    seedCorrection(world.db, ORG_B, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    await sweep(world);
    expect(world.db.find((item) => item.pk === projectLearningKey(ORG_B, "web", "STATE").pk)).toHaveLength(1);
    expect(world.db.find((item) => item.pk === projectLearningKey(TEST_ORG, "web", "STATE").pk)).toHaveLength(0);
  });

  it("deletes an item only while it is still expired (a conditional delete)", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    const sk = seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1 });
    // The item is renewed between the sweep's read and its delete.
    world.db.injectFault({ command: "DeleteCommand", error: { name: "ConditionalCheckFailedException" } });
    const result = await sweep(world);
    expect(result.deleted).toBe(0);
    expect(world.db.get(projectLearningKey(TEST_ORG, "web", sk))).toBeDefined();
  });

  it("logs counts only", async () => {
    const world = makeWorld();
    seedProject(world.db, TEST_ORG, "web");
    seedCorrection(world.db, TEST_ORG, "web", 1, { expiresAtSeconds: epochSeconds(NOW_MS) - 1, text: "SECRET-WORDING" });
    const log = vi.fn();
    await expireLearningItems(world.db, "state", TEST_ORG, new Date(NOW_MS), log);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "learning_expiry.deleted", deleted: 1 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-WORDING");
  });

  it("runs only where the table has no TTL (the same guard as the index sweep)", () => {
    expect(indexSweepWanted({})).toBe(true);
    expect(indexSweepWanted({ INDEX_EXPIRY: "ttl" })).toBe(false);
  });
});
