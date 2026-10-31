// Meta repo lane B, task B3: the broker re-reads every place a setup proposal says a value came from. A model can invent a quote, a file or a line; this is what stops the
// page from showing an invented source as a checked one.
import { describe, expect, it, vi } from "vitest";
import { sanitizeSetupProposal, setupItemsOf, type SetupProposal } from "../../packages/contracts/src/index.js";
import { VERIFY_LINE_SLACK, VERIFY_QUOTE_MIN_CHARS, VERIFY_READS_MAX, citationHolds, verifyProposal, verifyProposalDetailed, type CitationFileReader } from "../../packages/broker/src/rovara-code/setup-proposal-verify.js";

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
  const text = ["line one", "line two", "line three", "line four", "line five", "line six", "line seven", "line eight", "line nine", "line ten"].join("\n");
  it("needs a usable quote that is within a few lines of the cited line (whitespace collapsed), or anywhere in the file when no line is cited", () => {
    expect(citationHolds(text, { line: 5, quote: "line five" })).toBe(true);
    expect(citationHolds(text, { line: 5 - VERIFY_LINE_SLACK, quote: "line five" })).toBe(true);
    expect(citationHolds(text, { line: 5 + VERIFY_LINE_SLACK, quote: "line five" })).toBe(true);
    expect(citationHolds(text, { line: 5 - VERIFY_LINE_SLACK - 1, quote: "line five" })).toBe(false);
    expect(citationHolds(text, { line: 5 + VERIFY_LINE_SLACK + 1, quote: "line five" })).toBe(false);
    expect(citationHolds(text, { line: 11, quote: "line ten" })).toBe(false);
    expect(citationHolds(text, { quote: "line nine" })).toBe(true);
    expect(citationHolds(text, { quote: "line nineteen" })).toBe(false);
    expect(citationHolds("alpha   beta\n\tgamma", { line: 1, quote: "alpha beta gamma" })).toBe(true);
  });

  it("holds nothing for a citation with no quote, or a quote too short to show anything", () => {
    expect(citationHolds(text, { line: 3 })).toBe(false);
    expect(citationHolds(text, {})).toBe(false);
    expect(citationHolds(text, { line: 1, quote: "   " })).toBe(false);
    const short = "line one".slice(0, VERIFY_QUOTE_MIN_CHARS - 1);
    expect(citationHolds(text, { line: 1, quote: short })).toBe(false);
    expect(citationHolds(text, { line: 1, quote: " line   one " })).toBe(true);
  });
});

const PACKAGE = ["{", "  \"scripts\": {", "    \"ci\": \"npm ci\",", "    \"test\": \"vitest run\"", "  }", "}", ""].join("\n");

