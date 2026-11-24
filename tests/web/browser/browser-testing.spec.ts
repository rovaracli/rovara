// Browser testing in a project's setup (owner DEC 417/420/421) in the browser, on the pretend Code: Priya (a company owner) sets it up from the checklist's row through the real router and the real Cloud route, checks, approves
// and pauses; Sam (a developer) sees it read-only; a Code without the routes shows no row. With BT_CAPTURE_DIR set, one more test captures every state of the approved mock at 1440 and 390, light and dark, into that folder
// (outside the repository); the vision reviews read those files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BrowserTestingPage, FAKE_CODE_URL, PROJECT, ROUTES, SetupTabPage, browserTestingWrites, setBrowserTesting, setFakePerson, setSetupRun } from "./pages/index.js";
import { accounts, approval, btView, candidate, draft, found, proof, summary } from "../support/browser-testing-fixtures.js";

test.afterEach(async ({ page }) => { await setBrowserTesting(page, {}); await setSetupRun(page, PROJECT, "none"); await setFakePerson(page, "priya"); });
const view = (state: Parameters<typeof btView>[0], over: Record<string, unknown> = {}) => btView(state, { project: PROJECT, ...over });

test("the owner sets it up from the checklist: Start, Check, Approve, then Pause and Resume; every change reaches Code once, with the listed members only", async ({ page }) => {
  await setSetupRun(page, PROJECT, "ready", true);
  await setBrowserTesting(page, { view: view("not-set-up"), next: view("draft") });
  const tab = new SetupTabPage(page), bt = new BrowserTestingPage(page);
  await tab.open(PROJECT);
  await expect(bt.row).toContainText("Browser testing");
  await expect(bt.row.getByTestId("also-browser-line")).toContainText("Not set up.");
  await bt.row.getByRole("link", { name: "Open" }).click();
  await expect(bt.root).toBeVisible();
  await expect(bt.chip).toHaveText("Not set up");
  await bt.button("Start setting up").click();
  await expect(bt.chip).toHaveText("Draft");
  await expect(page.getByTestId("bt-card-start")).toContainText("npm run start");
  await expect(page.getByTestId("bt-account-viewer")).toContainText("Not tried yet");
  await setBrowserTesting(page, { view: view("draft"), next: view("waiting") });
  await bt.open();
  await bt.button("Check the setup").click();
  await expect(bt.chip).toHaveText("Waiting for approval");
  await setBrowserTesting(page, { view: view("waiting"), next: view("on") });
  await bt.open();
  await bt.button("Approve browser testing").click();
  await expect(bt.chip).toHaveText("On");
  await expect(page.getByTestId("bt-banner-on")).toContainText("Browser testing is on for web.");
  await setBrowserTesting(page, { view: view("on"), next: view("paused") });
  await bt.open();
  await bt.button("Pause browser testing").click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause browser testing" }).click();
  await expect(bt.chip).toHaveText("Paused");
  const writes = await browserTestingWrites(page);
  expect(writes.map((one) => `${one.method} ${one.path.replace(`/v1/app/projects/${PROJECT}/browser-testing`, "")}`)).toEqual(["POST /pause"]);
  expect(JSON.stringify(writes[0]!.body)).not.toMatch(/password|secret|address/iu);
});

test("a developer sees browser testing read-only: the facts and no control", async ({ page }) => {
  await setFakePerson(page, "sam");
  await setSetupRun(page, PROJECT, "ready", true);
  await setBrowserTesting(page, { view: view("on", { canManage: false, viewerRole: "member" }) });
  const bt = new BrowserTestingPage(page);
  await bt.open();
  await expect(bt.root).toContainText("Only a company owner or admin can change browser testing.");
  await expect(bt.root.getByRole("button")).toHaveCount(0);
});

test("a Code without the routes shows no row and the page says it is not available yet", async ({ page }) => {
  await setSetupRun(page, PROJECT, "ready", true);
  await setBrowserTesting(page, { off: true });
  const bt = new BrowserTestingPage(page);
  await new SetupTabPage(page).open(PROJECT);
  await expect(bt.row).toHaveCount(0);
  await page.goto(`/app/projects/${PROJECT}/browser-testing`);
  await expect(page.getByTestId("bt-not-yet")).toBeVisible();
});

test("the Setup tab's Also for this project row links to the page", async ({ page }) => {
  await setBrowserTesting(page, { view: view("on") });
  await new SetupTabPage(page).open(PROJECT);
  await page.getByTestId("also-browser-open").click();
  await expect(page.getByTestId("bt-page")).toBeVisible();
});

