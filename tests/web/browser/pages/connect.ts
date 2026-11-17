// Guided onboarding PR 11: Add to Slack, a project's Slack channel and its Linear team (onboarding and Project settings), and the two providers' returns.
import { expect, type Locator, type Page } from "@playwright/test";

/** Slack's and Linear's `code` values the pretend Code understands (tests/support/fake-code.ts FAKE_SLACK_CODES, FAKE_LINEAR_CODES). */
export const FAKE_SLACK_CODES = { connected: "fakeslackok", other: "fakeslackother" } as const;
export const FAKE_LINEAR_CODES = { connected: "fakelinearok" } as const;

export class ConnectPage {
  readonly page: Page;
  readonly slackStep: Locator;
  readonly slackAdd: Locator;
  readonly slackSkip: Locator;
  readonly slackSkipped: Locator;
  readonly slackConnected: Locator;
  readonly slackConnectedLine: Locator;
  readonly slackRefused: Locator;
  readonly slackMismatch: Locator;
  readonly slackKeep: Locator;
  readonly channelRow: Locator;
  readonly channelSelect: Locator;
  readonly channelLink: Locator;
  readonly inviteNeeded: Locator;
  readonly channelCheck: Locator;
  readonly channelLinked: Locator;
  readonly channelChange: Locator;
  readonly channelRemove: Locator;
  readonly channelNote: Locator;
  readonly linearRow: Locator;
  readonly linearConnect: Locator;
  readonly linearConnected: Locator;
  readonly linearRefused: Locator;
  readonly teamSelect: Locator;
  readonly teamSave: Locator;
  readonly team: Locator;
  readonly teamRemove: Locator;
  constructor(page: Page) {
    this.page = page;
    this.slackStep = page.getByTestId("slack-step");
    this.slackAdd = page.getByTestId("slack-add");
    this.slackSkip = page.getByTestId("slack-skip");
    this.slackSkipped = page.getByTestId("slack-skipped");
    this.slackConnected = page.getByTestId("slack-connected");
    this.slackConnectedLine = page.getByTestId("slack-connected-line");
    this.slackRefused = page.getByTestId("slack-refused-message");
    this.slackMismatch = page.getByTestId("slack-mismatch");
    this.slackKeep = page.getByTestId("slack-keep");
    this.channelRow = page.getByTestId("slack-channel-row");
    this.channelSelect = page.getByTestId("slack-channel-picker").getByLabel("Slack channel");
    this.channelLink = page.getByTestId("slack-channel-link");
    this.inviteNeeded = page.getByTestId("slack-invite-needed");
    this.channelCheck = page.getByTestId("slack-channel-check");
    this.channelLinked = page.getByTestId("slack-channel-linked");
    this.channelChange = page.getByTestId("slack-channel-change");
    this.channelRemove = page.getByTestId("slack-channel-remove");
    this.channelNote = page.getByTestId("slack-channel-note");
    this.linearRow = page.getByTestId("linear-row");
    this.linearConnect = page.getByTestId("linear-connect");
    this.linearConnected = page.getByTestId("linear-connected");
    this.linearRefused = page.getByTestId("linear-refused-message");
    this.teamSelect = page.getByLabel("Linear team");
    this.teamSave = page.getByTestId("linear-team-save");
    this.team = page.getByTestId("linear-team");
    this.teamRemove = page.getByTestId("linear-team-remove");
  }
  /** Presses a button that leaves for a provider's consent page, and stops the browser there: the state and the address the provider would send the person back to. */
  async pressAndStopAt(button: Locator, host: "slack.com" | "linear.app"): Promise<{ state: string; redirectUri: string }> {
    let found: { state: string; redirectUri: string } | undefined;
    await this.page.route(`https://${host}/**`, async (route) => {
      const url = new URL(route.request().url());
      found = { state: url.searchParams.get("state") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "" };
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Consent</title>" });
    });
    await button.click();
    await this.page.waitForURL((url) => url.hostname === host);
    await this.page.unroute(`https://${host}/**`);
    expect(found?.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    return found!;
  }
  /** The provider sending the person back to Cloud's callback. */
  async returnFrom(provider: "slack" | "linear", query: Record<string, string>): Promise<void> {
    await this.page.goto(`/api/connect/${provider}/callback?${new URLSearchParams(query).toString()}`);
  }
}
