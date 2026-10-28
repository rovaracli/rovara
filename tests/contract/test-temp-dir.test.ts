import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { trackCdkAssemblies, type MkdtempFs } from "../support/cdk-assemblies.js";
import { TEST_TMP_PREFIX } from "../support/test-temp-dir.js";

describe("test temporary directory", () => {
  it("points every test's tmpdir at a per-run directory the run removes at teardown", () => {
    // CDK apps built without an outdir, and every mkdtemp in the suite, land under os.tmpdir(); the
    // global setup redirects it so the whole run's leftovers go when the run ends.
    expect(basename(tmpdir())).toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
    expect(basename(dirname(tmpdir()))).not.toMatch(new RegExp(`^${TEST_TMP_PREFIX}`));
  });

  it("adds no directory level under the run's, so socket paths built in tmpdir() keep their length (macOS allows 104 bytes)", () => {
    // The model-proxy fixture (tests/unit/e2e-model-proxy.test.ts) builds <tmpdir>/rm-XXXXXX/fresh/model/model.sock; on a Mac that was 102 bytes with no extra level and 106 with one.
    const socket = `/var/folders/3r/36_4_btd1gs0mr4vlwgzqj6c0000gn/T/${TEST_TMP_PREFIX}HWD13t/rm-hm1yuy/fresh/model/model.sock`;
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    expect(basename(tmpdir())).toHaveLength(TEST_TMP_PREFIX.length + 6);
  });

  it("removes the cdk.out directories this process made through mkdtempSync, and nothing else", () => {
    const directory = mkdtempSync(join(tmpdir(), "cdk-track-"));
    const fake: MkdtempFs = { mkdtempSync: (prefix: string) => { const path = `${prefix}ABC123`; mkdirSync(path, { recursive: true }); return path; } };
    const original = fake.mkdtempSync;
    try {
      const mine = join(directory, "cdk.out");
      const other = join(directory, "other");
      const foreign = join(directory, "cdk.outForeign");
      mkdirSync(foreign);
      const tracker = trackCdkAssemblies(fake);
      fake.mkdtempSync(mine);
      fake.mkdtempSync(other);
      writeFileSync(join(`${mine}ABC123`, "asset.zip"), "x");
      const removed = tracker.finish();
      expect(removed).toEqual([`${mine}ABC123`]);
      expect(existsSync(`${mine}ABC123`)).toBe(false);
      expect(existsSync(`${other}ABC123`)).toBe(true);
      expect(existsSync(foreign)).toBe(true);
      expect(fake.mkdtempSync).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
