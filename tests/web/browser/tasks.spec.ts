import { expect, test } from "@playwright/test";
import { PROJECT, ProjectPage, ROUTES, SessionPage } from "./pages/index.js";

test("starting a task from a project opens that task's page", async ({ page }) => {
  const title = `Add a retry to the webhook ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  await new SessionPage(page).expectLoaded(title);
});

test("a started task's page loads by its /app/sessions address, and again after a reload", async ({ page }) => {
  const title = `Speed up the search ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  const session = new SessionPage(page);
  const id = session.sessionIdFromAddress();
  await session.open(id);
  await session.expectLoaded(title);
  await page.reload();
  await session.expectLoaded(title);
});

test("a task nobody started says it was not found", async ({ page }) => {
  await page.goto(ROUTES.unknownSession);
  await expect(new SessionPage(page).notFound).toBeVisible();
});
