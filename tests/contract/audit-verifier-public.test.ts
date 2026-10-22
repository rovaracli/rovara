/**
 * Task 22: the verifier holds nothing private and builds, tests and packs alone.
 *
 * Every forbidden string is assembled at run time from fragments, and every planted fixture lives in a
 * temporary directory made by the test. No file in the repository holds a real account id or private name.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

const scratch: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const run = (cmd: string, args: string[], cwd?: string, env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, ...(cwd === undefined ? {} : { cwd }) });
const check = (dir: string, ...args: string[]) => run(process.execPath, [checkScript, dir, ...args]);

// Forbidden words, assembled at run time.
const word = {
  product: ["agent", "x"].join(""),
  crew: ["agent", "x", "crew"].join(""),
  cloud: ["Rovara", "-", "cloud"].join(""),
  org: ["Prep", "Labs"].join(""),
  staging: ["stag", "ing"].join(""),
  createRequire: ["create", "Require"].join(""),
};
const digits = (n: number): string => {
  let out = String(1 + (randomBytes(1).readUInt8(0) % 9));
  while (out.length < n) out += String(randomBytes(1).readUInt8(0) % 10);
  return out;
};
const accountId = (): string => digits(12);
const alnum = (n: number): string => {
  let out = "";
  while (out.length < n) out += randomBytes(n).toString("base64").replace(/[^a-z0-9]/g, "");
  return out.slice(0, n);
};
const orgId = (): string => "org_" + alnum(20);
const fullwidth = (text: string): string => [...text].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
const wrap64 = (b64: string): string => b64.replace(/(.{64})/g, "$1\n").trimEnd();

type Files = Record<string, string | Buffer>;

/** A directory holding a copy of the real sources and package.json, plus the given files. */
function build(files: Files, base = true): string {
  const dir = tempDir("audit-plant-");
  if (base) {
    cpSync(join(packageDir, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(packageDir, "package.json"), join(dir, "package.json"));
  }
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const plant = (files: Files, ...args: string[]) => check(build(files), ...args);
const one = (name: string, text: string) => plant({ [`extra/${name}`]: text });

describe("check-public.mjs on the real package", () => {
  it("passes", () => {
    const result = check(packageDir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("holds itself to the same rules (its own text has none of the forbidden words)", () => {
    const text = readFileSync(checkScript, "utf8").toLowerCase();
    for (const forbidden of [word.product, word.cloud, word.org, word.staging, word.createRequire]) {
      expect(text).not.toContain(forbidden.toLowerCase());
    }
  });

  it("exits 2 with a usage line for a missing or unreadable directory, or an unknown option", () => {
    expect(run(process.execPath, [checkScript]).status).toBe(2);
    expect(check(join(tmpdir(), "audit-no-such-dir-" + randomBytes(4).toString("hex"))).status).toBe(2);
    expect(check(packageDir, "--nope").status).toBe(2);
  });
});

describe("check-public.mjs on planted fixtures", () => {
  it("names the rule and the line, and never echoes the value", () => {
    const id = accountId();
    const result = one("secret.txt.md", `first line is fine\ndeployed by ${word.crew} to account ${id}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("extra/secret.txt.md:2: private-name");
    expect(result.stderr).toContain("extra/secret.txt.md:2: account-id");
    expect(result.stderr).not.toContain(id);
    expect(result.stderr).not.toContain(word.crew);
  });

  const cases: Array<[string, string, string, string]> = [
    // private names, preproduction word
    ["the cloud repository name", "notes.md", `see ${word.cloud} for details\n`, "private-name"],
    ["the cloud repository path", "notes.md", `git clone ${word.org}AI/${word.cloud}\n`, "private-name"],
    ["the company name in a source file", "x.ts", `// ${word.org}\n`, "private-name"],
    ["a pre-production environment name", "x.ts", `const env = "${word.staging}";\n`, "preprod"],
    ["the same in capitals", "x.ts", `const env = "${word.staging.toUpperCase()}";\n`, "preprod"],
    ["the product name in capitals", "x.md", `${word.product.toUpperCase()}\n`, "private-name"],
    ["a hyphenated product name", "x.md", `${word.product.slice(0, 5)}-${word.product.slice(5)}\n`, "private-name"],
    ["a spaced company name", "x.md", `${word.org.slice(0, 4)} ${word.org.slice(4)}\n`, "private-name"],
    ["an underscored cloud name", "x.md", `${word.cloud.replace("-", "_")}\n`, "private-name"],
    ["a fullwidth product name", "x.md", `${fullwidth(word.product)}\n`, "private-name"],
    ["a zero-width character inside a name", "x.md", `${word.product.slice(0, 3)}\u200b${word.product.slice(3)}\n`, "private-name"],
    ["a unicode escape inside a name", "x.ts", `const a = "\\u0061${word.product.slice(1)}";\n`, "private-name"],
    // hosts
    ["a cell host", "x.ts", 'fetch("https://c1.eu.rovara.dev/v1");\n', "cell-host"],
    ["a cell host in capitals", "x.ts", 'fetch("https://C1.ROVARA.DEV/v1");\n', "cell-host"],
    ["a templated cell host", "x.ts", "fetch(`https://${cell}.rovara.dev/v1`);\n", "cell-host"],
    ["a wildcard cell host", "x.md", "*.rovara.dev\n", "cell-host"],
    ["the bare rovara.dev host", "x.md", "https://rovara.dev/\n", "cell-host"],
    ["an amazonaws host", "x.ts", 'fetch("https://abc123.execute-api.us-east-1.amazonaws.com/");\n', "aws-host"],
    ["an amazonaws host in capitals", "x.ts", 'fetch("https://ABC.S3.AMAZONAWS.COM/");\n', "aws-host"],
    ["an amazonaws host with an escaped dot", "x.ts", 'const h = "bucket.s3.amazonaws\\u002ecom";\n', "aws-host"],
    ["a lambda function url host", "x.ts", 'fetch("https://abc.lambda-url.us-east-1.on.aws/");\n', "aws-host"],
    ["a cognito host", "x.ts", 'fetch("https://id.auth.us-east-1.amazoncognito.com/");\n', "aws-host"],
    ["a cloudfront host", "x.ts", 'fetch("https://d111111abcdef8.cloudfront.net/");\n', "aws-host"],
    ["an awsapps host", "x.ts", 'fetch("https://d-123.awsapps.com/start");\n', "aws-host"],
    // ids
    ["a real-looking org id", "x.json", `{"org": "${orgId()}"}\n`, "org-id"],
    ["an org id in capitals", "x.json", `{"org": "${orgId().toUpperCase()}"}\n`, "org-id"],
    ["an org id longer than 20 characters", "x.json", `{"org": "org_${alnum(30)}"}\n`, "org-id"],
    ["an account id", "x.md", `account ${accountId()}\n`, "account-id"],
    ["an account id with dashes", "x.md", ((a) => `account ${a.slice(0, 4)}-${a.slice(4, 8)}-${a.slice(8)}\n`)(accountId()), "account-id"],
    ["an account id with spaces", "x.md", ((a) => `account ${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}\n`)(accountId()), "account-id"],
    ["an account id inside a longer digit run", "x.md", `serial ${digits(14)}\n`, "account-id"],
    ["an account id after letters", "x.md", `acct${accountId()}\n`, "account-id"],
    // imports
    ["a bare package import", "x.ts", 'import { thing } from "left-pad";\n', "import"],
    ["a minified named import", "x.js", 'import{a}from"left-pad";\n', "import"],
    ["a minified namespace import", "x.js", 'import*as a from"left-pad";\n', "import"],
    ["a minified re-export", "x.js", 'export*from"left-pad";\n', "import"],
    ["a type import", "x.ts", 'import type { A } from "left-pad";\n', "import"],
    ["a node builtin without the node: prefix", "x.ts", 'import { readFileSync } from "fs";\n', "import"],
    ["a side-effect import", "x.ts", 'import "left-pad";\n', "import"],
    ["a minified side-effect import", "x.js", 'import"left-pad";\n', "import"],
    ["a re-export from a package", "x.ts", 'export * from "left-pad";\n', "import"],
    ["a named re-export from a package", "x.ts", 'export { a } from "left-pad";\n', "import"],
    ["a dynamic import", "x.mjs", 'const m = await import("left-pad");\n', "import"],
    ["a dynamic import of a template literal", "x.mjs", "const m = await import(`left-pad`);\n", "import"],
    ["a computed dynamic import", "x.mjs", "const m = await import(name);\n", "import"],
    ["a concatenated dynamic import", "x.mjs", 'const m = await import("left-" + "pad");\n', "import"],
    ["a require", "x.js", 'const m = require("left-pad");\n', "import"],
    ["a computed require", "x.js", "const m = require(name);\n", "import"],
    ["a createRequire", "x.mjs", `import { ${word.createRequire} } from "node:module";\nconst r = ${word.createRequire}(import.meta.url);\n`, "import"],
    ["an import = require", "x.ts", 'import m = require("left-pad");\n', "import"],
    ["a module declaration", "x.d.ts", 'declare module "left-pad" { export const a: number; }\n', "import"],
    ["a types reference", "x.d.ts", '/// <reference types="left-pad" />\n', "import"],
    ["a path reference", "x.d.ts", '/// <reference path="../../outside.d.ts" />\n', "import"],
    ["a multi-line import", "x.ts", 'import {\n  a,\n  b,\n} from "left-pad";\n', "import"],
    ["a relative import that leaves the package", "x.ts", 'import { a } from "../../../outside.js";\n', "import"],
    // file types and names
    ["a tsx file", "x.tsx", "export const a = 1;\n", "file-type"],
    ["a vue file", "x.vue", "<template></template>\n", "file-type"],
    ["an html file", "x.html", "<p>hi</p>\n", "file-type"],
    ["a shell script", "x.sh", "echo hi\n", "file-type"],
    ["an extensionless file", "Makefile", "all:\n", "file-type"],
    ["an npm config file", ".npmrc", "registry=https://registry.npmjs.org/\n", "file-type"],
    ["an env file", ".env", "A=1\n", "file-type"],
    ["a declaration map", "x.d.ts.map", "{}\n", "file-type"],
    ["a cjs file", "x.cjs", "module.exports = 1;\n", "file-type"],
    ["a pem file outside src/trust", "x.pem", "# nothing\n", "file-type"],
    ["a file name holding the product name", `${word.product}-notes.md`, "fine\n", "private-name"],
    ["a file name with a unicode letter", "caf\u00e9.md", "fine\n", "name"],
    // keys and blobs
    ["a private key", "k.md", "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n", "pem"],
    ["a private key with headers and no body shape", "k.md", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n", "pem"],
  ];
  it.each(cases)("fails on %s", (_name, file, text, rule) => {
    const result = one(file, text);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rule);
  });

  it("takes LICENSE, NOTICE and .gitignore at the root only", () => {
    expect(plant({ LICENSE: "text\n", NOTICE: "text\n", ".gitignore": "dist/\n" }).status).toBe(0);
    for (const name of ["sub/LICENSE", "sub/NOTICE", "sub/.gitignore"]) expect(plant({ [name]: "text\n" }).stderr).toContain(`${name}:0: file-type`);
  });

  it("reports a rule on a later line, not only the first", () => {
    const result = one("x.ts", `// one\n// two\n// three\nconst env = "${word.staging}";\n`);
    expect(result.stderr).toContain("extra/x.ts:4: preprod");
  });

  describe("certificates and blobs", () => {
    const pem = makePki("Planted").root.x509.toString().trim();
    const body = pem.split("\n").slice(1, -1);
    const raw = makePki("Planted").root.x509.raw.toString("base64");
    const failsAsPem = (name: string, text: string) => {
      const result = one(name, text);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pem");
    };

    it("fails on a certificate that is not one of the two pinned roots", () => failsAsPem("other-root.md", pem + "\n"));
    it("fails on that certificate escaped inside a JSON string", () => failsAsPem("x.json", JSON.stringify({ ca: pem + "\n" }) + "\n"));
    it("fails on that certificate escaped inside a source string", () => failsAsPem("x.ts", `export const ca = ${JSON.stringify(pem + "\n")};\n`));
    it("fails on the bare base64 in a string, with no markers", () => failsAsPem("x.ts", `export const ca = "${raw}";\n`));
    it("fails on the bare base64 split over concatenated lines", () =>
      failsAsPem("x.ts", `export const ca =\n${body.map((l) => `  "${l}" +`).join("\n")}\n  "";\n`));
    it("fails on lines prefixed with a comment star", () => failsAsPem("x.ts", `/*\n${pem.split("\n").map((l) => ` * ${l}`).join("\n")}\n */\n`));
    it("fails on lines prefixed with slashes", () => failsAsPem("x.ts", pem.split("\n").map((l) => `// ${l}`).join("\n") + "\n"));
    it("fails with a stray text line inside the body", () =>
      failsAsPem("x.md", [...body.slice(0, 2), "this line is not base64 at all", ...body.slice(2)].join("\n") + "\n"));
    it("fails with a stray text line inside a small structure, which only reads as one when joined", () => {
      const der = Buffer.concat([Buffer.from([0x30, 0x7e]), randomBytes(0x7e)]).toString("base64");
      const lines = wrap64(der).split("\n");
      expect(lines).toHaveLength(3);
      failsAsPem("x.md", [lines[0]!, "this line is not base64 at all", lines[1]!, lines[2]!].join("\n") + "\n");
      failsAsPem("x.md", lines.join("\n") + "\n");
    });

    it("fails on a long base64 blob that is not a certificate", () => {
      const blob = randomBytes(400).toString("base64");
      failsAsPem("x.md", wrap64(blob) + "\n");
    });
    it("fails on a long blob on one line", () => failsAsPem("x.json", JSON.stringify({ data: randomBytes(400).toString("base64") }) + "\n"));

    it("lets the pinned roots through however they are written", () => {
      const roots = ["digicert", "sectigo"].map((label) => readFileSync(join(packageDir, `src/trust/${label}.pem`), "utf8"));
      for (const root of roots) {
        const block = root.slice(root.indexOf("-----BEGIN")).trim();
        expect(plant({ "extra/a.md": block + "\n" }).status).toBe(0);
        expect(plant({ "extra/b.ts": `export const r = ${JSON.stringify(block)};\n` }).status).toBe(0);
        expect(plant({ "extra/c.ts": block.split("\n").map((l) => `// ${l}`).join("\n") + "\n" }).status).toBe(0);
      }
    });

    it("lets the pinned time-stamp fixtures through at their own path while their bytes are unchanged, and nowhere else", () => {
      const path = "test/support/real-timestamp-responses.ts";
      const real = readFileSync(join(packageDir, path), "utf8");
      expect(plant({ [path]: real }).status).toBe(0);
      expect(plant({ [path]: real + "\n// edited\n" }).stderr).toContain(`${path}:`);
      expect(plant({ "test/support/other-responses.ts": real }).stderr).toContain("pem");
    });

    it("lets lists of hashes and of identifiers through", () => {
      const hashes = Array.from({ length: 6 }, () => `  "${randomBytes(32).toString("hex")}",`).join("\n");
      const names = ["buildAuditFixtureForTheBundle", "cloneBundleWithEveryRecord", "closedAtOfTheEpoch", "flipHexDigitsInPlace", "rechainFromTheSeq", "mintTokenForTheEpoch", "epochIdOfTheSeal", "sealLeafDataOfTheSeal", "verifyBundleWithAnchors", "verifyExtendsAgainstOlder", "parseTimeStampResponseBytes", "findSignerCertificatesIn"];
      const result = plant({ "extra/a.ts": `const hashes = [\n${hashes}\n];\n`, "extra/b.ts": `import {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "./x.js";\n` });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("lets short base64 and hashes through", () => {
      const lock = JSON.stringify({ integrity: "sha512-" + randomBytes(64).toString("base64") }, null, 2);
      const text = `${lock}\nsha256 ${createHash("sha256").update("x").digest("hex")}\nrandom ${randomBytes(30).toString("base64")}\n`;
      const result = plant({ "extra/package-lock.json": text });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });

  it("allows relative imports inside the package, node: imports, and a documentation link", () => {
    const text = [
      'import { readFileSync } from "node:fs";',
      'import { a } from "./sibling.js";',
      'export { b } from "../src/index.js";',
      'const m = await import("node:path");',
      "// see https://docs.aws.amazon.com/general/latest/gr/rande.html",
      "// the pattern /-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/ is not a key",
      "",
    ].join("\n");
    const result = one("ok.ts", text);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("allows an Amazon documentation host and nothing else under that domain", () => {
    expect(one("doc.md", "https://awsdocs.s3.amazonaws.com/guide.pdf\n").status).toBe(0);
    expect(one("doc.md", "https://other.s3.amazonaws.com/guide.pdf\n").status).toBe(1);
  });

  it("does not flag numbers that are not account ids", () => {
    const text = [
      `eleven digits ${digits(11)}`,
      "dates 2026-10-20 2026-10-21 2026-10-22",
      `a hash-like token ${"a".repeat(10)}${digits(12)}${"b".repeat(14)}`,
      `org_${alnum(19)}`,
      "",
    ].join("\n");
    const result = one("numbers.md", text);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("leaves bare digit runs to the tests directory, but not ARNs or labelled ids, and checks them everywhere else", () => {
    const id = accountId();
    expect(plant({ "test/a.ts": `const n = "${id}";\n`, "test/b.ts": `const day = "491231235959Z";\n` }).status).toBe(0);
    expect(plant({ "src/a.ts": `const n = "${id}";\n` }).stderr).toContain("src/a.ts:1: account-id");
    expect(plant({ "test/a.ts": `const arn = "arn:aws:iam::${id}:root";\n` }).stderr).toContain("test/a.ts:1: account-id");
    expect(plant({ "test/a.ts": `// the account is ${id}\n` }).stderr).toContain("test/a.ts:1: account-id");
    expect(plant({ "test/a.ts": `// ${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}\n` }).stderr).toContain("account-id");
  });

  it("allows only the exact proposed repository url in repository.url, and the copyright line in the root files", () => {
    const dir = tempDir("audit-meta-");
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      repository?: { type?: string; url?: string };
    };
    const url = `git+https://github.com/${word.org}AI/rovara-audit-verifier.git`;
    expect(pkg.repository?.url).toBe(url);
    const put = (name: string, text: string) => {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    };
    const notice = `Rovara audit verifier\nCopyright 2026 ${word.org}\n`;
    put("package.json", JSON.stringify(pkg));
    put("NOTICE", notice);
    put("LICENSE", notice);
    expect(check(dir).status).toBe(0);
    // A different url, the url in another field, or the name anywhere else in the same files, fails.
    put("package.json", JSON.stringify({ ...pkg, repository: { url: `git+https://github.com/${word.org}AI/${word.cloud}.git` } }));
    expect(check(dir).status).toBe(1);
    put("package.json", JSON.stringify({ ...pkg, homepage: url }));
    expect(check(dir).status).toBe(1);
    put("package.json", JSON.stringify({ ...pkg, repository: { url: url + "x" } }));
    expect(check(dir).status).toBe(1);
    put("package.json", JSON.stringify(pkg));
    put("NOTICE", `Rovara audit verifier\nbuilt inside ${word.org}\n`);
    expect(check(dir).status).toBe(1);
    put("NOTICE", `Rovara audit verifier\nCopyright 2025 ${word.org}\n`);
    expect(check(dir).status).toBe(1);
    put("NOTICE", `Rovara audit verifier\ncopyright 2026 ${word.org}\n`);
    expect(check(dir).status).toBe(1);
    put("NOTICE", `Rovara audit verifier\nCopyright 2026 ${word.org} and others\n`);
    expect(check(dir).status).toBe(1);
    put("NOTICE", notice);
    // The exemptions are for the root files only.
    put("sub/package.json", JSON.stringify(pkg));
    expect(check(dir).status).toBe(1);
    rmSync(join(dir, "sub"), { recursive: true });
    put("sub/LICENSE", notice);
    expect(check(dir).status).toBe(1);
    rmSync(join(dir, "sub"), { recursive: true });
    put("x.ts", `// ${url}\n`);
    expect(check(dir).status).toBe(1);
    rmSync(join(dir, "x.ts"));
    put("README.md", notice);
    expect(check(dir).status).toBe(1);
  });

  it("refuses a package.json with dependencies, other development dependencies or install scripts", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
    const withField = (field: string, value: unknown) => plant({ "package.json": JSON.stringify({ ...pkg, [field]: value }) });
    expect(withField("dependencies", { "left-pad": "1.0.0" }).status).toBe(1);
    expect(withField("peerDependencies", { "left-pad": "1.0.0" }).status).toBe(1);
    expect(withField("optionalDependencies", { "left-pad": "1.0.0" }).status).toBe(1);
    expect(withField("devDependencies", { typescript: "5.9.3", "left-pad": "1.0.0" }).status).toBe(1);
    expect(withField("scripts", { postinstall: "node x.js" }).status).toBe(1);
    expect(plant({ "package.json": "{ not json" }).status).toBe(1);
    expect(withField("dependencies", { "left-pad": "1.0.0" }).stderr).toContain("package.json");
  });

  describe("traversal", () => {
    it("fails on a symlink to a file, and on a symlink to a directory", () => {
      const target = tempDir("audit-target-");
      writeFileSync(join(target, "secret.md"), "nothing here\n");
      for (const [name, to] of [["link.md", join(target, "secret.md")], ["linkdir", target]] as const) {
        const dir = build({});
        symlinkSync(to, join(dir, name));
        const result = check(dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${name}:0: symlink`);
      }
    });

    it("fails on a dangling symlink and on a symlinked node_modules", () => {
      const dir = build({});
      symlinkSync(join(tmpdir(), "audit-nothing-" + randomBytes(4).toString("hex")), join(dir, "dangling.md"));
      expect(check(dir).stderr).toContain("dangling.md:0: symlink");
      const other = build({});
      symlinkSync(tempDir("audit-modules-"), join(other, "node_modules"));
      expect(check(other).stderr).toContain("node_modules:0: symlink");
    });

    it("fails on a directory named for a private name", () => {
      const result = plant({ [`${word.product}/notes.md`]: "fine\n" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("private-name");
    });

    it("fails on an empty directory named for a private name", () => {
      const dir = build({});
      mkdirSync(join(dir, word.product));
      expect(check(dir).stderr).toContain(`${word.product}:0: private-name`);
    });

    it("skips a real node_modules at the root only", () => {
      const bad = `${word.product}\n`;
      expect(plant({ "node_modules/x/bad.js": bad, "node_modules/x/readme": bad }).status).toBe(0);
      expect(plant({ "src/node_modules/x/bad.js": bad }).status).toBe(1);
    });

    it("skips the root build output and nothing like it elsewhere", () => {
      const bad = `${word.product}\n`;
      expect(plant({ ".test-build/test/a.js": bad, "tsconfig.tsbuildinfo": bad }).status).toBe(0);
      expect(plant({ "src/.test-build/a.js": bad }).status).toBe(1);
      expect(plant({ "src/tsconfig.tsbuildinfo": bad }).status).toBe(1);
    });
  });

  describe("the built package, loaded with node", () => {
    const entry = (text: string) => ({ "dist/index.js": text, "dist/index.d.ts": "export {};\n" });

    it("passes a dist that imports only node: and relative modules", () => {
      const files = { ...entry('import { a } from "./a.js";\nexport { a };\n'), "dist/a.js": 'import { join } from "node:path";\nexport const a = join("a", "b");\n', "dist/a.d.ts": "export {};\n" };
      const result = plant(files, "--built");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("fails a computed import that only the loader sees", () => {
      const result = plant(entry('const name = ["left", "pad"].join("-");\nawait import(name);\n'), "--built");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:0: load");
    });

    it("fails a bare builtin without the node: prefix, which resolves in node but is not allowed", () => {
      const result = plant(entry('const name = ["f", "s"].join("");\nawait import(name);\n'), "--built");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("load");
    });

    it("fails an entry that throws while loading", () => {
      const result = plant(entry('throw new Error("boom");\n'), "--built");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:0: load");
    });

    it("fails when there is no dist to load", () => {
      expect(plant({}, "--built").status).toBe(1);
      expect(plant({}).status).toBe(0);
    });

    it("fails a file type that dist may not hold, and loads without any node_modules next to it", () => {
      expect(plant({ ...entry("export {};\n"), "dist/data.json": "{}\n" }, "--built").stderr).toContain("dist/data.json:0: file-type");
      expect(plant({ ...entry("export {};\n"), "dist/index.d.ts.map": "{}\n" }, "--built").stderr).toContain("dist/index.d.ts.map:0: file-type");
      expect(plant({ ...entry("export {};\n"), "dist/notes.md": "x\n" }, "--built").stderr).toContain("dist/notes.md:0: file-type");
      // The copy that is loaded holds only dist and package.json, so a sibling node_modules cannot satisfy an import.
      const files = { ...entry('await import("left-pad");\n'), "node_modules/left-pad/index.js": "export {};\n", "node_modules/left-pad/package.json": '{"name":"left-pad","version":"1.0.0","type":"module","main":"index.js"}\n' };
      expect(plant(files, "--built").status).toBe(1);
    });
  });
});

describe("package metadata", () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { devDependencies: Record<string, string> };

  it("stays private until the owner says go, and lists what it ships", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "NOTICE"]);
    expect(pkg.engines).toEqual({ node: ">=22.19.0 <23" });
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) expect(pkg).not.toHaveProperty(key);
  });

  it("builds, tests and packs with scripts of its own, using the same compiler as the repository", () => {
    expect(pkg.devDependencies).toEqual({
      "@types/node": rootPkg.devDependencies["@types/node"],
      typescript: rootPkg.devDependencies.typescript,
    });
    const scripts = pkg.scripts as Record<string, string>;
    expect(Object.keys(scripts).sort()).toEqual(["build", "check:public", "prepack", "test"]);
    expect(scripts.build).toBe("tsc -b");
    expect(scripts.test).toContain("node --test");
    expect(scripts.prepack).toContain("check-public.mjs");
    expect(scripts.prepack).toContain("--built");
  });

  it("has a standalone tsconfig that says where it came from, and ships no declaration maps", () => {
    const text = readFileSync(join(packageDir, "tsconfig.json"), "utf8");
    expect(text).not.toContain('"extends"');
    expect(text).toContain("tsconfig.base.json");
    expect(text).not.toMatch(/"declarationMap":\s*true/);
    const testText = readFileSync(join(packageDir, "tsconfig.test.json"), "utf8");
    expect(testText).not.toContain("../../");
  });

  it("ships a NOTICE and a lockfile for the clean install", () => {
    expect(readFileSync(join(packageDir, "NOTICE"), "utf8")).toContain("Copyright 2026");
    const lock = JSON.parse(readFileSync(join(packageDir, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages).sort()).toEqual(["", "node_modules/@types/node", "node_modules/typescript", "node_modules/undici-types"]);
  });
});

describe("the package alone, outside the monorepo, from a clean install", () => {
  let cached: string | undefined;
  /** Copies the package without build output or node_modules, once; every test calls this and none relies on another. */
  const standalone = (): string => {
    if (cached !== undefined) return cached;
    const dir = tempDir("audit-alone-");
    const copy = join(dir, "audit-verifier");
    cpSync(packageDir, copy, {
      recursive: true,
      filter: (source) => !/(^|\/)(dist|node_modules|\.test-build)(\/|$)|\.tsbuildinfo$/.test(source.slice(packageDir.length)),
    });
    cached = copy;
    return copy;
  };
  const npm = (copy: string, ...args: string[]) =>
    run("npm", args, copy, { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_prefer_offline: "true" });
  let installed = false;
  const installed_ = (): string => {
    const copy = standalone();
    if (!installed) {
      const result = npm(copy, "ci");
      expect(result.stderr).not.toContain("ERR!");
      expect(result.status).toBe(0);
      installed = true;
    }
    return copy;
  };

  it("holds no build output, no node_modules and no path into the monorepo", () => {
    const copy = standalone();
    expect(existsSync(join(copy, "dist"))).toBe(false);
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
    expect(existsSync(join(copy, "package-lock.json"))).toBe(true);
    for (const file of ["tsconfig.json", "tsconfig.test.json", "package.json"]) {
      expect(readFileSync(join(copy, file), "utf8")).not.toContain("../../");
    }
    expect(check(copy).status).toBe(0);
  });

  it("installs from its own lockfile, then runs its own tests with the node test runner", () => {
    const copy = installed_();
    const result = npm(copy, "test");
    expect(result.status).toBe(0);
    const count = (name: string): number => Number(new RegExp(`(?:ℹ|#) ${name} (\\d+)`).exec(result.stdout)?.[1] ?? "-1");
    expect(count("fail")).toBe(0);
    expect(count("pass")).toBeGreaterThanOrEqual(190);
    expect(count("tests")).toBe(count("pass"));
    expect(result.stderr).toBe("");
    // Nothing of vitest is needed or installed.
    expect(existsSync(join(copy, "node_modules/vitest"))).toBe(false);
  }, 300_000);

  it("builds with tsc, and its CLI verifies the Task 3 fixture and fails a tampered copy", () => {
    const copy = installed_();
    const built = npm(copy, "run", "build");
    expect(built.stdout).not.toContain("error");
    expect(built.status).toBe(0);
    expect(existsSync(join(copy, "dist/cli.js"))).toBe(true);
    expect(existsSync(join(copy, "dist/index.d.ts"))).toBe(true);
    expect(existsSync(join(copy, "dist/index.d.ts.map"))).toBe(false);

    const dir = tempDir("audit-cli-");
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
  }, 300_000);

  it("packs only dist, README, LICENSE, NOTICE and package.json, after the checks pass on the built copy", () => {
    const copy = installed_();
    const out = tempDir("audit-pack-");
    const packed = npm(copy, "pack", "--json", "--pack-destination", out);
    expect(packed.status).toBe(0);
    const [info] = JSON.parse(packed.stdout.slice(packed.stdout.search(/^\[/m))) as Array<{ files: Array<{ path: string }> }>;
    const paths = info!.files.map((f) => f.path).sort();
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("NOTICE");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths.filter((p) => !/^(dist\/[^/]+\.(js|d\.ts)|README\.md|LICENSE|NOTICE|package\.json)$/.test(p))).toEqual([]);
    expect(check(copy, "--built").status).toBe(0);
  }, 300_000);
});
