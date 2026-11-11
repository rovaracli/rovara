import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { posix } from "node:path";
// The browser-safe files of Rovara Code's contracts, read by path on purpose: this test compares them with the Node build of the same names that the package barrel exports. (Code has no
// browser entry; the one Cloud ships, `@agentx/cloud-contracts/web`, re-exports Code's names through the barrel and the build tree-shakes the Node-only modules out.)
import { CandidateManifestSchema as BrowserCandidate, workflowFindingFingerprint as browserFingerprint } from "../../vendor/rovara-code/packages/contracts/src/task-workflow.js";
import { RelativeWorkspacePathSchema as BrowserPath } from "../../vendor/rovara-code/packages/contracts/src/project.js";
import { CandidateManifestSchema as NodeCandidate, workflowFindingFingerprint as nodeFingerprint, RelativeWorkspacePathSchema as NodePath } from "@rovara-code/contracts";
import { sha256Hex } from "../../packages/cloud-contracts/src/web-hash.js";
import ts from "typescript";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
const root = process.cwd();
async function graph(file: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = await readFile(path.join(root, file), "utf8");
  const info = ts.preProcessFile(source, true, true);
  for (const imported of info.importedFiles) {
    const name = imported.fileName;
    expect(name).not.toMatch(/^(node:|typescript$|@rovara\/audit-verifier)/);
    if (name.startsWith(".")) {
      const resolved = ts.resolveModuleName(name, path.join(root, file), { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule;
      expect(resolved, name).toBeDefined();
      if (resolved) await graph(path.relative(root, resolved.resolvedFileName), seen);
    }
  }
  return seen;
}
describe("browser contracts entry", () => {
  it("has an exact, entirely browser-safe import graph", async () => {
    const manifest: unknown = JSON.parse(await readFile("packages/cloud-contracts/web-safe-files.json", "utf8"));
    expect([...(await graph("packages/cloud-contracts/src/web.ts"))].sort()).toEqual(manifest);
  });
  it("refuses a Node import added to a listed file", async () => {
    // Run bare, ESLint types the file with tsconfig.lint.json, the program over the whole repository (about 2,900 files; one eslint process over all of it needed
    // about 14 GB), and a worker on an 8 GB CI runner, whose heap defaults to about 2 GB, ran out of memory. npm run lint types each file with the program that owns it
    // instead (scripts/lint-shards.ts, through ROVARA_LINT_PROJECT, which eslint.config.js reads when it loads). The file is in the contracts package's program, so
    // the same config and the same rule run over a few hundred files.
    // typescript-eslint also switches to "single run" when CI=true (GitHub Actions sets it): it then reads the file from disk, not the text given to lintText, finds no
    // Node import in the real file and reports nothing (run 40693750224). TSESTREE_SINGLE_RUN=false keeps the program on the text under test.
    const before = process.env.ROVARA_LINT_PROJECT;
    const beforeSingleRun = process.env.TSESTREE_SINGLE_RUN;
    process.env.ROVARA_LINT_PROJECT = "./tsconfig.lint/pkg-contracts.json";
    process.env.TSESTREE_SINGLE_RUN = "false";
    try {
      const results = await new ESLint().lintText('import { createHash } from "node:crypto"; export const hash = createHash;', { filePath: "packages/cloud-contracts/src/web.ts" });
      // The messages are the assertion's own message, so a run that returns none of the rule's (a parse error, an ignored file) says why in its log.
      const messages = results.flatMap(result => result.messages);
      expect(messages.some(message => message.ruleId === "no-restricted-imports"), JSON.stringify(messages.map(message => ({ ruleId: message.ruleId, fatal: message.fatal, text: message.message.slice(0, 300) })))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ROVARA_LINT_PROJECT;
      else process.env.ROVARA_LINT_PROJECT = before;
      if (beforeSingleRun === undefined) delete process.env.TSESTREE_SINGLE_RUN;
      else process.env.TSESTREE_SINGLE_RUN = beforeSingleRun;
    }
  });
  it("keeps schema fingerprints byte-compatible with stored Node hashes", () => {
    for (const text of ["", "abc", "a".repeat(1000), "é 😀", "\ud800", JSON.stringify({ repository: "acme/payments", revision: 1 })]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
  it("preserves browser and Node schema acceptance, path normalization and stored digests", () => {
    for (const value of ["src/index.ts", "a/b", ".hidden/file", "a/../b", "a//b", "a/", "./a", "../a", "/a", "a\\b", "", "a".repeat(513)]) {
      const priorAcceptance = value.length >= 1 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => part === "" || part === "." || part === "..") && posix.normalize(value) === value;
      expect(BrowserPath.safeParse(value).success, value).toBe(priorAcceptance);
      expect(NodePath.safeParse(value).success, value).toBe(priorAcceptance);
    }
    const repositories = [{ repositoryId: "repo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }];
    const digest = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, repositories })).digest("hex");
    for (const manifest of [{ schemaVersion: 1, repositories, digest }, { schemaVersion: 1, repositories, digest: "0".repeat(64) }]) {
      expect(BrowserCandidate.safeParse(manifest).success).toBe(NodeCandidate.safeParse(manifest).success);
      expect(BrowserCandidate.safeParse(manifest).success).toBe(manifest.digest === digest);
    }
    const finding = { text: "A stored finding", file: "src/index.ts", line: 7 };
    const expected = createHash("sha256").update(JSON.stringify(["CRITIC", finding.text, finding.file, finding.line]), "utf8").digest("hex");
    expect(browserFingerprint("CRITIC", finding)).toBe(expected);
    expect(nodeFingerprint("CRITIC", finding)).toBe(expected);
  });
  it("configures Zod without runtime code generation", async () => {
    const { configureZodForCsp, SessionIdSchema } = await import("@agentx/cloud-contracts/web");
    const { z } = await import("zod");
    configureZodForCsp();
    expect(z.config().jitless).toBe(true);
    expect(SessionIdSchema.safeParse("ses_" + "a".repeat(20)).success).toBe(true);
  });
  it("emits no Node or TypeScript compiler code into browser assets", async () => {
    const directory = "packages/web/dist/app/assets";
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".js")) continue;
      const original = await readFile(path.join(directory, file));
      expect(brotliDecompressSync(await readFile(path.join(directory, file + ".br")))).toEqual(original);
      expect(gunzipSync(await readFile(path.join(directory, file + ".gz")))).toEqual(original);
      const source = original.toString("utf8");
      // RULING Q4: React DOM contains an ordinary node: object key.
      expect(/["'`]node:|ts\.createSourceFile/.test(source), file).toBe(false);
    }
  });
});

it("shares one browser-safe principal key helper with Node storage", async () => {
 const browser = await import("@agentx/cloud-contracts/web"), node = await import("@rovara-code/contracts");
 expect(browser.principalKey).toBe(node.principalKey);
 for (const principal of [{ kind: "member", developerId: "a".repeat(64) }, { kind: "project", project: "payments" }, { kind: "org" }] as const) {
  expect(browser.principalKey(principal)).toBe(node.principalKey(principal));
  expect(browser.principalKey(principal)).toBe(principal.kind === "member" ? "MEMBER#" + principal.developerId : principal.kind === "project" ? "PROJECT#" + principal.project : "ORG");
 }
});
