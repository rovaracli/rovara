import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";
import { PROJECT } from "./routes.js";

export const BROWSER_TESTING_ROUTE = (project: string) => `/app/projects/${project}/browser-testing`;
export interface FakeFailure { status: number; code: string; message: string }
/** Sets what the pretend Code's browser testing page serves for a project: the read, the read after the next change (`next`), and failures of the next reads or changes. `off`: Code without the routes. */
export async function setBrowserTesting(page: Page, options: { project?: string; view?: Record<string, unknown>; next?: Record<string, unknown>; failRead?: FakeFailure; failWrite?: FakeFailure; off?: boolean } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/browser-testing`, { data: { project: PROJECT, ...options } });
  expect(answer.status()).toBe(200);
}
/** The changes the pretend Code received for a project. */
export async function browserTestingWrites(page: Page, project = PROJECT): Promise<Array<{ method: string; path: string; body: unknown }>> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/browser-testing`, { data: { project, read: true } });
  return ((await answer.json()) as { writes: Array<{ method: string; path: string; body: unknown }> }).writes;
}

/** Browser testing's page and its row on the project's Setup tab ("Also for this project"). */
export class BrowserTestingPage {
  readonly page: Page;
  readonly root: Locator;
  readonly chip: Locator;
  readonly row: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("bt-page");
    this.chip = page.getByTestId("bt-chip");
    this.row = page.getByTestId("also-browser");
  }
  async open(project = PROJECT): Promise<void> {
    await this.page.goto(BROWSER_TESTING_ROUTE(project));
    await expect(this.root).toBeVisible();
    await expect(this.page.getByText("Reading…")).toHaveCount(0);
  }
  button(name: string | RegExp): Locator { return this.root.getByRole("button", { name }); }
}