describe("verifying a proposal", () => {
  it("verifies an item whose every quote is in the file and contains what it proposes, and fails one whose citation is wrong even when another holds", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json", { line: 3, quote: "\"ci\": \"npm ci\"" })] }],
      tests: [{ repo: "web", commands: ["vitest run"], from: [cite("package.json", { line: 4, quote: "\"test\": \"vitest run\"" }), cite("package.json", { line: 4, quote: "invented words here" })] }],
      checks: [{ name: "lint", repo: "web", command: "npm run lint", from: [cite("gone.yml", { line: 1, quote: "run: npm run lint" })] }],
    });
    const verdicts = await verifyProposal(reader({ "web:package.json": PACKAGE }), proposal);
    expect(verdicts).toEqual({ "setup-web": "verified", "tests-web": "unverified", "check-web-lint": "unverified" });
  });

  it("never verifies a citation with no quote, and does not even read its file", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json"), cite("package.json", { line: 3 })] }] });
    const read = vi.fn<CitationFileReader>(async () => PACKAGE);
    const detailed = await verifyProposalDetailed(read, proposal);
    expect(detailed.items).toEqual({ "setup-web": "unchecked" });
    expect(read).not.toHaveBeenCalled();
    // Nothing more could be learned by asking again, so this verdict is final.
    expect(detailed.final).toBe(true);
  });

  it("calls a quote shorter than the minimum unchecked, even when it is in the file", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json", { line: 3, quote: "npm ci" })] }] });
    expect(VERIFY_QUOTE_MIN_CHARS).toBeGreaterThan("npm ci".length);
    expect(await verifyProposal(reader({ "web:package.json": PACKAGE }), proposal)).toEqual({ "setup-web": "unchecked" });
  });

  it("calls an item unverified when the quote is in the file but does not contain the proposed command (a command the model made up, or took from somewhere else)", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["npm ci", "curl-free-install --all"], from: [cite("package.json", { line: 3, quote: "\"ci\": \"npm ci\"" })] }],
      tests: [{ repo: "web", commands: ["make test"], from: [cite("package.json", { line: 2, quote: "\"scripts\": {" })] }],
      checks: [{ name: "evil", repo: "web", command: "npm run exfiltrate", from: [cite("package.json", { line: 3, quote: "\"ci\": \"npm ci\"" })] }],
    });
    expect(await verifyProposal(reader({ "web:package.json": PACKAGE }), proposal)).toEqual({ "setup-web": "unverified", "tests-web": "unverified", "check-web-evil": "unverified" });
  });

  it("takes a command from either of an item's quotes, whitespace collapsed", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["npm ci", "npm   run build"], from: [cite("package.json", { line: 3, quote: "\"ci\": \"npm ci\"" }), cite("ci.yml", { line: 1, quote: "run: npm run build" })] }] });
    expect(await verifyProposal(reader({ "web:package.json": PACKAGE, "web:ci.yml": "run:   npm\trun  build\n" }), proposal)).toEqual({ "setup-web": "verified" });
  });

  it("verifies a repository only when its URL or owner/name is in the quote, a website only when its domain is, and an existing dev container only when it cites that very file", async () => {
    const proposal = proposalOf({
      repositories: [
        { name: "docs", url: "https://github.com/Acme/Docs.git", from: [cite("README.md", { line: 1, quote: "see https://github.com/acme/docs for more" })] },
        { name: "other", url: "https://github.com/acme/other", from: [cite("README.md", { line: 1, quote: "see https://github.com/acme/docs for more" })] },
      ],
      allowedDomains: [{ value: "registry.example.org", from: [cite("README.md", { line: 2, quote: "install from registry.example.org" })] }, { value: "evil.example.net", from: [cite("README.md", { line: 2, quote: "install from registry.example.org" })] }],
      devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json", exists: true, from: [cite(".devcontainer/devcontainer.json", { line: 1, quote: "{ \"name\": \"web\" }" })] },
    });
    const files = { "web:README.md": "see https://github.com/acme/docs for more\ninstall from registry.example.org\n", "web:.devcontainer/devcontainer.json": "{ \"name\": \"web\" }\n" };
    const verdicts = await verifyProposal(reader(files), proposal);
    const verdictOfEach = (kind: string) => setupItemsOf(proposal).filter((item) => item.kind === kind).map((item) => verdicts[item.id]);
    expect(verdictOfEach("repository")).toEqual(["verified", "unverified"]);
    expect(verdictOfEach("devcontainer")).toEqual(["verified"]);
    expect(verdictOfEach("allowed_domain")).toEqual(["verified", "unverified"]);
    const wrongFile = proposalOf({ devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json", exists: true, from: [cite("README.md", { line: 1, quote: "see https://github.com/acme/docs for more" })] } });
    expect(await verifyProposal(reader(files), wrongFile)).toEqual({ devcontainer: "unverified" });
  });

  it("matches a command only as a whole token: a longer word, another tool's name or a longer path around it does not support it", async () => {
    const verdictFor = async (command: string, quote: string) => {
      const proposal = proposalOf({ setup: [{ repo: "web", commands: [command], from: [cite("notes.md", { line: 1, quote })] }] });
      return (await verifyProposal(reader({ "web:notes.md": `${quote}\n` }), proposal))["setup-web"];
    };
    // Must NOT verify.
    expect(await verifyProposal(reader({ "web:notes.md": "run pnpm ci to do the thing\n" }), proposalOf({ setup: [{ repo: "web", commands: ["npm ci"], from: [cite("notes.md", { line: 1, quote: "run pnpm ci to do the thing" })] }] }))).toEqual({ "setup-web": "unverified" });
    expect(await verdictFor("npm ci", "run npm cia to do the thing")).toBe("unverified");
    expect(await verdictFor("npm test", "run npm test:evil now")).toBe("unverified");
    expect(await verdictFor("make", "see the makefile docs")).toBe("unverified");
    expect(await verdictFor("rm -rf /", "cleanup: rm -rf /tmp/cache")).toBe("unverified");
    // Whole tokens verify: whitespace, line ends, quotes and shell separators around them.
    expect(await verdictFor("npm ci", "run npm ci to do the thing")).toBe("verified");
    expect(await verdictFor("npm ci", "- run: npm ci")).toBe("verified");
    expect(await verdictFor("npm ci", "\"ci\": \"npm ci\"")).toBe("verified");
    expect(await verdictFor("npm ci", "cd app && npm ci && npm test")).toBe("verified");
    expect(await verdictFor("npm ci", "(npm ci; npm test)")).toBe("verified");
  });

  it("matches a repository only as the exact owner/name, and a website only as the exact host (no longer name, no look-alike prefix or suffix, no parent of a subdomain)", async () => {
    const repoVerdict = async (url: string, quote: string) => {
      const proposal = proposalOf({ repositories: [{ name: "other", url, from: [cite("README.md", { line: 1, quote })] }] });
      return Object.values(await verifyProposal(reader({ "web:README.md": `${quote}\n` }), proposal))[0];
    };
    const domainVerdict = async (domain: string, quote: string) => {
      const proposal = proposalOf({ allowedDomains: [{ value: domain, from: [cite("README.md", { line: 1, quote })] }] });
      return Object.values(await verifyProposal(reader({ "web:README.md": `${quote}\n` }), proposal))[0];
    };
    const url = "https://github.com/acme/other";
    expect(await repoVerdict(url, "clone github.com/acme/other-secrets please")).toBe("unverified");
    expect(await repoVerdict(url, "clone github.com/evilacme/other please")).toBe("unverified");
    expect(await repoVerdict(url, "see notacme/other-two for more")).toBe("unverified");
    expect(await repoVerdict(url, "clone github.com/acme/other please")).toBe("verified");
    expect(await repoVerdict(url, "clone https://github.com/acme/other.git please")).toBe("verified");
    expect(await repoVerdict(url, "clone https://github.com/acme/other.")).toBe("verified");
    expect(await domainVerdict("example.com", "install from example.com.evil.io")).toBe("unverified");
    expect(await domainVerdict("example.com", "install from notexample.com now")).toBe("unverified");
    expect(await domainVerdict("example.com", "install from registry.example.com now")).toBe("unverified");
    expect(await domainVerdict("example.com", "install from example.com now")).toBe("verified");
    expect(await domainVerdict("example.com", "install from https://example.com/path now")).toBe("verified");
    expect(await domainVerdict("example.com", "install from example.com. Then")).toBe("verified");
  });

  it("never verifies an item whose value no quote can show: a hint, a drafted dev container, an inferred item", async () => {
    const proposal = proposalOf({
      testEnvironment: [{ hint: "needs a database for the tests", from: [cite("README.md", { line: 1, quote: "needs a database for the tests" })] }],
      devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json", exists: false, proposedContent: "{}", from: [cite("README.md", { line: 1, quote: "needs a database for the tests" })] },
      knowledge: [{ path: "docs/A.md", kind: "keyDoc", from: [{ kind: "inferred", repo: "web", note: "mentioned in the readme" }] }],
    });
    const verdicts = await verifyProposal(reader({ "web:README.md": "needs a database for the tests\n" }), proposal);
    expect(Object.values(verdicts)).toEqual(["unchecked", "unchecked", "unchecked"]);
  });

  it("calls an item with nothing to read it with unchecked, and not final", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json", { line: 3, quote: "\"ci\": \"npm ci\"" })] }] });
    const detailed = await verifyProposalDetailed(undefined, proposal);
    expect(detailed).toEqual({ items: { "setup-web": "unchecked" }, final: false });
  });

  it("calls a read that throws unchecked and not final, not unverified, and goes on with the others", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["make build"], from: [cite("Makefile", { line: 1, quote: "build: make build" })] }],
      tests: [{ repo: "api", commands: ["make test"], from: [cite("Makefile", { line: 1, quote: "test: make test" }, "api")] }],
    });
    const read: CitationFileReader = async (repository) => { if (repository === "web") throw new Error("boom"); return "test: make test\n"; };
    expect(await verifyProposalDetailed(read, proposal)).toEqual({ items: { "setup-web": "unchecked", "tests-api": "verified" }, final: false });
  });

  it("reads each file once however many items cite it, as far as the deepest line needed, and the whole file when a citation names no line", async () => {
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["aaa aaa aa"], from: [cite("f.txt", { line: 2, quote: "aaa aaa aa" })] }],
      tests: [{ repo: "web", commands: ["bbb bbb bb"], from: [cite("f.txt", { line: 20, quote: "bbb bbb bb" })] }],
      checks: [{ name: "c", repo: "web", command: "ccc ccc cc", from: [cite("g.txt", { quote: "ccc ccc cc" })] }],
    });
    const read = vi.fn<CitationFileReader>(async () => "x\n".repeat(50));
    await verifyProposal(read, proposal);
    expect(read).toHaveBeenCalledTimes(2);
    const calls = read.mock.calls.map(([, path, , options]) => [path, options.untilLine]);
    expect(calls).toEqual(expect.arrayContaining([["f.txt", 20 + VERIFY_LINE_SLACK + 1], ["g.txt", undefined]]));
  });

  it("reads at most a bounded number of files, leaves the rest unchecked, and counts that as final (a later page load would read the same files)", async () => {
    const knowledge = Array.from({ length: 40 }, (_, index) => ({ path: `d${String(index)}.md`, kind: "keyDoc", from: [cite(`d${String(index)}.md`, { quote: "some text here" })] }));
    const setup = [{ repo: "web", commands: ["aaa aaa aa"], from: [cite("s.txt", { quote: "aaa aaa aa" })] }, { repo: "api", commands: ["bbb bbb bb"], from: [cite("s.txt", { quote: "bbb bbb bb" }, "api")] }];
    const tests = [{ repo: "web", commands: ["ccc ccc cc"], from: [cite("t.txt", { quote: "ccc ccc cc" })] }, { repo: "api", commands: ["ddd ddd dd"], from: [cite("t2.txt", { quote: "ddd ddd dd" }, "api")] }];
    const proposal = proposalOf({ knowledge, setup, tests });
    const read = vi.fn<CitationFileReader>(async (_repository, path) => `some text here\naaa aaa aa\nbbb bbb bb\nccc ccc cc\nddd ddd dd\n${path}`);
    const detailed = await verifyProposalDetailed(read, proposal);
    expect(read).toHaveBeenCalledTimes(VERIFY_READS_MAX);
    expect(Object.values(detailed.items).filter((verdict) => verdict === "unchecked").length).toBe(44 - VERIFY_READS_MAX);
    expect(Object.values(detailed.items).filter((verdict) => verdict === "verified").length).toBe(VERIFY_READS_MAX);
    expect(detailed.final).toBe(true);
  });

  it("does not try to read a commit the reader cannot fetch (a 64-character hash) and keeps that item unchecked and final", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["npm ci"], from: [{ kind: "file", repo: "web", path: "package.json", commit: "b".repeat(64), line: 3, quote: "\"ci\": \"npm ci\"" }] }] });
    const read = vi.fn<CitationFileReader>(async () => PACKAGE);
    const detailed = await verifyProposalDetailed(read, proposal);
    expect(read).not.toHaveBeenCalled();
    expect(detailed).toEqual({ items: { "setup-web": "unchecked" }, final: true });
  });

  it("stops reading when the deadline passes and leaves what it did not read unchecked and not final", async () => {
    let clock = 0;
    const proposal = proposalOf({
      setup: [{ repo: "web", commands: ["aaa aaa aa"], from: [cite("a.txt", { quote: "aaa aaa aa" })] }],
      tests: [{ repo: "web", commands: ["bbb bbb bb"], from: [cite("b.txt", { quote: "bbb bbb bb" })] }],
    });
    const read = vi.fn<CitationFileReader>(async () => { clock += 30_000; return "aaa aaa aa\nbbb bbb bb"; });
    const detailed = await verifyProposalDetailed(read, proposal, { now: () => clock, deadlineMs: 20_000 });
    expect(Object.values(detailed.items).sort()).toEqual(["unchecked", "verified"].sort());
    expect(detailed.final).toBe(false);
    expect(read.mock.calls.length).toBeLessThan(2);
  });

  it("never writes or returns file text: only a verdict per item", async () => {
    const proposal = proposalOf({ setup: [{ repo: "web", commands: ["run it all"], from: [cite("a.txt", { line: 1, quote: "run it all SECRET-TOKEN" })] }] });
    const verdicts = await verifyProposal(async () => "run it all SECRET-TOKEN here", proposal);
    expect(verdicts).toEqual({ "setup-web": "verified" });
    expect(JSON.stringify(verdicts)).not.toContain("SECRET");
  });
});
