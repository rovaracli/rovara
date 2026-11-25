// The gitleaks gate with the REAL git and gitleaks against a fixture repository: each way a candidate could switch a finding off must fail the gate. Needs gitleaks on PATH (the pinned 8.30.1).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gate } from "../../ops/pipeline/gates/gitleaks.gate.ts";
import type { GateInput } from "../../ops/pipeline/types.ts";

const haveGitleaks = spawnSync("gitleaks", ["version"]).status === 0;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"];
/** A token-shaped value built at run time, so this file holds none. */
const token = (): string => ["ghp", "_", "0123456789abcdefghijABCDEFGHIJ012345"].join("");
const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "gl-bypass-repo-"));
  made.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  execFileSync("git", [...GIT, "-C", repo, "add", "--", ...Object.keys(files)]);
  execFileSync("git", [...GIT, "-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

async function runGate(repo: string): Promise<{ result: string; failures: string[]; logs: string[] }> {
  const work = mkdtempSync(path.join(tmpdir(), "gl-bypass-work-"));
  made.push(work);
  const logs: string[] = [];
  const ports = {
    exec: (cmd: string, args: readonly string[]) => {
      const r = spawnSync(cmd, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return Promise.resolve({ code: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    },
    fs: { exists: (p: string) => existsSync(p), readText: (p: string) => readFileSync(p, "utf8") },
  };
  const out = await gate.run({ dirs: { pipeline: ROOT, cloud: repo, out: work, work }, ports, log: (l: string) => logs.push(l) } as unknown as GateInput);
  return { result: out.result, failures: out.failures ?? [], logs };
}

describe.skipIf(!haveGitleaks)("gitleaks gate against a real repository: no bypass", () => {
  const leak = `export const t = "${token()}";\n`;

  it("a clean tree passes and a leaking one fails (the control)", async () => {
    expect((await runGate(repoWith({ "a.ts": "export const a = 1;\n" }))).result).toBe("pass");
    expect((await runGate(repoWith({ "a.ts": leak }))).result).toBe("fail");
  });

  it("an inline gitleaks:allow comment does not hide the finding", async () => {
    const result = await runGate(repoWith({ "a.ts": `export const t = "${token()}"; // gitleaks:allow\n` }));
    expect(result.result).toBe("fail");
    expect(result.failures.join("\n")).toMatch(/leaks found/);
  });

  it("a tracked .gitleaksignore, at the root or deeper, fails the gate", async () => {
    for (const where of [".gitleaksignore", "deep/dir/.gitleaksignore"]) {
      const result = await runGate(repoWith({ "a.ts": leak, [where]: "a.ts:github-pat:1\n" }));
      expect(result.result, where).toBe("fail");
      expect(result.failures.join("\n"), where).toMatch(/tracks a \.gitleaksignore/);
    }
  });

  it("export-ignore in .gitattributes cannot drop a file from the scan: the gate fails", async () => {
    const result = await runGate(repoWith({ "a.ts": "export const a = 1;\n", "secrets/k.ts": leak, ".gitattributes": "secrets/ export-ignore\n" }));
    expect(result.result).toBe("fail");
    expect(result.failures.join("\n")).toMatch(/missing from the export.*secrets\/k\.ts/);
  });
});
