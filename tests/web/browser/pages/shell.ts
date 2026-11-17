import { expect, type Locator, type Page } from "@playwright/test";

/** The frame around every signed-in screen. */
export class ShellPage {
  readonly page: Page;
  readonly accountMenu: Locator;
  constructor(page: Page) {
    this.page = page;
    this.accountMenu = page.getByTestId("account-menu");
  }
  /** Signed in as this person: their name is on the account menu. */
  async expectSignedInAs(name: string): Promise<void> {
    await expect(this.accountMenu).toHaveText(name);
  }
}

/** What a screen shows when Rovara Code cannot answer it (a route Code does not serve yet). */
export class UnavailablePage {
  readonly page: Page;
  readonly message: Locator;
  readonly loading: Locator;
  constructor(page: Page) {
    this.page = page;
    this.message = page.getByTestId("load-error");
    this.loading = page.getByRole("progressbar");
  }
  /** Within the expect timeout the screen stops loading and says plainly that Code does not offer this yet. */
  async expectNotAvailableYet(): Promise<void> {
    await expect(this.message).toBeVisible();
    await expect(this.message).toContainText("Not available yet.");
    await expect(this.loading).toHaveCount(0);
  }
}
