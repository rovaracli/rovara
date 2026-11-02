// One test id (NH-1 fix 1; contracts `test-id.ts`): puts a parsed report's tests into the form every consumer matches on, `file::name`, where for pytest that is the test's own node id
// (`tests/test_cart_rules.py::TestRules::test_discount_fails[x]`). Pytest's default JUnit XML (xunit2) writes `classname="tests.test_cart_rules.TestRules" name="test_discount_fails[x]"` and NO file, so the file and the classes are
// found by looking at the test files themselves: the longest dotted prefix of the classname that is a `.py` file under the check's directory is the file, and what is left of the classname is the class path. A report that
// names the file (`file=`, pytest's xunit1 family) gives the file directly. An absolute path (vitest and jest write one) is made relative to the check's directory, so the same test has the same id on any worker.
// Nothing is rewritten that is not a path or a class path; an id with whitespace stays what it is and `isSafeTestId` keeps it out of every list that is matched.
import { stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { counted, type ParsedTestReport, type ReportedTest } from "./test-report.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A dotted pytest classname as a file and a class path, given a way to ask whether a `.py` file (relative to the check's directory) exists. The longest file wins; undefined when no prefix is a file. */
export async function pytestFileOf(classname: string, exists: (path: string) => Promise<boolean>): Promise<{ file: string; classes: string[] } | undefined> {
  const parts = classname.split(".");
  if (parts.length === 0 || !parts.every((part) => IDENTIFIER.test(part))) return undefined;
  for (let take = parts.length; take >= 1; take -= 1) {
    const file = `${parts.slice(0, take).join("/")}.py`;
    if (await exists(file)) return { file, classes: parts.slice(take) };
  }
  return undefined;
}

export interface TestIdContext {
  /** The workspace root. */
  root: string;
  /** The check's directory, relative to the root (its `cwd`): test files are looked for here, and absolute paths are made relative to it. */
  cwd: string;
}

/** A path made relative to the check's directory (or the workspace root) when it is absolute and lies under one of them; otherwise as it is, with forward slashes. */
function relativeFile(file: string, context: TestIdContext): string {
  const slashed = file.replaceAll("\\", "/");
  if (!isAbsolute(slashed)) return posix.normalize(slashed);
  const base = resolve(context.root, context.cwd);
  const under = relative(base, slashed);
  if (under !== "" && !under.startsWith("..") && !isAbsolute(under)) return under.split("\\").join("/");
  const fromRoot = relative(resolve(context.root), slashed);
  if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return fromRoot.split("\\").join("/");
  return slashed;
}

/** The report with each test in id form. Counts, statuses and durations are unchanged; a test that cannot be resolved keeps the file and name it had (made relative if it was an absolute path). */
export async function withTestIds(report: ParsedTestReport, context: TestIdContext): Promise<ParsedTestReport> {
  const known = new Map<string, boolean>();
  const exists = async (file: string): Promise<boolean> => {
    const path = join(resolve(context.root, context.cwd), file);
    const cached = known.get(path);
    if (cached !== undefined) return cached;
    const found = await stat(path).then((info) => info.isFile(), () => false);
    known.set(path, found);
    return found;
  };
  const tests: ReportedTest[] = [];
  for (const test of report.tests) {
    const { classname, fileGiven, ...rest } = test;
    if (report.format !== "junit" || classname === undefined) {
      tests.push({ ...rest, ...(rest.file === undefined ? {} : { file: relativeFile(rest.file, context) }) });
      continue;
    }
    let file: string | undefined;
    let classes: string[] = [];
    if (fileGiven === true && test.file !== undefined) {
      // The report names the file; the classes are what the classname has after the file's own dotted form.
      file = relativeFile(test.file, context);
      const dotted = file.replace(/\.py$/u, "").split("/").join(".");
      classes = classname.startsWith(`${dotted}.`) ? classname.slice(dotted.length + 1).split(".") : [];
    } else {
      const found = await pytestFileOf(classname, exists);
      if (found !== undefined) ({ file, classes } = found);
    }
    if (file === undefined) {
      // Not pytest (or not a file this check holds): as it was.
      tests.push({ ...rest, ...(rest.file === undefined ? {} : { file: relativeFile(rest.file, context) }) });
      continue;
    }
    tests.push({ ...rest, file, name: [...classes, test.name].join("::") });
  }
  return counted(report.format, tests);
}
