// Task 6 (source-row lane): TR-E2c mention scrub.
import { describe, expect, it } from "vitest";
import { cleanRecordText, scrubPersonalDetails } from "../../../packages/broker/src/team-record/text.js";


describe("TR-E2c mentions", () => {
  it("code-shaped text such as a[~i] is not a mention", () => {
    expect(scrubPersonalDetails("use a[~i] and x[~mask] in the loop")).toBe("use a[~i] and x[~mask] in the loop");
    expect(scrubPersonalDetails("ping [~accountid:abc123] and [~bob] now")).toBe("ping @member and @member now"); // positive control: Jira still scrubbed
  });
  it("a GitHub @login, a Linear profile mention and a bare Linear profile link become @member", () => {
    expect(scrubPersonalDetails("thanks @octo-cat, and @Bob.")).toBe("thanks @member, and @member.");
    expect(scrubPersonalDetails("cc [@Jane Doe](https://linear.app/acme/profiles/jane) please")).toBe("cc @member please");
    expect(scrubPersonalDetails("see https://linear.app/acme/profiles/jane for context")).toBe("see @member for context");
  });
  it("an email, a team mention and a package scope are left alone by the login rule", () => {
    expect(scrubPersonalDetails("write to bob@acme.com")).toBe("write to [email]");
    expect(scrubPersonalDetails("ask @acme/backend about @angular/core")).toBe("ask @acme/backend about @angular/core");
  });
  it("code kept for a human edit is not touched by the login rule, other text is", () => {
    expect(cleanRecordText("@Injectable() class A {}", { keepCode: true })).toBe("@Injectable() class A {}");
    expect(cleanRecordText("@Injectable() class A {}")).toBe("@member() class A {}");
  });
  it("the login rule leaves inline code spans and the Slack group words @here, @channel and @everyone alone", () => {
    expect(scrubPersonalDetails("annotate with `@Transactional` and `@alice` here")).toBe("annotate with `@Transactional` and `@alice` here");
    expect(scrubPersonalDetails("@here and @channel and @everyone please look")).toBe("@here and @channel and @everyone please look");
    expect(scrubPersonalDetails("`@Transactional` then thanks @alice")).toBe("`@Transactional` then thanks @member"); // positive control: text outside the span is still scrubbed
    expect(scrubPersonalDetails("@herein @channels")).toBe("@member @member"); // only the exact group words are exempt
  });
});
