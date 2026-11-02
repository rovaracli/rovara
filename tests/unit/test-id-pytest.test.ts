// NH-1 fix 1: ONE test id. Real `pytest --junitxml` output (default format, pytest 9) in tests/fixtures/pytest-nightly, read by the worker's own report reader, must give pytest's OWN node ids (the fixture's
// collected.txt is `pytest --collect-only -q`), and the nightly's failing set, the evidence pack's names, the known-failing comparison and the selection must all speak that one id.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, isSafeTestId, testIdOf } from "@agentx/contracts";
import { hasUnconfirmedFailingTest } from "../../packages/broker/src/verification/result.js";
import { nightlyHealthOf } from "../../packages/broker/src/test-env/nightly.js";
import { runNightly, type NightlyPorts } from "../../packages/worker/src/nightly-run.js";
import { selectTests } from "../../packages/worker/src/verification/selection.js";
import { collectEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";
import { runNightlyInvocation } from "../../packages/worker/src/nightly-invocation.js";
import { pytestFileOf, withTestIds } from "../../packages/worker/src/verification/test-ids.js";
import { counted, evidenceTests, parseTestReport } from "../../packages/worker/src/verification/test-report.js";
import { readTestReportAt } from "../../packages/worker/src/verification/test-report-folder.js";

// The workspace is tests/fixtures; the check runs in its pytest-nightly directory, as a project's check runs in a directory of the workspace.
const WORKSPACE = resolve(import.meta.dirname, "../fixtures");
const CWD = "pytest-nightly";
const FIXTURE = resolve(WORKSPACE, CWD);
const cmd = (args: string[]) => ({ cwd: CWD, executable: "pytest", args, timeoutSeconds: 600 });
const env = TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "cart", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd(["-q"]), kind: "test", reportPath: "reports/junit.xml", selectArgs: ["{tests}"] }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const collected = async () => (await readFile(resolve(FIXTURE, "collected.txt"), "utf8")).split("\n").filter((line) => line !== "");
const read = async () => (await withTestIds((await readTestReportAt(WORKSPACE, `${CWD}/reports/junit.xml`)).report!, { root: WORKSPACE, cwd: CWD }));
const FAILING = ["tests/test_cart.py::test_total_fails", "tests/test_cart_rules.py::TestRules::test_discount_fails"];

