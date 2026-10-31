// Meta repo lane B, task B3: the broker re-reads every place a setup proposal says a value came from. A model can invent a quote, a file or a line; this is what stops the
// page from showing an invented source as a checked one.
import { describe, expect, it, vi } from "vitest";
import { sanitizeSetupProposal, type SetupProposal } from "../../packages/contracts/src/index.js";
import { VERIFY_LINE_SLACK, VERIFY_READS_MAX, citationHolds, verificationIsFinal, verifyProposal, type CitationFileReader } from "../../packages/broker/src/rovara-code/setup-proposal-verify.js";

const COMMIT = "a".repeat(40);
const context = { basedOnRevision: 1, repositories: [{ name: "web" }, { name: "api" }] };
const cite = (path: string, extra: Record<string, unknown> = {}, repo = "web") => ({ kind: "file", repo, path, commit: COMMIT, ...extra });
const proposalOf = (answer: unknown): SetupProposal => {
  const read = sanitizeSetupProposal(answer, context);
  if (!read.ok) throw new Error(read.errors.join("; "));
  return read.proposal;
};
const reader = (files: Record<string, string>): CitationFileReader => async (repository, path, _commit, options) => {
  const text = files[`${repository}:${path}`];
  return text === undefined || options.untilLine === undefined ? text : text.split("\n").slice(0, options.untilLine).join("\n");
};

describe("whether a file supports a citation", () => {
  const text = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n");
  it("needs the line to exist, and the quote to be within a few lines of it (whitespace collapsed), or anywhere in the file when no line is cited", () => {
    expect(citationHolds(text, { line: 3 })).toBe(true);
    expect(citationHolds(text, { line: 11 })).toBe(false);
    expect(citationHolds(text, { line: 5, quote: "five" })).toBe(true);
    expect(citationHolds(text, { line: 5, quote: "five" })).toBe(true);
    expect(citationHolds(text, { line: 5 - VERIFY_LINE_SLACK, quote: "five" })).toBe(true);
    expect(citationHolds(text, { line: 5 + VERIFY_LINE_SLACK, quote: "five" })).toBe(true);
    expect(citationHolds(text, { line: 5 - VERIFY_LINE_SLACK - 1, quote: "five" })).toBe(false);
    expect(citationHolds(text, { line: 5 + VERIFY_LINE_SLACK + 1, quote: "five" })).toBe(false);
    expect(citationHolds(text, { quote: "nine" })).toBe(true);
    expect(citationHolds(text, { quote: "nineteen" })).toBe(false);
    expect(citationHolds("a   b\n\tc", { line: 1, quote: "a b c" })).toBe(true);
    expect(citationHolds(text, {})).toBe(true);
  });
});

