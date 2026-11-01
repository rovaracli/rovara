// Enterprise upgrades are built AT APPROVAL (owner decision 2026-10-31, option A): the customer's `bundle approve` runs the release's own pinned CDK app with the install's own settings.
// This is the release step that makes that app, the "synthesis kit" a signed bundle carries under synth-kit/:
//
//   kit.json          the manifest (schema SynthKitManifestSchema)
//   synth.mjs         the CDK app (infra/lib/app.ts, aws-cdk-lib inside) bundled by esbuild, run as `node synth.mjs <context.json> <out dir>`
//   code-map.json     each Lambda function (construct path) and the id of the code package it runs
//   code/<id>.zip     those packages: the release's own zips, copied in
//
// Lambda code is edition- and settings-independent, and there is no source at approval, so `aws-cdk-lib/aws-lambda-nodejs` is replaced in the bundle by synth-kit/prebuilt-code.ts, which
// takes each function's code from the map and never builds anything. A function the map does not name stops the build; a package the release does not list stops this step.
//
// Before it returns, the step runs the finished kit the way approval will (in the same sandbox where the computer has one) and requires: (1) the same context twice, in two different
// directories, gives byte-identical output (the same inputs are the same hash); (2) the release's own placeholder context gives the release's own templates and packages.
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENVIRONMENT_PLACEHOLDER, SynthKitManifestSchema, canonicalJson, type SynthKitManifest } from "@agentx/contracts";
import { build, type Plugin } from "esbuild";
import { SUPPORTED_REGIONS } from "../../infra/lib/production-foundation.js";
import { createNodeSynthRunner, runKitProcess, type SynthRunner } from "../../packages/cli/src/upgrade/bundle/synth-run.js";
import { RELEASE_SYNTH_ROOT, synthReleaseProfile, type FunctionCode } from "./build.js";
import { sha256Hex } from "./hash.js";
import { ReleaseManifestSchema, type ReleaseManifest } from "./manifest.js";
import { enterpriseReleaseProfiles } from "./profiles.js";
import { CodeMapSchema, KIT_CODE_MAP_FILE, kitCodeFile } from "./synth-kit/code-map.js";

/** The Node major a kit is built for and run on: the one `engines` names for the CLI. */
export const SYNTH_KIT_NODE_MAJOR = 22;
const KIT_DIR = join(import.meta.dirname, "synth-kit");
const KIT_ENTRY_SOURCE = join(KIT_DIR, "entry.ts");
const PREBUILT_CODE_SOURCE = join(KIT_DIR, "prebuilt-code.ts");
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Lets a bundled CommonJS dependency (aws-cdk-lib) run inside an ES module. */
const ESM_BANNER = [
  'import { createRequire as __kitCreateRequire } from "node:module";',
  'import { fileURLToPath as __kitFileURLToPath } from "node:url";',
  'import { dirname as __kitDirname } from "node:path";',
  "const require = __kitCreateRequire(import.meta.url);",
  "const __filename = __kitFileURLToPath(import.meta.url);",
  "const __dirname = __kitDirname(__filename);",
].join("\n");

/** Replaces aws-cdk-lib's own `aws-lambda-nodejs` (reached as `aws-cdk-lib/aws-lambda-nodejs` and from aws-cdk-lib/index.js as `./aws-lambda-nodejs`) with the prebuilt-code stand-in. */
function prebuiltLambdaCode(): Plugin {
  return {
    name: "rovara-prebuilt-lambda-code",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^(aws-cdk-lib\/aws-lambda-nodejs|\.\/aws-lambda-nodejs)$/ }, (args) => {
        const fromCdkIndex = args.path === "./aws-lambda-nodejs" && /[\\/]node_modules[\\/]aws-cdk-lib[\\/]index\.js$/.test(args.importer);
        return args.path === "aws-cdk-lib/aws-lambda-nodejs" || fromCdkIndex ? { path: PREBUILT_CODE_SOURCE } : undefined;
      });
    },
  };
}

