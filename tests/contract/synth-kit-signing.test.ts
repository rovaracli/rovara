// SK-4 (the signing step refuses a kit that is not exactly what release:kit made): kit.json names the hash of every other file; bundle.ts refuses a kit with a file kit.json does not list, a file whose bytes
// are not the listed ones (edited after release:kit, or while it was copied), or a missing one; and it runs the kit's checks again, on the copy it is about to sign. The release build and the kit step take
// the checkout as it is only when it is a clean commit with no ignored file that changes what is built and no build output older than its source (build.ts:374).
import { execFileSync } from "node:child_process";
import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SynthKitManifestSchema, sha256OfBytes } from "@agentx/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "../../scripts/release/bundle.js";
import { assertBuildIsClean, assertSourceIsRelease, gitSourceState, isExpectedIgnoredPath, releaseCommitOfCleanTree, type SourceState } from "../../scripts/release/source-state.js";
import { kitFileHashes, verifyKitForSigning } from "../../scripts/release/synth-kit.js";
import { IMAGES, NO_KIT_CHECK, fakeExporter, newTestKey, writeRelease } from "../support/bundle-fixture.js";
import { writeFakeKit } from "../support/synth-kit-fixture.js";

let root: string;
let releaseDir: string;
let releaseSha: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "kit-signing-")));
  releaseDir = join(root, "release");
  await mkdir(releaseDir);
  await writeRelease(releaseDir);
  releaseSha = sha256OfBytes(await readFile(join(releaseDir, "release.json")));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

let counter = 0;
/** A fake kit made for the test release; `change` edits it afterwards (as someone with the folder could). */
async function kitDir(change: (dir: string) => Promise<void> = async () => undefined): Promise<string> {
  const dir = join(root, `kit-${String(counter += 1)}`);
  await writeFakeKit(dir, { releaseSha256: releaseSha });
  await change(dir);
  return dir;
}
const sign = (dir: string, extra: Partial<Parameters<typeof buildBundle>[0]> = {}) =>
  buildBundle({ releaseDir, out: join(root, `out-${String(counter += 1)}`), images: IMAGES, exportImage: fakeExporter, signer: newTestKey().signer, synthKitDir: dir, kitCheck: NO_KIT_CHECK, ...extra });

describe("kit.json names every file of the kit", () => {
  it("the manifest lists the entry and holds nothing else it was not given: the schema wants the hash of the entry and only the paths a kit holds", () => {
    const base = { schemaVersion: 1, format: "rovara-synth-kit", entry: "synth-kit/synth.mjs", nodeMajor: 22, releaseSha256: "a".repeat(64), gitCommit: "b".repeat(40) };
    const hash = "c".repeat(64);
    expect(SynthKitManifestSchema.safeParse({ ...base, files: { "synth.mjs": hash, "code-map.json": hash, [`code/${"d".repeat(64)}.zip`]: hash } }).success).toBe(true);
    expect(SynthKitManifestSchema.safeParse(base).success, "no files").toBe(false);
    expect(SynthKitManifestSchema.safeParse({ ...base, files: {} }).success, "the entry has no hash").toBe(false);
    for (const path of ["kit.json", "evil.sh", "../synth.mjs", "code/x.zip", "other/synth.mjs", "code-map.json.bak"]) {
      expect(SynthKitManifestSchema.safeParse({ ...base, files: { "synth.mjs": hash, [path]: hash } }).success, path).toBe(false);
    }
    expect(SynthKitManifestSchema.safeParse({ ...base, files: { "synth.mjs": "short" } }).success, "a hash").toBe(false);
  });

  it("kitFileHashes is the SHA-256 of every file but kit.json", async () => {
    const dir = await kitDir(async (d) => { await mkdir(join(d, "code"), { recursive: true }); await writeFile(join(d, "code", `${"e".repeat(64)}.zip`), "zip"); });
    const hashes = await kitFileHashes(dir);
    expect(Object.keys(hashes).sort()).toEqual([`code/${"e".repeat(64)}.zip`, "synth.mjs"]);
    expect(hashes["synth.mjs"]).toBe(sha256OfBytes(await readFile(join(dir, "synth.mjs"))));
  });
});

