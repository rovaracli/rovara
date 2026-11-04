// Slice 2 supply chain: scripts/verify-local-aws-run.sh checks, by script and not by eye, that the downloaded `image-result` belongs to a successful `image` workflow run on main or rovara/main at the expected sha, and that the
// run's own log names the digest in index.digest. Driven here with a fake `gh`; every way it can be wrong must refuse.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/verify-local-aws-run.sh", import.meta.url).pathname;
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const META = { headBranch: "main", headSha: SHA, workflowName: "image", conclusion: "success" };

function run(options: { meta?: Record<string, unknown> | string; log?: string; digestFile?: string; args?: string[] }) {
  const directory = mkdtempSync(join(tmpdir(), "la-run-"));
  const meta = options.meta ?? META;
  const log = options.log ?? `build\nindex digest: ${DIGEST}\ndone\n`;
  writeFileSync(join(directory, "meta.json"), meta === "garbage" ? "not json" : JSON.stringify(meta));
  writeFileSync(join(directory, "run.log"), log === "fail" ? "" : log);
  writeFileSync(join(directory, "index.digest"), options.digestFile ?? `${DIGEST}\n`);
  const gh = join(directory, "gh");
  writeFileSync(gh, [
    "#!/bin/bash",
    `echo "$*" >> "${directory}/gh.log"`,
    'case "$*" in',
    ...(meta === "fail" ? ['  *"--json"*) exit 1 ;;'] : []),
    `  *"--json"*) cat "${directory}/meta.json" ;;`,
    ...(log === "fail" ? ['  *"--log"*) exit 1 ;;'] : []),
    `  *"--log"*) cat "${directory}/run.log" ;;`,
    "  *) exit 9 ;;",
    "esac",
  ].join("\n"));
  chmodSync(gh, 0o755);
  const result = spawnSync("/bin/bash", [SCRIPT, ...(options.args ?? ["123456", SHA, directory])], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", GH: gh } });
  const calls = (() => { try { return readFileSync(join(directory, "gh.log"), "utf8"); } catch { return ""; } })();
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

describe("verify-local-aws-run.sh", () => {
  it("passes for a successful `image` run on main or rovara/main at the expected sha whose log names the digest in index.digest, and reads the private fork only", () => {
    for (const branch of ["main", "rovara/main"]) {
      const result = run({ meta: { ...META, headBranch: branch } });
      expect(result.status, result.err).toBe(0);
      expect(result.out).toContain(DIGEST);
    }
    const result = run({});
    expect(result.calls).toContain("run view 123456 -R PrepLabsAI/rovara-local-aws --json headBranch,headSha,workflowName,conclusion");
    expect(result.calls).toContain("run view 123456 -R PrepLabsAI/rovara-local-aws --log");
  });
  it("refuses another branch, another sha, another workflow, a run that did not succeed, and a missing field", () => {
    for (const change of [{ headBranch: "rovara/image-6" }, { headBranch: "feature/x" }, { headSha: "c".repeat(40) }, { workflowName: "arm-probe" }, { conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: null }, { conclusion: "" }]) {
      const result = run({ meta: { ...META, ...change } });
      expect(result.status, JSON.stringify(change)).toBe(1);
      expect(result.err).toContain("REFUSED");
    }
    for (const key of Object.keys(META)) {
      const partial = { ...META } as Record<string, unknown>;
      delete partial[key];
      expect(run({ meta: partial }).status, key).toBe(1);
    }
  });
  it("refuses a failing gh, an answer that is not JSON, and a log that cannot be read", () => {
    expect(run({ meta: "fail" }).status).toBe(1);
    expect(run({ meta: "garbage" }).status).toBe(1);
    expect(run({ log: "fail" }).status).toBe(1);
  });
  it("refuses a digest file that is not one digest, a log without that digest, an empty log, and a log that names a second digest", () => {
    expect(run({ digestFile: "sha256:abc\n" }).status).toBe(1);
    expect(run({ digestFile: "\n" }).status).toBe(1);
    expect(run({ digestFile: `sha256:${"d".repeat(64)}\n` }).status).toBe(1);
    expect(run({ log: "nothing here\n" }).status).toBe(1);
    expect(run({ log: `index digest: ${DIGEST}\nindex digest: sha256:${"e".repeat(64)}\n` }).status).toBe(1);
    // the digest only in some other sentence is not the line
    expect(run({ log: `the index was ${DIGEST}\n` }).status).toBe(1);
  });
  it("refuses bad arguments", () => {
    for (const args of [[], ["abc", SHA, "/tmp"], ["1", "short", "/tmp"], ["1", SHA, "/nonexistent-folder"]]) expect(run({ args }).status, JSON.stringify(args)).toBe(1);
  });
});
