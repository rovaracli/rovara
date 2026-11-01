import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listPrograms } from "../../scripts/typecheck-programs.js";
import { DEFAULT_HEAP_MB, DIRECTORY_SHARDS, REST, REST_PROJECT, eslintArguments, parseOptions, planShards } from "../../scripts/lint-shards.js";

// C90: `eslint .` over one TypeScript program of the whole repository needed ~14 GB and ran out of memory on the 8 GB CI runner.
// `npm run lint` now lints in shards (scripts/lint-shards.ts). These tests keep the shards covering exactly what `eslint .` covers.
const listed = listPrograms();
if (!listed.ok) throw new Error(listed.reason);
const shards = planShards(listed.programs);

describe("the lint shards", () => {
  it("are one per type-check program, one per web directory, and a last shard for everything else", () => {
    expect(shards.filter((shard) => shard.project?.startsWith("./tsconfig.lint/")).map((shard) => shard.name).sort()).toEqual(listed.programs.map((program) => program.name).sort());
    expect(shards.filter((shard) => shard.project === undefined).map((shard) => shard.name)).toEqual(DIRECTORY_SHARDS.map((shard) => shard.name));
    expect(shards.at(-1)?.name).toBe(REST);
    expect(new Set(shards.map((shard) => shard.name)).size).toBe(shards.length);
  });

  it("give every file of the whole-repository program to exactly one shard, and leave all of them out of the last shard", () => {
    const owner = new Map<string, string>();
    for (const shard of shards.filter((candidate) => candidate.project?.startsWith("./tsconfig.lint/"))) {
      expect(shard.targets.length, shard.name).toBeGreaterThan(0);
      for (const file of shard.targets) {
        expect(owner.get(file), `${file} is in both ${owner.get(file)} and ${shard.name}`).toBeUndefined();
        owner.set(file, shard.name);
      }
    }
    const last = shards.at(-1)!;
    expect(last.targets).toEqual(["."]);
    expect([...(last.exclude ?? [])].filter((entry) => !entry.endsWith("/")).sort()).toEqual([...owner.keys()].sort());
    expect((last.exclude ?? []).filter((entry) => entry.endsWith("/")).sort()).toEqual(DIRECTORY_SHARDS.map((shard) => `${shard.directory}/`).sort());
  });

  it("read type information from configs that exist, and the web directories from the config blocks that use the project service", () => {
    for (const shard of shards) if (shard.project !== undefined) expect(existsSync(shard.project), shard.project).toBe(true);
    const config = readFileSync("eslint.config.js", "utf8");
    for (const { directory } of DIRECTORY_SHARDS) expect(config, directory).toContain(`"${directory}/**/*.{ts,tsx}"`);
    expect(config).toContain('process.env.ROVARA_LINT_PROJECT ?? "./tsconfig.lint.json"');
    expect(config).toContain("process.env.ROVARA_LINT_EXCLUDE_FILE");
  });

  it("give the files outside every program a small program of their own, with the compiler options of tsconfig.lint.json", () => {
    expect(shards.at(-1)?.project).toBe(REST_PROJECT);
    const rest = JSON.parse(readFileSync("tsconfig.lint-rest.json", "utf8")) as { extends: string; include: string[]; compilerOptions?: unknown };
    expect(rest.extends).toBe("./tsconfig.lint.json");
    expect(rest.compilerOptions).toBeUndefined();
    expect(rest.include).toEqual(["vitest.config.ts", "vitest.native-p0.config.ts", "vitest.lessons-dynamo.config.ts"]);
  });

  it("run through npm run lint, in CI, with a heap cap below the 4 GB the runner can spare", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.lint).toBe("node scripts/lint-shards.ts");
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toMatch(/^\s+- run: npm run lint$/m);
    expect(DEFAULT_HEAP_MB).toBeLessThanOrEqual(4096);
    expect(eslintArguments("node_modules/eslint/bin/eslint.js", shards[0]!, DEFAULT_HEAP_MB).slice(0, 2)).toEqual([`--max-old-space-size=${DEFAULT_HEAP_MB}`, "node_modules/eslint/bin/eslint.js"]);
  });

  it("read their options", () => {
    expect(parseOptions([])).toEqual({ list: false, stats: false, heapMb: DEFAULT_HEAP_MB });
    expect(parseOptions(["--stats", "--heap", "2048", "--only", "infra,rest"])).toEqual({ list: false, stats: true, heapMb: 2048, only: new Set(["infra", "rest"]) });
    expect(parseOptions(["--heap", "12"])).toMatch(/--heap needs/);
    expect(parseOptions(["--nope"])).toMatch(/Unknown option/);
  });
});
