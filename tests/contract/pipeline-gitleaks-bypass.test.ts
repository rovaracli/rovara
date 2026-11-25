// The gitleaks gate with the REAL git and gitleaks against a fixture repository: each way a candidate could switch a finding off must fail the gate. Needs gitleaks on PATH (the pinned 8.30.1).
// In CI a missing gitleaks FAILS (never a silent skip); on a developer machine the cases are skipped with a loud note (tests/support/gitleaks-required.ts).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WORK_NAMES, gate } from "../../ops/pipeline/gates/gitleaks.gate.ts";
import type { GateInput } from "../../ops/pipeline/types.ts";
import { GITLEAKS_MISSING_IN_CI, gitleaksPlanNow } from "../support/gitleaks-required.ts";

const plan = gitleaksPlanNow();
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

async function runGate(repo: string): Promise<{ result: string; failures: string[]; logs: string[]; work: string }> {
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
  return { result: out.result, failures: out.failures ?? [], logs, work };
}

describe.runIf(plan === "fail")("gitleaks is required in CI", () => {
  it("is on PATH", () => { throw new Error(GITLEAKS_MISSING_IN_CI); });
});

describe.skipIf(plan !== "run")("gitleaks gate against a real repository: no bypass", () => {
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

  it("a value in a file type gitleaks' default config skips (svg, lock files, go.sum, wrapper scripts) is still found, and the finding names the tracked path", async () => {
    const files: Record<string, string> = {
      "assets/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><desc>${token()}</desc></svg>\n`,
      "package-lock.json": `{"packages":{"x":{"resolved":"https://registry.example.test/x.tgz?token=${token()}"}}}\n`,
      "pkg/yarn.lock": `# ${token()}\n`,
      "pnpm-lock.yaml": `registry: ${token()}\n`,
      "go.sum": `${token()}\n`,
      "gradlew": `#!/bin/sh\nTOKEN=${token()}\n`,
    };
    // the premise: gitleaks' own scan of the plain tree skips every one of these (so the second scan is what finds them)
    const skipped = repoWith(files);
    const direct = spawnSync("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--config", path.join(ROOT, ".gitleaks.toml"), skipped], { encoding: "utf8" });
    expect(direct.status, "the default config no longer skips these paths: re-check the gate's second scan").toBe(0);
    for (const [file, text] of Object.entries(files)) {
      const result = await runGate(repoWith({ "a.ts": "export const a = 1;\n", [file]: text }));
      expect(result.result, file).toBe("fail");
      expect(result.failures.join("\n"), file).toMatch(new RegExp(`second scan.*${file.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}:`, "u"));
    }
  });

  it("gitleaks skips a file by its first bytes, whatever its name: a %PDF or zip (PK) prefix does not hide a value, and the finding is at the file's own line", async () => {
    const prefixes: Record<string, string> = { "%PDF-1.4": "x.env", "PK\x03\x04": "src/k.ts" };
    for (const [magic, file] of Object.entries(prefixes)) {
      const content = `${magic}\nTOKEN=${token()}\n`;
      // the premise: plain gitleaks drops the file (skip by content sniff)
      const plain = repoWith({ [file]: content });
      const direct = spawnSync("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--config", path.join(ROOT, ".gitleaks.toml"), plain], { encoding: "utf8" });
      expect(direct.status, `${magic}: gitleaks no longer skips by magic bytes`).toBe(0);
      const result = await runGate(repoWith({ "a.ts": "export const a = 1;\n", [file]: content }));
      expect(result.result, magic).toBe("fail");
      // a PK-prefixed file is also an archive by its content: the gate refuses it as that, before the second scan
      expect(result.failures.join("\n"), magic).toContain(magic.startsWith("PK") ? `archive file(s) by content (${file})` : `${file}:2`);
    }
  });

  it("a tracked archive is refused by its content, whatever its name (zip, gzip, tar), and a text file that merely mentions the magic is not", async () => {
    const zip = Buffer.from("504b0304140000000000", "hex");
    const gzip = Buffer.from("1f8b0800000000000003", "hex");
    const tar = Buffer.concat([Buffer.alloc(257), Buffer.from("ustar\0"), Buffer.alloc(100)]);
    for (const [file, bytes] of [["data.bin", zip], ["notes.txt", gzip], ["src/a.ts", tar], ["report.docx", zip]] as const) {
      const repo = repoWith({ "a.ts": "export const a = 1;\n" });
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), bytes);
      execFileSync("git", [...GIT, "-C", repo, "add", "--", file]);
      execFileSync("git", [...GIT, "-C", repo, "commit", "-q", "-m", "archive"]);
      const result = await runGate(repo);
      expect(result.result, file).toBe("fail");
      expect(result.failures.join("\n"), file).toMatch(new RegExp(`tracks 1 archive file\\(s\\) by content \\(${file.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}\\)`, "u"));
    }
    expect((await runGate(repoWith({ "a.ts": "// PK and ustar and 1f8b are only words here\n", "docs/zip.md": "a zip file\n" }))).result).toBe("pass");
  });

  it("a value in a symlink's target text is found (gitleaks never reads link text), and a link to a harmless target passes", async () => {
    const repo = repoWith({ "a.ts": "export const a = 1;\n" });
    mkdirSync(path.join(repo, "links"), { recursive: true });
    symlinkSync(token(), path.join(repo, "links/odd"));
    execFileSync("git", [...GIT, "-C", repo, "add", "--", "links/odd"]);
    execFileSync("git", [...GIT, "-C", repo, "commit", "-q", "-m", "link"]);
    const result = await runGate(repo);
    expect(result.result).toBe("fail");
    expect(result.failures.join("\n")).toMatch(/second scan.*links\/odd:1/);
    const fine = repoWith({ "a.ts": "export const a = 1;\n" });
    symlinkSync("a.ts", path.join(fine, "alias.ts"));
    execFileSync("git", [...GIT, "-C", fine, "add", "--", "alias.ts"]);
    execFileSync("git", [...GIT, "-C", fine, "commit", "-q", "-m", "link"]);
    expect((await runGate(fine)).result).toBe("pass");
  });

  it("no copy of the candidate tree, map or report is left in the work directory, after a pass, a finding or a refusal", async () => {
    for (const [name, files] of [["pass", { "a.ts": "export const a = 1;\n" }], ["finding", { "a.ts": leak }], ["svg finding", { "a.svg": `<svg>${token()}</svg>\n` }], ["refusal", { "a.ts": leak, ".gitleaksignore": "x\n" }]] as const) {
      const result = await runGate(repoWith(files));
      for (const leftover of WORK_NAMES) expect(existsSync(path.join(result.work, leftover)), `${name}: ${leftover}`).toBe(false);
      expect(readdirSync(result.work), name).toEqual([]);
    }
  });

  it("a clean svg, lock file and root .gitleaks.toml pass, and images and fonts are copied through the second scan without trouble", async () => {
    const result = await runGate(repoWith({
      "a.ts": "export const a = 1;\n", "assets/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h1v1z\"/></svg>\n", "package-lock.json": "{\"lockfileVersion\":3}\n",
      ".gitleaks.toml": readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8"),
    }));
    expect(result.failures).toEqual([]);
    expect(result.result).toBe("pass");
  });

  it("a tracked node_modules/ directory or a nested gitleaks config fails the gate (the default config would skip every file in them)", async () => {
    for (const [file, text] of [["vendor/node_modules/p/index.js", /node_modules\//], ["sub/gitleaks.toml", /gitleaks config other than the root/], ["gitleaks.toml", /gitleaks config other than the root/]] as const) {
      const result = await runGate(repoWith({ "a.ts": "export const a = 1;\n", [file]: `// ${token()}\n` }));
      expect(result.result, file).toBe("fail");
      expect(result.failures.join("\n"), file).toMatch(text);
    }
  });

  it("export-ignore in .gitattributes cannot drop a file from the scan: the gate fails", async () => {
    const result = await runGate(repoWith({ "a.ts": "export const a = 1;\n", "secrets/k.ts": leak, ".gitattributes": "secrets/ export-ignore\n" }));
    expect(result.result).toBe("fail");
    expect(result.failures.join("\n")).toMatch(/missing from the export.*secrets\/k\.ts/);
  });
});
