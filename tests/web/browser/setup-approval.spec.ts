// L4-D2 in the browser, on the pretend Code (Code #899's candidate, confirm, discard and decide): Priya, the company owner, opens the Setup step and meets the approval card in each of its states (low, medium and high risk, a person who
// can and cannot approve, a check that is running or failed, a candidate that moved), approves after the fresh sign-in, and the card holds at phone width in light and dark. Screenshots go to the test output folder.
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SetupApprovalPage, setSetupApply, setSetupRun } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setSetupApply(page, PROJECT, null); await setSetupRun(page, PROJECT, "none"); });

async function open(page: Page, confirmed?: string) {
  await setSetupRun(page, PROJECT, "ready");
  const approval = new SetupApprovalPage(page);
  await approval.open(PROJECT, confirmed);
  await expect(approval.card).toBeVisible();
  return approval;
}

test("low risk: the card shows the risk, the changes and the passed check; Approve asks for the fresh sign-in first", async ({ page }, testInfo) => {
  await setSetupApply(page, PROJECT, { risk: "low" });
  const approval = await open(page);
  await expect(approval.card.getByTestId("setup-approval-risk")).toContainText("Low risk");
  await expect(approval.card).toContainText("Setup commands: 1 to run");
  await expect(approval.card).toContainText("Passed on a fresh workspace.");
  await expect(approval.card).not.toContainText("ab12ab12");
  await expect(approval.approve).toBeVisible();
  await expect(approval.reject).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("approval-low.png"), fullPage: true });
  const asked = page.waitForRequest(request => request.url().includes("/v1/auth/browser/authorize") && request.url().includes("step_up=1"));
  await approval.approve.click();
  const url = (await asked).url();
  expect(decodeURIComponent(url)).toMatch(/confirmed=[0-9a-f-]{36}/u);
});

test("after the fresh sign-in, Approve sends the decision bound to what the card read, and the card gives way to the result", async ({ page }, testInfo) => {
  await setSetupApply(page, PROJECT, { risk: "low" });
  const approval = await open(page, "e2e-approve");
  await expect(approval.card.getByTestId("setup-approval-fresh")).toContainText("You confirmed it's you");
  const sent = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith(`/v1/web/projects/${PROJECT}/setup-agent/decide`));
  await approval.approve.click();
  const body = JSON.parse((await sent).postData() ?? "{}") as { outcome: string; seen: { revision: number; artifactDigest: string } };
  expect(body).toMatchObject({ outcome: "approve", seen: { revision: 4 } });
  expect(body.seen.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
  await expect(approval.decided).toContainText("Approved");
  await expect(approval.card).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("approval-approved.png"), fullPage: true });
});

test("medium and high risk say why; a person who may not approve gets one line and no Approve button", async ({ page }, testInfo) => {
  await setSetupApply(page, PROJECT, { risk: "medium", changes: [{ area: "test_mocks", risk: "medium" }] });
  let approval = await open(page);
  await expect(approval.card.getByTestId("setup-approval-risk")).toContainText("Medium risk");
  await page.screenshot({ path: testInfo.outputPath("approval-medium.png"), fullPage: true });
  await setSetupApply(page, PROJECT, { risk: "high", changes: [{ area: "websites", risk: "high" }, { area: "setup_commands", risk: "low" }], canApprove: false, canReject: true });
  approval = await open(page);
  await expect(approval.card.getByTestId("setup-approval-risk")).toContainText("High risk");
  await expect(approval.card.getByTestId("setup-approval-risk")).toContainText("allowed websites");
  await expect(approval.card.getByTestId("setup-approval-who")).toHaveText("A company owner or admin approves high-risk changes.");
  await expect(approval.approve).toHaveCount(0);
  await expect(approval.reject).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("approval-high-cannot-approve.png"), fullPage: true });
  await setSetupApply(page, PROJECT, { risk: "high", changes: [{ area: "websites", risk: "high" }], canApprove: false, canReject: false });
  approval = await open(page);
  await expect(approval.card.getByRole("button", { name: /Approve|Reject/u })).toHaveCount(0);
});

test("a check that is running or failed offers no decision, only Discard", async ({ page }, testInfo) => {
  await setSetupApply(page, PROJECT, { check: "checking" });
  let approval = await open(page);
  await expect(approval.card).toContainText("checking it on a fresh workspace");
  await expect(approval.approve).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("approval-checking.png"), fullPage: true });
  await setSetupApply(page, PROJECT, { check: "failed", failedStep: "npm test" });
  approval = await open(page);
  await expect(approval.card.getByRole("alert")).toContainText("failed");
  await expect(approval.card.getByRole("alert")).toContainText("npm test");
  await expect(approval.approve).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("approval-check-failed.png"), fullPage: true });
  await approval.discard.click();
  await expect(approval.decided).toContainText("Discarded");
});

test("a candidate that moved shows the fixed refusal and a Refresh", async ({ page }, testInfo) => {
  await setSetupApply(page, PROJECT, { risk: "low", moved: true });
  const approval = await open(page, "e2e-stale");
  await approval.approve.click();
  await expect(approval.problem).toContainText("changed or is no longer waiting");
  await expect(approval.problem.getByRole("button", { name: "Refresh" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("approval-stale.png"), fullPage: true });
});

for (const scheme of ["light", "dark"] as const) {
  test(`the card at phone width, ${scheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 800 });
    await setSetupApply(page, PROJECT, { risk: "high", changes: [{ area: "websites", risk: "high" }, { area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }] });
    const approval = await open(page);
    await expect(approval.card).toBeVisible();
    // No sideways scroll at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`approval-phone-${scheme}.png`), fullPage: true });
  });
}