describe("verifying a proposal", () => {
  it("verifies an item whose every file citation holds, and fails one whose citation is wrong even when another holds", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json", { line: 2, quote: "scripts" })] }],
      tests: [{ repo: "web", commands: ["npm test"], from: [cite("package.json", { line: 2, quote: "scripts" }), cite("package.json", { line: 2, quote: "invented words" })] }],
      checks: [{ name: "lint", repo: "web", command: "npm run lint", from: [cite("gone.yml")] }],
    });
    const verdicts = await verifyProposal(reader({ "web:package.json": "{\n  \"scripts\": {}\n}\n" }), proposal);
    expect(verdicts).toEqual({ "setup-web": "verified", "tests-web": "unverified", "check-web-lint": "unverified" });
  });

  it("calls an item with no file to read, or nothing to read it with, unchecked, never verified", async () => {
    const proposal = proposalOf({ knowledge: [{ path: "docs/A.md", kind: "keyDoc", from: [{ kind: "inferred", repo: "web", note: "mentioned in the readme" }] }], setup: [{ repo: "web", commands: ["make"], from: [cite("Makefile")] }] });
    expect(await verifyProposal(reader({}), proposal)).toEqual({ "knowledge-docs-a.md": "unchecked", "setup-web": "unverified" });
    expect(await verifyProposal(undefined, proposal)).toEqual({ "knowledge-docs-a.md": "unchecked", "setup-web": "unchecked" });
    expect(verificationIsFinal(proposal, { "knowledge-docs-a.md": "unchecked", "setup-web": "unchecked" })).toBe(false);
    expect(verificationIsFinal(proposal, { "knowledge-docs-a.md": "unchecked", "setup-web": "verified" })).toBe(true);
  });

  it("calls a read that throws unchecked, not unverified, and goes on with the others", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["make"], from: [cite("Makefile")] }], tests: [{ repo: "api", commands: ["make test"], from: [cite("Makefile", {}, "api")] }] });
    const read: CitationFileReader = async (repository) => { if (repository === "web") throw new Error("boom"); return "all:\n"; };
    expect(await verifyProposal(read, proposal)).toEqual({ "setup-web": "unchecked", "tests-api": "verified" });
  });

  it("reads each file once however many items cite it, as far as the deepest line needed, and the whole file when a citation names no line", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["a"], from: [cite("f.txt", { line: 2 })] }],
      tests: [{ repo: "web", commands: ["b"], from: [cite("f.txt", { line: 20 })] }],
      checks: [{ name: "c", repo: "web", command: "c", from: [cite("g.txt")] }],
    });
    const read = vi.fn<CitationFileReader>(async () => "x\n".repeat(50));
    await verifyProposal(read, proposal);
    expect(read).toHaveBeenCalledTimes(2);
    const calls = read.mock.calls.map(([, path, , options]) => [path, options.untilLine]);
    expect(calls).toEqual(expect.arrayContaining([["f.txt", 20 + VERIFY_LINE_SLACK + 1], ["g.txt", undefined]]));
  });

  it("reads at most a bounded number of files and leaves the rest unchecked", async () => {
    const knowledge = Array.from({ length: 40 }, (_, index) => ({ path: `d${String(index)}.md`, kind: "keyDoc", from: [cite(`d${String(index)}.md`)] }));
    const setup = [{ repo: "web", commands: ["a"], from: [cite("s.txt")] }, { repo: "api", commands: ["b"], from: [cite("s.txt", {}, "api")] }];
    const proposal = proposalOf({ knowledge, setup, tests: [{ repo: "web", commands: ["t"], from: [cite("t.txt")] }, { repo: "api", commands: ["t"], from: [cite("t2.txt", {}, "api")] }] });
    const read = vi.fn<CitationFileReader>(async () => "text");
    const verdicts = await verifyProposal(read, proposal);
    expect(read).toHaveBeenCalledTimes(VERIFY_READS_MAX);
    expect(Object.values(verdicts).filter((verdict) => verdict === "unchecked").length).toBe(44 - VERIFY_READS_MAX);
    expect(Object.values(verdicts).filter((verdict) => verdict === "verified").length).toBe(VERIFY_READS_MAX);
  });

  it("stops reading when the deadline passes and leaves what it did not read unchecked", async () => {
    let clock = 0;
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["a"], from: [cite("a.txt")] }], tests: [{ repo: "web", commands: ["b"], from: [cite("b.txt")] }] });
    const read = vi.fn<CitationFileReader>(async () => { clock += 30_000; return "text"; });
    const verdicts = await verifyProposal(read, proposal, { now: () => clock, deadlineMs: 20_000 });
    expect(Object.values(verdicts).sort()).toEqual(["unchecked", "verified"].sort());
    expect(read.mock.calls.length).toBeLessThan(2);
  });

  it("never writes or returns file text: only a verdict per item", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["a"], from: [cite("a.txt", { line: 1, quote: "SECRET-TOKEN" })] }] });
    const verdicts = await verifyProposal(async () => "SECRET-TOKEN here", proposal);
    expect(verdicts).toEqual({ "setup-web": "verified" });
    expect(JSON.stringify(verdicts)).not.toContain("SECRET");
  });
});
