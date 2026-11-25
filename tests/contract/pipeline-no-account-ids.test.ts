// NO ACCOUNT IDS IN COMMITTED FILES (controller rule, 2026-11-24): the Cloud repository has a public copy with full history. No real AWS account id may be
// written in the pipeline's code, its infra or its contract tests; the stage resolves the account at run time and checks it against one given from outside git.
// Every text file under the roots is scanned (binary files by content, and the named lockfiles, are skipped). The only 12-digit tokens allowed are the three
// documented fakes, one repeated digit, and the exact file+token pairs in KNOWN_NON_ACCOUNTS below, each with its reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FAKE_ACCOUNTS = new Set(["123456789012", "210987654321", "111122223333"]);
const ROOTS = ["infra/lib", "tests/contract", "ops/pipeline"];
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu;
const SKIPPED_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist"]);

/** Exact file and token, with why it is not an account id. A token listed here is allowed in that file only. */
export const KNOWN_NON_ACCOUNTS: ReadonlyArray<{ file: string; token: string; reason: string }> = [
  { file: "tests/contract/audit-verifier-timestamp.test.ts", token: "060480808001", reason: "DER hex of an object identifier" },
  { file: "tests/contract/audit-verifier-timestamp.test.ts", token: "491231235959", reason: "an ASN.1 time string (end of the X.509 date range)" },
  { file: "tests/contract/audit-verifier-timestamp.test.ts", token: "500101000000", reason: "an ASN.1 time string" },
  { file: "tests/contract/audit-verifier-public.test.ts", token: "491231235959", reason: "an ASN.1 time string" },
  { file: "tests/contract/test-env-dependency.test.ts", token: "222233334444", reason: "a patterned placeholder account in sample ARNs" },
  { file: "tests/contract/test-environment-contract.test.ts", token: "222233334444", reason: "a patterned placeholder account in sample ARNs" },
  { file: "tests/contract/test-environment-contract.test.ts", token: "999900001111", reason: "a patterned placeholder account in sample ARNs" },
  // This file names the tokens above, so it is allowed to hold exactly them.
  { file: "tests/contract/pipeline-no-account-ids.test.ts", token: "060480808001", reason: "names the allowed token" },
  { file: "tests/contract/pipeline-no-account-ids.test.ts", token: "491231235959", reason: "names the allowed token" },
  { file: "tests/contract/pipeline-no-account-ids.test.ts", token: "500101000000", reason: "names the allowed token" },
  { file: "tests/contract/pipeline-no-account-ids.test.ts", token: "222233334444", reason: "names the allowed token" },
  { file: "tests/contract/pipeline-no-account-ids.test.ts", token: "999900001111", reason: "names the allowed token" },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIPPED_DIRS.has(name)) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** A file is scanned unless it is a named lockfile or has a NUL byte (a binary). Extension never decides: .yml, .yaml, .js, .txt and the rest are all text. */
export function isScanned(path: string, content: Buffer): boolean {
  const name = path.split("/").pop() ?? path;
  return !SKIPPED_NAMES.has(name) && !content.includes(0);
}

/** 12-digit tokens in a text that are not allowed in this file (UUIDs removed first). */
export function accountLikeTokens(path: string, text: string): string[] {
  const allowedHere = new Set(KNOWN_NON_ACCOUNTS.filter((entry) => entry.file === path).map((entry) => entry.token));
  const found: string[] = [];
  for (const match of text.replace(UUID, "").matchAll(/(?<![0-9])[0-9]{12}(?![0-9])/gu)) {
    const token = match[0];
    if (FAKE_ACCOUNTS.has(token) || /^(\d)\1{11}$/u.test(token) || allowedHere.has(token)) continue;
    found.push(token);
  }
  return found;
}

describe("no real AWS account id in the pipeline's files", () => {
  it("holds no 12-digit token in infra/lib, tests/contract or ops/pipeline except the documented ones", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const path of walk(root)) {
        const content = readFileSync(path);
        if (!isScanned(path, content)) continue;
        for (const token of accountLikeTokens(path, content.toString("utf8"))) found.push(`${path}: ${token.slice(0, 2)}**********`);
      }
    }
    expect(found).toEqual([]);
  });

  it("every allowed non-account entry is still present in its file (a stale entry is removed, not kept)", () => {
    for (const entry of KNOWN_NON_ACCOUNTS) expect(readFileSync(entry.file, "utf8"), `${entry.file} ${entry.reason}`).toContain(entry.token);
  });

  it("scans every kind of text file, and skips only lockfiles and binaries", () => {
    for (const name of ["buildspec.yml", "buildspec.yaml", "a.js", "notes.txt", "x.sh", "y.mjs", "z.md", "w.json", "v.ts", "noextension"]) expect(isScanned(`ops/pipeline/${name}`, Buffer.from("text")), name).toBe(true);
    expect(isScanned("ops/pipeline/package-lock.json", Buffer.from("text"))).toBe(false);
    expect(isScanned("ops/pipeline/image.png", Buffer.from([137, 80, 0, 71]))).toBe(false);
  });

  it("refuses an id-shaped token, including one that looks like a time string, anywhere but its listed file", () => {
    const real = ["34567", "8901234"].join("");
    const timeLike = ["49123", "1235959"].join("");
    expect(accountLikeTokens("ops/pipeline/x.yml", `account: ${real}`)).toEqual([real]);
    expect(accountLikeTokens("tests/contract/other.test.ts", `x ${timeLike} x`)).toEqual([timeLike]);
    expect(accountLikeTokens("tests/contract/audit-verifier-public.test.ts", `x ${timeLike} x`)).toEqual([]);
    expect(accountLikeTokens("ops/pipeline/x.txt", "x 123456789012 x 111111111111 x 11111111-1111-4111-8111-111111111111")).toEqual([]);
  });
});