/** Bundles the kit's entry into one ES module. Refuses a bundle that still holds CDK's own source bundler: no path may build Lambda code. */
export async function bundleKitEntry(outfile: string): Promise<{ bytes: number }> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [KIT_ENTRY_SOURCE],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    sourcemap: false,
    metafile: true,
    logLevel: "error",
    banner: { js: ESM_BANNER },
    plugins: [prebuiltLambdaCode()],
  });
  const inputs = Object.keys(result.metafile.inputs);
  const sourceBundler = inputs.filter((input) => /aws-cdk-lib[\\/]aws-lambda-nodejs[\\/]/.test(input));
  if (sourceBundler.length > 0) throw new Error(`the kit still holds aws-cdk-lib's source bundler (${sourceBundler[0] ?? ""}); every NodejsFunction must take its code from the code map`);
  if (!inputs.some((input) => input.endsWith("prebuilt-code.ts"))) throw new Error("the kit does not hold the prebuilt-code stand-in");
  return { bytes: Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0) };
}

/** Adds one profile's functions to the map; a function that runs different code in two profiles stops the step (Lambda code must not depend on the edition or the settings). */
export function mergeFunctionCode(found: Map<string, string>, functions: readonly FunctionCode[], profileName: string): void {
  for (const fn of functions) {
    const earlier = found.get(fn.path);
    if (earlier !== undefined && earlier !== fn.assetId) throw new Error(`the function ${fn.path} runs different code in profile ${profileName} than in another; Lambda code must not depend on the edition or the settings`);
    found.set(fn.path, fn.assetId);
  }
}

/** The code map of a release: every Lambda function of the placeholder (Public) app and of each Enterprise profile, with the package it runs. A function two builds disagree about stops the step. */
export async function collectCodeMap(): Promise<FunctionCode[]> {
  const [region] = SUPPORTED_REGIONS;
  if (region === undefined) throw new Error("no supported region");
  await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
  const found = new Map<string, string>();
  const synthDirs: string[] = [];
  try {
    const contexts: Array<{ name: string; context: Record<string, string> }> = [{ name: "public", context: {} }, ...enterpriseReleaseProfiles().map((profile) => ({ name: profile.name, context: { ...profile.context } }))];
    for (const profile of contexts) {
      const outdir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
      synthDirs.push(outdir);
      const { functions } = synthReleaseProfile({ context: { ...profile.context, agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxRegion: region }, outdir });
      mergeFunctionCode(found, functions, profile.name);
    }
  } finally {
    await Promise.all(synthDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
  return [...found].map(([path, assetId]) => ({ path, assetId })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The sandboxed runner approval uses where this computer has a sandbox; otherwise the same process start without one (this is our own freshly built kit, checked on our own machine). */
export function releaseCheckRunner(): { runner: SynthRunner; sandboxed: boolean } {
  const real = createNodeSynthRunner();
  if (real.sandbox !== "none") return { runner: real, sandboxed: true };
  return { runner: { confined: false, sandbox: "none (release check, no sandbox on this computer)", run: (input) => runKitProcess(input, undefined) }, sandboxed: false };
}

/** Every file under `root`, relative and "/"-separated, sorted. */
async function listFiles(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(root, path)));
    else found.push(path);
  }
  return found;
}

/** The first difference between two output trees, or undefined when they hold the same files with the same bytes. */
export async function firstTreeDifference(a: string, b: string): Promise<string | undefined> {
  const [filesA, filesB] = [await listFiles(a), await listFiles(b)];
  if (filesA.join("\n") !== filesB.join("\n")) return `different files (${filesA.length} against ${filesB.length})`;
  for (const file of filesA) {
    const [bytesA, bytesB] = [await readFile(join(a, file)), await readFile(join(b, file))];
    if (!bytesA.equals(bytesB)) return `${file} differs`;
  }
  return undefined;
}

/** Runs the kit once for `context` in a fresh work and output directory under `parent`, and returns the output directory. */
async function runKit(input: { runner: SynthRunner; kitRoot: string; context: Record<string, string>; parent: string }): Promise<string> {
  const workDir = join(input.parent, "work");
  const outDir = join(input.parent, "out");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(outDir, "templates"), { recursive: true, mode: 0o700 });
  await mkdir(join(outDir, "packages"), { recursive: true, mode: 0o700 });
  const contextFile = join(workDir, "context.json");
  await writeFile(contextFile, canonicalJson({ context: input.context }), { mode: 0o400 });
  await input.runner.run({ entry: join(input.kitRoot, "synth.mjs"), kitDir: input.kitRoot, contextFile, outDir, workDir });
  return outDir;
}

