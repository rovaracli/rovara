import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type * as TypeScript from "typescript";
import { MONOLITH_CONFIG, affectedPrograms, importsOf, listPrograms, parsePeakBytes, projectDependencies, runPool, type GraphDeps, type Program } from "../../scripts/typecheck-programs.js";

const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;

function memoryDeps(files: Record<string, string>): GraphDeps {
  return { read: (path) => files[path], exists: (path) => path in files };
}

const PROGRAMS: Program[] = [
  { name: "pkg-a", config: "tsconfig.lint/pkg-a.json", files: ["packages/a/src/index.ts"] },
  { name: "pkg-b", config: "tsconfig.lint/pkg-b.json", files: ["packages/b/src/index.ts"] },
  { name: "tests-one", config: "tsconfig.lint/tests-one.json", files: ["tests/contract/one.test.ts"] },
  { name: "tests-two", config: "tsconfig.lint/tests-two.json", files: ["tests/unit/two.test.ts"] },
  { name: "tests-support", config: "tsconfig.lint/tests-support.json", files: ["tests/support/helper.ts"] },
  { name: "infra", config: "tsconfig.lint/infra.json", files: ["infra/lib/app.ts"] },
];

const FILES: Record<string, string> = {
  "packages/a/src/index.ts": 'export const a = 1;\n',
  "packages/a/src/other.ts": 'export const other = 2;\n',
  "packages/a/package.json": "{}",
  "packages/b/src/index.ts": 'import { a } from "@agentx/a";\nexport const b = a;\n',
  "packages/b/package.json": '{ "dependencies": { "@agentx/a": "0.1.0" } }',
  "tests/contract/one.test.ts": 'import { helper } from "../support/helper.js";\nimport { other } from "../../packages/a/src/other.js";\n',
  "tests/unit/two.test.ts": 'import { b } from "@agentx/b";\nconst json = await import("./data.json");\n',
  "tests/unit/data.json": "{}",
  "tests/support/helper.ts": 'export const helper = 1;\n',
  "infra/lib/app.ts": 'import { a } from "@agentx/a";\n',
  "infra/tsconfig.json": '{ "references": [{ "path": "../packages/a" }] }',
};

describe("which programs a change affects", () => {
  const deps = memoryDeps(FILES);
  const affected = (...changed: string[]): string[] => [...affectedPrograms(PROGRAMS, changed, deps).names].sort();

  it("resolves .js imports to the .ts file, and the project of a file in a package or infra", () => {
    expect(importsOf("tests/contract/one.test.ts", deps).sort()).toEqual(["packages/a/src/other.ts", "project:packages/a", "tests/support/helper.ts"]);
  });

  it("sees @agentx imports and dynamic imports", () => {
    expect(importsOf("tests/unit/two.test.ts", deps).sort()).toEqual(["project:packages/b", "tests/unit/data.json"]);
  });

  it("reads a project's dependencies from its package.json and tsconfig references", () => {
    expect(projectDependencies("project:packages/b", deps)).toEqual(["project:packages/a"]);
    expect(projectDependencies("project:infra", deps)).toEqual(["project:packages/a"]);
  });

  it("selects only the program that owns a changed test that nothing else imports", () => {
    expect(affected("tests/unit/two.test.ts")).toEqual(["tests-two"]);
  });

  it("selects the programs that import a changed helper, and the helper's own program", () => {
    expect(affected("tests/support/helper.ts")).toEqual(["tests-one", "tests-support"]);
  });

  it("selects every program that builds on a changed package, through other packages too", () => {
    expect(affected("packages/a/src/other.ts")).toEqual(["infra", "pkg-a", "pkg-b", "tests-one", "tests-two"]);
    expect(affected("packages/b/src/index.ts")).toEqual(["pkg-b", "tests-two"]);
  });

  it("selects the program that reads a changed data file", () => {
    expect(affected("tests/unit/data.json")).toEqual(["tests-two"]);
  });

  it("selects every program when a compiler option, a dependency or the check itself changes", () => {
    for (const file of ["tsconfig.base.json", "tsconfig.lint/base.json", "package-lock.json", "packages/a/package.json", "scripts/typecheck-baseline.ts", ".node-version"]) {
      expect(affected(file), file).toHaveLength(PROGRAMS.length);
    }
  });

  it("selects nothing for a file no program reads", () => {
    expect(affected("README.md", "docs/plan.md")).toEqual([]);
  });
});

describe("the programs", () => {
  const listed = listPrograms();
  const monolith = ts.getParsedCommandLineOfConfigFile(MONOLITH_CONFIG, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;

  it("are all listed", () => {
    expect(listed.ok).toBe(true);
  });

  it("own, between them, exactly the files tsconfig.lint.json owns, each in one program", () => {
    if (!listed.ok) throw new Error(listed.reason);
    const owner = new Map<string, string>();
    for (const program of listed.programs) {
      for (const file of program.files) {
        expect(owner.get(file), `${file} is in both ${owner.get(file)} and ${program.name}`).toBeUndefined();
        owner.set(file, program.name);
      }
    }
    const old = monolith.fileNames.map((file) => file.replace(`${process.cwd()}/`, "")).sort();
    expect([...owner.keys()].sort()).toEqual(old);
  });

  it("use the same compiler options as tsconfig.lint.json, except declaration output, which only a program with project references turns off", () => {
    if (!listed.ok) throw new Error(listed.reason);
    const OUTPUT_AND_LOCATION = ["configFilePath", "rootDir", "declaration", "declarationMap"];
    const strip = (options: TypeScript.CompilerOptions): Record<string, unknown> =>
      Object.fromEntries(Object.entries(options).filter(([key]) => !OUTPUT_AND_LOCATION.includes(key)));
    for (const program of listed.programs) {
      const parsed = ts.getParsedCommandLineOfConfigFile(program.config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
      expect(strip(parsed.options), program.name).toEqual(strip(monolith.options));
      expect(parsed.options.strict, program.name).toBe(true);
      expect(parsed.options.rootDir, program.name).toBe(process.cwd());
      if (parsed.options.declaration !== true) {
        expect(parsed.options.declaration ?? false, program.name).toBe(false);
        expect(parsed.projectReferences?.length ?? 0, `${program.name} turns declaration output off, which is only safe when it reads referenced projects' declarations`).toBeGreaterThan(0);
      }
    }
  });
});

describe("helpers", () => {
  it("reads peak memory from a macOS or Linux /usr/bin/time report", () => {
    expect(parsePeakBytes("        1.2 real\n   2299478016  maximum resident set size\n")).toBe(2299478016);
    expect(parsePeakBytes("\tMaximum resident set size (kbytes): 2048\n")).toBe(2048 * 1024);
    expect(parsePeakBytes("nothing")).toBeUndefined();
  });

  it("runs at most `limit` tasks at once and returns the results in input order", async () => {
    let running = 0;
    let most = 0;
    const results = await runPool([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });
});
