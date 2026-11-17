import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";

/** The operator invite code the pretend Code takes (tests/support/fake-code.ts FAKE_INVITE_CODE). */
export const FAKE_INVITE_CODE = "inv_fakecode0001";

/** Makes the pretend Code name no company for the person signed in (DEC 253z), or a company again. */
export async function setNoCompany(page: Page, on: boolean): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/no-company`, { data: { on } });
  expect(answer.status()).toBe(200);
}

/** Makes the pretend Code's next sign-in this person (tests/support/fake-code.ts PEOPLE: priya, sam). */
export async function setFakePerson(page: Page, person: "priya" | "sam"): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/person`, { data: { person } });
  expect(answer.status()).toBe(200);
}

/** The onboarding screens for a person with no company: "You're not in a company yet", "Create your company" and the invite link's join page. */
export class CompanyOnboardingPage {
  readonly page: Page;
  readonly noCompany: Locator;
  readonly create: Locator;
  readonly createForm: Locator;
  readonly name: Locator;
  readonly code: Locator;
  readonly submit: Locator;
  readonly error: Locator;
  readonly join: Locator;
  readonly joinSignIn: Locator;
  readonly joinUnusable: Locator;
  constructor(page: Page) {
    this.page = page;
    this.noCompany = page.getByTestId("no-company");
    this.create = page.getByTestId("no-company-create");
    this.createForm = page.getByTestId("create-company");
    this.name = page.getByLabel("Company name");
    this.code = page.getByLabel("Invite code");
    this.submit = page.getByTestId("create-company-submit");
    this.error = page.getByTestId("create-company-error");
    this.join = page.getByTestId("join");
    this.joinSignIn = page.getByTestId("join-sign-in");
    this.joinUnusable = page.getByTestId("join-unusable");
  }
}
