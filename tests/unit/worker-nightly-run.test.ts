// NH-1: the nightly run on the worker. The Prove sequence over the approved environment, one rerun of failures, the coverage map, and ONE tally for the counts and the step words.
import { describe, expect, it } from "vitest";
import { CoverageMapSchema, isSafeTestId, testIdOf, NightlyResultSchema, type NightlyResult, TestEnvironmentBodySchema, type CoverageMapData, type ProjectCommand, type TestEnvironmentBody } from "@agentx/contracts";
import { coverageMapDigest, nightlyHealthOf, splitFailures as brokerSplitFailures } from "../../packages/broker/src/test-env/nightly.js";
import { coverageMapDigestOf, coverageMapFromContexts, runNightly, splitFailures, type NightlyPorts } from "../../packages/worker/src/nightly-run.js";
import { counted, type ParsedTestReport, type ReportedTest } from "../../packages/worker/src/verification/test-report.js";

const HEAD = "a".repeat(40);
const SLOT = "c".repeat(64);
const WIRE = { slotId: SLOT, envRevision: 3, branch: "main", headSha: HEAD };
const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const env = (over: Record<string, unknown> = {}, checks?: unknown[]): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "svc", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: checks ?? [
    { id: "build", label: "Build", command: cmd("make", ["build"]), kind: "build" },
    { id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml", coveragePath: "coverage.xml", selectArgs: ["{tests}"] },
  ] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});

const t = (name: string, status: ReportedTest["status"] = "passed", file = "tests/test_a.py", durationMs?: number): ReportedTest => ({ file, name, status, ...(durationMs === undefined ? {} : { durationMs }) });
const report = (...tests: ReportedTest[]): ParsedTestReport => counted("junit", tests);

interface Script {
  /** The exit code and time-out of a command, by "executable args". */
  exits?: Record<string, { exitCode?: number | null; timedOut?: boolean }>;
  /** The report each command leaves, by "executable args" (undefined: none written). */
  reports?: Record<string, ParsedTestReport | undefined>;
  map?: CoverageMapData | undefined;
}

function fakes(script: Script = {}) {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const ran: string[] = [];
  let mapCalls = 0;
  const ports: NightlyPorts = {
    runCommand: (command) => {
      const key = `${command.executable} ${command.args.join(" ")}`.trim();
      ran.push(key);
      clock.t += 1_000;
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "", ...(script.exits?.[key] ?? {}) });
    },
    startMock: () => Promise.reject(new Error("no service")),
    probePreprod: () => Promise.resolve(true),
    mockUnmatched: () => Promise.resolve([]),
    readReport: (_check, command) => Promise.resolve(script.reports?.[`${command.executable} ${command.args.join(" ")}`.trim()]),
    buildCoverageMap: () => { mapCalls += 1; return Promise.resolve(script.map); },
    now: () => clock.t,
  };
  return { ports, ran, clock, mapCalls: () => mapCalls };
}
const night = (ports: NightlyPorts, environment = env(), over: { signal?: AbortSignal; deadlineMs?: number } = {}) =>
  runNightly({ environment, run: WIRE, ports, signal: over.signal ?? new AbortController().signal, deadlineMs: over.deadlineMs ?? 5_400_000 });
/** What the broker makes of the night: it strips the worker's own words and classifies with its rules (`nightlyHealthOf`). */
const verdict = (result: NightlyResult, noSmokeCheck = true) => { const { ranFrom: _ranFrom, ...stored } = nightlyHealthOf(result, { noSmokeCheck }) ?? {}; return stored; }; // eslint-disable-line @typescript-eslint/no-unused-vars -- ranFrom is not part of the verdict
const MAP: CoverageMapData = { builtAt: "2026-11-05T06:00:00.000Z", files: { "service/src/match.py": ["tests/test_a.py::t1"] } };

