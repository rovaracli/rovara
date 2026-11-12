// exp/automations: the project's Automations tab against the mock cell (mocked API): the list, then pausing and resuming a trigger, at a phone's width (390) and a desktop's (1280), in both themes.
import { test, expect, type Page, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, mode: "edit" | "readonly" | "off") {
  await request.post("/__mock/scenario", { data: { name: "project" } });
  if (mode !== "off") await request.post("/__mock/automations", { data: { mode } });
  await context.addCookies([{ name: "__Host-agentx_review_session", value: SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
  await mockRealtime(page);
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.goto("/app/projects/payments?tab=automations");
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const sent = async (request: APIRequestContext) => await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: unknown }>;

for (const width of [390, 1280]) {
  test(`a maintainer lists chains and triggers, pauses one and resumes another (held for an admin) at ${String(width)}`, async ({ page, context, request, baseURL }, testInfo) => {
    await enter(page, context, request, baseURL, width, "edit");
    const first = page.getByRole("listitem").filter({ hasText: "GitHub: pull request opened" }), second = page.getByRole("listitem").filter({ hasText: "Every day at 09:30 (Europe/Berlin)" });
    await expect(page.getByRole("tab", { name: "Automations", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Chains", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Refund triage" }).first()).toBeVisible();
    await expect(first.getByText("On", { exact: true })).toBeVisible();
    await expect(first.getByRole("link", { name: "Open the run" })).toBeVisible();
    await expect(second.getByText("Paused", { exact: true })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    // Every control is at least 44px tall, and a keyboard can reach it (the focus ring is the design's own).
    for (const button of await first.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath(`automations-${String(width)}-light.png`), fullPage: true });
    await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath(`automations-${String(width)}-dark.png`), fullPage: true });

    await first.getByRole("button", { name: "Pause" }).click();
    await expect(first.getByText("Paused. It won't start anything until it is resumed.")).toBeVisible();
    await expect(first.getByText("Paused", { exact: true })).toBeVisible();
    await expect(first.getByRole("button", { name: "Resume" })).toBeVisible();

    await second.getByRole("button", { name: "Resume" }).click();
    await expect(second.getByText("Waiting for an admin to confirm").first()).toBeVisible();
    await expect(second.getByRole("button", { name: "Open the confirmation page" })).toBeVisible();
    await expect(second.getByText("It is on.")).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
    await evidenceShot(page, { path: testInfo.outputPath(`automations-${String(width)}-waiting.png`), fullPage: true });

    const puts = (await sent(request)).filter(item => item.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ path: expect.stringMatching(/\/triggers\/ctr_b{20}$/u) as unknown as string, body: { enabled: false, project: "payments" } });
    expect(puts[1]).toMatchObject({ body: { enabled: true } });
  });
}

test("someone who can only read sees the list with plain words and no change buttons", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 390, "readonly");
  await expect(page.getByText("Only maintainers can change automations.")).toBeVisible();
  await expect(page.getByText("GitHub: pull request opened")).toBeVisible();
  for (const name of ["Pause", "Resume", "Change", "Delete", "New chain"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activity" }).first()).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});

test("with automations off the project page has no Automations tab and asks nothing about them", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 1280, "off");
  await expect(page.getByRole("heading", { name: "payments", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Sources" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Automations" })).toHaveCount(0);
  expect((await sent(request)).some(item => item.path.includes("/automations") || item.path.includes("/chain-runs"))).toBe(false);
  await page.goto("/app/chains/chn_" + "a".repeat(20));
  await expect(page.getByRole("heading", { name: "This isn't available", level: 1 })).toBeVisible();
});
