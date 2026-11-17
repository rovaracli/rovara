import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";
import { ROUTES } from "./routes.js";

/** Seeds the pretend Code's inbox (web task channel K5) for the person signed in: rows name a task by title or id; `off` makes Code answer as one with no inbox. */
export async function seedInbox(page: Page, data: { off?: boolean; clear?: boolean; rows?: Array<{ taskTitle?: string; taskId?: string; kind?: string; read?: boolean; atMs?: number }> }): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/inbox`, { data });
  expect(answer.status()).toBe(200);
}

/** The Inbox screen and the nav link with its count. */
export class InboxPage {
  readonly page: Page;
  readonly root: Locator;
  readonly rows: Locator;
  readonly empty: Locator;
  readonly unavailable: Locator;
  readonly markAll: Locator;
  readonly navLink: Locator;
  readonly badge: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("inbox");
    this.rows = page.getByTestId("inbox-row");
    this.empty = page.getByTestId("inbox-empty");
    this.unavailable = page.getByTestId("inbox-unavailable");
    this.markAll = page.getByRole("button", { name: "Mark all as read" });
    this.navLink = page.getByRole("complementary").getByRole("link", { name: /^Inbox/u });
    this.badge = page.getByRole("complementary").getByTestId("inbox-badge");
  }
  async open(): Promise<void> {
    await this.page.goto(ROUTES.inbox);
    await expect(this.root).toBeVisible();
  }
  row(title: string): Locator {
    return this.rows.filter({ hasText: title });
  }
}