describe("pytest's own output", () => {
  it("is read into pytest's own node ids: every test of the real report is a node id pytest itself collected, nested classes and parametrized names included", async () => {
    const ids = (await read()).tests.map((test) => testIdOf(test));
    expect([...ids].sort()).toEqual([...(await collected())].sort());
    expect(ids).toContain("tests/test_cart_rules.py::TestOther::TestNested::test_deep");
    expect(ids).toContain("tests/pkg/test_deep.py::test_in_package");
  });

  it("finds the file by the longest dotted prefix that is a file, and gives up on anything that is not a dotted name", async () => {
    const present = new Set(["tests/test_cart_rules.py", "tests/test_cart.py"]);
    const exists = (path: string) => Promise.resolve(present.has(path));
    expect(await pytestFileOf("tests.test_cart_rules.TestOther.TestNested", exists)).toEqual({ file: "tests/test_cart_rules.py", classes: ["TestOther", "TestNested"] });
    expect(await pytestFileOf("tests.test_cart", exists)).toEqual({ file: "tests/test_cart.py", classes: [] });
    expect(await pytestFileOf("tests.missing.TestX", exists)).toBeUndefined();
    expect(await pytestFileOf("../etc/passwd", exists)).toBeUndefined();
    expect(await pytestFileOf("a b.c", exists)).toBeUndefined();
  });

  it("a report that names its file (xunit1) is read the same way", async () => {
    const xunit1 = '<testsuite><testcase classname="tests.test_cart_rules.TestRules" name="test_discount_fails" file="tests/test_cart_rules.py" line="3"><failure/></testcase></testsuite>';
    const parsed = (await withTestIds(parseTestReport(xunit1)!, { root: WORKSPACE, cwd: CWD })).tests[0]!;
    expect(testIdOf(parsed)).toBe("tests/test_cart_rules.py::TestRules::test_discount_fails");
  });

  it("an absolute path in a vitest report is made relative to the check's directory, so a worker's root does not change an id", async () => {
    const json = JSON.stringify({ testResults: [{ name: `${FIXTURE}/src/a.test.ts`, status: "passed", assertionResults: [{ fullName: "adds", status: "passed" }] }] });
    expect(testIdOf((await withTestIds(parseTestReport(json)!, { root: WORKSPACE, cwd: CWD })).tests[0]!)).toBe("src/a.test.ts::adds");
  });

  it("the evidence collector reads the real report from the check's own command and names the tests by pytest's node ids", async () => {
    const command = { executable: "pytest", args: ["-q", "--junitxml=reports/junit.xml"], cwd: CWD, timeoutSeconds: 60 };
    const entry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 100, exitCode: 1 } as never;
    const raw = await collectEvidenceRaw({ rootPath: WORKSPACE, commands: [command], entries: [entry], candidateDigest: "d".repeat(64), repositories: [] });
    const names = raw?.checks[0]?.tests?.names.map((test) => test.name) ?? [];
    expect([...names].sort()).toEqual([...(await collected())].sort());
    expect(names.filter((name) => name.endsWith("test_discount_fails"))).toEqual(["tests/test_cart_rules.py::TestRules::test_discount_fails"]);
  });

  it("the nightly's own report reader (the production port) gives the same ids from the same file", async () => {
    const posted: unknown[] = [];
    const environment = { ...env, selection: { method: "full" as const, alwaysRun: [], fullSuiteOn: [] } };
    await runNightlyInvocation(
      { kind: "task", operationId: "11111111-1111-4111-8111-111111111111", payload: { conversationId: "22222222-2222-4222-8222-222222222222", nightlyRun: { slotId: "c".repeat(64), envRevision: 1, branch: "main", headSha: "a".repeat(40), environment } } } as never,
      {
        rootPath: WORKSPACE, eventSink: async () => undefined, nightlyResult: (message) => { posted.push(message); return Promise.resolve({}); },
        runners: { runProjectCommand: () => Promise.resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }), runAgentCommand: () => Promise.reject(new Error("not used")) },
      },
      { repositories: [{ name: "cart", path: CWD, resolvedCommit: "a".repeat(40) }] } as never,
    );
    expect((posted[0] as { result: { failed: string[] } }).result.failed).toEqual(FAILING);
  });

  it("the nightly, the evidence pack, the already-failing comparison and the selection speak one id", async () => {
    // Only the failing test with a safe id can be listed; the fixture's third failure has a space in its parametrized id.
    const ranCommands: string[] = [];
    const ports: NightlyPorts = {
      runCommand: (command) => { ranCommands.push(`${command.executable} ${command.args.join(" ")}`); return Promise.resolve({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }); },
      startMock: () => Promise.reject(new Error("none")), probePreprod: () => Promise.resolve(true), mockUnmatched: () => Promise.resolve([]),
      readReport: async () => read(), buildCoverageMap: () => Promise.resolve(undefined), now: () => Date.UTC(2026, 10, 5, 6, 0, 0),
    };
    const { result } = await runNightly({ environment: env, run: { slotId: "c".repeat(64), envRevision: 1, branch: "main", headSha: "a".repeat(40) }, ports, signal: new AbortController().signal, deadlineMs: 60_000 });
    expect(result.failed).toEqual(FAILING);
    // 3 failures counted, 2 listed: the one with a space is counted and never listed or rerun.
    expect(result.tests.failed).toBe(3);
    expect(ranCommands.at(-1)).toBe(`pytest -q ${FAILING.join(" ")}`);
    expect(nightlyHealthOf(result)).toMatchObject({ class: "tests" });

    // The evidence pack's names for the same report are the same strings.
    const view = evidenceTests(await read());
    const failingNames = view.names.filter((entry) => entry.status === "failed" || entry.status === "errored").map((entry) => entry.name);
    expect(failingNames.filter(isSafeTestId).sort()).toEqual(FAILING);

    // A check that failed on the original code too, whose only failures are tests the nightly already lists, is NOT a new failure; one the nightly does not list is.
    const withoutUnsafe = counted("junit", (await read()).tests.filter((test) => !testIdOf(test).includes(" ")));
    const check = (names: ReturnType<typeof evidenceTests>) => ({ checkId: "unit", kind: "test", after: "failed", class: "already_failing", tests: names }) as never;
    expect(hasUnconfirmedFailingTest(check(evidenceTests(withoutUnsafe)), result.failed)).toBe(false);
    expect(hasUnconfirmedFailingTest(check(evidenceTests(withoutUnsafe)), [FAILING[0]!])).toBe(true);
    expect(hasUnconfirmedFailingTest(check(evidenceTests(withoutUnsafe)), ["test_total_fails", "TestRules::test_discount_fails"])).toBe(true);
    // The unsafe failure is never confirmed as already failing, whatever the sets hold.
    expect(hasUnconfirmedFailingTest(check(view), [...result.failed, "tests/test_cart.py::test_label_with_space_fails[x"])).toBe(true);

    // The selection always re-runs last night's failures, matched by id against the inventory.
    const inventory = (await collected()).filter(isSafeTestId);
    const picked = selectTests({
      config: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, check: { id: "unit", selectArgs: ["{tests}"] }, changes: [{ path: "src/other.py", status: "modified" }], inventory,
      coverageMap: { builtAt: new Date(Date.UTC(2026, 10, 5, 6, 0, 0)).toISOString(), files: { "src/other.py": ["tests/test_cart.py::test_add"] } }, lastNightlyFailures: result.failed, now: new Date(Date.UTC(2026, 10, 5, 7, 0, 0)),
    });
    expect(picked.mode).toBe("selected");
    if (picked.mode === "selected") expect(picked.tests).toEqual([...FAILING, "tests/test_cart.py::test_add"].sort());
  });
});
