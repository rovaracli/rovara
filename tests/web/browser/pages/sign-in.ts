import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** The page people see after signing out. Visiting any signed-in address signs in through Rovara Code on its own. */
export class SignedOutPage {
  readonly page: Page;
  readonly root: Locator;
  readonly signIn: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("signed-out");
    this.signIn = page.getByTestId("signed-out-sign-in");
  }
  async open(): Promise<void> {
    await this.page.goto(ROUTES.signedOut);
    await expect(this.root).toBeVisible();
  }
}
