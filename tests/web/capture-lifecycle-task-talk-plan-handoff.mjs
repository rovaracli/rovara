/* global document */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { build } from "vite";
import { chromium } from "playwright";

const root = process.cwd();
const output = resolve(process.argv[2] ?? "/private/tmp/rovara-talk-plan-handoff-captures");
const site = await mkdtemp(join(tmpdir(), "rovara-talk-plan-handoff-site-"));
await mkdir(output, { recursive: true });
let browser;
try {
 await build({ configFile: false, root, base: "./", build: { outDir: site, emptyOutDir: true, rollupOptions: { input: resolve(root, "tests/fixtures/lifecycle-task-talk-plan-handoff-capture.html") } } });
 browser = await chromium.launch({ headless: true });
 for (const [name, width, height] of [["1440x1000", 1440, 1000], ["768x1024", 768, 1024], ["390x844", 390, 844], ["320x740", 320, 740]]) {
  for (const theme of ["light", "dark"]) {
   const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
   await page.goto(pathToFileURL(resolve(site, "tests/fixtures/lifecycle-task-talk-plan-handoff-capture.html")).href + `?theme=${theme}`);
   await page.waitForSelector('body[data-capture-ready="true"]');
   if (await page.getByRole("region", { name: "Plan change handoff" }).count() !== 1 || await page.getByRole("link", { name: "Review plan" }).count() !== 1) throw new Error(`intended state missing at ${name} ${theme}`);
   const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
   if (overflow) throw new Error(`horizontal overflow at ${name} ${theme}`);
   await page.screenshot({ path: resolve(output, `talk-plan-handoff-${name}-${theme}.png`), fullPage: true });
   await page.close();
  }
 }
 console.log(`Captured pending plan change handoff at four viewports in light and dark: ${pathToFileURL(output).pathname}`);
} finally {
 await browser?.close();
 await rm(site, { recursive: true, force: true });
}
