// Meta repo lane B, task B4: onboarding's Setup step, end to end in Chromium against the mock cell: Rovara proposes, every suggestion says where it came from, only a
// verified one is ticked, the person applies by keyboard, the saved setup shows in the form, and the risky suggestion has its own card (nothing applies it).
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";

for (const theme of ["light", "dark"] as const) test("Rovara proposes the setup, the person applies the verified suggestion, and the risky one waits for its card in " + theme, async ({ page, context, request, baseURL }) => {
  await request.post("/__mock/scenario", { data: { name: "onboarding" } });
  await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await request.get("/__mock/github-install");
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto("/app/onboard?github=connected");
  await page.getByLabel("acme/payments").check();
  await page.getByLabel("Project name", { exact: true }).fill("payments");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByLabel("Setup commands")).toBeVisible();

  await page.getByRole("button", { name: "Ask Rovara to propose the setup" }).click();
  await expect(page.getByRole("group", { name: "Repositories to add" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("package.json:4", { exact: false })).toBeVisible();
  await expect(page.getByText("Rovara could not find this in the file")).toBeVisible();
  // Only the suggestion whose source was checked is ticked.
  await expect(page.getByRole("checkbox", { name: /^setup: In payments:/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^tests: In payments:/ })).not.toBeChecked();
  await checkA11y(page, { theme });

  // The risky repository has its own card; pressing Check and apply never includes it.
  await expect(page.getByRole("group", { name: /^Approval for repository:/ })).toBeVisible();
  await page.getByRole("button", { name: "Check and apply" }).focus();
  await page.keyboard.press("Enter");
  // The commands are checked on a fresh machine first: the page says so, saves nothing, and asks again until the check has finished.
  await expect(page.getByText("Rovara is running these commands on a fresh machine. Nothing is saved until they pass.")).toBeVisible();
  await expect(page.getByLabel("Setup commands")).toHaveValue("");
  await expect(page.getByText("Applied.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Setup commands")).toHaveValue("npm ci");
  await expect(page.getByLabel("Test commands")).toHaveValue("");
  const requests = await (await request.get("/__mock/requests")).json() as Array<{ path: string; body?: { items?: Array<{ id: string }> } }>;
  const applied = requests.filter((entry) => entry.path.endsWith("/setup-draft/apply"));
  // Two presses of one request: the check, then the save.
  expect(applied).toHaveLength(2);
  expect(applied.map((entry) => entry.body?.items?.map((item) => item.id))).toEqual([["setup-payments"], ["setup-payments"]]);
});
