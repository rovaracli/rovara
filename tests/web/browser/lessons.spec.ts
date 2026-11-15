import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { LessonsPage, PROJECT, setLessons } from "./pages/index.js";

// The lessons screens (DEC 231) on the pretend Code, which serves Code's lessons API (#713) for project "web": three proposed lessons (one from Priya's own correction,
// one that lapses within a day), two approved, one retired, and two lessons given to the pull-request task. Priya decides. Off is the pretend Code's switch.
const PR_TASK = "44444444-4444-4444-8444-444444444444";
test.afterEach(async ({ page }) => { await setLessons(page, true); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main");
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}

test("Work shows one row for the week's lessons under Needs you, and its card has Keep, Edit and Drop with the expiry warning", async ({ page }) => {
  const lessons = new LessonsPage(page);
  await lessons.openWork();
  const row = lessons.batchRow(PROJECT);
  await expect(row).toContainText("3 lessons from this week's corrections");
  await expect(row).toContainText("1 lapses soon");
  await row.click();
  await expect(lessons.batch).toBeVisible();
  await expect(page).toHaveURL(/task=lessons(%3A|:)web/u);
  // Priya's own corrections first.
  await expect(lessons.batch.getByRole("article").first()).toContainText("From your correction");
  await expect(lessons.lesson("Put new tests next to the module").getByTestId("lesson-expiry-soon")).toContainText("if nobody decides");
  await expect(lessons.lesson("Wrap webhook calls in withRetry").getByRole("radio", { name: /Keep/u })).toBeVisible();
});

test("How we work has a Learned section with the mode, the approved lessons and their honest counts", async ({ page }) => {
  const lessons = new LessonsPage(page);
  await lessons.openHowWeWork(PROJECT);
  await expect(lessons.learned.getByRole("heading", { name: "Learned" })).toBeVisible();
  await expect(lessons.learned.getByRole("group", { name: "Learning" }).getByRole("radio", { name: "Suggest" })).toBeChecked();
  await expect(lessons.learned).toContainText("Log request ids with every error");
  await expect(lessons.learned).toContainText("Loaded 14 times · 3 helpful · 1 not helpful · learned from 3 tasks");
  await expect(lessons.learned).not.toContainText(/used in \d+ tasks/u);
  // The old Lessons tab is gone; its address opens How we work.
  await expect(page.getByRole("tab", { name: "Lessons", exact: true })).toHaveCount(0);
  await page.goto(`/app/projects/${PROJECT}?tab=lessons`);
  await expect(lessons.learned).toBeVisible();
});

test("the task page lists the lessons used, with why, the citation and the marks", async ({ page }) => {
  const lessons = new LessonsPage(page);
  await lessons.openTask(PR_TASK);
  await expect(lessons.used).toContainText("Log request ids with every error");
  await expect(lessons.used).toContainText("Why: It covers this part of the project");
  await expect(lessons.used).toContainText("3 helpful · 1 not helpful, across all tasks");
  await expect(lessons.used).toContainText("A lesson from a source you can't see");
});

test("every lessons screen is calm when Code says lessons are off", async ({ page }) => {
  await setLessons(page, false);
  const lessons = new LessonsPage(page);
  await lessons.openWork();
  await expect(page.getByRole("region", { name: "Work list" }).locator(".rv-inbox-row").first()).toBeVisible();
  await expect(lessons.batchRow(PROJECT)).toHaveCount(0);
  await expect(page.getByTestId("lessons-unavailable")).toHaveCount(0);
  await lessons.openHowWeWork(PROJECT);
  await expect(lessons.learned.getByTestId("lessons-off")).toContainText("Lessons are off.");
  await expect(lessons.learned.getByRole("alert")).toHaveCount(0);
  await lessons.openTask(PR_TASK);
  await expect(lessons.used.getByTestId("lessons-off")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the lessons screens have no accessibility violations (contrast included) in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const lessons = new LessonsPage(page);
    await lessons.openWork();
    await lessons.batchRow(PROJECT).click();
    await lessons.lesson("Put new tests next to the module").getByRole("radio", { name: /Drop/u }).check();
    await lessons.lesson("Wrap webhook calls in withRetry").getByRole("radio", { name: /Edit/u }).check();
    expect(await violations(page)).toEqual([]);
    await lessons.openHowWeWork(PROJECT);
    await expect(lessons.learned).toContainText("Log request ids with every error");
    expect(await violations(page)).toEqual([]);
    await lessons.learned.getByRole("tab", { name: "Proposed" }).click();
    await expect(lessons.learned).toContainText("if nobody decides");
    expect(await violations(page)).toEqual([]);
    await lessons.openTask(PR_TASK);
    await expect(lessons.used).toContainText("Log request ids with every error");
    expect(await violations(page)).toEqual([]);
  });
}

// Last: it changes what the pretend Code holds (the batch is decided).
test("sending the batch decides each lesson in one call and shows what happened to each", async ({ page }) => {
  const lessons = new LessonsPage(page);
  await lessons.openWork();
  await lessons.batchRow(PROJECT).click();
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/lessons/decisions")) posts.push(request.postData() ?? ""); });
  await lessons.lesson("Wrap webhook calls in withRetry").getByRole("radio", { name: /Edit/u }).check();
  await lessons.lesson("Wrap webhook calls in withRetry").getByRole("textbox", { name: "Title" }).fill("Wrap every webhook call in withRetry");
  await lessons.lesson("Put new tests next to the module").getByRole("radio", { name: /Drop/u }).check();
  await lessons.lesson("Put new tests next to the module").getByRole("combobox", { name: "Why drop it" }).selectOption("too_narrow");
  // K keeps the lesson that has focus.
  await lessons.lesson("Use the shared date formatter").getByRole("radio", { name: /Drop/u }).focus();
  await page.keyboard.press("k");
  await expect(lessons.lesson("Use the shared date formatter").getByRole("radio", { name: /Keep/u })).toBeChecked();
  await lessons.batch.getByRole("button", { name: "Send 3 decisions" }).click();
  await expect(lessons.results).toContainText("Kept. Rovara uses it in tasks from now on.");
  await expect(lessons.results).toContainText("Dropped.");
  await expect(lessons.results).toContainText("waits for one more person");
  expect(posts).toHaveLength(1);
  await expect(page.getByTestId("lesson-batch-done")).toBeVisible();
  await lessons.batch.getByRole("button", { name: "Done" }).click();
  await expect(lessons.batchRow(PROJECT)).toContainText("1 lesson");
});
