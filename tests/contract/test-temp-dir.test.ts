import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCdkAssemblies } from "../support/cdk-assemblies.js";
import { TEST_TMP_PREFIX } from "../support/test-temp-dir.js";

describe("test temporary directory", () => {
  it("points every test's tmpdir at a directory of its own file, inside a per-run directory the run removes at teardown", () => {
    // CDK apps built without an outdir, and every mkdtemp in the suite, land under os.tmpdir(); the global setup redirects it
    // so the whole run's leftovers go when the run ends, and the setup file (tests/support/test-file-temp-dir.ts) gives each file its own directory in it.
    const run = dirname(tmpdir());
    expect(basename(run)).toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
    expect(basename(dirname(run))).not.toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
  });

  it("removes cdk.out assemblies from a directory and nothing else", () => {
    const directory = mkdtempSync(join(tmpdir(), "cdk-clean-"));
    try {
      for (const name of ["cdk.outAbC123", "cdk.out"]) {
        mkdirSync(join(directory, name, "nested"), { recursive: true });
        writeFileSync(join(directory, name, "nested", "asset.zip"), "x");
      }
      mkdirSync(join(directory, "other"));
      writeFileSync(join(directory, "my-cdk.out"), "keep");
      expect(removeCdkAssemblies(directory).sort()).toEqual(["cdk.out", "cdk.outAbC123"]);
      expect(existsSync(join(directory, "cdk.outAbC123"))).toBe(false);
      expect(existsSync(join(directory, "other"))).toBe(true);
      expect(existsSync(join(directory, "my-cdk.out"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
