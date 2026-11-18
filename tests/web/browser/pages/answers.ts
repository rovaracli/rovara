import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";

/** Sets what the pretend Code's answer service does for a project (lead 4 J3): `answers` is `not_set_up` (the default: no model set up), `answered`, or `off` (Code without the route); `suggest` is its start-box suggestion. */
export async function setAnswers(page: Page, project: string, options: { answers?: "answered" | "not_set_up" | "off"; suggest?: Record<string, unknown> } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/answers`, { data: { project, ...options } });
  expect(answer.status()).toBe(200);
}

/** The Ask box and its answer (wiki tab, project page, "Ask about this task"), and the start box's choice card. */
export class AskBox {
  readonly page: Page;
  readonly box: Locator;
  readonly text: Locator;
  readonly submit: Locator;
  readonly answer: Locator;
  readonly error: Locator;
  readonly card: Locator;
  constructor(page: Page) {
    this.page = page;
    this.box = page.getByTestId("ask-box");
    this.text = page.getByTestId("ask-box-text");
    this.submit = page.getByTestId("ask-box-submit");
    this.answer = page.getByTestId("answer");
    this.error = page.getByTestId("ask-box-error");
    this.card = page.getByTestId("start-choice-card");
  }
  async ask(question: string): Promise<void> {
    await this.text.fill(question);
    await this.submit.click();
  }
}
