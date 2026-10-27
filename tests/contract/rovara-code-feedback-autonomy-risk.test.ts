// Rovara Code (Plan 6 Tasks 15 and 16): a fix to an open pull request (for CI, a conflict or review comments) may not hide the failure it was asked to fix. A fix that removes or skips tests,
// or changes CI configuration, is high risk (Task 13's risk rules, recomputed when the fix is pushed). The same change as an ordinary build is judged as it always was.
import { describe, expect, it } from "vitest";
import { RiskAssessmentSchema, type VerificationReport } from "@agentx/contracts";
import { createCandidateManifest } from "@agentx/contracts";
import { parseChangedFiles } from "../../packages/broker/src/rovara-code/changed-files.js";
import { CI_CONFIG_PATH_PATTERNS, assessRisk, type RiskInput } from "../../packages/broker/src/rovara-code/risk.js";

const digest = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
const cleanReport: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
const input = (overrides: Partial<RiskInput> = {}): RiskInput => ({ changedFiles: [], changedFilesComplete: true, report: cleanReport, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...overrides });
const section = (diff: string[], status: string[] = []) => ["## payments", "", "### status", ...status, "### diff", ...diff].join("\n");
const hunk = (path: string, lines: string[]): string[] => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", ...lines];

describe("what a change does to the tests it touches", () => {
  it("a test file that is deleted, or that only loses lines, is a test removed; a test that gains lines is not", () => {
    const text = section([
      "diff --git a/src/a.test.ts b/src/a.test.ts", "deleted file mode 100644", "index 1..0", "--- a/src/a.test.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-it('a', () => {})", "-it('b', () => {})",
      ...hunk("tests/b.spec.ts", ["-expect(1).toBe(2);", " keep"]),
      ...hunk("tests/c.test.ts", ["-old", "+new", "+more"]),
      ...hunk("src/d.ts", ["-gone"]),
    ]);
    const files = parseChangedFiles(text).files;
    expect(files.find((file) => file.path === "src/a.test.ts")).toMatchObject({ testsRemoved: true, removed: 2 });
    expect(files.find((file) => file.path === "tests/b.spec.ts")).toMatchObject({ testsRemoved: true });
    expect(files.find((file) => file.path === "tests/c.test.ts")?.testsRemoved).toBeUndefined();
    // Only a test is judged: other code that only loses lines is just a smaller file.
    expect(files.find((file) => file.path === "src/d.ts")?.testsRemoved).toBeUndefined();
  });

  it("a test file deleted with nothing in it to count is still a test removed", () => {
    const text = section(["diff --git a/tests/empty.test.ts b/tests/empty.test.ts", "deleted file mode 100644", "index e69de29..0000000"]);
    expect(parseChangedFiles(text).files[0]).toMatchObject({ path: "tests/empty.test.ts", testsRemoved: true });
    expect(parseChangedFiles(section(["diff --git a/src/empty.ts b/src/empty.ts", "deleted file mode 100644", "index e69de29..0000000"])).files[0]?.testsRemoved).toBeUndefined();
  });

  it("a line added to a test that switches a test off is a test skipped, in the common frameworks", () => {
    for (const line of ["+it.skip('x', () => {})", "+  test.todo('x')", "+xit('x', () => {})", "+describe.skip('x', () => {})", "+  @Disabled", "+  t.Skip(\"later\")", "+@pytest.mark.skip(reason='flaky')", "+    self.skipTest('no')"]) {
      const files = parseChangedFiles(section(hunk("tests/a.test.ts", [line, " keep"]))).files;
      expect(files[0]?.testsSkipped, line).toBe(true);
    }
    for (const line of ["+it('x', () => {})", "+const skip = 3;", "+// skipping nothing", "-it.skip('x', () => {})"]) {
      expect(parseChangedFiles(section(hunk("tests/a.test.ts", [line, " keep"]))).files[0]?.testsSkipped, line).toBeUndefined();
    }
    // A skip marker in code that is not a test is not a test skipped.
    expect(parseChangedFiles(section(hunk("src/a.ts", ["+it.skip('x')"]))).files[0]?.testsSkipped).toBeUndefined();
  });

  it("a test renamed out of the test paths is a test removed (nothing is left for CI to run), and a test renamed within them is not", () => {
    const rename = (from: string, to: string) => section([`diff --git a/${from} b/${to}`, "similarity index 100%", `rename from ${from}`, `rename to ${to}`]);
    for (const [from, to] of [["src/a.test.ts", "src/a.test.ts.off"], ["tests/x.ts", "fixtures/x.ts"], ["src/billing.spec.ts", "src/billing.ts.bak"]] as const) {
      expect(parseChangedFiles(rename(from, to)).files[0], `${from} -> ${to}`).toMatchObject({ path: to, renamedFrom: from, testsRemoved: true });
    }
    expect(parseChangedFiles(rename("src/a.test.ts", "src/b.test.ts")).files[0]?.testsRemoved).toBeUndefined();
    expect(parseChangedFiles(rename("src/a.ts", "src/b.ts")).files[0]?.testsRemoved).toBeUndefined();
  });

  it("a test gutted with a line added is a test removed: it loses more lines than it gains", () => {
    const gutted = parseChangedFiles(section(hunk("tests/a.test.ts", ["-expect(a).toBe(1);", "-expect(b).toBe(2);", "-expect(c).toBe(3);", "+// TODO", " keep"]))).files[0];
    expect(gutted).toMatchObject({ added: 1, removed: 3, testsRemoved: true });
    // A test that gains as many lines as it loses is a rewrite, not a removal.
    expect(parseChangedFiles(section(hunk("tests/a.test.ts", ["-expect(a).toBe(1);", "+expect(a).toBe(2);", " keep"]))).files[0]?.testsRemoved).toBeUndefined();
  });

  it("focusing one test switches the rest off: .only, fit, fdescribe, a Rust #[ignore], a skipIf and a fixme all count as skipped", () => {
    for (const line of ["+it.only('x', () => {})", "+describe.only('x', () => {})", "+fit('x', () => {})", "+  fdescribe('x', () => {})", "+#[ignore]", "+test.skipIf(true)('x', () => {})", "+test.fixme('x', () => {})", "+  it.concurrent.skip('x', () => {})"]) {
      expect(parseChangedFiles(section(hunk("tests/a.test.ts", [line, " keep"]))).files[0]?.testsSkipped, line).toBe(true);
    }
    expect(parseChangedFiles(section(hunk("tests/a.test.ts", ["+const only = 1;", "+const fits = 2;", " keep"]))).files[0]?.testsSkipped).toBeUndefined();
  });

  it("a change to the test command in package.json is seen, and an ordinary dependency change is not", () => {
    const test = (line: string) => parseChangedFiles(section(["diff --git a/package.json b/package.json", "--- a/package.json", "+++ b/package.json", "@@ -1,3 +1,3 @@", line, " keep"])).files[0];
    for (const line of ['-    "test": "vitest run",', '+    "test": "echo skipped",', '+    "test:unit": "true",']) expect(test(line)?.testCommandChanged, line).toBe(true);
    for (const line of ['+    "lodash": "^4.17.21",', '+    "pretest": "x",', '+    "testing-library": "1.0.0",']) expect(test(line)?.testCommandChanged, line).toBeUndefined();
    // Only package.json carries the test command: the same text elsewhere is not it.
    expect(parseChangedFiles(section(hunk("src/a.json", ['+    "test": "x",', " keep"]))).files[0]?.testCommandChanged).toBeUndefined();
  });

  it("a renamed test file is still a test", () => {
    const text = section(["diff --git a/tests/old.test.ts b/src/legacy.ts", "similarity index 90%", "rename from tests/old.test.ts", "rename to src/legacy.ts", "--- a/tests/old.test.ts", "+++ b/src/legacy.ts", "@@ -1 +0,0 @@", "-it('a')"]);
    expect(parseChangedFiles(text).files[0]).toMatchObject({ path: "src/legacy.ts", renamedFrom: "tests/old.test.ts", testsRemoved: true });
  });
});

