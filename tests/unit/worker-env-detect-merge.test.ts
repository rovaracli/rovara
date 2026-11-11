// Proof and test environment E2: several detectors on one repository give ONE coherent detection (no duplicate commands, every citation kept, one copy of each question, the limits held) and a proposal that is valid.
import { afterEach, describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema } from "@rovara-code/contracts";
import { DETECTORS, boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import type { Detector } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const CONFIG = "package.PartnerService = {\n  interfaces = (1.0);\n};\n";
const PYTEST: Files = { "pytest.ini": "[pytest]\naddopts = -q --junitxml=out/results.xml\n", "tests/test_a.py": "" };
const GRADLE: Files = { "build.gradle": "plugins {\n  id 'java'\n  id 'checkstyle'\n}\n", gradlew: "", "gradle/wrapper/gradle-wrapper.properties": "", "gradle/wrapper/gradle-wrapper.jar": "", "src/test/java/ATest.java": "" };
const NODE: Files = { "package.json": '{\n  "scripts": {\n    "test": "vitest run",\n    "lint": "eslint ."\n  }\n}', "package-lock.json": "{}" };
const BRAZIL_DOC: Files = { "README.md": "## Tests\n```\nbrazil-build release\n```\n" };

const injected: string[] = [];
const inject = (name: string, run: Detector): void => { (DETECTORS as Array<{ name: string; run: Detector }>).push({ name, run }); injected.push(name); };
afterEach(() => { for (const name of injected.splice(0)) { const at = DETECTORS.findIndex((item) => item.name === name); if (at !== -1) (DETECTORS as Array<unknown>).splice(at, 1); } });

describe("several detectors, one detection", () => {
  it("Brazil + Python: pytest and the team's Brazil command, each with its own citation, one question-free proposal", async () => {
    const detection = await detect({ Config: CONFIG, ...PYTEST, ...BRAZIL_DOC });
    expect(detection.checks.map((check) => [check.value.id, check.value.command.executable, check.source])).toEqual([
      ["unit", "pytest", { path: "pytest.ini", line: 1 }], ["brazil-test", "brazil-build", { path: "README.md", line: 3 }],
    ]);
    expect(detection.questions).toEqual([]);
    expect(new Set(detection.notes).size).toBe(detection.notes.length);
  });
  it("Brazil + Java: Gradle's commands and the team's Brazil command together, and the one open question when the docs are silent", async () => {
    const documented = await detect({ Config: CONFIG, ...GRADLE, ...BRAZIL_DOC });
    expect(documented.checks.map((check) => check.value.id)).toEqual(["unit", "checkstyle", "brazil-test"]);
    expect(documented.questions).toEqual([]);
    const silent = await detect({ Config: CONFIG, ...GRADLE });
    expect(silent.checks.map((check) => check.value.id)).toEqual(["unit", "checkstyle"]);
    expect(silent.questions).toHaveLength(1);
  });
  it("Node + Java: both test checks are kept, the second under its detector's name, instead of one silently replacing the other", async () => {
    const detection = await detect({ ...NODE, ...GRADLE });
    expect(detection.checks.map((check) => [check.value.id, check.value.command.executable, check.source])).toEqual([
      ["unit", "npm", { path: "package.json", line: 3 }], ["lint", "npm", { path: "package.json", line: 4 }], ["unit-java", "./gradlew", { path: "build.gradle", line: 1 }], ["checkstyle", "./gradlew", { path: "build.gradle", line: 3 }],
    ]);
    expect(detection.setupCommands.map((item) => item.value.executable)).toEqual(["npm", "./gradlew"]);
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["package-lock.json", "package.json", "build.gradle", "gradlew"]));
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
    expect(draft.environment.repos[0]?.checks.map((check) => check.id)).toEqual(["unit", "lint", "unit-java", "checkstyle"]);
    expect(draft.valueSources).toContainEqual({ field: "repos[0].checks[2]", source: { path: "build.gradle", line: 1 } });
  });
  it("Brazil + Python + Java + Node together: unique check ids, and every command appears once", async () => {
    const detection = await detect({ Config: CONFIG, ...PYTEST, ...GRADLE, ...NODE, ...BRAZIL_DOC });
    const ids = detection.checks.map((check) => check.value.id);
    expect(new Set(ids).size).toBe(ids.length);
    const commands = detection.checks.map((check) => JSON.stringify(check.value.command));
    expect(new Set(commands).size).toBe(commands.length);
    expect(ids).toEqual(expect.arrayContaining(["unit", "unit-node", "unit-java", "brazil-test"]));
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.valueSources.filter((item) => /^repos\[0\]\.checks\[\d+\]$/u.test(item.field))).toHaveLength(detection.checks.length);
  });
  it("keeps the first of two identical commands (and its citation), and one copy of each note and question", async () => {
    inject("twin-a", () => Promise.resolve({
      checks: [{ value: { id: "unit", label: "Tests", kind: "test", command: { cwd: "service", executable: "make", args: ["test"], timeoutSeconds: 600 } }, source: { path: "Makefile", line: 3 } }],
      setupCommands: [{ value: { cwd: "service", executable: "make", args: ["setup"], timeoutSeconds: 600 }, source: { path: "Makefile", line: 1 } }],
      notes: ["same note"], questions: ["same question?"],
    }));
    inject("twin-b", () => Promise.resolve({
      checks: [{ value: { id: "tests", label: "Tests again", kind: "test", command: { cwd: "service", executable: "make", args: ["test"], timeoutSeconds: 600 } }, source: { path: "docs.md", line: 9 } }],
      setupCommands: [{ value: { cwd: "service", executable: "make", args: ["setup"], timeoutSeconds: 600 }, source: { path: "docs.md", line: 8 } }],
      notes: ["same note"], questions: ["same question?"],
    }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks.map((check) => [check.value.id, check.source])).toEqual([["unit", { path: "Makefile", line: 3 }]]);
    expect(detection.setupCommands.map((item) => item.source)).toEqual([{ path: "Makefile", line: 1 }]);
    expect(detection.notes.filter((note) => note === "same note")).toHaveLength(1);
    expect(detection.questions).toEqual(["same question?"]);
  });
  it("holds the limits (32 checks, 20 setup commands, 90 detected full-suite globs) and says so", async () => {
    inject("many", () => Promise.resolve({
      checks: Array.from({ length: 40 }, (_, index) => ({ value: { id: `c${String(index)}`, label: "c", kind: "test" as const, command: { cwd: "service", executable: "make", args: [`t${String(index)}`], timeoutSeconds: 60 } }, source: "detector:many" as const })),
      setupCommands: Array.from({ length: 25 }, (_, index) => ({ value: { cwd: "service", executable: "make", args: [`s${String(index)}`], timeoutSeconds: 60 }, source: "detector:many" as const })),
      fullSuiteOn: Array.from({ length: 120 }, (_, index) => ({ value: `g${String(index)}/**`, source: "detector:many" as const })),
    }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks).toHaveLength(32);
    expect(detection.setupCommands).toHaveLength(20);
    expect(detection.fullSuiteOn).toHaveLength(90);
    expect(detection.notes.join(" ")).toContain("More than 32 checks");
    expect(detection.notes.join(" ")).toContain("More than 20 setup commands");
    expect(detection.notes.join(" ")).toContain("More than 90 full-suite paths");
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.environment.repos[0]?.checks).toHaveLength(32);
    expect(draft.environment.selection.fullSuiteOn).toEqual(expect.arrayContaining([".github/**", ".gitlab-ci.yml", "Makefile"]));
  });
  it("renames a colliding id to something the environment still accepts", async () => {
    inject("a-very-long-detector-name-that-goes-on-and-on", () => Promise.resolve({ checks: [{ value: { id: "x".repeat(60), label: "c", kind: "test", command: { cwd: "service", executable: "make", args: ["one"], timeoutSeconds: 60 } }, source: "detector:x" }] }));
    inject("second-long-detector-name-that-goes-on-and-on-too", () => Promise.resolve({ checks: [{ value: { id: "x".repeat(60), label: "c", kind: "test", command: { cwd: "service", executable: "make", args: ["two"], timeoutSeconds: 60 } }, source: "detector:x" }] }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks).toHaveLength(2);
    expect(detection.checks.every((check) => /^[a-z][a-z0-9_-]{0,63}$/u.test(check.value.id))).toBe(true);
    expect(new Set(detection.checks.map((check) => check.value.id)).size).toBe(2);
  });
});
