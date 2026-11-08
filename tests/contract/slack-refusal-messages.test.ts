import { describe, expect, it } from "vitest";
import { SLACK_PROJECT_ARCHIVED, SLACK_REMOVED_FROM_ORG, slackRefusalMessage } from "../../packages/broker/src/aws/slack-refusals.js";

const OUT_OF_DATE = "That approval is out of date. Use the latest message in this thread.";

// Ruling AU: a refused approval or retry says why, as the API and the page do, instead of "out of date" for every reason the press can meet.
describe("what a Slack press hears when the broker refuses it", () => {
  it.each([
    ["CONFIG_INVALID", "this plan was returned because its E2E source reference failed protected-candidate validation; request changes and submit a corrected plan before approval"],
    ["CONFIG_INVALID", "the corrected plan must retain the required feature E2E intent before approval"],
    ["CONFIG_INVALID", "the approved plan must include the canonical E2E intent required by the pinned project baseline"],
    ["CONFIG_INVALID", "the pinned project revision is unavailable; refresh the plan before approving it"],
    ["CONFIG_INVALID", "the candidate changed after this plan's source reference was rejected; refresh the plan before approval"],
    ["CONFIG_INVALID", "keep at least one check before retrying verification, or close the task"],
    ["CONFIG_INVALID", "keep only checks the approved plan proposed"],
    ["RUNTIME_UNAVAILABLE", "application E2E plans cannot be approved here: the check against the approved setup and the ready runtimes is not installed"],
  ])("says the real reason, as a sentence, for %s: %s", (code, reason) => {
    const said = slackRefusalMessage(code, OUT_OF_DATE, reason);
    expect(said).toBeDefined();
    expect(said).not.toBe(OUT_OF_DATE);
    expect(said!.charAt(0)).toBe(said!.charAt(0).toUpperCase());
    expect(said).toMatch(/[.!?]$/u);
    expect(said!.toLowerCase()).toContain(reason.slice(0, 40).toLowerCase());
  });

  it("QA6-12b: a refused raise says the amounts, in Slack's terms; a stale button hears the new one", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This raises the run limit from $2 to $12. Approve again with the run limit acknowledged as $12 (acknowledgedRunLimitUsd 12), or approve it in Rovara: https://cell.example/review/x/task"))
      .toBe("This raises the run limit from $2 to $12. This button does not carry the new limit. Use the latest message in this thread if it shows this raise, or approve the plan in Rovara: https://cell.example/review/x/task");
    // Without a link the way forward is still said.
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This raises the run limit from $2 to $12. Approve again with the run limit acknowledged as $12 (acknowledgedRunLimitUsd 12)."))
      .toBe("This raises the run limit from $2 to $12. This button does not carry the new limit. Use the latest message in this thread if it shows this raise, or approve the plan in Rovara.");
    // A link with markup in it is not said.
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This raises the run limit from $2 to $12. Approve again (acknowledgedRunLimitUsd 12), or approve it in Rovara: https://x.example/<!channel>"))
      .not.toContain("<");
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This plan's run limit is now $15.50, not the $12 you were shown. This raises the run limit from $2 to $15.50. Check it and approve again with the run limit acknowledged as $15.50."))
      .toBe("The run limit changed since this message was posted: it is now $15.50, not the $12 this button showed. This raises the run limit from $2 to $15.50. Use the latest message in this thread to approve it.");
    // The limit came down to what the task has: nothing is raised, and the sentence says only that.
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This plan's run limit is now $2, not the $12 you were shown. Check it and approve again with the run limit acknowledged as $2."))
      .toBe("The run limit changed since this message was posted: it is now $2, not the $12 this button showed. Use the latest message in this thread to approve it.");
    // A stale amount keeps the checked plan link too, escaped, so the person always has a way forward even when the latest message is the same button.
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This plan's run limit is now $15, not the $12 you were shown. This raises the run limit from $2 to $15. Check it and approve again with the run limit acknowledged as $15, or approve it in Rovara: https://cell.example/review/x/task?a=1&b=2"))
      .toBe("The run limit changed since this message was posted: it is now $15, not the $12 this button showed. This raises the run limit from $2 to $15. Use the latest message in this thread to approve it, or approve the plan in Rovara: https://cell.example/review/x/task?a=1&amp;b=2");
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This plan's run limit is now $15, not the $12 you were shown. Check it and approve again, or approve it in Rovara: https://x.example/<!channel>")).not.toContain("<");
    // Words that merely start alike are not said.
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "This raises the run limit from <@U1> to $12.")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "something else")).toBe(OUT_OF_DATE);
  });

  it("a medium or high plan pressed in Slack hears where to approve it, with the link; any other forbidden stays the owner message", () => {
    const link = "https://cell.example/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa?decision=approve_plan%3Ax";
    expect(slackRefusalMessage("FORBIDDEN", OUT_OF_DATE, `This plan is medium risk, so it is approved on its card in Rovara: ${link}`)).toBe(`This plan is medium risk, so it is approved on its card in Rovara: ${link}`);
    expect(slackRefusalMessage("FORBIDDEN", OUT_OF_DATE, "This plan is high risk, so it is approved on its card in Rovara, after a sign-in with the email code.")).toContain("high risk");
    expect(slackRefusalMessage("FORBIDDEN", OUT_OF_DATE, "This plan is high risk, so it is approved on its card in Rovara <!channel>")).toBe("Only the task owner can do that.");
    expect(slackRefusalMessage("FORBIDDEN", OUT_OF_DATE, "nope")).toBe("Only the task owner can do that.");
  });

  it("tells a person removed from the company so, as a sentence", () => {
    expect(slackRefusalMessage("REMOVED_FROM_ORG", OUT_OF_DATE, "You were removed from this organization. Ask an admin to invite you again.")).toBe(SLACK_REMOVED_FROM_ORG);
    expect(SLACK_REMOVED_FROM_ORG).toBe("You're no longer a member of this organization.");
  });

  it("says an archived project plainly, whatever the broker's own sentence is (it names the project)", () => {
    expect(slackRefusalMessage("PROJECT_ARCHIVED", OUT_OF_DATE, "Project `payments` is archived. Ask a project maintainer to restore it.")).toBe(SLACK_PROJECT_ARCHIVED);
  });

  it("still answers a reason it does not know with the out-of-date words, and never says data it was not written for", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "request ID was already used for a different workflow decision")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, `the approved work breakdown is invalid: ${"x".repeat(50)}`)).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("RUNTIME_UNAVAILABLE", OUT_OF_DATE, "EC2 worker returned HTTP 500")).toBeUndefined();
  });

  it("keeps escaping Slack's markup characters in what it says", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "the application E2E plan cannot be approved: <!channel> & more")).toBe("The application E2E plan cannot be approved: &lt;!channel&gt; &amp; more.");
  });
});

