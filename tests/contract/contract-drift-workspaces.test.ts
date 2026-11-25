// The drift tool against a Code repository whose contracts import a sibling workspace package (Code train 42: @preplabsai/rovara-code-api). A fixture repo, no network, no real Code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installContractsWorkspaces, workspaceDependencies } from "../../scripts/contract-drift/code-workspaces.js";
import { CLOUD_ROOT, exportCode, webSafeFiles } from "../../scripts/contract-drift/run.js";

const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"];
const CONTRACT_FILE = webSafeFiles()[0] as string; // a file the Cloud list names, so the fixture's contracts file is one the tool reads
const write = (root: string, file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const commit = (repo: string): string => {
  execFileSync("git", [...GIT, "-C", repo, "add", "-A"]);
  execFileSync("git", [...GIT, "-C", repo, "commit", "-q", "-m", "fixture"]);
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
};

/** A Code repo: packages/contracts imports @fixture/code-api (src/index.ts and src/sub.ts; the package's exports name dist files that only a build makes) and @fixture/deep through it. */
function fixtureRepo(over: { withSrc?: boolean } = {}): { repo: string; sha: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "drift-fixture-code-"));
  execFileSync("git", ["init", "-q", repo]);
  write(repo, "package.json", JSON.stringify({ name: "fixture-code", private: true, workspaces: ["packages/*"] }));
  write(repo, "packages/contracts/package.json", JSON.stringify({ name: "@fixture/contracts", type: "module", dependencies: { "@fixture/code-api": "0.1.0", zod: "4.6.6" } }));
  write(repo, `packages/contracts/${CONTRACT_FILE.replace(/^packages\/contracts\//u, "")}`, 'import { z } from "zod";\nimport { FIXTURE_CODES } from "@fixture/code-api";\nexport const FixtureCodeSchema = z.enum(FIXTURE_CODES);\n');
  write(repo, "packages/code-api/package.json", JSON.stringify({ name: "@fixture/code-api", type: "module", dependencies: { "@fixture/deep": "0.1.0" }, exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }));
  if (over.withSrc !== false) {
    write(repo, "packages/code-api/src/index.ts", 'import { DEEP } from "@fixture/deep";\nimport { MORE } from "./sub.js";\nexport const FIXTURE_CODES = ["ONE", "TWO", MORE, DEEP] as const;\n');
    write(repo, "packages/code-api/src/sub.ts", 'export const MORE: "THREE" = "THREE";\n');
  }
  write(repo, "packages/deep/package.json", JSON.stringify({ name: "@fixture/deep", type: "module", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }));
  write(repo, "packages/deep/src/index.ts", 'export const DEEP: "FOUR" = "FOUR";\n');
  return { repo, sha: commit(repo) };
}

describe("contract drift against a Code tree with workspace packages", () => {
  const made: string[] = [];
  beforeAll(() => { expect(existsSync(path.join(CLOUD_ROOT, "node_modules", "typescript"))).toBe(true); });
  afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

  it("finds every workspace package the contracts need, through the ones they depend on, and not the ones they do not", () => {
    const { repo, sha } = fixtureRepo();
    made.push(repo);
    expect(workspaceDependencies(repo, sha, "packages/contracts").map((w) => w.name)).toEqual(["@fixture/code-api", "@fixture/deep"]);
    expect(workspaceDependencies(repo, sha, "packages/deep")).toEqual([]);
  });

  it("exportCode loads Code's contracts that import a workspace package, built from the same commit, without writing to the Cloud tree's node_modules", async () => {
    const { repo, sha } = fixtureRepo();
    made.push(repo);
    const snapshot = await exportCode({ repo, ref: "HEAD" });
    expect(snapshot.source.sha).toBe(sha);
    const schema = snapshot.schemas[`${CONTRACT_FILE.replace(/^packages\/contracts\/src\//u, "")}#FixtureCodeSchema`] as { enum?: string[] } | undefined;
    expect(schema?.enum).toEqual(["ONE", "TWO", "THREE", "FOUR"]);
    expect(existsSync(path.join(CLOUD_ROOT, "node_modules", "@fixture"))).toBe(false);
  });

  it("fails closed when a workspace package cannot be built (no src): nothing is skipped", async () => {
    const { repo } = fixtureRepo({ withSrc: false });
    made.push(repo);
    await expect(exportCode({ repo, ref: "HEAD" })).rejects.toThrow(/@fixture\/code-api.*no src directory/u);
  });

  it("link-code-workspaces.ts (what the gate runs in a tree whose own tool predates the fix) installs the packages into that tree's node_modules, and exits non-zero when it cannot", () => {
    const { repo, sha } = fixtureRepo();
    const broken = fixtureRepo({ withSrc: false });
    const tree = mkdtempSync(path.join(tmpdir(), "drift-fixture-tree-"));
    made.push(repo, broken.repo, tree);
    mkdirSync(path.join(tree, "node_modules"));
    for (const name of ["typescript", "zod"]) symlinkSync(path.join(CLOUD_ROOT, "node_modules", name), path.join(tree, "node_modules", name));
    const script = path.join(CLOUD_ROOT, "scripts/contract-drift/link-code-workspaces.ts");
    const out = execFileSync(process.execPath, [script, tree, repo, sha], { encoding: "utf8" });
    expect(out).toMatch(/@fixture\/code-api, @fixture\/deep/u);
    expect(existsSync(path.join(tree, "node_modules/@fixture/code-api/dist/index.js"))).toBe(true);
    expect(existsSync(path.join(tree, "node_modules/@fixture/code-api/dist/sub.js"))).toBe(true);
    expect(existsSync(path.join(tree, "node_modules/@fixture/deep/dist/index.js"))).toBe(true);
    expect(() => installContractsWorkspaces(broken.repo, broken.sha, path.join(tree, "node_modules"), tree)).toThrow(/no src directory/u);
    let status = 0;
    try { execFileSync(process.execPath, [script, tree, broken.repo, broken.sha], { encoding: "utf8", stdio: "pipe" }); } catch (error) { status = (error as { status: number }).status; }
    expect(status).toBe(1);
    let usage = 0;
    try { execFileSync(process.execPath, [script, tree], { encoding: "utf8", stdio: "pipe" }); } catch (error) { usage = (error as { status: number }).status; }
    expect(usage).toBe(2);
  });
});