export interface BuildSynthKitInput {
  /** A release directory made by `release:build`, of this source tree. */
  releaseDir: string;
  /** Must be absent or empty. */
  out: string;
  /** Runs the finished kit for the self-checks. Defaults to the sandbox approval uses (see releaseCheckRunner). */
  runner?: SynthRunner;
}
export interface BuildSynthKitResult {
  manifest: SynthKitManifest;
  functions: number;
  packages: number;
  entryBytes: number;
  /** Whether the self-checks ran inside the operating system sandbox. */
  sandboxed: boolean;
}

export async function buildSynthKit(input: BuildSynthKitInput): Promise<BuildSynthKitResult> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== SYNTH_KIT_NODE_MAJOR) throw new Error(`the synthesis kit is built on Node ${String(SYNTH_KIT_NODE_MAJOR)} (this is Node ${String(nodeMajor)}): it is run by an agentx on that version`);
  const releaseDir = resolve(input.releaseDir);
  const out = resolve(input.out);
  const release: ReleaseManifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")));
  const listed = new Map([...release.packages, ...(release.enterprisePackages ?? [])].map((pkg) => [pkg.assetId, pkg]));

  // The functions and their code, from this source tree; every package must be one the release lists, with the bytes the release lists.
  const functions = await collectCodeMap();
  const used = new Set<string>();
  for (const fn of functions) {
    const pkg = listed.get(fn.assetId);
    if (pkg === undefined) throw new Error(`the function ${fn.path} runs code package ${fn.assetId.slice(0, 16)}, which the release at ${releaseDir} does not list (is the release from this source tree? does the release's package list cover every Enterprise stack?)`);
    if (sha256Hex(await readFile(join(releaseDir, pkg.file))) !== pkg.sha256) throw new Error(`release file ${pkg.file} does not match release.json`);
    used.add(fn.assetId);
  }

  try {
    if ((await readdir(out)).length > 0) throw new Error(`synthesis kit output directory is not empty: ${out}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(out, "code"), { recursive: true });
  try {
    for (const assetId of [...used].sort()) await copyFile(join(releaseDir, listed.get(assetId)!.file), join(out, kitCodeFile(assetId)));
    await writeFile(join(out, KIT_CODE_MAP_FILE), `${JSON.stringify(CodeMapSchema.parse({ schemaVersion: 1, functions }), null, 2)}\n`, "utf8");
    const { bytes } = await bundleKitEntry(join(out, "synth.mjs"));
    const manifest = SynthKitManifestSchema.parse({ schemaVersion: 1, format: "rovara-synth-kit", entry: "synth-kit/synth.mjs", nodeMajor: SYNTH_KIT_NODE_MAJOR });
    await writeFile(join(out, "kit.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const sandboxed = await selfCheck({ kitRoot: out, release, releaseDir, runner: input.runner });
    return { manifest, functions: functions.length, packages: used.size, entryBytes: bytes, sandboxed };
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}

/** The two checks every kit passes before the release ships it. Returns whether they ran inside the sandbox. */
export async function selfCheck(input: { kitRoot: string; release: ReleaseManifest; releaseDir: string; runner?: SynthRunner | undefined }): Promise<boolean> {
  const { runner, sandboxed } = input.runner === undefined ? releaseCheckRunner() : { runner: input.runner, sandboxed: input.runner.sandbox !== "none" };
  const [region] = SUPPORTED_REGIONS;
  if (region === undefined) throw new Error("no supported region");
  // Real paths: the permission model compares the paths a kit opens (resolved) with the ones it was allowed, and a temp directory may sit behind a link (macOS /var).
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "synth-kit-check-")));
  const kitRoot = await realpath(input.kitRoot);
  try {
    // (1) The same inputs are the same bytes, wherever the kit runs: two runs in directories of different depth and name.
    const installContext = { agentxEnv: "kitcheck", agentxRegion: region, agentxSynthesizer: "legacy" };
    for (const profile of enterpriseReleaseProfiles()) {
      const context = { ...profile.context, ...installContext };
      const first = await runKit({ runner, kitRoot, context, parent: join(scratch, `a-${profile.name}`) });
      const second = await runKit({ runner, kitRoot, context, parent: join(scratch, "much", "deeper", `b-${profile.name}`) });
      const difference = await firstTreeDifference(first, second);
      if (difference !== undefined) throw new Error(`the kit is not deterministic (${profile.name}): two runs gave different output (${difference})`);
    }
    // (2) The release's own context gives the release's own templates and code packages, in every region the release covers: the stand-in for the source bundler changes nothing the
    // templates say.
    for (const releaseRegion of [...new Set(input.release.templates.map((template) => template.region))].sort()) {
      const publicOut = await runKit({ runner, kitRoot, context: { agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxRegion: releaseRegion, agentxSynthesizer: "legacy" }, parent: join(scratch, `public-${releaseRegion}`) });
      for (const entry of input.release.templates.filter((template) => template.region === releaseRegion)) {
        const kitText = await readFile(join(publicOut, "templates", `${entry.part}.template.json`), "utf8").catch(() => undefined);
        if (kitText === undefined) throw new Error(`the kit made no ${entry.part} template for the release's own context (${releaseRegion})`);
        if (canonicalJson(JSON.parse(kitText)) !== canonicalJson(JSON.parse(await readFile(join(input.releaseDir, entry.file), "utf8")))) throw new Error(`the kit's ${entry.part} template differs from the release's own for the release's own context (${releaseRegion})`);
      }
      const kitPackages = (await readdir(join(publicOut, "packages"))).sort();
      const releasePackages = input.release.packages.map((pkg) => `${pkg.assetId}.zip`).sort();
      if (kitPackages.join(",") !== releasePackages.join(",")) throw new Error(`the kit's code packages for the release's own context (${releaseRegion}) are not the release's`);
      for (const file of kitPackages) {
        const entry = input.release.packages.find((pkg) => `${pkg.assetId}.zip` === file);
        if (entry === undefined || sha256Hex(await readFile(join(publicOut, "packages", file))) !== entry.sha256) throw new Error(`the kit's package ${file.slice(0, 16)} is not the release's`);
      }
    }
    return sandboxed;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function usage(): string {
  return "Usage: tsx scripts/release/synth-kit.ts --release <dir> --out <dir>\n(Makes the synthesis kit of a release; pass the folder to scripts/release/bundle.ts with --synth-kit.)\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(usage());
  } else {
    (async () => {
      const release = value("--release");
      const out = value("--out");
      if (!release || !out || release.startsWith("--") || out.startsWith("--")) throw new Error("--release and --out are required");
      const result = await buildSynthKit({ releaseDir: release, out });
      process.stdout.write(`wrote the synthesis kit to ${resolve(out)}: ${String(result.functions)} functions, ${String(result.packages)} code packages, entry ${String(result.entryBytes)} bytes; checked ${result.sandboxed ? "inside the sandbox" : "WITHOUT a sandbox (none on this computer)"}\n`);
    })().catch((error: unknown) => {
      process.stderr.write(`agentx synthesis kit build failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
