// Lead 4 J3 in the browser, on the pretend Code (which answers Code J1's answer route and the start box's suggestion for the project "web"): the Ask box at the bottom of the Wiki tab, the answer first
// with its sources and one fixed button, the fixed "not set up" outcome with nothing to press, the start box's routing (DEC 173), phone width, dark mode and the keyboard. The deployment's answers
// setting is on for this run (playwright.config.ts); the other specs see the pretend Code with no model set up, where the start box starts Quick as ever. Screenshots go to the test output folder.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { AskBox, PROJECT, ProjectPage, SessionPage, WikiPage, setAnswers } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setAnswers(page, PROJECT); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { rules: { "color-contrast": { enabled: false } } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}

test("the Ask box on the Wiki tab answers first, with sources, one wiki link and one fixed button", async ({ page }, testInfo) => {
  await setAnswers(page, PROJECT, { answers: "answered" });
  await new WikiPage(page).open(PROJECT);
  const ask = new AskBox(page);
  await expect(ask.box).toBeVisible();
  await ask.ask("How does a refund reach the customer?");
  await expect(ask.answer).toBeVisible();
  await expect(ask.answer).toContainText("Refunds go out to the payment provider and come back by webhook.");
  await expect(page.getByTestId("answer-sources")).toContainText("beacon-api/src/billing/refund.ts:12-40");
  await expect(page.getByTestId("answer-honesty")).toContainText("I checked the code: the wiki was out of date here.");
  // The one fixed action, and the small "Not right" control (lead 4 J5).
  await expect(ask.answer.getByRole("button")).toHaveCount(2);
  await expect(ask.answer.getByTestId("answer-not-right")).toBeVisible();
  await expect(ask.answer.getByRole("button", { name: "Start a Quick task" })).toBeVisible();
  await expect(ask.answer).not.toContainText(/\$|cost|confidence/iu);
  await page.screenshot({ path: testInfo.outputPath("answer-wiki-tab.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
});

test("'Start a Quick task' from an answer starts the task and opens its page", async ({ page }) => {
  await setAnswers(page, PROJECT, { answers: "answered" });
  await new WikiPage(page).open(PROJECT);
  const ask = new AskBox(page);
  await ask.ask("Can refunds be partial?");
  await ask.answer.getByRole("button", { name: "Start a Quick task" }).click();
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
});

test("with no model set up the answer is the fixed 'not set up' words and nothing to press", async ({ page }, testInfo) => {
  await new WikiPage(page).open(PROJECT);
  const ask = new AskBox(page);
  await ask.ask("How does a refund reach the customer?");
  await expect(ask.answer).toHaveText("Answers are not set up here yet.");
  await expect(ask.answer.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("answer-not-set-up.png"), fullPage: true });
});

test("a Code that does not serve answers shows the fixed words, not a dead end", async ({ page }) => {
  await setAnswers(page, PROJECT, { answers: "off" });
  await new WikiPage(page).open(PROJECT);
  const ask = new AskBox(page);
  await ask.ask("How does a refund reach the customer?");
  await expect(ask.error).toHaveText("Answers aren't available on this Rovara yet.");
});

test("the start box: a small change starts Quick at once; a question is answered and nothing starts; a larger change offers Full", async ({ page }, testInfo) => {
  const project = new ProjectPage(page);
  await setAnswers(page, PROJECT, { answers: "answered", suggest: { kind: "question", classifier: "ok", pick: "answer" } });
  await project.open(PROJECT);
  await project.text.fill("How do refunds work?");
  await project.start.click();
  await expect(page.getByTestId("answer")).toContainText("Refunds go out to the payment provider");
  await expect(page).not.toHaveURL(SessionPage.SHARE_ADDRESS);
  await page.screenshot({ path: testInfo.outputPath("start-box-answer.png"), fullPage: true });

  await setAnswers(page, PROJECT, { answers: "answered", suggest: { kind: "large_change", classifier: "ok", pick: "full" } });
  await project.open(PROJECT);
  await project.text.fill("Rewrite the billing module");
  await project.start.click();
  const card = new AskBox(page).card;
  await expect(card).toBeVisible();
  await expect(card.getByTestId("start-choice-full")).toContainText("suggested");
  await page.screenshot({ path: testInfo.outputPath("start-box-card.png"), fullPage: true });
  await card.getByTestId("start-choice-full").click();
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);

  await setAnswers(page, PROJECT, { suggest: { kind: "small_change", classifier: "ok", pick: "quick" } });
  await project.open(PROJECT);
  await project.startWork(`Fix a typo ${String(Date.now())}`);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
});

test("the keyboard asks and reads, and a phone-width screen shows the answer without sideways scrolling", async ({ page }, testInfo) => {
  await setAnswers(page, PROJECT, { answers: "answered" });
  await page.setViewportSize({ width: 390, height: 844 });
  await new WikiPage(page).open(PROJECT);
  const ask = new AskBox(page);
  await ask.text.fill("How does a refund reach the customer?");
  await ask.text.press("Control+Enter");
  await expect(ask.answer).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("answer-phone.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("answer-phone-dark.png"), fullPage: true });
});
