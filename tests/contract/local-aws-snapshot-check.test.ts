// scripts/verify-local-aws-snapshot.sh: the controller's check, before the public CI-only build of the engine image, that the public snapshot (rovaracli/rovara-local-aws, `main`, one no-history commit) is exactly the private commit of
// rovara/front minus src/ and .superpowers/. Driven here with real throwaway git repositories; every way it can be wrong must refuse.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/verify-local-aws-snapshot.sh", import.meta.url).pathname;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const GIT_ENV = { PATH: process.env["PATH"] ?? "", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
type Files = Record<string, string | { text: string; exec: true }>;
function commit(files: Files, history = 0): { directory: string; sha: string } {
  const directory = mkdtempSync(join(tmpdir(), "la-snap-"));
  roots.push(directory);
  git(directory, "init", "-q");
  const write = (name: string, value: string | { text: string; exec: true }) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : value.text);
    if (typeof value !== "string") chmodSync(path, 0o755);
  };
  for (let index = 0; index < history; index += 1) { write("old.txt", `old ${String(index)}`); git(directory, "add", "-A"); git(directory, "commit", "-q", "-m", `old ${String(index)}`); }
  git(directory, "rm", "-q", "-f", "--ignore-unmatch", "old.txt");
  for (const [name, value] of Object.entries(files)) write(name, value);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "--allow-empty", "-m", "snapshot");
  return { directory, sha: git(directory, "rev-parse", "HEAD") };
}
const KEPT: Files = { "README.md": "readme", "front/main.go": "package main", "image/Containerfile.engine": "FROM scratch", "scripts/build.sh": { text: "#!/bin/sh\n", exec: true }, "licenses/Apache-2.0.txt": "licence" };
const REMOVED: Files = { "src/main/java/A.java": "class A {}", ".superpowers/sdd/x.md": "notes", "src/b.txt": "b" };

function check(privateRepo: { directory: string; sha: string }, publicRepo: { directory: string; sha: string }, overrides: { args?: string[] } = {}) {
  const result = spawnSync("/bin/bash", [SCRIPT, ...(overrides.args ?? [privateRepo.directory, privateRepo.sha, publicRepo.directory, publicRepo.sha])], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir() } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("verify-local-aws-snapshot.sh", () => {
  const privateRepo = commit({ ...KEPT, ...REMOVED }, 2);
  it("passes when the public snapshot is the private commit minus src/ and .superpowers/ (history and the removed folders do not matter), and prints both shas for the provenance", () => {
    const publicRepo = commit(KEPT);
    const result = check(privateRepo, publicRepo);
    expect(result.status, result.err).toBe(0);
    expect(result.out).toContain(`privateSourceSha=${privateRepo.sha}`);
    expect(result.out).toContain(`publicSnapshotSha=${publicRepo.sha}`);
    expect(result.out).toContain("5 files");
    expect(privateRepo.sha).not.toBe(publicRepo.sha);
  });
  it("refuses a snapshot with a changed file, a missing file, an extra file, a changed mode, or a removed folder put back", () => {
    const cases: Array<[string, Files]> = [
      ["changed content", { ...KEPT, "front/main.go": "package other" }],
      ["missing file", Object.fromEntries(Object.entries(KEPT).filter(([name]) => name !== "README.md"))],
      ["extra file", { ...KEPT, "extra.txt": "x" }],
      ["changed mode", { ...KEPT, "scripts/build.sh": "#!/bin/sh\n" }],
      ["src/ put back", { ...KEPT, "src/b.txt": "b" }],
      [".superpowers/ put back", { ...KEPT, ".superpowers/sdd/x.md": "notes" }],
    ];
    for (const [label, files] of cases) {
      const result = check(privateRepo, commit(files));
      expect(result.status, label).toBe(1);
      expect(result.err, label).toContain("REFUSED");
      expect(result.err, label).toContain("not the private commit minus src/ and .superpowers/");
    }
  });
  it("refuses a public commit that has a parent (it must be a no-history snapshot)", () => {
    const publicRepo = commit(KEPT, 1);
    const result = check(privateRepo, publicRepo);
    expect(result.status).toBe(1);
    expect(result.err).toContain("has a parent");
  });
  it("only removes src/ and .superpowers/ at the top: a nested src folder or a look-alike name is kept and must be in the snapshot", () => {
    const nested: Files = { ...KEPT, "front/src/a.go": "a", "srcfile.txt": "s", ".superpowers-notes": "n" };
    const priv = commit({ ...nested, ...REMOVED });
    expect(check(priv, commit(nested)).status).toBe(0);
    const result = check(priv, commit(KEPT));
    expect(result.status).toBe(1);
  });
  it("refuses bad arguments: a short sha, a sha that is not in that checkout (swapped checkouts), a missing folder", () => {
    const publicRepo = commit(KEPT);
    for (const args of [[], [privateRepo.directory, "abc", publicRepo.directory, publicRepo.sha], [privateRepo.directory, privateRepo.sha, publicRepo.directory, "abc"], [publicRepo.directory, privateRepo.sha, privateRepo.directory, publicRepo.sha], [privateRepo.directory, privateRepo.sha, "/nonexistent-folder", publicRepo.sha]]) {
      const result = check(privateRepo, publicRepo, { args });
      expect(result.status, JSON.stringify(args)).toBe(1);
      expect(result.err).toContain("REFUSED");
    }
  });
});