describe("a passing night", () => {
  it("runs setup, build and the suite, reports every step, counts the tests and classifies as passed", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("t1", "passed", "tests/test_a.py", 40), t("t2", "passed", "tests/test_a.py", 900), t("t3", "skipped")) }, map: MAP });
    const { result, coverageMap } = await night(f.ports);
    expect(f.ran).toEqual(["pip install -e .", "make build", "pytest -q"]);
    expect(NightlyResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ slotId: SLOT, envRevision: 3, branch: "main", headSha: HEAD, tests: { total: 3, passed: 2, failed: 0, skipped: 1 }, failed: [], flaky: [] });
    expect(result.slowest[0]).toEqual({ id: "tests/test_a.py::t2", durationMs: 900 });
    expect(result.health!.steps).toEqual([
      { step: "pull", status: "passed" }, { step: "update", status: "skipped" }, { step: "setup", status: "passed" }, { step: "build", status: "passed" },
      { step: "smoke", status: "skipped" }, { step: "full_suite", status: "passed" }, { step: "boot", status: "skipped" }, { step: "mocks", status: "skipped" }, { step: "preprod_probe", status: "skipped" },
    ].sort((a, b) => ["pull", "update", "setup", "build", "boot", "mocks", "preprod_probe", "smoke", "full_suite"].indexOf(a.step) - ["pull", "update", "setup", "build", "boot", "mocks", "preprod_probe", "smoke", "full_suite"].indexOf(b.step)));
    expect(verdict(result)).toEqual({ class: "passed" });
    expect(coverageMap).toEqual(MAP);
    expect(result.coverageMapRef).toBe(coverageMapDigestOf(MAP));
  });

  it("the counts of the result and of its health block are the same numbers, so the broker never reads the night as 'steps_disagree'", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("t1", "passed"), t("t2", "failed"), t("t3", "errored"), t("t4", "skipped"), t("t5", "passed")) } });
    const { result } = await night(f.ports);
    const h = result.health!;
    expect(h.tests).toEqual({ total: 5, passed: 2, failures: 1, errors: 1, skipped: 1 });
    expect(result.tests).toEqual({ total: h.tests.total, passed: h.tests.passed, failed: h.tests.failures + h.tests.errors, skipped: h.tests.skipped });
    expect(nightlyHealthOf(result)).toMatchObject({ class: "tests", ranFrom: "fresh" });
    expect(nightlyHealthOf(result)?.cause).toBeUndefined();
  });

  it("a test that appears twice in a report is one test, the worse of the two (the count and the failing list stay equal)", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("dup", "failed"), t("dup", "passed"), t("other", "passed")) } });
    const { result } = await night(f.ports);
    expect(result.tests).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(result.failed).toEqual(["tests/test_a.py::dup"]);
  });
});

describe("the one rerun", () => {
  const first = report(t("a", "failed"), t("b", "failed"), t("c", "passed"));
  it("a test that passes on the rerun is flaky and counts as passed; one that fails again is failing", async () => {
    const f = fakes({ reports: { "pytest -q": first, "pytest -q tests/test_a.py::a tests/test_a.py::b": report(t("a", "failed"), t("b", "passed")) } });
    const { result } = await night(f.ports);
    expect(f.ran.at(-1)).toBe("pytest -q tests/test_a.py::a tests/test_a.py::b");
    expect(result.failed).toEqual(["tests/test_a.py::a"]);
    expect(result.flaky).toEqual(["tests/test_a.py::b"]);
    expect(result.tests).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(result.health!.tests).toMatchObject({ passed: 2, failures: 1, errors: 0 });
    expect(result.flaky.some((id) => result.failed.includes(id))).toBe(false);
  });
  it("a check with no approved {tests} template is not rerun: its failures stand and nothing is flaky", async () => {
    const f = fakes({ reports: { "pytest -q": first } });
    const checks = [{ id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml" }];
    const { result } = await night(f.ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }, checks));
    expect(f.ran.filter((line) => line.startsWith("pytest"))).toEqual(["pytest -q"]);
    expect(result.failed).toHaveLength(2);
    expect(result.flaky).toEqual([]);
  });
  it("a rerun that times out or writes nothing readable excuses nothing", async () => {
    const fixed = report(t("a", "passed"), t("b", "passed"));
    for (const rerun of [{ exits: { "pytest -q tests/test_a.py::a tests/test_a.py::b": { timedOut: true, exitCode: null } }, reports: { "pytest -q": first, "pytest -q tests/test_a.py::a tests/test_a.py::b": fixed } }, { reports: { "pytest -q": first } }]) {
      const f = fakes(rerun);
      const { result } = await night(f.ports);
      expect(result.failed).toEqual(["tests/test_a.py::a", "tests/test_a.py::b"]);
      expect(result.flaky).toEqual([]);
    }
  });
  it("a test the rerun does not report is still failing", async () => {
    const f = fakes({ reports: { "pytest -q": first, "pytest -q tests/test_a.py::a tests/test_a.py::b": report(t("a", "passed")) } });
    const { result } = await night(f.ports);
    expect(result.failed).toEqual(["tests/test_a.py::b"]);
    expect(result.flaky).toEqual(["tests/test_a.py::a"]);
  });
  it("matches the broker's own split of failures", () => {
    expect(splitFailures(["a", "b", "c"], ["b"])).toEqual(brokerSplitFailures(["a", "b", "c"], ["b"]));
    expect(splitFailures(["b", "b", "a"], [])).toEqual(brokerSplitFailures(["b", "b", "a"], []));
  });
});

