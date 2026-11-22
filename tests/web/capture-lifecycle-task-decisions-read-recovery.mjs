/* global document */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.ROVARA_TASK_DECISIONS_RECOVERY_CAPTURE_URL;
if (!baseUrl) throw new Error("Set ROVARA_TASK_DECISIONS_RECOVERY_CAPTURE_URL to the authenticated task page.");
const output = resolve(process.env.ROVARA_TASK_DECISIONS_RECOVERY_CAPTURE_OUT ?? "/private/tmp/rovara-task-decisions-read-recovery-captures");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of [[1440, 1000], [768, 1024]]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      const page = await context.newPage();
      await page.route("**/v1/app/sessions/*/log", route => route.abort("failed").catch(() => undefined));
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const notice = page.getByTestId("task-decisions-read-recovery");
      await notice.waitFor({ state: "visible" });
      if (!(await notice.getByRole("alert").innerText()).includes("The task's decisions could not be loaded. No answer or approval was sent.")) {
        throw new Error("The task decisions recovery notice did not show the intended failure state.");
      }
      if (!(await notice.getByRole("button", { name: "Reload decisions" }).isVisible())) throw new Error("The existing decisions retry is missing.");
      if (await notice.locator("li").count() !== 0) throw new Error("Stale decision history is visible in the failed section.");
      if (!(await page.locator("main h1").first().isVisible())) throw new Error("The task page context is missing.");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error(`Horizontal overflow at ${width}x${height} (${theme}).`);
      await page.screenshot({ path: resolve(output, `failed-${width}x${height}-${theme}.png`), fullPage: true });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