describe("the signing step refuses a kit that is not what release:kit made", () => {
  it("signs a kit that is exactly what kit.json lists (positive control), and carries it into the bundle", async () => {
    const result = await sign(await kitDir());
    expect(result.manifest.files.filter((file) => file.kind === "synth-kit").map((file) => file.file)).toEqual(["synth-kit/kit.json", "synth-kit/synth.mjs"]);
  });

  it("refuses a file kit.json does not list (a stray file, or a second module), and writes nothing", async () => {
    for (const [name, add] of [["a stray script", "evil.mjs"], ["a code package nobody listed", `code/${"f".repeat(64)}.zip`]] as const) {
      const dir = await kitDir(async (d) => { await mkdir(join(d, "code"), { recursive: true }); await writeFile(join(d, add), "x"); });
      const out = join(root, `out-stray-${String(counter += 1)}`);
      await expect(sign(dir, { out }), name).rejects.toThrow(/does not list/);
      expect(existsSync(out), name).toBe(false);
    }
  });

  it("refuses a kit module edited after release:kit made it, and one that was swapped for a different one, and writes nothing", async () => {
    const edited = await kitDir(async (d) => { await writeFile(join(d, "synth.mjs"), `${await readFile(join(d, "synth.mjs"), "utf8")}\n// edited after the checks\n`); });
    const out = join(root, "out-edited");
    await expect(sign(edited, { out })).rejects.toThrow(/synth\.mjs is not what kit\.json lists/);
    expect(existsSync(out)).toBe(false);
    const handWritten = await kitDir(async (d) => { await writeFile(join(d, "synth.mjs"), "export {};\n"); });
    await expect(sign(handWritten)).rejects.toThrow(/not what kit\.json lists/);
  });

  it("refuses a kit with a listed file missing, and a kit.json with no hashes (one written by hand or by an older release:kit)", async () => {
    const missing = await kitDir(async (d) => {
      const kit = JSON.parse(await readFile(join(d, "kit.json"), "utf8")) as { files: Record<string, string> };
      kit.files[`code/${"a".repeat(64)}.zip`] = "a".repeat(64);
      await writeFile(join(d, "kit.json"), JSON.stringify(kit));
    });
    await expect(sign(missing)).rejects.toThrow(/missing a file kit\.json lists/);
    const noHashes = await kitDir(async (d) => {
      const { files: _files, ...rest } = JSON.parse(await readFile(join(d, "kit.json"), "utf8")) as { files: unknown };
      void _files;
      await writeFile(join(d, "kit.json"), JSON.stringify(rest));
    });
    await expect(sign(noHashes)).rejects.toThrow();
  });

  it("checks the hashes on the bytes that were copied, not the ones it listed first: a file changed while the kit is being copied is refused", async () => {
    const dir = await kitDir();
    const kit = JSON.parse(await readFile(join(dir, "kit.json"), "utf8")) as { files: Record<string, string> };
    // kit.json lists the hash of a module that is not the one in the folder (the situation after a swap that happened between the listing and the copy).
    kit.files["synth.mjs"] = sha256OfBytes(Buffer.from("something else"));
    await writeFile(join(dir, "kit.json"), JSON.stringify(kit));
    await expect(sign(dir)).rejects.toThrow(/not what kit\.json lists/);
  });
});