describe("a night that is not the tests' fault, and one that never finishes", () => {
  it("a failed setup step ends the run: later steps are skipped, no suite runs, no map is built, and the broker reads environment", async () => {
    const f = fakes({ exits: { "pip install -e .": { exitCode: 1 } }, reports: { "pytest -q": report(t("a")) }, map: MAP });
    const { result, coverageMap } = await night(f.ports);
    expect(f.ran).toEqual(["pip install -e ."]);
    expect(f.mapCalls()).toBe(0);
    expect(coverageMap).toBeUndefined();
    expect(result.coverageMapRef).toBeUndefined();
    expect(result.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(result.health!.steps.find((s) => s.step === "setup")?.status).toBe("failed");
    expect(result.health!.steps.find((s) => s.step === "smoke")?.status).toBe("skipped");
    expect(verdict(result)).toEqual({ class: "environment", cause: "setup_failed" });
  });
  it("a report that was approved and not written is an environment fault, not a pass", async () => {
    const f = fakes({ reports: { "pytest -q": undefined } });
    const { result } = await night(f.ports);
    expect(result.health!.checks.find((c) => c.runsTests)).toMatchObject({ started: true, reportApproved: true, reportWritten: false });
    // The broker checks "no tests collected" before "no report written"; either way it is the environment.
    expect(verdict(result).class).toBe("environment");
  });
  it("a check that hit its own time limit is reported as timed out", async () => {
    const f = fakes({ exits: { "pytest -q": { exitCode: null, timedOut: true } } });
    const { result } = await night(f.ports);
    expect(result.health!.checks.find((c) => c.runsTests)?.timedOut).toBe(true);
    expect(verdict(result)).toMatchObject({ class: "environment", cause: "check_timed_out" });
  });
  it("a stop sends nothing: the run rejects and no result exists", async () => {
    const stop = new AbortController();
    const f = fakes({ reports: { "pytest -q": report(t("a")) } });
    const base = f.ports.runCommand;
    f.ports.runCommand = (command, signal) => { if (command.executable === "make") stop.abort(); return base(command, signal); };
    await expect(night(f.ports, env(), { signal: stop.signal })).rejects.toThrow(/stopped/);
  });
  it("the wall clock ends the night with nothing reported", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("a")) } });
    const base = f.ports.runCommand;
    f.ports.runCommand = (command, signal) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); void base(command, signal).then((r) => command.executable === "make" ? undefined : resolve(r)); });
    await expect(night(f.ports, env(), { deadlineMs: 20 })).rejects.toThrow(/ran out of its time/);
  });
});

describe("the coverage map", () => {
  it("is built right after a suite that FAILED too, before a rerun can overwrite the data, and the result names it by its digest", async () => {
    const order: string[] = [];
    // The suite exits non-zero because a test failed, as a real runner does: the Prove step fails and builds no map of its own.
    const f = fakes({ exits: { "pytest -q": { exitCode: 1 } }, reports: { "pytest -q": report(t("a", "failed")), "pytest -q tests/test_a.py::a": report(t("a", "passed")) }, map: MAP });
    const runCommand = f.ports.runCommand;
    f.ports.runCommand = (command, signal) => { order.push(`run:${command.args.join(" ")}`); return runCommand(command, signal); };
    const build = f.ports.buildCoverageMap.bind(f.ports);
    f.ports.buildCoverageMap = (signal) => { order.push("map"); return build(signal); };
    const { result, coverageMap } = await night(f.ports, env({}, [
      { id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml", selectArgs: ["{tests}"] },
    ]));
    expect(order).toEqual(["run:install -e .", "run:-q", "map", "run:-q tests/test_a.py::a"]);
    expect(coverageMap).toEqual(MAP);
    expect(result.coverageMapRef).toBe(coverageMapDigestOf(MAP));
  });
  it("is not asked for by an environment that selects by the full suite", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("a")) }, map: MAP });
    await night(f.ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }));
    expect(f.mapCalls()).toBe(0);
  });
  it("a map that cannot be built is no reference at all, and the night is still reported", async () => {
    const f = fakes({ reports: { "pytest -q": report(t("a")) }, map: undefined });
    const { result } = await night(f.ports);
    expect(result.coverageMapRef).toBeUndefined();
  });
  it("digests it the way the broker does", () => {
    expect(coverageMapDigestOf(MAP)).toBe(coverageMapDigest(MAP));
  });
  it("is read from coverage.py's contexts: the tests of each file, the phase suffix and the empty context dropped, a file with too many tests left out", () => {
    const text = JSON.stringify({ files: {
      "src/match.py": { contexts: { "1": ["", "tests/test_a.py::t1|run"], "2": ["tests/test_a.py::t1|run", "tests/test_b.py::t2|setup"] } },
      "src/huge.py": { contexts: { "1": Array.from({ length: 5_001 }, (_, i) => `tests/test_h.py::t${String(i)}|run`) } },
      "src/none.py": { contexts: { "1": [""] } },
    } });
    const built = coverageMapFromContexts(text, "2026-11-05T06:00:00.000Z", { sourceRoot: "service" });
    expect(built).toEqual({ builtAt: "2026-11-05T06:00:00.000Z", files: { "service/src/match.py": ["tests/test_a.py::t1", "tests/test_b.py::t2"] } });
    expect(CoverageMapSchema.safeParse(built).success).toBe(true);
    expect(coverageMapFromContexts("not json", "2026-11-05T06:00:00.000Z")).toBeUndefined();
    expect(coverageMapFromContexts(JSON.stringify({ files: { "a.py": { contexts: { "1": [""] } } } }), "2026-11-05T06:00:00.000Z")).toBeUndefined();
  });
});

