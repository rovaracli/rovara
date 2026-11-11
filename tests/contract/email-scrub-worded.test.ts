// S3-L2 and S3-L5 (release 0.5.7): one email rule for free text (`replaceEmailAddresses`, with `hideEmailAddresses` as the usual placeholder), and the spelled-out at signs: `[at]`, `(at)`, `{at}`
// and a plain " at " between a first.last name and a domain. Table-driven: every row is a text and what it must become, so a false positive (a sentence with "at") and a leak read the same way.
import { describe, expect, it } from "vitest";
import { EMAIL_HIDDEN, hideEmailAddresses, replaceEmailAddresses } from "@rovara-code/contracts";
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
    // A zero-width character inside the spelled-out at, the blanks, the name or the domain is not seen by a reader, so it hides nothing.
    ["a zero-width character inside the plain at", "maya.chen a\u200Bt example.test", H],
    ["a zero-width character beside the plain at", "maya.chen \u200B at \u200D example.test", H],
    ["a zero-width character in the name before a plain at", "maya\u200B.chen at example.test", H],
    ["a zero-width character in the domain after a plain at", "maya.chen at exa\u200Dmple.test", H],
    ["a zero-width character inside [at]", "maya.chen [a\u200Bt] example.test", H],
    ["several blanks and a tab around a plain at", "maya.chen  \t at \t  example.test", H],
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
    // A name that ends like a site or a product is not a person.
    ["a product name ending in io", "Socket.IO at socket.io"],
    ["a name ending in net, ai, dev or app", "use asp.net at example.test, open.ai at example.test, my.dev at example.test, the.app at example.test"],
    ["a zero-width character in a sentence with at", "look a\u200Bt example.test for details"],
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

// Review fixes (release 0.5.7): a colon after the domain is not always a git remote, and the match is linear in the text.
describe("hideEmailAddresses: what follows the domain", () => {
  const at = String.fromCharCode(64);
  const hidden: Array<[string, string, string]> = [
    ["a port", `maya${at}example.com:8080`, `${H}:8080`],
    ["a word", `maya${at}example.com:note`, `${H}:note`],
    ["a label before it", `Email:maya${at}example.com:pw`, `Email:${H}:pw`],
    ["a colon and a space", `Contact maya${at}example.com: thanks`, `Contact ${H}: thanks`],
    ["a colon at the end", `maya${at}example.com:`, `${H}:`],
    ["a port and a path", `maya${at}example.com:8080/x`, `${H}:8080/x`],
  ];
  it.each(hidden)("hides an address followed by %s", (_why, text, expected) => {
    expect(hideEmailAddresses(text)).toBe(expected);
  });

  const kept = [
    `git clone git${at}github.com:org/repo.git`, `scp a.txt deploy${at}build.example.test:/srv/app`, `rsync -a dir/ deploy${at}build.example.test:~/dir`, `git remote add o git${at}github.com:Org-1/repo.name`,
    `scp file.txt deploy${at}build.example.test:/srv/app`, `git${at}gitlab.example.test:group/project.git`,
  ];
  it.each(kept.map((text) => [text]))("leaves a remote alone: %s", (text) => {
    expect(hideEmailAddresses(text)).toBe(text);
  });
});

describe("hideEmailAddresses: time", () => {
  const at = String.fromCharCode(64);
  const LIMIT_MS = 200;
  // Input is not capped on every path (Slack, a pull request body), so the scan must not grow with the square of a run of name characters, labels or blanks.
  const inputs: Array<[string, string, number?]> = [
    ["30K letters then an at sign", `${"a".repeat(30_000)}${at}`],
    ["30K dotted labels then an at sign", `${"a.".repeat(15_000)}${at}`],
    ["an at sign then 30K dotted labels", `${at}${"a.".repeat(15_000)}`],
    ["30K letters around an at sign", `${"a".repeat(15_000)}${at}${"b".repeat(15_000)}`],
    ["30K dotted labels around an at sign", `${"a.".repeat(7_500)}${at}${"b.".repeat(7_500)}`],
    ["many at signs", `${"a".concat(at)}`.repeat(15_000)],
    ["many addresses on one line", `${`a${at}b.co `}`.repeat(4_000)],
    ["30K blanks then at", `${" ".repeat(30_000)}at example.test`, 50],
    ["50K blanks then at", `${" ".repeat(50_000)}at`, 50],
    ["50K tabs then at", `${"\t".repeat(50_000)}at`, 50],
    ["blanks and zero-width characters alternating, then at", `${" \u200B".repeat(25_000)}at `, 50],
    ["an at sign then 50K zero-width characters", `${at}${"\u200B".repeat(50_000)}`, 50],
    ["a letter, an at sign and 50K zero-width characters", `a${at}${"\u200B".repeat(50_000)}`, 50],
    ["50K zero-width characters, then at", `${"\u200B".repeat(50_000)}at example.test`, 50],
    ["50K brackets and zero-width characters", "[\u200B".repeat(25_000), 50],
    ["a blank, a zero-width character and at, repeated", " \u200B at ".repeat(8_000)],
    ["a name, then blank-zero-width-at repeated, then a domain", `x${" \u200Bat\u200B ".repeat(8_000)}a.b.com`],
    ["many name-and-at pairs", "maya.chen at ".repeat(2_500)],
    ["many brackets", "[at]".repeat(10_000)],
    ["ordinary prose with at", "we looked at the results at the end of the week. ".repeat(600)],
    ["digits and dots after an at sign", `${at}${"1.".repeat(15_000)}`],
  ];
  it.each(inputs)(`takes under ${String(LIMIT_MS)} ms (or the case's own lower bound): %s`, (_why, text, limit = LIMIT_MS) => {
    // A machine-relative bound: a quadratic scan of a hostile input is orders of magnitude slower than a linear scan of plain text of the
    // same length, while a loaded CI runner slows both alike. So each case is timed (warm-up, then the best of three) against plain prose of
    // the same length on the same machine. A case may take up to 100x that baseline (never less than its own limit), and never more than
    // 2 s. A scan that grows with the square of these 30K-50K inputs is thousands of times slower than linear, so it fails either bound.
    const best = (input: string): number => {
      hideEmailAddresses(input);
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        hideEmailAddresses(input);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    const plain = "the quick brown fox jumps over the lazy dog ".repeat(Math.ceil(text.length / 44)).slice(0, text.length);
    const bound = Math.min(2_000, Math.max(limit, best(plain) * 100));
    expect(best(text)).toBeLessThan(bound);
  });

  it("still hides every address of a long line of them", () => {
    const line = `x${at}y.co `.repeat(3);
    expect(hideEmailAddresses(line)).toBe(`${H} `.repeat(3));
  });

  it("cuts a local part at 64 characters: the 64 before the at sign are the address", () => {
    expect(hideEmailAddresses(`${"a".repeat(64)}${at}example.test`)).toBe(H);
    expect(hideEmailAddresses(`${"a".repeat(70)}${at}example.test`)).toBe(`${"a".repeat(6)}${H}`);
  });
});
