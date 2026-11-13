import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { updateRovaraCode } from "../../scripts/vendor/update-rovara-code.js";
import { ancestryProblem, checkImports, packageOfSpecifier, trackedBuildOutput, verifyRovaraCode } from "../../scripts/vendor/verify-rovara-code.js";
import {
  CODE_DIR, INCLUDE, PIN_FILE, PUBLIC_REPO_URL, SHIMMED_PACKAGES, SHIMS_DIR, blobId, defaultLayout, diffManifests, formatPin, localManifest, manifestDigest, parsePin, planShims, type Layout,
} from "../../scripts/vendor/rovara-code-vendor.js";

// The pinned copy of public Rovara Code in vendor/rovara-code (convergence plan W0-1, owner decision 72 O1). The real tree is checked offline against the manifest in
// vendor/rovara-code/PIN. The update and verify scripts are exercised on a small fixture repository (a local git repository standing in for the public one), so
// every way a vendored file can go wrong has a case that fails, and the real public repository is read only when ROVARA_VENDOR_VERIFY_REMOTE=1 (CI's vendor step).
const REAL_ROOT = process.cwd();
const temps: string[] = [];
const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; };
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

const GIT = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
const run = (cwd: string, ...args: string[]): string => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" });

/** A stand-in for the public repository: two packages (one with subpaths and a deep folder), the root tsconfig, a licence, and one executable. */
function fixtureRepo(options: { alphaSource?: string } = {}): { url: string; sha: string; dir: string } {
  const dir = temp("vendor-fixture-repo-");
  const put = (path: string, text: string, mode?: number): void => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    if (mode !== undefined) chmodSync(join(dir, path), mode);
  };
  put("LICENSE", "fixture licence\n");
  put("tsconfig.base.json", "{}\n");
  put("packages/alpha/package.json", JSON.stringify({ name: "@agentx/alpha", version: "1.2.3", exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" } }));
  put("packages/alpha/src/index.ts", options.alphaSource ?? "export const alpha = 1;\n");
  put("packages/alpha/src/core/one/index.ts", "export const one = 1;\n");
  put("packages/alpha/src/core/two/other.ts", "export const two = 2;\n");
  put("packages/beta/package.json", JSON.stringify({ name: "@agentx/beta", version: "0.1.0", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }));
  put("packages/beta/src/index.ts", "export const beta = 1;\n");
  put("packages/beta/bin/tool.sh", "#!/bin/sh\n", 0o755);
  put("unrelated/readme.md", "not copied\n");
  run(dir, "init", "-q", "-b", "main");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "fixture");
  return { url: `file://${dir}`, sha: run(dir, "rev-parse", "HEAD").trim(), dir };
}

function fixtureLayout(url: string): { layout: Layout; root: string } {
  const root = temp("vendor-fixture-root-");
  return { root, layout: { root, include: ["LICENSE", "packages/alpha", "packages/beta", "tsconfig.base.json"], repoUrl: url, shimmed: ["alpha", "beta"], thirdPartyLinks: {}, undeclaredImports: {} } };
}

describe("the pinned copy of Rovara Code in vendor/rovara-code", () => {
  const real = defaultLayout(REAL_ROOT);

  it("matches the manifest in PIN, and its generated shims and links are current", () => {
    const result = verifyRovaraCode(real);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names a full public sha, and the include list in PIN is the one the scripts use", () => {
    const { pin, problems } = parsePin(readFileSync(join(REAL_ROOT, PIN_FILE), "utf8"));
    expect(problems).toEqual([]);
    expect(pin?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pin?.repo).toBe("https://github.com/PrepLabsAI/Rovara.git");
    expect(pin?.include).toEqual([...INCLUDE]);
    expect(pin?.files).toBeGreaterThan(1000);
  });

  it("has Cloud's workspaces, build references and lint ignores wired to it", () => {
    const rootPackage = JSON.parse(readFileSync(join(REAL_ROOT, "package.json"), "utf8")) as { workspaces: string[] };
    expect(rootPackage.workspaces).toContain(`${SHIMS_DIR}/*`);
    const tsconfig = JSON.parse(readFileSync(join(REAL_ROOT, "tsconfig.json"), "utf8")) as { references: { path: string }[] };
    const referenced = tsconfig.references.map((r) => r.path).filter((p) => p.startsWith(CODE_DIR));
    expect(referenced.sort()).toEqual(["aws-adapters", "contracts", "gateway", "local-adapters", "model-runtime", "testing", "verifier", "broker", "worker"].map((n) => `${CODE_DIR}/packages/${n}`).sort());
    const eslint = readFileSync(join(REAL_ROOT, "eslint.config.js"), "utf8");
    expect(eslint).toContain('"vendor/rovara-code/**"');
    expect(eslint).toContain('"vendor/rovara-code-shims/**"');
    const shimNames = SHIMMED_PACKAGES.map((n) => (JSON.parse(readFileSync(join(REAL_ROOT, SHIMS_DIR, n, "package.json"), "utf8")) as { name: string }).name);
    expect(shimNames).toEqual(SHIMMED_PACKAGES.map((n) => `@rovara-code/${n}`));
  });

  it("takes the repository from the scripts, never from the environment or from PIN", () => {
    const saved = process.env["ROVARA_CODE_REPO_URL"];
    process.env["ROVARA_CODE_REPO_URL"] = "file:///elsewhere";
    try {
      expect(defaultLayout(REAL_ROOT)).toMatchObject({ repoUrl: PUBLIC_REPO_URL, include: [...INCLUDE] });
    } finally {
      if (saved === undefined) delete process.env["ROVARA_CODE_REPO_URL"]; else process.env["ROVARA_CODE_REPO_URL"] = saved;
    }
  });

  it("is checked by a CI step that skips where there is no PIN (ci.yml also lives on the public repository)", () => {
    const workflow = YAML.parse(readFileSync(join(REAL_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }> };
    const step = workflow.jobs["checks"]!.steps.find((candidate) => candidate.run === "node scripts/vendor/verify-rovara-code.ts --remote");
    expect(step?.if).toBe("hashFiles('vendor/rovara-code/PIN') != ''");
  });

  it("has shims that import Code by relative path, never by a bare @agentx name", () => {
    for (const file of planShims(REAL_ROOT)) {
      if (!file.path.endsWith(".js") && !file.path.endsWith(".d.ts")) continue;
      expect(file.content, file.path).not.toMatch(/from "@agentx\//);
      expect(file.content, file.path).toMatch(/export \* from "(\.\.\/)+rovara-code\/packages\/[a-z-]+\/dist\//);
    }
  });

  it("holds Code's imports to the linked @agentx packages and the dependencies Code declares", () => {
    expect(checkImports(real)).toEqual([]);
  });

  it.skipIf(process.env["ROVARA_VENDOR_VERIFY_REMOTE"] !== "1")("is byte for byte the tree of the pinned sha in the public repository", () => {
    const result = verifyRovaraCode(real, { remote: true });
    expect(result.problems).toEqual([]);
  }, 180_000);
});

describe("the vendor scripts, on a fixture repository", () => {
  const fixture = fixtureRepo();

  function pinned(): { layout: Layout; root: string } {
    const made = fixtureLayout(fixture.url);
    updateRovaraCode(made.layout, fixture.sha);
    return made;
  }

  it("updates from a sha, writes PIN, shims and links, and then verifies offline and against the repository", () => {
    const { layout, root } = pinned();
    expect(verifyRovaraCode(layout).problems).toEqual([]);
    expect(verifyRovaraCode(layout, { remote: true }).problems).toEqual([]);
    const pin = parsePin(readFileSync(join(root, PIN_FILE), "utf8")).pin!;
    expect(pin).toMatchObject({ sha: fixture.sha, files: 9 });
    expect(readFileSync(join(root, CODE_DIR, "packages/alpha/src/index.ts"), "utf8")).toBe("export const alpha = 1;\n");
    expect(() => readFileSync(join(root, CODE_DIR, "unrelated/readme.md"))).toThrow();
    // The shims: every exports subpath, a folder under core/ that has an index.ts, and a package name in the shim scope.
    const alpha = JSON.parse(readFileSync(join(root, SHIMS_DIR, "alpha/package.json"), "utf8")) as { name: string; exports: Record<string, unknown> };
    expect(alpha.name).toBe("@rovara-code/alpha");
    expect(Object.keys(alpha.exports)).toEqual([".", "./extra"]);
    expect(readFileSync(join(root, SHIMS_DIR, "alpha/extra.js"), "utf8")).toContain('export * from "../../rovara-code/packages/alpha/dist/extra.js";');
    expect(readFileSync(join(root, SHIMS_DIR, "beta/index.d.ts"), "utf8")).toContain('export * from "../../rovara-code/packages/beta/dist/index.js";');
    expect(readFileSync(join(root, "vendor/node_modules/@agentx/beta/package.json"), "utf8")).toContain("@agentx/beta");
  });

  it("resolves a branch name to its sha", () => {
    const { layout, root } = fixtureLayout(fixture.url);
    expect(updateRovaraCode(layout, "main").sha).toBe(fixture.sha);
    expect(readFileSync(join(root, PIN_FILE), "utf8")).toContain(`sha=${fixture.sha}`);
  });

  it("refuses a short sha and an unknown branch", () => {
    const { layout } = fixtureLayout(fixture.url);
    expect(() => updateRovaraCode(layout, fixture.sha.slice(0, 8))).toThrow(/full 40-character sha/);
    expect(() => updateRovaraCode(layout, "no-such-branch")).toThrow(/no branch/);
  });

  it("fails when a vendored file is edited, even by one byte", () => {
    const { layout, root } = pinned();
    writeFileSync(join(root, CODE_DIR, "packages/alpha/src/index.ts"), "export const alpha = 2;\n");
    const result = verifyRovaraCode(layout);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/do not hash to the manifest/);
    // With --remote the file is named.
    expect(verifyRovaraCode(layout, { remote: true }).problems.join("\n")).toContain("packages/alpha/src/index.ts");
  });

  it("fails a copy made from another repository, even when PIN and the files agree with each other (the review's probe)", () => {
    // Another repository with one edited line in a vendored file, updated into a copy, then checked the way CI checks the real tree: with the scripts' own repository.
    const other = fixtureRepo({ alphaSource: "export const alpha = 666;\n" });
    const { layout, root } = fixtureLayout(other.url);
    updateRovaraCode(layout, other.sha);
    expect(verifyRovaraCode(layout).problems).toEqual([]); // it verifies against itself...
    const strict = { ...layout, repoUrl: fixture.url };
    expect(verifyRovaraCode(strict).problems.join("\n")).toContain(`PIN names the repository ${other.url}`);
    expect(verifyRovaraCode(strict, { remote: true }).ok).toBe(false);
    expect(readFileSync(join(root, CODE_DIR, "packages/alpha/src/index.ts"), "utf8")).toContain("666");
  });

  it("fails a PIN whose repository is rewritten, and one whose include list is changed", () => {
    const repo = pinned();
    const pinPath = join(repo.root, PIN_FILE);
    const good = readFileSync(pinPath, "utf8");
    writeFileSync(pinPath, good.replace(/repo=.*/, "repo=https://example.test/other.git"));
    expect(verifyRovaraCode(repo.layout).problems.join("\n")).toContain("PIN names the repository https://example.test/other.git");
    writeFileSync(pinPath, good.replace(/include=.*/, "include=LICENSE"));
    expect(verifyRovaraCode(repo.layout).problems.join("\n")).toContain("include list is not the one");
    writeFileSync(pinPath, good);
    expect(verifyRovaraCode(repo.layout).problems).toEqual([]);
  });

  it("skips build output only where tsc -b writes it, and counts the same names anywhere else", () => {
    const { layout, root } = pinned();
    const pkg = join(root, CODE_DIR, "packages/alpha");
    for (const [path, text, undo] of [["src/dist/evil.js", "x\n", "src/dist"], ["src/evil.tsbuildinfo", "{}", "src/evil.tsbuildinfo"], ["src/node_modules/x/y.js", "x\n", "src/node_modules"], ["other.tsbuildinfo", "{}", "other.tsbuildinfo"], ["dist-extra/x.js", "x\n", "dist-extra"]] as const) {
      mkdirSync(join(pkg, path, ".."), { recursive: true });
      writeFileSync(join(pkg, path), text);
      const result = verifyRovaraCode(layout);
      expect(result.ok, path).toBe(false);
      expect(result.problems.join("\n"), path).toMatch(/do not hash to the manifest/);
      rmSync(join(pkg, undo), { recursive: true, force: true });
      expect(verifyRovaraCode(layout).problems, `${path} removed`).toEqual([]);
    }
    // A package's top-level dist as a link is not build output either.
    symlinkSync("src", join(pkg, "dist"));
    expect(verifyRovaraCode(layout).ok).toBe(false);
  });

  it("fails when git tracks build output inside the copy (a force-added dist file or tsbuildinfo), though the hash skips those paths", () => {
    const { layout, root } = pinned();
    run(root, "init", "-q");
    run(root, "add", "-A");
    expect(verifyRovaraCode(layout).problems).toEqual([]);
    expect(trackedBuildOutput(layout)).toEqual([]);
    const pkg = join(root, CODE_DIR, "packages/alpha");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist/index.js"), "export const tampered = true;\n");
    writeFileSync(join(pkg, "tsconfig.tsbuildinfo"), "{}");
    mkdirSync(join(pkg, "node_modules/x"), { recursive: true });
    writeFileSync(join(pkg, "node_modules/x/index.js"), "x\n");
    // Not tracked yet: ignored by the hash, so the copy still verifies (this is build output).
    expect(verifyRovaraCode(layout).problems).toEqual([]);
    run(root, "add", "-f", "--", CODE_DIR);
    const result = verifyRovaraCode(layout);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("git tracks build output");
    expect(trackedBuildOutput(layout).sort()).toEqual([`${CODE_DIR}/packages/alpha/dist/index.js`, `${CODE_DIR}/packages/alpha/node_modules/x/index.js`, `${CODE_DIR}/packages/alpha/tsconfig.tsbuildinfo`]);
    run(root, "rm", "-q", "-r", "--cached", "--", `${CODE_DIR}/packages/alpha/dist`, `${CODE_DIR}/packages/alpha/node_modules`, `${CODE_DIR}/packages/alpha/tsconfig.tsbuildinfo`);
    expect(verifyRovaraCode(layout).problems).toEqual([]);
  });

  it("fails when Code's source imports an @agentx package that is not linked, or a package it does not declare", () => {
    const { layout, root } = pinned();
    const source = join(root, CODE_DIR, "packages/alpha/src/index.ts");
    const original = readFileSync(source, "utf8");
    const imports = (text: string): string[] => { writeFileSync(source, `${original}${text}`); return checkImports(layout); };
    expect(imports('import { x } from "@agentx/orchestrator";\n').join("\n")).toContain("alpha imports @agentx/orchestrator (src/index.ts), which is not one of the vendored packages");
    expect(imports('export * from "left-pad/lib";\n').join("\n")).toContain("imports left-pad");
    expect(imports('const m = await import("@scope/dyn");\n').join("\n")).toContain("imports @scope/dyn");
    expect(imports('const r = require("leftpad2");\n').join("\n")).toContain("imports leftpad2");
    // Fine: the linked packages, node's own modules, relative paths, comments, strings and method calls that only look like imports.
    expect(imports('import { b } from "@agentx/beta";\nimport fs from "node:fs";\nimport path from "path";\nimport "./side.js";\nconst names = ["--import", "tsx"];\nregistry.require("storage");\n// import x from "commented"\n/* export * from "block" */\n')).toEqual([]);
    writeFileSync(join(root, CODE_DIR, "packages/alpha/package.json"), JSON.stringify({ name: "@agentx/alpha", version: "1.2.3", exports: { ".": "./dist/index.js" }, dependencies: { "left-pad": "1.0.0" } }));
    expect(imports('import pad from "left-pad";\n')).toEqual([]);
    // The tolerated list is per package, and stays visible.
    expect(checkImports({ ...layout, undeclaredImports: { alpha: ["leftpad2"] } }).join("\n")).not.toContain("leftpad2");
  });

  it("generates shims that fail to load once copied out of the vendor layout", async () => {
    const { root } = pinned();
    const copied = temp("vendor-shim-copy-");
    const dir = join(copied, "node_modules/@rovara-code/alpha");
    cpSync(join(root, SHIMS_DIR, "alpha"), dir, { recursive: true });
    await expect(import(/* @vite-ignore */ join(dir, "index.js"))).rejects.toThrow();
  });

  it("fails when a file is added or removed", () => {
    const added = pinned();
    writeFileSync(join(added.root, CODE_DIR, "packages/alpha/src/new.ts"), "export {};\n");
    expect(verifyRovaraCode(added.layout).ok).toBe(false);
    expect(verifyRovaraCode(added.layout, { remote: true }).problems.join("\n")).toContain("not in the public tree: packages/alpha/src/new.ts");
    const removed = pinned();
    rmSync(join(removed.root, CODE_DIR, "LICENSE"));
    expect(verifyRovaraCode(removed.layout, { remote: true }).problems.join("\n")).toContain("missing from the copy: LICENSE");
  });

  it("fails when a file's executable bit changes, and when a file becomes a link", () => {
    const mode = pinned();
    chmodSync(join(mode.root, CODE_DIR, "packages/beta/bin/tool.sh"), 0o644);
    expect(verifyRovaraCode(mode.layout).ok).toBe(false);
    const link = pinned();
    rmSync(join(link.root, CODE_DIR, "LICENSE"));
    symlinkSync("tsconfig.base.json", join(link.root, CODE_DIR, "LICENSE"));
    expect(verifyRovaraCode(link.layout).ok).toBe(false);
  });

  it("ignores build output (dist, node_modules, *.tsbuildinfo) inside the packages, and nothing else", () => {
    const { layout, root } = pinned();
    mkdirSync(join(root, CODE_DIR, "packages/alpha/dist"), { recursive: true });
    writeFileSync(join(root, CODE_DIR, "packages/alpha/dist/index.js"), "built\n");
    mkdirSync(join(root, CODE_DIR, "packages/alpha/node_modules/x"), { recursive: true });
    writeFileSync(join(root, CODE_DIR, "packages/alpha/tsconfig.tsbuildinfo"), "{}");
    expect(verifyRovaraCode(layout).problems).toEqual([]);
    mkdirSync(join(root, CODE_DIR, "dist"), { recursive: true });
    writeFileSync(join(root, CODE_DIR, "dist/stray.js"), "x\n");
    expect(verifyRovaraCode(layout).ok).toBe(false);
  });

  it("fails when PIN is missing, malformed or points at another sha", () => {
    const { layout, root } = pinned();
    const pinPath = join(root, PIN_FILE);
    const good = readFileSync(pinPath, "utf8");
    writeFileSync(pinPath, good.replace(/sha=[0-9a-f]{40}/, "sha=abc"));
    expect(verifyRovaraCode(layout).problems.join("\n")).toMatch(/40-character/);
    writeFileSync(pinPath, good.replace(/sha=[0-9a-f]{40}/, `sha=${"1".repeat(40)}`));
    expect(verifyRovaraCode(layout, { remote: true }).ok).toBe(false);
    writeFileSync(pinPath, good.replace(/manifest-sha256=[0-9a-f]{64}/, `manifest-sha256=${"0".repeat(64)}`));
    expect(verifyRovaraCode(layout).ok).toBe(false);
    rmSync(pinPath);
    expect(verifyRovaraCode(layout).problems).toEqual([`${PIN_FILE} is missing`]);
  });

  it("fails when a generated shim or link is stale", () => {
    const shim = pinned();
    writeFileSync(join(shim.root, SHIMS_DIR, "alpha/index.js"), "export const hacked = 1;\n");
    expect(verifyRovaraCode(shim.layout).problems.join("\n")).toContain("alpha/index.js is missing or stale");
    const link = pinned();
    rmSync(join(link.root, "vendor/node_modules/@agentx/alpha"));
    symlinkSync("../../elsewhere", join(link.root, "vendor/node_modules/@agentx/alpha"));
    expect(verifyRovaraCode(link.layout).problems.join("\n")).toContain("links are missing or stale");
  });

  it("reports a Code dependency that resolves to another version", () => {
    const { layout, root } = pinned();
    writeFileSync(join(root, CODE_DIR, "packages/alpha/package.json"), JSON.stringify({ name: "@agentx/alpha", version: "1.2.3", exports: { ".": "./dist/index.js" }, dependencies: { dep: "2.0.0" } }));
    mkdirSync(join(root, "node_modules/dep"), { recursive: true });
    writeFileSync(join(root, "node_modules/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
    // The edit also trips the hash, which is expected; the version drift is reported next to it.
    expect(verifyRovaraCode(layout).problems.join("\n")).toContain("wants dep@2.0.0 but it resolves to 1.0.0");
  });

  it("does not replace the copy when the include list matches nothing", () => {
    const { layout, root } = pinned();
    const before = readFileSync(join(root, PIN_FILE), "utf8");
    expect(() => updateRovaraCode({ ...layout, include: ["no-such-path"] }, fixture.sha)).toThrow();
    expect(readFileSync(join(root, PIN_FILE), "utf8")).toBe(before);
  });
});

describe("the manifest helpers", () => {
  it("name the package of an import specifier", () => {
    expect(["@agentx/contracts", "@agentx/model-runtime/catalog", "zod", "zod/v4", "node:fs", "fs", "./x.js", "../y", "/abs"].map(packageOfSpecifier)).toEqual(["@agentx/contracts", "@agentx/model-runtime", "zod", "zod", undefined, undefined, undefined, undefined, undefined]);
  });

  it("hash a blob the way git does", () => {
    expect(blobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(blobId(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("digest the same files to the same value in any order, and a changed mode or id to another", () => {
    const a = { mode: "100644", oid: blobId(Buffer.from("a")), path: "a" };
    const b = { mode: "100644", oid: blobId(Buffer.from("b")), path: "b" };
    expect(manifestDigest([a, b])).toBe(manifestDigest([b, a]));
    expect(manifestDigest([a, b])).not.toBe(manifestDigest([a, { ...b, mode: "100755" }]));
    expect(manifestDigest([a, b])).not.toBe(manifestDigest([a, { ...b, oid: a.oid }]));
    expect(diffManifests([a, b], [a, { ...b, mode: "100755" }])).toEqual({ missing: [], extra: [], changed: ["b"] });
  });

  it("round-trip a PIN and refuse a duplicate or missing field", () => {
    const pin = { repo: "https://example.test/r.git", sha: "a".repeat(40), branch: "code/next", include: ["x", "y"], files: 3, manifestSha256: "b".repeat(64) };
    expect(parsePin(formatPin(pin)).pin).toEqual(pin);
    expect(parsePin(`${formatPin(pin)}sha=${"c".repeat(40)}\n`).problems.join()).toContain("repeats sha");
    expect(parsePin("# nothing\n").pin).toBeUndefined();
  });

  it("build a manifest of a tree that skips PIN only when asked", () => {
    const dir = temp("vendor-manifest-");
    writeFileSync(join(dir, "PIN"), "x\n");
    writeFileSync(join(dir, "f"), "y\n");
    expect(localManifest(dir).entries.map((e) => e.path)).toEqual(["PIN", "f"]);
    expect(localManifest(dir, new Set(["PIN"])).entries.map((e) => e.path)).toEqual(["f"]);
    mkdirSync(join(dir, "copy"));
    cpSync(join(dir, "f"), join(dir, "copy/PIN"));
    expect(localManifest(dir, new Set(["PIN"])).entries.map((e) => e.path)).toEqual(["copy/PIN", "f"]);
  });

  it("plan a shim for every package it is given, from the vendored package.json files", () => {
    const planned = planShims(REAL_ROOT);
    expect(new Set(planned.filter((f) => f.path.endsWith("package.json")).map((f) => f.path.split("/")[0]))).toEqual(new Set(SHIMMED_PACKAGES));
    expect(planned.map((f) => f.path)).toContain("broker/core/cost.js");
    expect(planned.map((f) => f.path)).toContain("model-runtime/catalog.d.ts");
  });
});

describe("the pinned sha is on code/next (W0-3 review L4)", () => {
  const sha = "d".repeat(40);
  it("accepts code/next itself and an ancestor of it", () => {
    expect(ancestryProblem(sha, "identical")).toBeUndefined();
    expect(ancestryProblem(sha, "ahead")).toBeUndefined();
  });
  it("refuses a commit that is not behind code/next, and an answer it could not get", () => {
    expect(ancestryProblem(sha, "diverged")).toContain("not an ancestor of code/next");
    expect(ancestryProblem(sha, "behind")).toContain("not an ancestor of code/next");
    expect(ancestryProblem(sha, undefined)).toContain("could not ask GitHub");
  });
});
