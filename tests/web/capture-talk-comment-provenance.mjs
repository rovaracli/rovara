import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const url = process.env.ROVARA_TALK_CAPTURE_URL;
const sessionId = process.env.ROVARA_TALK_CAPTURE_SESSION_ID;
const messageId = process.env.ROVARA_TALK_CAPTURE_MESSAGE_ID;
const expectedSource = process.env.ROVARA_TALK_CAPTURE_EXPECTED_SOURCE;
const outDir = resolve(process.env.ROVARA_TALK_CAPTURE_OUT ?? "captures/talk-comment-provenance");
if (!url || !sessionId || !messageId || !expectedSource) throw new Error("Set ROVARA_TALK_CAPTURE_URL, ROVARA_TALK_CAPTURE_SESSION_ID, ROVARA_TALK_CAPTURE_MESSAGE_ID and ROVARA_TALK_CAPTURE_EXPECTED_SOURCE from the parent Talk handoff.");

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
 for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [320, 740]]) {
  for (const theme of ["light", "dark"]) {
   const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce" });
   const page = await context.newPage();
   await page.goto(url, { waitUntil: "networkidle" });
   if (!page.url().includes(sessionId)) throw new Error(`Capture did not open the parent handoff session at ${width}x${height} ${theme}.`);
   const row = page.getByTestId("talk-comment-provenance");
   await row.waitFor({ state: "visible" });
   if (await row.getAttribute("data-message-id") !== messageId) throw new Error(`Capture showed a different comment at ${width}x${height} ${theme}.`);
   const text = await row.innerText();
   if (!text.includes(expectedSource) || !text.includes("Comment") || /#[\w-]+/u.test(text)) throw new Error(`Capture did not show the intended attribution safely at ${width}x${height} ${theme}.`);
   if (await row.locator("button").count() !== 0) throw new Error(`Attribution row exposed an instruction control at ${width}x${height} ${theme}.`);
   const themeRoot = page.locator("[data-theme]").first();
   if (await themeRoot.getAttribute("data-theme") !== theme) throw new Error(`Capture did not load the ${theme} theme at ${width}x${height}.`);
   if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`Capture overflowed horizontally at ${width}x${height} ${theme}.`);
   await page.screenshot({ path: resolve(outDir, `talk-${width}x${height}-${theme}.png`), fullPage: true });
   await context.close();
  }
 }
} finally { await browser.close(); }
