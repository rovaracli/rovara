// Track record (v1.2 slice 1): the three places a person reads it, in a real browser. The How we work cards, the review dialog's less-safe changes with the stage's lines beside them, and the owner's early
// score on the task page. The mock cell answers the ordinary views; each test adds the track record fields the broker would send, the way a newer server's answer carries them.
import { mkdirSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { stageRecords } from "../web/support/how-we-work-view.js";

const SHOTS = process.env.TRACK_RECORD_SHOTS ?? ".test-build/web-e2e/shots";
const shot = (name: string) => { mkdirSync(SHOTS, { recursive: true });return SHOTS + "/" + name + ".png"; };
const patch = async (page: Page, pattern: string, change: (body: Record<string, unknown>) => void) => {
 await page.route(pattern, async route => { const response = await route.fetch(), body = await response.json() as Record<string, unknown>;change(body);await route.fulfill({ response, json: body }); });
};
const signIn = async (page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, name: string) => {
 await request.post("/__mock/scenario", { data: { name } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
};
const withRecords = (body: Record<string, unknown>) => { for (const stage of body.stages as Array<Record<string, unknown>>) if (stageRecords[stage.id as string] !== undefined) stage.trackRecord = stageRecords[stage.id as string]; };

test("the How we work cards say what each checking stage has earned", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "project");
 await patch(page, "**/v1/web/projects/payments/how-we-work", withRecords);
 await page.setViewportSize({ width: 1280, height: 1100 });await page.goto("/app/projects/payments?tab=how-we-work");
 await expect(page.getByRole("heading", { name: "Build", exact: true })).toBeVisible();
 const review = page.getByRole("region", { name: "Review" });
 await expect(review.getByText("No changes requested by a person on 9 of 10 merged PRs (last 30 days)")).toBeVisible();
 await expect(review.getByText("2 closed unmerged · 3 merged without a person's review · Reverts after merge aren't tracked yet")).toBeVisible();
 await expect(review.getByText("Not enough history yet (6 so far)")).toBeVisible();
 await expect(page.getByRole("region", { name: "Plan check" }).getByText("The person approved the plan 14 of 17 times (last 30 days)")).toBeVisible();
 await expect(page.getByRole("region", { name: "Checks" }).getByText("CI passed on 14 of 16 PRs where tests said they prove the change (last 30 days)")).toBeVisible();
 await evidenceShot(page, { path: shot("how-we-work-cards"), fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a less-safe change in the review dialog shows the stage's lines beside it", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "project");
 await patch(page, "**/v1/web/projects/payments/how-we-work", withRecords);
 await patch(page, "**/v1/web/agents/*/diff*", body => { body.lessSafe = ["Changes the instructions of the review step \"Review\"", "Raises the agent's autonomy from suggest to run"]; });
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/projects/payments?tab=how-we-work");
 await expect(page.getByRole("heading", { name: "Build", exact: true })).toBeVisible();
 await page.getByRole("textbox", { name: "Project rules" }).fill("Keep changes small.\nAdd a test for every bug fix.");
 await page.getByRole("button", { name: "Save draft" }).click();
 await expect(page.getByText("Draft saved. Review changes to publish it.")).toBeVisible();
 await page.getByRole("button", { name: "Review changes" }).click();
 const dialog = page.getByRole("dialog", { name: "Review changes" });
 const reasons = dialog.getByRole("region", { name: "Needs someone else to confirm" });
 await expect(reasons.getByText("No changes requested by a person on 9 of 10 merged PRs (last 30 days)")).toBeVisible();
 await expect(reasons.getByRole("group", { name: "Track record" })).toHaveCount(1);
 await evidenceShot(dialog, { path: shot("review-dialog-confirmation") });
 await checkA11y(page, { theme: "light" });
});

test("the task page shows the owner's early score with its count", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "workspace");
 await patch(page, "**/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa", body => { const task = (body.session as { body: { task: Record<string, unknown> } }).body.task;task.earlyRiskSignal = { held: 5, notHeld: 1, windowDays: 30, capped: false, enough: false }; });
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");
 await page.getByRole("tab", { name: "Pull request" }).click();
 const signal = page.getByRole("region", { name: "Early signal, only you can see this" });
 await expect(signal.getByText("Early signal, few samples: PRs this project rated low risk were merged with no changes requested by a person 5 of 6 times (last 30 days). Reverts after merge aren't tracked yet.")).toBeVisible();
 await expect(signal.getByText("Only you can see this.")).toBeVisible();
 await evidenceShot(page, { path: shot("task-page-early-signal") });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});
