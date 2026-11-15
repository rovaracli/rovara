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
  constructor(page: Page) {
    this.page = page;
    this.header = page.getByTestId("session-header");
    this.title = page.getByTestId("session-title");
    this.status = page.getByTestId("session-status");
    this.notFound = page.getByTestId("not-found");
    this.loadError = page.getByTestId("load-error");
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
