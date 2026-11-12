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

function run(options: { meta?: Record<string, unknown> | string; log?: string; digestFile?: string; args?: string[]; env?: Record<string, string>; repo?: string; privateSha?: string; sha?: string }) {
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
  const result = spawnSync("/bin/bash", [SCRIPT, ...(options.args ?? ["123456", options.sha ?? SHA, directory, ...(options.repo === undefined ? [] : [options.repo, ...(options.privateSha === undefined ? [] : [options.privateSha])])])], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", GH: gh, ...(options.env ?? {}) } });
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
  it("takes the public CI-only copy rovaracli/rovara-local-aws: the run's branch must be exactly snapshot/<first 12 hex of the private sha>, at the public snapshot sha, and the gh calls go to that repository", () => {
    const PUBLIC = "rovaracli/rovara-local-aws";
    const PRIVATE_SHA = "f6958f742027698476026714795eabda8c14bb1f";
    const SNAPSHOT_SHA = "3f2b3c06ba7fe536143ecb9be5f1239bb012008c";
    const meta = { ...META, headBranch: "snapshot/f6958f742027", headSha: SNAPSHOT_SHA };
    const base = { repo: PUBLIC, privateSha: PRIVATE_SHA, sha: SNAPSHOT_SHA };
    const ok = run({ meta, ...base });
    expect(ok.status, ok.err).toBe(0);
    expect(ok.out).toContain(PUBLIC);
    expect(ok.calls).toContain(`run view 123456 -R ${PUBLIC} --json headBranch,headSha,workflowName,conclusion`);
    expect(ok.calls).toContain(`run view 123456 -R ${PUBLIC} --log`);
    expect(ok.calls).not.toContain("PrepLabsAI");
    // `main` is no longer accepted there, nor any other branch: not the private fork's, not another snapshot, not a prefix or a longer name
    for (const branch of ["main", "rovara/main", "rovara/front", "snapshot/f6958f74202", "snapshot/f6958f7420270", "snapshot/000000000000", "snapshot/F6958F742027", "snapshot/f6958f742027/x", "snapshot", "feature/x", "f6958f742027"]) {
      expect(run({ meta: { ...meta, headBranch: branch }, ...base }).status, branch).toBe(1);
    }
    // the sha is still the pin, and the workflow and conclusion are still checked
    expect(run({ meta: { ...meta, headSha: "c".repeat(40) }, ...base }).status).toBe(1);
    expect(run({ meta: { ...meta, headSha: PRIVATE_SHA }, ...base }).status).toBe(1);
    expect(run({ meta: { ...meta, workflowName: "arm-probe" }, ...base }).status).toBe(1);
    expect(run({ meta: { ...meta, conclusion: "failure" }, ...base }).status).toBe(1);
    // another private sha moves the one allowed branch with it
    const other = "0123456789abcdef0123456789abcdef01234567";
    expect(run({ meta: { ...meta, headBranch: "snapshot/0123456789ab" }, ...base, privateSha: other }).status).toBe(0);
    expect(run({ meta, ...base, privateSha: other }).status).toBe(1);
  });
  it("needs the private sha for the public repository, a full lowercase 40-character one, and takes none for the private fork; all refused before gh is asked", () => {
    const PUBLIC = "rovaracli/rovara-local-aws";
    const meta = { ...META, headBranch: "snapshot/f6958f742027" };
    for (const privateSha of [undefined, "f6958f742027", "F6958F742027698476026714795EABDA8C14BB1F", `${"f6958f742027698476026714795eabda8c14bb1f"}0`, "g".repeat(40)]) {
      const result = run({ meta, repo: PUBLIC, ...(privateSha === undefined ? {} : { privateSha }) });
      expect(result.status, String(privateSha)).toBe(1);
      expect(result.err, String(privateSha)).toContain("REFUSED");
      expect(result.calls, String(privateSha)).toBe("");
    }
    const withPrivate = run({ meta: { ...META, headBranch: "main" }, repo: "PrepLabsAI/rovara-local-aws", privateSha: "f6958f742027698476026714795eabda8c14bb1f" });
    expect(withPrivate.status).toBe(1);
    expect(withPrivate.calls).toBe("");
  });
  it("keeps the private fork as the default and its two branches; rovara/front there is no longer accepted (its Actions cannot run), and no variable adds a branch or a repository", () => {
    expect(run({ meta: { ...META, headBranch: "rovara/front" } }).status).toBe(1);
    expect(run({ meta: { ...META, headBranch: "rovara/main" } }).status).toBe(0);
    expect(run({ meta: META }).calls).toContain("-R PrepLabsAI/rovara-local-aws");
    expect(run({ meta: { ...META, headBranch: "rovara/other" }, env: { LOCAL_AWS_RUN_BRANCH: "rovara/other" } }).status).toBe(1);
    expect(run({ meta: META, env: { LOCAL_AWS_REPO: "rovaracli/rovara-local-aws" } }).calls).toContain("-R PrepLabsAI/rovara-local-aws");
  });
  it("refuses any other repository, before gh is asked: another owner, another name, a look-alike, a path", () => {
    for (const repo of ["rovaracli/rovara", "PrepLabsAI/Rovara-cloud", "rovaracli/rovara-local-aws2", "evil/rovara-local-aws", "rovaracli/rovara-local-aws/x", "ROVARACLI/rovara-local-aws", "rovaracli/rovara-local-aws "]) {
      const result = run({ meta: META, repo });
      expect(result.status, repo).toBe(1);
      expect(result.err, repo).toContain("REFUSED");
      expect(result.calls, repo).toBe("");
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
