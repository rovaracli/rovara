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
    expect(assessRisk(input({ changedFiles: [removed] })).level).toBe("low");
    expect(assessRisk(input({ changedFiles: [skipped] })).level).toBe("low");
    expect(assessRisk(input({ changedFiles: [{ repository: "payments", path: ".gitlab-ci.yml", added: 1, removed: 1 }] })).level).toBe("low");
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