describe("the risk of a fix", () => {
  const removed = { repository: "payments", path: "tests/a.test.ts", added: 0, removed: 4, testsRemoved: true as const };
  const skipped = { repository: "payments", path: "tests/a.test.ts", added: 1, removed: 0, testsSkipped: true as const };

  it("a fix that removes tests is high risk, with its reason", () => {
    const risk = assessRisk(input({ fix: true, changedFiles: [removed] }));
    expect(risk.level).toBe("high");
    expect(risk.reasons).toContain("A fix removes or skips tests (tests/a.test.ts), so a failure may be hidden rather than fixed.");
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("a fix that skips a test is high risk", () => {
    expect(assessRisk(input({ fix: true, changedFiles: [skipped] })).level).toBe("high");
  });

  it("a fix that changes what CI runs from beside the usual files is high risk: composite actions, GitLab includes, test-runner configs, the test command", () => {
    for (const path of [".github/actions/setup/action.yml", ".gitlab/ci/test.yml", "vitest.config.ts", "packages/api/jest.config.js", "pytest.ini", "tests/conftest.py", "playwright.config.ts", "tox.ini", ".mocharc.json", "karma.conf.js"]) {
      const risk = assessRisk(input({ fix: true, changedFiles: [{ repository: "payments", path, added: 1, removed: 1 }] }));
      expect(risk.level, path).toBe("high");
      expect(risk.reasons.some((reason) => reason.startsWith("A fix changes CI configuration")), path).toBe(true);
    }
    const command = assessRisk(input({ fix: true, changedFiles: [{ repository: "payments", path: "package.json", added: 1, removed: 1, testCommandChanged: true }] }));
    expect(command.level).toBe("high");
    expect(command.reasons).toContain("A fix changes the command that runs the tests (package.json), so a check may pass because the tests no longer run.");
    // The same files in an ordinary change are judged as before.
    expect(assessRisk(input({ changedFiles: [{ repository: "payments", path: "vitest.config.ts", added: 1, removed: 1 }] })).level).toBe("high");
    expect(assessRisk(input({ changedFiles: [{ repository: "payments", path: "package.json", added: 1, removed: 1, testCommandChanged: true }] })).level).toBe("medium");
  });

  it("a fix that changes CI configuration is high risk, whichever CI it is", () => {
    for (const path of [".github/workflows/ci.yml", ".circleci/config.yml", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", ".travis.yml", "bitbucket-pipelines.yaml", "ci/.buildkite/pipeline.yml", "appveyor.yml"]) {
      const risk = assessRisk(input({ fix: true, changedFiles: [{ repository: "payments", path, added: 1, removed: 1 }] }));
      expect(risk.level, path).toBe("high");
      expect(risk.reasons.some((reason) => reason.startsWith("A fix changes CI configuration")), path).toBe(true);
    }
    // A rename out of CI configuration is a change to it.
    expect(assessRisk(input({ fix: true, changedFiles: [{ repository: "payments", path: "ci/new.yml", renamedFrom: ".gitlab-ci.yml", added: 1, removed: 1 }] })).level).toBe("high");
  });

  it("an ordinary build that does the same is judged as before (these two reasons are for a fix); only the workflows folder was and stays sensitive", () => {
    // Since 2026-10-27 the risk shown next to Merge names them for an ordinary change too (rovara-code-risk-tiers.test.ts): removed or skipped tests are medium, CI configuration is high.
    expect(assessRisk(input({ changedFiles: [removed] })).level).toBe("medium");
    expect(assessRisk(input({ changedFiles: [skipped] })).level).toBe("medium");
    expect(assessRisk(input({ changedFiles: [{ repository: "payments", path: ".gitlab-ci.yml", added: 1, removed: 1 }] })).level).toBe("high");
    expect(assessRisk(input({ changedFiles: [{ repository: "payments", path: ".github/workflows/ci.yml", added: 1, removed: 1 }] })).level).toBe("high");
  });

  it("a fix that changes ordinary code and adds tests is judged as any change", () => {
    const risk = assessRisk(input({ fix: true, changedFiles: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }, { repository: "payments", path: "tests/retry.test.ts", added: 9, removed: 0 }] }));
    expect(risk.level).toBe("low");
  });

  it("the CI configuration patterns match whole path segments only", () => {
    const matches = (path: string) => CI_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(path.toLowerCase()));
    expect(matches("src/jenkinsfile-notes.md")).toBe(false);
    expect(matches("docs/circleci.md")).toBe(false);
    expect(matches("my.github/workflows/x")).toBe(false);
    expect(matches("services/api/Jenkinsfile")).toBe(true);
  });
});
