/* global document */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const output = resolve(process.env.ROVARA_PLAN_START_RECEIPT_CAPTURE_OUT ?? "/private/tmp/rovara-plan-start-receipt-captures");
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
 await server.listen();
 const address = server.httpServer.address();
 if (address === null || typeof address === "string") throw new Error("Vite did not expose its local capture address.");
 browser = await chromium.launch();
 await mkdir(output, { recursive: true });
 for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [320, 740]]) {
  for (const theme of ["light", "dark"]) {
   const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
   await page.goto(`http://127.0.0.1:${address.port}/tests/web/fixtures/lifecycle-task-plan-start-receipt/capture.html?theme=${theme}`);
   await page.getByRole("heading", { name: "Plan v3 approved" }).waitFor();
   await page.getByText("Build starting").waitFor();
   await page.getByText("The first command hasn't been observed yet.").waitFor();
   const verified = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
   if (verified.theme !== theme || verified.overflow) throw new Error(`Capture state check failed at ${width}x${height} ${theme}: ${JSON.stringify(verified)}`);
   await page.screenshot({ path: resolve(output, `plan-start-receipt-${width}x${height}-${theme}.png`), fullPage: true });
   await page.close();
  }
 }
} finally {
 await browser?.close();
 await server.close();
}
