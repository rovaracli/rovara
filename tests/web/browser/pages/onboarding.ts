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
export async function setFakePerson(page: Page, person: "priya" | "sam" | "zed"): Promise<void> {
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

/** GitHub's `code` values the pretend Code's GitHub claim understands (tests/support/fake-code.ts FAKE_GITHUB_CODES). */
export const FAKE_GITHUB_CODES = { connected: "fakeghconnected", choose: "fakeghchoose" } as const;

/** Guided onboarding PR 2: the Connect GitHub step and what the GitHub callback came back with. */
export class GithubConnectPage {
  readonly page: Page;
  readonly connect: Locator;
  readonly connected: Locator;
  readonly choose: Locator;
  readonly choices: Locator;
  readonly requested: Locator;
  readonly adminLink: Locator;
  readonly refused: Locator;
  readonly tryAgain: Locator;
  readonly stepDone: Locator;
  constructor(page: Page) {
    this.page = page;
    this.connect = page.getByTestId("github-connect");
    this.connected = page.getByTestId("github-connected");
    this.choose = page.getByTestId("github-choose");
    this.choices = page.getByTestId("github-choice");
    this.requested = page.getByTestId("github-requested");
    this.adminLink = page.getByTestId("github-admin-link");
    this.refused = page.getByTestId("github-refused-message");
    this.tryAgain = page.getByTestId("github-try-again");
    this.stepDone = page.getByTestId("github-step-done");
  }
  /**
   * Presses Connect GitHub and stops the browser at GitHub (the pretend GitHub answers a blank page): the state GitHub would carry back. The
   * cookie Cloud set at connect stays in the browser, as it would on the way to GitHub and back.
   */
  async pressConnect(): Promise<string> {
    let state: string | undefined;
    await this.page.route("https://github.com/**", async (route) => {
      state = new URL(route.request().url()).searchParams.get("state") ?? undefined;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>GitHub</title>" });
    });
    await this.connect.click();
    await this.page.waitForURL((url) => url.hostname === "github.com");
    await this.page.unroute("https://github.com/**");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    return state!;
  }
  /** GitHub sending the person back to Cloud's callback. */
  async returnFromGithub(query: Record<string, string>): Promise<void> {
    await this.page.goto(`/api/connect/github/callback?${new URLSearchParams(query).toString()}`);
  }
}
