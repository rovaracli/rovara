// DEC 253z onboarding in the browser, on the pretend Code: a person Code names no company for lands on "You're not in a company yet", creates
// a company with an operator's invite code (Code's fixed words on a wrong one) and lands on the first-day flow after signing in again; an
// invite link opens "Join <company> on Rovara" and joins through Code's sign-in, and a link that can't be used says the one sentence.
import { expect, test } from "@playwright/test";
import { CompanyOnboardingPage, FAKE_INVITE_CODE, HomePage, ROUTES, setNoCompany } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setNoCompany(page, false); });

test("a person with no company is sent to create one, and lands on the first-day flow once it's made", async ({ page }, testInfo) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
  await setNoCompany(page, true);
  const screens = new CompanyOnboardingPage(page);
  await page.goto(ROUTES.home);
  await expect(screens.noCompany).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(ROUTES.noCompany);
  await expect(page.getByRole("heading", { name: "You're not in a company yet" })).toBeVisible();
  await expect(page.getByText("Have an invite? Open the link you were sent.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("no-company.png"), fullPage: true });
  await screens.create.click();
  await expect(screens.createForm).toBeVisible();
  await expect(screens.submit).toBeDisabled();
  await screens.name.fill("Nova Labs");
  await screens.code.fill("inv_wrongcode0001");
  await screens.submit.click();
  await expect(screens.error).toHaveText("This invite code can't be used. Ask the Rovara team for a new one.");
  await page.screenshot({ path: testInfo.outputPath("create-company-refused.png"), fullPage: true });
  await screens.code.fill(FAKE_INVITE_CODE);
  await screens.submit.click();
  await page.waitForURL((url) => url.pathname === ROUTES.firstDay);
  await page.screenshot({ path: testInfo.outputPath("first-day.png"), fullPage: true });
});

test("an invite link opens the join page with the company's name, and joins through Code's sign-in; a used or broken link says one sentence", async ({ page }, testInfo) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
  // An admin's invite, made through the app's own route (Code pre-approves the email; Cloud keeps the invite).
  const inviteUrl = await page.evaluate(async () => {
    const me = await (await fetch("/v1/web/me")).json() as { csrf: string };
    const answer = await fetch("/v1/web/org/invites", { method: "POST", headers: { "content-type": "application/json", "x-rovara-csrf": me.csrf }, body: JSON.stringify({ requestId: crypto.randomUUID(), role: "member", email: `new-${String(Date.now())}@example.test` }) });
    return (await answer.json() as { inviteUrl: string }).inviteUrl;
  });
  const link = new URL(inviteUrl);
  expect(link.pathname).toBe(ROUTES.join);
  expect(link.hash).toMatch(/^#invite=[A-Za-z0-9_-]{43}$/u);
  const screens = new CompanyOnboardingPage(page);
  await page.goto(link.pathname + link.hash);
  await expect(page.getByRole("heading", { name: /^Join .+ on Rovara$/u })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("join.png"), fullPage: true });
  await screens.joinSignIn.click();
  await page.waitForURL((url) => url.pathname === ROUTES.home && url.searchParams.get("joined") === "1");
  // Used now: the same link can't be used again.
  await page.goto(link.pathname + link.hash);
  await expect(screens.joinUnusable).toHaveText("This invite can't be used. Ask your company admin for a new one.");
  await page.goto(`${ROUTES.join}#invite=${"q".repeat(43)}`);
  await expect(screens.joinUnusable).toHaveText("This invite can't be used. Ask your company admin for a new one.");
  await page.screenshot({ path: testInfo.outputPath("join-unusable.png"), fullPage: true });
});
