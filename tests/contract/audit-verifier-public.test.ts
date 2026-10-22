/**
 * Task 22: the verifier holds nothing private and builds alone.
 *
 * Every forbidden string is assembled at run time from fragments, and every planted fixture lives in a
 * temporary directory made by the test. No file in the repository holds a real account id or private name.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makePki } from "../support/fake-tsa.js";
import { TSA_LABEL, buildAuditFixture } from "../support/audit-bundle-fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = join(repoRoot, "packages/audit-verifier");
const checkScript = join(packageDir, "scripts/check-public.mjs");
const tscBin = join(repoRoot, "node_modules/typescript/bin/tsc");

const scratch: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const run = (cmd: string, args: string[], cwd?: string) =>
  spawnSync(cmd, args, { encoding: "utf8", ...(cwd === undefined ? {} : { cwd }) });
const check = (dir: string) => run(process.execPath, [checkScript, dir]);

// Forbidden words, assembled at run time.
const word = {
  product: ["agent", "x"].join(""),
  crew: ["agent", "x", "crew"].join(""),
  cloud: ["Rovara", "-", "cloud"].join(""),
  org: ["Prep", "Labs"].join(""),
  staging: ["stag", "ing"].join(""),
};
const accountId = (): string => String(100_000_000_000 + (randomBytes(5).readUIntBE(0, 5) % 900_000_000_000));
const orgId = (): string => "org_" + randomBytes(15).toString("base64url").replace(/[^A-Za-z0-9]/g, "a").slice(0, 20).padEnd(20, "b");

/** Copies the real package, adds one file, and runs the check on the copy. */
function plant(name: string, text: string) {
  const dir = tempDir("audit-plant-");
  cpSync(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(packageDir, "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "extra"), { recursive: true });
  writeFileSync(join(dir, "extra", name), text);
  return check(dir);
}

describe("check-public.mjs on the real package", () => {
  it("passes", () => {
    const result = check(packageDir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("holds itself to the same rules (its own text has none of the forbidden words)", () => {
    const text = readFileSync(checkScript, "utf8").toLowerCase();
    for (const forbidden of [word.product, word.cloud, word.org, word.staging]) expect(text).not.toContain(forbidden.toLowerCase());
  });

  it("exits 2 with a usage line for a missing or unreadable directory", () => {
    expect(run(process.execPath, [checkScript]).status).toBe(2);
    const missing = run(process.execPath, [checkScript, join(tmpdir(), "audit-no-such-dir-" + randomBytes(4).toString("hex"))]);
    expect(missing.status).toBe(2);
  });
});

describe("check-public.mjs on planted fixtures", () => {
  it("fails on the product name and an account id, and names the rules but does not echo the values", () => {
    const id = accountId();
    const result = plant("secret.txt", `deployed by ${word.crew} to account ${id}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("extra/secret.txt:1");
    expect(result.stderr).toContain("private-name");
    expect(result.stderr).toContain("account-id");
    expect(result.stderr).not.toContain(id);
    expect(result.stderr).not.toContain(word.crew);
  });

  const cases: Array<[string, string, string, string]> = [
    ["the cloud repository name", "notes.md", `see ${word.cloud} for details\n`, "private-name"],
    ["the cloud repository path", "notes.md", `git clone ${word.org}AI/${word.cloud}\n`, "private-name"],
    ["the company name in a source file", "x.ts", `// ${word.org}\n`, "private-name"],
    ["a pre-production environment name", "x.ts", `const env = "${word.staging}";\n`, "preprod"],
    ["a cell host", "x.ts", 'fetch("https://c1.eu.rovara.dev/v1");\n', "cell-host"],
    ["an amazonaws host", "x.ts", 'fetch("https://abc123.execute-api.us-east-1.amazonaws.com/");\n', "aws-host"],
    ["a real-looking org id", "x.json", `{"org": "${orgId()}"}\n`, "org-id"],
    ["a bare package import", "x.ts", 'import { thing } from "left-pad";\n', "import"],
    ["a node builtin without the node: prefix", "x.ts", 'import { readFileSync } from "fs";\n', "import"],
    ["a side-effect import", "x.ts", 'import "left-pad";\n', "import"],
    ["a re-export from a package", "x.ts", 'export * from "left-pad";\n', "import"],
    ["a dynamic import", "x.mjs", 'const m = await import("left-pad");\n', "import"],
    ["a require", "x.cjs", 'const m = require("left-pad");\n', "import"],
    ["a multi-line import", "x.ts", 'import {\n  a,\n  b,\n} from "left-pad";\n', "import"],
    ["a relative import that leaves the package", "x.ts", 'import { a } from "../../../outside.js";\n', "import"],
    ["a private key", "k.txt", "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n", "pem"],
    ["a private key with headers and no body shape", "k.txt", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n", "pem"],
  ];
  it.each(cases)("fails on %s", (_name, file, text, rule) => {
    const result = plant(file, text);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rule);
  });

  it("fails on a certificate that is not one of the two pinned roots", () => {
    const pem = makePki("Planted").root.x509.toString();
    const result = plant("other-root.pem", pem);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pem");
  });

  it("allows relative imports inside the package, node: imports, and a documentation link", () => {
    const text = [
      'import { readFileSync } from "node:fs";',
      'import { a } from "./sibling.js";',
      'export { b } from "../src/index.js";',
      "// see https://docs.aws.amazon.com/general/latest/gr/rande.html",
      "// the pattern /-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/ is not a key",
      "",
    ].join("\n");
    const result = plant("ok.ts", text);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("allows the pinned roots again when planted elsewhere in the package", () => {
    const dir = tempDir("audit-pinned-");
    cpSync(join(packageDir, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(packageDir, "src/trust/digicert.pem"), join(dir, "copy.pem"));
    expect(check(dir).status).toBe(0);
  });

  it("allows only the exact proposed repository url and the copyright line", () => {
    const dir = tempDir("audit-meta-");
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { repository?: { url?: string } };
    expect(pkg.repository?.url).toBe(`git+https://github.com/${word.org}AI/rovara-audit-verifier.git`);
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dir, "NOTICE"), `Rovara audit verifier\nCopyright 2026 ${word.org}\n`);
    expect(check(dir).status).toBe(0);
    // A different url, or the company name anywhere else in the same files, fails.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, repository: { url: `git+https://github.com/${word.org}AI/${word.cloud}.git` } }));
    expect(check(dir).status).toBe(1);
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dir, "NOTICE"), `Rovara audit verifier\nbuilt inside ${word.org}\n`);
    expect(check(dir).status).toBe(1);
    // The exemptions are per file: the url in a source file, or the copyright line in a readme, fails.
    writeFileSync(join(dir, "NOTICE"), "Rovara audit verifier\n");
    writeFileSync(join(dir, "x.ts"), `// ${pkg.repository?.url}\n`);
    expect(check(dir).status).toBe(1);
    rmSync(join(dir, "x.ts"));
    writeFileSync(join(dir, "README.md"), `Copyright 2026 ${word.org}\n`);
    expect(check(dir).status).toBe(1);
  });
});

describe("package metadata", () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;

  it("stays private until the owner says go, and lists what it ships", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "NOTICE"]);
    expect(pkg.engines).toEqual({ node: ">=22.19.0 <23" });
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("ships a NOTICE", () => {
    expect(readFileSync(join(packageDir, "NOTICE"), "utf8")).toContain("Copyright 2026");
  });
});

describe("the package alone, outside the monorepo", () => {
  const dir = tempDir("audit-alone-");
  const copy = join(dir, "audit-verifier");
  let built = { status: -1, out: "" };

  it("copies without the monorepo, installs nothing, and builds with tsc", () => {
    cpSync(packageDir, copy, {
      recursive: true,
      filter: (source) => !/(^|\/)(dist|node_modules)(\/|$)|\.tsbuildinfo$/.test(source.slice(packageDir.length)),
    });
    expect(existsSync(join(copy, "dist"))).toBe(false);
    // The copy must not reach the monorepo: its own tsconfig stands alone.
    expect((JSON.parse(readFileSync(join(copy, "tsconfig.json"), "utf8")) as { extends?: string }).extends).toBeUndefined();
    // Only the compiler's type package for Node is linked in, in place of an install.
    mkdirSync(join(copy, "node_modules/@types"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules/@types/node"), join(copy, "node_modules/@types/node"));
    expect(check(copy).status).toBe(0);
    const result = run(process.execPath, [tscBin, "-p", "."], copy);
    built = { status: result.status ?? -1, out: result.stdout + result.stderr };
    expect(built.out).toBe("");
    expect(built.status).toBe(0);
    expect(existsSync(join(copy, "dist/cli.js"))).toBe(true);
    expect(existsSync(join(copy, "dist/index.d.ts"))).toBe(true);
  }, 120_000);

  it("checks clean after the build too", () => {
    expect(check(copy).status).toBe(0);
  });

  it("verifies the Task 3 fixture with its CLI, and fails a tampered copy", () => {
    const fixture = buildAuditFixture();
    const root = join(dir, "root.pem");
    writeFileSync(root, fixture.pki.root.x509.toString());
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(fixture.bundle));
    const cli = join(copy, "dist/cli.js");
    const ok = run(process.execPath, [cli, good, "--trust", `${TSA_LABEL}=${root}`], dir);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("ok   chain:");
    expect(ok.stdout).toContain("Sealed and checked through record 35.");

    const bad = JSON.parse(JSON.stringify(fixture.bundle)) as { records: Array<{ facts: Record<string, unknown> }> };
    bad.records[4]!.facts.role = "owner";
    const tampered = join(dir, "tampered.json");
    writeFileSync(tampered, JSON.stringify(bad));
    const fail = run(process.execPath, [cli, tampered, "--trust", `${TSA_LABEL}=${root}`], dir);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("FAIL chain:");
  });
});
