// On Linux `stat -f` prints file-system information and exits 0, so a BSD-first `stat -f ... || stat -c ...` inside $(...) hands the caller that text instead of an owner or a mode. The acceptance
// scripts ask GNU `stat -c` first (it fails on macOS, which then falls through to `stat -f`), as tests/unit/staging-su1-report.test.ts does.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPTS = [
  "scripts/acceptance/p0-native-journey.sh",
  "scripts/acceptance/run-p0-cli-lanes.sh",
  "scripts/acceptance/run-p0-fix1-terminal-authority.sh",
];

describe("the acceptance scripts read an owner or a mode GNU-first", () => {
  for (const script of SCRIPTS) {
    it(`${script} puts stat -c before stat -f on every line that uses both, and still parses`, () => {
      const lines = readFileSync(script, "utf8").split("\n").filter((line) => /\bstat -[fc]\b/.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, line).toMatch(/stat -c .*\|\| *stat -f /);
        expect(line.indexOf("stat -c")).toBeLessThan(line.indexOf("stat -f"));
      }
      expect(spawnSync("bash", ["-n", script], { encoding: "utf8" }).status).toBe(0);
    });
  }
});
