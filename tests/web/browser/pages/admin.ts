import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** The admin area: the grouped sidebar on the left, the page on the right (Hybrid 1, DEC 223). */
export class AdminPage {
  readonly page: Page;
  readonly nav: Locator;
  readonly groupHeadings: Locator;
  readonly notConnected: Locator;
  readonly freshSignIn: Locator;
  readonly loading: Locator;
  constructor(page: Page) {
    this.page = page;
    this.nav = page.getByRole("navigation", { name: "Administration" });
    this.groupHeadings = this.nav.getByRole("heading");
    this.notConnected = page.getByTestId("not-connected");
    this.freshSignIn = page.getByTestId("fresh-sign-in");
    this.loading = page.getByRole("progressbar");
  }
  async open(path: string = ROUTES.admin.home): Promise<void> {
    await this.page.goto(path);
    await expect(this.nav).toBeVisible();
  }
  link(name: string): Locator {
    return this.nav.getByRole("link", { name, exact: true });
  }
  heading(name: string): Locator {
    return this.page.getByRole("heading", { name, level: 1 });
  }
  /** The stat tiles of the Spending page or the Overview. */
  stats(name: string | RegExp): Locator {
    return this.page.getByRole("group", { name });
  }
  table(name: string): Locator {
    return this.page.getByRole("table", { name });
  }
  /** The page said "not connected yet" and stopped loading. */
  async expectNotConnected(what: string | RegExp): Promise<void> {
    await expect(this.notConnected.first()).toBeVisible();
    await expect(this.notConnected.first()).toContainText(what);
    await expect(this.notConnected.first()).toContainText("isn't connected to Rovara Code yet");
    await expect(this.loading).toHaveCount(0);
  }
}

/** Your account: name, appearance, confirmation email and passkeys. */
export class AccountPage {
  readonly page: Page;
  readonly passkeys: Locator;
  readonly factorEmail: Locator;
  readonly freshSignIn: Locator;
  constructor(page: Page) {
    this.page = page;
    this.passkeys = page.getByRole("list", { name: "Your passkeys" });
    this.factorEmail = page.getByTestId("factor-email");
    this.freshSignIn = page.getByTestId("fresh-sign-in");
  }
  async open(query = ""): Promise<void> {
    await this.page.goto(ROUTES.account + query);
    // A dialog opened by the address hides the page from the accessibility tree, so the heading is found by its class.
    await expect(this.page.locator(".rv-account h1")).toHaveText("Your account");
  }
}
