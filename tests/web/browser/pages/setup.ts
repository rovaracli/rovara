import { expect, type Locator, type Page } from "@playwright/test";
import { HomePage } from "./home.js";
import { FAKE_CODE_URL } from "./lessons.js";
import { ROUTES } from "./routes.js";

/** Sets a project's hosted setup run on the pretend Code (none, running, ready or failed) and clears its skipped rows (guided onboarding PR 9). */
export async function setSetupRun(page: Page, project: string, status: "none" | "running" | "ready" | "failed", approved = false): Promise<void> {
  // L4-T2: a ready run is Done only when its setup was approved and checked (`approved`); otherwise the row says Needs you.
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/setup-run`, { data: { project, status, ...(approved ? { approved: true } : {}) } });
  expect(answer.status()).toBe(200);
}

/** Sets a project's eval card on the pretend Code (L4-EVC: a finished setup run proposes one by default; "none" shows the checklist's own words instead; "default" puts the default back). */
export async function setEvalCard(page: Page, project: string, state: "default" | "none" | "propose" | "waiting" | "approved" | "rejected"): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/eval-card`, { data: { project, state } });
  expect(answer.status()).toBe(200);
}

/** Sets a project's setup scenario on the pretend Code (SETUP-TAB): fields merged over the run read and the checklist's Setup run row (`null` removes one), the run's commands, and the company's cap on the limits. `reset` forgets all of it. */
export async function setSetupScenario(page: Page, project: string, body: { status?: "none" | "running" | "ready" | "failed"; run?: Record<string, unknown>; row?: Record<string, unknown>; entries?: unknown[]; companyLock?: Record<string, number>; reset?: boolean }): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/setup-scenario`, { data: { project, ...body } });
  expect(answer.status()).toBe(200);
}

/** The project setup checklist on the project's page (a one-line Setup run row), Project settings, and Home's "Finish setting up" card (guided onboarding PR 9). */
export class SetupChecklistPage {
  readonly page: Page;
  readonly checklist: Locator;
  readonly progress: Locator;
  readonly runRow: Locator;
  readonly settings: Locator;
  readonly settingsSetupLink: Locator;
  readonly homeCard: Locator;
  constructor(page: Page) {
    this.page = page;
    this.checklist = page.getByTestId("project-checklist");
    this.progress = page.getByTestId("checklist-progress");
    this.runRow = page.getByTestId("setup-run-row");
    this.settings = page.getByTestId("project-settings");
    this.settingsSetupLink = page.getByTestId("project-settings-setup-link");
    this.homeCard = page.getByTestId("home-finish-setup");
  }
  row(name: string): Locator { return this.page.getByTestId(`checklist-row-${name}`); }
  skip(name: string): Locator { return this.page.getByTestId(`checklist-skip-${name}`); }
  async open(project: string): Promise<void> {
    await this.page.goto(ROUTES.project(project));
    await expect(this.checklist).toBeVisible();
  }
  async openSettings(project: string): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=settings`);
    await expect(this.settings).toBeVisible();
  }
}

/** The project's Setup tab (FABLE-REVIEW): the status card with its one primary action, the addresses to decide, this run, the extras and the limits for a setup run. */
export class SetupTabPage {
  readonly page: Page;
  readonly tab: Locator;
  readonly card: Locator;
  readonly actions: Locator;
  readonly start: Locator;
  readonly stop: Locator;
  readonly addresses: Locator;
  readonly hostAsks: Locator;
  readonly run: Locator;
  readonly log: Locator;
  readonly also: Locator;
  readonly limits: Locator;
  readonly changeLimits: Locator;
  constructor(page: Page) {
    this.page = page;
    this.tab = page.getByTestId("setup-tab");
    this.card = page.getByTestId("setup-status-card");
    this.actions = page.getByTestId("setup-card-actions");
    this.start = this.card.getByTestId("setup-run-start");
    this.stop = this.card.getByTestId("setup-run-stop");
    this.addresses = page.getByTestId("setup-addresses");
    this.hostAsks = page.getByTestId("host-ask");
    this.run = page.getByTestId("setup-run");
    this.log = page.getByTestId("run-log");
    this.also = page.getByTestId("setup-also");
    this.limits = page.getByTestId("setup-limits");
    this.changeLimits = page.getByTestId("limits-change");
  }
  async open(project: string): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=setup`);
    await expect(this.card).toBeVisible();
  }
  hostAsk(host: string): Locator { return this.page.locator(`[data-testid="host-ask"][data-host="${host}"]`); }
}

/** Sets the candidate setup waiting for a decision on a project of the pretend Code (L4-D2): null clears it. */
export async function setSetupApply(page: Page, project: string, apply: { check?: "checking" | "ready" | "failed"; risk?: "low" | "medium" | "high"; changes?: Array<{ area: string; risk: string }>; canApprove?: boolean; canReject?: boolean; moved?: boolean; failedStep?: string } | null): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/setup-apply`, { data: { project, apply } });
  expect(answer.status()).toBe(200);
}

/** The setup approval card on the onboarding Setup step (L4-D2). */
export class SetupApprovalPage {
  readonly page: Page;
  readonly card: Locator;
  readonly approve: Locator;
  readonly reject: Locator;
  readonly discard: Locator;
  readonly problem: Locator;
  readonly decided: Locator;
  constructor(page: Page) {
    this.page = page;
    this.card = page.getByTestId("setup-approval");
    this.approve = this.card.getByTestId("setup-approve");
    this.reject = this.card.getByTestId("setup-reject");
    this.discard = this.card.getByTestId("setup-discard");
    this.problem = this.card.getByTestId("setup-approval-problem");
    this.decided = page.getByTestId("setup-decided");
  }
  /** Opens the Setup step. */
  async open(project: string): Promise<void> {
    // The first address opened signs the person in through Code (a redirect chain), so settle on a page of the app before touching its storage.
    await this.page.goto(ROUTES.home);
    await new HomePage(this.page).expectLoaded();
    await this.page.goto(`${ROUTES.firstDay}?project=${encodeURIComponent(project)}&step=setup`);
  }
}
