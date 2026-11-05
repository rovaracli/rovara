// S3-L2 and S3-L5 (release 0.5.7): one email rule for free text (`replaceEmailAddresses`, with `hideEmailAddresses` as the usual placeholder), and the spelled-out at signs: `[at]`, `(at)`, `{at}`
// and a plain " at " between a first.last name and a domain. Table-driven: every row is a text and what it must become, so a false positive (a sentence with "at") and a leak read the same way.
import { describe, expect, it } from "vitest";
import { EMAIL_HIDDEN, hideEmailAddresses, replaceEmailAddresses } from "../../packages/contracts/src/index.js";
import { scrubAskText } from "../../packages/broker/src/agent-sessions/ask-store.js";
import { displayText } from "../../packages/broker/src/e2e/application-display.js";
import { cleanNoteText } from "../../packages/broker/src/team-record/distill.js";
import { shownName } from "../../packages/broker/src/team-record/identity-links.js";
import { scrubPersonalDetails } from "../../packages/broker/src/team-record/text.js";

const H = EMAIL_HIDDEN;

describe("hideEmailAddresses: an at sign written as a word", () => {
  const hidden: Array<[string, string, string]> = [
    // [why, text, expected]
    ["square brackets", "maya.chen[at]example.test", H],
    ["square brackets with spaces", "maya.chen [at] example.test", H],
    ["square brackets, no dot in the name", "maya [at] example.test", H],
    ["parentheses", "mail maya (at) example.test now", `mail ${H} now`],
    ["braces", "maya{at}example.test", H],
    ["capitals", "Maya.Chen [AT] Example.Test", H],
    ["mixed with a plain address", "a[at]b.test and c.d@e.test", `${H} and ${H}`],
    ["a trailing full stop is not part of it", "write to maya.chen [at] example.test.", `write to ${H}.`],
    ["a plain at between a first.last name and a domain", "write to maya.chen at example.test", `write to ${H}`],
    ["a plain at, capitals", "Maya.Chen AT Example.Test", H],
    ["a plain at, a longer domain", "omar.diaz at mail.example.co.uk please", `${H} please`],
    ["a plain at, end of a sentence", "You can reach omar.diaz at example.test.", `You can reach ${H}.`],
    ["a plain at, two of them", "maya.chen at example.test or omar.diaz at example.test", `${H} or ${H}`],
    ["a plain at beside a markup mark", "**maya.chen at example.test**", `**${H}**`],
  ];
  it.each(hidden)("hides: %s", (_why, text, expected) => {
    expect(hideEmailAddresses(text)).toBe(expected);
  });

  const kept: Array<[string, string]> = [
    // [why, text]: all come back unchanged
    ["an ordinary sentence with at", "Meet me at example.test at noon"],
    ["at and a domain, a single word before", "Look at example.test for the docs"],
    ["at and a domain, a plain name before", "email me at example.test"],
    ["at and a domain, two words", "the build is running at example.test now"],
    ["at and a link with a path", "see index.ts at github.com/org/repo"],
    ["a file name before at", "see package.json at example.test"],
    ["a file name with a code extension", "the file build.log at example.test"],
    ["a version before at", "released v1.2 at example.test"],
    ["a name with digits before at", "maya.chen2 at example.test"],
    ["at and a path", "maya.chen at example.test/docs"],
    ["at and a word, not a domain", "maya.chen at lunch with the team"],
    ["at and a domain with no dot", "maya.chen at localhost"],
    ["at and a number", "maya.chen at 10.0.0.1"],
    ["at and a version", "maya.chen at react18.3.1"],
    ["at without a domain", "arrive at the office"],
    ["a name and at, nothing after", "maya.chen at"],
    ["snake_case before at", "set my_value at example.test"],
    ["[at] with nothing before it", "[at] example.test"],
    ["[at] with nothing after it", "maya [at]"],
    ["[at] and a word, not a domain", "maya [at] lunch"],
    ["[at] and an IP address", "maya [at] 10.0.0.1"],
    ["a markdown reference named at", "see [at] for details"],
    ["the word at inside a word", "maya.chen cat example.test"],
    ["a newline between name and at", "maya.chen\nat example.test"],
    ["code with at", "if (x) { return at(example.test); }"],
    ["an ordinary sentence, no domain", "We looked at the results at the end of the week."],
  ];
  it.each(kept)("keeps: %s", (_why, text) => {
    expect(hideEmailAddresses(text)).toBe(text);
  });

  it("keeps the layout around a hidden address, line breaks and code fences included", () => {
    const text = ["Run this:", "```sh", "  mail -s hi maya.chen [at] example.test   # keep  the  spacing", "```", "and `inline` code."].join("\n");
    expect(hideEmailAddresses(text)).toBe(text.replace("maya.chen [at] example.test", H));
  });

  it("does not spend a worded at sign on an ssh host or a version", () => {
    const at = String.fromCharCode(64);
    for (const text of [`ssh ec2-user${at}ip-10-0-0-1.ec2.internal`, `react${at}18.3.1`, `git clone git${at}github.com:org/repo.git`]) expect(hideEmailAddresses(text), text).toBe(text);
  });
});

