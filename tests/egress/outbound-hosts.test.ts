// Enterprise foundations, task N4: the "no phone home" guard. The Enterprise edition sends nothing to Rovara by default, and an install's network team needs
// the list of every host the code can reach. This test fails when the code names a host that is not in the list, names a listed host somewhere its rule does
// not allow, or stops naming a listed host; and it keeps docs/enterprise/outbound.md equal to the list.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_TITLES, HOST_RULES, checkAgainstRules, renderOutboundDoc } from "./outbound-allowlist.js";
import { foundHostsIn, scanOutboundHosts, withoutComments } from "./scan-outbound-hosts.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = join(ROOT, "docs", "enterprise", "outbound.md");
const describeOccurrence = (occurrence: { host: string; file: string; line: number }) => `${occurrence.host} (${occurrence.file}:${String(occurrence.line)})`;

describe("the hosts the code can reach", () => {
  const found = scanOutboundHosts(ROOT);
  const check = checkAgainstRules(found, HOST_RULES);

  it("finds the hosts the code is known to name, so a scan that finds nothing cannot pass", () => {
    const hosts = new Set(found.map((entry) => entry.host));
    for (const host of ["api.github.com", "slack.com", "api.anthropic.com", "timestamp.digicert.com", "rovara.dev", "registry.npmjs.org"]) expect(hosts.has(host), host).toBe(true);
    expect(found.length).toBeGreaterThan(100);
  });

  it("lists every host the code names; a new hard-coded host fails here until it is classified", () => {
    expect(check.unlisted.map(describeOccurrence)).toEqual([]);
  });

  it("names a host only where its rule allows (a call to a Rovara-operated, timestamp or supply-chain host from somewhere new is looked at)", () => {
    expect(check.misplaced.map(describeOccurrence)).toEqual([]);
  });

  it("lists no host the code has stopped naming, and no host twice", () => {
    expect(check.stale).toEqual([]);
    expect(check.duplicated).toEqual([]);
  });

  it("never lists a Rovara-operated host outside the one category that says it is only a link", () => {
    for (const rule of HOST_RULES) {
      if (rule.hosts.some((host) => host === "rovara.dev" || host.endsWith(".rovara.dev"))) expect(rule.category).toBe("rovara-operated");
    }
    const rovara = HOST_RULES.filter((rule) => rule.category === "rovara-operated");
    for (const rule of rovara) expect(rule.files, "a Rovara-operated host is allowed in named files only").toBeDefined();
    expect(CATEGORY_TITLES["rovara-operated"].enterprise).toMatch(/No Enterprise code path calls a Rovara-operated host/);
  });

  it("keeps docs/enterprise/outbound.md equal to the list", () => {
    const expected = renderOutboundDoc(HOST_RULES);
    if (process.env.UPDATE_OUTBOUND_DOC === "1") writeFileSync(DOC, expected);
    expect(existsSync(DOC), "docs/enterprise/outbound.md is missing: run this test with UPDATE_OUTBOUND_DOC=1").toBe(true);
    expect(readFileSync(DOC, "utf8")).toBe(expected);
  });
});

describe("the checker can fail", () => {
  const planted = [
    { host: "telemetry.rovara.example.org", file: "packages/broker/src/new-feature.ts", line: 12 },
    { host: "rovara.dev", file: "packages/broker/src/aws/broker.ts", line: 5 },
    { host: "api.github.com", file: "packages/broker/src/github-app.ts", line: 1 },
  ];

  it("reports a new host, a listed host in a file its rule does not allow, a stale entry and a duplicate", () => {
    const result = checkAgainstRules(planted, [
      ...HOST_RULES,
      { category: "doc-link", why: "duplicate", hosts: ["docs.aws.amazon.com"] },
    ]);
    expect(result.unlisted.map((entry) => entry.host)).toEqual(["telemetry.rovara.example.org"]);
    expect(result.misplaced.map((entry) => entry.host)).toEqual(["rovara.dev"]);
    expect(result.stale).toContain("slack.com");
    expect(result.duplicated).toEqual(["docs.aws.amazon.com"]);
  });
});

describe("the scanner", () => {
  it("finds a host in a URL literal and one alone in a string, and reports its line", () => {
    const text = ["const a = 1;", "const url = \"https://Telemetry.Example.org/ping\";", "const host = 'api.eu.example.dev';", "const wild = `*.example.com`;"].join("\n");
    expect(foundHostsIn(text, "x.ts")).toEqual([
      { host: "telemetry.example.org", file: "x.ts", line: 2 },
      { host: "api.eu.example.dev", file: "x.ts", line: 3 },
      { host: "*.example.com", file: "x.ts", line: 4 },
    ]);
  });

  it("does not count a host that only a comment names, but still reads a URL's own double slash", () => {
    const text = ["// see https://docs.example.org/x", "/* https://block.example.org */", "const a = fetch(\"https://real.example.org/x\"); // https://trailing.example.org", "/**", " * https://jsdoc.example.org", " */"].join("\n");
    expect(foundHostsIn(text, "x.ts").map((entry) => entry.host)).toEqual(["real.example.org"]);
    expect(withoutComments(text).split("\n")).toHaveLength(6);
  });

  it("leaves out the part of a host that is built at run time, and file names that only look like hosts", () => {
    const text = "const a = `https://${tenant}.example.org/x`; const b = \"index.ts\"; const c = \"package.json\"; const d = \"readme.md\";";
    expect(foundHostsIn(text, "x.ts")).toEqual([]);
  });
});
