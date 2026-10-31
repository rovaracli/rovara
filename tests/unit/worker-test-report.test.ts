// Proof and evidence P2: reading a check's own JUnit or vitest/jest JSON report into totals, names, new tests and skip counts. Fail closed: a file that is not a report, is empty, too big or holds no test is "not measured".
import { describe, expect, it } from "vitest";
import { EvidencePackSchema } from "../../packages/contracts/src/evidence.js";
import { evidenceTests, parseJsonReport, parseJunit, parseTestReport, plainName, skipRise, skippedOutsideChanged, TEST_REPORT_MAX_BYTES, TEST_REPORT_MAX_TESTS } from "../../packages/worker/src/verification/test-report.js";

// A pytest --junitxml file, as pytest 8 writes it.
const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5" time="0.30">
<testcase classname="tests.test_match" name="test_no_region" time="0.012"></testcase>
<testcase classname="tests.test_match" name="test_scores_partner" time="0.020"><failure message="assert 1 == 2">assert 1 == 2</failure></testcase>
<testcase classname="tests.test_rank" name="test_timeout" time="0.100"><error message="collection error">ImportError</error></testcase>
<testcase classname="tests.test_rank" name="test_slow" time="0.001"><skipped type="pytest.skip" message="slow">skip</skipped></testcase>
<testcase classname="tests.test_rank" name="test_top5[a &amp; b]" time="0.002"/>
</testsuite></testsuites>`;
const VITEST = JSON.stringify({ numTotalTests: 99, testResults: [
  { name: "/work/repo/src/match.test.ts", status: "passed", assertionResults: [{ fullName: "match scores a partner", status: "passed", duration: 12.4 }, { fullName: "match skips no region", status: "failed", duration: 3 }, { fullName: "match todo", status: "todo" }] },
  { name: "/work/repo/src/broken.test.ts", status: "failed", message: "Cannot find module", assertionResults: [] },
] });

describe("JUnit", () => {
  const report = parseJunit(PYTEST)!;
  it("counts the test cases it reads, not the header's own numbers", () => {
    expect(report).toMatchObject({ format: "junit", total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
    expect(parseJunit(PYTEST.replace('tests="5"', 'tests="500"').replace('failures="1"', 'failures="0"'))).toMatchObject({ total: 5, failed: 1 });
  });
  it("reads each test's file from the file attribute or the class name, its name unescaped and its time as milliseconds", () => {
    expect(report.tests[0]).toEqual({ file: "tests/test_match", name: "test_no_region", status: "passed", durationMs: 12 });
    expect(report.tests[4]?.name).toBe("test_top5[a & b]");
    expect(parseJunit('<testsuite><testcase classname="a/b.py" file="a/b.py" name="t"/></testsuite>')?.tests[0]?.file).toBe("a/b.py");
  });
  it("calls a case with both a failure and an error errored", () => {
    expect(parseJunit('<testsuite><testcase name="t"><failure/><error/></testcase></testsuite>')?.tests[0]?.status).toBe("errored");
  });
  it("is not fooled by test-case-looking text inside CDATA or comments", () => {
    const text = '<testsuite><testcase name="real"><failure><![CDATA[<testcase name="fake"/></testcase>]]></failure></testcase><!-- <testcase name="hidden"/> --></testsuite>';
    const read = parseJunit(text)!;
    expect(read.total).toBe(1);
    expect(read.tests[0]).toMatchObject({ name: "real", status: "failed" });
  });
  it("reads a bare testsuite and numeric entities", () => {
    expect(parseJunit('<testsuite><testcase name="caf&#233; &#x1F600;"/></testsuite>')?.tests[0]?.name).toBe("café \u{1F600}");
    expect(parseJunit('<testsuite><testcase name="bad &#0; &#xD800;"/></testsuite>')?.tests[0]?.name).toBe("bad");
  });
  it("is not measured when it is not a report, holds no test, or has too many tests", () => {
    expect(parseJunit("<html><body>not junit</body></html>")).toBeUndefined();
    expect(parseJunit('<testsuites><testsuite name="empty" tests="0"></testsuite></testsuites>')).toBeUndefined();
    expect(parseJunit("")).toBeUndefined();
    const many = `<testsuite>${'<testcase name="t"/>'.repeat(TEST_REPORT_MAX_TESTS + 1)}</testsuite>`;
    expect(parseJunit(many)).toBeUndefined();
    expect(parseJunit(`<testsuite>${'<testcase name="t"/>'.repeat(TEST_REPORT_MAX_TESTS)}</testsuite>`)?.total).toBe(TEST_REPORT_MAX_TESTS);
  });
});

describe("JUnit written by a command the agent can influence", () => {
  const started = () => performance.now();
  it("refuses an unclosed tag, comment, CDATA section or test case, and reads a `>` inside an attribute", () => {
    expect(parseJunit('<testsuite><testcase name="a"')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a">')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a"/><!-- never closed')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a"/><![CDATA[ never closed')).toBeUndefined();
    expect(parseJunit('<testsuite><testcase name="a > b"/></testsuite>')?.tests[0]?.name).toBe("a > b");
    expect(parseJunit('<testsuite><testcases name="a"/><testcase name="b"/></testsuite>')?.total).toBe(1);
  });
  it("reads a test case with one huge attribute without a quadratic scan: over 16 KiB of attributes is unreadable, under it is read in linear time", () => {
    for (const filler of ["a", "a=", "a =", 'a="', "a='", "= "]) {
      const hostile = `<testsuite><testcase ${filler.repeat(Math.ceil(8_000_000 / filler.length))}/></testsuite>`;
      const t0 = started();
      expect(parseJunit(hostile), filler).toBeUndefined();
      expect(performance.now() - t0, filler).toBeLessThan(2_000);
    }
    const nearCap = `<testsuite><testcase name="ok" ${"a".repeat(16_000)}/></testsuite>`;
    const t1 = started();
    expect(parseJunit(nearCap)?.tests[0]?.name).toBe("ok");
    expect(performance.now() - t1).toBeLessThan(500);
    expect(parseJunit(`<testsuite><testcase name="ok" ${"a".repeat(17_000)}/></testsuite>`)).toBeUndefined();
  });
  it("reads each attribute pair once: the first of a repeated name wins, both quote kinds work, a malformed pair is skipped", () => {
    const read = parseJunit(`<testsuite><testcase junk = name='first' name="second" =x classname="a.b" time=oops/></testsuite>`)!;
    expect(read.tests[0]).toMatchObject({ name: "first", file: "a/b" });
  });
  it("reads a hostile 8 MiB file in one pass: many unclosed test cases, comments or CDATA sections cost no more than a single scan", () => {
    const hostile = [
      `<testsuite>${'<testcase name="a">'.repeat(400_000)}`,
      `<testsuite>${"<!--".repeat(2_000_000)}`,
      `<testsuite>${"<![CDATA[".repeat(900_000)}`,
      `<testsuite>${'<testcase name="a" '.repeat(400_000)}`,
    ];
    for (const text of hostile) {
      const t0 = started();
      expect(parseJunit(text)).toBeUndefined();
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });
});

describe("vitest and jest JSON", () => {
  const report = parseJsonReport(VITEST)!;
  it("counts passed, failed and skipped from the assertion results, ignoring the file's own total", () => {
    expect(report).toMatchObject({ format: "json", total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
  });
  it("counts a suite that failed to run as one errored test named for its file, so a load failure is never zero failures", () => {
    expect(report.tests.at(-1)).toMatchObject({ status: "errored", file: "/work/repo/src/broken.test.ts" });
    expect(report.tests.at(-1)?.name).toBe("/work/repo/src/broken.test.ts");
  });
  it("keeps each test's file and rounds its duration", () => {
    expect(report.tests[0]).toEqual({ file: "/work/repo/src/match.test.ts", name: "match scores a partner", status: "passed", durationMs: 12 });
  });
  it("is not measured for text that is not JSON, has no testResults, or holds no test", () => {
    expect(parseJsonReport("not json")).toBeUndefined();
    expect(parseJsonReport('{"other": []}')).toBeUndefined();
    expect(parseJsonReport('{"testResults": []}')).toBeUndefined();
    expect(parseJsonReport('{"testResults": [null, 3, {"name": "a", "status": "passed", "assertionResults": []}]}')).toBeUndefined();
    expect(parseJsonReport("[]")).toBeUndefined();
  });
});

describe("vitest and jest JSON, fail closed", () => {
  const suite = (over: Record<string, unknown>) => JSON.stringify({ testResults: [{ name: "/w/a.test.ts", status: "passed", ...over }] });
  it("counts an unknown or garbage status as errored, not skipped, and only pending, todo, skipped and disabled as skipped", () => {
    const read = parseJsonReport(suite({ assertionResults: ["pending", "todo", "skipped", "disabled", "quarantined", 7, null, "passed"].map((status, index) => ({ fullName: `t${String(index)}`, status })) }))!;
    expect(read).toMatchObject({ skipped: 4, errored: 3, passed: 1 });
    expect(read.tests.filter((test) => test.status === "errored").map((test) => test.name)).toEqual(["t4", "t5", "t6"]);
  });
  it("keeps a suite's own failure when its tests passed (an afterAll or hook failure), and does not add one when a test failed", () => {
    const hook = parseJsonReport(suite({ status: "failed", assertionResults: [{ fullName: "t", status: "passed" }] }))!;
    expect(hook).toMatchObject({ total: 2, passed: 1, errored: 1 });
    expect(hook.tests.at(-1)).toMatchObject({ status: "errored", file: "/w/a.test.ts" });
    const failing = parseJsonReport(suite({ status: "failed", assertionResults: [{ fullName: "t", status: "failed" }] }))!;
    expect(failing).toMatchObject({ total: 1, failed: 1, errored: 0 });
  });
  it("stops at the test cap even for suite-level errors", () => {
    const suites = Array.from({ length: TEST_REPORT_MAX_TESTS + 1 }, (_, index) => ({ name: `f${String(index)}`, status: "failed", assertionResults: [] }));
    expect(parseJsonReport(JSON.stringify({ testResults: suites }))).toBeUndefined();
    expect(parseJsonReport(JSON.stringify({ testResults: suites.slice(0, TEST_REPORT_MAX_TESTS) }))?.total).toBe(TEST_REPORT_MAX_TESTS);
  });
});

describe("parseTestReport", () => {
  it("picks the format from the text, or the one the check names", () => {
    expect(parseTestReport(PYTEST)?.format).toBe("junit");
    expect(parseTestReport(`  ${VITEST}`)?.format).toBe("json");
    expect(parseTestReport(PYTEST, "json")).toBeUndefined();
    expect(parseTestReport(VITEST, "junit")).toBeUndefined();
  });
  it("reads nothing from an empty text or one over the size cap", () => {
    expect(parseTestReport("")).toBeUndefined();
    expect(parseTestReport(`${PYTEST}${" ".repeat(TEST_REPORT_MAX_BYTES)}`)).toBeUndefined();
  });
});

describe("names", () => {
  it("are one plain line with secrets redacted, cut at 300 characters, and never empty", () => {
    expect(plainName("a\nb‮c\u0000d")).toBe("a b c d");
    expect(plainName("   ")).toBe("test");
    expect(plainName("x".repeat(400))).toHaveLength(300);
    const cut = plainName(`${"x".repeat(299)}\u{1F600}tail`);
    expect(cut).toBe(`${"x".repeat(299)}\u{1F600}`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    const secret = `ghp_${"A1b2".repeat(9)}`;
    expect(plainName(`test with ${secret}`)).not.toContain(secret);
  });
});

describe("evidence tests", () => {
  const changed = ["tests/test_match.py"];
  const report = parseJunit(PYTEST)!;
  const view = evidenceTests(report, { changedTestPaths: changed, proofByTest: new Map([["test_no_region", "proves_change"], ["test_top5[a & b]", "does_not_prove"]]) });
  it("keeps the totals, lists failing and errored tests first, then touched tests, then the rest", () => {
    expect(view).toMatchObject({ total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
    expect(view.names.map((entry) => entry.name)).toEqual(["test_scores_partner", "test_timeout", "test_no_region", "test_slow", "test_top5[a & b]"]);
  });
  it("names the tests the change added or changed (not skipped ones) as new", () => {
    expect(view.newTests).toEqual(["test_no_region", "test_scores_partner"]);
  });
  it("attaches TESTPROOF's verdict to a touched test only", () => {
    expect(view.names.find((entry) => entry.name === "test_no_region")?.proof).toBe("proves_change");
    expect(view.names.find((entry) => entry.name === "test_top5[a & b]")?.proof).toBeUndefined();
  });
  it("caps names at 500 and new tests at 100, with the totals still true", () => {
    const tests = Array.from({ length: 700 }, (_, index) => ({ file: "tests/test_match.py", name: `t${String(index)}`, status: "passed" as const }));
    const big = evidenceTests({ format: "junit", total: 700, passed: 700, failed: 0, skipped: 0, errored: 0, tests }, { changedTestPaths: changed });
    expect(big.names).toHaveLength(500);
    expect(big.newTests).toHaveLength(100);
    expect(big.total).toBe(700);
  });
  it("keeps a failing test in the 500 even when it comes last in the report", () => {
    const tests = [...Array.from({ length: 600 }, (_, index) => ({ name: `t${String(index)}`, status: "passed" as const })), { name: "the-failure", status: "failed" as const }];
    const big = evidenceTests({ format: "junit", total: 601, passed: 600, failed: 1, skipped: 0, errored: 0, tests });
    expect(big.names[0]?.name).toBe("the-failure");
  });
  it("lists a duplicate test name in one file once", () => {
    const tests = [{ file: "a.py", name: "t", status: "passed" as const }, { file: "a.py", name: "t", status: "passed" as const }, { file: "b.py", name: "t", status: "passed" as const }];
    expect(evidenceTests({ format: "junit", total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, tests }).names).toHaveLength(2);
  });
  it("carries the skips among untouched tests before and after, so the broker can judge a rise", () => {
    const withSkips = evidenceTests(report, { changedTestPaths: changed, skippedOutside: { before: 0, after: 1 } });
    expect(withSkips).toMatchObject({ skippedBefore: 0, skippedAfter: 1 });
    expect(view).not.toHaveProperty("skippedBefore");
  });
  it("is accepted by the evidence pack's own schema for a check", () => {
    const pack = {
      schemaVersion: 1, candidateDigest: "a".repeat(64),
      environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
      checks: [{ checkId: "readiness:0", kind: "test", label: "pytest", before: "failed", after: "failed", class: "failing_no_before", durationMs: 5, tests: view }],
      selection: { method: "full", selected: 5, total: 5 }, api: [], browser: [], notTested: [],
    };
    expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
  });
});

describe("a rise in skips", () => {
  const changed = ["tests/test_match.py"];
  const before = parseJunit('<testsuite><testcase classname="tests.test_rank" name="a"/><testcase classname="tests.test_rank" name="b"><skipped/></testcase></testsuite>')!;
  it("counts skips only among tests the change did not touch", () => {
    const after = parseJunit('<testsuite><testcase classname="tests.test_match" name="new"><skipped/></testcase><testcase classname="tests.test_rank" name="a"><skipped/></testcase><testcase classname="tests.test_rank" name="b"><skipped/></testcase></testsuite>')!;
    expect(skippedOutsideChanged(after, changed)).toBe(2);
    expect(skipRise(before, after, changed)).toEqual({ rose: true, before: 1, after: 2 });
  });
  it("does not call a skip in a new test, or a steady count, a rise", () => {
    const onlyNew = parseJunit('<testsuite><testcase classname="tests.test_match" name="new"><skipped/></testcase><testcase classname="tests.test_rank" name="a"/><testcase classname="tests.test_rank" name="b"><skipped/></testcase></testsuite>')!;
    expect(skipRise(before, onlyNew, changed)?.rose).toBe(false);
  });
  it("makes no claim without both reports", () => {
    expect(skipRise(undefined, before, changed)).toBeUndefined();
    expect(skipRise(before, undefined, changed)).toBeUndefined();
  });
});