describe("bounds and shapes", () => {
  it("a test check with no approved report is one verdict: a pass counts one, a failure counts one and is listed by the check's id", async () => {
    const checks = [{ id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test" }];
    const passed = await night(fakes().ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }, checks));
    expect(passed.result.tests).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    const failed = await night(fakes({ exits: { "pytest -q": { exitCode: 1 } } }).ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }, checks));
    expect(failed.result.tests).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(failed.result.failed).toEqual(["check:unit"]);
  });
  it("more failing tests than the result lists: the count is the whole count and the list is cut, so the broker excuses none", async () => {
    const many = report(...Array.from({ length: 600 }, (_, i) => t(`t${String(i).padStart(3, "0")}`, "failed")));
    const checks = [{ id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml" }];
    const { result } = await night(fakes({ reports: { "pytest -q": many } }).ports, env({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } }, checks));
    expect(result.tests.failed).toBe(600);
    expect(result.failed).toHaveLength(500);
  });
  it("an id is file::name, never rewritten; one with whitespace is not safe: it is counted, never listed, never rerun and never in the map", async () => {
    expect(testIdOf({ file: "tests/a.py", name: "TestC::t[1-2]" })).toBe("tests/a.py::TestC::t[1-2]");
    expect(testIdOf({ name: "bare" })).toBe("bare");
    expect(isSafeTestId("tests/a.py::t[a b]")).toBe(false);
    expect(isSafeTestId("tests/a.py::t[a-b]")).toBe(true);
    expect(isSafeTestId("-x")).toBe(false);
    expect(isSafeTestId("x".repeat(501))).toBe(false);
    const f = fakes({ reports: { "pytest -q": report(t("t[a b]", "failed", "tests/a.py", 500), t("t2", "failed", "tests/a.py", 100), t("t3", "passed")) } });
    const { result } = await night(f.ports);
    // Counted as failing, not listed (so the broker will excuse nothing), not rerun (only the safe id is on the command line), not among the slowest.
    expect(result.tests).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
    expect(result.failed).toEqual(["tests/a.py::t2"]);
    expect(f.ran.at(-1)).toBe("pytest -q tests/a.py::t2");
    expect(result.slowest.map((entry) => entry.id)).toEqual(["tests/a.py::t2"]);
  });
  it("the smoke step is reported as it was: skipped when the environment has no smoke check, as it ran when it has one; the broker alone decides what a skipped smoke means", async () => {
    const withSmoke = [
      { id: "smoke", label: "Smoke", command: cmd("pytest", ["smoke"]), kind: "smoke" },
      { id: "unit", label: "Unit", command: cmd("pytest", ["-q"]), kind: "test", reportPath: "reports/junit.xml" },
    ];
    const full = { selection: { method: "full", alwaysRun: [], fullSuiteOn: [] } };
    const a = await night(fakes({ reports: { "pytest -q": report(t("a")) }, exits: { "pytest smoke": { exitCode: 1 } } }).ports, env(full, withSmoke));
    expect(a.result.health!.steps.find((s) => s.step === "smoke")?.status).toBe("failed");
    expect(a.result.health!.steps.find((s) => s.step === "full_suite")?.status).toBe("skipped");
    const b = await night(fakes({ exits: { "pip install -e .": { exitCode: 1 } } }).ports);
    expect(b.result.health!.steps.find((s) => s.step === "smoke")?.status).toBe("skipped");
    // No smoke check in the environment: skipped. The broker's approved environment says whether that is fine.
    const c = await night(fakes({ reports: { "pytest -q": report(t("a")) } }).ports);
    expect(c.result.health!.steps.find((s) => s.step === "smoke")?.status).toBe("skipped");
    expect(verdict(c.result, true)).toEqual({ class: "passed" });
    expect(verdict(c.result, false)).toMatchObject({ class: "unclear", cause: "incomplete_run" });
  });
});
