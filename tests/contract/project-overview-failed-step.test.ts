// A failed setup check with a long error must not take the project's page down: the overview clamps a failing step stored before the writer kept to the 300-character
// cap, and a page that still fails the contract says which fields in one structured line (paths and codes only) before it answers "can't be shown".
import { describe, expect, it } from "vitest";
import { ProjectOverviewSchema } from "@rovara-code/contracts";
import { projectOverview } from "../../packages/broker/src/agent-sessions/project-overview.js";
import type { ProjectPageParts } from "../../packages/broker/src/agent-sessions/project-overview.js";
import { sessionWorld, MAX, CELL } from "../support/agent-session-world.js";

const overviewOf = (page: (name: string) => ProjectPageParts, log?: (entry: Record<string, unknown>) => void) => {
  const w = sessionWorld();
  return projectOverview({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => { throw new Error("No task read expected"); }, projectPage: async (_caller, name) => page(name), ...(log === undefined ? {} : { log }),
  }, w.caller(MAX), "web");
};
const failedPage = (failedStep: string) => (name: string): ProjectPageParts => ({ name, status: "active", repositories: [], setup: { status: "failed", failedStep }, channels: [] });

describe("the project overview and a long failing step", () => {
  it("answers a project whose stored failing step is 343 characters, with the step cut to 300 and ending in an ellipsis", async () => {
    const stored = `test: npm test - ${"x".repeat(343 - "test: npm test - ".length)}`;
    expect(stored).toHaveLength(343);
    const result = await overviewOf(failedPage(stored));
    const step = result.project.setup.failedStep!;
    expect(step).toHaveLength(300);
    expect(step.endsWith("…")).toBe(true);
    expect(step.startsWith("test: npm test - xxx")).toBe(true);
    expect(ProjectOverviewSchema.safeParse(result).success).toBe(true);
  });

  it("leaves a failing step of 300 characters or fewer exactly as stored", async () => {
    const stored = `setup: npm ci - ${"y".repeat(300 - "setup: npm ci - ".length)}`;
    expect((await overviewOf(failedPage(stored))).project.setup.failedStep).toBe(stored);
  });

  it("never cuts a character in two when the clamp falls inside one", async () => {
    const stored = `test: ${"😀".repeat(200)}`;
    const step = (await overviewOf(failedPage(stored))).project.setup.failedStep!;
    expect(step.length).toBeLessThanOrEqual(300);
    expect(step).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  });

  it("logs one structured line with the failing paths and codes only when the page does not match its contract, then refuses", async () => {
    const secret = "xoxb-planted-description-secret";
    const lines: Array<Record<string, unknown>> = [];
    const bad = (name: string): ProjectPageParts => ({ name, description: `${secret} ${"d".repeat(2_100)}`, status: "active", repositories: [{ fullName: "", defaultBranch: "main" }], setup: { status: "ready" }, channels: [] });
    await expect(overviewOf(bad, (entry) => lines.push(entry))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ event: "project_overview.invalid", issues: expect.arrayContaining([{ path: "project.description", code: "too_big" }, { path: "project.repositories.0.fullName", code: "too_small" }]) as unknown });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("main");
    expect(Object.keys((lines[0]!.issues as Array<Record<string, unknown>>)[0]!).sort()).toEqual(["code", "path"]);
  });

  it("logs to the console as a broker line when no logger is given", async () => {
    const original = console.log;
    const printed: string[] = [];
    console.log = (line: unknown) => { printed.push(String(line)); };
    try {
      await expect(overviewOf((name) => ({ name, status: "active", repositories: [{ fullName: "", defaultBranch: "main" }], setup: { status: "ready" }, channels: [] }))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    } finally { console.log = original; }
    const line = JSON.parse(printed.find((text) => text.includes("project_overview.invalid"))!) as Record<string, unknown>;
    expect(line).toMatchObject({ component: "broker", event: "project_overview.invalid" });
  });
});
