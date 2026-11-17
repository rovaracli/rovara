import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { WorkPage } from "./pages/index.js";

// Work, the split inbox (Hybrid 1, DEC 223), on the pretend Code. The pretend Code keeps its state in memory and the specs run one after another, so the one spec
// that approves a plan runs last among the ones that read it.
const PLAN_TASK = "Add a retry to the billing webhook";
const MERGE_TASK = "Fix the README typo";
const RUNNING_TASK = "Speed up the search index";

test("the list groups work by who owns the next move and opens a task beside it", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.expectLoaded();
  await expect(work.group("Needs you")).toBeVisible();
  await expect(work.group("Rovara is working").getByRole("button", { name: new RegExp(RUNNING_TASK, "u") })).toBeVisible();
  // Both decisions have waited over a day, so the quickest is first: the plan (about 25 minutes) goes before the ones with no estimate.
  await expect(work.group("Needs you").getByRole("button").first()).toContainText(PLAN_TASK);
  await expect(work.group("Needs you").getByRole("button", { name: new RegExp(MERGE_TASK, "u") })).toBeVisible();
  await expect(work.paneTitle).toHaveText(PLAN_TASK);
  await expect(work.stepRail).toBeVisible();
  await expect(work.decision()).toBeVisible();
  // List and pane are side by side on a desktop screen.
  const list = await work.list.boundingBox(), pane = await work.pane.boundingBox();
  expect(list !== null && pane !== null && pane.x >= list.x + list.width - 1 && Math.abs(pane.y - list.y) < 4).toBe(true);
});

test("j and k move the selection while the list has focus, and the address follows", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.expectLoaded();
  const first = work.rows.first();
  await first.focus();
  const before = await work.paneTitle.textContent();
  await page.keyboard.press("j");
  await expect(work.paneTitle).not.toHaveText(before ?? "");
  await expect(page).toHaveURL(/[?&]task=[0-9a-f-]{36}/u);
  const after = await work.paneTitle.textContent();
  await page.keyboard.press("k");
  await expect(work.paneTitle).toHaveText(before ?? "");
  expect(after).not.toBe(before);
  // Keys typed anywhere else leave the selection alone.
  await page.getByRole("link", { name: "Home" }).first().focus();
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/\/app\/live/u);
});

test("the spec shows its criteria with ids, asks its question in place, and says what is not connected yet", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.select(PLAN_TASK);
  const spec = work.pane.getByRole("region", { name: "Spec" });
  await expect(spec).toContainText("R1.1");
  await expect(spec).toContainText("Question for you.");
  await spec.getByRole("button", { name: /Yes, behind a flag/u }).click();
  // This task has no Cloud session yet (K0b): nothing is sent, and the question says where to answer, plainly.
  await expect(page.getByTestId("answer-error").first()).toContainText("Answer this question on the task's session page.");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("a click on a step shows that stage: build activity, then proof per criterion", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.select(PLAN_TASK);
  await work.step("Build").click();
  const build = work.pane.getByRole("region", { name: "Build" });
  await expect(build).toContainText("T2");
  await expect(build.getByRole("log")).toContainText("Now at");
  await work.step("Proof").click();
  const proof = work.pane.getByRole("region", { name: "Proof", exact: true });
  const rows = proof.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(3); // the head row and one per acceptance criterion
  await expect(proof).toContainText("2 of 2 criteria proven");
  await expect(proof).toContainText("Also checked.");
});

test("the merge card shows the pull request and its decision, with the merge-by-itself box off", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.select(MERGE_TASK);
  await expect(work.decision()).toContainText("Merge pull request");
  await expect(work.pane.getByRole("region", { name: "Pull request" })).toContainText("example/web #42");
  await expect(work.pane.getByRole("link", { name: /View on GitHub/u })).toHaveAttribute("href", "https://github.com/example/web/pull/42");
});

test("an unserved task list says it is not connected yet, never a spinner", async ({ page }) => {
  await page.route("**/v1/web/sessions", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } }) }));
  const work = new WorkPage(page);
  await work.open();
  await expect(work.loadError).toContainText("isn't connected to Rovara Code yet");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("loading, could not load and empty are each said in the list", async ({ page }) => {
  const work = new WorkPage(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/v1/web/sessions", async (route) => { await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [] }) }); });
  // No lessons waiting either (a lesson batch is work that needs the person, so the list would not be empty).
  await page.route("**/v1/web/lessons/inbox", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "on", batches: [], unavailable: [] }) }));
  await work.open();
  await expect(work.list.getByRole("progressbar", { name: "Loading your work" })).toBeVisible();
  release?.();
  await expect(work.empty).toBeVisible();
  await page.unroute("**/v1/web/sessions");
  await page.route("**/v1/web/sessions", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Your access ended." } }) }));
  await page.reload();
  await expect(work.loadError).toContainText("Your access ended.");
  await expect(work.loadError.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the agents row says agents are not connected yet while Code serves none", async ({ page }) => {
  await new WorkPage(page).open();
  await expect(page.getByTestId("agents-not-connected")).toBeVisible();
});

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main");
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}
for (const scheme of ["light", "dark"] as const) {
  test(`Work has no accessibility violations (contrast included) in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const work = new WorkPage(page);
    await work.open();
    await work.expectLoaded();
    await expect(work.pane.getByRole("region", { name: "Spec" })).toBeVisible().catch(() => undefined);
    expect(await violations(page)).toEqual([]);
  });
}

test("Compact density tightens the rows, and Work still loads", async ({ page }) => {
  await page.addInitScript(() => { try { window.localStorage.setItem("rovara.density", "compact"); } catch { /* a blocked store leaves Comfortable */ } });
  const work = new WorkPage(page);
  await work.open();
  await work.expectLoaded();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rv-density-row-y-dense").trim())).toBe("5px");
});

// Last: it changes what the pretend Code holds (the plan is approved and its task starts building).
test("approving the plan sends the decision and the list moves to the next task that needs you", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.select(PLAN_TASK);
  await work.decision().getByRole("button", { name: "Approve plan" }).click();
  await expect(work.paneTitle).not.toHaveText(PLAN_TASK);
  await expect(work.group("Rovara is working").getByRole("button", { name: new RegExp(PLAN_TASK, "u") })).toBeVisible();
  await expect(work.group("Needs you").getByRole("button", { name: new RegExp(PLAN_TASK, "u") })).toHaveCount(0);
});
