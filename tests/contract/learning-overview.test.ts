// v1.2 learning loop, B7: the overview's maintainer-only `learning` block (design 6.2 and 6.4): this month's repeats and corrections, last month's share, repeats after each accepted rule.
import { describe, expect, it } from "vitest";
import { ProjectOverviewSchema } from "../../packages/contracts/src/index.js";
import { projectOverview } from "../../packages/broker/src/agent-sessions/project-overview.js";
import { projectLearningKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { CELL, MAX, MIA, OLA, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";

const PC = "2026-10-02T00:00:00.000Z";

function world() {
  const w = sessionWorld();
  const put = (sk: string, fields: Record<string, unknown>) => w.db.set({ ...projectLearningKey(ORG_A, "web", sk), orgId: ORG_A, projectCreatedAt: PC, ...fields });
  const overview = (who: string) => projectOverview({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => { throw new Error("No task read expected"); }, projectPage: async (_caller, name) => ({ name, status: "active", repositories: [], setup: { status: "ready" }, channels: [] }),
  }, w.caller(who), "web");
  const correction = (n: number, month: string, fields: Record<string, unknown>) => put(`CORRECTION#${month}-1${String(n).padStart(1, "0")}T09:00:00.000Z#c${String(n)}`, {
    entityType: "LEARNING_CORRECTION", id: `c${String(n)}`, stage: "build", source: "comment", sourceRef: { taskId: `t${String(n)}` }, taskId: `t${String(n)}`, signature: ["h"], author: "dev1", standing: "member",
    createdAt: `${month}-1${String(n)}T09:00:00.000Z`, indexExpiresAt: 2_000_000_000, ...fields,
  });
  return { ...w, put, overview, correction };
}

describe("project overview, learning block", () => {
  it("gives a maintainer this month's repeats and corrections, last month's share, and the repeats after each accepted rule", async () => {
    const w = world();
    w.put("STATE", { revision: 2, openSuggestions: 0, liveCorrections: 5, pendingRules: 0 });
    w.put("METRIC#2026-10", { memberCorrections: 12, repeats: 3, repeatsOfAcceptedRules: 2 });
    w.put("METRIC#2026-09", { memberCorrections: 20, repeats: 5 });
    w.put("RULE#rule-1", { id: "rule-1", suggestionId: "s1", stage: "build", text: "Use the helper.", processAgentId: "agt_1", requestId: "q1", status: "active", processVersion: 3 });
    w.put("RULE#rule-2", { id: "rule-2", suggestionId: "s2", stage: "plan", text: "Name things well.", processAgentId: "agt_1", requestId: "q2", status: "removed", processVersion: 3 });
    w.correction(1, "2026-10", { repeatOf: "rule-1", groupedAt: "2026-10-20T00:00:00.000Z" });
    w.correction(2, "2026-10", { repeatOf: "rule-1", groupedAt: "2026-10-20T00:00:00.000Z" });
    w.correction(3, "2026-10", { repeatOf: "c1", groupedAt: "2026-10-20T00:00:00.000Z" });
    w.correction(4, "2026-10", { repeatOf: "rule-2", groupedAt: "2026-10-20T00:00:00.000Z" });
    w.correction(5, "2026-09", { repeatOf: "rule-1", groupedAt: "2026-09-20T00:00:00.000Z" });
    const view = await w.overview(MAX);
    expect(view.learning).toEqual({
      thisMonth: { repeats: 3, corrections: 12, enoughData: true }, lastMonthShare: 0.25,
      repeatsAfterRule: [{ ruleId: "rule-1", stage: "build", repeats: 2 }],
    });
    expect(ProjectOverviewSchema.safeParse(view).success).toBe(true);
    // An org admin is a maintainer of every project.
    expect((await w.overview(OLA)).learning).toBeDefined();
  });

  it("is absent for a contributor and a viewer", async () => {
    const w = world();
    w.put("METRIC#2026-10", { memberCorrections: 12, repeats: 3 });
    expect((await w.overview(PRIYA))).not.toHaveProperty("learning");
    expect((await w.overview(MIA))).not.toHaveProperty("learning");
  });

  it("says there is not enough data below 10 corrections, and a project with no learning yet has zeros and no last-month share", async () => {
    const w = world();
    expect((await w.overview(MAX)).learning).toEqual({ thisMonth: { repeats: 0, corrections: 0, enoughData: false }, repeatsAfterRule: [] });
    w.put("METRIC#2026-10", { memberCorrections: 4, repeats: 3 });
    w.put("METRIC#2026-09", { memberCorrections: 4, repeats: 2 });
    const view = await w.overview(MAX);
    expect(view.learning).toEqual({ thisMonth: { repeats: 3, corrections: 4, enoughData: false }, repeatsAfterRule: [] });
  });

  it("leaves a project created again with nothing old", async () => {
    const w = world();
    w.put("METRIC#2026-10", { memberCorrections: 12, repeats: 3, projectCreatedAt: "2026-01-01T00:00:00.000Z" });
    expect((await w.overview(MAX)).learning).toEqual({ thisMonth: { repeats: 0, corrections: 0, enoughData: false }, repeatsAfterRule: [] });
  });
});

describe("project overview, learning block: bounded reads", () => {
  it("labels the repeats after a rule '500+' when the corrections read hit the cap, and leaves the label out below it", async () => {
    const w = world();
    w.put("STATE", { revision: 2, openSuggestions: 0, liveCorrections: 520, pendingRules: 0 });
    w.put("METRIC#2026-10", { memberCorrections: 520, repeats: 520 });
    w.put("RULE#rule-1", { id: "rule-1", suggestionId: "s1", stage: "build", text: "Use the helper.", processAgentId: "agt_1", requestId: "q1", status: "active", processVersion: 3 });
    for (let n = 0; n < 3; n += 1) w.correction(n + 1, "2026-10", { repeatOf: "rule-1", groupedAt: "2026-10-20T00:00:00.000Z" });
    expect((await w.overview(MAX)).learning).not.toHaveProperty("repeatsAfterRuleLabel");
    for (let n = 0; n < 520; n += 1) {
      const id = `x${String(n).padStart(4, "0")}`;
      w.put(`CORRECTION#2026-10-20T09:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z#${id}`, {
        entityType: "LEARNING_CORRECTION", id, stage: "build", source: "comment", sourceRef: { taskId: id }, taskId: id, signature: ["h"], author: "dev1", standing: "member",
        createdAt: "2026-10-20T09:00:00.000Z", indexExpiresAt: 2_000_000_000, repeatOf: "rule-1", groupedAt: "2026-10-20T00:00:00.000Z",
      });
    }
    const view = await w.overview(MAX);
    expect(view.learning?.repeatsAfterRule).toEqual([{ ruleId: "rule-1", stage: "build", repeats: 500 }]);
    expect(view.learning).toMatchObject({ repeatsAfterRuleLabel: "500+" });
    expect(ProjectOverviewSchema.safeParse(view).success).toBe(true);
  });

  it("gives up after its time limit: a read that never answers does not hold the overview", async () => {
    const { learningOverviewBlock } = await import("../../packages/broker/src/learning/overview-block.js");
    const hung = { documentClient: { send: () => new Promise<never>(() => undefined) }, tableName: "state", now: () => Date.parse("2026-10-30T10:00:00.000Z") };
    const started = Date.now();
    await expect(learningOverviewBlock(hung as never, { orgId: ORG_A, project: "web", projectCreatedAt: PC }, { millis: 50 })).rejects.toMatchObject({ name: "LearningOverviewTimeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("leaves the block out of the page, and the page answers, when the block times out", async () => {
    const w = world();
    // The page read itself uses the same table; only the learning reads hang.
    const real = w.db;
    const documentClient = { send: (command: { input?: { Key?: { pk?: string }; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      const text = JSON.stringify(command.input ?? {});
      return text.includes("PROJECT_LEARNING") ? new Promise<never>(() => undefined) : real.send(command as never);
    } };
    const view = await projectOverview({
      documentClient: documentClient as never, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async () => { throw new Error("No task read expected"); }, projectPage: async (_caller: unknown, name: string) => ({ name, status: "active", repositories: [], setup: { status: "ready" }, channels: [] }),
      learningMillis: 50,
    } as never, w.caller(MAX), "web");
    expect(view).not.toHaveProperty("learning");
    expect(view.project.name).toBe("web");
  });
});