describe("replaceEmailAddresses (the one rule; other stored texts choose their own placeholder)", () => {
  const at = String.fromCharCode(64);
  const rows: Array<[string, string, string, string]> = [
    // [text, replacement, expected, why]
    [`bob${at}acme.com`, "[email]", "[email]", "a plain address"],
    [`ask bob${at}acme.com or li${at}acme.co.uk`, "@member", "ask @member or @member", "the placeholder the caller chose, twice"],
    [`bob＠acme.com`, "[email]", "[email]", "fullwidth"],
    [`bob%40acme.com`, "[email]", "[email]", "percent-encoded"],
    [`bob.smith [at] acme.com`, "[email]", "[email]", "worded"],
    [`react${at}18.3.1 and git${at}github.com:org/repo`, "[email]", `react${at}18.3.1 and git${at}github.com:org/repo`, "code text is not mail"],
    ["no address here", "[email]", "no address here", "nothing to replace"],
  ];
  it.each(rows)("%s with %s", (text, replacement, expected) => {
    expect(replaceEmailAddresses(text, replacement)).toBe(expected);
  });

  it("is hideEmailAddresses with its placeholder", () => {
    const text = `a${at}b.test, c[at]d.test, e%40f.test`;
    expect(hideEmailAddresses(text)).toBe(replaceEmailAddresses(text, H));
  });

  it("does not run the replacement as a pattern", () => {
    expect(replaceEmailAddresses(`bob${at}acme.com`, "$&$1$$")).toBe("$&$1$$");
  });

  it("passes a value that is not a string through", () => {
    expect(replaceEmailAddresses(undefined as unknown as string, "[email]")).toBeUndefined();
  });
});

// S3-L2: the stored-text scrubs (an Ask, a team-record line, a note, an end-to-end row, a tracker person's name) had copies of an address pattern of their own. They keep the placeholder their
// readers know, and find an address by the one rule: the spellings the one rule knows are found in all of them, and code text is left alone in all of them.
describe("every stored-text scrub uses the one rule", () => {
  const at = String.fromCharCode(64);
  const scrubs: Array<[string, (text: string) => string, string]> = [
    ["an Ask", (text) => scrubAskText(text, [], new Set()), "@member"],
    ["a team-record line", (text) => scrubPersonalDetails(text), "[email]"],
    ["a team-record note", (text) => cleanNoteText(text), "[email]"],
    ["an end-to-end row", (text) => displayText(text, 200), "[email]"],
    ["a tracker person's name", (text) => shownName(text, "fallback"), "[email]"],
  ];
  const spellings: Array<[string, string]> = [
    ["plain", `bob.smith${at}acme.example`], ["fullwidth", "bob.smith＠acme.example"], ["percent-encoded", "bob.smith%40acme.example"], ["an html reference", "bob.smith&#64;acme.example"],
    ["in brackets", "bob.smith [at] acme.example"], ["spelled out", "bob.smith at acme.example"], ["with a zero-width character", `bob.smith${at}\u200Dacme.example`],
  ];
  for (const [name, scrub, placeholder] of scrubs) {
    it.each(spellings)(`${name}: hides an address that is ${"%s"}`, (_how, address) => {
      expect(scrub(`write to ${address} today`)).toBe(`write to ${placeholder} today`);
    });
    it(`${name}: leaves code text, a version and a sentence with at alone`, () => {
      const samples = [`npm i react${at}18.3.1`, `git clone git${at}github.com:org/repo.git`, "Look at example.test at noon", "meet me at example.test"];
      for (const text of samples) expect(scrub(text), text).toBe(text);
    });
  }
});
