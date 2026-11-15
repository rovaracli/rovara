import { expect, test } from "@playwright/test";
import { HomePage, PERSON, PROJECT, ProjectPage, ROUTES, ShellPage, SignedOutPage } from "./pages/index.js";

test("opening the app signs the person in through Code and lands on Home", async ({ page }) => {
  await new HomePage(page).open();
  await new HomePage(page).expectLoaded();
  await new ShellPage(page).expectSignedInAs(PERSON);
  expect(new URL(page.url()).pathname).toBe(ROUTES.home);
});

test("the signed-out page signs in again and returns to Home", async ({ page }) => {
  const signedOut = new SignedOutPage(page);
  await signedOut.open();
  await signedOut.signIn.click();
  await new HomePage(page).expectLoaded();
  await new ShellPage(page).expectSignedInAs(PERSON);
});

test("an address opened before signing in is the one you land on afterwards", async ({ page }) => {
  await page.goto(ROUTES.project(PROJECT));
  await expect(new ProjectPage(page).text).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(ROUTES.project(PROJECT));
  await new ShellPage(page).expectSignedInAs(PERSON);
});
