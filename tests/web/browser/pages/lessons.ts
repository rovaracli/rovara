import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** The pretend Code's own address (the config's port), for its "lessons on or off" switch. */
export const FAKE_CODE_URL = `http://127.0.0.1:${process.env.ROVARA_E2E_CODE_PORT ?? "18790"}`;
/** Turns the pretend Code's lessons on or off (off: every lessons route answers "Lessons are off.", as Code does while its switch is off). */
export async function setLessons(page: Page, on: boolean): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/lessons`, { data: { on } });
  expect(answer.status()).toBe(200);
}

/** The lessons screens (DEC 231): the Work inbox's batch row and card, Learned in How we work, and Lessons used on the task page. */
export class LessonsPage {
  readonly page: Page;
  readonly batch: Locator;
  readonly results: Locator;
  readonly learned: Locator;
  readonly used: Locator;
  readonly off: Locator;
  constructor(page: Page) {
    this.page = page;
    this.batch = page.getByTestId("lesson-batch");
    this.results = page.getByTestId("lesson-results");
    this.learned = page.getByTestId("learned");
    this.used = page.getByTestId("lessons-used");
    this.off = page.getByTestId("lessons-off");
  }
  /** The batch row of a project in Work's table (its status chip says Needs you). */
  batchRow(project: string): Locator {
    return this.page.getByRole("region", { name: "Work list" }).locator(`button.rv-qp-row[data-batch="${project}"]`);
  }
  lesson(title: string): Locator {
    return this.batch.getByRole("article", { name: title });
  }
  async openWork(): Promise<void> {
    await this.page.goto(ROUTES.work);
  }
  /** Learned is its own view of the How we work tab (G4: Rules, Learned, Models by stage, History). */
  async openHowWeWork(project: string): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=how-we-work&view=learned`);
  }
  async openTask(taskId: string): Promise<void> {
    await this.page.goto(ROUTES.session(taskId));
  }
}
