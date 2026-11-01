// v1.2 learning loop, B5: the metric item and its view (design 4.3 and 6.4).
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ensureMetricCurrent, metricMonth, metricSk, metricUpdateItem, readMetric } from "../../packages/broker/src/learning/metric.js";
import { projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { PROJECT_CREATED, makeWorld, seedItem } from "../support/learning-world.js";

type TestWorld = ReturnType<typeof makeWorld>;
const metric = (world: TestWorld, month: string) => world.db.get(projectLearningKey(world.scope.orgId, world.scope.project, metricSk(month)));
const apply = (world: TestWorld, month: string, deltas: Parameters<typeof metricUpdateItem>[3]) =>
  world.db.send(new TransactWriteCommand({ TransactItems: [metricUpdateItem(world.deps, world.scope, month, deltas)] }));

describe("metric month and keys", () => {
  it("is the UTC year and month of the correction's createdAt", () => {
    expect(metricMonth("2026-10-31T23:59:59.999Z")).toBe("2026-10");
    expect(metricMonth("2026-11-01T00:00:00.000Z")).toBe("2026-11");
    expect(metricSk("2026-10")).toBe("METRIC#2026-10");
  });
});

describe("the metric view", () => {
  it("is not enough data below 10 member corrections, and then has a share", async () => {
    const world = makeWorld();
    seedItem(world.db, world.scope.orgId, world.scope.project, "METRIC#2026-10", { entityType: "LEARNING_METRIC", projectCreatedAt: PROJECT_CREATED, memberCorrections: 9, repeats: 3, repeatsOfAcceptedRules: 1 });
    expect(await readMetric(world.deps, world.scope, "2026-10", { prCaptureOff: false })).toMatchObject({ memberCorrections: 9, repeats: 3, repeatsOfAcceptedRules: 1, enoughData: false, share: null });
    seedItem(world.db, world.scope.orgId, world.scope.project, "METRIC#2026-10", { entityType: "LEARNING_METRIC", projectCreatedAt: PROJECT_CREATED, memberCorrections: 20, repeats: 5, repeatsOfAcceptedRules: 1 });
    expect(await readMetric(world.deps, world.scope, "2026-10", { prCaptureOff: false })).toMatchObject({ enoughData: true, share: 0.25 });
  });

  it("is zeros for a month with nothing, and ignores an earlier project's item", async () => {
    const world = makeWorld();
    expect(await readMetric(world.deps, world.scope, "2026-09", { prCaptureOff: false })).toMatchObject({ memberCorrections: 0, repeats: 0, enoughData: false, share: null });
    seedItem(world.db, world.scope.orgId, world.scope.project, "METRIC#2026-10", { entityType: "LEARNING_METRIC", projectCreatedAt: "2026-01-01T00:00:00.000Z", memberCorrections: 50, repeats: 40 });
    expect(await readMetric(world.deps, world.scope, "2026-10", { prCaptureOff: false })).toMatchObject({ memberCorrections: 0, repeats: 0 });
  });

  it("subtracts the PR counters while PR capture is off, never below zero", async () => {
    const world = makeWorld();
    seedItem(world.db, world.scope.orgId, world.scope.project, "METRIC#2026-10", {
      entityType: "LEARNING_METRIC", projectCreatedAt: PROJECT_CREATED, memberCorrections: 12, repeats: 6, repeatsOfAcceptedRules: 2, prMemberCorrections: 2, prRepeats: 2, prRepeatsOfAcceptedRules: 5,
    });
    expect(await readMetric(world.deps, world.scope, "2026-10", { prCaptureOff: true })).toMatchObject({ memberCorrections: 10, repeats: 4, repeatsOfAcceptedRules: 0 });
  });
});

describe("the update item", () => {
  it("adds the deltas, stamps the project, and starts a project created again from zero", async () => {
    const world = makeWorld();
    await ensureMetricCurrent(world.deps, world.scope, "2026-10");
    await apply(world, "2026-10", { memberCorrections: 1, repeats: 1 });
    await apply(world, "2026-10", { memberCorrections: 1, accepted: 1 });
    expect(metric(world, "2026-10")).toMatchObject({ memberCorrections: 2, repeats: 1, accepted: 1, projectCreatedAt: PROJECT_CREATED });
    const later = makeWorld({ db: world.db, projectCreatedAt: "2026-10-15T00:00:00.000Z" });
    await ensureMetricCurrent(later.deps, later.scope, "2026-10");
    await apply(later, "2026-10", { memberCorrections: 1 });
    expect(metric(later, "2026-10")).toMatchObject({ memberCorrections: 1, projectCreatedAt: "2026-10-15T00:00:00.000Z" });
    expect(metric(later, "2026-10")).not.toHaveProperty("repeats");
  });
});
