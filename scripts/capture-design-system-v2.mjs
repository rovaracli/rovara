/* global document, window, getComputedStyle, localStorage */
/** Controller-host capture only. No downloads, provider calls, AWS or real writes. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const scenes = ["colours", "type", "space", "statuses", "buttons", "decisions", "timeline", "table", "toast", "confirmation", "outcome", "focus", "shell-running", "shell-plan", "shell-gaps", "delivery", "held", "states-loading", "states-empty", "states-slow", "states-error", "states-stale", "states-phone", "states-first-load-failed", "states-stale-or-heartbeat", "states-write-unconfirmed"];
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
export function capturePlan() {
 return scenes.flatMap(scene => viewports.flatMap(viewport => ["light", "dark"].map(theme => ({ scene, ...viewport, theme, filename: `${scene}-${viewport.width}x${viewport.height}-${theme}.png` }))));
}
export function localBaseUrl(value) {
 const url = new URL(value);
 if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("--base-url must be a dedicated loopback HTTP origin with an explicit port");
 return url;
}
async function fingerprint() {
 const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
 const head = git("rev-parse", "HEAD").trim(), hash = createHash("sha256").update(head).update(git("diff", "HEAD", "--binary"));
 const untracked = git("ls-files", "--others", "--exclude-standard", "packages/ui/src", "scripts/capture-design-system-v2.mjs", "tests/web/design-system-v2/shell-gallery").trim().split("\n").filter(path => /\.(?:tsx?|mjs|css)$/.test(path)).sort();
 for (const path of untracked) hash.update(path).update(await readFile(path));
 return { head, treeFingerprint: hash.digest("hex"), dirty: git("status", "--porcelain").trim() !== "" };
}
async function settled(page) {
 await page.evaluate(async () => {
  await Promise.all([...document.getAnimations()].filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
 });
}
async function assertScene(page, scene, width, theme) {
 const root = page.locator(`[data-gallery-scene="${scene}"]`);
 await root.waitFor({ state: "visible" });
 if (await page.locator("[data-gallery-scene]").count() !== 1) throw new Error(`${scene}: scene isolation failed`);
 if (await root.locator("[data-gallery-placeholder]").count()) throw new Error(`${scene}: part not integrated; a placeholder is not visual proof`);
 if (!await root.locator("h2").first().isVisible()) throw new Error(`${scene}: intended scene heading missing`);
 const labels = {
  "colours": ["Colour roles", "LIGHT", "DARK"], "type": ["Type: five sizes", "--no-interaction"], "space": ["Space: 4px base", "48"],
  "statuses": ["Queued", "Not run", "Unknown"], "buttons": ["Review evidence", "Request changes"],
  "decisions": ["Answer", "Needs you"], "timeline": ["Build", "Checks"], "table": ["Add refunds endpoint"],
  "toast": ["Undo"], "confirmation": ["Preview Close confirmation"], "outcome": ["What happened", "What is safe", "What to do"],
  "focus": ["New in v2: selection, focus and outlines", "LIGHT", "DARK", "Not started"],
  "shell-running": ["Writing the POST /refunds handler", "Where this task is"], "shell-plan": ["Approve plan v3?", "Risks to know"], "shell-gaps": ["2 required results are missing", "Could not run", "Not run"],
  "delivery": ["Queued for this build", "Applied", "Checking delivery", "Not delivered", "Not applied: outside the plan"], "held": ["Unknown", "checking"],
  "states-loading": ["Tasks"], "states-empty": ["No tasks yet"], "states-slow": ["Longer than usual"], "states-error": ["couldn't refresh"], "states-stale": ["Unknown", "3 min ago"], "states-phone": ["Plan v3", "Start a task"],
  "states-first-load-failed": ["couldn't load this project's tasks"], "states-stale-or-heartbeat": ["Was Running at 14:20", "Unknown"], "states-write-unconfirmed": ["didn't hear back", "Check current limit"],
 };
 if (await page.locator("html").getAttribute("data-theme") !== theme) throw new Error(`${scene}: explicit theme not applied`);
 const text = await root.innerText();
 for (const label of labels[scene] ?? []) if (!text.includes(label)) throw new Error(`${scene}: missing intended label ${label}`);
 if (scene === "states-loading" && !await root.getByRole("progressbar").count()) throw new Error("Loading scene lacks its row skeleton");
 const fonts = await page.evaluate(async () => {
  for (const face of ['400 14px Inter', '600 28px Inter', '400 12px "JetBrains Mono"']) await document.fonts.load(face);
  await document.fonts.ready;
  const loaded = [...document.fonts].map(face => ({ family: face.family.replaceAll('"', ""), weight: face.weight, status: face.status }));
  const expected = [["Inter", "400"], ["Inter", "600"], ["JetBrains Mono", "400"]];
  if (expected.some(([family, weight]) => !loaded.some(face => face.family === family && face.weight === weight && face.status === "loaded"))) throw new Error("Bundled font face missing or not loaded");
  if (!document.fonts.check('400 14px Inter') || !document.fonts.check('600 28px Inter') || !document.fonts.check('400 12px "JetBrains Mono"')) throw new Error("Font checks failed");
  return loaded;
 });
 await settled(page);
 const layout = await root.evaluate((element, viewportWidth) => {
  if (document.documentElement.scrollWidth > viewportWidth) throw new Error("Horizontal page overflow");
  if (Number(getComputedStyle(element).opacity) !== 1) throw new Error("Scene has not settled to opacity 1");
  const minimum = viewportWidth < 640 ? 48 : 36;
  for (const target of element.querySelectorAll("button.rv-button,input.rv-input,textarea.rv-input,summary,.rv-ds-selection button")) {
   if (target.getClientRects().length && target.getBoundingClientRect().height + 0.5 < minimum) throw new Error(`Undersized control: ${target.textContent ?? target.tagName}`);
  }
  return { scrollWidth: document.documentElement.scrollWidth, minimumControlHeight: minimum };
 }, width);
 return { root, fonts, layout, labels: labels[scene] };
}
async function sceneTop(page, root) {
 await root.evaluate(element => {
  const top = element.getBoundingClientRect().top + window.scrollY;
  const header = document.querySelector(".rv-shell-header")?.getBoundingClientRect().height ?? 0;
  window.scrollTo(0, Math.max(0, top - header));
 });
 await settled(page);
}
async function take(page, root, out, name) {
 await sceneTop(page, root);
 const paths = [];
 const save = async (suffix, options = {}) => {
  const path = resolve(out, `${name}${suffix}.png`);
  await page.screenshot({ path, animations: "disabled", ...options });paths.push(path);
 };
 await save("");await save("-full", { fullPage: true });
 const bounds = await root.boundingBox(), viewport = page.viewportSize();
 if (bounds && viewport && bounds.height > viewport.height) {
  const start = await page.evaluate(() => window.scrollY);
  for (let offset = viewport.height - 100, n = 2; offset < bounds.height; offset += viewport.height - 100, n++) {
   await page.evaluate(y => window.scrollTo(0, y), start + offset);await save(`-segment-${n}`);
  }
 }
 return paths;
}
async function localRequestsOnly(context, base) {
 await context.route("**/*", route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort("blockedbyclient"));
 await context.routeWebSocket("**/*", socket => {
  const url = new URL(socket.url());url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  if (url.origin === base.origin) socket.connectToServer();else void socket.close({ code: 1008, reason: "Controller capture is loopback only" });
 });
}
async function run() {
 const args = process.argv.slice(2), flags = new Map();
 for (let i = 0; i < args.length; i += 2) {
  if (!["--base-url", "--out"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error("Usage: node scripts/capture-design-system-v2.mjs --base-url http://127.0.0.1:<port> --out <brief>/captures/<head>");
  flags.set(args[i], args[i + 1]);
 }
 const base = localBaseUrl(flags.get("--base-url")), out = resolve(flags.get("--out") ?? (() => { throw new Error("--out is required"); })());
 const { chromium } = await import("playwright");
 await mkdir(out, { recursive: true });
 const manifest = { ...await fingerprint(), baseUrl: base.origin, fixtureTime: "2026-11-21T14:07:00.000Z", captures: [], boundaries: [], normalMotion: null, failures: [] };
 const browser = await chromium.launch();
 try {
  for (const target of capturePlan()) {
   const context = await browser.newContext({ viewport: { width: target.width, height: target.height }, colorScheme: target.theme, reducedMotion: "reduce" });
   // Fail closed on outbound requests. The controller supplies fake Code on this origin.
   await localRequestsOnly(context, base);
   await context.addInitScript(theme => localStorage.setItem("rovara.theme", theme), target.theme);
   const page = await context.newPage(), errors = [];
   page.on("pageerror", error => errors.push(error.message));
   page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
   try {
    await page.clock.setFixedTime(new Date(manifest.fixtureTime));
    const response = await page.goto(`${base.origin}/app/design-system?scene=${target.scene}`);
    if (response?.status() !== 200 || !response.headers()["content-type"]?.includes("text/html")) throw new Error("Cloud did not directly serve the gallery page");
    const proof = await assertScene(page, target.scene, target.width, target.theme);
    const name = target.filename.replace(/\.png$/, ""), paths = await take(page, proof.root, out, name);
    const variants = [];
    if (target.scene === "focus") {
     await proof.root.getByRole("button", { name: "Review evidence", exact: true }).focus();
     variants.push(...await take(page, proof.root, out, `${name}-focus-target`));
    }
    if (target.scene === "shell-running" || target.scene === "timeline") {
     const log = proof.root.locator("details").filter({ has: page.locator("summary", { hasText: "Live log" }) }).first();
     if (await log.count()) { await log.locator("summary").click();variants.push(...await take(page, proof.root, out, `${name}-expanded-log`)); }
    }
    if (target.scene === "confirmation") {
     if (!await page.getByRole("dialog").count()) await proof.root.getByRole("button").first().click();
     if (!await page.getByRole("dialog").isVisible()) throw new Error("Confirmation dialog did not open");
     for (const label of ["Keep changes and close", "Cancel", "Discard changes and close"]) if (!await page.getByRole("dialog").getByRole("button", { name: label, exact: true }).isVisible()) throw new Error(`Confirmation missing ${label}`);
     variants.push(...await take(page, proof.root, out, `${name}-expanded-dialog`));
    }
    if (target.scene === "outcome" || target.scene === "states-write-unconfirmed") {
     await proof.root.getByRole("button", { name: "Check current limit", exact: true }).click();
     if (!(await proof.root.innerText()).includes("$600")) throw new Error("Outcome check missing observed value");
     variants.push(...await take(page, proof.root, out, `${name}-outcome-after`));
    }
    if (errors.length) throw new Error(errors.join("\n"));
    manifest.captures.push({ ...target, assertions: proof.labels, fonts: proof.fonts, layout: proof.layout, paths, variants });
   } catch (error) { manifest.failures.push({ target, error: String(error) }); }
   finally { await context.close(); }
  }
  // Boundary checks are in addition to the required 104 base captures.
  for (const width of [320, 639, 640, 1023, 1024]) for (const theme of ["light", "dark"]) {
   const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
   await localRequestsOnly(context, base);
   await context.addInitScript(value => localStorage.setItem("rovara.theme", value), theme);
   const page = await context.newPage();
   try {
    for (const scene of ["colours", "type", "space", "focus", "shell-running"]) {
     await page.goto(`${base.origin}/app/design-system?scene=${scene}`);
     const proof = await assertScene(page, scene, width, theme);
     manifest.boundaries.push({ width, theme, scene, paths: await take(page, proof.root, out, `${scene}-${width}x1000-${theme}-boundary`) });
    }
   } catch (error) { manifest.failures.push({ width, theme, error: String(error) }); }
   finally { await context.close(); }
  }
  const context = await browser.newContext({ viewport: viewports[0], reducedMotion: "no-preference" });
  await localRequestsOnly(context, base);
  try {
   await context.addInitScript(() => localStorage.setItem("rovara.theme", "light"));
   const page = await context.newPage();await page.goto(`${base.origin}/app/design-system?scene=focus`);
   const proof = await assertScene(page, "focus", 1440, "light");manifest.normalMotion = { settled: true, paths: await take(page, proof.root, out, "focus-1440x1000-light-normal-motion") };
  } catch (error) { manifest.failures.push({ smoke: "normal-motion", error: String(error) }); }
  finally { await context.close(); }
 } finally {
  await browser.close();await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
 }
 if ((await fingerprint()).treeFingerprint !== manifest.treeFingerprint) throw new Error("Source tree changed during capture");
 if (manifest.failures.length || manifest.captures.length !== 104) throw new Error(`Capture failed: ${manifest.failures.length} failures; ${manifest.captures.length}/104 complete. See manifest.json.`);
 console.log(`Captured 104 base scenes plus variants and boundaries in ${out}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch(error => { console.error(String(error));process.exitCode = 1; });
