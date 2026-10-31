// Python detector: pytest (with the report path the config already writes, or the flag to add as a PROPOSAL), ruff, flake8, mypy, bandit, requirements and lockfiles.
import { type Detection, type Detector, type DetectorContext, findLine } from "./types.js";

const TIMEOUT = { test: 1_800, lint: 600, setup: 900 } as const;
const cmd = (cwd: string, executable: string, args: string[], timeoutSeconds: number) => ({ cwd, executable, args, timeoutSeconds });

async function firstExisting(context: DetectorContext, names: readonly string[]): Promise<{ path: string; text: string } | undefined> {
  for (const name of names) {
    if (!context.repo.paths.includes(name)) continue;
    const text = await context.repo.read(name);
    if (text !== undefined) return { path: name, text };
  }
  return undefined;
}

export const detectPython: Detector = async (context) => {
  const { repo, cwd } = context;
  const found: Partial<Detection> = { setupCommands: [], checks: [], fullSuiteOn: [], notes: [], questions: [] };
  const setup = found.setupCommands!;
  const checks = found.checks!;
  const hasPython = repo.paths.some((path) => path.endsWith(".py")) || ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "requirements.txt"].some((name) => repo.paths.includes(name));
  if (!hasPython) return {};

  const pyproject = await firstExisting(context, ["pyproject.toml"]);
  const pytestIni = await firstExisting(context, ["pytest.ini", "tox.ini", "setup.cfg"]);
  const configs = [pyproject, pytestIni].filter((item) => item !== undefined);
  const requirements = await firstExisting(context, ["requirements-dev.txt", "requirements.txt"]);

  if (repo.paths.includes("requirements.txt")) setup.push({ value: cmd(cwd, "pip", ["install", "-r", "requirements.txt"], TIMEOUT.setup), source: { path: "requirements.txt", line: 1 } });
  else if (pyproject !== undefined && /^\[(?:project|tool\.poetry)\]/mu.test(pyproject.text)) setup.push({ value: cmd(cwd, "pip", ["install", "-e", "."], TIMEOUT.setup), source: { path: "pyproject.toml", line: findLine(pyproject.text, /^\[(?:project|tool\.poetry)\]/mu) ?? 1 } });
  if (repo.paths.includes("requirements-dev.txt") && requirements?.path === "requirements-dev.txt") setup.push({ value: cmd(cwd, "pip", ["install", "-r", "requirements-dev.txt"], TIMEOUT.setup), source: { path: "requirements-dev.txt", line: 1 } });

  for (const lock of ["poetry.lock", "Pipfile.lock", "uv.lock", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini"]) if (repo.paths.includes(lock)) found.fullSuiteOn!.push({ value: lock, source: `detector:python` });
  if (repo.paths.some((path) => path === "conftest.py" || path.endsWith("/conftest.py"))) found.fullSuiteOn!.push({ value: "**/conftest.py", source: "detector:python" });

  // pytest
  let pytestAt: { path: string; line: number } | undefined;
  for (const config of configs) {
    const line = findLine(config.text, /^\[(?:tool\.pytest\.ini_options|tool:pytest|pytest)\]/mu);
    if (line !== undefined) { pytestAt = { path: config.path, line }; break; }
  }
  if (pytestAt === undefined && requirements !== undefined) {
    const line = findLine(requirements.text, /^\s*pytest(?:[<>=!~\s[]|$)/mu);
    if (line !== undefined) pytestAt = { path: requirements.path, line };
  }
  if (pytestAt === undefined && repo.paths.some((path) => /(?:^|\/)test_[^/]+\.py$/u.test(path))) pytestAt = undefined;
  const looksTested = pytestAt !== undefined || repo.paths.some((path) => /(?:^|\/)test_[^/]+\.py$/u.test(path));
  if (looksTested) {
    const text = configs.map((config) => config.text).join("\n");
    const junit = /--junit-?xml[= ]([A-Za-z0-9_./-]{1,200})/u.exec(text)?.[1];
    const coverage = /--cov-report[= ]xml:([A-Za-z0-9_./-]{1,200})/u.exec(text)?.[1] ?? (/--cov-report[= ]xml(?![:\w])/u.test(text) ? "coverage.xml" : undefined);
    const reportPath = junit ?? "reports/junit.xml";
    const args = ["-q", ...(junit === undefined ? [`--junitxml=${reportPath}`] : [])];
    checks.push({
      value: { id: "unit", label: "Unit tests (pytest)", kind: "test", command: cmd(cwd, "pytest", args, TIMEOUT.test), reportPath, ...(coverage === undefined ? {} : { coveragePath: coverage }), selectArgs: ["{tests}"] },
      source: pytestAt ?? "detector:python",
    });
    if (junit === undefined) found.notes!.push("pytest does not write a JUnit report yet: the proposed command adds --junitxml so test names and counts can be shown. The maintainer approves the command.");
    if (coverage === undefined) found.notes!.push("No XML coverage report is configured, so changed-line coverage will show as not measured.");
  }

  // linters and type checkers
  const toml = pyproject?.text ?? "";
  const ruff = findLine(toml, /^\[tool\.ruff/mu);
  if (ruff !== undefined || repo.paths.includes("ruff.toml") || repo.paths.includes(".ruff.toml")) checks.push({ value: { id: "lint", label: "Lint (ruff)", kind: "lint", command: cmd(cwd, "ruff", ["check", "."], TIMEOUT.lint) }, source: ruff === undefined ? "detector:python" : { path: "pyproject.toml", line: ruff } });
  else if (repo.paths.includes(".flake8") || /^\[flake8\]/mu.test(pytestIni?.text ?? "")) checks.push({ value: { id: "lint", label: "Lint (flake8)", kind: "lint", command: cmd(cwd, "flake8", [], TIMEOUT.lint) }, source: repo.paths.includes(".flake8") ? { path: ".flake8", line: 1 } : "detector:python" });
  const mypy = findLine(toml, /^\[tool\.mypy\]/mu);
  if (mypy !== undefined || repo.paths.includes("mypy.ini")) checks.push({ value: { id: "typecheck", label: "Type check (mypy)", kind: "typecheck", command: cmd(cwd, "mypy", ["."], TIMEOUT.lint) }, source: mypy === undefined ? { path: "mypy.ini", line: 1 } : { path: "pyproject.toml", line: mypy } });
  const bandit = findLine(toml, /^\[tool\.bandit/mu);
  if (bandit !== undefined || repo.paths.includes(".bandit")) checks.push({ value: { id: "security", label: "Security scan (bandit)", kind: "security", command: cmd(cwd, "bandit", ["-r", ".", "-f", "sarif", "-o", "reports/bandit.sarif"], TIMEOUT.lint), sarifPath: "reports/bandit.sarif" }, source: bandit === undefined ? { path: ".bandit", line: 1 } : { path: "pyproject.toml", line: bandit } });
  return found;
};
