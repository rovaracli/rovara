// SK-4 (S1): the signing job installs ONLY scripts/release/signer (its own package and lockfile) and builds scripts/release/sign-bundle.ts from the tagged commit's source. These tests keep that package
// small and the built program's imports to what the package provides. They build the file in memory and never run it (it can reach KMS).
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface Lock { packages: Record<string, { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean; link?: boolean; dev?: boolean }> }
const read = async (path: string): Promise<string> => readFile(path, "utf8");

describe("the signer package", () => {
  it("has exactly the three dependencies the signer needs, at the exact versions the repository already uses", async () => {
    const signer = JSON.parse(await read("scripts/release/signer/package.json")) as { dependencies: Record<string, string>; devDependencies?: unknown; scripts?: unknown };
    const root = JSON.parse(await read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(signer.dependencies).sort()).toEqual(["@aws-sdk/client-kms", "esbuild", "zod"]);
    // No lifecycle script of its own, and no dev dependency.
    expect(signer.scripts).toBeUndefined();
    expect(signer.devDependencies).toBeUndefined();
    const known: Record<string, string | undefined> = { ...root.dependencies, ...root.devDependencies, zod: "4.6.6" };
    for (const [name, version] of Object.entries(signer.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(version, name).toBe(known[name]);
    }
  });

  it("has a lockfile in which every package is pinned by hash from the npm registry, none is a link or a path, and only esbuild has an install script (which --ignore-scripts skips)", async () => {
    const lock = JSON.parse(await read("scripts/release/signer/package-lock.json")) as Lock;
    const entries = Object.entries(lock.packages).filter(([path]) => path !== "");
    expect(entries.length).toBeGreaterThan(10);
    for (const [path, entry] of entries) {
      expect(entry.link, path).toBeUndefined();
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(entry.integrity, path).toMatch(/^sha512-/u);
    }
    expect(entries.filter(([, entry]) => entry.hasInstallScript === true).map(([path]) => path)).toEqual(["node_modules/esbuild"]);
  });

  it("is installed with --ignore-scripts and is not part of the root workspaces", async () => {
    const root = JSON.parse(await read("package.json")) as { workspaces: string[] };
    expect(root.workspaces.every((pattern) => !pattern.includes("scripts"))).toBe(true);
    const workflow = YAML.parse(await read(".github/workflows/release.yml")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    const installs = workflow.jobs.sign!.steps.map((step) => step.run ?? "").filter((run) => run.includes("npm "));
    expect(installs).toEqual(["npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/release/signer"]);
  });
});

describe("the signer program, built the way the sign job builds it", () => {
  it("imports nothing but node built-ins, zod and the KMS client: the three packages scripts/release/signer installs", async () => {
    const workflow = YAML.parse(await read(".github/workflows/release.yml")) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    // The job builds with scripts/release/signer/build.mjs; the test builds with the same options in memory.
    expect(workflow.jobs.sign!.steps.map((step) => step.run ?? "").filter((run) => run.includes("build.mjs"))).toEqual(["node scripts/release/signer/build.mjs"]);
    const { signerBuildOptions } = await import("../../scripts/release/signer/build.mjs");
    const { outfile: _outfile, ...options } = signerBuildOptions();
    void _outfile;
    const result = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
    const text = result.outputFiles[0]!.text;
    const bare = new Set<string>();
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)) if (!match[1]!.startsWith("node:")) bare.add(match[1]!);
    expect([...bare].sort()).toEqual(["@aws-sdk/client-kms", "zod"]);
    // The source it was built from is the repository's: scripts/release, packages/cloud-contracts/src and Rovara Code's contracts source (vendor/rovara-code/packages/contracts/src), the folders the sign job checks out.
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => !input.startsWith("scripts/release/") && !input.startsWith("packages/cloud-contracts/src/") && !input.startsWith("vendor/rovara-code/packages/contracts/src/"))).toEqual([]);
    // It carries nothing that builds or exports a release.
    expect(text).not.toMatch(/bubblewrap|skopeo|synth-kit\.js|aws-cdk-lib/u);
  }, 60_000);
});
