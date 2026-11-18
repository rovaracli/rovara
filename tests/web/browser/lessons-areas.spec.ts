import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { LessonsPage, PROJECT, WikiPage, setFakePerson, setLessons, setWiki } from "./pages/index.js";

// Lead 4 L4-LP3W in the browser, on the pretend Code (which serves Code's lessons-by-area read, "Where Rovara learns from" with its Pause, and the wiki page's team lessons): Learned by code area, the
// sources list with a pause that holds, and a wiki module page's "Team lessons for this area" with Ask to retire; contrast and structure in both themes, and a phone width without sideways scroll.
// Screenshots go to SHOT_DIR when it is set (else the test output folder).
const SHOT_DIR = process.env["LESSONS_AREAS_SHOT_DIR"];
if (SHOT_DIR !== undefined) mkdirSync(SHOT_DIR, { recursive: true });
const shot = (testInfo: { outputPath(name: string): string }, name: string) => (SHOT_DIR === undefined ? testInfo.outputPath(name) : `${SHOT_DIR}/${name}`);

test.afterEach(async ({ page }) => { await setLessons(page, true); await setWiki(page, PROJECT); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`Learned opens by code area, picks a folder, and lists where Rovara learns from, in ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    const lessons = new LessonsPage(page);
    await lessons.openHowWeWork(PROJECT);
    const areas = lessons.learned.getByTestId("areas");
    await expect(areas.getByRole("navigation", { name: "Code areas" })).toBeVisible();
    await expect(areas.getByRole("button", { name: /^Whole project\s*1$/u })).toBeVisible();
    await areas.getByRole("button", { name: /^server\/\s*1$/u }).click();
    await expect(lessons.learned.getByTestId("area-title")).toContainText("web/src/server/");
    await expect(lessons.learned.getByRole("list", { name: "Lessons for web/src/server/" })).toContainText("Log request ids with every error");
    const sources = lessons.learned.getByTestId("learning-sources");
    await expect(sources.getByRole("heading", { name: "Where Rovara learns from" })).toBeVisible();
    await expect(sources.getByTestId("source-counts-pr_edits")).toHaveText("12 seen · 5 suggested · 3 kept (60% of suggestions)");
    await expect(sources.getByRole("link", { name: "Log request ids with every error" })).toBeVisible();
    await page.screenshot({ path: shot(testInfo, `learned-by-area-${scheme}.png`), fullPage: true });
    expect(await violations(page)).toEqual([]);
  });

  test(`a wiki module page shows the team's lessons for its area, with Ask to retire, in ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setFakePerson(page, "sam");
    const wiki = new WikiPage(page);
    await wiki.open(PROJECT, "beacon-api--billing");
    const team = page.getByTestId("team-lessons");
    await expect(team.getByRole("heading", { name: "Team lessons for this area (2)" })).toBeVisible();
    await expect(team).toContainText("L-les_retry0001");
    await expect(team).toContainText("Agents are told them as notes, not commands");
    await expect(team.getByRole("button", { name: "Ask to retire: Wrap webhook calls in withRetry" })).toBeVisible();
    await page.screenshot({ path: shot(testInfo, `wiki-team-lessons-${scheme}.png`), fullPage: true });
    expect(await violations(page)).toEqual([]);
    await team.getByRole("button", { name: "Ask to retire: Wrap webhook calls in withRetry" }).click();
    await expect(team).toContainText("Asked. The people who decide lessons will see your request.");
  });
}

test("pausing a source holds it (the row says so and the switch stays on, after a reload too) and resuming puts it back", async ({ page }, testInfo) => {
  const lessons = new LessonsPage(page);
  await lessons.openHowWeWork(PROJECT);
  const sources = lessons.learned.getByTestId("learning-sources");
  const pause = sources.getByRole("switch", { name: "Pause Edits to Rovara's pull requests" });
  await pause.click();
  await expect(sources.getByRole("switch", { name: "Resume Edits to Rovara's pull requests" })).toBeChecked();
  await expect(sources.locator('[data-source="pr_edits"]')).toContainText("Paused. New suggestions from this wait until you resume it");
  await page.screenshot({ path: shot(testInfo, "sources-paused.png"), fullPage: true });
  await page.reload();
  await expect(lessons.learned.getByTestId("learning-sources").getByRole("switch", { name: "Resume Edits to Rovara's pull requests" })).toBeChecked();
  await lessons.learned.getByTestId("learning-sources").getByRole("switch", { name: "Resume Edits to Rovara's pull requests" }).click();
  await expect(lessons.learned.getByTestId("learning-sources").getByRole("switch", { name: "Pause Edits to Rovara's pull requests" })).not.toBeChecked();
});

test("on a phone the tree and the sources list do not scroll sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const lessons = new LessonsPage(page);
  await lessons.openHowWeWork(PROJECT);
  await expect(lessons.learned.getByTestId("areas")).toBeVisible();
  await expect(lessons.learned.getByTestId("learning-sources")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: shot(testInfo, "learned-by-area-phone.png"), fullPage: true });
});
