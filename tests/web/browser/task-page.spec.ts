import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, ProjectPage, SessionPage, WorkPage } from "./pages/index.js";

// The task on its own page (Hybrid 1's full view, DEC 223), on the pretend Code: the Work pane at full width with the steer box, the stop and continue actions,
// comments on spec passages and the history. A task started in Cloud has a session (steer, stop and comments go through it); a seeded task has only its id.
const PLAN_TASK = "Add a retry to the billing webhook";
const RUNNING_TASK = "Speed up the search index";
const TASK_ADDRESS = /\/app\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

async function openFromWork(page: Page, title: string): Promise<SessionPage> {
  const work = new WorkPage(page);
  await work.open();
  await work.select(title);
  await work.fullPage.click();
  const task = new SessionPage(page);
  await expect(task.title).toHaveText(title);
  return task;
}

test("the Work pane opens the task on its own page, with the pane at full width and a way back", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.select(PLAN_TASK);
  const narrow = await work.pane.boundingBox();
  await work.fullPage.click();
  await expect(page).toHaveURL(TASK_ADDRESS);
  const task = new SessionPage(page);
  await expect(task.title).toHaveText(PLAN_TASK);
  await expect(task.stepRail).toBeVisible();
  await expect(task.decision()).toBeVisible();
  await expect(task.pane.getByRole("region", { name: "Spec" })).toContainText("R1.1");
  await expect(task.pane.getByRole("region", { name: "Cost" })).toBeVisible();
  const wide = await task.pane.boundingBox();
  expect(narrow !== null && wide !== null && wide.width > narrow.width).toBe(true);
  await task.backToWork.click();
  await expect(page).toHaveURL(/\/app\/live\?task=[0-9a-f-]{36}/u);
  await expect(work.paneTitle).toHaveText(PLAN_TASK);
});

test("o on the focused list opens the selected task", async ({ page }) => {
  const work = new WorkPage(page);
  await work.open();
  await work.expectLoaded();
  await work.rows.first().focus();
  const title = await work.paneTitle.textContent();
  await page.keyboard.press("o");
  await expect(page).toHaveURL(TASK_ADDRESS);
  await expect(new SessionPage(page).title).toHaveText(title ?? "");
});

test("each step shows its own stage: Request is the request, Pull request says when there is none", async ({ page }) => {
  const task = await openFromWork(page, PLAN_TASK);
  await task.step("Request").click();
  await expect(task.pane.getByRole("region", { name: "Request" })).toContainText("Questions Rovara asked");
  await expect(task.pane.getByRole("region", { name: "Spec" })).toHaveCount(0);
  await task.step("Pull request").click();
  await expect(page.getByTestId("no-pull-request")).toContainText("No pull request yet");
  await task.step("Proof").click();
  await expect(task.pane.getByRole("region", { name: "Proof", exact: true })).toContainText("criteria proven");
});

test("a task Cloud did not start says steering and stopping work only for tasks started in Cloud", async ({ page }) => {
  const task = await openFromWork(page, RUNNING_TASK);
  await expect(page.getByTestId("stop-unavailable")).toContainText("started in Rovara Cloud");
  await task.step("Build").click();
  await expect(page.getByTestId("steer-unavailable")).toContainText("started in Rovara Cloud");
  await expect(task.steerBox).toHaveCount(0);
  await expect(task.more).toHaveCount(0); // no session, so no earlier tabs
});

test("a task started in Cloud has the steer box, which says Cloud does not take steering yet and keeps the note", async ({ page }) => {
  const title = `Add a cache to the lookup ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  const task = new SessionPage(page);
  await task.expectLoaded(title);
  await task.step("Build").click();
  await expect(task.steerBox).toBeVisible();
  const note = task.steerBox.getByRole("textbox", { name: "Steer this task" });
  await note.fill("use the existing helper");
  await task.steerBox.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("steer-error")).toContainText("aren't available in Rovara Cloud yet");
  await expect(note).toHaveValue("use the existing helper");
  expect(await violations(page)).toEqual([]); // the error state, too
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  // The earlier tabs stay one click away.
  await expect(task.more).toBeVisible();
  await expect(task.more).not.toHaveAttribute("open", "");
});

test("Stop on a task started in Cloud asks Code to stop it, and the task says so", async ({ page }) => {
  const title = `Trim the startup path ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  const task = new SessionPage(page);
  await task.expectLoaded(title);
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Stop/u }).last().click();
  await expect(page.getByText("Stop requested.")).toBeVisible();
});

test("Continue in my tool and a comment on a criterion say not connected yet, and keep the draft", async ({ page }) => {
  const task = await openFromWork(page, PLAN_TASK);
  await page.getByRole("button", { name: "Continue in my tool" }).click();
  await expect(page.getByTestId("continue-message")).toContainText("isn't connected to Rovara Code yet");
  const spec = task.pane.getByRole("region", { name: "Spec" });
  await spec.getByRole("button", { name: /^Comment on R1\.1/u }).click();
  const box = spec.getByRole("textbox", { name: "Comment on R1.1" });
  await box.fill("Count the retries");
  await spec.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("comment-error").first()).toContainText("isn't connected to Rovara Code yet");
  await expect(box).toHaveValue("Count the retries");
});

test("a task nobody has says it was not found, and an unserved list says not connected yet", async ({ page }) => {
  await page.goto("/app/sessions/99999999-9999-4999-8999-999999999999");
  await expect(new SessionPage(page).notFound).toBeVisible();
  await page.route("**/v1/web/sessions", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_ON_CODE_YET", message: "/v1/app/sessions isn't connected to Rovara Code yet." } }) }));
  await page.goto("/app/sessions/11111111-1111-4111-8111-111111111111");
  await expect(new SessionPage(page).loadError).toContainText("isn't connected to Rovara Code yet");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
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
  test(`the task page has no accessibility violations (contrast included) in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const task = await openFromWork(page, PLAN_TASK);
    await expect(task.pane.getByRole("region", { name: "Spec" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await task.step("Build").click();
    await expect(task.pane.getByRole("region", { name: "Build" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}

test("Compact density tightens the task page, and it still loads", async ({ page }) => {
  await page.addInitScript(() => { try { window.localStorage.setItem("rovara.density", "compact"); } catch { /* a blocked store leaves Comfortable */ } });
  const task = await openFromWork(page, PLAN_TASK);
  await expect(task.stepRail).toBeVisible();
  // The criterion rows use the dense row padding: 5px in Compact (9px otherwise), so the page itself, not only the variable, follows the density.
  const criterion = task.pane.locator(".rv-criterion").first();
  await expect(criterion).toBeVisible();
  expect(await criterion.evaluate((element) => getComputedStyle(element).paddingTop)).toBe("5px");
});