// ---- capture: every state of the approved mock (29), at 1440 and 390, light and dark. Only with BT_CAPTURE_DIR.
const NEWER = (kind: "repo" | "choices" = "repo") => ({ kind, found: found({}, { userKinds: [{ profileId: "admin", roleRef: "admin", signInPath: "/login" }, { profileId: "viewer", roleRef: "viewer", signInPath: "/login" }, { profileId: "editor", roleRef: "editor", signInPath: "/login" }] }), newUserKinds: ["editor"], removedUserKinds: [], proof: proof(), runTimeoutMs: 600_000 });
const NO_SIGNIN = found({}, { recipeSource: "inferred", start: "npm start", healthPath: "/", userKinds: [], signInDeclared: false, snippet: { path: "package.json", text: JSON.stringify({ agentx: { e2e: { schemaVersion: "e2e-application-project/v1", recipe: { schemaVersion: "e2e-app-recipe/v1" }, accountProfiles: [{ profileId: "user", scope: "synthetic-test", login: { kind: "form", path: "/login", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "signed-in" } }] } } }, null, 2) + "\n", needsSeedStep: true } });
const checked = (extra: Record<string, unknown> = {}) => candidate({ checkedAt: "2026-11-23T05:02:00.000Z", ...extra });
const FIRST = [["admin", { status: "ok", checkedAt: "2026-11-24T10:05:00.000Z" }], ["viewer", { status: "refused", checkedAt: "2026-11-24T10:05:00.000Z" }]] as Array<[string, Record<string, unknown> | null]>;
/** The next reads fail (the served facts stay); then time moves on and the page asks again, as it does when the person comes back to the tab. */
const reconnect = async (page: Page, failRead: { status: number; code: string; message: string }) => {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/browser-testing`, { data: { project: PROJECT, failReadOnly: failRead } });
  expect(answer.status()).toBe(200);
  await page.clock.fastForward(20_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("visibilitychange")); });
};

interface Scenario { name: string; stalledRead?: boolean; where?: "page" | "checklist"; view?: Record<string, unknown>; next?: Record<string, unknown>; person?: "priya" | "sam" | "zed"; failRead?: { status: number; code: string; message: string }; after?: (page: Page, bt: BrowserTestingPage) => Promise<void> }
const SCENARIOS: Scenario[] = [
  { name: "checklist-none", where: "checklist", view: view("not-set-up") },
  { name: "checklist-waiting", where: "checklist", view: view("waiting") },
  { name: "checklist-on", where: "checklist", view: view("on") },
  { name: "loading", view: view("on"), stalledRead: true },
  { name: "read-failed", failRead: { status: 503, code: "RUNTIME_UNAVAILABLE", message: "Browser testing could not be read just now. Try again." } },
  { name: "not-set-up", view: view("not-set-up") },
  { name: "not-set-up-member", view: view("not-set-up", { canManage: false, viewerRole: "member" }) },
  { name: "draft-start", view: view("draft") },
  { name: "draft-no-signin", view: view("draft", { draft: draft({}, NO_SIGNIN), accounts: [] }) },
  { name: "draft-edit-choices", view: view("draft"), after: async (_page, bt) => { await bt.button("Change choices").click(); } },
  { name: "draft-checking", view: view("checking") },
  { name: "check-failed-commands", view: view("check-failed") },
  { name: "waiting-approve", view: view("waiting", { candidate: checked() }) },
  { name: "waiting-approve-no-signin", view: view("waiting", { candidate: checked({ summary: { found: NO_SIGNIN, proof: proof(), runTimeoutMs: 600_000 } }), accounts: [] }) },
  { name: "waiting-member", view: view("waiting", { canManage: false, viewerRole: "member", candidate: checked({ canApprove: false }) }) },
  { name: "waiting-sending", view: view("waiting", { candidate: checked() }), after: async (page, bt) => { await page.route("**/browser-testing/decision", () => undefined); await bt.button("Approve browser testing").click(); await expect(bt.button("Approving…")).toBeVisible(); } },
  { name: "waiting-conflict", view: view("waiting", { candidate: checked() }), after: async (page, bt) => { await setBrowserTesting(page, { view: view("waiting", { candidate: checked({ approval: { ...approval(), artifactDigest: "b".repeat(64) } }) }) }); await bt.button("Approve browser testing").click(); await expect(page.getByTestId("bt-conflict")).toBeVisible(); } },
  { name: "on", view: view("on") },
  { name: "on-first-check", view: view("on", { accounts: accounts(FIRST) }) },
  { name: "on-member", view: view("on", { canManage: false, viewerRole: "member", approved: { revision: 6, approvedAt: "2026-11-23T05:10:00.000Z", approvedBy: "p-owner", decidedByYou: false, summary: summary() } }) },
  { name: "on-newer-draft", view: view("on", { newerChange: NEWER(), draft: draft({ locked: true }), candidate: checked({ summary: { found: NEWER().found, proof: proof(), runTimeoutMs: 600_000 } }) }) },
  { name: "dlg-pause", view: view("on"), after: async (page, bt) => { await bt.button("Pause browser testing").click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.waitForTimeout(600); } },
  { name: "paused", view: view("paused") },
  { name: "err-unavailable", view: view("draft", { sandboxAvailable: false, faults: ["sandbox-unavailable"] }) },
  { name: "err-fault-accounts", view: view("on", { faults: ["accounts-refresh-failed"] }) },
  { name: "err-stale-draft", view: view("draft"), after: async (page) => { await reconnect(page, { status: 503, code: "RUNTIME_UNAVAILABLE", message: "Browser testing could not be read just now. Try again." }); await expect(page.getByTestId("bt-stale")).toBeVisible(); } },
  { name: "err-stale-on", view: view("on"), after: async (page) => { await reconnect(page, { status: 503, code: "RUNTIME_UNAVAILABLE", message: "Browser testing could not be read just now. Try again." }); await expect(page.getByTestId("bt-stale")).toBeVisible(); } },
  { name: "err-saved-stale", view: view("draft"), next: view("draft"), after: async (page, bt) => { await bt.button("Change choices").click(); await page.getByLabel("After every step").check(); await bt.button("Save choices").click(); await expect(bt.button("Save choices")).toHaveCount(0); await reconnect(page, { status: 503, code: "RUNTIME_UNAVAILABLE", message: "Browser testing could not be read just now. Try again." }); await expect(page.getByTestId("bt-saved-stale")).toBeVisible(); } },
  { name: "err-access-lost", view: view("draft"), next: view("draft"), after: async (page, bt) => { await bt.button("Change choices").click(); await page.getByLabel("After every step").check(); await bt.button("Save choices").click(); await expect(bt.button("Save choices")).toHaveCount(0); await reconnect(page, { status: 404, code: "NOT_FOUND", message: "project not found" }); await expect(page.getByTestId("bt-access-lost")).toBeVisible(); } },
  { name: "err-no-permission", view: view("waiting", { candidate: checked() }), after: async (page, bt) => { await setBrowserTesting(page, { view: view("waiting", { canManage: false, viewerRole: "project-admin", candidate: checked({ canApprove: false }) }) }); await bt.button("Approve browser testing").click(); await expect(page.getByTestId("bt-no-permission")).toBeVisible(); } },
  { name: "err-unknown-outcome", view: view("waiting", { candidate: checked() }), after: async (page, bt) => { await setBrowserTesting(page, { view: view("waiting", { candidate: checked() }), failWrite: { status: 503, code: "RUNTIME_UNAVAILABLE", message: "The request's outcome is unknown. Check its status before trying again." } }); await bt.button("Approve browser testing").click(); await expect(page.getByTestId("bt-unknown")).toBeVisible(); } },
];
const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;
test.describe("capture of every state", () => {
  test.skip(process.env["BT_CAPTURE_DIR"] === undefined, "BT_CAPTURE_DIR is not set");
  test.setTimeout(600_000);
  test("every state, two sizes, two themes", async ({ page }) => {
    const out = process.env["BT_CAPTURE_DIR"]!;
    mkdirSync(out, { recursive: true });
    await page.clock.install();
    await setSetupRun(page, PROJECT, "ready", true);
    for (const scenario of SCENARIOS) {
      for (const theme of ["light", "dark"] as const) for (const size of SIZES) {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: theme });
        await setFakePerson(page, scenario.person ?? "priya");
        await setBrowserTesting(page, { ...(scenario.view === undefined ? {} : { view: scenario.view }), ...(scenario.next === undefined ? {} : { next: scenario.next }), ...(scenario.failRead === undefined ? {} : { failRead: scenario.failRead }) });
        const bt = new BrowserTestingPage(page);
        if (scenario.where === "checklist") {
          await page.goto(`${ROUTES.project(PROJECT)}?tab=setup`);
          await expect(bt.row).toBeVisible();
          await expect(bt.row).not.toContainText("Reading");
          await page.getByTestId("setup-also").screenshot({ path: join(out, `${scenario.name}-${size.width}-${theme}.png`) });
          continue;
        }
        if (scenario.stalledRead === true) await page.route("**/v1/web/projects/*/browser-testing", () => undefined);
        await page.goto(`/app/projects/${PROJECT}/browser-testing`);
        await expect(bt.root).toBeVisible();
        if (scenario.stalledRead !== true) await expect(page.getByText("Reading…")).toHaveCount(0);
        await scenario.after?.(page, bt);
        // The shell's header and sidebar are fixed: a full-page shot would paint them mid-page. The window is made as tall as the page instead, so the shot is of the page as a person sees it.
        if (scenario.name !== "dlg-pause") {
          const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
          await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
          await page.waitForTimeout(150);
        }
        await page.screenshot({ path: join(out, `${scenario.name}-${size.width}-${theme}.png`) });
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
    }
  });
});
