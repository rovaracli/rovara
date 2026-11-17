import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** A task's page (the web app calls a task and its page a session). */
export class SessionPage {
  readonly page: Page;
  readonly header: Locator;
  readonly title: Locator;
  readonly status: Locator;
  readonly notFound: Locator;
  readonly loadError: Locator;
  /** The task page's pane (the same pane as Work's, at full width). */
  readonly pane: Locator;
  readonly stepRail: Locator;
  readonly backToWork: Locator;
  readonly steerBox: Locator;
  readonly more: Locator;
  constructor(page: Page) {
    this.page = page;
    this.header = page.getByTestId("session-header");
    this.title = page.getByTestId("session-title");
    this.status = page.getByTestId("session-status");
    this.notFound = page.getByTestId("not-found");
    this.loadError = page.getByTestId("load-error");
    this.pane = page.getByRole("article", { name: /^Task: / });
    this.stepRail = page.getByRole("list", { name: "Steps of this task" });
    this.backToWork = page.getByRole("link", { name: "Back to Work" });
    this.steerBox = page.getByRole("form", { name: /^Steer / });
    this.more = page.getByTestId("task-page").locator("details.rv-task-more");
  }
  /** A step of the rail (Request, Spec, Build, Proof, Pull request). */
  step(label: string): Locator {
    return this.stepRail.getByRole("button", { name: new RegExp(`^${label}`, "u") });
  }
  /** The decision card: "Your decision" and the other kinds' headings. */
  decision(name = "Your decision"): Locator {
    return this.pane.getByRole("region", { name, exact: true });
  }
  /** A task's page by its own id (any task the person can read, whether or not Cloud started it). */
  async openTask(taskId: string): Promise<void> {
    await this.page.goto(ROUTES.session(taskId));
  }
  /** The address people share for a task (what Start opens). */
  static readonly SHARE_ADDRESS = /\/s\/(ses_[0-9a-z]{20})$/u;
  async open(sessionId: string): Promise<void> {
    await this.page.goto(ROUTES.session(sessionId));
  }
  /** The task's page loaded with this title and a status, and no load error. */
  async expectLoaded(title: string): Promise<void> {
    await expect(this.title).toHaveText(title);
    await expect(this.status).toBeVisible();
    await expect(this.loadError).toHaveCount(0);
  }
  /** The id in the address the page is on. */
  sessionIdFromAddress(): string {
    const match = SessionPage.SHARE_ADDRESS.exec(new URL(this.page.url()).pathname);
    if (match?.[1] === undefined) throw new Error(`Not on a task page: ${this.page.url()}`);
    return match[1];
  }
}

/** The People panel on a task's page (web task channel K3): the list, the add form and the confirm step. */
export class PeoplePanel {
  readonly page: Page;
  readonly panel: Locator;
  readonly rows: Locator;
  readonly waiting: Locator;
  readonly message: Locator;
  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId("people-panel");
    this.rows = this.panel.getByTestId("people-row");
    this.waiting = this.panel.getByTestId("people-waiting");
    this.message = this.panel.getByTestId("people-message");
  }
  async open(): Promise<void> {
    await this.panel.locator("summary").click();
    await expect(this.rows.first()).toBeVisible();
  }
  row(name: string): Locator {
    return this.rows.filter({ hasText: name });
  }
  roleOf(name: string): Locator {
    return this.panel.getByRole("combobox", { name: `Role for ${name}` });
  }
}
