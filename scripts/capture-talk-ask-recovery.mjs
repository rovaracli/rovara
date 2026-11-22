import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const states = [
  ["failed", "Rovara couldn't answer this just now."],
  ["queued", "Rovara hasn't answered this yet."],
  ["unavailable", "Couldn't check whether Rovara answered this."],
  ["authority-lost", "This question is no longer available in this session."],
];
const viewports = [[1440, 1000], [768, 1024], [390, 844], [320, 740]];
const baseUrl = process.env.ROVARA_TALK_ASK_RECOVERY_CAPTURE_URL;
if (!baseUrl) throw new Error("Set ROVARA_TALK_ASK_RECOVERY_CAPTURE_URL to the parent-mounted Talk route with its recovery fixture selector.");
const out = resolve(process.env.ROVARA_TALK_ASK_RECOVERY_CAPTURE_OUT ?? "/private/tmp/rovara-talk-ask-recovery-captures");
const expectedSessionAnchor = process.env.ROVARA_TALK_ASK_RECOVERY_SESSION_ANCHOR;
if (!expectedSessionAnchor) throw new Error("Set ROVARA_TALK_ASK_RECOVERY_SESSION_ANCHOR to visible text that proves the parent kept the supported session anchor.");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [state, expected] of states) {
    for (const [width, height] of viewports) {
      for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme });
        const page = await context.newPage();
        const url = new URL(baseUrl);
        url.searchParams.set("talkRecovery", state);
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        const notice = page.locator(".rv-ask-recovery");
        await notice.waitFor({ state: "visible" });
        if (!(await notice.innerText()).includes(expected)) throw new Error(`${state} scene did not show its intended message at ${width}x${height} ${colorScheme}.`);
        if (state === "unavailable" && !(await notice.getByRole("button", { name: "Check" }).count())) throw new Error("Unavailable scene has no read-only Check action.");
        if (state === "authority-lost" && (await notice.locator("button").count())) throw new Error("Authority-lost scene retained an action.");
        if (!(await page.getByText(expectedSessionAnchor, { exact: false }).count())) throw new Error("The parent did not prove the expected session anchor.");
        const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth);
        if (overflow) throw new Error(`${state} scene overflows horizontally at ${width}x${height} ${colorScheme}.`);
        const file = `${state}-${width}x${height}-${colorScheme}.png`;
        await page.screenshot({ path: resolve(out, file), fullPage: true, animations: "disabled" });
        await context.close();
        process.stdout.write(`${file}\n`);
      }
    }
  }
} finally {
  await browser.close();
}
