/* global document, window */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { build } from "vite";
import { chromium } from "playwright";

const root = process.cwd();
const output = resolve(process.argv[2] ?? "/private/tmp/rovara-talk-comment-edit-recovery-captures");
const site = await mkdtemp(join(tmpdir(), "rovara-talk-comment-edit-recovery-site-"));
await mkdir(output, { recursive: true });
let browser;
try {
  await build({ configFile: false, root, base: "./", build: { outDir: site, emptyOutDir: true, rollupOptions: { input: resolve(root, "tests/web/lifecycle-task-talk-comment-edit-recovery-capture.html") } } });
  browser = await chromium.launch({ headless: true });
  for (const [state, expected] of [
    ["conflict", "The comment could not be changed."],
    ["missing", "This comment is no longer available to edit."],
    ["reload-failed", "The current comment could not be loaded."],
  ]) {
    for (const [name, width, height] of [["1440x1000", 1440, 1000], ["768x1024", 768, 1024], ["390x844", 390, 844], ["320x740", 320, 740]]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
        await page.goto(pathToFileURL(resolve(site, "tests/web/lifecycle-task-talk-comment-edit-recovery-capture.html")).href + `?state=${state}&theme=${theme}`);
        await page.waitForSelector('body[data-capture-ready="true"]');
        const region = page.getByRole("alert", { name: "Comment edit recovery" });
        assert.equal(await region.count(), 1, `${state} scene present`);
        assert.match(await region.innerText(), new RegExp(expected));
        assert.equal(await region.getAttribute("data-message-id"), "msg_aaaaaaaaaaaaaaaaaaaa", "same message identity retained");
        assert.match(await region.innerText(), /My unsent explanation for the review/, "supplied draft retained");
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme, `${theme} theme loaded`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal overflow");
        await page.screenshot({ path: join(output, `talk-comment-${state}-${name}-${theme}.png`), fullPage: true });
        await page.close();
      }
    }
  }
  console.log(`Captured three comment recovery states at four viewports in light and dark: ${pathToFileURL(output).pathname}`);
} finally {
  await browser?.close();
  await rm(site, { recursive: true, force: true });
}