describe("the signing step runs the kit's checks again, on the copy it signs", () => {
  it("runs the check once, on a copy inside the output folder that holds the files being signed, before anything is signed", async () => {
    const dir = await kitDir();
    const seen: Array<{ kitRoot: string; files: string[] }> = [];
    await sign(dir, { kitCheck: async ({ kitRoot }) => { seen.push({ kitRoot, files: [(await readFile(join(kitRoot, "synth.mjs"), "utf8")).length > 0 ? "synth.mjs" : ""] }); } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kitRoot).not.toBe(dir);
    expect(seen[0]!.kitRoot.endsWith("/synth-kit")).toBe(true);
  });

  it("a failing check stops the signing and removes the output folder: nothing is left to be mistaken for a bundle", async () => {
    const out = join(root, "out-check-fails");
    await expect(sign(await kitDir(), { out, kitCheck: async () => { throw new Error("the kit's Enterprise template differs from a build from source"); } })).rejects.toThrow(/differs from a build from source/);
    expect(existsSync(out)).toBe(false);
  });

  it("without a check of its own, the bundle step runs the real one, which wants the release's commit checked out and a clean tree: this checkout is not the fake release's commit", async () => {
    const out = join(root, "out-default-check");
    await expect(buildBundle({ releaseDir, out, images: IMAGES, exportImage: fakeExporter, signer: newTestKey().signer, synthKitDir: await kitDir() })).rejects.toThrow(/working tree is at|changed file|sandbox/);
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it("verifyKitForSigning refuses a checkout that is not the release's commit before it runs anything", async () => {
    const state: SourceState = { head: () => "c".repeat(40), dirtyFiles: () => [] };
    await expect(verifyKitForSigning({ kitRoot: await kitDir(), releaseDir, release: { gitCommit: "d".repeat(40) } as never, source: state })).rejects.toThrow(/working tree is at/);
  });
});

describe("the checkout a release and its kit are built from (build.ts, synth-kit.ts)", () => {
  const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repo, encoding: "utf8" });
  /** A repository with a package that has a source file and a built (gitignored) dist, as a built checkout has. */
  async function builtRepo(): Promise<{ repo: string; head: string }> {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "kit-tree-")));
    git(repo, "init", "-q");
    await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n*.tsbuildinfo\n.env\nlocal-override.ts\n");
    await mkdir(join(repo, "packages", "a", "src"), { recursive: true });
    await mkdir(join(repo, "packages", "a", "dist"), { recursive: true });
    await writeFile(join(repo, "packages", "a", "src", "index.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, "packages", "a", "src", "index.ts"), past, past);
    await writeFile(join(repo, "packages", "a", "dist", "index.js"), "export const a = 1;\n");
    return { repo, head: git(repo, "rev-parse", "HEAD").trim() };
  }

  it("a built, clean checkout of the commit passes (positive control), and the release build takes its commit from it", async () => {
    const { repo, head } = await builtRepo();
    try {
      const state = gitSourceState(repo);
      expect(() => assertSourceIsRelease(state, { gitCommit: head })).not.toThrow();
      expect(releaseCommitOfCleanTree(state)).toBe(head);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("the release build refuses what the kit step already refuses: a changed file, an untracked file", async () => {
    const { repo } = await builtRepo();
    try {
      await writeFile(join(repo, "packages", "a", "src", "index.ts"), "export const a = 2;\n");
      expect(() => releaseCommitOfCleanTree(gitSourceState(repo))).toThrow(/changed file/);
      git(repo, "checkout", "--", "packages/a/src/index.ts");
      await writeFile(join(repo, "extra.ts"), "x");
      expect(() => releaseCommitOfCleanTree(gitSourceState(repo))).toThrow(/changed file/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("an ignored file that is not build output is refused (it changes what is built and is in no commit), and so is a dist older than its source", async () => {
    const { repo, head } = await builtRepo();
    try {
      await writeFile(join(repo, "local-override.ts"), "export {};\n");
      expect(() => assertSourceIsRelease(gitSourceState(repo), { gitCommit: head })).toThrow(/ignored file/);
      expect(() => releaseCommitOfCleanTree(gitSourceState(repo))).toThrow(/ignored file/);
      await rm(join(repo, "local-override.ts"));
      expect(() => releaseCommitOfCleanTree(gitSourceState(repo))).not.toThrow();
      // The source is newer than what was built from it (another commit was checked out since the build): the dist is the old source's.
      const future = new Date(Date.now() + 120_000);
      utimesSync(join(repo, "packages", "a", "src", "index.ts"), future, future);
      expect(() => assertSourceIsRelease(gitSourceState(repo), { gitCommit: head })).toThrow(/older than its source/);
      expect(() => releaseCommitOfCleanTree(gitSourceState(repo))).toThrow(/packages\/a\/dist\/.* older than its source|older than its source/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("the release build command stops on a dirty checkout, before it builds anything (build.ts takes its commit from a clean tree)", async () => {
    const { repo } = await builtRepo();
    try {
      await writeFile(join(repo, "packages", "a", "src", "index.ts"), "export const a = 2;\n");
      const script = join(process.cwd(), "scripts", "release", "build.ts");
      const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      let output = "";
      try {
        execFileSync(process.execPath, [tsx, script, "--version", "9.9.9", "--out", join(repo, "release-out")], { cwd: repo, encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        output = String((error as { stderr?: string }).stderr);
      }
      expect(output).toMatch(/agentx release build failed: the working tree has 1 changed file/);
      expect(existsSync(join(repo, "release-out"))).toBe(false);
    } finally { await rm(repo, { recursive: true, force: true }); }
  }, 120_000);

  it("a package with no build output at all is refused too, and the expected ignored paths are named", () => {
    expect(() => assertBuildIsClean({ head: () => "x", dirtyFiles: () => [], staleBuildOutputs: () => ["packages/a/dist/"] })).toThrow(/older than its source/);
    expect(() => assertBuildIsClean({ head: () => "x", dirtyFiles: () => [], unexpectedIgnoredFiles: () => [".env.local"] })).toThrow(/ignored file/);
    expect(() => assertBuildIsClean({ head: () => "x", dirtyFiles: () => [] })).not.toThrow();
    for (const path of ["node_modules/", "packages/contracts/dist/", "packages/web/tsconfig.tsbuildinfo", ".release-synth/", "infra/cdk.out/", "docs/notes.md", ".agentx/state"]) expect(isExpectedIgnoredPath(path), path).toBe(true);
    for (const path of ["packages/broker/src/local-override.ts", ".env", "scripts/release/hook.mjs", "infra/lib/local.ts"]) expect(isExpectedIgnoredPath(path), path).toBe(false);
  });
});