// M1.3 Task 3.7 (Ruling AU): the two refusals M1.3 introduces are said as plain sentences too, and only their opening words are said: what follows is data (account and
// application names, dates) and never reaches Slack.
describe("what a Slack press hears when the test accounts or an outside service's mock changed", () => {
  const ACCOUNTS = "The test accounts changed since this plan was approved. Retry the checks to approve the plan again with the accounts that are registered now.";
  const MOCK = "The mock for an outside service changed since this plan was approved. Retry the checks to approve the plan again with the mock that is approved now.";

  it.each([
    ["CONFIG_INVALID", "accounts-changed-reapprove: account profile orders-viewer of application demo expires at 2026-12-01T00:00:00.000Z, before this round can finish", ACCOUNTS],
    ["RUNTIME_UNAVAILABLE", "accounts-changed-reapprove: the registered record of account profile orders-owner cannot be read; an administrator must register the project again", ACCOUNTS],
    ["CONFIG_INVALID", "the application E2E plan cannot be approved: accounts-changed-reapprove: account profile orders-viewer of application demo is not the registered one. Request changes so the plan is written against the test accounts registered now", ACCOUNTS],
    ["CONFIG_INVALID", "the plan cannot be approved again here: mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
    ["CONFIG_INVALID", "mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
    ["RUNTIME_UNAVAILABLE", "mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
  ])("says the sentence for %s: %s", (code, reason, sentence) => {
    expect(slackRefusalMessage(code, OUT_OF_DATE, reason)).toBe(sentence);
  });

  it("does not say the data after the opening words, and does not take a lookalike for them", () => {
    const said = slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "accounts-changed-reapprove: <!channel> orders-viewer@tenant-a.example") ?? "";
    expect(said).not.toContain("channel");
    expect(said).not.toContain("tenant-a.example");
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "the accounts-changed-reapprove: nothing")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "mock-fixture-changed: x")).toBe(OUT_OF_DATE);
  });
});
