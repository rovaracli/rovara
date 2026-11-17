import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";

/** Forgets the projects a spec made through the picker (the pretend Code keeps the two it starts with). */
export async function resetCreatedProjects(page: Page): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/reset-created-projects`, { data: {} });
  expect(answer.status()).toBe(200);
}

/** The "Choose repositories" step: the picker, the one-or-separate question and the bulk progress table (guided onboarding PR 10). */
export class RepoPickerPage {
  readonly page: Page;
  readonly list: Locator;
  readonly search: Locator;
  readonly picked: Locator;
  readonly question: Locator;
  readonly whySeparate: Locator;
  readonly name: Locator;
  readonly error: Locator;
  readonly table: Locator;
  readonly showMore: Locator;
  constructor(page: Page) {
    this.page = page;
    this.list = page.getByTestId("repository-list");
    this.search = page.getByLabel("Search repositories");
    this.picked = page.getByTestId("picked-count");
    this.question = page.getByTestId("together");
    this.whySeparate = page.getByTestId("why-separate");
    this.name = page.getByLabel("Project name (optional)");
    this.error = page.getByRole("alert");
    this.table = page.getByTestId("bulk-progress");
    this.showMore = page.getByRole("button", { name: "Show more repositories" });
  }
  async open(): Promise<void> {
    await this.page.goto("/app/onboard?step=repositories");
    await expect(this.page.getByRole("heading", { name: "Choose repositories" })).toBeVisible();
    await expect(this.list).toBeVisible();
  }
  repository(name: string): Locator {
    return this.page.getByRole("checkbox", { name: new RegExp(`^example/${name}( |$)`, "u") });
  }
  async pick(...names: string[]): Promise<void> {
    for (const name of names) await this.repository(name).check();
  }
  button(name: string | RegExp): Locator {
    return this.page.getByRole("button", { name });
  }
}
